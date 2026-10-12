use arm::{
    AuthorityKind, AuthorizationChange, Availability, Capability, EvidenceBundle, NativeContext,
};
use catalyst_sdk::{self as sdk, spl::*, Adapter, Context, Error};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::token;
use solana_account::Account;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface::{
    instruction,
    state::{Account as TokenAccount, Mint},
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
                "fixture:spl-mint.bin".into(),
                "fixture:spl-mint:authority-accounts".into(),
            ],
            observed_at: "fixture:slot:1".into(),
        },
    }
}

fn fixture() -> AuthorityState {
    AuthorityState {
        address: Pubkey::new_from_array([3; 32]),
        account: Account {
            lamports: 10_000_000,
            data: include_bytes!("fixtures/spl-mint.bin").to_vec(),
            owner: token::ID,
            ..Account::default()
        },
        authorities: [5, 6]
            .into_iter()
            .map(|key| (Pubkey::new_from_array([key; 32]), Account::default()))
            .collect(),
    }
}

fn recipient() -> (Pubkey, Account) {
    (
        Pubkey::new_from_array([1; 32]),
        Account {
            lamports: 10_000_000,
            data: include_bytes!("fixtures/spl-delegate.bin").to_vec(),
            owner: token::ID,
            ..Account::default()
        },
    )
}

#[test]
fn mint_raw_fixture_matches_exact_golden_and_requirements() {
    let state = fixture();
    let projection = sdk::compile_state(&MintAdapter, &state, &context()).unwrap();
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/spl-mint.json")).unwrap();
    assert_eq!(serde_json::to_value(&projection).unwrap(), golden);
    assert!(projection
        .iter()
        .all(|authority| authority.authority_kind == AuthorityKind::Direct));
    assert_eq!(
        projection,
        sdk::compile_state(&MintAdapter, &state, &context()).unwrap()
    );
    assert_eq!(
        MintAdapter.source_requirements(&state).accounts,
        vec![
            state.address,
            state.authorities[0].0,
            state.authorities[1].0
        ]
    );
}

#[test]
fn native_mint_to_increases_supply_and_recipient_amount() {
    let state = fixture();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let (key, account) = recipient();
    let ix = instruction::mint_to(
        &token::ID,
        &state.address,
        &key,
        &state.authorities[0].0,
        &[],
        7,
    )
    .unwrap();
    let result = mollusk.process_instruction(
        &ix,
        &[
            (state.address, state.account),
            (key, account),
            state.authorities[0].clone(),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        Mint::unpack(&result.resulting_accounts[0].1.data)
            .unwrap()
            .supply,
        107
    );
    assert_eq!(
        TokenAccount::unpack(&result.resulting_accounts[1].1.data)
            .unwrap()
            .amount,
        107
    );
}

#[test]
fn native_initialize_and_mint_to_reproduce_golden_bytes() {
    let mut state = fixture();
    state.account.data.fill(0);
    let (key, mut recipient) = recipient();
    let mut native = TokenAccount::unpack(&recipient.data).unwrap();
    native.amount = 0;
    TokenAccount::pack(native, &mut recipient.data).unwrap();
    let initialize = instruction::initialize_mint2(
        &token::ID,
        &state.address,
        &state.authorities[0].0,
        Some(&state.authorities[1].0),
        6,
    )
    .unwrap();
    let mint = instruction::mint_to(
        &token::ID,
        &state.address,
        &key,
        &state.authorities[0].0,
        &[],
        100,
    )
    .unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let result = mollusk.process_instruction_chain(
        &[initialize, mint],
        &[
            (state.address, state.account),
            (key, recipient),
            state.authorities[0].clone(),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        result.resulting_accounts[0].1.data,
        include_bytes!("fixtures/spl-mint.bin")
    );
    assert_eq!(
        result.resulting_accounts[1].1.data,
        include_bytes!("fixtures/spl-delegate.bin")
    );
}

#[test]
fn native_authority_removal_rejects_bad_signatures_and_controllers() {
    let state = fixture();
    let before = sdk::compile_state(&MintAdapter, &state, &context()).unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    for authorization in &before {
        let canonical = sdk::actions(&MintAdapter, authorization, &state, &context())
            .unwrap()
            .remove(0)
            .instructions
            .remove(0);
        for wrong_controller in [false, true] {
            let mut ix = canonical.clone();
            let signer = if wrong_controller {
                Pubkey::new_from_array([9; 32])
            } else {
                ix.accounts[1].pubkey
            };
            ix.accounts[1].pubkey = signer;
            ix.accounts[1].is_signer = wrong_controller;
            let result = mollusk.process_instruction(
                &ix,
                &[
                    (state.address, state.account.clone()),
                    (signer, Account::default()),
                ],
            );
            assert!(result.raw_result.is_err());
            assert_eq!(result.resulting_accounts[0].1.data, state.account.data);
        }
    }
}

#[test]
fn native_freeze_and_thaw_change_delegate_availability() {
    let state = fixture();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let (key, mut account) = recipient();
    for freeze in [true, false] {
        let ix = if freeze {
            instruction::freeze_account(
                &token::ID,
                &key,
                &state.address,
                &state.authorities[1].0,
                &[],
            )
        } else {
            instruction::thaw_account(
                &token::ID,
                &key,
                &state.address,
                &state.authorities[1].0,
                &[],
            )
        }
        .unwrap();
        let result = mollusk.process_instruction(
            &ix,
            &[
                (key, account),
                (state.address, state.account.clone()),
                state.authorities[1].clone(),
            ],
        );
        assert_eq!(result.raw_result, Ok(()));
        account = result.resulting_accounts[0].1.clone();
        let observation = State {
            address: key,
            account: account.clone(),
            owner: Account::default(),
            delegate: Account::default(),
        };
        let authorization = sdk::compile_state(&DelegateAdapter, &observation, &context())
            .unwrap()
            .remove(0);
        assert_eq!(
            authorization.availability_at(0).unwrap(),
            if freeze {
                Availability::Inactive
            } else {
                Availability::Conditional
            }
        );
    }
}

#[test]
fn native_authority_removal_matches_diff_and_cannot_be_reversed() {
    for capability in [Capability::Mint, Capability::Freeze, Capability::Thaw] {
        let mut state = fixture();
        let before_state = fixture();
        let before = sdk::compile_state(&MintAdapter, &state, &context()).unwrap();
        let authorization = before.iter().find(|a| a.capability == capability).unwrap();
        let action = sdk::actions(&MintAdapter, authorization, &state, &context())
            .unwrap()
            .remove(0);
        let delta =
            sdk::diff_transaction(&MintAdapter, &action.instructions, &state, &context()).unwrap();
        let mut mollusk = Mollusk::default();
        token::add_program(&mut mollusk);
        let mut accounts = vec![(state.address, state.account.clone())];
        accounts.extend(state.authorities.clone());
        let result = mollusk.process_instruction(&action.instructions[0], &accounts);
        assert_eq!(result.raw_result, Ok(()));
        state.account = result.resulting_accounts[0].1.clone();
        let mut observed = context();
        observed.evidence.observed_at = "fixture:slot:2".into();
        observed.evidence.references = vec!["fixture:mint-authority-removal:result".into()];
        assert_eq!(
            sdk::verify_transaction_diff(
                &MintAdapter,
                &action.instructions,
                &before_state,
                &context(),
                &state,
                &observed
            ),
            Ok(delta.clone())
        );
        let after = sdk::compile_state(&MintAdapter, &state, &observed).unwrap();
        let removed: Vec<_> = before
            .iter()
            .filter(|a| !after.iter().any(|b| a.id == b.id))
            .cloned()
            .map(|authorization| AuthorizationChange::Removed {
                authorization: Box::new(authorization),
            })
            .collect();
        assert_eq!(delta, removed);
        let surviving: Vec<_> = before.iter().filter(|authorization| {
            !removed.iter().any(|change| matches!(change,
                AuthorizationChange::Removed { authorization: removed } if removed.id == authorization.id))
        }).cloned().collect();
        let normalized: Vec<_> = after
            .iter()
            .cloned()
            .map(|mut authorization| {
                authorization.evidence = context().evidence;
                authorization
            })
            .collect();
        assert_eq!(surviving, normalized);
        assert_eq!(
            after.len(),
            if capability == Capability::Mint { 2 } else { 1 }
        );
        assert_eq!(
            sdk::actions(&MintAdapter, authorization, &state, &context()),
            Err(Error::InvalidProjection)
        );
        let authority_type = if capability == Capability::Mint {
            instruction::AuthorityType::MintTokens
        } else {
            instruction::AuthorityType::FreezeAccount
        };
        let signer = if capability == Capability::Mint {
            state.authorities[0].0
        } else {
            state.authorities[1].0
        };
        let restore = instruction::set_authority(
            &token::ID,
            &state.address,
            Some(&signer),
            authority_type,
            &signer,
            &[],
        )
        .unwrap();
        accounts[0].1 = state.account.clone();
        let failed = mollusk.process_instruction(&restore, &accounts);
        assert!(failed.raw_result.is_err());
        assert_eq!(failed.resulting_accounts[0].1.data, state.account.data);
    }
}

#[test]
fn mint_authority_evidence_and_unknown_versions_fail_closed() {
    let mut state = fixture();
    state.authorities.clear();
    assert_eq!(
        sdk::compile_state(&MintAdapter, &state, &context()),
        Err(Error::InsufficientEvidence)
    );
    state = fixture();
    state.authorities.push(state.authorities[0].clone());
    assert!(matches!(
        sdk::compile_state(&MintAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    state = fixture();
    state.authorities[0].1.owner = token::ID;
    assert_eq!(
        sdk::compile_state(&MintAdapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    state.account.data.clear();
    assert!(matches!(
        sdk::compile_state(&MintAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
    let mut unknown = context();
    unknown.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&MintAdapter, &state, &unknown),
        Err(Error::UnsupportedVersion)
    );
}

#[test]
fn declared_diff_rejects_unsigned_foreign_and_noncanonical_changes() {
    let state = fixture();
    let before = sdk::compile_state(&MintAdapter, &state, &context()).unwrap();
    let ix = sdk::actions(&MintAdapter, &before[0], &state, &context())
        .unwrap()
        .remove(0)
        .instructions
        .remove(0);
    for field in 0..4 {
        let mut changed = ix.clone();
        match field {
            0 => changed.accounts[1].is_signer = false,
            1 => changed.program_id = Pubkey::default(),
            2 => changed.accounts[0].pubkey = Pubkey::default(),
            _ => changed.data.push(0),
        }
        assert_eq!(
            sdk::diff_transaction(&MintAdapter, &[changed], &state, &context()),
            Err(Error::UnsupportedOperation)
        );
    }
    assert_eq!(
        sdk::diff_transaction(&MintAdapter, &[], &state, &context()),
        Err(Error::UnsupportedOperation)
    );
}
