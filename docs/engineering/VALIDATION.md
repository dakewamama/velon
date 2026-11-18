# Validation without GitHub Actions

The isolated Railway project `velon-validation`, environment `validation`, runs
`app/deploy/validate.Dockerfile` and `scripts/validate.sh`. It has no public domain,
production credentials, persistent evidence volume or production service bindings.
Its source is pinned to an explicit commit of `release/production-correctness`.
Restart policy is NEVER; execution is bounded to 50 minutes plus shutdown time.

The runner uses Node 22.16.0 and Bun 1.3.14 with verified download checksums, Rust
1.97.1, frozen package lockfiles and locked Cargo dependencies. It runs formatting,
Clippy, Rust tests including native executable conformance, SDK and app TypeScript
checks, unit/API tests, native journal backup/restore, browser tests and hosted
export identity checks. `VELON_VALIDATION_PASS` appears only after all stages pass.
The JSON result identifies the tested commit and hashes the runtime, frontend and
lockfiles. Recovery, browser controls and hosted export use the optimized
`--release` runtime, matching the production Dockerfile's Cargo profile. This does
not certify the production container, bit-reproducible builds or public-chain actions.

Hosted console exports embed their backend commit. The client checks the backend's
revision and API contract before enabling controls, before review and after wallet
signing. A mismatch requires refreshing after the update. Direct local fixtures
have no hosted pin. The runtime build tracks the current branch reference as well
as HEAD and index so cached local builds notice a new commit.

The runner rejects a revision that differs from Git HEAD and rejects an uncommitted
checkout before building. Production image startup uses manifest format 2, covering
all immutable files, including application code, installed dependencies and recovery
tools. Missing, added or changed files, modes and symlink targets fail verification.
Only `logs/` and `app/.data/` are mutable; source links cannot target either location.
Docker excludes dotenv files, Vercel settings and Python bytecode caches. Both image
recipes fetch their declared commit from the public Velon repository and verify HEAD;
unpushed local changes are not image inputs. This checks
artifact consistency, not authenticity against an attacker who can replace both
the manifest and verifier. Complete image execution and reproducible base/system
dependencies remain separate release gates.

GitHub Actions remains an available validation definition, but billing prevented
its jobs from starting. Railway runs the commands independently; a Railway
deployment status alone is not a test result. Check the final marker, JSON commit
and logs. Neither validation route authorizes a production deployment or merge.

Public-chain execution, complete archival coverage, exact historical incarnation
reconstruction and production restore/rollback remain separate release gates.
