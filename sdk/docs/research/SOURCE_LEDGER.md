# Source ledger

## Reviewed transaction submission

- Reuse: DEPEND on Kit RPC 8.4.0, same MIT source revision
  `0a296c6ba8cd7e055f79364b64dbf01907172ea2` as the wallet codecs below.
  TARGETED SOURCE: `rpc/src/{rpc,rpc-transport,rpc-default-config}.ts`,
  `rpc-api/src/{getGenesisHash,getBlockHeight,isBlockhashValid,sendTransaction}.ts`,
  `rpc-transformers/src/request-transformer-default-commitment-internal.ts`,
  and existing transaction signature/wire APIs. No source copied.
- Official [sendTransaction](https://solana.com/docs/rpc/http/sendtransaction),
  [getBlockHeight](https://solana.com/docs/rpc/http/getblockheight) and
  [isBlockhashValid](https://solana.com/docs/rpc/http/isblockhashvalid) define
  acceptance, expiry and minimum context semantics. Acceptance is not finality.
- Kit removes an explicit finalized commitment from request options because it is
  the server default. The HTTP test checks actual emitted requests, including native
  preflight and minimum slot, rather than expecting our input options verbatim.
- EXECUTED LOCALLY: real Kit HTTP transport and WebCrypto signing of the existing
  revoke fixture with substituted test keys. Expiry across signing, cluster changes,
  malformed/provider failures, unsigned/altered messages and uncertain submission
  retain fail-closed behavior. Lost responses retain the signature and signed bytes
  for subsequent finalized verification. No public-chain submission or new RPC layer.

## Wallet signing and transaction introspection

- Source: https://github.com/anza-xyz/kit, tag `v8.4.0`, revision
  `0a296c6ba8cd7e055f79364b64dbf01907172ea2`; MIT license inspected.
  Wallet dependencies are pinned to the published 8.4.0 packages in bun.lock.
- Inspection: TARGETED SOURCE in transaction codecs, compiled message codecs,
  transaction signatures, addresses/public-key and keys/signatures. Relevant API:
  getTransactionDecoder/Encoder, getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress and verifySignature. No upstream source copied.
- Reuse: DEPEND. Kit's isFullySignedTransaction/assertIsFullySignedTransaction
  check signature presence, not cryptographic validity. The SDK must compare the
  retained message and verify all returned signatures before allowing submission.
  Wallet buffers can alias mutable caller data; retain independent byte snapshots.
- Local tests exercise Kit codecs and real WebCrypto signatures against the runtime
  revoke wire fixture from Cataloger `b511648bba96e826c51bf7c08b6975d8570c7492`.
  The fixture is unchanged; signing tests substitute generated test keys. This is
  local handoff evidence, not browser-wallet or finalized network execution evidence.
- Introspection inspection: TARGETED SOURCE in the same release's
  `packages/transaction-introspection/src/{decode-rpc-transaction,walk-instructions,get-inner-instructions}.ts`
  and `src/__tests__/walk-instructions-test.ts`. Upstream tests were read, not run.
  decodeTransactionFromRpcResponse handles wire/base64/base58 and unparsed JSON;
  walkInstructions exposes outer and inner positions and resolves account indices.
- Reuse decision: PUBLIC API candidate for transaction observation, not installed
  as a project dependency yet. Missing inner metadata yields only outer instructions.
  Orphan inner groups are appended rather than rejected; upstream tests preserve
  this display behavior. Velon must validate evidence completeness and positions.
  Returned account roles derive from transaction account metadata and do not prove
  each CPI's actual signer privileges. Introspection does not verify execution,
  finality, deployed code, or authorization meaning.

## Subscriptions maintainer study

- Source: https://github.com/solana-foundation/subscriptions, revision
  `56de552a26a0f0af437c0ce5191b3309741cc596`; MIT license inspected.
- Inspection: DEEP SOURCE for authority semantics, relevant native/client tests,
  generated client slices, ADRs, security notes, July 30 audit and replay history.
  EXECUTED LOCALLY only for 51 host unit tests and seven selected client tests.
  That study did not execute native SBF integration, full Surfpool suites or fuzzing.
  Subsequent fixed-delegation SBF evidence is recorded below.
- Relevant source: instructions and their helpers, state/versioning, event engine,
  program/build.rs, IDL, generated Rust/TS accounts and control builders, TS overlays,
  integration lifecycle/replay tests and fuzz budget/conservation invariants.
- History: PRs 214, 221 and 222 bind approvals to observed state and document
  residual replay; PR 244 adds ephemeral hook context. Current source supersedes
  old PR layout prose and ADR empty-payload descriptions. Open PR 252 is not part
  of this baseline and is not borrowed as accepted behavior.
- Audit: audited commit d6b3a5dc, remediation verified debb4f75, not blanket HEAD
  coverage. The report distinguishes fixed findings from acknowledged behavior.
- Experience: shared technical authority is not a merchant grant; a period cap
  belongs to one native budget; active state is not collectible funds; slot/value
  freshness checks are not unique epochs; recovery compatibility is distinct from
  spending-version support. Native errors and boundaries outrank prose.
- Reuse: GENERATE/PUBLIC API for future client integration; PATTERN ONLY for tests
  and observation design. No source code copied into Catalyst or ARM.
- Durable findings: SUBSCRIPTIONS_SEMANTICS.md, SUBSCRIPTIONS_FIXTURES.md and
  SUBSCRIPTIONS_ARM_GAPS.md. No adapter or ARM schema change in this milestone.

## Native instruction types

- Source: solana-sdk crates, https://github.com/anza-xyz/solana-sdk.
- Versions: solana-instruction 3.4.0 and solana-pubkey 4.2.0, exact Cargo pins/lockfile.
- Published source commits: instruction `1d4d322b9eac89e6c8069464e0c184d72584106c`,
  pubkey `5b985fd7b60de1c845c25bb2d4fc16e19c9ee6ab` (crate .cargo_vcs_info.json).
- License: Apache-2.0, verified from published crate manifests.
- Inspection: TARGETED SOURCE, published instruction fields, AccountMeta signer/writable
  requirements and new_with_bytes constructor; dependencies executed through ABI tests.
- Reuse: DEPEND. No source copied. Native account metadata carries signing requirements;
  Catalyst does not introduce its own instruction or public-key representation.
- Upgrade review: native adapter client dependencies must agree with these type versions.

## ARM

- Source: https://github.com/dakewamama/arm.
- Revision: 3b91100314473b616b5fd6f77214c6b6282a1dfb.
- Inspection: EXECUTED LOCALLY (model and all fixtures/tests); project-owned dependency.
- Reuse: DEPEND. No separate Catalyst ARM domain model or handwritten TS mirror.

## Token client interfaces

- Sources: https://github.com/solana-program/token and
  https://github.com/solana-program/token-2022.
- Published packages inspected: spl-token-interface 3.0.0, commit
  `46eaacd2c13629eb3436354ed650a8df8b202bc4`; spl-token-2022-interface 3.1.2,
  commit `0e74c157aebd5dbdef8035b526a56f0e416f9fb6`.
- License: Apache-2.0, verified in both published manifests.
- Inspection: TARGETED SOURCE and EXECUTED LOCALLY for the supported slices. Read state decoding,
  instruction revoke builders, extension inventory/access and PermanentDelegate helper.
- Tests inspected: classic test_instruction_unpack_panic/proptest; Token-2022
  get_extension_types_with_opaque_buffer and malformed TransferHookAccount access tests.
- Experience: use public Pack APIs and native builders. Base unpacking leaves TLV lazy;
  a helper using get_extension().ok() loses malformed-versus-absent information.
- Reuse: DEPEND for typed decoding; PUBLIC API for native builders. No source copied.
- Compatibility: both interfaces compiled with instruction 3.4.0/pubkey 4.2.0 in an
  isolated proof. Upstream solana-address 1.1.0 re-exports Address 2.x; type equality
  was checked by assignments and native instruction return types, without conversion.
- Classic interface now EXECUTED LOCALLY through Approve, Transfer and Revoke fixtures.
- Token-2022 delegate interpretation is executed locally; live version matching remains unverified.

## Native classic token fixture

- Source: https://github.com/anza-xyz/mollusk, published mollusk-svm and
  mollusk-svm-programs-token 0.15.1, commit f432ef136ee9779d2a814ebf2b80f44c10607255.
- License: Apache-2.0, verified from the published LICENSE files (manifest uses license-file).
- Inspection: EXECUTED LOCALLY. Read token helper APIs, update script, loader setup,
  process_instruction and result account/error types. Upstream fixture notes capture
  mainnet-beta slot 347196212; that note does not establish current chain coverage.
- Token ELF SHA256: 8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697.
  Test asserts the digest before golden compilation. Fixture capture metadata alone
  does not establish live coverage; the byte observation below bounds an additional selector.
- Native source checked: spl-token 9.0.0 processor.rs transfer, approve, revoke,
  validate_owner; interface state Pack/layout and revoke/approve/transfer builders.
- Experience: signature checks happen in the native processor; frozen Revoke fails;
  the allowance is cumulative and native consumption clears delegation at zero.
- Reuse: DEPEND/PUBLIC API for fixture ELF loading and instruction execution. No source
  code copied. Upstream fixture lockfile was a resolution seed; the project lockfile
  retains only its own dependency graph. No program crate is a runtime dependency.
- Transaction agreement: TARGETED SOURCE of pinned Mollusk
  `harness/src/lib.rs::process_transaction_instructions` and
  `harness/tests/transaction_instructions.rs`. This method runs one message/context
  and restores input accounts on failure; instruction chains are separate invocations.
  EXECUTED LOCALLY with native SPL revoke plus a failing transfer, and cancellation
  at a delayed Clock against both verified Subscriptions executables. Reuse: DEPEND.
  SDK verifies only projected ARM changes; the caller checks native success and binds
  instruction/account/clock evidence. No signature, fee, finality or coverage claim added.
- Further executed evidence: InitializeMint2 + MintTo reproduce mint/token golden bytes;
  MintTo changes supply and balance; Freeze/Thaw change delegate availability; canonical
  SetAuthority removals agree with recompilation, including both Freeze/Thaw removals.
- Additional TARGETED SOURCE: spl-token 9.0.0 process_set_authority, process_mint_to,
  process_toggle_freeze_account and official set_authority builder. Source comments
  explain why clearing mint/freeze authority is irreversible. Native fixture verifies
  restore attempts fail without changing state. No source copied.
- Close authority study: official process_close_account, process_set_authority
  CloseAccount branch, is_owned_by_system_program_or_incinerator, and close_account
  builder. TARGETED SOURCE plus EXECUTED LOCALLY against the same hashed ELF.
- Executable facts: absent explicit closer falls back to token owner; clearing it changes
  the current principal instead of deleting Close permission; frozen empty accounts close
  even though frozen authority reset fails; nonempty ordinary accounts fail to close;
  native InitializeAccount3 creates wrapped SOL that closes with a nonzero balance.
- Native closure returns lamports to the selected recipient, removes account data and
  owner, and recompiles to no Close authority. Same-owner reset has no current semantic
  delta. Source/recipient alias, missing signature and wrong controller fail unchanged.
- Reuse: official Pack/state methods, SetAuthority/CloseAccount/InitializeAccount3 public
  APIs and Mollusk execution. No source copied; no balance predicate invented in ARM.

## Observed classic token deployment (October 8, 2026)

- Evidence: public mainnet finalized `solana program show` for
  `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. Loader-v3 ProgramData:
  `3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2`; lastDeploySlot `419472000`,
  authority none, dataLen `108600`.
- `solana program dump` returned a program whose full payload SHA256
  is `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697`, equal
  to the pinned Mollusk token ELF and `spl::PROGRAM_VERSION`.
  This is OBSERVED-BYTE EQUALITY on October 8, 2026, not a reproducible-source-build claim.
- A complete finalized `getMultipleAccounts` response at slot `454547887` retains
  the same executable, loader metadata and Clock in Cataloger's
  [native capture](https://github.com/dakewamama/cataloger/blob/main/services/catalyst-indexer/tests/fixtures/mainnet-spl-response.json).
  The raw response SHA256 is
  `68ffbb2b01685f3bdadf174780681fb4dac9355b58282a09d145ff8f5acd1b0e`.
- Additional supported selector: `spl::LIVE_DEPLOYMENT` is exactly
  `solana:loader-v3:3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2:419472000`.
  The fixture selector remains supported. Delegate, Mint and Close retain exact
  protocol, full payload hash and adapter version `0.1` checks.
- Runtime must verify each observation: validate raw program, ProgramData and Clock
  from the same finalized response, comparing the full program payload hash and exact
  deployment selector before supplying Context. A label alone is insufficient.
  This observation establishes no open-ended slot interval or current coverage.
- Native Revoke, declared Diff and recompilation are tested for both contexts using
  the same hashed ELF locally in Mollusk. These tests do not execute on mainnet.

## Historical program source comparison

- Published spl-token 8.0.0 at `1f61242183ea9b43d37b47a1b4f745eb1beb32de` and
  spl-token-2022 8.0.1 at `4a10133df35b9c8635c2d553043b166e240a0f9f`.
- License: Apache-2.0, verified from manifests. TARGETED SOURCE, not executed locally.
- Relevant files: state.rs, instruction.rs, processor.rs process_revoke, extension/mod.rs
  and extension/permanent_delegate.rs. Native clients match the currently pinned 2.x types.
- Verified source: both reject revoke on frozen state and clear delegate/allowance.
  Classic revoke validates the owner; this Token-2022 version also accepts the current
  delegate as revoking authority. Do not infer identical controllers from shared opcodes.
- Reuse: PATTERN ONLY for interpreting the distinction; no source copied. These archived
  versions are not proof of current deployed behavior or a reason to choose an old client.

## Native Token-2022 fixture

- Source: https://github.com/anza-xyz/mollusk, published fixture 0.15.1,
  commit f432ef136ee9779d2a814ebf2b80f44c10607255; Apache-2.0.
- ELF SHA256: b2a7ce1ea6dfbcbc5ccb0e7f48f7c61dced1a86582d1c7d2e059ac54ed612da4.
  The test asserts this digest. Capture metadata is not live deployment coverage.
- Program source: https://github.com/solana-program/token-2022, published 11.1.0,
  commit 8867f751c0f69367ba03af4f85510b5611989491; Apache-2.0.
- Inspection: TARGETED SOURCE of transfer, revoke and PermanentDelegate SetAuthority;
  EXECUTED LOCALLY against the pinned ELF. Interface extension inventory and typed access
  tests informed malformed-data fixtures. No claim of a complete program review.
- Native initialization reproduces both raw goldens. Ordinary delegation consumes its
  allowance; Permanent Delegate bypasses it while retaining balance/frozen checks.
  Owner and delegate each revoke ordinary delegation without removing Permanent Delegate.
  Native permanent-authority clearing removes that projection and disables its transfers.
- Counterexample: approving the Permanent Delegate as ordinary delegate allows a transfer
  exceeding the ordinary allowance without consuming it. That overlap is Unsupported,
  not an independently consumable cumulative grant. No ARM schema change was needed.
- Reuse: DEPEND/PUBLIC API for decoding, builders and SVM execution. No source copied.
  Unknown semantic extensions fail closed; malformed typed data cannot become absence.

## Subscriptions fixed-delegation fixture

- Source: solana-foundation/subscriptions `56de552a26a0f0af437c0ce5191b3309741cc596`,
  MIT. DEEP SOURCE for the authority study; fixed lifecycle executed locally.
- Official generated Rust client: crates.io `subscriptions` 0.5.0, source commit
  `5a347ffaa969036061d274d3c91e0277962e2b51`. Reuse classification: DEPEND.
- Mollusk 0.15.1 executes the program built with Solana platform-tools v1.54.
  Locked offline rebuild with cargo-build-sbf 4.1.0, rustc 1.89.0 and default v0
  architecture reproduced the identical ELF. The upstream worktree stayed clean.
  Program ELF SHA256 `a59467f0b2d0a0211b06ddf9a3f3141a90eaea6faeeaa3d19541288eaa082107`;
  Token ELF SHA256 `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697`.
- Fixture captures native authority initialization, fixed grant creation, a 40-unit
  pull from a 100-unit grant, rejected 61-unit pull (error 300, all accounts stable),
  and delegator revoke. Revoke closes fixed state but preserves shared token approval.
  Token/mint fixture data is harness-installed; authority and grant are program-created.
- Reuse: DEPEND official client builders and Mollusk. No upstream source copied.
  This is local protocol evidence, not live deployment support.
- DelegationAdapter uses the same official client for production decoding and revoke.
  subscriptions-fixed-arm.json independently specifies the two expected ARM records.
  Native tests verify canonical revoke/Diff/recompilation, sponsored rent refunds,
  expiry boundaries, unsigned failures, token revoke and authority incarnation behavior.
  ARM is unchanged; derived availability remains conservatively Unknown.

## Subscriptions recurring-delegation fixture

- Same official repository, MIT license, source/client revisions and ELF hashes as
  the fixed fixture above. EXECUTED LOCALLY through Mollusk with raw before/after
  accounts, instruction metadata, clock evidence and rejected-state rollback.
- Relevant source: `program/src/instructions/helpers/transfer_validation.rs`,
  `create_recurring_delegation.rs`, `transfer_recurring_delegation.rs` and recurring
  account layout; upstream tests: `test_transfer_recurring_delegation.rs`.
- Experience: an attempted period rollover can roll back on transfer failure.
  Observation must derive allowance from the bank clock without claiming a write.
  Skipped periods do not accumulate; finite expiry retains the final in-bounds
  period, including its remaining allowance at the inclusive endpoint.
- Reuse: DEPEND official client decoding/builders and Mollusk; REIMPLEMENT FROM SPEC
  for the independently written semantic projection. No upstream source copied.
- `subscriptions-recurring.json` captures 13 native transitions;
  `subscriptions-recurring-arm.json` specifies the complete partial-pull projection.
  DelegationAdapter version 0.2 shares account validation and native revoke with fixed
  grants. Native tests prove declared removal, recompilation, future start and unbounded
  rollover. No live deployment coverage or ARM schema change is claimed.

## Subscriptions lifecycle fixture

- Same pinned MIT source, official 0.5.0 client and ELF hashes as the delegation
  fixtures. EXECUTED LOCALLY: 41 transitions in subscriptions-lifecycle.json.
- Relevant handlers: subscribe, transfer_subscription, cancel_subscription,
  resume_subscription, cancel_subscription_now, update_plan and revoke_delegation.
- Experience: native plan status uses Sunset=0 and Active=1. Sunset blocks new
  subscriptions while existing ones collect. Cancellation is an exclusive time
  boundary, not immediate suspension; resume preserves the shared period budget.
  Immediate cancellation requires joint signatures and binds the observed period
  start. It preserves other subscriptions and the shared technical approval.
- Rejection fixtures cover stale subscribe consent/generation, active/pending
  subscriber revoke, stale plan edits and puller restoration after sunset.
  Finite plan end remains inclusive; cancellation caps at end plus one and
  never opens a fresh period at the final boundary.
- Reuse: DEPEND/PUBLIC API for official instruction builders and Mollusk. No source
  copied. The capture proves native behavior, not yet its semantic projection.

## Subscriptions semantic compilation

- DelegationAdapter 0.3 uses official SubscriptionDelegation and Plan decoding,
  validating owner, exact kind/length, header version, native bindings and current
  wallet/clock evidence. Reuse: DEPEND for clients; REIMPLEMENT FROM SPEC for
  semantic translation and native time calculations. No source copied.
- One principal set shares one period budget; recipient constraints remain separate.
  Plan-owner membership management is Administrative and Partial, not spend power.
  Existing fixed/recurring goldens change only adapter provenance to 0.3.
- Native control uses CancelSubscription, CancelSubscriptionNow, ResumeSubscription
  and RevokeDelegation public APIs. Declared Diff changes lifecycle/virtual period
  usage at the observed clock; native execution and recompilation are its proof.
  Canonical cancellation can have no semantic delta when finite plan end already
  imposes that cutoff. Retained signatures still obey the documented native limits.

## Verified devnet deployment (October 9, 2026)

- Native source: solana-foundation/subscriptions
  `56de552a26a0f0af437c0ce5191b3309741cc596`, MIT. This remains the adapter baseline.
  [Official devnet deployment](https://github.com/solana-foundation/subscriptions/actions/runs/37008589067),
  job `110842633884`, built that commit on October 2 using solana-verify 0.5.2,
  Agave 3.1.10 and platform-tools v1.52. Program-v0.5.0 instead tags `364a419`;
  a client or release name alone does not establish executable identity.
- Verifier: https://github.com/solana-foundation/solana-verifiable-build,
  tag v0.5.2, commit `f8cfe2f834f4334aad9c60a29284de0ba396f829`, MIT.
  TARGETED SOURCE of `src/main.rs::get_binary_hash`, build invocation and
  `docker/v3.1.10.Dockerfile`. Reuse: PUBLIC API / PATTERN ONLY; no source copied.
  The verified hash excludes trailing zero allocation bytes. Runtime identity
  continues to hash the entire observed payload; it does not normalize padding.
- Official image digest:
  `solanafoundation/solana-verifiable-build@sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3`.
  The deployment log prints verified executable hash
  `e705f5a309f84f849b402f20de4bea5f2cc1d1d4f691ba7caabcb07c8b46af51`.
- EXECUTED LOCALLY: locked offline source rebuild using official Agave 3.1.10
  and platform-tools v1.52 reproduced that verified hash. This used the native
  toolchain, not Docker. The stripped 129168-byte ELF's full SHA256 is
  `1135b0933f7b4e291a9cf1c4e839641cbbad42eb822c514d901c9f0fce6da5ed`.
- Fresh public devnet finalized `getMultipleAccounts` at slot `509022453`
  retains both native programs, their ProgramData and Clock in one unsliced
  response. Genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`;
  Clock timestamp: `1791511613`; response SHA256:
  `794c6c9fbb35697eabf1931fb42440cca8b8a8dc2a42de95fb95b1a945651f53`.
- Subscriptions ProgramData `HaYb5J9eXooZuNzN3z6TfuzVDcaTfiDdDPWCFtexFfMg`,
  deployment slot `506642674`, has a 133280-byte payload. Its verified hash
  matches both the official job and the rebuild; full payload SHA256:
  `2675ad1d2b5068d47fc5d169156cf4859a9c21c0406ce63e3828e3b7320fddbf`.
  The retained payload is `tests/fixtures/subscriptions-devnet-program.so`.
- Devnet SPL ProgramData `3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2`,
  deployment slot `451008000`, has the same complete 108600-byte payload as
  `spl::PROGRAM_VERSION`. DEVNET_DEPLOYMENT binds that separate deployment.
- EXECUTED LOCALLY: all 59 fixed/recurring/subscription native transitions reproduce
  unchanged account bytes and rejection outcomes against the captured executable.
  Canonical subscription controls are executed, diffed and recompiled for both
  version pairs. The fixture pair is preserved; cross-paired hashes are rejected.
  These are local conformance proofs and program identity evidence, not live user
  grants, chain execution, complete coverage or blanket audit coverage of this commit.
