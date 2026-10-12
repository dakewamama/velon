use arm::{AuthorizationChange, EvidenceBundle, NativeContext, Principal};
use catalyst_sdk::{self as sdk, spl::AuthorityState, token2022::*, Adapter, Context, Error};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::token2022;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_2022_interface::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    instruction,
    state::{Account as TokenAccount, Mint},
};

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn svm() -> Mollusk {
    let mut svm = Mollusk::default();
    token2022::add_program(&mut svm);
    svm
}

fn context() -> Context {
    Context {
        program_id: token2022::ID,
        native: NativeContext {
            protocol: "token-2022".into(),
            deployment: DEPLOYMENT.into(),
            program_version: PROGRAM_VERSION.into(),
            adapter_version: "0.1".into(),
        },
        evidence: EvidenceBundle {
            references: vec![
                "fixture:token2022-account.bin".into(),
                "fixture:token2022-mint.bin".into(),
                "fixture:token2022:authority-accounts".into(),
            ],
            observed_at: "fixture:slot:1".into(),
        },
    }
}

fn native_fixture() -> State {
    let mint = key(3);
    let address = key(1);
    let size =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::PermanentDelegate])
            .unwrap();
    let mint_account = Account {
        lamports: 10_000_000,
        owner: token2022::ID,
        data: vec![0; size],
        ..Account::default()
    };
    let token_account = Account {
        lamports: 10_000_000,
        owner: token2022::ID,
        data: vec![0; TokenAccount::LEN],
        ..Account::default()
    };
    let instructions = vec![
        instruction::initialize_permanent_delegate(&token2022::ID, &mint, &key(7)).unwrap(),
        instruction::initialize_mint2(&token2022::ID, &mint, &key(5), None, 6).unwrap(),
        instruction::initialize_account3(&token2022::ID, &address, &mint, &key(4)).unwrap(),
        instruction::mint_to(&token2022::ID, &mint, &address, &key(5), &[], 100).unwrap(),
        instruction::approve(&token2022::ID, &address, &key(2), &key(4), &[], 25).unwrap(),
    ];
    let result = svm().process_instruction_chain(
        &instructions,
        &[
            (mint, mint_account),
            (address, token_account),
            (key(5), Account::default()),
            (key(4), Account::default()),
            (key(2), Account::default()),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    let account = |key| {
        result
            .resulting_accounts
            .iter()
            .find(|(address, _)| *address == key)
            .unwrap()
            .1
            .clone()
    };
    State {
        source: AuthorityState {
            address,
            account: account(address),
            authorities: [2, 4, 7]
                .into_iter()
                .map(|i| (key(i), Account::default()))
                .collect(),
        },
        mint: (mint, account(mint)),
    }
}

#[test]
fn native_initialization_reproduces_raw_goldens() {
    let state = native_fixture();
    assert_eq!(
        state.source.account.data,
        include_bytes!("fixtures/token2022-account.bin")
    );
    assert_eq!(
        state.mint.1.data,
        include_bytes!("fixtures/token2022-mint.bin")
    );
}

fn fixture() -> State {
    State {
        source: AuthorityState {
            address: key(1),
            account: Account {
                lamports: 10_000_000,
                owner: token2022::ID,
                data: include_bytes!("fixtures/token2022-account.bin").to_vec(),
                ..Account::default()
            },
            authorities: [2, 4, 7]
                .into_iter()
                .map(|i| (key(i), Account::default()))
                .collect(),
        },
        mint: (
            key(3),
            Account {
                lamports: 10_000_000,
                owner: token2022::ID,
                data: include_bytes!("fixtures/token2022-mint.bin").to_vec(),
                ..Account::default()
            },
        ),
    }
}

fn transfer(state: &State, signer: Pubkey, amount: u64) -> mollusk_svm::result::InstructionResult {
    let destination = key(8);
    let mut receiver = state.source.account.clone();
    let base = StateWithExtensions::<TokenAccount>::unpack(&receiver.data)
        .unwrap()
        .base;
    TokenAccount::pack(
        TokenAccount {
            amount: 0,
            delegate: COption::None,
            delegated_amount: 0,
            ..base
        },
        &mut receiver.data,
    )
    .unwrap();
    let ix = instruction::transfer_checked(
        &token2022::ID,
        &state.source.address,
        &state.mint.0,
        &destination,
        &signer,
        &[],
        amount,
        6,
    )
    .unwrap();
    svm().process_instruction(
        &ix,
        &[
            (state.source.address, state.source.account.clone()),
            (state.mint.0, state.mint.1.clone()),
            (destination, receiver),
            (signer, Account::default()),
        ],
    )
}

#[test]
fn exact_binary_and_native_state_match_semantic_golden() {
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(token2022::ELF)),
        PROGRAM_VERSION
    );
    let state = fixture();
    let first = sdk::compile_state(&Token2022Adapter, &state, &context()).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/token2022.json")).unwrap();
    assert_eq!(serde_json::to_value(&first).unwrap(), expected);
    assert_eq!(
        first,
        sdk::compile_state(&Token2022Adapter, &state, &context()).unwrap()
    );
    assert_eq!(
        Token2022Adapter.source_requirements(&state).accounts,
        vec![key(1), key(3), key(4), key(2), key(7)]
    );
}

#[test]
fn ordinary_delegate_budget_is_consumed_but_permanent_delegate_bypasses_it() {
    let state = fixture();
    let failed = transfer(&state, key(2), 26);
    assert!(failed.raw_result.is_err());
    assert_eq!(
        failed.resulting_accounts[0].1.data,
        state.source.account.data
    );
    let consumed = transfer(&state, key(2), 25);
    assert_eq!(consumed.raw_result, Ok(()));
    let base = StateWithExtensions::<TokenAccount>::unpack(&consumed.resulting_accounts[0].1.data)
        .unwrap()
        .base;
    assert_eq!(base.amount, 75);
    assert_eq!(base.delegate, COption::None);
    assert_eq!(base.delegated_amount, 0);
    let permanent = transfer(&state, key(7), 26);
    assert_eq!(permanent.raw_result, Ok(()));
    let base = StateWithExtensions::<TokenAccount>::unpack(&permanent.resulting_accounts[0].1.data)
        .unwrap()
        .base;
    assert_eq!(base.amount, 74);
    assert_eq!(base.delegate, COption::Some(key(2)));
    assert_eq!(base.delegated_amount, 25);
    let failed = transfer(&state, key(7), 101);
    assert!(failed.raw_result.is_err());
    assert_eq!(
        failed.resulting_accounts[0].1.data,
        state.source.account.data
    );
}

#[test]
fn owner_and_delegate_can_each_revoke_only_the_ordinary_delegation() {
    let state = fixture();
    let before = sdk::compile_state(&Token2022Adapter, &state, &context()).unwrap();
    let actions = sdk::actions(&Token2022Adapter, &before[0], &state, &context()).unwrap();
    assert_eq!(actions.len(), 2);
    for action in actions {
        let changes =
            sdk::diff_transaction(&Token2022Adapter, &action.instructions, &state, &context())
                .unwrap();
        assert_eq!(
            changes,
            vec![AuthorizationChange::Removed {
                authorization: Box::new(before[0].clone())
            }]
        );
        let mut accounts = vec![(state.source.address, state.source.account.clone())];
        accounts.extend(state.source.authorities.clone());
        let result = svm().process_instruction(&action.instructions[0], &accounts);
        assert_eq!(result.raw_result, Ok(()));
        let mut observed = fixture();
        observed.source.account = result.resulting_accounts[0].1.clone();
        let mut observed_context = context();
        observed_context.evidence.observed_at = "fixture:slot:2".into();
        observed_context.evidence.references = vec!["fixture:token2022-revoke:result".into()];
        assert_eq!(
            sdk::verify_transaction_diff(
                &Token2022Adapter,
                &action.instructions,
                &state,
                &context(),
                &observed,
                &observed_context
            ),
            Ok(changes)
        );
        let mut after =
            sdk::compile_state(&Token2022Adapter, &observed, &observed_context).unwrap();
        assert_eq!(after.len(), 1);
        after[0].evidence = context().evidence;
        assert_eq!(after, vec![before[1].clone()]);
        let transfer = transfer(&observed, key(7), 26);
        assert_eq!(transfer.raw_result, Ok(()));
    }
    assert_eq!(
        sdk::actions(&Token2022Adapter, &before[1], &state, &context()),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn same_principal_permanent_authority_must_not_be_misreported_as_a_cumulative_budget() {
    let mut state = fixture();
    let approve = instruction::approve(
        &token2022::ID,
        &state.source.address,
        &key(7),
        &key(4),
        &[],
        25,
    )
    .unwrap();
    let result = svm().process_instruction(
        &approve,
        &[
            (key(1), state.source.account.clone()),
            (key(7), Account::default()),
            (key(4), Account::default()),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    state.source.account = result.resulting_accounts[0].1.clone();
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    let transferred = transfer(&state, key(7), 26);
    assert_eq!(transferred.raw_result, Ok(()));
    let base =
        StateWithExtensions::<TokenAccount>::unpack(&transferred.resulting_accounts[0].1.data)
            .unwrap()
            .base;
    assert_eq!(base.delegated_amount, 25);
    assert_eq!(base.delegate, COption::Some(key(7)));
}

#[test]
fn permanently_cleared_mint_delegate_is_absent_without_removing_ordinary_authority() {
    let mut state = fixture();
    let ix = instruction::set_authority(
        &token2022::ID,
        &state.mint.0,
        None,
        instruction::AuthorityType::PermanentDelegate,
        &key(7),
        &[],
    )
    .unwrap();
    let result = svm().process_instruction(
        &ix,
        &[
            (state.mint.0, state.mint.1.clone()),
            (key(7), Account::default()),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    state.mint.1 = result.resulting_accounts[0].1.clone();
    let projection = sdk::compile_state(&Token2022Adapter, &state, &context()).unwrap();
    assert_eq!(projection.len(), 1);
    assert_eq!(
        projection[0].principal,
        Principal::Identity(key(2).to_string())
    );
    let failed = transfer(&state, key(7), 26);
    assert!(failed.raw_result.is_err());
    assert_eq!(
        failed.resulting_accounts[0].1.data,
        state.source.account.data
    );
}

#[test]
fn malformed_extension_cannot_be_treated_as_absent() {
    let mut state = fixture();
    let length_offset = TokenAccount::LEN + 3;
    state.mint.1.data.truncate(length_offset + 2);
    state.mint.1.data[length_offset..length_offset + 2].fill(0);
    let decoded = StateWithExtensions::<Mint>::unpack(&state.mint.1.data).unwrap();
    assert_eq!(
        decoded.get_extension_types().unwrap(),
        vec![ExtensionType::PermanentDelegate]
    );
    assert!(decoded.get_extension::<spl_token_2022_interface::extension::permanent_delegate::PermanentDelegate>().is_err());
    assert!(matches!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut state = fixture();
    state.mint.1.data[TokenAccount::LEN + 1..TokenAccount::LEN + 3].fill(255);
    assert!(matches!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
}

#[test]
fn recognized_but_unreviewed_extensions_are_unsupported() {
    use spl_token_2022_interface::extension::{
        immutable_owner::ImmutableOwner, mint_close_authority::MintCloseAuthority,
        BaseStateWithExtensionsMut, StateWithExtensionsMut,
    };
    let mut state = fixture();
    let base = StateWithExtensions::<TokenAccount>::unpack(&state.source.account.data)
        .unwrap()
        .base;
    let size =
        ExtensionType::try_calculate_account_len::<TokenAccount>(&[ExtensionType::ImmutableOwner])
            .unwrap();
    state.source.account.data = vec![0; size];
    let mut decoded = StateWithExtensionsMut::<TokenAccount>::unpack_uninitialized(
        &mut state.source.account.data,
    )
    .unwrap();
    decoded.init_extension::<ImmutableOwner>(false).unwrap();
    decoded.base = base;
    decoded.pack_base();
    decoded.init_account_type().unwrap();
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    let mut state = fixture();
    let base = StateWithExtensions::<Mint>::unpack(&state.mint.1.data)
        .unwrap()
        .base;
    let size =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::MintCloseAuthority])
            .unwrap();
    state.mint.1.data = vec![0; size];
    let mut decoded =
        StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut state.mint.1.data).unwrap();
    decoded.init_extension::<MintCloseAuthority>(false).unwrap();
    decoded.base = base;
    decoded.pack_base();
    decoded.init_account_type().unwrap();
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn missing_mismatched_and_unsupported_evidence_fails_closed() {
    let mut state = fixture();
    state.mint.1.data.clear();
    assert_eq!(
        Token2022Adapter.source_requirements(&state).accounts,
        vec![key(1), key(3), key(4), key(2)]
    );
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    let mut state = fixture();
    state.mint.0 = key(9);
    assert!(matches!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut state = fixture();
    state.mint.1.owner = Pubkey::default();
    assert!(matches!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut state = fixture();
    state.source.account.owner = Pubkey::default();
    assert!(matches!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut state = fixture();
    state
        .source
        .authorities
        .retain(|(key, _)| *key != self::key(7));
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    let mut state = fixture();
    state.source.authorities[0].1.owner = token2022::ID;
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    let mut state = fixture();
    state.source.account.data.clear();
    let mut unknown = context();
    unknown.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &unknown),
        Err(Error::UnsupportedVersion)
    );
    unknown = context();
    unknown.evidence.references.clear();
    assert_eq!(
        sdk::compile_state(&Token2022Adapter, &state, &unknown),
        Err(Error::InsufficientEvidence)
    );
}

#[test]
fn frozen_account_blocks_delegate_spend_and_revoke_without_suspending_the_mint_wide_grant() {
    let mut state = fixture();
    let mut base = StateWithExtensions::<TokenAccount>::unpack(&state.source.account.data)
        .unwrap()
        .base;
    base.state = spl_token_2022_interface::state::AccountState::Frozen;
    TokenAccount::pack(base, &mut state.source.account.data).unwrap();
    let projection = sdk::compile_state(&Token2022Adapter, &state, &context()).unwrap();
    assert_eq!(
        projection[0].availability_at(0).unwrap(),
        arm::Availability::Inactive
    );
    assert_eq!(
        projection[1].lifecycle,
        arm::Lifecycle::Active {
            valid_from: None,
            valid_until: None
        }
    );
    assert_eq!(
        sdk::actions(&Token2022Adapter, &projection[0], &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    for signer in [key(2), key(4)] {
        let revoke =
            instruction::revoke(&token2022::ID, &state.source.address, &signer, &[]).unwrap();
        let result = svm().process_instruction(
            &revoke,
            &[
                (state.source.address, state.source.account.clone()),
                (signer, Account::default()),
            ],
        );
        assert!(result.raw_result.is_err());
        assert_eq!(
            result.resulting_accounts[0].1.data,
            state.source.account.data
        );
    }
    let failed = transfer(&state, key(7), 26);
    assert!(failed.raw_result.is_err());
    assert_eq!(
        failed.resulting_accounts[0].1.data,
        state.source.account.data
    );
}

#[test]
fn unsigned_wrong_controller_and_noncanonical_revokes_fail_closed() {
    let state = fixture();
    let mut authorization = sdk::compile_state(&Token2022Adapter, &state, &context())
        .unwrap()
        .remove(0);
    for wrong in [false, true] {
        let signer = if wrong { key(9) } else { key(4) };
        let mut revoke =
            instruction::revoke(&token2022::ID, &state.source.address, &signer, &[]).unwrap();
        revoke.accounts[1].is_signer = wrong;
        assert_eq!(
            sdk::diff_transaction(&Token2022Adapter, &[revoke.clone()], &state, &context()),
            Err(Error::UnsupportedOperation)
        );
        let result = svm().process_instruction(
            &revoke,
            &[
                (state.source.address, state.source.account.clone()),
                (signer, Account::default()),
            ],
        );
        assert!(result.raw_result.is_err());
        assert_eq!(
            result.resulting_accounts[0].1.data,
            state.source.account.data
        );
    }
    let mut revoke =
        instruction::revoke(&token2022::ID, &state.source.address, &key(4), &[]).unwrap();
    revoke.program_id = Pubkey::default();
    assert_eq!(
        sdk::diff_transaction(&Token2022Adapter, &[revoke], &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    assert_eq!(
        sdk::diff_transaction(&Token2022Adapter, &[], &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    authorization.principal = Principal::Identity("fabricated".into());
    assert_eq!(
        sdk::actions(&Token2022Adapter, &authorization, &state, &context()),
        Err(Error::InvalidProjection)
    );
}
