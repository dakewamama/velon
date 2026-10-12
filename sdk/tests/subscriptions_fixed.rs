use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface_v2::state::{Account as TokenAccount, AccountState, Mint};
use subscriptions::{
    accounts::{EventAuthority, FixedDelegation, SubscriptionAuthority},
    instructions::{
        CreateFixedDelegation, CreateFixedDelegationInstructionArgs, InitSubscriptionAuthority,
        RevokeDelegation, TransferFixed, TransferFixedInstructionArgs,
    },
    types::{CreateFixedDelegationData, TransferData},
    SUBSCRIPTIONS_ID,
};

#[test]
fn fixed_allowance_is_consumed_and_revoked_natively() {
    let elf = include_bytes!("fixtures/subscriptions-program.so");
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&SUBSCRIPTIONS_ID, &program::loader_keys::LOADER_V2, elf);
    token::add_program(&mut vm);
    vm.sysvars.clock.slot = 100;
    vm.sysvars.clock.unix_timestamp = 1_800_000_000;

    let owner = Pubkey::new_from_array([1; 32]);
    let delegate = Pubkey::new_from_array([2; 32]);
    let mint = Pubkey::new_from_array([3; 32]);
    let destination = Pubkey::new_from_array([4; 32]);
    let beneficiary = Pubkey::new_from_array([5; 32]);
    let (authority, _) = SubscriptionAuthority::find_pda(&owner, &mint);
    let (delegation, _) = FixedDelegation::find_pda(&authority, &owner, &delegate, 0);
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
    let create = CreateFixedDelegation {
        delegator: owner,
        subscription_authority: authority,
        delegation_account: delegation,
        delegatee: delegate,
        system_program: Pubkey::default(),
        payer: None,
    }
    .instruction(CreateFixedDelegationInstructionArgs {
        fixed_delegation: CreateFixedDelegationData {
            nonce: 0,
            amount: 100,
            expiry_ts: 1_800_000_100,
            expected_subscription_authority_init_id: 100,
        },
    });
    let transfer = TransferFixed {
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
        transfer.instruction(TransferFixedInstructionArgs {
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
    let instructions = [initialize, create, pull(40), pull(61), revoke];
    let mut transitions = Vec::new();
    for (position, instruction) in instructions.iter().enumerate() {
        let before = accounts.clone();
        let result = vm.process_instruction(instruction, &accounts);
        if position == 3 {
            assert_eq!(format!("{:?}", result.raw_result), "Err(Custom(300))");
            assert_eq!(result.resulting_accounts, before);
        } else {
            assert_eq!(result.raw_result, Ok(()));
        }
        accounts = result.resulting_accounts;
        transitions.push(serde_json::json!({
            "position": position,
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
        if position == 0 {
            let technical = TokenAccount::unpack(&observed(source).data).unwrap();
            assert_eq!(technical.delegate, COption::Some(authority));
            assert_eq!(technical.delegated_amount, u64::MAX);
            assert_eq!(
                SubscriptionAuthority::from_bytes(&observed(authority).data)
                    .unwrap()
                    .init_id,
                100
            );
        } else if position == 1 || position == 2 {
            let grant = FixedDelegation::from_bytes(&observed(delegation).data).unwrap();
            assert_eq!(grant.amount, if position == 1 { 100 } else { 60 });
            assert_eq!(grant.header.delegatee, delegate);
        } else if position == 4 {
            assert_eq!(observed(delegation).lamports, 0);
            assert!(observed(delegation).data.is_empty());
            let technical = TokenAccount::unpack(&observed(source).data).unwrap();
            assert_eq!(technical.delegate, COption::Some(authority));
            assert_eq!(technical.delegated_amount, u64::MAX - 40);
            assert_eq!(technical.amount, 960);
            assert_eq!(
                TokenAccount::unpack(&observed(destination).data)
                    .unwrap()
                    .amount,
                40
            );
        }
    }
    let actual = serde_json::json!({
        "source": "56de552a26a0f0af437c0ce5191b3309741cc596",
        "client": "subscriptions:0.5.0:5a347ffaa969036061d274d3c91e0277962e2b51",
        "program_sha256": format!("{:x}", Sha256::digest(elf)),
        "token_sha256": format!("{:x}", Sha256::digest(token::ELF)),
        "clock": { "slot": 100, "unix_timestamp": 1_800_000_000 },
        "transitions": transitions,
    });
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/subscriptions-fixed.json")).unwrap();
    assert_eq!(actual, expected);
}

fn snapshot(accounts: &[(Pubkey, Account)]) -> serde_json::Value {
    serde_json::json!(accounts
        .iter()
        .filter(|(_, account)| !account.executable)
        .map(|(address, account)| {
            serde_json::json!({
                "address": address.to_string(), "owner": account.owner.to_string(),
                "lamports": account.lamports,
                "data": account.data.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            })
        })
        .collect::<Vec<_>>())
}
