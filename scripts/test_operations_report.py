import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from unittest.mock import patch

from evidence_backup import backup
from operations_report import report, rpc_status, gateway_status


class OperationsEvidence(unittest.TestCase):
    def test_rpc_throttling_cluster_disagreement_and_secrets_are_not_hidden(self):
        status = 429
        methods = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                method = json.loads(self.rfile.read(int(self.headers["Content-Length"])))['method']
                methods.append(method)
                self.send_response(status)
                self.end_headers()
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": 1,
                    "result": "expected-cluster" if method == "getGenesisHash" else 2**64 - 1}).encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port) + "/private-key"
        try:
            self.assertEqual(rpc_status(url)["state"], "rate_limited")
            status = 200
            methods.clear()
            self.assertEqual(rpc_status(url, "wrong-cluster")["state"], "cluster_mismatch")
            self.assertEqual(methods, ["getGenesisHash"])
            result = rpc_status(url, "expected-cluster")
            self.assertEqual(result["finalized_slot"], str(2**64 - 1))
            self.assertNotIn("private-key", json.dumps(result))
            self.assertEqual(gateway_status("https://external.example")["state"], "invalid_configuration")
            with patch.dict(os.environ, {"GATEWAY_TOKEN": ""}):
                self.assertEqual(gateway_status("http://127.0.0.1:9")["state"], "operator_authentication_unconfigured")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_missing_database_is_not_created_or_healthy(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "missing.sqlite"
            result = report(database)
            self.assertFalse(database.exists())
            self.assertEqual(result["journal"]["state"], "unavailable")
            self.assertIn("journal_unavailable_or_invalid", result["alerts"])
            self.assertEqual(result["backup"]["state"], "not_configured")

    def test_retained_tip_is_exact_but_never_claims_coverage_and_corruption_is_visible(self):
        root = Path(__file__).resolve().parents[1]
        binary = os.environ.get("AUTHZ_BIN", str(root / "runtime/target/debug/authorization-api"))
        fixtures = root / "runtime/services/catalyst-indexer/tests/fixtures"
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "evidence.sqlite"
            subprocess.run([binary, "import", str(fixtures / "catalog.json"), str(fixtures / "spl-snapshot.json")],
                           env=dict(os.environ, DATABASE_URL="sqlite://" + str(database)),
                           check=True, stdout=subprocess.PIPE)
            raw = "{}"
            maximum = 2**64 - 1
            with sqlite3.connect(database) as conn:
                conn.execute("INSERT INTO activity_transactions VALUES (?,?,?,?,?,?,?)",
                             ("test-cluster", "signature", str(maximum), maximum.to_bytes(8, "big"),
                              raw, hashlib.sha256(raw.encode()).hexdigest(), "provider"))
                conn.execute("INSERT INTO activity_gaps VALUES ('cluster','address','signature','provider','missing',1)")
            artifact = Path(directory) / "backup"
            backup(database, artifact)
            result = report(database, artifact)
            self.assertEqual(result["journal"]["state"], "readable")
            self.assertEqual(result["journal"]["retained_tips"][0]["latest_retained_finalized_slot"], str(maximum))
            self.assertEqual(result["journal"]["archive_coverage"], "unproven")
            self.assertIn("unresolved_indexing_gaps", result["alerts"])
            self.assertEqual(result["backup"]["state"], "verified")
            self.assertGreaterEqual(result["backup"]["age_seconds"], 0)
            self.assertEqual(result["monitoring"]["slo_attainment"], "unmeasured")
            with sqlite3.connect(database) as conn:
                conn.execute("UPDATE authority_snapshots SET record='corrupted'")
            invalid = report(database, artifact)
            self.assertEqual(invalid["journal"]["state"], "invalid")
            self.assertEqual(invalid["journal"]["invalid_checksums"], 1)
            self.assertIn("journal_unavailable_or_invalid", invalid["alerts"])
            self.assertEqual(invalid["backup"]["state"], "verified")
            with (artifact / "evidence.sqlite").open("r+b") as stream:
                stream.write(b"corrupted backup")
            self.assertEqual(report(database, artifact)["backup"]["state"], "invalid")


if __name__ == "__main__":
    unittest.main()
