# Production completion baseline

Inspected 2026-11-15. No production mutations authorized or performed.

- Local clean `main`: `929416a`; audited `wip`: `0e0d8c7` (still remote wip HEAD).
- Draft PR #1: `081ad67`, 22 commits, six files; malformed discovery input,
  incomplete history disclosure, and loaded address ordering. Included as the
  starting point of `release/production-correctness`; validation remains required.
- Upstream Subscriptions HEAD: `40fa2a06de81f0992a65293e4754a0ec559da680`.
  `audits/AUDIT_STATUS.md` records Cantina baseline `d6b3a5d` and fixes through
  `debb4f7`; HEAD has 38 subsequent commits. HEAD is not wholly externally audited.
- Railway read-only inventory: project `velon`, production backend on `wip`,
  successful deployment `b12aecff-993c-44b2-a73f-34ceddec7c5a`, **zero volumes**.
  A successful deployment does not demonstrate evidence health or persistence.
- Prior audit's numbered list of 28 findings is absent from the checkout and PR.
  Do not invent a numbered disposition without the source audit.

| Subsystem | Evidence and assessment | Classification | Required validation |
| --- | --- | --- | --- |
| ARM | Existing schema, conservative evaluation and model tests; no historical incarnation field | Existing functionality; do not replace model | Rust checks and model tests |
| Cataloger | Bounded selectors and executable/runtime checks already implemented | Existing functionality | Resolver, deployment mismatch tests |
| Catalyst | Native SPL, Token-2022 and Subscriptions control/Diff tests exist; readmes lag later implementation | Documentation discrepancy; verify actual support | Native executable hashes and execution tests |
| History identity | `sdk/src/subscriptions.rs` IDs use PDA and parent `init_id`; `app/scripts/demo.ts` matches older events using current delegation | Correctness risk: parent generation is not a unique child incarnation | Revoke/recreate fixtures, unresolved attribution |
| Indexer | Positioned raw events, decimal amounts and replay dedup exist; webhook is not independently finalized | Missing finality/backfill/checkpoint/query capability | Replay, conflicting evidence, crash recovery |
| Console history | Reads 25 signatures; PR prevents complete-coverage inference, but empty detail text still overstates | Confirmed disclosure defect | Empty/partial/pruned histories and UI tests |
| Controls | Exact signing, submission uncertainty and retained finalized receipts already exist; cancel path added before audited HEAD | Preserve and verify existing pipeline | Stale signing, upgrade, expiry, native cancellation |
| Storage | SQLite journals and receipt checksums exist; revision-specific default path and ephemeral deployment | Operational blocker | Existing data inventory, backup/restore, migration |
| Release | Root console workflow deploys on wip; nested CI files do not run as root workflows | Reliability risk; CI state needs remote confirmation | Non-deploying complete validation gate, artifact parity |
| Gateway | Optional token, GET paths unmetered, health trusts HTTP RPC success | Security/reliability risks requiring tests | Auth boundary, RPC error bodies, request exhaustion |

## Identity decision under examination

An address is a locator, not a historical authorization ID. Parent `init_id` is
copied at child creation (`program/src/state/header.rs` upstream); fixed/recurring
PDAs use reusable nonce seeds, subscriptions use plan/subscriber seeds. Closing a
child does not necessarily rotate the parent. Same-slot parent recreation can
also reuse the generation. Event layouts omit a unique child creation identifier.

Keep transaction facts even when no exact historical incarnation is provable.
Do not join these facts to today's permission, plan pullers or billing terms.
A future resolved incarnation must bind cluster, program, creation transaction
and instruction position, parent generation and retained execution evidence.
Deployment identity and historical state version are separate provenance fields:
an upgrade does not by itself create a new account incarnation. Missing creation,
ordering, deployment or historical state evidence must remain explicit.

This is an initial inventory, not a release certificate. Test results and finding
dispositions must be updated from executed checks.
