"""Read-only operational evidence. Never equates retained tips with continuous index coverage."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

from evidence_backup import verify


def journal_status(database):
    # Never create or migrate a database while measuring its health.
    with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as conn:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        integrity = conn.execute("PRAGMA quick_check").fetchall() == [("ok",)]
        foreign_keys = not conn.execute("PRAGMA foreign_key_check").fetchall()
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"authority_snapshots", "activity_transactions", "activity_backfill", "activity_gaps",
                    "activity_block_attempts", "webhook_receipts", "revoke_verifications"}
        counts = {name: conn.execute("SELECT count(*) FROM " + name).fetchone()[0]
                  for name in sorted(required & tables)}
        migrations = conn.execute("SELECT version, success FROM _sqlx_migrations ORDER BY version").fetchall()
        invalid = 0
        sampled = {}
        observations = {"fixture": 0, "finalized": 0, "other": 0}
        latest_observations = {}
        # Bounded checksum samples; structural checks above are database-wide.
        for table, column, checksum in [("authority_snapshots", "record", "record_sha256"),
                                        ("activity_transactions", "raw_json", "sha256"),
                                        ("activity_blocks", "raw_json", "sha256"),
                                        ("webhook_deliveries", "payload", "id")]:
            if table not in tables:
                continue
            limit = 20 if table == "authority_snapshots" else 200
            rows = conn.execute(f"SELECT {column},{checksum} FROM {table} ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
            sampled[table] = len(rows)
            invalid += sum(hashlib.sha256(raw.encode()).hexdigest() != expected for raw, expected in rows)
            if table == "authority_snapshots":
                for raw, expected in rows:
                    if hashlib.sha256(raw.encode()).hexdigest() != expected:
                        continue
                    try:
                        observation = json.loads(raw)["snapshot"]["observation"]
                        origin = observation["origin"]
                        observations[origin if origin in observations else "other"] += 1
                        if origin == "finalized":
                            cluster, slot = observation["cluster"], observation["slot"]
                            latest_observations[cluster] = max(latest_observations.get(cluster, 0), int(slot))
                    except (ValueError, KeyError, TypeError):
                        invalid += 1
        tips = []
        if "activity_transactions" in tables:
            for cluster, slot in conn.execute(
                "SELECT t.cluster,t.slot_units FROM activity_transactions t JOIN "
                "(SELECT cluster,max(slot_order) tip FROM activity_transactions GROUP BY cluster) m "
                "ON t.cluster=m.cluster AND t.slot_order=m.tip GROUP BY t.cluster,t.slot_units"
            ):
                tips.append({"cluster": cluster, "latest_retained_finalized_slot": slot})
        checkpoints = None
        if "activity_backfill" in tables:
            checkpoints = {"tracked_ranges": counts["activity_backfill"],
                           "provider_exhausted_ranges": conn.execute(
                               "SELECT count(*) FROM activity_backfill WHERE exhausted=1").fetchone()[0],
                           "last_advance_at": None, "continuous_coverage": "unproven"}
        block_gaps = None
        if "activity_block_attempts" in tables:
            block_gaps = conn.execute("SELECT count(*) FROM activity_block_attempts WHERE resolved=0").fetchone()[0]
        pending = None
        if {"webhook_receipts", "activity_transactions"} <= tables:
            pending = conn.execute("SELECT count(DISTINCT signature) FROM webhook_receipts r WHERE NOT EXISTS "
                                   "(SELECT 1 FROM activity_transactions t WHERE t.signature=r.signature)").fetchone()[0]
        healthy_bytes = integrity and foreign_keys and invalid == 0 and all(row[1] for row in migrations)
        return {"state": "readable" if healthy_bytes else "invalid", "quick_check": integrity,
                "foreign_key_check": foreign_keys, "latest_migration": str(migrations[-1][0]) if migrations else None,
                "missing_operational_tables": sorted(required - tables), "counts": counts,
                "checksum_samples": sampled, "invalid_checksums": invalid,
                "observation_sample": observations,
                "latest_sampled_finalized_observations": {cluster: str(slot) for cluster, slot in latest_observations.items()},
                "checksum_scope": "latest 20 snapshots, latest 200 rows per other evidence table; not native semantic replay",
                "retained_tips": tips, "backfill": checkpoints,
                "unreconciled_webhook_signatures": pending, "unresolved_block_attempts": block_gaps,
                "archive_coverage": "unproven", "historical_attribution": "unresolved"}


def rpc_status(url, expected_cluster=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        return {"state": "invalid_configuration"}
    started = time.monotonic()
    try:
        def call(method, params):
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                                                        "params": params}).encode(),
                                         {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as response:
                reply = json.load(response)
            if reply.get("jsonrpc") != "2.0" or reply.get("id") != 1 or "error" in reply:
                raise ValueError("Invalid RPC result")
            return reply["result"]
        cluster = call("getGenesisHash", [])
        if not isinstance(cluster, str) or not cluster:
            raise ValueError("Missing cluster")
        if expected_cluster and cluster != expected_cluster:
            return {"state": "cluster_mismatch"}
        slot = call("getSlot", [{"commitment": "finalized"}])
        if type(slot) is not int or not 0 <= slot <= 2**64 - 1:
            raise ValueError("Invalid slot")
        return {"state": "reachable", "cluster": cluster, "finalized_slot": str(slot),
                "probe_milliseconds": round((time.monotonic() - started) * 1000, 2),
                "scope": "two read requests; not an availability or rate-limit guarantee"}
    except urllib.error.HTTPError as error:
        return {"state": "rate_limited" if error.code == 429 else "unavailable", "http_status": error.code}
    except (OSError, ValueError, KeyError, TypeError):
        return {"state": "unavailable"}


def report(database, backup=None, rpc=None, expected_cluster=None):
    result = {"format": 1, "observed_at": datetime.now(timezone.utc).isoformat(),
              "production_readiness": "not_certified", "alerts": []}
    try:
        result["journal"] = journal_status(database)
    except (sqlite3.Error, OSError, ValueError, TypeError):
        result["journal"] = {"state": "unavailable"}
    journal = result["journal"]
    if journal["state"] != "readable":
        result["alerts"].append("journal_unavailable_or_invalid")
    if journal.get("missing_operational_tables"):
        result["alerts"].append("legacy_schema_without_history_telemetry")
    if journal.get("counts", {}).get("activity_gaps", 0) or journal.get("unresolved_block_attempts"):
        result["alerts"].append("unresolved_indexing_gaps")
    if journal.get("unreconciled_webhook_signatures"):
        result["alerts"].append("unreconciled_webhook_signatures")
    if journal.get("state") == "readable" and not journal.get("retained_tips"):
        result["alerts"].append("no_finalized_activity_retained")
    result["rpc"] = rpc_status(rpc, expected_cluster) if rpc is not None else {"state": "not_probed"}
    if rpc is not None and result["rpc"]["state"] != "reachable":
        result["alerts"].append("rpc_" + result["rpc"]["state"])
    for tip in journal.get("retained_tips", []):
        if tip["cluster"] == result["rpc"].get("cluster"):
            distance = int(result["rpc"]["finalized_slot"]) - int(tip["latest_retained_finalized_slot"])
            tip["distance_from_rpc_tip_slots"] = str(distance)
            tip["scope"] = "distance of newest retained transaction; not a continuous finalized checkpoint"
            if distance < 0:
                result["alerts"].append("rpc_tip_behind_retained_evidence")
    result["backup"] = {"state": "not_configured", "offsite_retention": "unverified"}
    if backup:
        try:
            manifest = verify(Path(backup))
            created = manifest.get("created_at")
            age = None if not created else (datetime.now(timezone.utc) - datetime.fromisoformat(created)).total_seconds()
            if age is not None and age < 0:
                raise ValueError("Backup date is in the future")
            result["backup"] = {"state": "verified", "sha256": manifest["sha256"], "bytes": manifest["bytes"],
                                "created_at": created, "age_seconds": age, "offsite_retention": "unverified"}
            if age is None:
                result["alerts"].append("backup_freshness_unknown")
            elif age > 3600:
                result["alerts"].append("backup_older_than_one_hour")
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            result["backup"] = {"state": "invalid", "offsite_retention": "unverified"}
    if result["backup"]["state"] != "verified":
        result["alerts"].append("backup_unverified")
    result["monitoring"] = {"alert_delivery": "not_configured", "backup_schedule": "not_verified",
                            "slo_attainment": "unmeasured"}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--probe-rpc", action="store_true", help="Read RPC_URL from the environment; never printed")
    parser.add_argument("--cluster")
    args = parser.parse_args()
    result = report(args.database, args.backup, os.environ.get("RPC_URL", "") if args.probe_rpc else None, args.cluster)
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if result["alerts"] else 0)
