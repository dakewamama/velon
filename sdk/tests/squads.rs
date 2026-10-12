use arm::{
    Availability, Capability, Constraint, ConstraintExpr, EvidenceBundle, NativeContext, Principal,
    UsageSemantics,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use catalyst_sdk::{
    actions, compile_state,
    squads::{SpendingLimitAdapter, State, DEPLOYMENT, PROGRAM_ID, PROGRAM_VERSION},
    verify_transaction_diff, ActionKind, Context, Error,
};
use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface_v2::state::Account as TokenAccount;

/// Fetched by `bun run fixture:squads`; read at run time so it is never embedded or skipped.
fn elf() -> &'static [u8] {
    static ELF: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    ELF.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/squads-v4-mainnet.so"
        );
        let bytes = std::fs::read(path).expect("run `bun run fixture:squads` first");
        assert_eq!(
            format!("sha256:{:x}", Sha256::digest(&bytes)),
            PROGRAM_VERSION,
            "squads-v4-mainnet.so is not the pinned program"
        );
        bytes
    })
}
const RESPONSE: &str = include_str!("fixtures/squads-spending-limit-response.json");
const MONTH: i64 = 30 * 24 * 60 * 60;
const REMAINING: u64 = 8_042_000_000;

fn capture() -> Value {
    serde_json::from_str(include_str!("fixtures/squads-spending-limit-capture.json")).unwrap()
}

fn key(name: &str) -> Pubkey {
    capture()[name].as_str().unwrap().parse().unwrap()
}

fn members() -> Vec<Pubkey> {
    capture()["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| member.as_str().unwrap().parse().unwrap())
        .collect()
}

/// Every account is the unmodified finalized mainnet value; RPC null stays an empty account.
fn observed() -> Vec<(Pubkey, Account)> {
    let response: Value = serde_json::from_str(RESPONSE).unwrap();
    capture()["keys"]
        .as_array()
        .unwrap()
        .iter()
        .zip(response["result"]["value"].as_array().unwrap())
        .map(|(key, value)| {
            let account = if value.is_null() {
                Account::default()
            } else {
                Account {
                    lamports: value["lamports"].as_u64().unwrap(),
                    data: STANDARD.decode(value["data"][0].as_str().unwrap()).unwrap(),
                    owner: value["owner"].as_str().unwrap().parse().unwrap(),
                    executable: value["executable"].as_bool().unwrap(),
                    rent_epoch: 0,
                }
            };
            (key.as_str().unwrap().parse().unwrap(), account)
        })
        .collect()
}

fn get(accounts: &[(Pubkey, Account)], key: Pubkey) -> Account {
    accounts
        .iter()
        .find(|(address, _)| *address == key)
        .unwrap()
        .1
        .clone()
}

fn state(accounts: &[(Pubkey, Account)]) -> State {
    State {
        address: key("spending_limit"),
        account: get(accounts, key("spending_limit")),
        multisig: get(accounts, key("multisig")),
    }
}

fn context() -> Context {
    Context {
        program_id: PROGRAM_ID,
        native: NativeContext {
            protocol: "squads-v4".into(),
            deployment: DEPLOYMENT.into(),
            program_version: PROGRAM_VERSION.into(),
            adapter_version: "0.1".into(),
        },
        evidence: EvidenceBundle {
            references: vec![format!(
                "rpc:squads-spending-limit-response.json:sha256:{}",
                capture()["response_sha256"].as_str().unwrap()
            )],
            observed_at: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d:rpc:finalized:455978356"
                .into(),
        },
    }
}

fn last_reset(accounts: &[(Pubkey, Account)]) -> i64 {
    match compile_state(&SpendingLimitAdapter, &state(accounts), &context()).unwrap()[0].usage {
        UsageSemantics::Recurring {
            observed_period_start,
            ..
        } => observed_period_start,
        _ => panic!("monthly limit"),
    }
}

fn remaining(accounts: &[(Pubkey, Account)]) -> u64 {
    match compile_state(&SpendingLimitAdapter, &state(accounts), &context()).unwrap()[0].usage {
        UsageSemantics::Recurring { remaining, .. } => remaining.unwrap(),
        _ => panic!("monthly limit"),
    }
}

fn vm(unix_timestamp: i64) -> Mollusk {
    let mut vm = Mollusk::default();
    vm.add_program_with_loader_and_elf(&PROGRAM_ID, &program::loader_keys::LOADER_V3, elf());
    token::add_program(&mut vm);
    vm.sysvars.clock.unix_timestamp = unix_timestamp;
    vm
}

fn spend(member: Pubkey, destination: Pubkey, token_account: Pubkey, amount: u64) -> Instruction {
    let mut data = Sha256::digest(b"global:spending_limit_use")[..8].to_vec();
    data.extend(amount.to_le_bytes());
    data.extend([6, 0]);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(key("multisig"), false),
            AccountMeta::new_readonly(member, true),
            AccountMeta::new(key("spending_limit"), false),
            AccountMeta::new(key("vault"), false),
            AccountMeta::new(destination, false),
            // Anchor reads the program id as an absent optional account.
            AccountMeta::new_readonly(PROGRAM_ID, false),
            AccountMeta::new_readonly(key("mint"), false),
            AccountMeta::new(key("vault_token_account"), false),
            AccountMeta::new(token_account, false),
            AccountMeta::new_readonly(token::ID, false),
        ],
        data,
    }
}

fn run(
    vm: &Mollusk,
    instruction: &Instruction,
    accounts: &mut [(Pubkey, Account)],
) -> Result<(), String> {
    // A supplied Clock account would override the clock each case sets on the VM.
    let mut input = accounts.to_vec();
    input.retain(|(address, _)| *address != key_of_clock());
    input.push(token::keyed_account());
    input.push((
        PROGRAM_ID,
        program::create_program_account_loader_v3(&PROGRAM_ID),
    ));
    let result = vm.process_instruction(instruction, &input);
    if let Err(error) = &result.raw_result {
        return Err(format!("{error:?}"));
    }
    for (key, account) in accounts.iter_mut() {
        if *key != key_of_clock() {
            *account = get(&result.resulting_accounts, *key);
        }
    }
    Ok(())
}

fn balance(accounts: &[(Pubkey, Account)], key: Pubkey) -> u64 {
    TokenAccount::unpack(&get(accounts, key).data)
        .unwrap()
        .amount
}

#[test]
fn retained_capture_and_program_are_the_pinned_bytes() {
    elf();
    assert_eq!(
        format!("{:x}", Sha256::digest(RESPONSE.as_bytes())),
        capture()["response_sha256"].as_str().unwrap()
    );
}

#[test]
fn mainnet_limit_is_one_shared_allowance_separate_from_its_controller() {
    let accounts = observed();
    let grants = compile_state(&SpendingLimitAdapter, &state(&accounts), &context()).unwrap();
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/squads-spending-limit-arm.json")).unwrap();
    assert_eq!(serde_json::to_value(&grants).unwrap(), golden);

    let [spend, control] = grants.as_slice() else {
        panic!("one shared spend grant and one controller");
    };
    let spenders: Vec<_> = members()
        .iter()
        .map(|member| Principal::Identity(member.to_string()))
        .collect();
    assert_eq!(spend.principal, Principal::AnyOf(spenders));
    assert_eq!(spend.resource.id, key("vault").to_string());
    assert_eq!(
        spend.constraints,
        ConstraintExpr::All(vec![
            ConstraintExpr::Constraint(Constraint::AmountAtMost {
                asset: arm::Resource {
                    namespace: "solana:mint".into(),
                    id: key("mint").to_string(),
                },
                amount: 30_000_000_000,
            }),
            ConstraintExpr::Constraint(Constraint::Recipient {
                principal: Principal::Identity(key("destination").to_string()),
            }),
        ])
    );
    assert_eq!(remaining(&accounts), REMAINING);
    assert_eq!(control.capability, Capability::RevokeAuthority);
    assert_eq!(
        control.principal,
        Principal::Identity(key("config_authority").to_string())
    );
    // The observed month ended long before this capture; ARM must not guess the reset.
    let clock = get(&accounts, key_of_clock());
    let now = i64::from_le_bytes(clock.data[32..40].try_into().unwrap());
    assert!(now > last_reset(&accounts) + MONTH);
    assert_eq!(spend.availability_at(now).unwrap(), Availability::Unknown);
    assert_eq!(
        spend
            .availability_at(last_reset(&accounts) + MONTH - 1)
            .unwrap(),
        Availability::Conditional
    );
}

fn key_of_clock() -> Pubkey {
    "SysvarC1ock11111111111111111111111111111111"
        .parse()
        .unwrap()
}

// Error codes returned by the deployed program for each refusal.
const UNAUTHORIZED: &str = "Custom(6004)";
const INVALID_DESTINATION: &str = "Custom(6025)";
const LIMIT_EXCEEDED: &str = "Custom(6026)";
const INSUFFICIENT_FUNDS: &str = "Custom(1)";

#[test]
fn native_use_enforces_member_destination_shared_budget_and_period() {
    let mut accounts = observed();
    let start = last_reset(&accounts);
    let [first, second, ..] = members()[..] else {
        panic!("three members");
    };
    let (destination, token_account) = (key("destination"), key("destination_token_account"));
    let held = balance(&accounts, key("vault_token_account"));
    let outsider = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();
    let stranger_tokens = Pubkey::new_unique();
    let mut other = get(&accounts, token_account);
    let mut token_state = TokenAccount::unpack(&other.data).unwrap();
    token_state.owner = stranger;
    TokenAccount::pack(token_state, &mut other.data).unwrap();
    // Harness accounts: an unlisted signer and an unlisted recipient with a valid token account.
    accounts.extend([
        (outsider, Account::default()),
        (stranger, Account::default()),
        (stranger_tokens, other),
    ]);

    // Exactly one period after the reset the native budget has not reset yet.
    let within = vm(start + MONTH);
    let before = accounts.clone();
    let mut unsigned = spend(first, destination, token_account, 1);
    unsigned.accounts[1].is_signer = false;
    for (instruction, refusal) in [
        (
            spend(outsider, destination, token_account, 1),
            Some(UNAUTHORIZED),
        ),
        (
            spend(first, stranger, stranger_tokens, 1),
            Some(INVALID_DESTINATION),
        ),
        // The allowance is not a balance: this vault holds less than its members may spend.
        (
            spend(first, destination, token_account, held + 1),
            Some(INSUFFICIENT_FUNDS),
        ),
        (unsigned, None),
    ] {
        let error = run(&within, &instruction, &mut accounts).unwrap_err();
        assert!(refusal.is_none_or(|code| error == code), "{error}");
        assert_eq!(accounts, before);
    }
    assert!(held < REMAINING);

    // Two members draw down the same allowance.
    run(
        &within,
        &spend(first, destination, token_account, 100_000),
        &mut accounts,
    )
    .unwrap();
    run(
        &within,
        &spend(second, destination, token_account, 200_000),
        &mut accounts,
    )
    .unwrap();
    assert_eq!(remaining(&accounts), REMAINING - 300_000);
    assert_eq!(last_reset(&accounts), start);
    assert_eq!(balance(&accounts, token_account), 300_000);

    // Harness funding makes the limit, not the vault balance, the binding constraint below.
    let vault_tokens = accounts
        .iter_mut()
        .find(|(address, _)| *address == key("vault_token_account"))
        .unwrap();
    let mut funded = TokenAccount::unpack(&vault_tokens.1.data).unwrap();
    funded.amount = 40_000_000_000;
    TokenAccount::pack(funded, &mut vault_tokens.1.data).unwrap();
    let before = accounts.clone();
    assert_eq!(
        run(
            &within,
            &spend(first, destination, token_account, REMAINING - 300_000 + 1),
            &mut accounts
        ),
        Err(LIMIT_EXCEEDED.into())
    );
    assert_eq!(accounts, before);

    // One second later the full amount is available again and the period advances.
    let after = vm(start + MONTH + 1);
    run(
        &after,
        &spend(first, destination, token_account, REMAINING),
        &mut accounts,
    )
    .unwrap();
    assert_eq!(remaining(&accounts), 30_000_000_000 - REMAINING);
    assert_eq!(last_reset(&accounts), start + MONTH);
    assert_eq!(
        run(
            &after,
            &spend(
                second,
                destination,
                token_account,
                30_000_000_000 - REMAINING + 1
            ),
            &mut accounts
        ),
        Err(LIMIT_EXCEEDED.into())
    );
}

#[test]
fn controller_removal_executes_and_agrees_with_the_declared_diff() {
    let mut accounts = observed();
    let before = state(&accounts);
    let grants = compile_state(&SpendingLimitAdapter, &before, &context()).unwrap();
    let removal = actions(&SpendingLimitAdapter, &grants[0], &before, &context()).unwrap();
    let [action] = removal.as_slice() else {
        panic!("one removal");
    };
    assert_eq!(action.kind, ActionKind::Revoke);
    assert_eq!(
        action.instructions[0].data[..8],
        Sha256::digest(b"global:multisig_remove_spending_limit")[..8]
    );
    assert_eq!(
        actions(&SpendingLimitAdapter, &grants[1], &before, &context()).unwrap_err(),
        Error::UnsupportedOperation
    );

    // A spending member who is not the controller cannot remove the limit.
    let vm = vm(last_reset(&accounts));
    let outsider = members()[0];
    assert_ne!(outsider, key("config_authority"));
    let mut forged = action.instructions[0].clone();
    forged.accounts[1].pubkey = outsider;
    forged.accounts[3].pubkey = outsider;
    let untouched = accounts.clone();
    assert!(run(&vm, &forged, &mut accounts).is_err());
    assert_eq!(accounts, untouched);

    run(&vm, &action.instructions[0], &mut accounts).unwrap();
    let after = state(&accounts);
    assert_eq!(after.account.lamports, 0);
    let changes = verify_transaction_diff(
        &SpendingLimitAdapter,
        &action.instructions,
        &before,
        &context(),
        &after,
        &context(),
    )
    .unwrap();
    assert_eq!(changes.len(), 2);
    // The vault can no longer be drawn through the closed limit.
    let token_account = key("destination_token_account");
    assert!(run(
        &vm,
        &spend(outsider, key("destination"), token_account, 1),
        &mut accounts
    )
    .is_err());
}

// Anchor's refusals for an undecodable account and for seeds that do not derive the address.
const DID_NOT_DESERIALIZE: &str = "Custom(3003)";
const CONSTRAINT_SEEDS: &str = "Custom(2006)";

fn multisig(accounts: &mut [(Pubkey, Account)]) -> &mut Vec<u8> {
    &mut accounts
        .iter_mut()
        .find(|(address, _)| *address == key("multisig"))
        .unwrap()
        .1
        .data
}

#[test]
fn a_parent_the_program_rejects_never_compiles_to_authority() {
    // Offsets: create key at 8, rent collector tag at 94, bump at 127, member count at 128.
    type Mutation = fn(&mut Vec<u8>);
    let cases: [(Mutation, &str); 6] = [
        (|data| data.truncate(72), DID_NOT_DESERIALIZE),
        (|data| data.truncate(128), DID_NOT_DESERIALIZE),
        (|data| data.truncate(230), DID_NOT_DESERIALIZE),
        (
            |data| data[128..132].copy_from_slice(&u32::MAX.to_le_bytes()),
            DID_NOT_DESERIALIZE,
        ),
        (|data| data[8] ^= 1, CONSTRAINT_SEEDS),
        (|data| data[127] ^= 1, CONSTRAINT_SEEDS),
    ];
    for (index, (mutate, refusal)) in cases.into_iter().enumerate() {
        let mut accounts = observed();
        let reset = last_reset(&accounts);
        mutate(multisig(&mut accounts));
        let instruction = spend(
            members()[0],
            key("destination"),
            key("destination_token_account"),
            1,
        );
        assert_eq!(
            run(&vm(reset), &instruction, &mut accounts),
            Err(refusal.into()),
            "{index}"
        );
        assert!(
            matches!(
                compile_state(&SpendingLimitAdapter, &state(&accounts), &context()),
                Err(Error::InvalidState(_))
            ),
            "{index}"
        );
    }
    // Bytes after the members are stale allocation the program ignores.
    let mut accounts = observed();
    let reset = last_reset(&accounts);
    assert!(multisig(&mut accounts)[231..].iter().any(|byte| *byte != 0));
    multisig(&mut accounts)[231..].fill(0xff);
    let instruction = spend(
        members()[0],
        key("destination"),
        key("destination_token_account"),
        1,
    );
    run(&vm(reset), &instruction, &mut accounts).unwrap();
    compile_state(&SpendingLimitAdapter, &state(&accounts), &context()).unwrap();
}

#[test]
fn unrepresented_or_malformed_state_fails_closed() {
    let accounts = observed();
    let compile = |state: &State, context: &Context| {
        compile_state(&SpendingLimitAdapter, state, context).unwrap_err()
    };
    // Another limit's parent is not evidence for this one.
    let mut reparented = state(&accounts);
    reparented.account.data[8] ^= 1;
    assert!(matches!(
        compile(&reparented, &context()),
        Error::InvalidState(_)
    ));
    let mut autonomous = state(&accounts);
    autonomous.multisig.data[40..72].fill(0);
    assert_eq!(
        compile(&autonomous, &context()),
        Error::UnsupportedOperation
    );
    let mut lamports = state(&accounts);
    lamports.account.data[73..105].fill(0);
    assert_eq!(compile(&lamports, &context()), Error::UnsupportedOperation);

    let mutations: [fn(&mut State); 8] = [
        |state| state.account.data.push(0),
        |state| state.account.data.truncate(266),
        |state| state.account.data[0] ^= 1,
        |state| state.account.owner = Pubkey::default(),
        |state| state.address = Pubkey::new_unique(),
        |state| state.account.data[113] = 4,
        |state| state.account.data[114..122].copy_from_slice(&u64::MAX.to_le_bytes()),
        |state| state.multisig.data[0] ^= 1,
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut state = state(&accounts);
        mutate(&mut state);
        assert!(
            matches!(compile(&state, &context()), Error::InvalidState(_)),
            "{index}"
        );
    }
    let mut unknown = context();
    unknown.native.program_version = "sha256:other".into();
    assert_eq!(
        compile(&state(&accounts), &unknown),
        Error::UnsupportedVersion
    );
    let mut unevidenced = context();
    unevidenced.evidence.references.clear();
    assert_eq!(
        compile(&state(&accounts), &unevidenced),
        Error::InsufficientEvidence
    );
}
