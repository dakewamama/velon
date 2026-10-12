use arm::{AuthorizationChange, Availability, EvidenceBundle, NativeContext};
use catalyst_sdk::{self as sdk, spl::*, Adapter, Context, Error};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::token;
use sha2::{Digest, Sha256};
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
            references: vec!["fixture:spl-delegate.bin".into()],
            observed_at: "fixture:slot:1".into(),
        },
    }
}

fn state() -> State {
    State {
        address: Pubkey::new_from_array([1; 32]),
        account: Account {
            lamports: 10_000_000,
            owner: token::ID,
            data: include_bytes!("fixtures/spl-delegate.bin").to_vec(),
            ..Account::default()
        },
        owner: Account {
            lamports: 1_000_000,
            ..Account::default()
        },
        delegate: Account::default(),
    }
}

#[test]
fn raw_native_fixture_matches_semantic_golden() {
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(token::ELF)),
        PROGRAM_VERSION
    );
    let first = sdk::compile_state(&DelegateAdapter, &state(), &context()).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/spl-delegate.json")).unwrap();
    assert_eq!(serde_json::to_value(&first).unwrap(), expected);
    assert_eq!(
        first,
        sdk::compile_state(&DelegateAdapter, &state(), &context()).unwrap()
    );
    assert_eq!(
        first[0].availability_at(0).unwrap(),
        Availability::Conditional
    );
}

#[test]
fn golden_bytes_are_reproduced_by_native_approve() {
    let mut state = state();
    let mut native = TokenAccount::unpack(&state.account.data).unwrap();
    let delegate = Option::<Pubkey>::from(native.delegate).unwrap();
    native.delegate = COption::None;
    native.delegated_amount = 0;
    TokenAccount::pack(native, &mut state.account.data).unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let ix = instruction::approve(
        &token::ID,
        &state.address,
        &delegate,
        &native.owner,
        &[],
        25,
    )
    .unwrap();
    let result = mollusk.process_instruction(
        &ix,
        &[
            (state.address, state.account),
            (delegate, state.delegate),
            (native.owner, state.owner),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    assert_eq!(
        result.resulting_accounts[0].1.data,
        include_bytes!("fixtures/spl-delegate.bin")
    );
}

#[test]
fn native_account_closure_removes_delegate_authority() {
    let mut state = state();
    let mut account = TokenAccount::unpack(&state.account.data).unwrap();
    account.amount = 0;
    TokenAccount::pack(account, &mut state.account.data).unwrap();
    assert_eq!(
        sdk::compile_state(&DelegateAdapter, &state, &context())
            .unwrap()
            .len(),
        1
    );
    let recipient = Pubkey::new_from_array([8; 32]);
    let instruction =
        instruction::close_account(&token::ID, &state.address, &recipient, &account.owner, &[])
            .unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let result = mollusk.process_instruction(
        &instruction,
        &[
            (state.address, state.account.clone()),
            (recipient, Account::default()),
            (account.owner, state.owner.clone()),
        ],
    );
    assert_eq!(result.raw_result, Ok(()));
    state.account = result
        .resulting_accounts
        .iter()
        .find(|(key, _)| *key == state.address)
        .unwrap()
        .1
        .clone();
    assert_eq!(state.account, Account::default());
    assert!(sdk::compile_state(&DelegateAdapter, &state, &context())
        .unwrap()
        .is_empty());
    assert_eq!(
        DelegateAdapter.source_requirements(&state).accounts,
        vec![state.address]
    );
    let mut unknown = context();
    unknown.native.program_version = "unknown".into();
    assert_eq!(
        sdk::compile_state(&DelegateAdapter, &state, &unknown),
        Err(Error::UnsupportedVersion)
    );
    state.account.lamports = 1;
    assert!(matches!(
        sdk::compile_state(&DelegateAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
}

#[test]
fn native_spending_enforces_and_consumes_the_observed_budget() {
    let state = state();
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    let delegate = Option::<Pubkey>::from(native.delegate).unwrap();
    let destination_key = Pubkey::new_from_array([8; 32]);
    let mut destination = state.account.clone();
    TokenAccount::pack(
        TokenAccount {
            amount: 0,
            delegate: COption::None,
            delegated_amount: 0,
            ..native
        },
        &mut destination.data,
    )
    .unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    for amount in [26, 25] {
        let ix = instruction::transfer(
            &token::ID,
            &state.address,
            &destination_key,
            &delegate,
            &[],
            amount,
        )
        .unwrap();
        let result = mollusk.process_instruction(
            &ix,
            &[
                (state.address, state.account.clone()),
                (destination_key, destination.clone()),
                (delegate, state.delegate.clone()),
            ],
        );
        if amount == 26 {
            assert!(result.raw_result.is_err());
            assert_eq!(result.resulting_accounts[0].1.data, state.account.data);
        } else {
            assert_eq!(result.raw_result, Ok(()));
            let after = TokenAccount::unpack(&result.resulting_accounts[0].1.data).unwrap();
            assert_eq!(after.amount, 75);
            assert_eq!(after.delegated_amount, 0);
            assert_eq!(after.delegate, COption::None);
            let observed = State {
                account: result.resulting_accounts[0].1.clone(),
                ..state
            };
            assert!(sdk::compile_state(&DelegateAdapter, &observed, &context())
                .unwrap()
                .is_empty());
            break;
        }
    }
}

#[test]
fn native_revoke_executes_and_recompilation_matches_declared_diff() {
    for deployment in [DEPLOYMENT, LIVE_DEPLOYMENT, DEVNET_DEPLOYMENT] {
        let mut context = context();
        context.native.deployment = deployment.into();
        native_revoke_round_trip(context);
    }
}

fn native_revoke_round_trip(context: Context) {
    let mut state = state();
    let before_state = self::state();
    let before = sdk::compile_state(&DelegateAdapter, &state, &context)
        .unwrap()
        .remove(0);
    let action = sdk::actions(&DelegateAdapter, &before, &state, &context)
        .unwrap()
        .remove(0);
    let declared =
        sdk::diff_transaction(&DelegateAdapter, &action.instructions, &state, &context).unwrap();
    assert_eq!(
        declared,
        vec![AuthorizationChange::Removed {
            authorization: Box::new(before)
        }]
    );
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    assert_eq!(
        action.instructions[0],
        instruction::revoke(&token::ID, &state.address, &native.owner, &[]).unwrap()
    );
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    let result = mollusk.process_transaction_instructions(
        &action.instructions,
        &[
            (state.address, state.account.clone()),
            (native.owner, state.owner.clone()),
        ],
        None,
    );
    assert_eq!(result.raw_result, Ok(()));
    state.account = result
        .resulting_accounts
        .into_iter()
        .find(|(key, _)| *key == state.address)
        .unwrap()
        .1;
    let after = TokenAccount::unpack(&state.account.data).unwrap();
    assert_eq!(after.delegate, COption::None);
    assert_eq!(after.delegated_amount, 0);
    assert_eq!(after.owner, native.owner);
    assert_eq!(after.amount, native.amount);
    let mut observed = context.clone();
    observed.evidence.observed_at = "fixture:slot:2".into();
    observed.evidence.references = vec!["fixture:native-revoke:result".into()];
    assert!(sdk::compile_state(&DelegateAdapter, &state, &observed)
        .unwrap()
        .is_empty());
    assert_eq!(
        sdk::verify_transaction_diff(
            &DelegateAdapter,
            &action.instructions,
            &before_state,
            &context,
            &state,
            &observed
        ),
        Ok(declared)
    );
    assert_eq!(
        sdk::verify_transaction_diff(
            &DelegateAdapter,
            &action.instructions,
            &before_state,
            &context,
            &before_state,
            &observed
        ),
        Err(Error::DiffMismatch)
    );
}

#[test]
fn verified_diff_does_not_cross_known_deployment_boundaries() {
    let before = context();
    let mut after = before.clone();
    after.native.deployment = LIVE_DEPLOYMENT.into();
    assert!(DelegateAdapter.supports(&after.native));
    assert_eq!(
        sdk::verify_transaction_diff(&DelegateAdapter, &[], &state(), &before, &state(), &after),
        Err(Error::UnsupportedVersion)
    );
}

#[test]
fn failed_transaction_rolls_back_an_already_executed_revoke() {
    let state = state();
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    let beneficiary = Pubkey::new_from_array([9; 32]);
    let mut destination = state.account.clone();
    let mut recipient = native;
    recipient.amount = 0;
    recipient.delegate = COption::None;
    recipient.delegated_amount = 0;
    TokenAccount::pack(recipient, &mut destination.data).unwrap();
    let instructions = [
        instruction::revoke(&token::ID, &state.address, &native.owner, &[]).unwrap(),
        instruction::transfer(
            &token::ID,
            &state.address,
            &beneficiary,
            &native.owner,
            &[],
            native.amount + 1,
        )
        .unwrap(),
    ];
    let accounts = vec![
        (state.address, state.account.clone()),
        (native.owner, state.owner.clone()),
        (beneficiary, destination),
    ];
    let mut vm = Mollusk::default();
    token::add_program(&mut vm);
    let result = vm.process_transaction_instructions(&instructions, &accounts, None);
    assert!(format!("{:?}", result.raw_result).starts_with("Err(InstructionError(1,"));
    assert_eq!(result.resulting_accounts, accounts);
    assert_eq!(
        sdk::diff_transaction(&DelegateAdapter, &instructions, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
}

#[test]
fn only_exact_deployments_and_versions_are_supported() {
    let state = state();
    for deployment in [DEPLOYMENT, LIVE_DEPLOYMENT, DEVNET_DEPLOYMENT] {
        let mut known = context();
        known.native.deployment = deployment.into();
        assert!(DelegateAdapter.supports(&known.native));
        assert!(MintAdapter.supports(&known.native));
        assert!(CloseAdapter.supports(&known.native));
        let authorization = sdk::compile_state(&DelegateAdapter, &state, &known)
            .unwrap()
            .remove(0);
        assert_eq!(authorization.native_context, known.native);
        for field in 0..7 {
            let mut unknown = known.clone();
            match field {
                0 => unknown.native.program_version = "sha256:unknown".into(),
                1 => unknown.native.deployment = "unknown".into(),
                2 => unknown.native.adapter_version = "future".into(),
                3 => unknown.native.protocol = "spl-token-2022".into(),
                4 => unknown.native.deployment = LIVE_DEPLOYMENT.replace("419472000", "419472001"),
                5 => {
                    unknown.native.deployment = format!("solana:loader-v3:{}:419472000", token::ID)
                }
                _ => unknown.native.deployment = format!("{LIVE_DEPLOYMENT}:other"),
            }
            assert!(!DelegateAdapter.supports(&unknown.native));
            assert!(!MintAdapter.supports(&unknown.native));
            assert!(!CloseAdapter.supports(&unknown.native));
            assert_eq!(
                sdk::compile_state(&DelegateAdapter, &state, &unknown),
                Err(Error::UnsupportedVersion)
            );
            assert_eq!(
                sdk::diff_transaction(&DelegateAdapter, &[], &state, &unknown),
                Err(Error::UnsupportedVersion)
            );
            assert_eq!(
                sdk::actions(&DelegateAdapter, &authorization, &state, &unknown),
                Err(Error::UnsupportedVersion)
            );
        }
    }
}

#[test]
fn native_revoke_rejects_wrong_or_unsigned_owner_without_mutation() {
    let state = state();
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    for wrong_owner in [false, true] {
        let owner = if wrong_owner {
            Pubkey::new_from_array([9; 32])
        } else {
            native.owner
        };
        let mut instruction = instruction::revoke(&token::ID, &state.address, &owner, &[]).unwrap();
        instruction.accounts[1].is_signer = wrong_owner;
        assert_eq!(
            sdk::diff_transaction(&DelegateAdapter, &[instruction.clone()], &state, &context()),
            Err(Error::UnsupportedOperation)
        );
        let result = mollusk.process_instruction(
            &instruction,
            &[
                (state.address, state.account.clone()),
                (owner, state.owner.clone()),
            ],
        );
        assert!(result.raw_result.is_err());
        assert_eq!(result.resulting_accounts[0].1.data, state.account.data);
    }
}

#[test]
fn frozen_and_exhausted_authority_is_not_available() {
    for frozen in [false, true] {
        let mut state = state();
        let mut native = TokenAccount::unpack(&state.account.data).unwrap();
        if frozen {
            native.state = AccountState::Frozen;
        } else {
            native.delegated_amount = 0;
        }
        TokenAccount::pack(native, &mut state.account.data).unwrap();
        let authorization = sdk::compile_state(&DelegateAdapter, &state, &context())
            .unwrap()
            .remove(0);
        assert_eq!(
            authorization.availability_at(0).unwrap(),
            Availability::Inactive
        );
        if frozen {
            assert_eq!(
                sdk::actions(&DelegateAdapter, &authorization, &state, &context()),
                Err(Error::UnsupportedOperation)
            );
            let mut mollusk = Mollusk::default();
            token::add_program(&mut mollusk);
            let ix = instruction::revoke(&token::ID, &state.address, &native.owner, &[]).unwrap();
            let result = mollusk.process_instruction(
                &ix,
                &[
                    (state.address, state.account.clone()),
                    (native.owner, state.owner.clone()),
                ],
            );
            assert!(result.raw_result.is_err());
            assert_eq!(result.resulting_accounts[0].1.data, state.account.data);
        }
    }
}

#[test]
fn malformed_state_unknown_version_and_fabricated_actions_fail_closed() {
    let mut state = state();
    let known = context();
    let mut authorization = sdk::compile_state(&DelegateAdapter, &state, &known)
        .unwrap()
        .remove(0);
    authorization.principal = arm::Principal::Identity("fabricated".into());
    assert_eq!(
        sdk::actions(&DelegateAdapter, &authorization, &state, &known),
        Err(Error::InvalidProjection)
    );
    state.owner.data = vec![0; 355];
    let authorization = sdk::compile_state(&DelegateAdapter, &state, &known)
        .unwrap()
        .remove(0);
    assert_eq!(
        sdk::actions(&DelegateAdapter, &authorization, &state, &known),
        Err(Error::UnsupportedOperation)
    );
    state.account.data.clear();
    assert!(matches!(
        sdk::compile_state(&DelegateAdapter, &state, &known),
        Err(Error::InvalidState(_))
    ));
    let mut unknown = known;
    unknown.native.program_version = "future".into();
    assert_eq!(
        sdk::compile_state(&DelegateAdapter, &state, &unknown),
        Err(Error::UnsupportedVersion)
    );
}

#[test]
fn requirements_and_wrong_program_owner_are_explicit() {
    let mut state = state();
    let native = TokenAccount::unpack(&state.account.data).unwrap();
    assert_eq!(
        DelegateAdapter.source_requirements(&state).accounts,
        vec![
            state.address,
            native.owner,
            Option::<Pubkey>::from(native.delegate).unwrap()
        ]
    );
    state.delegate.owner = token::ID;
    state.delegate.data = vec![0; 355];
    assert_eq!(
        sdk::compile_state(&DelegateAdapter, &state, &context()),
        Err(Error::UnsupportedOperation)
    );
    state.account.owner = Pubkey::default();
    assert!(matches!(
        sdk::compile_state(&DelegateAdapter, &state, &context()),
        Err(Error::InvalidState(_))
    ));
}
