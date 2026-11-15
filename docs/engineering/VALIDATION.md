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
lockfiles. Its runtime artifact is a **debug validation build**, not a production
container release or public-chain action certification.

Hosted console exports embed their backend commit. The client checks the backend's
revision and API contract before enabling controls, before review and after wallet
signing. A mismatch requires refreshing after the update. Direct local fixtures
have no hosted pin. The runtime build tracks the current branch reference as well
as HEAD and index so cached local builds notice a new commit.

GitHub Actions remains an available validation definition, but billing prevented
its jobs from starting. Railway runs the commands independently; a Railway
deployment status alone is not a test result. Check the final marker, JSON commit
and logs. Neither validation route authorizes a production deployment or merge.

Public-chain execution, complete archival coverage, exact historical incarnation
reconstruction and production restore/rollback remain separate release gates.
