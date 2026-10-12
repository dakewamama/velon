# Source ledger

## ARM v0.1 red team: persistent versus one-shot authority

- Repository: [Uniswap/permit2](https://github.com/Uniswap/permit2).
- Commit: `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` (main resolved 2026-10-01).
- License: MIT, verified in repository LICENSE and source SPDX header.
- Inspection: TARGETED SOURCE, not executed locally.
- Relevant source: `src/SignatureTransfer.sol`, `_permitTransferFrom`, `_useUnorderedNonce`.
- Relevant test: `test/SignatureTransfer.t.sol`, `testPermitTransferFromInvalidNonce`.
- Verified source: a transfer consumes the permit nonce; the same permit cannot be reused
  even if the first transfer spent less than the permitted maximum.
- Counterexample: modeling this as a cumulative remaining balance would falsely retain
  authority after consumption. ARM represents consumption independently with OneShot;
  absent consumption evidence remains Unknown. Regression: `one_shot_is_not_a_persistent_allowance`.
- Deadline is inclusive in this reference. ARM's half-open lifecycle interval must be
  translated explicitly by adapters; these tests do not claim an Ethereum adapter.
- Reuse: PATTERN ONLY. No upstream code copied; no Ethereum integration/dependency.
- Scope limit: this red team verifies one model dimension, not complete protocol coverage.

## Boolean composition

Independent truth-table checks exercise 112 expressions over a bounded amount domain,
including conjunction, disjunction, negation and empty compositions. Every reported
implication must preserve allowed inputs. This is local executable evidence, not a
claim of OpenFGA integration. OpenFGA documentation retrieval failed; no design claim
relies on it.
