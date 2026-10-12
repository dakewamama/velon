use arm::{
    AuthorityKind, AuthorizationChange, Availability, EvidenceBundle, Lifecycle, NativeContext,
};
use catalyst_sdk::{self as sdk, spl::AuthorityState, subscriptions::*, Adapter, Context, Error};
use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use subscriptions::{
    accounts::{FixedDelegation, SubscriptionAuthority},
    instructions::{
        CloseSubscriptionAuthority, CreateFixedDelegation, CreateFixedDelegationInstructionArgs,
    },
    types::CreateFixedDelegationData,
    SUBSCRIPTIONS_ID,
};

fn context() -> Context {
    Context {
        program_id: SUBSCRIPTIONS_ID,
        native: NativeContext {
            protocol: "subscriptions".into(),
            deployment: DEPLOYMENT.into(),
            program_version: PROGRAM_VERSION.into(),
            adapter_version: ADAPTER_VERSION.into(),
        },
        evidence: EvidenceBundle {
            references: vec!["fixture:subscriptions-fixed.json:2:after".into()],
            observed_at: "fixture:slot:100".into(),
        },
    }
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn trace() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/subscriptions-fixed.json")).unwrap()
}

fn accounts(position: usize) -> Vec<(Pubkey, Account)> {
    decode_accounts(&trace()["transitions"][position]["after"])
}

fn decode_accounts(value: &serde_json::Value) -> Vec<(Pubkey, Account)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            (
                value["address"].as_str().unwrap().parse().unwrap(),
                Account {
                    owner: value["owner"].as_str().unwrap().parse().unwrap(),
                    lamports: value["lamports"].as_u64().unwrap(),
                    data: bytes(value["data"].as_str().unwrap()),
                    ..Account::default()
                },
            )
        })
        .collect()
}

mod recurring {
    use super::*;
    use arm::{Constraint, ConstraintExpr, UsageSemantics};
    use subscriptions::{
        accounts::RecurringDelegation,
        instructions::{CreateRecurringDelegation, CreateRecurringDelegationInstructionArgs},
        types::CreateRecurringDelegationData,
    };

    fn trace() -> serde_json::Value {
        serde_json::from_str(include_str!("fixtures/subscriptions-recurring.json")).unwrap()
    }

    fn accounts(position: usize, phase: &str) -> Vec<(Pubkey, Account)> {
        decode_accounts(&trace()["transitions"][position][phase])
    }

    fn state(accounts: &[(Pubkey, Account)], now: i64) -> DelegationState {
        let owner = Pubkey::new_from_array([1; 32]);
        let delegate = Pubkey::new_from_array([2; 32]);
        let mint = Pubkey::new_from_array([3; 32]);
        let (authority, _) = SubscriptionAuthority::find_pda(&owner, &mint);
        let (delegation, _) = RecurringDelegation::find_pda(&authority, &owner, &delegate, 0);
        let source =
            decode_instruction(&trace()["transitions"][0]["instruction"]).accounts[3].pubkey;
        let account = |key| {
            accounts
                .iter()
                .find(|(address, _)| *address == key)
                .unwrap()
                .clone()
        };
        DelegationState {
            delegation: account(delegation),
            authority: account(authority),
            source: AuthorityState {
                address: source,
                account: account(source).1,
                authorities: vec![account(owner), account(delegate)],
            },
            mint: account(mint),
            token_program_version: sdk::spl::PROGRAM_VERSION.into(),
            unix_timestamp: Some(now),
            plan: None,
        }
    }

    fn context(position: usize, phase: &str) -> Context {
        let mut context = super::context();
        context.evidence = EvidenceBundle {
            references: vec![
                format!("fixture:subscriptions-recurring.json:{position}:{phase}"),
                format!("fixture:subscriptions-recurring.json:{position}:clock"),
            ],
            observed_at: format!("fixture:slot:{}", 100 + position),
        };
        context
    }

    #[test]
    fn native_state_matches_recurring_golden_and_requires_clock() {
        let state = state(&accounts(2, "after"), 1_800_000_000);
        let context = context(2, "after");
        let actual = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let expected: Vec<arm::Authorization> =
            serde_json::from_str(include_str!("fixtures/subscriptions-recurring-arm.json"))
                .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(
            actual,
            sdk::compile_state(&DelegationAdapter, &state, &context).unwrap()
        );
        assert!(DelegationAdapter.source_requirements(&state).clock);
        assert_eq!(
            actual[1].availability_at(1_800_000_000).unwrap(),
            Availability::Unknown
        );
        let mut state = state;
        state.unix_timestamp = None;
        assert_eq!(
            sdk::compile_state(&DelegationAdapter, &state, &context),
            Err(Error::InsufficientEvidence)
        );
        let mut context = context;
        context.native.adapter_version = "0.1".into();
        assert_eq!(
            sdk::compile_state(&DelegationAdapter, &state, &context),
            Err(Error::UnsupportedVersion)
        );
    }

    #[test]
    fn projection_matches_native_rollover_and_inclusive_expiry() {
        let trace = trace();
        for (position, phase, start, remaining, availability) in [
            (2, "after", 0, 40, Availability::Unknown),
            (4, "before", 90, 100, Availability::Unknown),
            (4, "after", 90, 100, Availability::Unknown),
            (5, "after", 90, 0, Availability::Inactive),
            (7, "before", 120, 100, Availability::Unknown),
            (7, "after", 120, 40, Availability::Unknown),
            (8, "before", 120, 40, Availability::Unknown),
            (8, "after", 120, 0, Availability::Unknown),
            (10, "after", 120, 0, Availability::Inactive),
        ] {
            let now = trace["transitions"][position]["clock"]["unix_timestamp"]
                .as_i64()
                .unwrap();
            let state = state(&accounts(position, phase), now);
            let projected =
                sdk::compile_state(&DelegationAdapter, &state, &context(position, phase)).unwrap();
            let grant = RecurringDelegation::from_bytes(&state.delegation.1.data).unwrap();
            assert_eq!(
                projected[1].usage,
                UsageSemantics::Recurring {
                    period_seconds: 30,
                    anchor_unix_seconds: grant.current_period_start_ts,
                    observed_period_start: 1_800_000_000 + start,
                    remaining: Some(remaining),
                },
                "{position}:{phase}"
            );
            assert_eq!(
                projected[1].constraints,
                ConstraintExpr::Constraint(Constraint::AmountAtMost {
                    asset: arm::Resource {
                        namespace: "solana:mint".into(),
                        id: state.mint.0.to_string()
                    },
                    amount: 100,
                })
            );
            assert_eq!(projected[1].availability_at(now).unwrap(), availability);
        }
    }

    #[test]
    fn recurring_revoke_executes_and_matches_declared_removal() {
        let mut accounts = accounts(2, "after");
        let vm = vm(&mut accounts);
        let state = state(&accounts, vm.sysvars.clock.unix_timestamp);
        let context = context(2, "after");
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let action = sdk::actions(&DelegationAdapter, &before[1], &state, &context)
            .unwrap()
            .remove(0);
        assert_eq!(
            action.instructions,
            vec![decode_instruction(
                &trace()["transitions"][12]["instruction"]
            )]
        );
        assert_eq!(
            sdk::diff_transaction(&DelegationAdapter, &action.instructions, &state, &context)
                .unwrap(),
            vec![AuthorizationChange::Removed {
                authorization: Box::new(before[1].clone())
            }]
        );
        let result = vm.process_instruction(&action.instructions[0], &accounts);
        assert_eq!(result.raw_result, Ok(()));
        assert_eq!(
            sdk::verify_transaction_diff(
                &DelegationAdapter,
                &action.instructions,
                &state,
                &context,
                &self::state(&result.resulting_accounts, vm.sysvars.clock.unix_timestamp),
                &context
            ),
            sdk::diff_transaction(&DelegationAdapter, &action.instructions, &state, &context)
        );
        assert_eq!(
            sdk::compile_state(
                &DelegationAdapter,
                &self::state(&result.resulting_accounts, vm.sysvars.clock.unix_timestamp),
                &context
            )
            .unwrap(),
            vec![before[0].clone()]
        );
        let mut unsigned = action.instructions[0].clone();
        unsigned.accounts[0].is_signer = false;
        let rejected = vm.process_instruction(&unsigned, &accounts);
        assert!(rejected.raw_result.is_err());
        assert_eq!(rejected.resulting_accounts, accounts);
    }

    #[test]
    fn native_future_start_and_unbounded_recurrence() {
        let mut accounts = accounts(0, "after");
        let mut vm = vm(&mut accounts);
        let initial = state(&accounts, 1_800_000_000);
        let create = CreateRecurringDelegation {
            delegator: initial.source.authorities[0].0,
            subscription_authority: initial.authority.0,
            delegation_account: initial.delegation.0,
            delegatee: initial.source.authorities[1].0,
            system_program: Pubkey::default(),
            payer: None,
        }
        .instruction(CreateRecurringDelegationInstructionArgs {
            recurring_delegation: CreateRecurringDelegationData {
                nonce: 0,
                amount_per_period: 100,
                period_length_s: 30,
                start_ts: 1_800_000_030,
                expiry_ts: 0,
                expected_subscription_authority_init_id: 100,
            },
        });
        let created = vm.process_instruction(&create, &accounts);
        assert_eq!(created.raw_result, Ok(()));
        let trace = trace();
        let transfer = decode_instruction(&trace["transitions"][2]["instruction"]);
        let mut context = super::context();
        context.evidence.references =
            vec!["test:native_future_start_and_unbounded_recurrence".into()];
        let projected = sdk::compile_state(
            &DelegationAdapter,
            &state(&created.resulting_accounts, 1_800_000_000),
            &context,
        )
        .unwrap();
        assert_eq!(
            projected[1].availability_at(1_800_000_000).unwrap(),
            Availability::Inactive
        );
        let early = vm.process_instruction(&transfer, &created.resulting_accounts);
        assert!(early.raw_result.is_err());
        assert_eq!(early.resulting_accounts, created.resulting_accounts);
        vm.sysvars.clock.unix_timestamp = 1_800_000_090;
        let current = state(&created.resulting_accounts, vm.sysvars.clock.unix_timestamp);
        let projected = sdk::compile_state(&DelegationAdapter, &current, &context).unwrap();
        assert_eq!(
            projected[1].usage,
            UsageSemantics::Recurring {
                period_seconds: 30,
                anchor_unix_seconds: 1_800_000_030,
                observed_period_start: 1_800_000_090,
                remaining: Some(100),
            }
        );
        let pulled = vm.process_instruction(&transfer, &created.resulting_accounts);
        assert_eq!(pulled.raw_result, Ok(()));
        let grant = RecurringDelegation::from_bytes(
            &pulled
                .resulting_accounts
                .iter()
                .find(|(key, _)| *key == current.delegation.0)
                .unwrap()
                .1
                .data,
        )
        .unwrap();
        assert_eq!(grant.current_period_start_ts, 1_800_000_090);
        assert_eq!(grant.amount_pulled_in_period, 60);
        vm.sysvars.clock.unix_timestamp = i64::MAX;
        assert_eq!(
            sdk::compile_state(
                &DelegationAdapter,
                &state(&created.resulting_accounts, vm.sysvars.clock.unix_timestamp),
                &context,
            ),
            Err(Error::UnsupportedOperation)
        );
    }

    #[test]
    fn malformed_recurring_state_fails_closed() {
        let original = state(&accounts(2, "after"), 1_800_000_000);
        for (offset, bytes) in [
            (179, 0_u64.to_le_bytes()),
            (179, u64::MAX.to_le_bytes()),
            (203, 101_u64.to_le_bytes()),
        ] {
            let mut state = self::state(&accounts(2, "after"), 1_800_000_000);
            state.delegation.1.data[offset..offset + 8].copy_from_slice(&bytes);
            assert!(matches!(
                sdk::compile_state(&DelegationAdapter, &state, &context(2, "after")),
                Err(Error::InvalidState(_))
            ));
        }
        let mut state = original;
        state.delegation.1.data[1] = 2;
        assert_eq!(
            sdk::compile_state(&DelegationAdapter, &state, &context(2, "after")),
            Err(Error::UnsupportedVersion)
        );
        state.delegation.1.data[1] = 1;
        state.delegation.1.data.pop();
        assert!(matches!(
            sdk::compile_state(&DelegationAdapter, &state, &context(2, "after")),
            Err(Error::InvalidState(_))
        ));
    }
}

fn instruction(position: usize) -> Instruction {
    decode_instruction(&trace()["transitions"][position]["instruction"])
}

fn decode_instruction(value: &serde_json::Value) -> Instruction {
    Instruction {
        program_id: value["program"].as_str().unwrap().parse().unwrap(),
        data: bytes(value["data"].as_str().unwrap()),
        accounts: value["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|meta| AccountMeta {
                pubkey: meta["address"].as_str().unwrap().parse().unwrap(),
                is_signer: meta["signer"].as_bool().unwrap(),
                is_writable: meta["writable"].as_bool().unwrap(),
            })
            .collect(),
    }
}

fn state(accounts: &[(Pubkey, Account)]) -> DelegationState {
    let owner = Pubkey::new_from_array([1; 32]);
    let delegate = Pubkey::new_from_array([2; 32]);
    let mint = Pubkey::new_from_array([3; 32]);
    let (authority, _) = SubscriptionAuthority::find_pda(&owner, &mint);
    let (delegation, _) = FixedDelegation::find_pda(&authority, &owner, &delegate, 0);
    let source = instruction(0).accounts[3].pubkey;
    let account = |key| {
        accounts
            .iter()
            .find(|(address, _)| *address == key)
            .unwrap()
            .clone()
    };
    DelegationState {
        delegation: account(delegation),
        authority: account(authority),
        source: AuthorityState {
            address: source,
            account: account(source).1,
            authorities: vec![account(owner), account(delegate)],
        },
        mint: account(mint),
        token_program_version: sdk::spl::PROGRAM_VERSION.into(),
        unix_timestamp: None,
        plan: None,
    }
}

fn vm(accounts: &mut Vec<(Pubkey, Account)>) -> Mollusk {
    let elf = include_bytes!("fixtures/subscriptions-program.so");
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    vm.sysvars.clock.slot = 100;
    vm.sysvars.clock.unix_timestamp = 1_800_000_000;
    accounts.extend([
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (
            SUBSCRIPTIONS_ID,
            program::create_program_account_loader_v2(elf),
        ),
    ]);
    vm
}

#[test]
fn native_state_matches_semantic_golden_and_preserves_lineage() {
    let state = state(&accounts(2));
    let context = context();
    let actual = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/subscriptions-fixed-arm.json")).unwrap();
    assert_eq!(serde_json::to_value(&actual).unwrap(), expected);
    assert_eq!(
        actual,
        sdk::compile_state(&DelegationAdapter, &state, &context).unwrap()
    );
    assert_eq!(
        actual[0].availability_at(1_800_000_100).unwrap(),
        Availability::Conditional
    );
    assert_eq!(
        actual[1].availability_at(1_800_000_100).unwrap(),
        Availability::Unknown
    );
    assert_eq!(
        actual[1].availability_at(1_800_000_101).unwrap(),
        Availability::Inactive
    );
    let requirements = DelegationAdapter.source_requirements(&state);
    assert!(!requirements.clock);
    assert_eq!(
        requirements.accounts,
        vec![
            state.delegation.0,
            state.authority.0,
            state.source.address,
            state.mint.0,
            state.source.authorities[0].0,
            state.source.authorities[1].0
        ]
    );
}

#[test]
fn adapter_revoke_executes_and_matches_declared_removal() {
    let mut accounts = accounts(2);
    let vm = vm(&mut accounts);
    let state = state(&accounts);
    let context = context();
    let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert!(
        sdk::actions(&DelegationAdapter, &before[0], &state, &context)
            .unwrap()
            .is_empty()
    );
    let action = sdk::actions(&DelegationAdapter, &before[1], &state, &context)
        .unwrap()
        .remove(0);
    assert_eq!(action.instructions, vec![instruction(4)]);
    let declared =
        sdk::diff_transaction(&DelegationAdapter, &action.instructions, &state, &context).unwrap();
    assert_eq!(
        declared,
        vec![AuthorizationChange::Removed {
            authorization: Box::new(before[1].clone())
        }]
    );
    let result = vm.process_instruction(&action.instructions[0], &accounts);
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        sdk::verify_transaction_diff(
            &DelegationAdapter,
            &action.instructions,
            &state,
            &context,
            &self::state(&result.resulting_accounts),
            &context
        ),
        Ok(declared)
    );
    let after = sdk::compile_state(
        &DelegationAdapter,
        &self::state(&result.resulting_accounts),
        &context,
    )
    .unwrap();
    assert_eq!(after, vec![before[0].clone()]);
    assert_eq!(
        after,
        sdk::compile_state(
            &DelegationAdapter,
            &self::state(&self::accounts(4)),
            &context
        )
        .unwrap()
    );
    let mut stale = before[1].clone();
    stale.id.push_str(":stale");
    assert_eq!(
        sdk::actions(&DelegationAdapter, &stale, &state, &context),
        Err(Error::InvalidProjection)
    );
    assert_eq!(
        sdk::diff_transaction(&DelegationAdapter, &[instruction(2)], &state, &context),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn native_expiry_is_inclusive_and_failure_does_not_change_state() {
    let mut accounts = accounts(2);
    let mut vm = vm(&mut accounts);
    for (now, succeeds) in [(1_800_000_100, true), (1_800_000_101, false)] {
        vm.sysvars.clock.unix_timestamp = now;
        let result = vm.process_instruction(&instruction(2), &accounts);
        assert_eq!(result.raw_result.is_ok(), succeeds);
        if !succeeds {
            assert_eq!(result.resulting_accounts, accounts);
        }
    }
}

#[test]
fn sponsored_grant_revoke_returns_rent_to_recorded_payer() {
    let mut accounts = accounts(0);
    let vm = vm(&mut accounts);
    let sponsor = Pubkey::new_from_array([6; 32]);
    accounts.push((
        sponsor,
        Account {
            lamports: 1_000_000_000,
            ..Account::default()
        },
    ));
    let initial = state(&accounts);
    let create = CreateFixedDelegation {
        delegator: initial.source.authorities[0].0,
        subscription_authority: initial.authority.0,
        delegation_account: initial.delegation.0,
        delegatee: initial.source.authorities[1].0,
        system_program: Pubkey::default(),
        payer: Some(sponsor),
    }
    .instruction(CreateFixedDelegationInstructionArgs {
        fixed_delegation: CreateFixedDelegationData {
            nonce: 0,
            amount: 100,
            expiry_ts: 1_800_000_100,
            expected_subscription_authority_init_id: 100,
        },
    });
    let created = vm.process_instruction(&create, &accounts);
    assert_eq!(created.raw_result, Ok(()));
    let state = state(&created.resulting_accounts);
    let before = sdk::compile_state(&DelegationAdapter, &state, &context()).unwrap();
    let action = sdk::actions(&DelegationAdapter, &before[1], &state, &context())
        .unwrap()
        .remove(0);
    assert_eq!(
        action.instructions[0].accounts.last(),
        Some(&AccountMeta::new(sponsor, false))
    );
    let result = vm.process_instruction(&action.instructions[0], &created.resulting_accounts);
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        result
            .resulting_accounts
            .iter()
            .find(|(key, _)| *key == sponsor)
            .unwrap()
            .1
            .lamports,
        1_000_000_000
    );
    assert_eq!(
        sdk::compile_state(
            &DelegationAdapter,
            &self::state(&result.resulting_accounts),
            &context()
        )
        .unwrap(),
        vec![before[0].clone()]
    );
}

#[test]
fn native_token_revoke_suspends_grant_without_deleting_it() {
    let mut accounts = accounts(2);
    let vm = vm(&mut accounts);
    let state = state(&accounts);
    let before = sdk::compile_state(&DelegationAdapter, &state, &context()).unwrap();
    let revoke = spl_token_interface::instruction::revoke(
        &token::ID,
        &state.source.address,
        &state.source.authorities[0].0,
        &[],
    )
    .unwrap();
    let result = vm.process_instruction(&revoke, &accounts);
    assert_eq!(result.raw_result, Ok(()));
    let after = sdk::compile_state(
        &DelegationAdapter,
        &self::state(&result.resulting_accounts),
        &context(),
    )
    .unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, before[1].id);
    assert_eq!(after[0].lifecycle, Lifecycle::Suspended);
    assert!(matches!(
        after[0].authority_kind,
        AuthorityKind::Derived { .. }
    ));
}

#[test]
fn native_authority_incarnation_controls_existing_grant() {
    for slot in [100, 101] {
        let mut accounts = accounts(2);
        let mut vm = vm(&mut accounts);
        let state = state(&accounts);
        let before = sdk::compile_state(&DelegationAdapter, &state, &context()).unwrap();
        let close = CloseSubscriptionAuthority {
            user: state.source.authorities[0].0,
            subscription_authority: state.authority.0,
            receiver: None,
        }
        .instruction();
        let closed = vm.process_instruction(&close, &accounts);
        assert_eq!(closed.raw_result, Ok(()));
        let inactive = sdk::compile_state(
            &DelegationAdapter,
            &self::state(&closed.resulting_accounts),
            &context(),
        )
        .unwrap();
        assert_eq!(inactive[0], before[0]);
        assert_eq!(inactive[1].lifecycle, Lifecycle::Suspended);
        vm.sysvars.clock.slot = slot;
        let reopened = vm.process_instruction(&instruction(0), &closed.resulting_accounts);
        assert_eq!(reopened.raw_result, Ok(()));
        let after = sdk::compile_state(
            &DelegationAdapter,
            &self::state(&reopened.resulting_accounts),
            &context(),
        )
        .unwrap();
        assert_eq!(after[1].id, before[1].id);
        assert_eq!(
            after[1].lifecycle,
            if slot == 100 {
                before[1].lifecycle.clone()
            } else {
                Lifecycle::Suspended
            }
        );
        let pulled = vm.process_instruction(&instruction(2), &reopened.resulting_accounts);
        assert_eq!(pulled.raw_result.is_ok(), slot == 100);
        if slot == 101 {
            assert_eq!(pulled.resulting_accounts, reopened.resulting_accounts);
        }
    }
}

#[test]
fn native_zero_and_maximum_expiry_have_no_exclusive_boundary() {
    for expiry in [0, i64::MAX] {
        let mut accounts = accounts(0);
        let mut vm = vm(&mut accounts);
        let state = state(&accounts);
        let create = CreateFixedDelegation {
            delegator: state.source.authorities[0].0,
            subscription_authority: state.authority.0,
            delegation_account: state.delegation.0,
            delegatee: state.source.authorities[1].0,
            system_program: Pubkey::default(),
            payer: None,
        }
        .instruction(CreateFixedDelegationInstructionArgs {
            fixed_delegation: CreateFixedDelegationData {
                nonce: 0,
                amount: 100,
                expiry_ts: expiry,
                expected_subscription_authority_init_id: 100,
            },
        });
        let created = vm.process_instruction(&create, &accounts);
        assert_eq!(created.raw_result, Ok(()));
        let projected = sdk::compile_state(
            &DelegationAdapter,
            &self::state(&created.resulting_accounts),
            &context(),
        )
        .unwrap();
        assert_eq!(
            projected[1].lifecycle,
            Lifecycle::Active {
                valid_from: None,
                valid_until: None
            }
        );
        vm.sysvars.clock.unix_timestamp = i64::MAX;
        let pulled = vm.process_instruction(&instruction(2), &created.resulting_accounts);
        assert_eq!(pulled.raw_result, Ok(()));
    }
}

#[test]
fn unsigned_revoke_fails_without_changing_native_state() {
    let mut accounts = accounts(2);
    let vm = vm(&mut accounts);
    let mut revoke = instruction(4);
    revoke.accounts[0].is_signer = false;
    let result = vm.process_instruction(&revoke, &accounts);
    assert!(result.raw_result.is_err());
    assert_eq!(result.resulting_accounts, accounts);
}

#[test]
fn missing_or_ambiguous_controller_evidence_fails_closed() {
    let mut state = state(&accounts(2));
    state.source.authorities.pop();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    state.source.authorities = self::state(&accounts(2)).source.authorities;
    state
        .source
        .authorities
        .push(state.source.authorities[1].clone());
    assert!(matches!(
        sdk::compile_state(&DelegationAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    state.source.authorities.pop();
    state.source.authorities[1].1.owner = SUBSCRIPTIONS_ID;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn only_verified_deployment_and_version_pairs_compile() {
    let state = state(&accounts(2));
    for (deployment, version) in [
        (DEPLOYMENT, PROGRAM_VERSION),
        (DEVNET_DEPLOYMENT, DEVNET_PROGRAM_VERSION),
    ] {
        let mut known = context();
        known.native.deployment = deployment.into();
        known.native.program_version = version.into();
        let compiled = sdk::compile_state(&DelegationAdapter, &state, &known).unwrap();
        assert!(compiled
            .iter()
            .all(|grant| grant.native_context == known.native));
        for (wrong_deployment, wrong_version) in [
            (DEPLOYMENT, DEVNET_PROGRAM_VERSION),
            (DEVNET_DEPLOYMENT, PROGRAM_VERSION),
            ("unknown", version),
            (deployment, "sha256:unknown"),
        ] {
            let mut unknown = known.clone();
            unknown.native.deployment = wrong_deployment.into();
            unknown.native.program_version = wrong_version.into();
            assert!(!DelegationAdapter.supports(&unknown.native));
            assert_eq!(
                sdk::compile_state(&DelegationAdapter, &state, &unknown),
                Err(Error::UnsupportedVersion)
            );
            assert_eq!(
                sdk::actions(&DelegationAdapter, &compiled[1], &state, &unknown),
                Err(Error::UnsupportedVersion)
            );
        }
    }
}

#[test]
fn unknown_versions_and_malformed_native_state_fail_closed() {
    let state = state(&accounts(2));
    let mut context = context();
    context.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedVersion)
    );
    context = self::context();
    context.evidence.references.clear();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::InsufficientEvidence)
    );
    let mut state = self::state(&accounts(2));
    state.token_program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &self::context()),
        Err(Error::UnsupportedVersion)
    );
    state.token_program_version = sdk::spl::PROGRAM_VERSION.into();
    state.delegation.1.data[1] = 2;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &self::context()),
        Err(Error::UnsupportedVersion)
    );
    for data in [vec![], vec![2], vec![2, 1], vec![0; 187], vec![2; 188]] {
        state.delegation.1.data = data;
        assert!(matches!(
            sdk::compile_state(&DelegationAdapter, &state, &self::context()),
            Err(Error::InvalidState(_))
                | Err(Error::UnsupportedVersion)
                | Err(Error::UnsupportedOperation)
        ));
    }
    state = self::state(&accounts(2));
    state.delegation.1.owner = token::ID;
    assert!(matches!(
        sdk::compile_state(&DelegationAdapter, &state, &self::context()),
        Err(Error::InvalidState(_))
    ));
    state = self::state(&accounts(2));
    state.authority.1.data.truncate(105);
    assert!(matches!(
        sdk::compile_state(&DelegationAdapter, &state, &self::context()),
        Err(Error::InvalidState(_))
    ));
    state = self::state(&accounts(2));
    state.mint.0 = Pubkey::new_from_array([7; 32]);
    assert!(matches!(
        sdk::compile_state(&DelegationAdapter, &state, &self::context()),
        Err(Error::InvalidState(_))
    ));
}
