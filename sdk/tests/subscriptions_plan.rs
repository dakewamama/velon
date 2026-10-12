use arm::{
    Authorization, AuthorizationChange, Availability, Constraint, ConstraintExpr, EvidenceBundle,
    Lifecycle, NativeContext, Principal, Resource, UsageSemantics,
};
use catalyst_sdk::{
    self as sdk, spl::AuthorityState, subscriptions::*, ActionKind, Adapter, Context, Error,
};
use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface::state::Account as TokenAccount;
use subscriptions::{
    accounts::{EventAuthority, Plan, SubscriptionAuthority, SubscriptionDelegation},
    instructions::{
        CancelSubscription, CancelSubscriptionNow, CancelSubscriptionNowInstructionArgs,
        ResumeSubscription, ResumeSubscriptionInstructionArgs, RevokeDelegation, UpdatePlan,
        UpdatePlanInstructionArgs,
    },
    types::{CancelSubscriptionNowData, ResumeData, UpdatePlanData},
    SUBSCRIPTIONS_ID,
};

const START: i64 = 1_800_000_000;

fn trace() -> Value {
    serde_json::from_str(include_str!("fixtures/subscriptions-lifecycle.json")).unwrap()
}

fn transition<'a>(trace: &'a Value, name: &str) -> &'a Value {
    let mut matches = trace["transitions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["name"] == name);
    let step = matches.next().unwrap_or_else(|| panic!("missing {name}"));
    assert!(matches.next().is_none(), "duplicate {name}");
    step
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn accounts(step: &Value, phase: &str) -> Vec<(Pubkey, Account)> {
    step[phase]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            (
                value["address"].as_str().unwrap().parse().unwrap(),
                Account {
                    owner: value["owner"].as_str().unwrap().parse().unwrap(),
                    lamports: value["lamports"].as_u64().unwrap(),
                    executable: value["executable"].as_bool().unwrap(),
                    data: bytes(value["data"].as_str().unwrap()),
                    ..Account::default()
                },
            )
        })
        .collect()
}

fn state(accounts: &[(Pubkey, Account)], now: i64, plan_id: u64) -> DelegationState {
    let subscriber = Pubkey::new_from_array([1; 32]);
    let merchant = Pubkey::new_from_array([2; 32]);
    let mint = Pubkey::new_from_array([3; 32]);
    let (authority, _) = SubscriptionAuthority::find_pda(&subscriber, &mint);
    let (plan, _) = Plan::find_pda(&merchant, plan_id);
    let (subscription, _) = SubscriptionDelegation::find_pda(&plan, &subscriber);
    let source = Pubkey::find_program_address(
        &[subscriber.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )
    .0;
    let account = |key| {
        accounts
            .iter()
            .find(|(address, _)| *address == key)
            .unwrap()
            .clone()
    };
    DelegationState {
        delegation: account(subscription),
        authority: account(authority),
        plan: Some(account(plan)),
        source: AuthorityState {
            address: source,
            account: account(source).1,
            authorities: vec![
                account(subscriber),
                account(merchant),
                account(Pubkey::new_from_array([6; 32])),
            ],
        },
        mint: account(mint),
        token_program_version: sdk::spl::PROGRAM_VERSION.into(),
        unix_timestamp: Some(now),
    }
}

fn context(step: &Value, phase: &str) -> Context {
    let name = step["name"].as_str().unwrap();
    Context {
        program_id: SUBSCRIPTIONS_ID,
        native: NativeContext {
            protocol: "subscriptions".into(),
            deployment: DEPLOYMENT.into(),
            program_version: PROGRAM_VERSION.into(),
            adapter_version: "0.3".into(),
        },
        evidence: EvidenceBundle {
            references: vec![
                format!("fixture:subscriptions-lifecycle.json:{name}:{phase}"),
                format!("fixture:subscriptions-lifecycle.json:{name}:clock"),
            ],
            observed_at: format!("fixture:slot:{}", step["clock"]["slot"].as_u64().unwrap()),
        },
    }
}

fn vm(step: &Value, accounts: &mut Vec<(Pubkey, Account)>) -> Mollusk {
    vm_with_elf(
        step,
        accounts,
        include_bytes!("fixtures/subscriptions-program.so"),
    )
}

fn vm_with_elf(step: &Value, accounts: &mut Vec<(Pubkey, Account)>, elf: &[u8]) -> Mollusk {
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    vm.sysvars.clock.slot = step["clock"]["slot"].as_u64().unwrap();
    vm.sysvars.clock.epoch = step["clock"]["epoch"].as_u64().unwrap();
    vm.sysvars.clock.epoch_start_timestamp =
        step["clock"]["epoch_start_timestamp"].as_i64().unwrap();
    vm.sysvars.clock.leader_schedule_epoch =
        step["clock"]["leader_schedule_epoch"].as_u64().unwrap();
    vm.sysvars.clock.unix_timestamp = step["clock"]["unix_timestamp"].as_i64().unwrap();
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

fn instruction(step: &Value) -> Instruction {
    let value = &step["instruction"];
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

fn official_action(kind: ActionKind, state: &DelegationState) -> Instruction {
    let grant = SubscriptionDelegation::from_bytes(&state.delegation.1.data).unwrap();
    let plan = Plan::from_bytes(&state.plan.as_ref().unwrap().1.data).unwrap();
    let event_authority = EventAuthority::find_pda().0;
    match kind {
        ActionKind::Cancel => CancelSubscription {
            subscriber: grant.header.delegator,
            plan_pda: grant.header.delegatee,
            subscription_pda: state.delegation.0,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(),
        ActionKind::Resume => ResumeSubscription {
            subscriber: grant.header.delegator,
            plan_pda: grant.header.delegatee,
            subscription_pda: state.delegation.0,
            subscription_authority: state.authority.0,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(ResumeSubscriptionInstructionArgs {
            resume_data: ResumeData {
                expected_expires_at_ts: grant.expires_at_ts,
            },
        }),
        ActionKind::CancelNow => CancelSubscriptionNow {
            subscriber: grant.header.delegator,
            merchant: plan.owner,
            plan_pda: grant.header.delegatee,
            subscription_pda: state.delegation.0,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(CancelSubscriptionNowInstructionArgs {
            cancel_subscription_now_data: CancelSubscriptionNowData {
                expected_current_period_start_ts: grant.current_period_start_ts,
            },
        }),
        ActionKind::Revoke => RevokeDelegation {
            authority: grant.header.delegator,
            delegation_account: state.delegation.0,
        }
        .instruction_with_remaining_accounts(&[AccountMeta::new_readonly(
            grant.header.delegatee,
            false,
        )]),
        _ => panic!("unexpected subscription action"),
    }
}

#[test]
fn independent_golden_is_complete_deterministic_and_requires_current_sources() {
    let trace = trace();
    assert_eq!(trace["source"], "56de552a26a0f0af437c0ce5191b3309741cc596");
    assert_eq!(trace["transitions"].as_array().unwrap().len(), 41);
    assert_eq!(
        trace["program_sha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/subscriptions-program.so"))
        )
    );
    assert_eq!(
        PROGRAM_VERSION,
        format!("sha256:{}", trace["program_sha256"].as_str().unwrap())
    );
    assert_eq!(ADAPTER_VERSION, "0.3");
    let step = transition(&trace, "owner_pull_60");
    let state = state(&accounts(step, "after"), START, 0);
    let context = context(step, "after");
    let expected: Vec<Authorization> =
        serde_json::from_str(include_str!("fixtures/subscriptions-plan-arm.json")).unwrap();
    let actual = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(
        actual,
        sdk::compile_state(&DelegationAdapter, &state, &context).unwrap()
    );
    assert_eq!(
        actual[1].availability_at(START).unwrap(),
        Availability::Unknown
    );
    let requirements = DelegationAdapter.source_requirements(&state);
    assert!(requirements.clock);
    let mut required = requirements.accounts.clone();
    required.sort();
    let mut expected = vec![
        state.delegation.0,
        state.authority.0,
        state.source.address,
        state.mint.0,
        state.plan.as_ref().unwrap().0,
        Pubkey::new_from_array([1; 32]),
        Pubkey::new_from_array([2; 32]),
        Pubkey::new_from_array([6; 32]),
    ];
    expected.sort();
    assert_eq!(required, expected);
}

#[test]
fn owner_and_pullers_share_one_principal_one_budget_and_unique_destinations() {
    let trace = trace();
    for (name, remaining) in [
        ("owner_pull_60", 40),
        ("puller_exceeds_shared_remaining", 40),
        ("puller_uses_shared_budget", 20),
        ("unauthorized_caller", 20),
        ("unauthorized_recipient", 20),
    ] {
        let step = transition(&trace, name);
        let state = state(&accounts(step, "after"), START, 0);
        let projected =
            sdk::compile_state(&DelegationAdapter, &state, &context(step, "after")).unwrap();
        assert_eq!(projected.len(), 3, "{name}");
        assert_eq!(
            projected[1].principal,
            Principal::AnyOf(vec![
                Principal::Identity(Pubkey::new_from_array([2; 32]).to_string()),
                Principal::Identity(Pubkey::new_from_array([6; 32]).to_string()),
            ])
        );
        assert_eq!(
            projected[1].usage,
            UsageSemantics::Recurring {
                period_seconds: 3_600,
                anchor_unix_seconds: START,
                observed_period_start: START,
                remaining: Some(remaining),
            },
            "{name}"
        );
    }
    let step = transition(&trace, "owner_pull_60");
    let mut state = state(&accounts(step, "after"), START, 0);
    let context = context(step, "after");
    let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    let plan = &mut state.plan.as_mut().unwrap().1.data;
    plan[267..299].copy_from_slice(Pubkey::new_from_array([6; 32]).as_ref());
    plan[299..331].copy_from_slice(Pubkey::new_from_array([2; 32]).as_ref());
    plan[139..171].copy_from_slice(Pubkey::new_from_array([5; 32]).as_ref());
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context).unwrap(),
        before
    );
    state.plan.as_mut().unwrap().1.data[171..203]
        .copy_from_slice(Pubkey::new_from_array([7; 32]).as_ref());
    let after = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert_eq!(
        after[1].constraints,
        ConstraintExpr::All(vec![
            ConstraintExpr::Constraint(Constraint::AmountAtMost {
                asset: Resource {
                    namespace: "solana:mint".into(),
                    id: state.mint.0.to_string()
                },
                amount: 100,
            }),
            ConstraintExpr::Constraint(Constraint::Recipient {
                principal: Principal::AnyOf(vec![
                    Principal::Identity(Pubkey::new_from_array([5; 32]).to_string()),
                    Principal::Identity(Pubkey::new_from_array([7; 32]).to_string()),
                ]),
            }),
        ])
    );
    assert_eq!(after[0], before[0]);
    assert_eq!(after[2], before[2]);
    assert_eq!(after[1].usage, before[1].usage);
}

#[test]
fn open_recipient_plan_and_sunset_puller_removal_preserve_existing_collection() {
    let trace = trace();
    let step = transition(&trace, "other_subscription_survives_open_recipient");
    let now = step["clock"]["unix_timestamp"].as_i64().unwrap();
    let state = state(&accounts(step, "after"), now, 1);
    let projected =
        sdk::compile_state(&DelegationAdapter, &state, &context(step, "after")).unwrap();
    assert_eq!(
        projected[1].principal,
        Principal::Identity(Pubkey::new_from_array([2; 32]).to_string())
    );
    assert_eq!(
        projected[1].constraints,
        ConstraintExpr::Constraint(Constraint::AmountAtMost {
            asset: Resource {
                namespace: "solana:mint".into(),
                id: state.mint.0.to_string()
            },
            amount: 100,
        })
    );
    for (name, remaining, puller_present) in [
        ("sunset", 100, true),
        ("sunset_existing_collectible", 90, true),
        ("sunset_puller_removal", 90, false),
        ("removed_puller_rejected", 90, false),
    ] {
        let step = transition(&trace, name);
        let now = step["clock"]["unix_timestamp"].as_i64().unwrap();
        let state = self::state(&accounts(step, "after"), now, 0);
        let projected =
            sdk::compile_state(&DelegationAdapter, &state, &context(step, "after")).unwrap();
        let owner = Principal::Identity(Pubkey::new_from_array([2; 32]).to_string());
        assert_eq!(
            projected[1].principal,
            if puller_present {
                Principal::AnyOf(vec![
                    owner,
                    Principal::Identity(Pubkey::new_from_array([6; 32]).to_string()),
                ])
            } else {
                owner
            },
            "{name}"
        );
        assert_eq!(
            projected[1].lifecycle,
            Lifecycle::Active {
                valid_from: Some(START + 3_601),
                valid_until: Some(START + 10_801),
            }
        );
        assert_eq!(
            projected[1].usage,
            UsageSemantics::Recurring {
                period_seconds: 3_600,
                anchor_unix_seconds: START + 3_601,
                observed_period_start: START + 3_601,
                remaining: Some(remaining),
            }
        );
        assert_eq!(
            projected[1].availability_at(now).unwrap(),
            Availability::Unknown
        );
        let required = DelegationAdapter.source_requirements(&state);
        assert_eq!(
            required.accounts.contains(&Pubkey::new_from_array([6; 32])),
            puller_present
        );
    }
}

#[test]
fn cancellation_resume_and_inclusive_plan_end_have_native_boundaries() {
    let trace = trace();
    for (name, plan_id, period, remaining, until, availability) in [
        ("cancel_pending", 0, 0, 20, 3_600, Availability::Unknown),
        (
            "pending_cancel_still_collectible",
            0,
            0,
            10,
            3_600,
            Availability::Unknown,
        ),
        (
            "resume_preserves_consumption",
            0,
            0,
            10,
            0,
            Availability::Unknown,
        ),
        (
            "resume_does_not_refresh_budget",
            0,
            0,
            10,
            0,
            Availability::Unknown,
        ),
        ("cancel_again", 0, 0, 10, 3_600, Availability::Unknown),
        (
            "revoke_before_cancel_cutoff_rejected",
            0,
            0,
            10,
            3_600,
            Availability::Unknown,
        ),
        (
            "exclusive_cancel_cutoff",
            0,
            0,
            10,
            3_600,
            Availability::Inactive,
        ),
        ("cancel_now", 0, 3_601, 90, 3_602, Availability::Inactive),
        (
            "cancel_now_blocks_collection",
            0,
            3_601,
            90,
            3_602,
            Availability::Inactive,
        ),
        (
            "other_plan_final_period_pull_60",
            1,
            7_200,
            40,
            10_801,
            Availability::Unknown,
        ),
        (
            "cancel_capped_at_inclusive_plan_end",
            1,
            7_200,
            40,
            10_801,
            Availability::Unknown,
        ),
        (
            "inclusive_plan_end_pull_remaining",
            1,
            7_200,
            0,
            10_801,
            Availability::Unknown,
        ),
        (
            "past_plan_end_rejected",
            1,
            7_200,
            0,
            10_801,
            Availability::Inactive,
        ),
    ] {
        let step = transition(&trace, name);
        let now = step["clock"]["unix_timestamp"].as_i64().unwrap();
        let state = state(&accounts(step, "after"), now, plan_id);
        let projected =
            sdk::compile_state(&DelegationAdapter, &state, &context(step, "after")).unwrap();
        assert_eq!(
            projected[1].lifecycle,
            Lifecycle::Active {
                valid_from: Some(START + period),
                valid_until: if until == 0 {
                    None
                } else {
                    Some(START + until)
                },
            },
            "{name}"
        );
        assert_eq!(
            projected[1].usage,
            UsageSemantics::Recurring {
                period_seconds: 3_600,
                anchor_unix_seconds: START + period,
                observed_period_start: START + period,
                remaining: Some(remaining),
            },
            "{name}"
        );
        assert_eq!(
            projected[1].availability_at(now).unwrap(),
            availability,
            "{name}"
        );
    }
}

#[test]
fn native_actions_predict_exact_changes_and_preserve_technical_and_plan_records() {
    for (deployment, version, elf) in [
        (
            DEPLOYMENT,
            PROGRAM_VERSION,
            include_bytes!("fixtures/subscriptions-program.so").as_slice(),
        ),
        (
            DEVNET_DEPLOYMENT,
            DEVNET_PROGRAM_VERSION,
            include_bytes!("fixtures/subscriptions-devnet-program.so").as_slice(),
        ),
    ] {
        native_actions_round_trip(deployment, version, elf);
    }
}

#[test]
fn delayed_native_cancellation_rejects_the_stale_declared_cutoff() {
    let trace = trace();
    let step = transition(&trace, "cancel_pending");
    for (deployment, version, elf) in [
        (
            DEPLOYMENT,
            PROGRAM_VERSION,
            include_bytes!("fixtures/subscriptions-program.so").as_slice(),
        ),
        (
            DEVNET_DEPLOYMENT,
            DEVNET_PROGRAM_VERSION,
            include_bytes!("fixtures/subscriptions-devnet-program.so").as_slice(),
        ),
    ] {
        let mut accounts = accounts(step, "before");
        let mut vm = vm_with_elf(step, &mut accounts, elf);
        let before = state(&accounts, vm.sysvars.clock.unix_timestamp, 0);
        let mut context = context(step, "before");
        context.native.deployment = deployment.into();
        context.native.program_version = version.into();
        let instructions = vec![official_action(ActionKind::Cancel, &before)];
        let declared =
            sdk::diff_transaction(&DelegationAdapter, &instructions, &before, &context).unwrap();
        assert!(
            matches!(&declared[0], AuthorizationChange::Changed { after, .. }
            if after.lifecycle == Lifecycle::Active { valid_from: Some(START), valid_until: Some(START + 3_600) })
        );
        vm.sysvars.clock.unix_timestamp += 3_600;
        vm.sysvars.clock.slot += 1;
        let result = vm.process_transaction_instructions(&instructions, &accounts, None);
        assert_eq!(result.raw_result, Ok(()));
        let after = state(
            &result.resulting_accounts,
            vm.sysvars.clock.unix_timestamp,
            0,
        );
        assert_eq!(
            SubscriptionDelegation::from_bytes(&after.delegation.1.data)
                .unwrap()
                .expires_at_ts,
            START + 7_200
        );
        let mut observed = context.clone();
        observed.evidence.observed_at = format!("fixture:slot:{}", vm.sysvars.clock.slot);
        observed.evidence.references = vec![format!(
            "test:delayed-cancel:timestamp:{}",
            vm.sysvars.clock.unix_timestamp
        )];
        assert_eq!(
            sdk::verify_transaction_diff(
                &DelegationAdapter,
                &instructions,
                &before,
                &context,
                &after,
                &observed
            ),
            Err(Error::DiffMismatch)
        );
        let fresh = state(&accounts, vm.sysvars.clock.unix_timestamp, 0);
        let fresh_declared =
            sdk::diff_transaction(&DelegationAdapter, &instructions, &fresh, &observed).unwrap();
        assert_eq!(
            sdk::verify_transaction_diff(
                &DelegationAdapter,
                &instructions,
                &fresh,
                &observed,
                &after,
                &observed
            ),
            Ok(fresh_declared)
        );
    }
}

fn native_actions_round_trip(deployment: &str, version: &str, elf: &[u8]) {
    let trace = trace();
    for (name, phase, kind, expected_kinds) in [
        (
            "cancel_pending",
            "before",
            ActionKind::Cancel,
            vec![ActionKind::Cancel, ActionKind::CancelNow],
        ),
        (
            "resume_preserves_consumption",
            "before",
            ActionKind::Resume,
            vec![ActionKind::Resume, ActionKind::CancelNow],
        ),
        (
            "cancel_pending",
            "after",
            ActionKind::CancelNow,
            vec![ActionKind::Resume, ActionKind::CancelNow],
        ),
        (
            "cancel_now",
            "before",
            ActionKind::CancelNow,
            vec![ActionKind::Cancel, ActionKind::CancelNow],
        ),
        (
            "revoke_cancelled",
            "before",
            ActionKind::Revoke,
            vec![ActionKind::Revoke],
        ),
        (
            "revoke_immediate",
            "before",
            ActionKind::Revoke,
            vec![ActionKind::Revoke],
        ),
        (
            "cancel_capped_at_inclusive_plan_end",
            "before",
            ActionKind::Cancel,
            vec![ActionKind::Cancel, ActionKind::CancelNow],
        ),
    ] {
        let step = transition(&trace, name);
        let mut accounts = accounts(step, phase);
        let vm = vm_with_elf(step, &mut accounts, elf);
        let plan_id = u64::from(name == "cancel_capped_at_inclusive_plan_end");
        let state = state(&accounts, vm.sysvars.clock.unix_timestamp, plan_id);
        let mut context = context(step, phase);
        context.native.deployment = deployment.into();
        context.native.program_version = version.into();
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        for authorization in [&before[0], &before[2]] {
            assert!(
                sdk::actions(&DelegationAdapter, authorization, &state, &context)
                    .unwrap()
                    .is_empty()
            );
        }
        let actions = sdk::actions(&DelegationAdapter, &before[1], &state, &context).unwrap();
        assert_eq!(
            actions.iter().map(|action| action.kind).collect::<Vec<_>>(),
            expected_kinds,
            "{name}:{phase}"
        );
        for action in &actions {
            assert_eq!(
                action.instructions,
                vec![official_action(action.kind, &state)]
            );
        }
        let action = actions
            .into_iter()
            .find(|action| action.kind == kind)
            .unwrap();
        assert_eq!(action.authorization_id, before[1].id);
        if phase == "before" {
            assert_eq!(action.instructions, vec![instruction(step)], "{name}");
        }
        let declared =
            sdk::diff_transaction(&DelegationAdapter, &action.instructions, &state, &context)
                .unwrap();
        let result = vm.process_instruction(&action.instructions[0], &accounts);
        assert_eq!(result.raw_result, Ok(()), "{name}:{phase}");
        for (address, account) in &accounts {
            if *address != state.delegation.0
                && !(kind == ActionKind::Revoke && *address == state.source.authorities[0].0)
            {
                assert_eq!(
                    &result
                        .resulting_accounts
                        .iter()
                        .find(|(key, _)| key == address)
                        .unwrap()
                        .1,
                    account,
                    "{name}:{phase}:unrelated:{address}"
                );
            }
        }
        let after_state = self::state(
            &result.resulting_accounts,
            vm.sysvars.clock.unix_timestamp,
            plan_id,
        );
        let after = sdk::compile_state(&DelegationAdapter, &after_state, &context).unwrap();
        let expected = if kind == ActionKind::Revoke {
            assert_eq!(after, vec![before[0].clone(), before[2].clone()]);
            vec![AuthorizationChange::Removed {
                authorization: Box::new(before[1].clone()),
            }]
        } else {
            assert_eq!(after.len(), 3);
            assert_eq!(after[0], before[0]);
            assert_eq!(after[2], before[2]);
            assert_eq!(after[1].id, before[1].id);
            if kind == ActionKind::Resume {
                let native_before =
                    SubscriptionDelegation::from_bytes(&state.delegation.1.data).unwrap();
                let native_after =
                    SubscriptionDelegation::from_bytes(&after_state.delegation.1.data).unwrap();
                assert_eq!(
                    native_after.current_period_start_ts,
                    native_before.current_period_start_ts
                );
                assert_eq!(
                    native_after.amount_pulled_in_period,
                    native_before.amount_pulled_in_period
                );
            }
            if name == "cancel_capped_at_inclusive_plan_end" {
                assert_eq!(
                    SubscriptionDelegation::from_bytes(&state.delegation.1.data)
                        .unwrap()
                        .expires_at_ts,
                    0
                );
                assert_eq!(
                    SubscriptionDelegation::from_bytes(&after_state.delegation.1.data)
                        .unwrap()
                        .expires_at_ts,
                    START + 10_801
                );
                assert_eq!(before[1], after[1]);
            }
            if before[1] == after[1] {
                vec![]
            } else {
                vec![AuthorizationChange::Changed {
                    before: Box::new(before[1].clone()),
                    after: Box::new(after[1].clone()),
                }]
            }
        };
        assert_eq!(declared, expected, "{name}:{phase}");
        let mut observed = context.clone();
        observed
            .evidence
            .references
            .push(format!("test:simulation:{name}:result"));
        assert_eq!(
            sdk::verify_transaction_diff(
                &DelegationAdapter,
                &action.instructions,
                &state,
                &context,
                &after_state,
                &observed
            ),
            Ok(declared),
            "{name}:{phase}"
        );
        if phase == "before" {
            assert_eq!(
                after,
                sdk::compile_state(
                    &DelegationAdapter,
                    &self::state(
                        &self::accounts(step, "after"),
                        vm.sysvars.clock.unix_timestamp,
                        plan_id
                    ),
                    &context
                )
                .unwrap()
            );
        }
        for index in action.instructions[0]
            .accounts
            .iter()
            .enumerate()
            .filter_map(|(index, meta)| meta.is_signer.then_some(index))
        {
            let mut unsigned = action.instructions[0].clone();
            unsigned.accounts[index].is_signer = false;
            let rejected = vm.process_instruction(&unsigned, &accounts);
            assert_eq!(
                format!("{:?}", rejected.raw_result),
                "Err(Custom(100))",
                "{name}:signer:{index}"
            );
            assert_eq!(rejected.resulting_accounts, accounts);
            assert_eq!(
                sdk::diff_transaction(&DelegationAdapter, &[unsigned], &state, &context),
                Err(Error::UnsupportedOperation)
            );
        }
        let mut batch = action.instructions.clone();
        batch.extend(action.instructions.clone());
        assert_eq!(
            sdk::diff_transaction(&DelegationAdapter, &batch, &state, &context),
            Err(Error::UnsupportedOperation)
        );
        let mut stale = before[1].clone();
        stale.id.push_str(":stale");
        assert_eq!(
            sdk::actions(&DelegationAdapter, &stale, &state, &context),
            Err(Error::InvalidProjection)
        );
    }
}

#[test]
fn pending_resume_requires_current_authority_generation_and_live_plan_end() {
    let trace = trace();
    let step = transition(&trace, "resume_preserves_consumption");
    let mut state = state(&accounts(step, "before"), START + 30, 0);
    let context = context(step, "before");
    state.authority.1.data[98..106].copy_from_slice(&101_i64.to_le_bytes());
    let projected = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert_eq!(projected[1].lifecycle, Lifecycle::Suspended);
    let actions = sdk::actions(&DelegationAdapter, &projected[1], &state, &context).unwrap();
    assert!(!actions
        .iter()
        .any(|action| action.kind == ActionKind::Resume));
    let mut state = self::state(&accounts(step, "before"), START + 30, 0);
    state.plan.as_mut().unwrap().1.data[99..107].copy_from_slice(&(START + 29).to_le_bytes());
    let projected = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert_eq!(
        projected[1].availability_at(START + 30).unwrap(),
        Availability::Inactive
    );
    let actions = sdk::actions(&DelegationAdapter, &projected[1], &state, &context).unwrap();
    assert!(!actions
        .iter()
        .any(|action| action.kind == ActionKind::Resume));
    assert_eq!(
        sdk::diff_transaction(
            &DelegationAdapter,
            &[official_action(ActionKind::Resume, &state)],
            &state,
            &context
        ),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn cancel_now_at_creation_or_period_boundary_matches_native_lifecycle_and_usage() {
    let trace = trace();
    for (name, elapsed, remaining) in [("subscribe", 0, 100), ("owner_pull_60", 3_600, 40)] {
        let step = transition(&trace, name);
        let mut accounts = accounts(step, "after");
        let mut vm = vm(step, &mut accounts);
        vm.sysvars.clock.unix_timestamp = START + elapsed;
        let state = state(&accounts, vm.sysvars.clock.unix_timestamp, 0);
        let mut context = context(step, "after");
        context
            .evidence
            .references
            .push(format!("test:cancel-now:bank-time:{}", START + elapsed));
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let action = sdk::actions(&DelegationAdapter, &before[1], &state, &context)
            .unwrap()
            .into_iter()
            .find(|action| action.kind == ActionKind::CancelNow)
            .unwrap();
        assert_eq!(
            action.instructions,
            vec![official_action(ActionKind::CancelNow, &state)]
        );
        let result = vm.process_instruction(&action.instructions[0], &accounts);
        assert_eq!(result.raw_result, Ok(()), "{name}");
        let after_state = self::state(
            &result.resulting_accounts,
            vm.sysvars.clock.unix_timestamp,
            0,
        );
        let native = SubscriptionDelegation::from_bytes(&after_state.delegation.1.data).unwrap();
        assert_eq!(native.expires_at_ts, START + elapsed);
        assert_eq!(native.current_period_start_ts, START);
        assert_eq!(native.amount_pulled_in_period, 100 - remaining);
        let after = sdk::compile_state(&DelegationAdapter, &after_state, &context).unwrap();
        assert_eq!(after[0], before[0]);
        assert_eq!(after[2], before[2]);
        assert_eq!(
            after[1].lifecycle,
            if elapsed == 0 {
                Lifecycle::Revoked
            } else {
                Lifecycle::Active {
                    valid_from: Some(START),
                    valid_until: Some(START + elapsed),
                }
            }
        );
        assert_eq!(
            after[1].usage,
            UsageSemantics::Recurring {
                period_seconds: 3_600,
                anchor_unix_seconds: START,
                observed_period_start: START,
                remaining: Some(remaining),
            }
        );
        assert_eq!(
            after[1].availability_at(START + elapsed).unwrap(),
            Availability::Inactive
        );
        if elapsed != 0 {
            assert_eq!(
                before[1].usage,
                UsageSemantics::Recurring {
                    period_seconds: 3_600,
                    anchor_unix_seconds: START,
                    observed_period_start: START + elapsed,
                    remaining: Some(100),
                }
            );
            assert_ne!(before[1].usage, after[1].usage);
        }
        assert_eq!(
            sdk::diff_transaction(&DelegationAdapter, &action.instructions, &state, &context)
                .unwrap(),
            vec![AuthorizationChange::Changed {
                before: Box::new(before[1].clone()),
                after: Box::new(after[1].clone()),
            }],
            "{name}"
        );
        assert_eq!(
            sdk::actions(&DelegationAdapter, &after[1], &after_state, &context)
                .unwrap()
                .iter()
                .map(|action| action.kind)
                .collect::<Vec<_>>(),
            vec![ActionKind::Revoke]
        );
    }
}

#[test]
fn ghost_plan_terms_suspend_spend_and_disable_resume() {
    let trace = trace();
    let step = transition(&trace, "resume_preserves_consumption");
    let mut state = state(&accounts(step, "before"), START + 30, 0);
    let context = context(step, "before");
    let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    for (offset, replacement) in [
        (75, 101_u64.to_le_bytes()),
        (83, 2_u64.to_le_bytes()),
        (91, (START + 1).to_le_bytes()),
    ] {
        state.plan = self::state(&accounts(step, "before"), START + 30, 0).plan;
        state.plan.as_mut().unwrap().1.data[offset..offset + 8].copy_from_slice(&replacement);
        let after = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        assert_eq!(after[0], before[0]);
        assert_eq!(after[1].id, before[1].id);
        assert_eq!(after[1].usage, before[1].usage);
        assert_eq!(after[1].lifecycle, Lifecycle::Suspended);
        assert!(
            !sdk::actions(&DelegationAdapter, &after[1], &state, &context)
                .unwrap()
                .iter()
                .any(|action| action.kind == ActionKind::Resume)
        );
    }
}

#[test]
fn missing_clock_plan_and_current_wallet_evidence_fail_closed() {
    let trace = trace();
    let step = transition(&trace, "owner_pull_60");
    let context = context(step, "after");
    let mut state = state(&accounts(step, "after"), START, 0);
    state.unix_timestamp = None;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::InsufficientEvidence)
    );
    state.unix_timestamp = Some(START);
    state.plan = None;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::InsufficientEvidence)
    );
    state.plan = self::state(&accounts(step, "after"), START, 0).plan;
    state.plan.as_mut().unwrap().1 = Account::default();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedOperation)
    );
    for key in [1, 2, 6] {
        let mut state = self::state(&accounts(step, "after"), START, 0);
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let cancel = official_action(ActionKind::Cancel, &state);
        state
            .source
            .authorities
            .retain(|(address, _)| *address != Pubkey::new_from_array([key; 32]));
        assert_eq!(
            sdk::compile_state(&DelegationAdapter, &state, &context),
            Err(Error::InsufficientEvidence),
            "wallet:{key}"
        );
        assert_eq!(
            sdk::actions(&DelegationAdapter, &before[1], &state, &context),
            Err(Error::InsufficientEvidence)
        );
        assert_eq!(
            sdk::diff_transaction(&DelegationAdapter, &[cancel], &state, &context),
            Err(Error::InsufficientEvidence)
        );
    }
    let mut state = self::state(&accounts(step, "after"), START, 0);
    state
        .source
        .authorities
        .push(state.source.authorities[2].clone());
    assert!(matches!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::InvalidState(_))
    ));
    let mut state = self::state(&accounts(step, "after"), START, 0);
    state.source.authorities[2].1.owner = SUBSCRIPTIONS_ID;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn malformed_native_bindings_and_unknown_versions_are_rejected() {
    let trace = trace();
    let step = transition(&trace, "owner_pull_60");
    let context = context(step, "after");
    for case in 0..20 {
        let mut state = state(&accounts(step, "after"), START, 0);
        match case {
            0 => state.delegation.1.data[0] = 0,
            1 => {
                state.delegation.1.data.pop();
            }
            2 => state.delegation.1.owner = token::ID,
            3 => state.delegation.0 = Pubkey::new_from_array([9; 32]),
            4 => state.delegation.1.data[2] ^= 1,
            5 => state.plan.as_mut().unwrap().1.data[0] = 0,
            6 => {
                state.plan.as_mut().unwrap().1.data.pop();
            }
            7 => state.plan.as_mut().unwrap().1.owner = token::ID,
            8 => state.plan.as_mut().unwrap().0 = Pubkey::new_from_array([9; 32]),
            9 => state.plan.as_mut().unwrap().1.data[33] ^= 1,
            10 => state.plan.as_mut().unwrap().1.data[34] = 2,
            11 => state.plan.as_mut().unwrap().1.data[43..75].fill(9),
            12 => state.delegation.1.data[35..67].fill(9),
            13 => state.delegation.1.data[3..35].fill(9),
            14 => state.delegation.1.data[115..123].fill(0),
            15 => state.delegation.1.data[131..139].copy_from_slice(&101_u64.to_le_bytes()),
            16 => state.delegation.1.executable = true,
            17 => state.authority.1.data[0] = 1,
            18 => state.mint.0 = Pubkey::new_from_array([9; 32]),
            19 => state.plan.as_mut().unwrap().1.executable = true,
            _ => unreachable!(),
        }
        let result = sdk::compile_state(&DelegationAdapter, &state, &context);
        if case == 0 {
            assert_eq!(result, Err(Error::UnsupportedOperation));
        } else {
            assert!(
                matches!(result, Err(Error::InvalidState(_))),
                "case:{case}: {result:?}"
            );
        }
    }
    let mut state = state(&accounts(step, "after"), START, 0);
    state.delegation.1.data[1] = 2;
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedVersion)
    );
    state.delegation.1.data[1] = 1;
    state.token_program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedVersion)
    );
    state.token_program_version = sdk::spl::PROGRAM_VERSION.into();
    let mut context = context;
    context.native.adapter_version = "0.2".into();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedVersion)
    );
    context.native.adapter_version = "0.3".into();
    context.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::UnsupportedVersion)
    );
    context.native.program_version = PROGRAM_VERSION.into();
    context.evidence.references.clear();
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context),
        Err(Error::InsufficientEvidence)
    );
}

#[test]
fn rejected_native_transitions_preserve_projection_and_stale_actions_are_not_predicted() {
    let trace = trace();
    for name in [
        "stale_subscribe_terms",
        "stale_subscribe_authority",
        "revoke_active_rejected",
        "puller_exceeds_shared_remaining",
        "unauthorized_caller",
        "unauthorized_recipient",
        "stale_resume",
        "resume_does_not_refresh_budget",
        "revoke_before_cancel_cutoff_rejected",
        "exclusive_cancel_cutoff",
        "resume_at_cutoff_rejected",
        "removed_puller_rejected",
        "stale_cancel_now_incarnation",
        "cancel_now_requires_both_signers",
        "cancel_now_blocks_collection",
        "past_plan_end_rejected",
    ] {
        let step = transition(&trace, name);
        let mut accounts = accounts(step, "before");
        let vm = vm(step, &mut accounts);
        let plan_id = u64::from(name == "past_plan_end_rejected");
        let state = state(&accounts, vm.sysvars.clock.unix_timestamp, plan_id);
        let context = context(step, "before");
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let instruction = instruction(step);
        let result = vm.process_instruction(&instruction, &accounts);
        assert!(result.raw_result.is_err(), "{name}");
        assert_eq!(
            format!("{:?}", result.raw_result),
            step["outcome"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(result.resulting_accounts, accounts, "{name}");
        assert_eq!(
            before,
            sdk::compile_state(
                &DelegationAdapter,
                &self::state(
                    &result.resulting_accounts,
                    vm.sysvars.clock.unix_timestamp,
                    plan_id
                ),
                &context
            )
            .unwrap()
        );
        assert_eq!(
            sdk::diff_transaction(&DelegationAdapter, &[instruction], &state, &context),
            Err(Error::UnsupportedOperation),
            "{name}"
        );
    }
}

#[test]
fn removing_technical_approval_suspends_spend_and_retains_membership_administration() {
    let trace = trace();
    let step = transition(&trace, "owner_pull_60");
    let mut state = state(&accounts(step, "after"), START, 0);
    let context = context(step, "after");
    let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    let mut token = TokenAccount::unpack(&state.source.account.data).unwrap();
    token.delegate = Default::default();
    token.delegated_amount = 0;
    TokenAccount::pack(token, &mut state.source.account.data).unwrap();
    let after = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].id, before[1].id);
    assert_eq!(after[0].usage, before[1].usage);
    assert_eq!(after[0].lifecycle, Lifecycle::Suspended);
    assert_eq!(after[1], before[2]);
    state.plan.as_mut().unwrap().1.data[363] = b'x';
    assert_eq!(
        sdk::compile_state(&DelegationAdapter, &state, &context).unwrap()[1],
        before[2]
    );
}

#[test]
fn membership_administration_follows_native_expiry_and_requires_clock_without_subscription() {
    let trace = trace();
    for (name, plan_id, succeeds) in [
        ("past_plan_end_rejected", 1, false),
        ("revoke_immediate", 0, true),
    ] {
        let step = transition(&trace, name);
        let mut accounts = accounts(step, "after");
        let mut vm = vm(step, &mut accounts);
        vm.sysvars.clock.unix_timestamp = START + 10_801;
        let state = state(&accounts, vm.sysvars.clock.unix_timestamp, plan_id);
        let mut context = context(step, "after");
        context
            .evidence
            .references
            .push(format!("test:plan-update:bank-time:{}", START + 10_801));
        let before = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        let admin = before.last().unwrap();
        assert_eq!(admin.observability, arm::Observability::Partial);
        assert_eq!(
            admin.lifecycle,
            if succeeds {
                Lifecycle::Active {
                    valid_from: None,
                    valid_until: None,
                }
            } else {
                Lifecycle::Suspended
            }
        );
        assert_eq!(
            admin.availability_at(START + 10_801).unwrap(),
            if succeeds {
                Availability::Unknown
            } else {
                Availability::Inactive
            }
        );
        let plan = Plan::from_bytes(&state.plan.as_ref().unwrap().1.data).unwrap();
        let pullers = if succeeds {
            [Pubkey::default(); 4]
        } else {
            [
                Pubkey::new_from_array([6; 32]),
                Pubkey::default(),
                Pubkey::default(),
                Pubkey::default(),
            ]
        };
        let update = UpdatePlan {
            owner: plan.owner,
            plan_pda: state.plan.as_ref().unwrap().0,
            event_authority: EventAuthority::find_pda().0,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(UpdatePlanInstructionArgs {
            update_plan_data: UpdatePlanData {
                status: plan.status,
                end_ts: plan.data.end_ts,
                pullers,
                metadata_uri: plan.data.metadata_uri,
                expected_created_at: plan.data.terms.created_at,
                expected_end_ts: plan.data.end_ts,
                expected_pullers: plan.data.pullers,
                expected_metadata_uri: plan.data.metadata_uri,
            },
        });
        let result = vm.process_instruction(&update, &accounts);
        assert_eq!(result.raw_result.is_ok(), succeeds, "{name}");
        if succeeds {
            let updated = self::state(
                &result.resulting_accounts,
                vm.sysvars.clock.unix_timestamp,
                plan_id,
            );
            assert_eq!(
                Plan::from_bytes(&updated.plan.as_ref().unwrap().1.data)
                    .unwrap()
                    .data
                    .pullers,
                pullers
            );
            assert_eq!(
                sdk::compile_state(&DelegationAdapter, &updated, &context).unwrap(),
                before
            );
        } else {
            assert_eq!(format!("{:?}", result.raw_result), "Err(Custom(501))");
            assert_eq!(result.resulting_accounts, accounts);
        }
    }
    let step = transition(&trace, "revoke_immediate");
    let mut state = state(&accounts(step, "after"), START + 3_602, 0);
    let context = context(step, "after");
    assert!(state.delegation.1.data.is_empty());
    for technical_approval in [true, false] {
        if !technical_approval {
            let mut token = TokenAccount::unpack(&state.source.account.data).unwrap();
            token.delegate = Default::default();
            token.delegated_amount = 0;
            TokenAccount::pack(token, &mut state.source.account.data).unwrap();
        }
        assert!(DelegationAdapter.source_requirements(&state).clock);
        let projected = sdk::compile_state(&DelegationAdapter, &state, &context).unwrap();
        assert_eq!(projected.len(), if technical_approval { 2 } else { 1 });
        assert_eq!(
            projected.last().unwrap().capability,
            arm::Capability::ModifyAuthority
        );
        state.unix_timestamp = None;
        assert_eq!(
            sdk::compile_state(&DelegationAdapter, &state, &context),
            Err(Error::InsufficientEvidence)
        );
        state.unix_timestamp = Some(START + 3_602);
    }
}
