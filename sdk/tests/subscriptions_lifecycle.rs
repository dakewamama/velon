use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::AccountMeta;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface_v2::state::{Account as TokenAccount, AccountState, Mint};
use subscriptions::{
    accounts::{EventAuthority, Plan, SubscriptionAuthority, SubscriptionDelegation},
    instructions::{
        CancelSubscription, CancelSubscriptionNow, CancelSubscriptionNowInstructionArgs,
        CreatePlan, CreatePlanInstructionArgs, InitSubscriptionAuthority, ResumeSubscription,
        ResumeSubscriptionInstructionArgs, RevokeDelegation, Subscribe, SubscribeInstructionArgs,
        TransferSubscription, TransferSubscriptionInstructionArgs, UpdatePlan,
        UpdatePlanInstructionArgs,
    },
    types::{
        CancelSubscriptionNowData, PlanData, PlanTerms, ResumeData, SubscribeData, TransferData,
        UpdatePlanData,
    },
    SUBSCRIPTIONS_ID,
};

#[test]
fn subscription_lifecycle_and_shared_budget_are_enforced_natively() {
    let elf = include_bytes!("fixtures/subscriptions-program.so");
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    let start = 1_800_000_000;
    vm.sysvars.clock.epoch_start_timestamp = start;
    let subscriber = Pubkey::new_from_array([1; 32]);
    let merchant = Pubkey::new_from_array([2; 32]);
    let mint = Pubkey::new_from_array([3; 32]);
    let destination = Pubkey::new_from_array([4; 32]);
    let beneficiary = Pubkey::new_from_array([5; 32]);
    let puller = Pubkey::new_from_array([6; 32]);
    let stranger = Pubkey::new_from_array([7; 32]);
    let wrong_destination = Pubkey::new_from_array([8; 32]);
    let (authority, _) = SubscriptionAuthority::find_pda(&subscriber, &mint);
    let (plan, plan_bump) = Plan::find_pda(&merchant, 0);
    let (other_plan, other_bump) = Plan::find_pda(&merchant, 1);
    let (subscription, _) = SubscriptionDelegation::find_pda(&plan, &subscriber);
    let (other_subscription, _) = SubscriptionDelegation::find_pda(&other_plan, &subscriber);
    let (event_authority, _) = EventAuthority::find_pda();
    let source = Pubkey::find_program_address(
        &[subscriber.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )
    .0;
    let token_state = TokenAccount {
        mint,
        owner: subscriber,
        amount: 1_000,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    // Token state is harness setup; authority, plans and subscriptions are created natively.
    let mut accounts: Vec<_> = [subscriber, merchant, puller, stranger]
        .into_iter()
        .map(|key| {
            (
                key,
                Account {
                    lamports: 1_000_000_000,
                    ..Account::default()
                },
            )
        })
        .collect();
    accounts.extend(
        [
            authority,
            plan,
            other_plan,
            subscription,
            other_subscription,
            event_authority,
        ]
        .map(|key| (key, Account::default())),
    );
    accounts.extend([
        (
            mint,
            token::create_account_for_mint(Mint {
                mint_authority: COption::Some(subscriber),
                supply: 1_000,
                decimals: 0,
                is_initialized: true,
                freeze_authority: COption::None,
            }),
        ),
        (source, token::create_account_for_token_account(token_state)),
        (
            destination,
            token::create_account_for_token_account(TokenAccount {
                owner: beneficiary,
                amount: 0,
                ..token_state
            }),
        ),
        (
            wrong_destination,
            token::create_account_for_token_account(TokenAccount {
                owner: stranger,
                amount: 0,
                ..token_state
            }),
        ),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (
            SUBSCRIPTIONS_ID,
            program::create_program_account_loader_v2(elf),
        ),
    ]);
    let initialize = InitSubscriptionAuthority {
        owner: subscriber,
        subscription_authority: authority,
        token_mint: mint,
        user_ata: source,
        system_program: Pubkey::default(),
        token_program: token::ID,
        payer: None,
    }
    .instruction();
    let create_plan = |plan_id, plan_pda, restricted| {
        CreatePlan {
            merchant,
            plan_pda,
            token_mint: mint,
            system_program: Pubkey::default(),
            token_program: token::ID,
            payer: None,
        }
        .instruction(CreatePlanInstructionArgs {
            plan_data: PlanData {
                plan_id,
                mint,
                terms: PlanTerms {
                    amount: 100,
                    period_hours: 1,
                    created_at: 0,
                },
                end_ts: if restricted { 0 } else { start + 10_800 },
                destinations: if restricted {
                    [
                        beneficiary,
                        Pubkey::default(),
                        Pubkey::default(),
                        Pubkey::default(),
                    ]
                } else {
                    [Pubkey::default(); 4]
                },
                pullers: if restricted {
                    [
                        puller,
                        Pubkey::default(),
                        Pubkey::default(),
                        Pubkey::default(),
                    ]
                } else {
                    [Pubkey::default(); 4]
                },
                metadata_uri: [0; 128],
            },
        })
    };
    let subscribe =
        |plan_id, plan_pda, plan_bump, subscription_pda, expected_amount, expected_init_id| {
            Subscribe {
                subscriber,
                merchant,
                plan_pda,
                subscription_pda,
                subscription_authority_pda: authority,
                system_program: Pubkey::default(),
                event_authority,
                self_program: SUBSCRIPTIONS_ID,
                payer: None,
            }
            .instruction(SubscribeInstructionArgs {
                subscribe_data: SubscribeData {
                    plan_id,
                    plan_bump,
                    expected_mint: mint,
                    expected_amount,
                    expected_period_hours: 1,
                    expected_created_at: start,
                    expected_subscription_authority_init_id: expected_init_id,
                },
            })
        };
    let pull = |plan_pda, subscription_pda, caller, receiver_ata, amount| {
        TransferSubscription {
            subscription_pda,
            plan_pda,
            subscription_authority: authority,
            delegator_ata: source,
            receiver_ata,
            caller,
            token_mint: mint,
            token_program: token::ID,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(TransferSubscriptionInstructionArgs {
            transfer_data: TransferData {
                amount,
                delegator: subscriber,
                mint,
            },
        })
    };
    let cancel = CancelSubscription {
        subscriber,
        plan_pda: plan,
        subscription_pda: subscription,
        event_authority,
        self_program: SUBSCRIPTIONS_ID,
    }
    .instruction();
    let resume = |expiry| {
        ResumeSubscription {
            subscriber,
            plan_pda: plan,
            subscription_pda: subscription,
            subscription_authority: authority,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(ResumeSubscriptionInstructionArgs {
            resume_data: ResumeData {
                expected_expires_at_ts: expiry,
            },
        })
    };
    let cancel_now = |period| {
        CancelSubscriptionNow {
            subscriber,
            merchant,
            plan_pda: plan,
            subscription_pda: subscription,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(CancelSubscriptionNowInstructionArgs {
            cancel_subscription_now_data: CancelSubscriptionNowData {
                expected_current_period_start_ts: period,
            },
        })
    };
    let revoke = RevokeDelegation {
        authority: subscriber,
        delegation_account: subscription,
    }
    .instruction_with_remaining_accounts(&[AccountMeta::new_readonly(plan, false)]);
    let update = |update_plan_data| {
        UpdatePlan {
            owner: merchant,
            plan_pda: plan,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(UpdatePlanInstructionArgs { update_plan_data })
    };
    let sunset_data = UpdatePlanData {
        status: 0,
        end_ts: start + 10_800,
        pullers: [
            puller,
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
        ],
        metadata_uri: [0; 128],
        expected_created_at: start,
        expected_end_ts: 0,
        expected_pullers: [
            puller,
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
        ],
        expected_metadata_uri: [0; 128],
    };
    let sunset = update(sunset_data.clone());
    let remove_puller = update(UpdatePlanData {
        pullers: [Pubkey::default(); 4],
        expected_end_ts: start + 10_800,
        ..sunset_data.clone()
    });
    let restore_puller = update(UpdatePlanData {
        expected_pullers: [Pubkey::default(); 4],
        expected_end_ts: start + 10_800,
        ..sunset_data
    });
    let cancel_other = CancelSubscription {
        subscriber,
        plan_pda: other_plan,
        subscription_pda: other_subscription,
        event_authority,
        self_program: SUBSCRIPTIONS_ID,
    }
    .instruction();
    let mut unsigned_cancel = cancel_now(start + 3_601);
    unsigned_cancel.accounts[1].is_signer = false;
    let steps = [
        ("initialize", 0, initialize, "Ok(())", 0, 0, 0, 0),
        (
            "create_plan",
            0,
            create_plan(0, plan, true),
            "Ok(())",
            0,
            0,
            0,
            0,
        ),
        (
            "stale_subscribe_terms",
            0,
            subscribe(0, plan, plan_bump, subscription, 99, 100),
            "Err(Custom(519))",
            0,
            0,
            0,
            0,
        ),
        (
            "stale_subscribe_authority",
            0,
            subscribe(0, plan, plan_bump, subscription, 100, 99),
            "Err(Custom(136))",
            0,
            0,
            0,
            0,
        ),
        (
            "subscribe",
            0,
            subscribe(0, plan, plan_bump, subscription, 100, 100),
            "Ok(())",
            0,
            0,
            0,
            0,
        ),
        (
            "create_other_plan",
            0,
            create_plan(1, other_plan, false),
            "Ok(())",
            0,
            0,
            0,
            0,
        ),
        (
            "subscribe_other",
            0,
            subscribe(1, other_plan, other_bump, other_subscription, 100, 100),
            "Ok(())",
            0,
            0,
            0,
            0,
        ),
        (
            "revoke_active_rejected",
            0,
            revoke.clone(),
            "Err(Custom(510))",
            0,
            0,
            0,
            0,
        ),
        (
            "owner_pull_60",
            0,
            pull(plan, subscription, merchant, destination, 60),
            "Ok(())",
            0,
            60,
            0,
            60,
        ),
        (
            "puller_exceeds_shared_remaining",
            0,
            pull(plan, subscription, puller, destination, 41),
            "Err(Custom(400))",
            0,
            60,
            0,
            60,
        ),
        (
            "puller_uses_shared_budget",
            0,
            pull(plan, subscription, puller, destination, 20),
            "Ok(())",
            0,
            80,
            0,
            80,
        ),
        (
            "unauthorized_caller",
            0,
            pull(plan, subscription, stranger, destination, 1),
            "Err(Custom(130))",
            0,
            80,
            0,
            80,
        ),
        (
            "unauthorized_recipient",
            0,
            pull(plan, subscription, merchant, wrong_destination, 1),
            "Err(Custom(506))",
            0,
            80,
            0,
            80,
        ),
        (
            "cancel_pending",
            10,
            cancel.clone(),
            "Ok(())",
            0,
            80,
            3_600,
            80,
        ),
        (
            "pending_cancel_still_collectible",
            20,
            pull(plan, subscription, puller, destination, 10),
            "Ok(())",
            0,
            90,
            3_600,
            90,
        ),
        (
            "stale_resume",
            30,
            resume(start + 3_601),
            "Err(Custom(521))",
            0,
            90,
            3_600,
            90,
        ),
        (
            "resume_preserves_consumption",
            30,
            resume(start + 3_600),
            "Ok(())",
            0,
            90,
            0,
            90,
        ),
        (
            "resume_does_not_refresh_budget",
            30,
            pull(plan, subscription, merchant, destination, 11),
            "Err(Custom(400))",
            0,
            90,
            0,
            90,
        ),
        ("cancel_again", 40, cancel, "Ok(())", 0, 90, 3_600, 90),
        (
            "revoke_before_cancel_cutoff_rejected",
            3_599,
            revoke.clone(),
            "Err(Custom(510))",
            0,
            90,
            3_600,
            90,
        ),
        (
            "exclusive_cancel_cutoff",
            3_600,
            pull(plan, subscription, merchant, destination, 1),
            "Err(Custom(508))",
            0,
            90,
            3_600,
            90,
        ),
        (
            "resume_at_cutoff_rejected",
            3_600,
            resume(start + 3_600),
            "Err(Custom(508))",
            0,
            90,
            3_600,
            90,
        ),
        (
            "revoke_cancelled",
            3_600,
            revoke.clone(),
            "Ok(())",
            0,
            0,
            0,
            90,
        ),
        (
            "resubscribe",
            3_601,
            subscribe(0, plan, plan_bump, subscription, 100, 100),
            "Ok(())",
            3_601,
            0,
            0,
            90,
        ),
        ("sunset", 3_601, sunset.clone(), "Ok(())", 3_601, 0, 0, 90),
        (
            "sunset_existing_collectible",
            3_601,
            pull(plan, subscription, merchant, destination, 10),
            "Ok(())",
            3_601,
            10,
            0,
            100,
        ),
        (
            "stale_plan_update",
            3_601,
            sunset,
            "Err(Custom(522))",
            3_601,
            10,
            0,
            100,
        ),
        (
            "sunset_puller_removal",
            3_601,
            remove_puller,
            "Ok(())",
            3_601,
            10,
            0,
            100,
        ),
        (
            "removed_puller_rejected",
            3_601,
            pull(plan, subscription, puller, destination, 1),
            "Err(Custom(130))",
            3_601,
            10,
            0,
            100,
        ),
        (
            "sunset_puller_restoration_rejected",
            3_601,
            restore_puller,
            "Err(Custom(513))",
            3_601,
            10,
            0,
            100,
        ),
        (
            "stale_cancel_now_incarnation",
            3_602,
            cancel_now(start),
            "Err(Custom(521))",
            3_601,
            10,
            0,
            100,
        ),
        (
            "cancel_now_requires_both_signers",
            3_602,
            unsigned_cancel,
            "Err(Custom(100))",
            3_601,
            10,
            0,
            100,
        ),
        (
            "cancel_now",
            3_602,
            cancel_now(start + 3_601),
            "Ok(())",
            3_601,
            10,
            3_602,
            100,
        ),
        (
            "cancel_now_blocks_collection",
            3_602,
            pull(plan, subscription, merchant, destination, 1),
            "Err(Custom(508))",
            3_601,
            10,
            3_602,
            100,
        ),
        (
            "other_subscription_survives_open_recipient",
            3_602,
            pull(
                other_plan,
                other_subscription,
                merchant,
                wrong_destination,
                100,
            ),
            "Ok(())",
            3_601,
            10,
            3_602,
            200,
        ),
        ("revoke_immediate", 3_602, revoke, "Ok(())", 0, 0, 0, 200),
        (
            "sunset_blocks_new_subscriptions",
            3_603,
            subscribe(0, plan, plan_bump, subscription, 100, 100),
            "Err(Custom(500))",
            0,
            0,
            0,
            200,
        ),
        (
            "other_plan_final_period_pull_60",
            10_799,
            pull(
                other_plan,
                other_subscription,
                merchant,
                wrong_destination,
                60,
            ),
            "Ok(())",
            0,
            0,
            0,
            260,
        ),
        (
            "cancel_capped_at_inclusive_plan_end",
            10_800,
            cancel_other,
            "Ok(())",
            0,
            0,
            0,
            260,
        ),
        (
            "inclusive_plan_end_pull_remaining",
            10_800,
            pull(
                other_plan,
                other_subscription,
                merchant,
                wrong_destination,
                40,
            ),
            "Ok(())",
            0,
            0,
            0,
            300,
        ),
        (
            "past_plan_end_rejected",
            10_801,
            pull(
                other_plan,
                other_subscription,
                merchant,
                wrong_destination,
                1,
            ),
            "Err(Custom(501))",
            0,
            0,
            0,
            300,
        ),
    ];
    let mut transitions = Vec::new();
    for (position, (name, elapsed, instruction, outcome, period, consumed, expiry, total)) in
        steps.iter().enumerate()
    {
        vm.sysvars.clock.slot = 100 + position as u64;
        vm.sysvars.clock.unix_timestamp = start + elapsed;
        let before = accounts.clone();
        let result = vm.process_instruction(instruction, &accounts);
        assert_eq!(format!("{:?}", result.raw_result), *outcome, "{name}");
        if result.raw_result.is_err() {
            assert_eq!(result.resulting_accounts, before, "{name}");
        }
        accounts = result.resulting_accounts;
        transitions.push(serde_json::json!({
            "position": position, "name": name,
            "clock": { "slot": vm.sysvars.clock.slot, "epoch": vm.sysvars.clock.epoch,
                "epoch_start_timestamp": vm.sysvars.clock.epoch_start_timestamp,
                "leader_schedule_epoch": vm.sysvars.clock.leader_schedule_epoch,
                "unix_timestamp": vm.sysvars.clock.unix_timestamp },
            "instruction": { "program": instruction.program_id.to_string(),
                "data": instruction.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                "accounts": instruction.accounts.iter().map(|meta| serde_json::json!({
                    "address": meta.pubkey.to_string(), "signer": meta.is_signer, "writable": meta.is_writable,
                })).collect::<Vec<_>>() },
            "outcome": format!("{:?}", result.raw_result),
            "before": snapshot(&before), "after": snapshot(&accounts),
        }));
        let observed = |key| {
            &accounts
                .iter()
                .find(|(address, _)| *address == key)
                .unwrap()
                .1
        };
        let technical = TokenAccount::unpack(&observed(source).data).unwrap();
        assert_eq!(technical.delegate, COption::Some(authority), "{name}");
        assert_eq!(technical.delegated_amount, u64::MAX - total, "{name}");
        assert_eq!(technical.amount, 1_000 - total, "{name}");
        assert_eq!(
            SubscriptionAuthority::from_bytes(&observed(authority).data)
                .unwrap()
                .init_id,
            100
        );
        if !observed(subscription).data.is_empty() {
            let grant = SubscriptionDelegation::from_bytes(&observed(subscription).data).unwrap();
            assert_eq!(grant.header.delegator, subscriber);
            assert_eq!(grant.header.delegatee, plan);
            assert_eq!(grant.header.payer, subscriber);
            assert_eq!(grant.header.init_id, 100);
            assert_eq!(grant.terms.amount, 100);
            assert_eq!(grant.terms.period_hours, 1);
            assert_eq!(grant.terms.created_at, start);
            assert_eq!(grant.current_period_start_ts, start + period, "{name}");
            assert_eq!(grant.amount_pulled_in_period, *consumed, "{name}");
            assert_eq!(
                grant.expires_at_ts,
                if *expiry == 0 { 0 } else { start + expiry },
                "{name}"
            );
        }
        if *name == "revoke_cancelled" || *name == "revoke_immediate" {
            assert_eq!(observed(subscription), &Account::default());
            for key in [source, authority, plan, other_subscription] {
                assert_eq!(
                    observed(key),
                    &before
                        .iter()
                        .find(|(address, _)| *address == key)
                        .unwrap()
                        .1
                );
            }
        }
        if *name == "cancel_capped_at_inclusive_plan_end"
            || *name == "inclusive_plan_end_pull_remaining"
            || *name == "past_plan_end_rejected"
        {
            let grant =
                SubscriptionDelegation::from_bytes(&observed(other_subscription).data).unwrap();
            assert_eq!(grant.expires_at_ts, start + 10_801);
            assert_eq!(grant.current_period_start_ts, start + 7_200);
            assert_eq!(
                grant.amount_pulled_in_period,
                if *name == "cancel_capped_at_inclusive_plan_end" {
                    60
                } else {
                    100
                }
            );
        }
        if *name == "other_subscription_survives_open_recipient" {
            let grant =
                SubscriptionDelegation::from_bytes(&observed(other_subscription).data).unwrap();
            assert_eq!(grant.current_period_start_ts, start + 3_600);
            assert_eq!(grant.amount_pulled_in_period, 100);
            assert_eq!(grant.expires_at_ts, 0);
        }
    }
    let actual = serde_json::json!({
        "source": "56de552a26a0f0af437c0ce5191b3309741cc596",
        "client": "subscriptions:0.5.0:5a347ffaa969036061d274d3c91e0277962e2b51",
        "program_sha256": format!("{:x}", Sha256::digest(elf)),
        "token_sha256": format!("{:x}", Sha256::digest(token::ELF)), "transitions": transitions,
    });
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/subscriptions-lifecycle.json")).unwrap();
    assert_eq!(actual, expected);
}

fn snapshot(accounts: &[(Pubkey, Account)]) -> serde_json::Value {
    serde_json::json!(accounts
        .iter()
        .filter(|(_, account)| !account.executable)
        .map(|(address, account)| serde_json::json!({
            "address": address.to_string(), "owner": account.owner.to_string(),
            "lamports": account.lamports, "executable": account.executable,
            "data": account.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        }))
        .collect::<Vec<_>>())
}
