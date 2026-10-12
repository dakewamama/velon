# ARM

Protocol-neutral authorization representation for Velon. This repository was renamed
from catalyst-crank; the former Solana program remains in Git history, not in ARM.

ARM describes meaning. It has no RPC, native account layouts, program IDs, instruction
builders, database, or protocol client dependency. Catalyst interprets native evidence;
Cataloger decides whether that deployment/version is supported.

## Schema 0.1

An Authorization associates a subject, principal, resource and capability with boolean
constraints, usage, lifecycle, delegability, authority kind, enforcement, observability,
evidence and native provenance. One record describes one capability. Identity and
resource namespaces are opaque to ARM and must be scoped consistently by adapters.
Adapters supply deterministic source-scoped IDs: observation time, amount and mutable
state must not change an authorization ID. ARM does not hash guessed identity fields.

PermissionIntent is a requested permission, AuthorizationGrant records the grantor,
EffectiveAuthorization records evaluation, and AuthorizationChange retains before/after
meaning. There is no state-to-intent conversion.

JSON uses snake_case enums and explicit kind tags. Boolean structure and vector order
are preserved. Unknown fields and variants fail deserialization; unsupported schema
versions fail `Authorization::validate`. Deserialize, then validate before accepting
state. All public evaluation methods validate. Native versions remain opaque;
Cataloger and adapters must fail closed before producing an Authorization.

Amounts are u64 integer base units. JSON consumers must parse these integers losslessly;
a JavaScript Number cannot represent the full range. Time uses signed Unix seconds;
lifecycle intervals are half-open. An adapter must translate native inclusive expiry
explicitly, and return unsupported if exact translation is impossible.

`availability_at` and `effective_at` evaluate lifecycle and observed usage. Conditional
means lifecycle permits further checking, never that a transaction is authorized.
Constraints still require native evaluation. Unknown observation/parent state stays
unknown; recurring allowances never reset merely because the clock advanced.
Evidence references and observation positions are opaque identifiers resolved by the
runtime; Exact requires a reference but ARM cannot verify its contents or freshness.

`is_proven_subset_of` proves a conservative subset of boolean implications. False means
unproven. Empty All is true, empty Any is false. Negation is retained but only structural
equality is proved. `is_proven_attenuation_of` requires equal principal, resource, usage,
lifecycle, authority kind, delegability, enforcement and native context, then checks
constraint implication. It is not a delegation-chain validator or an intent compiler.

## Verification

```sh
cargo fmt --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git diff --check
```

Ten canonical JSON fixtures cover direct, recurring, session, administrative, expired,
revoked, attenuated, derived, one-shot and composed boolean authority. Tests also cover
arithmetic boundaries, unknown evidence/schema, malformed lineage, serialization and
implication soundness. The fixture protocol is synthetic ARM language; native protocol
translation and control round trips belong to the next milestones.

Schema refinements require a real supported protocol fixture demonstrating a general
semantic gap. Source study and limits are recorded in docs/research/SOURCE_LEDGER.md.
