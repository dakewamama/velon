# catalyst-sdk

Catalyst translates typed native authority into ARM meaning. The Rust library is the
semantic adapter boundary; the Bun/TypeScript package decodes lifecycle event bytes
and handles reviewed wallet signing/submission. Event decoding alone does not establish authority.

## Semantic adapter ABI

Implement Adapter with a native State type and six methods: protocol, supports,
source_requirements, compile_state, diff_transaction and actions. No intent compiler
exists yet. Native decoding belongs to official/generated clients, not this trait.

Runtime callers use the crate-level compile_state, diff_transaction and actions functions.
The trait methods are interpretation hooks; directly calling them bypasses the checked
dispatch boundary. Checked dispatch rejects a protocol/program mismatch or unsupported
native deployment/version before invoking a hook. Evidence must include references and
an observation position. Outputs must validate against ARM and retain the exact supplied
provenance/evidence bundle. Compile output cannot contain duplicate authorization IDs;
Changed output must preserve identity; management actions must target that authorization
and contain instructions. Empty output is valid when there is no authority/action.

Context binds a native program key to Cataloger-resolved NativeContext and source evidence.
Adapters must check known deployments, program versions and their own adapter version.
The runtime is responsible for ensuring Context describes the supplied native state;
the ABI does not authenticate RPC responses or establish freshness/finality.

SourceRequirements lists native account keys and whether clock evidence is needed.
Actions contain standard solana-instruction instructions, including native signer and
writable account metadata. The Rust adapter API neither signs nor submits transactions. Declared Diff
is an adapter statement. `verify_transaction_diff` checks agreement with a successful
simulation's recompiled state before returning that statement.

The caller supplies before/after typed states and their observation contexts, checks
simulation success and binds the instruction list, account scope and bank clock to
that execution. Both contexts must use the same verified program/deployment/version
and adapter. The check applies each declared change once, validates its current-state
precondition and compares every projected authorization field with the observed result.
Only observation evidence is normalized for equality; original contexts are retained
by the caller and returned changes keep their declared evidence. `DiffMismatch` rejects
disagreement, duplicate effects, missing removals and unexpected surviving permissions.

This verifies the adapter's projection, preserving its existing observability and
coverage limits. It does not authenticate an RPC response or guarantee that a future
execution matches this simulation. Native tests use atomic Mollusk transaction
execution for SPL revoke and delayed Subscriptions cancellation. A revoke followed by
a failing instruction rolls back. A cancellation crossing a period boundary rejects
the stale cutoff; a fresh declaration at the simulated clock agrees. Existing SPL
mint/close, Token-2022 and Subscriptions management round trips also pass the check.

The synthetic test adapter proves determinism, explicit requirements, failure before
interpretation, evidence propagation, standard instructions and removal representation.
It is not a supported native protocol or a native revoke round trip.

ARM is pinned to its committed Git revision. Its domain model is reused directly; no
parallel semantic model is maintained here. Solana instruction/public-key dependencies
are pinned; adapter native clients must use compatible versions.

Verified reuse boundaries and the native compatibility proof are recorded in
[REUSE_BOUNDARIES.md](docs/research/REUSE_BOUNDARIES.md).

## SPL delegate slice

spl::DelegateAdapter interprets classic SPL token account delegate Spend authority.
State retains native account observations; the runtime binds owner/delegate observations
to the keys returned by source_requirements and retains their evidence. Official Pack
decodes state and the official revoke builder constructs instructions. The owner revoke
action requires an observed ordinary system account; multisig/program-controlled owners
are unsupported for actions. Multisig/program-controlled delegates are unsupported for
interpretation until their principal semantics are implemented.

Support is limited to the exact ELF digest and three deployment selectors named by spl
constants: the local fixture, LIVE_DEPLOYMENT and DEVNET_DEPLOYMENT. The October 8,
2026 mainnet observation matched the pinned Mollusk ELF bytes, as recorded in
[SOURCE_LEDGER.md](docs/research/SOURCE_LEDGER.md).
For each live observation, the runtime must validate raw program, ProgramData and Clock
from the same finalized response and compare the full payload hash and exact selector.
A label alone does not establish coverage. Unknown versions fail before decoding.
Native tests execute the same hashed ELF locally; they do not execute on mainnet.

The checked-in raw state is reproduced by native Approve execution and has a complete
ARM golden. Mollusk executes Revoke; recompilation removes the authorization and agrees
with its declared Diff. Native Transfer rejects an amount above the delegated allowance
and consumes that allowance. Frozen state is suspended, zero allowance is inactive, and
native unsigned/wrong-owner/frozen revoke failures leave state unchanged.

This is a delegate projection, not complete account coverage. Owner,
Burn semantics are not projected by this classic adapter. Spend and Burn share the native
delegated allowance; this adapter emits only Spend and never adds their budgets together.
Remaining allowance does not promise available balance or transaction success. Declared
Diff supports exactly one canonical owner Revoke; other instructions return Unsupported.

MintAdapter consumes AuthorityState observations for the same verified classic program.
It projects Mint on the mint resource and direct Freeze/Thaw on that mint's
token accounts. It does not infer a human owner from mint state. Native authority
accounts must be supplied by key; missing, duplicate, multisig or program-owned
observations fail closed. These are separate native powers, not Spend permissions.

Mint actions use official SetAuthority instructions to clear the selected authority.
Clearing mint authority permanently fixes supply against further minting; clearing
freeze authority permanently removes both Freeze and Thaw, including the ability to
thaw existing frozen accounts. Native execution proves neither authority can be restored
after clearing. The SDK builds these actions; it does not submit them. Each declared
Diff must match one canonical removal instruction and retains the removed evidence.

The raw mint golden is reproduced by native InitializeMint2 and MintTo. Native tests
verify supply/balance changes, freeze/thaw effects on the existing delegate projection,
signature/controller failures, removal/recompilation agreement and irreversible removal.

CloseAdapter shares AuthorityState's keyed native observations with MintAdapter.
It projects explicit close authority, or the token account owner when the native close
authority is absent. Clearing an explicit close authority restores the owner; it does
not remove Close permission. That action is ResetAuthority, and its declared Diff is
Changed, or empty when the effective principal already equals the owner. Missing
fallback-owner evidence prevents proposing or declaring the reset.

Close is technical authority, not a guarantee of transaction success: ordinary token
accounts must have zero token balance; wrapped SOL can close with a balance. Frozen
empty accounts can close, but their close authority cannot be reset until thawed.
These distinctions are verified by native execution. System/incinerator token ownership
and multisig/program-owned controllers remain unsupported. Native CloseAccount simulation
returns lamports to an explicitly selected beneficiary and re-observation of the deleted
account yields no Close authorization. The SDK does not propose a beneficiary or submit
a Close transaction from observed state; human destination intent is not inferred.

## Token-2022 delegate slice

Token2022Adapter uses official extension decoding and native instruction builders.
State requires the token account, its matching mint and keyed controller observations
from the same observed bank. It projects ordinary cumulative Spend and mint-wide
Permanent Delegate Spend. Only the exact local ELF digest named by token2022 constants
is supported; this is not live deployment coverage or complete protocol coverage.

Account extensions and mint extensions other than PermanentDelegate are unsupported.
Malformed extension data is an error, never evidence that authority is absent. Mint,
Freeze, Close and Burn powers are not projected by this adapter. Multisig and program
controllers remain unsupported. ARM is unchanged.

Native tests prove that Permanent Delegate bypasses the ordinary delegated allowance.
When both delegate roles name the same principal, compilation returns Unsupported
rather than claiming the ordinary allowance is independently consumed. Freezing one
account suspends its ordinary delegation; it does not revoke mint-wide authority.
Native balance and frozen-account checks still apply to permanent transfers.

Both the owner and ordinary delegate can revoke ordinary delegation. Canonical declared
Diff agrees with native execution and recompilation; Permanent Delegate survives.
Permanent Delegate management actions are not exposed yet. Golden account and mint
bytes are reproduced by native initialization, minting and approval.

## Subscriptions delegations

subscriptions::DelegationAdapter uses the official subscriptions 0.5.0 account types and
instruction builders for fixed, recurring and plan-backed subscription delegations.
DelegationState supplies the delegation, authority, canonical source account, matching
mint, keyed wallet observations and verified SPL program version. Subscriptions also
require the current bound plan through DelegationState.plan; other kinds use None.
Every account must come from the same observed bank. A deleted account must be explicitly
observed; a missing account in an incomplete scan is insufficient evidence.
Recurring and subscription projection also require the observed bank's unix timestamp, as declared by
source_requirements. Missing clock evidence fails closed. Adapter provenance is version 0.3;
the previous FixedAdapter/FixedState names are replaced by this shared delegation API.

The adapter emits the PDA's technical token allowance separately from the delegatee's
derived fixed allowance. A 100-unit grant after a 40-unit pull has 60 remaining; the
shared PDA approval is not a merchant grant. Inclusive native expiry becomes ARM's
exclusive boundary, with zero and i64::MAX handled without overflow. ARM remains unchanged.
Its generic evaluator returns Unknown for active derived records until lineage evaluation
is implemented; these records do not promise balance or transaction success.

Recurring state projects its per-period cap and remaining allowance at the observed clock.
Skipped periods grant one current cap, without accumulation. At inclusive finite expiry,
the final period remains in force rather than opening another allowance. ARM's generic
evaluator returns Unknown at that period's ordinary half-open boundary, even if the native
final allowance remains spendable. Projection preserves the native period and budget.
An unrepresentable period end returns Unsupported rather than overflowing.

The delegator's native Revoke closes only the selected delegation and refunds its recorded
payer. The declared removal matches native execution and recompilation; shared token
approval survives. Direct token revoke suspends the retained grant. Closing the authority
also suspends it; recreating the authority in the same slot preserves its generation
binding, while recreating it in a later slot invalidates that binding.

Subscriptions emit one shared principal/budget for the plan owner and allowed pullers,
with an independent recipient constraint when the plan restricts destination owners.
Pending cancellation remains active until its exclusive cutoff. Resume preserves
period consumption. Sunset keeps existing subscriptions collectible while puller
removal changes their principal set. Inclusive plan end caps cancellation at end plus one.

Plan-owner membership administration is a separate Partial ModifyAuthority record,
scoped to the plan's authority set. It does not promise arbitrary edits: sunset permits
only removals, ownership and billing terms are immutable, and native end rules apply.
No plan-edit action or permission compiler is exposed. A live active plan past its
finite end cannot update membership; a sunset plan retains its removal path.

Cancel, CancelNow, Resume and terminal subscriber Revoke use official native builders.
CancelNow includes both subscriber and plan-owner signatures. Resume binds the observed
cancellation cutoff. Native execution and recompilation agree with canonical declared
Diff at the observed bank clock, including empty changes when the plan already imposes
the cancellation cutoff. Execution at another clock requires fresh simulation/state;
a declared Diff does not promise that a delayed transaction has the same result.

Support includes the exact local fixture and verified devnet Subscriptions deployment,
paired with their respective full payload hashes. DEVNET_DEPLOYMENT and
DEVNET_PROGRAM_VERSION identify deployment slot 506642674; the fixture pair remains
unchanged. The October 9 finalized capture binds program, ProgramData, SPL and Clock
to one bank. The official deployment's verified hash matches the rebuilt source;
the captured executable reproduces all 59 native fixture transitions and the native
Cancel/CancelNow/Resume/Revoke semantic round trips. See [SOURCE_LEDGER.md](docs/research/SOURCE_LEDGER.md).
The runtime must validate the complete payload and selector for each observation;
these constants establish neither an open-ended support interval nor address coverage.
Unknown account versions and malformed bindings fail closed. Token-2022 and program
controlled acting wallets remain unsupported. Missing plan evidence fails closed;
an observed closed plan is unsupported rather than a fabricated merchant identity.
Native global authority revoke, plan-edit actions and sponsor subscription recovery
are not exposed. All three delegation kinds have native fixtures, ARM goldens and
native control/Diff/recompilation tests.

## Squads V4 spending limits

`squads::SpendingLimitAdapter` supports token spending limits on controlled multisigs
for the exact mainnet program payload named in `squads.rs`. One limit compiles to one
Spend authorization shared by its listed members, scoped to the vault, the mint, the
amount per period and the allowed recipients, plus a separate administrative
RevokeAuthority for the multisig's config authority. Limit members are not multisig
members: membership, voting or approval rights never become Spend here.

The stored remainder is reported as observed with its period start. Once that period
has passed the program will restore the full amount on the next use, so ARM reports
availability as unknown instead of guessing the reset. An allowance is not a balance;
the retained mainnet vault holds less than its members are permitted to spend.

The multisig is read in full and must derive the limit's parent address; a parent the
program would refuse yields no authority.

Revoke returns the native removal signed by the config authority. Autonomous
multisigs, where limits change by member vote, and native SOL limits return
`UnsupportedOperation`: a voting threshold is not one signer, and the lamport path has
no executed fixture. Proposals, vault transactions, batches, time locks and member
permissions are not interpreted. No live deployment support is claimed until Cataloger
holds executable and runtime evidence for this program.

## Wallet handoff

`signReviewedTransaction(reviewedBytes, signTransaction)` accepts the legacy wire
transaction returned by the runtime's verified SPL revoke endpoint. Call it only
after reviewing that transaction and its simulation evidence. The callback must
use the wallet's **signTransaction** operation, never signAndSendTransaction.
The SDK cannot prevent a callback from submitting; choose a sign-only wallet API.

The helper retains its own review snapshot, gives the wallet a separate buffer,
and accepts the result only when the entire message is unchanged and every required
Ed25519 signature verifies. It returns a separate copy of those exact signed bytes.
It neither supplies keys nor sends transactions. Wallet rejection is propagated
without retrying. Versioned transactions remain unsupported by this handoff.

Use the returned bytes for submission. Changing the blockhash, fee payer, account
list or instructions requires fresh simulation, review and signatures. Preserve
the endpoint's last-valid block height without narrowing its integer precision.
Check lifetime and observation freshness before submission; retain the transaction
signature and reobserve finalized state before claiming that revocation succeeded.
Signature verification establishes neither native execution success nor deployment
coverage. This helper is not a general transaction sanitizer or a wallet UI.

The wire fixture comes from Cataloger's native revoke simulation tests at
`b511648bba96e826c51bf7c08b6975d8570c7492`. Signing tests replace only its owner
with a local test key. No chain transaction is submitted by these tests.
Kit 8.4.0 supplies the codecs, key import and signature verification.

## Reviewed submission

`signAndSubmitReviewedTransaction(rpc, reviewedBytes, signTransaction, config)`
connects the verified signing handoff to an ordinary Kit RPC client. Supply the
runtime simulation's cluster genesis hash, observation slot as `minContextSlot`,
and replacement blockhash/last-valid block height as `lifetime`. Heights and slots
must be parsed losslessly into bigint. The lifetime blockhash must match the reviewed
message. The wallet callback must be sign-only.

The helper checks cluster identity, block height and blockhash validity before
requesting a signature and again afterward. It verifies the unchanged signed message,
then submits those exact bytes with preflight enabled and the observation slot floor.
Finalized commitment is selected explicitly; Kit omits it on the wire because it is
the RPC server default. It never replaces the blockhash or requests another signature.

`status: "submitted"` means the RPC accepted the request and returned the expected
signature. `status: "unknown"` means the send response failed or returned a different
signature. Both results retain `signature` and Base64 `signedTransaction`; the latter
can be passed as `signed_transaction` to the runtime's finalized verification endpoint.
An unknown response may still have reached the chain. Inspect that same signature
before considering another transaction. Failures before submission reject the promise.

Neither status means confirmed or finalized. The runtime must still reobserve,
recompile and retain verification before reporting success. These checks establish
lifetime and cluster consistency, not fresh authority state or runtime attestation.
The caller must retain the reviewed simulation/state version and invalidate the review
when its authorization evidence changes. Account state can change after any RPC check.
Browser review, wallet discovery and finalized verification polling remain integration
work. Tests use the native revoke wire fixture, local keys and a local RPC test server;
they submit no public-chain transaction.

## Checks

```sh
bun run fixture:squads
cargo fmt --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
bun install --frozen-lockfile
bun test
bun run typecheck
git diff --check
```

The TypeScript public entry point remains index.ts. It exports decodeEvent, the event
types, discriminators and the reviewed signing/submission helpers. The Rust public entry point is
src/lib.rs. Source decisions and remaining work are recorded under docs/research.

`fixture:squads` fetches the deployed Squads V4 program and verifies its pinned SHA256.
The AGPL-3.0 binary is Git-ignored and read only at test runtime.
