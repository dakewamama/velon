# SUB-0 review

Final local gate reviewed on 2026-10-03 after Cataloger correction a88dbd8 and
the SPL Freeze/Thaw classification correction. ARM remains pinned to
3b91100314473b616b5fd6f77214c6b6282a1dfb with schema 0.1 unchanged.

Hosted Cataloger CI: EXTERNALLY BLOCKED. GitHub reports that jobs cannot start
because the account is locked for billing; the correction run 37086495077 ran no
workflow steps. This external billing lock does not invalidate local gate evidence.
The owner explicitly approved progression on exact local checks; hosted CI is not
claimed green, and Railway is not a CI substitute.

## Gate evidence

| Requirement | Evidence |
| --- | --- |
| ARM 0.1 frozen | Ten canonical fixtures, serialization and conservative evaluation tests; no token-driven schema change |
| Catalyst ABI | Checked dispatch, native instruction types, evidence propagation and unsupported-version tests |
| Cataloger resolver | Explicit support intervals, gaps, deterministic resolution and provenance; no ARM dependency or capability declarations |
| SPL and Token-2022 interpretation | Official state interfaces, checked raw and semantic goldens, hashed native ELF execution |
| Native revoke round trip | Classic owner revoke; Token-2022 owner and delegate revoke; declared removal agrees with recompilation |
| Unknown versions fail closed | Checked dispatch rejects unsupported contexts before native decoding |
| Protocol-neutral ARM | No native protocol types, identifiers, RPC or storage dependencies in ARM source |
| Verification | fmt, strict Clippy and workspace tests pass in all three repositories; SDK Bun tests and TypeScript check pass |
| Milestones pushed | Reviewed revisions match locally recorded upstream main refs |

Rust test totals: ARM 12, Cataloger 30 (7 resolver and 23 retained runtime),
Catalyst 42. SDK also passes 3 Bun tests and `bun run typecheck`. SDK Rust checks use the offline
commands below; ARM and Cataloger reran the same workflow without `--offline`.
Commands run:

```sh
cargo fmt --check
cargo clippy --offline --locked --workspace --all-targets -- -D warnings
cargo test --offline --locked --workspace
git diff --check
```

## Cross-repository findings

SPL close-authority reset changes the principal to the owner rather than removing
Close permission. The existing Changed representation handles this without a schema
change. Mint, Freeze and Thaw are direct operational capabilities. Administrative authority
is reserved for managing authority or policy; the SDK adds no new capability or ARM type. Token-2022
Permanent Delegate bypasses ordinary allowance; overlapping principals are explicitly
Unsupported rather than assigned an independently consumed budget.

A second native program adapter was added without editing ARM or the adapter trait.
Official decoders, builders and native execution own byte layouts and enforcement.
AuthorityState is shared only where the observed account shape actually matches.
No RPC provider, decoder framework, intent compiler or generic policy engine was added
in anticipation of later protocols. No further extraction or abstraction is justified
by these fixtures.

## Decision and limits

All exact local workflows pass. SUB-0 is green for verified local fixture scope and
Subscriptions maintainer study is unlocked. Adapter implementation remains prohibited
until the semantic study and ARM fit review are complete.
This decision does not advertise live Solana support. Cataloger contains no verified
live deployment records. Controllers requiring multisig or program semantics, unreviewed
Token-2022 extensions and overlapping delegate roles remain unsupported. Individual
Exact projections do not imply complete protocol or address coverage.

The retained Cataloger webhook binary is not a completed index pipeline. Its known
runtime test/amount issues remain recorded separately. No address API, general
transaction simulation Diff or permission compiler is claimed by this gate.
