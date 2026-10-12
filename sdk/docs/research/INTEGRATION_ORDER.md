# Closed-loop integration order

Cataloger identifies deployments and evidence. Catalyst interprets native authority.
ARM represents its meaning. External packages supply mechanics at those boundaries.

## Current base

- Official SPL, Token-2022 and Subscriptions Rust clients already decode state and
  construct native actions. Mollusk already executes native adapter conformance tests.
- The runtime builds and simulates SPL revoke, checks its semantic Diff and exposes
  the reviewed unsigned transaction. `src/wallet.ts` verifies the sign-only response;
  `src/submit.ts` checks cluster/lifetime around signing and submits through Kit.
  Unknown send responses retain the signature and exact bytes for verification.
- The runtime retains finalized revoke receipts and replays their linked snapshots
  and semantic Diff without RPC. Historical verification is not current authority.
- Pull, Quasar and Microscope have forks under `dakewamama`. Fork creation alone
  establishes no execution, reliability or integration guarantee.
- Public deployment captures remain Incomplete without the required runtime witness.
  An IDL or matching source/build hash cannot fill that evidence gap.

## Implementation sequence

| Order | Existing boundary | Reuse | Required proof |
| --- | --- | --- | --- |
| 1 | Runtime revoke endpoint → SDK → wallet | Kit codecs/crypto/RPC; Pull approval presentation pattern | SDK signing/submission checks message, signatures, cluster and lifetime. Browser wiring and invalidating changed authorization evidence remain required. |
| 2 | Submitted signature → finalized observation → Catalyst recompilation | Runtime's official RPC client; Kit submission | Runtime verifies canonical revoke, finalized receipt and later account evidence, then retains replayable verification. Browser verification polling remains required. Missing runtime evidence remains Incomplete. |
| 3 | Runtime journal/checkpoint → restart and repair | Microscope consumption/checkpoint pattern; existing Carbon/Yellowstone interfaces where needed | A crash before durable processing replays; duplicates are idempotent; two transactions in one slot survive; gaps remain visible until repaired. |
| 4 | Known deployment → schema reference | Program Metadata, @solana/idl, Solana Verify; Codama-generated clients | Bind retrieved schema/build evidence to a known deployment and revision. Discovery never enables an unknown semantic adapter. |
| 5 | Catalyst native adapter → ARM → native action | Official Squads V4 client, then Swig client under their source gates | Native fixtures, administrative/direct separation, exact constraint preservation, control/recompile agreement. Unsupported if a constraint cannot be enforced. |
| 6 | Whole loop conformance | Existing Mollusk fixtures first; Crucible only after compatibility proof | Recorded inputs reproduce the Diff; native state sequences challenge the projection; partial coverage never becomes a claim that no authority exists. |

Steps 1 and 2 close the first action loop. Steps 3 through 6 extend its reliability
and supported native targets. This ordering does not waive any protocol study gate.

## Narrow source entry points

- Kit: `packages/transactions/src/codecs/transaction-codec.ts`,
  `packages/keys/src/signatures.ts`; wallet reuse is implemented.
- Introspection: `decodeTransactionFromRpcResponse` in
  `packages/transaction-introspection/src/decode-rpc-transaction.ts`, then
  `walkInstructions` and its upstream tests. Preserve raw response and instruction
  position. Reject mismatched inner groups at the evidence boundary; missing CPI
  metadata is partial observation. No custom ALT decoder is needed in the TS path.
- Pull fork: `packages/sdk/src/wallet.ts` and `packages/sdk/e2e/` at
  `ab0c0df6880a1048b72023b615033e5cca3c6bcc`. Borrow presentation/test patterns;
  Pull-specific explanations cannot interpret ARM or other native protocols.
- Quasar fork: instruction simulation and ExecutionResult at
  `b5a9363de13e0f1e5e4559f4251c77563c3c9986`. Before integration, prove the current
  revoke fixture's rollback and account effects under an explicitly recorded runtime
  profile. Its Agave 4.1 defaults cannot replace the recorded Agave 3.1.10 profile
  or establish finalized bank identity. Keep the current executor until that proof.
- Microscope fork: checkpoint/delivery and datasource code at
  `fb225510424acc349446d61d2f4d6f7c2dc40dc4`. Study the durable-consumption boundary
  before adapting it to our journal. Do not copy its full generated decoder stack.

Crucible, Riptide, Kit Plugins and the Squads verifier remain candidates requiring
targeted source, license and compatibility checks at their corresponding step.
Smart Accounts, relaying and Clear Sign alignment follow the core loop. They are not
dependencies or completed support. Reuse through public APIs first; patch a fork only
when a failing integration fixture demonstrates the missing behavior.
