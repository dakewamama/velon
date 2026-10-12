use arm::{AuthorizationChange, Availability, EvidenceBundle, NativeContext, Principal};
use catalyst_sdk::{self as sdk, spl::*, ActionKind, Adapter, Context, Error};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::token;
use solana_account::Account;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface::{
    instruction,
    state::{Account as TokenAccount, AccountState},
};

fn context() -> Context {
    Context {
        program_id: token::ID,
        native: NativeContext {
            protocol: "spl-token".into(),
            deployment: DEPLOYMENT.into(),
            program_version: PROGRAM_VERSION.into(),
            adapter_version: "0.1".into(),
        },
        evidence: EvidenceBundle {
            references: vec![
                "fixture:spl-close.bin".into(),
                "fixture:spl-close:authority-accounts".into(),
            ],
            observed_at: "fixture:slot:1".into(),
        },
    }
}

fn fixture() -> AuthorityState {
    AuthorityState {
        address: Pubkey::new_from_array([1; 32]),
        account: Account {
            lamports: 10_000_000,
            data: include_bytes!("fixtures/spl-close.bin").to_vec(),
            owner: token::ID,
            ..Account::default()
        },
        authorities: [4, 7]
            .into_iter()
            .map(|key| (Pubkey::new_from_array([key; 32]), Account::default()))
            .collect(),
    }
}

fn svm() -> Mollusk {
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk
}

#[test]
fn golden_close_authority_is_exact_and_reproduced_natively() {
    let mut state = fixture();
    let projection = sdk::compile_state(&CloseAdapter, &state, &context()).unwrap();
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/spl-close.json")).unwrap();
    assert_eq!(serde_json::to_value(&projection).unwrap(), golden);
    assert_eq!(
        CloseAdapter.source_requirements(&state).accounts,
        vec![
            state.address,
            state.authorities[1].0,
            state.authorities[0].0
        ]
    );
    assert_eq!(
        projection[0].availability_at(0).unwrap(),
        Availability::Conditional
    );
    let mut native = TokenAccount::unpack(&state.account.data).unwrap();
    native.close_authority = COption::None;
    TokenAccount::pack(native, &mut state.account.data).unwrap();
    let ix = instruction::set_authority(
        &token::ID,
        &state.address,
        Some(&state.authorities[1].0),
        instruction::AuthorityType::CloseAccount,
        &native.owner,
        &[],
    )
    .unwrap();
    let result = svm().process_instruction(
        &ix,
        &[(state.address, state.account), state.authorities[0].clone()],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        result.resulting_accounts[0].1.data,
        include_bytes!("fixtures/spl-close.bin")
    );
}

#[test]
fn clearing_explicit_close_authority_changes_principal_instead_of_removing_power() {
    let mut state = fixture();
    let before_state = fixture();
    let before = sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .remove(0);
    let action = sdk::actions(&CloseAdapter, &before, &state, &context())
        .unwrap()
        .remove(0);
    assert_eq!(action.kind, ActionKind::ResetAuthority);
    let changes =
        sdk::diff_transaction(&CloseAdapter, &action.instructions, &state, &context()).unwrap();
    let mut accounts = vec![(state.address, state.account.clone())];
    accounts.extend(state.authorities.clone());
    let result = svm().process_instruction(&action.instructions[0], &accounts);
    assert_eq!(result.raw_result, Ok(()));
    state.account = result.resulting_accounts[0].1.clone();
    assert_eq!(
        TokenAccount::unpack(&state.account.data)
            .unwrap()
            .close_authority,
        COption::None
    );
    let mut observed = context();
    observed.evidence.observed_at = "fixture:slot:2".into();
    observed.evidence.references = vec!["fixture:close-reset:result".into()];
    assert_eq!(
        sdk::verify_transaction_diff(
            &CloseAdapter,
            &action.instructions,
            &before_state,
            &context(),
            &state,
            &observed
        ),
        Ok(changes.clone())
    );
    let mut after = sdk::compile_state(&CloseAdapter, &state, &observed)
        .unwrap()
        .remove(0);
    assert_eq!(
        after.principal,
        Principal::Identity(state.authorities[0].0.to_string())
    );
    after.evidence = context().evidence;
    assert_eq!(
        changes,
        vec![AuthorizationChange::Changed {
            before: Box::new(before),
            after: Box::new(after.clone())
        }]
    );
    assert!(sdk::actions(&CloseAdapter, &after, &state, &context())
        .unwrap()
        .is_empty());
    let beneficiary = Pubkey::new_from_array([8; 32]);
    for signer in [state.authorities[1].0, state.authorities[0].0] {
        let ix = instruction::close_account(&token::ID, &state.address, &beneficiary, &signer, &[])
            .unwrap();
        let result = svm().process_instruction(
            &ix,
            &[
                (state.address, state.account.clone()),
                (beneficiary, Account::default()),
                (signer, Account::default()),
            ],
        );
        assert_eq!(result.raw_result.is_ok(), signer == state.authorities[0].0);
        if signer == state.authorities[1].0 {
            assert_eq!(result.resulting_accounts[0].1.data, state.account.data);
        }
    }
}

#[test]
fn same_owner_reset_has_no_current_semantic_change() {
    let mut state = fixture();
    let mut native = TokenAccount::unpack(&state.account.data).unwrap();
    native.close_authority = COption::Some(native.owner);
    TokenAccount::pack(native, &mut state.account.data).unwrap();
    let before = sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .remove(0);
    let action = sdk::actions(&CloseAdapter, &before, &state, &context())
        .unwrap()
        .remove(0);
    assert!(
        sdk::diff_transaction(&CloseAdapter, &action.instructions, &state, &context())
            .unwrap()
            .is_empty()
    );
    let result = svm().process_instruction(
        &action.instructions[0],
        &[
            (state.address, state.account.clone()),
            state.authorities[0].clone(),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    state.account = result.resulting_accounts[0].1.clone();
    assert_eq!(
        sdk::compile_state(&CloseAdapter, &state, &context()).unwrap(),
        vec![before]
    );
}

#[test]
fn native_close_returns_lamports_and_recompiles_to_no_authority_even_when_frozen() {
    for frozen in [false, true] {
        let mut state = fixture();
        if frozen {
            let mut native = TokenAccount::unpack(&state.account.data).unwrap();
            native.state = AccountState::Frozen;
            TokenAccount::pack(native, &mut state.account.data).unwrap();
        }
        let before = sdk::compile_state(&CloseAdapter, &state, &context())
            .unwrap()
            .remove(0);
        assert_eq!(
            before.availability_at(0).unwrap(),
            Availability::Conditional
        );
        if frozen {
            assert_eq!(
                sdk::actions(&CloseAdapter, &before, &state, &context()),
                Err(Error::UnsupportedOperation)
            );
        }
        let destination = Pubkey::new_from_array([8; 32]);
        let ix = instruction::close_account(
            &token::ID,
            &state.address,
            &destination,
            &state.authorities[1].0,
            &[],
        )
        .unwrap();
        let result = svm().process_instruction(
            &ix,
            &[
                (state.address, state.account.clone()),
                (
                    destination,
                    Account {
                        lamports: 50,
                        ..Account::default()
                    },
                ),
                state.authorities[1].clone(),
            ],
        );
        assert_eq!(result.raw_result, Ok(()));
        assert_eq!(
            result.resulting_accounts[1].1.lamports,
            state.account.lamports + 50
        );
        state.account = result.resulting_accounts[0].1.clone();
        assert_eq!(state.account, Account::default());
        let mut observed = context();
        observed.evidence.observed_at = "fixture:slot:2".into();
        observed.evidence.references = vec!["fixture:native-close:result".into()];
        assert!(sdk::compile_state(&CloseAdapter, &state, &observed)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn native_close_validates_balance_signer_controller_and_destination() {
    for failure in 0..4 {
        let mut state = fixture();
        if failure == 0 {
            let mut native = TokenAccount::unpack(&state.account.data).unwrap();
            native.amount = 1;
            TokenAccount::pack(native, &mut state.account.data).unwrap();
        }
        let signer = if failure == 2 {
            state.authorities[0].0
        } else {
            state.authorities[1].0
        };
        let destination = if failure == 3 {
            state.address
        } else {
            Pubkey::new_from_array([8; 32])
        };
        let mut ix =
            instruction::close_account(&token::ID, &state.address, &destination, &signer, &[])
                .unwrap();
        if failure == 1 {
            ix.accounts[2].is_signer = false;
        }
        let mut accounts = vec![
            (state.address, state.account.clone()),
            (signer, Account::default()),
        ];
        if destination != state.address {
            accounts.push((destination, Account::default()));
        }
        let result = svm().process_instruction(&ix, &accounts);
        assert!(result.raw_result.is_err());
        assert_eq!(result.resulting_accounts[0].1, state.account);
    }
}

#[test]
fn native_wrapped_sol_can_close_with_nonzero_balance() {
    let mut state = fixture();
    state.account.data.fill(0);
    let mint = spl_token_interface::native_mint::id();
    let initialize = instruction::initialize_account3(
        &token::ID,
        &state.address,
        &mint,
        &state.authorities[0].0,
    )
    .unwrap();
    let result = svm().process_instruction(
        &initialize,
        &[(state.address, state.account), (mint, Account::default())],
    );
    assert_eq!(result.raw_result, Ok(()));
    state.account = result.resulting_accounts[0].1.clone();
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    assert!(native.is_native());
    assert!(native.amount > 0);
    let authority = sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .remove(0);
    assert_eq!(
        authority.principal,
        Principal::Identity(state.authorities[0].0.to_string())
    );
    let beneficiary = Pubkey::new_from_array([8; 32]);
    let close =
        instruction::close_account(&token::ID, &state.address, &beneficiary, &native.owner, &[])
            .unwrap();
    let result = svm().process_instruction(
        &close,
        &[
            (state.address, state.account.clone()),
            (beneficiary, Account::default()),
            state.authorities[0].clone(),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        result.resulting_accounts[1].1.lamports,
        state.account.lamports
    );
    state.account = result.resulting_accounts[0].1.clone();
    assert!(sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .is_empty());
}

#[test]
fn reset_requires_evidence_for_the_fallback_owner() {
    let mut state = fixture();
    state.authorities.remove(0);
    let before = sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .remove(0);
    assert_eq!(
        sdk::actions(&CloseAdapter, &before, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    let ix = instruction::set_authority(
        &token::ID,
        &state.address,
        None,
        instruction::AuthorityType::CloseAccount,
        &state.authorities[0].0,
        &[],
    )
    .unwrap();
    assert_eq!(
        sdk::diff_transaction(&CloseAdapter, &[ix], &state, &context()),
        Err(Error::InsufficientEvidence)
    );
}

#[test]
fn missing_or_unsupported_controller_and_unknown_versions_fail_closed() {
    let mut state = fixture();
    state.authorities.clear();
    assert_eq!(
        sdk::compile_state(&CloseAdapter, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    state = fixture();
    state.authorities[1].1.owner = token::ID;
    assert_eq!(
        sdk::compile_state(&CloseAdapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    state = fixture();
    state.authorities.push(state.authorities[1].clone());
    assert!(matches!(
        sdk::compile_state(&CloseAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    state = fixture();
    let mut native = TokenAccount::unpack(&state.account.data).unwrap();
    native.owner = Pubkey::default();
    TokenAccount::pack(native, &mut state.account.data).unwrap();
    assert_eq!(
        sdk::compile_state(&CloseAdapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    state.account.data.clear();
    assert!(matches!(
        sdk::compile_state(&CloseAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut unknown = context();
    unknown.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&CloseAdapter, &state, &unknown),
        Err(Error::UnsupportedVersion)
    );
}

#[test]
fn reset_diff_rejects_noncanonical_instruction_and_fabricated_authorization() {
    let state = fixture();
    let mut authorization = sdk::compile_state(&CloseAdapter, &state, &context())
        .unwrap()
        .remove(0);
    let ix = sdk::actions(&CloseAdapter, &authorization, &state, &context())
        .unwrap()
        .remove(0)
        .instructions
        .remove(0);
    for change in 0..4 {
        let mut changed = ix.clone();
        match change {
            0 => changed.accounts[1].is_signer = false,
            1 => changed.program_id = Pubkey::default(),
            2 => changed.accounts[0].pubkey = Pubkey::default(),
            _ => changed.data.push(0),
        }
        assert_eq!(
            sdk::diff_transaction(&CloseAdapter, &[changed], &state, &context()),
            Err(Error::UnsupportedOperation)
        );
    }
    authorization.principal = Principal::Identity("fabricated".into());
    assert_eq!(
        sdk::actions(&CloseAdapter, &authorization, &state, &context()),
        Err(Error::InvalidProjection)
    );
}
