# Evidence storage and recovery

Keep SQLite. The existing runtime uses WAL, FULL synchronization, checksummed
records and SQLx migrations. Replacing it with another database would not recover
the missing production volume or missing historical evidence.

Production is blocked until storage is provisioned and existing evidence is
inventoried. Railway production had no volumes on 2026-11-15. Do not mount a new
empty volume over the running image's `.data` directory.

Before any rollout:

1. Inventory every existing `observations-*.db` and its WAL/SHM files. Preserve the
   release binaries and `artifacts.json` needed for each record's exact SDK replay.
2. Take a coherent backup of each database **before** replacing the deployment.
   Copying a database file alone while WAL writes are active is insufficient.
3. Copy and verify these backups outside the ephemeral container. Retention,
   access controls, encryption at rest and offsite storage need operator setup.
4. Provision a durable volume at a new path, restore each database into that path,
   and explicitly set `DATABASE_URL=sqlite:///durable/path/observations.db` for the
   selected journal. An environment variable must not point into the release image.
5. Run migrations and replay known IDs using the matching archived runtime before
   switching traffic. Opening an older SDK's evidence with a newer binary may
   correctly reject replay; retain the old database and binary for historical reads.

The launcher still defaults to revision-specific files when DATABASE_URL is unset.
That default is suitable for isolated fixtures, not durable production guarantees.
Do not concatenate databases or rewrite record provenance to bypass replay checks.

## Commands

```sh
python3 scripts/evidence_backup.py backup /path/to/journal.db /backup/new-artifact
python3 scripts/evidence_backup.py verify /backup/new-artifact
python3 scripts/evidence_backup.py restore /backup/new-artifact /durable/path/new.db
DATABASE_URL=sqlite:///durable/path/new.db /matching-release/authorization-api replay RECORD_ID
```

Backup uses SQLite's online backup API. The manifest records SHA256, length and
SQLx migration checksums only after database and filesystem synchronization.
Restore checks bytes, SQLite integrity, foreign keys and migration metadata,
then publishes a verified file atomically without overwriting another file.
An interrupted backup lacks its completion manifest and cannot be restored.
Do not restore over a running database; the command refuses existing destinations
and their WAL/SHM files. Point a stopped service at the newly verified file.

Hashes detect corruption; they do not authenticate an operator who can replace
both a backup and its manifest. Store backup manifests under independent access
controls. The utility does not encrypt files or send them to an offsite service.

## Enforced production startup boundary

The release image installs the recovery utility at
`/opt/velon/tools/evidence_backup.py`. Use the utility bundled with the matching
release when possible.

Mainnet startup now requires `DATABASE_URL` and `VELON_EVIDENCE_MOUNT`.
The mount must already exist as an active filesystem mount, and the database
must be a readable, initialized SQLite file inside it. The supervisor
refuses to silently create a new journal at its revision-specific default.
For example, with a Railway volume mounted at `/data`:

```text
VELON_EVIDENCE_MOUNT=/data
DATABASE_URL=sqlite:///data/observations.db
```

Do **not** set these variables and redeploy until the old journal has been
inventoried, backed up and independently restored to the mounted volume.
The startup guard checks mount presence, path confinement, database
readability and SQLite integrity. It does not prove that a provider's mount
is persistent, that the backup is offsite, or that every history range exists.
Those are independent operator release gates.

Railway volumes are mounted with root ownership. The image uses the
unprivileged `ubuntu` user. Check ownership and access before cutover:
a writable volume may require an explicit UID/ownership decision.
Do not solve this by silently changing the service to run as root.

## Tested and unmeasured

`python3 -m unittest discover -s scripts -p 'test_*.py' -v` imports retained native
SPL fixture evidence through the actual runtime, backs up with a WAL writer open,
restores and replays the exact record. It checks maximum-u64 decimal storage,
non-overwrite, corruption rejection, missing source and interrupted backup rejection.

This is local recovery conformance. No production backup, loss window, recovery
duration, deployment rollback or offsite retention has been measured. RPO and RTO
remain operational release gates, not achieved SLOs.

## Release startup and older records

Mainnet startup checks the executable's embedded revision with `authorization-api
identity` before opening a journal or making RPC calls. The private loopback
`GET /identity` endpoint is a process-readiness check, not evidence health.
Recorded example imports are disabled in mainnet mode; local/recorded examples
remain available. This prevents stable fixture IDs from conflicting with retained
records interpreted by an older SDK. Record IDs and retained bytes are unchanged.

Older records keep their original SDK revision. Replay them with the matching
archived executable and dependencies against an isolated copy of the pre-migration
backup. Never overwrite their revision or reinterpret them as current records to
make an upgrade start, and do not run an older executable against the only migrated
journal. Preserve and checksum both the original backup and archived artifacts.

The cross-release check used a real `0e0d8c78` runtime to import an SPL fixture,
then started the new runtime and mainnet launcher on that SQLite journal. It served
the live scenario without fixture imports; the old record and its stored SHA-256
were identical afterward. RPC/genesis and catalog inputs were controlled test
fixtures; this proves local upgrade/startup preservation, not mainnet compatibility
or restoration of retained production data.
