# Reuse boundaries

| Responsibility | Owner | Decision | Remaining Velon work |
| --- | --- | --- | --- |
| ARM serialization | Serde | DEPEND, already used | Semantic validation and schema fixtures |
| Solana keys, instructions and signer/writable metas | Official Solana SDK crates | DEPEND, already used | Select native action; preserve its meaning |
| SPL account decoding | spl-token-interface 3.0.0 | DEPEND, executed locally | Account owner/version checks and ARM translation |
| Token-2022 base state and extension decoding | spl-token-2022-interface | DEPEND, executed locally | Inspect extension inventory; reject unknown semantics |
| Native revoke and authority instruction construction | Official token interfaces | PUBLIC API, source verified | Identify the actual controller and required signers |
| Subscriptions fixed/recurring decoding and revoke | Official subscriptions 0.5.0 client | DEPEND/PUBLIC API, executed locally | Bind native observations, preserve generation and shared allowance, derive recurring allowance from observed clock, compile ARM |
| Exact deployment and adapter provenance | Cataloger | Project-owned | Bounded verified history; unknown versions rejected |
| Native authority to common meaning | Catalyst and ARM | Project-owned | Translation, evidence and native fixture conformance |

The classic token interface 3.0.0 now executes with native solana-instruction 3.4.0
and solana-pubkey 4.2.0. Cataloger uses the same key version. Upstream solana-address
1.1.0 re-exports 2.x, preserving type identity across interface generations; no project
conversion layer was added. Cargo.lock retains the tested Agave 4.2 harness dependencies
compatible with Rust 1.94.1. Token-2022 interface 3.1.2 is installed and executes against the pinned native fixture.
Do not implement a second instruction model or conversion framework to hide the gap.
A client crate version does not establish the deployed program version.

Mollusk 0.15.1 and its pinned native token fixture are test dependencies only. The adapter
supports that exact local ELF digest; no live version match is claimed. Golden bytes are
reproduced by native Approve, native Revoke removes projected authority, and Transfer
enforces/consumes the allowance. No host-side imitation of the token processor is used.

Token-2022 base unpacking leaves extension data lazy. Successful unpack is not proof
that every extension is valid or understood. Enumerate extensions, propagate malformed
data errors, and reject unknown semantic effects. A helper that maps extension errors
to None must not become an exact absence claim.

The ABI remains small: one required adapter trait, native state owned by each adapter,
checked dispatch and native instruction output. It has no decoder registry, intent
compiler, signer, policy engine or RPC framework. Revoke and ResetAuthority are backed
by native fixtures. ResetAuthority clears explicit SPL close authority, restoring its
owner fallback; describing it as Revoke would incorrectly claim Close permission ended.

Ingestion, developer clients and execution infrastructure remain behind their existing
source gates. No dependency decision for those layers is established by this audit.
Choose the provider only after inspecting its relevant source and proving the needed
behavior. The retained webhook service is legacy runtime code, not a new generic indexer.
