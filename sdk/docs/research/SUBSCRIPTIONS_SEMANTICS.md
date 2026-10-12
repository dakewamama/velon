# Subscriptions semantics

Study baseline: official solana-foundation/subscriptions at
`56de552a26a0f0af437c0ce5191b3309741cc596`, inspected October 3 and resumed
October 7, 2026. This is a source baseline, not verified live deployment coverage.
Program identity alone does not establish these semantics on a cluster.

[Pinned source](https://github.com/solana-foundation/subscriptions/tree/56de552a26a0f0af437c0ce5191b3309741cc596).
Paths below are relative to that source. Source findings and documented security
limitations are distinguished from execution evidence. No upstream code was copied.

## Authority and resources

`initialize_subscription_authority.rs` creates one authority PDA per user and mint
and approves it on the user's canonical ATA for `u64::MAX`. This is a finite,
consumable token approval. It is not an unlimited merchant grant. The user signs;
a sponsor funds rent without gaining spending or authority-management rights.
Idempotent initialization refreshes the approval but preserves the original payer
and generation.

The technical token principal is the authority PDA. The Subscriptions program
signs for it only through its native execution paths. Effective spending principals
are the fixed/recurring delegatee, or the subscription plan owner and live allowed
pullers. The plan PDA stored as a subscription's `header.delegatee` is a binding
to policy, not the merchant wallet. Callers and destination beneficiaries can differ.

`instructions/helpers/transfer_utils.rs` requires the canonical source ATA for
the delegator, mint and token program. A destination must have the same mint but
need not be an ATA. Fixed and recurring delegations allow third-party destinations.
Subscriptions additionally check the destination token account's owner against
the plan's destination list. All-zero destinations mean unrestricted recipients;
zero padding is ignored when a whitelist exists.

## Native state

| State | Size | Meaning |
| --- | ---: | --- |
| SubscriptionAuthority | 106 | User, mint, original rent payer, bump, slot-derived generation |
| Header | 107 | Kind, account version, bump, delegator, delegatee, payer, authority generation |
| FixedDelegation | 187 | Header, authority address, mint, remaining amount, optional expiry |
| RecurringDelegation | 211 | Header, authority, mint, period start/length, expiry, period cap and consumption |
| SubscriptionDelegation | 155 | Header, billing-term snapshot, period consumption/start, cancellation cutoff |
| Plan | 491 | Owner, status, mint, immutable terms/destinations and mutable control fields |

Verified in `state/*.rs`. Delegation header offsets are kind 0, version 1,
delegator 3, delegatee 35, payer 67 and generation 99. Only delegation accounts
carry this account-version header; neither plan nor authority should be decoded
as one. Current normal-operation account version is 1.

PDA derivations are native identity, not ARM fields: authority uses user/mint;
fixed and recurring use authority/delegator/delegatee/nonce; plan uses owner/id;
subscription uses plan/subscriber. Reusing an address does not prove the same
account lifecycle. See `state/common.rs` and the state-specific seed definitions.

## Spending budgets and time

`transfer_fixed_delegation.rs` checks the delegatee's signature and decrements a
remaining cumulative budget. Multiple partial pulls are supported. Fixed means
fixed total allowance, not one transaction.

`transfer_recurring_delegation.rs` uses the period cap minus consumption. Native
rollover advances by whole elapsed periods and resets consumption once. Missed
periods do not accumulate allowances. Creation permits a future start; a zero
start means landing time and requires a finite expiry to bound delayed activation.

`transfer_subscription.rs` checks the live plan, snapshotted terms and authority
generation. The owner and nonzero allowed pullers share the subscription's single
period budget. They do not each receive the full allowance. The period is anchored
to subscription creation and advances on collection; a current account does not
necessarily retain the original creation timestamp after rollover.

`instructions/helpers/transfer_validation.rs` is the executable time authority:

- Fixed/recurring finite expiry and plan end are inclusive: reject when `now > end`.
- Subscription cancellation is exclusive: reject when `now >= expires_at_ts`.
- Zero expiry/end means no boundary, not Unix epoch expiration.
- The 120-second tolerance applies to creation validation, not spending.
- At finite expiry, recurring advancement stops at the last period start strictly
  before expiry. It cannot create a fresh allowance beginning at expiry.

The native unit fixture `catch_up_at_exact_expiry_boundary_succeeds` uses start 0,
period 30, cap/consumption 100, expiry/now 90. It advances to 60 and permits the
final period's 100. `fully_used_final_period_does_not_open_a_period_past_expiry`
rejects another pull when that final period is already consumed. Both were run
within the 51 passing host tests. These are helper executions, not SVM round trips.

Amounts are gross debits in integer mint units. Token-2022 transfer fees can reduce
what a destination receives. No amount or period implies a guaranteed transfer:
native token approval, balance, frozen/paused state, extensions and hook execution
can independently block it.

## Lifecycle and control

`cancel_subscription.rs` lets the subscriber schedule cancellation at the next
period boundary, calculated from the current clock and stored period phase.
It caps this at finite plan end plus one, saturating at the integer limit, because
plan end is inclusive. A closed or mismatched plan causes immediate cancellation.
Pending cancellation remains billable before its cutoff.

`cancel_subscription_now.rs` requires both subscriber and current plan-owner
signatures and the observed `current_period_start_ts`. It sets the cutoff to now,
can shorten a pending cancellation and leaves the shared authority and other
subscriptions intact.

`resume_subscription.rs` requires the subscriber, matching observed cancellation
expiry, matching live plan terms, unexpired plan and matching authority generation.
It only resumes before the cancellation cutoff. It clears the cutoff without
resetting consumption or period start. It does not prove current token approval.

`revoke_delegation.rs` closes fixed/recurring state at the delegator's request.
Its recorded payer can recover fixed state after expiry or full consumption;
recurring recovery requires expiry. Subscription revocation by the subscriber
requires effective cancellation. Payer recovery also permits terminal plan
conditions: closed, term mismatch or expired. Rent returns to the recorded payer;
sponsor-funded closes require the appropriate recipient account.

`close_subscription_authority.rs` closes only the authority account. Token
approval can remain. `revoke_subscription_authority.rs` clears token approval
only when its delegate is the derived authority, then closes the authority if
open. Foreign or absent delegates are preserved. Neither operation deletes all
delegation accounts, and later observation must distinguish approval from
effective native collectibility.

`revoke_abandoned_delegation.rs` and `revoke_abandoned_subscription.rs` allow the
recorded payer to reclaim terminal state. A closed authority is terminal only
after its recorded creation slot has passed. A live generation mismatch is
terminal. Subscription abandonment obtains the mint from the bound live plan,
preventing an unrelated authority from being substituted; closed-plan recovery
uses ordinary revocation instead.

## Administrative authority

Plan owner spending and plan owner management are separate powers.
`update_plan.rs` changes status, end, pullers and metadata; mint, billing terms,
destinations and ownership stay immutable. Finite end can only be shortened.
Sunset blocks new subscriptions, not existing collections. After sunset only
puller removal/reordering within the live set is permitted. `delete_plan.rs`
requires owner signature and an expired finite end, without requiring sunset.

Plan sponsorship does not buy management authority or a recoverable deposit:
plan rent goes to the owner. Authority sponsorship likewise does not allow the
sponsor to force-close a healthy authority. `reclaim_excess_rent.rs` is a
permissionless refund to the recorded payer or plan owner, with fixed recipient;
it does not grant spending or policy control.

## Incarnation and replay

Authority `init_id` is the creation slot cast to `i64`; delegation headers copy it.
Transfers require equality. Reinitializing an existing authority preserves it.
Close/recreate in a later slot invalidates older bindings; same-slot recreation
can reuse it. `UNKNOWN_INIT_ID = i64::MIN` requires equality to the landing slot,
not evidence of signing time or a unique creation transaction.

The README security section and July 30 Cantina report document residual limits:

- A still-valid, unexecuted signed init plus sentinel create bundle can restore
  authority after revocation. Successful-transaction replay is a different issue.
- Authority init/close/revoke actions are not bound to an expected generation.
- Immediate-cancel binding is second-granular; same-second recreation can match.
- Resume checks an expiry value; same-period cancel/resume/cancel can repeat it.
- Plan updates compare observed values, not a monotonic revision; ABA can match.
- A subscribe near finite plan end can expose the full period budget for a partial
  window. It does not promise prorated billing or bind the mutable end timestamp.

Do not describe any of these as permanent revocation of all retained signatures.
Do not infer current human intent from the resulting account state.

## Versioning and observation

Normal handlers validate raw account kind and version before typed loads.
Future versions fail; older versions require migration, and no migration path
currently exists. Recovery loaders deliberately read the frozen V1 prefix without
normal-operation version gating. This native recovery permission is not evidence
that an adapter can interpret future spending semantics.

Instructions use one-byte discriminators. Self-CPI events use an eight-byte
Anchor-compatible tag plus one event byte. Transfers and subscription lifecycle
changes emit events, but authority/delegation creation, revocation and plan deletion
are not a complete event-sourced state machine. Transfer events now contain the
receiver token account; subscription transfers also contain the puller. Historical
event lengths differ across releases. Amounts remain gross debits.

Required observation for effective spending: deployment/version provenance,
delegation/subscription, current authority, source token account and mint, clock,
and live plan for subscriptions. Token-program version and relevant extensions
are additional dependencies. Hook-specific policy remains unsupported unless
independently interpreted. Missing dependencies must produce partial/unknown
evidence or Unsupported, never Exact effective authority.

Raw evidence must retain slot, transaction/instruction position, account owners,
native bytes, clock and adapter/schema versions. Events aid reconciliation;
current state plus coverage is canonical. The ephemeral TransferContext is created
and closed within a hooked transfer, so a post-transaction account fetch cannot
recover it. Its current layout is version 1, 67 bytes, with initiator at offset 2;
older PR prose describing offset 3 is superseded by current source.

## Verification scope

October 8: the pinned program executes 41 subscription lifecycle transitions in
tests/fixtures/subscriptions-lifecycle.json. DelegationAdapter 0.3 compiles the
captured subscription and live plan into unchanged ARM 0.1. The complete semantic
golden separates shared spending, recipient constraints and Partial membership
administration. Native cancellation/resume/revoke tests compare declared Diff with
execution and recompilation at the observed clock. Neither this proof nor the
source study establishes current live deployment coverage.

Read repository instructions, ADRs, dispatch, authority-relevant handlers/helpers,
state, events, IDL, generated client slices, handwritten overlays, relevant native
and client tests, fuzz invariants, changelog, security notes and relevant history.
Generated Rust decoding supplies typed fields but does not establish owner,
account-kind/version or deployment validity; adapters retain those checks.

Executed October 3: `cargo +stable test --locked -p subscriptions-program`:
51 passed, one documentation example ignored. Official client generation succeeded
using installed stable Rust for formatting. Selected Vitest validators, event
defaults and transfer-context tests: seven passed. This used host Rust 1.94.1,
not the repository's pinned 1.92. Full native integration, Surfpool lifecycle
and fuzz execution are not claimed.

October 7 follow-up: built the pinned program with platform-tools v1.54 and ran
the fixed-delegation create, partial transfer, over-limit rejection and revoke
sequence in Mollusk. Raw transitions and ELF hashes are recorded in
tests/fixtures/subscriptions-fixed.json. This proves that fixture's native
behavior only; it does not prove an ARM projection.

Cantina audit scope is commit-based: audited `d6b3a5dc`, remediation verified
through `debb4f75`, not the study HEAD. The report was read; acknowledged residual
risks are not claimed fixed. Current `program/build.rs` propagates IDL failures
and writes IDL without an environment gate, despite older CLAUDE guidance.
Current handlers/IDL also supersede ADR descriptions of empty resume/cancel-now
payloads. Source and tests outrank those descriptions.
