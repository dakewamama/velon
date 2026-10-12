use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface_v2::state::{Account as TokenAccount, AccountState, Mint};
use subscriptions::{
    accounts::{EventAuthority, RecurringDelegation, SubscriptionAuthority},
    instructions::{
        CreateRecurringDelegation, CreateRecurringDelegationInstructionArgs,
        InitSubscriptionAuthority, RevokeDelegation, TransferRecurring,
        TransferRecurringInstructionArgs,
    },
    types::{CreateRecurringDelegationData, TransferData},
    SUBSCRIPTIONS_ID,
};

#[test]
fn recurring_allowance_is_bounded_and_revoked_natively() {
    let elf = include_bytes!("fixtures/subscriptions-program.so");
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    vm.sysvars.clock.slot = 100;
    vm.sysvars.clock.unix_timestamp = 1_800_000_000;
    vm.sysvars.clock.epoch = 0;
    vm.sysvars.clock.epoch_start_timestamp = 1_800_000_000;
    vm.sysvars.clock.leader_schedule_epoch = 0;

    let owner = Pubkey::new_from_array([1; 32]);
    let delegate = Pubkey::new_from_array([2; 32]);
    let mint = Pubkey::new_from_array([3; 32]);
    let destination = Pubkey::new_from_array([4; 32]);
    let beneficiary = Pubkey::new_from_array([5; 32]);
    let (authority, _) = SubscriptionAuthority::find_pda(&owner, &mint);
    let (delegation, _) = RecurringDelegation::find_pda(&authority, &owner, &delegate, 0);
    let (event_authority, _) = EventAuthority::find_pda();
    let source = Pubkey::find_program_address(
        &[owner.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )
    .0;
    let token_state = TokenAccount {
        mint,
        owner,
        amount: 1_000,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    // Token state is harness setup; all delegation state comes from native instructions.
    let mut accounts = vec![
        (
            owner,
            Account {
                lamports: 1_000_000_000,
                ..Account::default()
            },
        ),
        (
            delegate,
            Account {
                lamports: 1_000_000,
                ..Account::default()
            },
        ),
        (authority, Account::default()),
        (delegation, Account::default()),
        (event_authority, Account::default()),
        (
            mint,
            token::create_account_for_mint(Mint {
                mint_authority: COption::Some(owner),
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
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (
            SUBSCRIPTIONS_ID,
            program::create_program_account_loader_v2(elf),
        ),
    ];
    let initialize = InitSubscriptionAuthority {
        owner,
        subscription_authority: authority,
        token_mint: mint,
        user_ata: source,
        system_program: Pubkey::default(),
        token_program: token::ID,
        payer: None,
    }
    .instruction();
    let create = CreateRecurringDelegation {
        delegator: owner,
        subscription_authority: authority,
        delegation_account: delegation,
        delegatee: delegate,
        system_program: Pubkey::default(),
        payer: None,
    }
    .instruction(CreateRecurringDelegationInstructionArgs {
        recurring_delegation: CreateRecurringDelegationData {
            nonce: 0,
            amount_per_period: 100,
            period_length_s: 30,
            start_ts: 1_800_000_000,
            expiry_ts: 1_800_000_150,
            expected_subscription_authority_init_id: 100,
        },
    });
    let transfer = TransferRecurring {
        delegation_pda: delegation,
        subscription_authority: authority,
        delegator_ata: source,
        receiver_ata: destination,
        token_mint: mint,
        token_program: token::ID,
        delegatee: delegate,
        event_authority,
        self_program: SUBSCRIPTIONS_ID,
    };
    let pull = |amount| {
        transfer.instruction(TransferRecurringInstructionArgs {
            transfer_data: TransferData {
                amount,
                delegator: owner,
                mint,
            },
        })
    };
    let revoke = RevokeDelegation {
        authority: owner,
        delegation_account: delegation,
    }
    .instruction();
    let steps = [
        ("initialize", 0, initialize, "Ok(())", 0, 0, 0),
        ("create", 0, create, "Ok(())", 0, 0, 0),
        ("pull_60", 0, pull(60), "Ok(())", 0, 60, 60),
        (
            "exceed_remaining_40",
            0,
            pull(41),
            "Err(Custom(400))",
            0,
            60,
            60,
        ),
        (
            "skip_three_periods_exceed_cap",
            90,
            pull(101),
            "Err(Custom(400))",
            0,
            60,
            60,
        ),
        (
            "skip_three_periods_one_cap",
            90,
            pull(100),
            "Ok(())",
            90,
            100,
            160,
        ),
        (
            "skipped_periods_no_accumulation",
            90,
            pull(1),
            "Err(Custom(400))",
            90,
            100,
            160,
        ),
        (
            "final_period_pull_60",
            149,
            pull(60),
            "Ok(())",
            120,
            60,
            220,
        ),
        (
            "inclusive_expiry_pull_remaining_40",
            150,
            pull(40),
            "Ok(())",
            120,
            100,
            260,
        ),
        (
            "exhausted_final_period_no_new_cap",
            150,
            pull(1),
            "Err(Custom(400))",
            120,
            100,
            260,
        ),
        (
            "past_expiry",
            151,
            pull(1),
            "Err(Custom(128))",
            120,
            100,
            260,
        ),
        (
            "later_boundary_no_new_cap",
            180,
            pull(100),
            "Err(Custom(128))",
            120,
            100,
            260,
        ),
        ("delegator_revoke", 180, revoke, "Ok(())", 120, 100, 260),
    ];
    let mut transitions = Vec::new();
    for (position, (name, elapsed, instruction, outcome, period_start, pulled, total)) in
        steps.iter().enumerate()
    {
        vm.sysvars.clock.slot = 100 + position as u64;
        vm.sysvars.clock.unix_timestamp = 1_800_000_000 + elapsed;
        let before = accounts.clone();
        let result = vm.process_instruction(instruction, &accounts);
        assert_eq!(format!("{:?}", result.raw_result), *outcome, "{name}");
        if result.raw_result.is_err() {
            assert_eq!(result.resulting_accounts, before, "{name}");
        }
        accounts = result.resulting_accounts;
        transitions.push(serde_json::json!({
            "position": position,
            "name": name,
            "clock": {
                "slot": vm.sysvars.clock.slot,
                "epoch": vm.sysvars.clock.epoch,
                "epoch_start_timestamp": vm.sysvars.clock.epoch_start_timestamp,
                "leader_schedule_epoch": vm.sysvars.clock.leader_schedule_epoch,
                "unix_timestamp": vm.sysvars.clock.unix_timestamp,
            },
            "instruction": {
                "program": instruction.program_id.to_string(),
                "data": instruction.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                "accounts": instruction.accounts.iter().map(|meta| serde_json::json!({
                    "address": meta.pubkey.to_string(), "signer": meta.is_signer,
                    "writable": meta.is_writable,
                })).collect::<Vec<_>>(),
            },
            "outcome": format!("{:?}", result.raw_result),
            "before": snapshot(&before),
            "after": snapshot(&accounts),
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
            TokenAccount::unpack(&observed(destination).data)
                .unwrap()
                .amount,
            *total,
            "{name}"
        );
        assert_eq!(
            SubscriptionAuthority::from_bytes(&observed(authority).data)
                .unwrap()
                .init_id,
            100
        );
        if position == 0 {
            assert!(observed(delegation).data.is_empty());
        } else if position == steps.len() - 1 {
            assert_eq!(observed(delegation).lamports, 0);
            assert!(observed(delegation).data.is_empty());
            assert_eq!(
                observed(source),
                &before.iter().find(|(key, _)| *key == source).unwrap().1
            );
            assert_eq!(
                observed(authority),
                &before.iter().find(|(key, _)| *key == authority).unwrap().1
            );
        } else {
            let grant = RecurringDelegation::from_bytes(&observed(delegation).data).unwrap();
            assert_eq!(observed(delegation).owner, SUBSCRIPTIONS_ID);
            assert_eq!(grant.header.delegator, owner);
            assert_eq!(grant.header.delegatee, delegate);
            assert_eq!(grant.header.payer, owner);
            assert_eq!(grant.header.init_id, 100);
            assert_eq!(grant.subscription_authority, authority);
            assert_eq!(grant.mint, mint);
            assert_eq!(grant.amount_per_period, 100);
            assert_eq!(grant.period_length_s, 30);
            assert_eq!(grant.expiry_ts, 1_800_000_150);
            assert_eq!(
                grant.current_period_start_ts,
                1_800_000_000 + period_start,
                "{name}"
            );
            assert_eq!(grant.amount_pulled_in_period, *pulled, "{name}");
            if position == 2 {
                assert_eq!(grant.amount_per_period - grant.amount_pulled_in_period, 40);
            }
        }
    }
    let actual = serde_json::json!({
        "source": "56de552a26a0f0af437c0ce5191b3309741cc596",
        "client": "subscriptions:0.5.0:5a347ffaa969036061d274d3c91e0277962e2b51",
        "program_sha256": format!("{:x}", Sha256::digest(elf)),
        "token_sha256": format!("{:x}", Sha256::digest(token::ELF)),
        "transitions": transitions,
    });
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/subscriptions-recurring.json")).unwrap();
    assert_eq!(actual, expected);
}

fn snapshot(accounts: &[(Pubkey, Account)]) -> serde_json::Value {
    serde_json::json!(accounts
        .iter()
        .filter(|(_, account)| !account.executable)
        .map(|(address, account)| {
            serde_json::json!({
                "address": address.to_string(), "owner": account.owner.to_string(),
                "lamports": account.lamports, "executable": account.executable,
                "data": account.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            })
        })
        .collect::<Vec<_>>())
}
