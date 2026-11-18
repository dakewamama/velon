# Release parity and operational evidence

## Production baseline — 2026-11-18 UTC

The public console's HTML, JavaScript and CSS matched the retained release export
for `0e0d8c78f012e565632e3ca88ababb84c636706a`. Railway's running manifest names
the same revision; the exported production native executable matches its declared
SHA-256 `4846083a453359e4b15734409ebdf3159db26233a3f39c1b131ddd18b8702b08`.
This is a manual artifact match. The live HTML has no backend revision pin and
`/api/control` has no revision/API-version fields, so automatic parity enforcement
is **not deployed**. The public landing page remains separate and unchanged.

The production journal passed SQLite structural checks and all three retained
snapshot checksums; all three are fixture observations. It has no live historical
transaction tables and no finalized observation in that sample. A functioning
HTTP server and reachable mainnet RPC do not demonstrate current authority data
or a working historical index.

At `2026-11-18T09:16:29Z`, two read-only RPC requests verified mainnet genesis
and finalized slot `470881405` in 82.64 ms from the production container. The
upstream is configured and is not Solana's shared public endpoint. This does not
prove an API key's quota, provider capacity or future availability. No key, URL
credential or environment value was exported.

The retained gateway log contained 57 completed requests, all HTTP 200, from
November 15 to November 18, with recorded durations from 0 to 6620 ms. The old
logger omits early rejections and health probes. This small retained sample does
not establish availability, observation latency, RPC success or an achieved SLO.

The earlier production backup remains checksum-verified. Its old manifest has
no creation timestamp, so the probe reports freshness as unknown. Off-container
export and local restore were demonstrated separately; automated retention,
scheduled backups, alert delivery and deployment rollback remain unverified.
The measurement did not change the production database bytes.

## Check the approved release

Hosted exports write `release.json`, containing the commit, control API version,
console page and hashes/sizes of the exported HTML, scripts, styles and media.
Keep the reviewed export and its manifest with release artifacts. The supervisor
already verifies immutable backend files and the native executable's embedded
revision; the browser already refuses incompatible backends before signing.

After an authorized rollout, run from the repository root:

```sh
python3 scripts/check_release.py https://console.velonsecure.xyz /approved/export/release.json
```

This compares the approved local manifest with the deployed one, downloads every
listed public asset, checks its bytes, checks the embedded backend pin, and compares
the public backend revision/API version. Redirects, missing metadata, changed bytes
and revision mismatches fail closed. It makes no blockchain requests or mutations.
It proves agreement with the reviewed manifest, not independent source-build
reproducibility or evidence health. An approved manifest must be trusted separately.

## Collect operational evidence

On the server, with its existing secrets available only in the environment:

```sh
python3 -B /opt/velon/tools/operations_report.py /data/observations.db \
  --backup /operator-backups/verified-artifact \
  --probe-rpc --cluster 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
  --gateway http://127.0.0.1:7860
```

The database path is the intended persistent-volume path, not the old live path.
Do not use it to cut over storage: follow `RECOVERY.md` first. The read-only
probe refuses to create or migrate a missing database. It reports schema support,
structural integrity, bounded evidence checksum samples, durable gap counts,
unreconciled provisional signatures, retained transaction tips and backfill state.
An old schema is an alert, not zero gaps. Latest transaction distance from the RPC
tip is explicitly **not** a continuous indexing checkpoint. Checkpoint advance
timestamps are not retained in the existing schema and remain unknown.

`--probe-rpc` reads `RPC_URL`, falling back to `UPSTREAM_RPC_URL`; it never prints
either. It issues only genesis and finalized-slot reads, without retrying. The
backup option verifies the actual artifact's checksum, integrity and migration
metadata. New backup manifests have creation timestamps; missing dates, dates in
the future, invalid artifacts and backups older than one hour produce alerts.
A valid artifact does not establish offsite retention or a backup schedule.

`--gateway` accepts only a loopback HTTP origin, uses `GATEWAY_TOKEN` internally,
and refuses redirects. The gateway's `/operations` endpoint requires that token
even on a bench; it is not a public Vercel route. It reports bounded request groups,
error counts and non-cumulative latency buckets. RPC relay measurements count
transport failures, HTTP errors, HTTP-200 RPC errors and recognized rate limits.
Native runtime RPC calls and health probes are outside that counter's scope.
Native observation/review/revalidation/verification HTTP failures remain visible
as separate request groups; their HTTP status does not identify every root cause.

Every gateway request, including early rejections, emits a structured line without
wallet addresses, IPs, bodies, provider URLs or keys. A `VELON_OPERATIONS` summary
is emitted once per minute. Counters reset on process restart; durable historical
facts remain in the journal. Retain these logs outside the container and connect
the report's nonzero alert exit status to an operator alert destination before
claiming active monitoring. Neither alert transport nor log retention is configured
or certified by this change. The report always says `production_readiness:
not_certified`; a zero exit only means its assessed checks had no alerts.

## RPC pressure and browser memory

Discovery/display reads share identical in-flight requests, run at most two
concurrently, queue at most sixteen and have a fifteen-second total deadline.
They retry at most twice for 429/503 or explicit RPC code 429. A provider's long
`Retry-After` fails the read instead of retrying prematurely. Completed reads are
not cached: a later discovery asks again. Health probes share a ten-second result.
These limits apply to those reads, not all native RPC traffic or a provider-wide
quota. Signed submission does not use this retry helper. Existing native finalized
revalidation, exact signing and uncertain-submission rules remain in force.

Provider keys stay server-side behind the same-origin RPC relay. A release ID
selects compatible code; it is not an RPC credential or a quota increase. Paid
provider changes and new credentials are not part of this change.

Supabase is an option for a future durable server store, not configured here.
Replacing SQLite needs a tested schema/evidence migration and restore proof.
The browser already keeps recent checks and up to twenty receipt references as
optional convenience data. Browser memory can be cleared or changed and never
establishes finality or replaces retained server evidence. No signing keys belong
in either that cache or Supabase.

## Targets, not achieved guarantees

Proposed release targets are 99.9% monthly valid-request availability, supported
observation p95 within ten seconds, configured ingestion reconciliation within
two minutes, backup RPO within one hour and restore RTO within thirty minutes.
The collected samples do not establish any of those targets. Continuous
checkpoint tracking, scheduled collection, alert delivery, offsite backup retention
and production restore timing must be demonstrated before claiming attainment.
