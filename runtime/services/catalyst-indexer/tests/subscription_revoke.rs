use arm::{AuthorityKind, AuthorizationChange};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use cataloger::{AdapterRef, Catalog, ProgramVersion, Provenance, SchemaSource};
use catalyst_indexer::{
    Error, Journal, Observation, Origin, Projection, SDK_REVISION, Snapshot, Target, rpc,
};
use catalyst_sdk::{Adapter, Error as AdapterError, spl, subscriptions};
use mollusk_svm::{Mollusk, program::ProgramCache};
use serde_json::{Value, json};
use solana_account::Account;
use solana_account_decoder_client_types::UiAccount;
use solana_clock::Clock;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::request::RpcRequest;
use solana_sdk_ids::{bpf_loader_upgradeable, sysvar};
use solana_transaction::{AccountMeta, Instruction, Transaction};
use tower::ServiceExt;

mod support;

// A controlled composition, not evidence of a devnet grant. The Subscriptions and SPL Token
// programs, the Clock and the feature set are the unmodified finalized devnet capture at SLOT.
// The grant accounts are the native Mollusk fixture phases. Only the Clock's unix_timestamp is
// set to the fixture's own clock, so the grant is judged at the time it was captured.
const SLOT: u64 = 509_022_453;
const CANCELLED: &str = include_str!("fixtures/revoke-cancelled-before.json");
const REVOKED: &str = include_str!("fixtures/revoke-cancelled-after.json");
const ACTIVE: &str = include_str!("fixtures/owner-pull-60.json");
// The transaction's two compute-budget instructions use 150 units each of the 10,000 limit.
const UNIT_LIMIT: u64 = 10_000 - 2 * 150;

fn delegator() -> Pubkey {
    Pubkey::new_from_array([1; 32])
}

fn targets(fixture: &Snapshot) -> (Pubkey, Pubkey) {
    let [
        Target::Subscription {
            delegation,
            plan: Some(plan),
            ..
        },
    ] = fixture.targets.as_slice()
    else {
        panic!("{:?}", fixture.targets);
    };
    (*delegation, *plan)
}

fn metadata() -> Value {
    serde_json::from_str(include_str!("fixtures/devnet-subscriptions-capture.json")).unwrap()
}

fn cluster() -> String {
    metadata()["cluster"].as_str().unwrap().into()
}

fn snapshot(fixture: &str) -> Snapshot {
    let fixture: Snapshot = serde_json::from_str(fixture).unwrap();
    let metadata = metadata();
    let response: Value =
        serde_json::from_str(include_str!("fixtures/devnet-subscriptions-response.json")).unwrap();
    let mut accounts = fixture.accounts;
    for (key, value) in metadata["keys"]
        .as_array()
        .unwrap()
        .iter()
        .zip(response["result"]["value"].as_array().unwrap())
    {
        let account: UiAccount = serde_json::from_value(value.clone()).unwrap();
        accounts.push((
            key.as_str().unwrap().parse().unwrap(),
            account.to_account().unwrap(),
        ));
    }
    let unix_timestamp = fixture.observation.unix_timestamp;
    let mut snapshot = Snapshot {
        observation: Observation {
            cluster: cluster(),
            bank: format!("rpc:finalized:{SLOT}"),
            slot: SLOT,
            unix_timestamp,
            origin: Origin::Finalized,
        },
        accounts,
        targets: fixture.targets,
        features: Some(support::features(support::DEVNET_FEATURES, SLOT)),
    };
    let clock = account(&mut snapshot, sysvar::clock::id());
    let mut value: Clock = bincode::deserialize(&clock.data).unwrap();
    assert_eq!(value.slot, SLOT);
    value.unix_timestamp = unix_timestamp;
    clock.data = bincode::serialize(&value).unwrap();
    snapshot
}

fn account(snapshot: &mut Snapshot, key: Pubkey) -> &mut Account {
    &mut snapshot
        .accounts
        .iter_mut()
        .find(|(address, _)| *address == key)
        .unwrap()
        .1
}

fn find(snapshot: &Snapshot, key: Pubkey) -> Account {
    snapshot
        .accounts
        .iter()
        .find(|(address, _)| *address == key)
        .unwrap()
        .1
        .clone()
}

fn version(protocol: catalyst_sdk::Protocol, program_version: &str) -> ProgramVersion {
    let (deployment, adapter_version, schema, revision) =
        if protocol.program_id == subscriptions::DelegationAdapter.protocol().program_id {
            (
                subscriptions::DEVNET_DEPLOYMENT,
                subscriptions::ADAPTER_VERSION,
                "subscriptions",
                "0.5.0",
            )
        } else {
            (
                spl::DEVNET_DEPLOYMENT,
                "0.1",
                "spl-token-interface",
                "3.0.0",
            )
        };
    let response_hash = metadata()["response_sha256"].as_str().unwrap().to_string();
    let mut version = ProgramVersion {
        cluster: cluster(),
        program_id: protocol.program_id,
        deployment: deployment.into(),
        version: program_version.into(),
        executable: None,
        supported_from_slot: SLOT,
        supported_until_slot_exclusive: SLOT + 2,
        schema: SchemaSource {
            uri: format!("https://docs.rs/{schema}/{revision}"),
            revision: revision.into(),
        },
        adapter: AdapterRef {
            protocol: protocol.name.into(),
            version: adapter_version.into(),
            source: format!("https://github.com/dakewamama/velon/tree/{SDK_REVISION}/sdk"),
        },
        provenance: Provenance {
            source: "fixture:devnet-programs-and-native-grant".into(),
            revision: format!("sha256:{response_hash}"),
            evidence_reference: format!(
                "rpc:devnet-subscriptions-response.json:sha256:{response_hash}"
            ),
        },
    };
    let snapshot = snapshot(CANCELLED);
    let programdata = find(&snapshot, get_program_data_address(&protocol.program_id)).data;
    support::attest_fixture(
        &mut version,
        &programdata[UpgradeableLoaderState::size_of_programdata_metadata()..],
        SLOT,
        snapshot.features.as_ref().unwrap(),
    );
    version
}

fn catalog_with(subscriptions_version: &str) -> Catalog {
    Catalog::new(vec![
        version(
            subscriptions::DelegationAdapter.protocol(),
            subscriptions_version,
        ),
        version(spl::DelegateAdapter.protocol(), spl::PROGRAM_VERSION),
    ])
    .unwrap()
}

fn catalog() -> Catalog {
    catalog_with(subscriptions::DEVNET_PROGRAM_VERSION)
}

fn ui(account: &Account) -> Value {
    json!({
        "lamports": account.lamports,
        "owner": account.owner.to_string(),
        "executable": account.executable,
        "rentEpoch": account.rent_epoch,
        "space": account.data.len(),
        "data": [STANDARD.encode(&account.data), "base64"]
    })
}

/// A provider reply for the reviewed addresses: delegator, delegation, plan, Clock.
fn simulation(snapshot: &Snapshot, delegation: Option<&Account>) -> Value {
    let revoked: Snapshot = serde_json::from_str(REVOKED).unwrap();
    let (_, plan) = targets(&revoked);
    json!({
        "context": {"slot": SLOT},
        "value": {
            "err": null,
            "logs": ["Program log: Instruction: RevokeDelegation"],
            "accounts": [
                ui(&find(&revoked, delegator())),
                delegation.map_or(Value::Null, ui),
                ui(&find(snapshot, plan)),
                ui(&find(snapshot, sysvar::clock::id())),
            ],
            "unitsConsumed": null,
            "replacementBlockhash": {"blockhash": "5LyjeY4xs2T6RWFAYsxXX3mb3znxqEwSzX4hLyHZxsVE", "lastValidBlockHeight": 100}
        }
    })
}

fn client(reply: Value) -> RpcClient {
    RpcClient::new_mock_with_mocks(
        "succeeds".into(),
        [
            (RpcRequest::GetGenesisHash, json!(cluster())),
            (RpcRequest::SimulateTransaction, reply),
        ]
        .into_iter()
        .collect(),
    )
}

fn revoke_instruction(delegation: Pubkey, plan: Pubkey) -> Instruction {
    Instruction {
        program_id: subscriptions::DelegationAdapter.protocol().program_id,
        accounts: vec![
            AccountMeta::new(delegator(), true),
            AccountMeta::new(delegation, false),
            AccountMeta::new_readonly(plan, false),
        ],
        data: vec![3],
    }
}

#[tokio::test]
async fn an_ended_subscription_compiles_its_derived_grant_on_the_pinned_deployments() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let record = journal
        .ingest(snapshot(CANCELLED), &catalog())
        .await
        .unwrap();
    let Projection::Compiled { authorizations } = &record.projection else {
        panic!("{:?}", record.projection);
    };
    assert!(
        authorizations
            .iter()
            .any(|grant| matches!(grant.authority_kind, AuthorityKind::Derived { .. }))
    );
    assert_eq!(journal.replay(&record.id).await.unwrap(), record);
}

#[test]
fn revoke_delegation_closes_the_grant_within_the_fixed_unit_limit() {
    let before = snapshot(CANCELLED);
    let after: Snapshot = serde_json::from_str(REVOKED).unwrap();
    let (delegation, plan) = targets(&before);
    let program = subscriptions::DelegationAdapter.protocol().program_id;
    let features = before.features.as_ref().unwrap().runtime(SLOT).unwrap();
    let mut compute_budget =
        ComputeBudget::new_with_defaults(features.raise_cpi_nesting_limit_to_8);
    compute_budget.compute_unit_limit = UNIT_LIMIT;
    let mut mollusk = Mollusk {
        compute_budget,
        ..Default::default()
    };
    mollusk.program_cache = ProgramCache::new(&features, &mollusk.compute_budget, false);
    mollusk.feature_set = features;
    mollusk.sysvars.clock = bincode::deserialize(&find(&before, sysvar::clock::id()).data).unwrap();
    let offset = UpgradeableLoaderState::size_of_programdata_metadata();
    let programdata = find(&before, get_program_data_address(&program)).data;
    mollusk.add_program_with_loader_and_elf(
        &program,
        &bpf_loader_upgradeable::id(),
        &programdata[offset..],
    );
    let keys = [delegator(), delegation, plan];
    let accounts: Vec<_> = keys.iter().map(|key| (*key, find(&before, *key))).collect();
    let result =
        mollusk.process_instruction_chain(&[revoke_instruction(delegation, plan)], &accounts);
    println!(
        "RevokeDelegation consumed {} of {UNIT_LIMIT} compute units",
        result.compute_units_consumed
    );
    assert!(result.raw_result.is_ok() && result.program_result.is_ok());
    assert!(result.compute_units_consumed <= UNIT_LIMIT);
    // The pinned devnet build reaches the native fixture's own post-state.
    for (key, account) in &result.resulting_accounts {
        assert_eq!(*account, find(&after, *key), "{key}");
    }
    assert_eq!(find(&after, delegation), Account::default());
}

#[tokio::test]
async fn an_ended_subscription_revokes_with_the_delegator_as_the_only_signer() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot(CANCELLED);
    let (delegation, plan) = targets(&observed);
    let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
    let simulated = rpc::simulate_revoke(
        &client(simulation(&observed, None)),
        &journal,
        &record.id,
        delegation,
    )
    .await
    .unwrap();
    let expected = Transaction::new_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(10_000),
            ComputeBudgetInstruction::set_compute_unit_price(1_000_000),
            revoke_instruction(delegation, plan),
        ],
        Some(&delegator()),
    );
    assert_eq!(simulated.transaction.message, expected.message);
    assert_eq!(
        simulated.transaction.message.header.num_required_signatures,
        1
    );
    assert!(matches!(
        simulated.changes.as_slice(),
        [AuthorizationChange::Removed { authorization }]
            if matches!(authorization.authority_kind, AuthorityKind::Derived { .. })
    ));
    let addresses = &simulated.config.accounts.as_ref().unwrap().addresses;
    assert_eq!(
        addresses,
        &[delegator(), delegation, plan, sysvar::clock::id()]
            .map(|key| key.to_string())
            .to_vec()
    );
}

#[tokio::test]
async fn a_provider_that_disagrees_with_the_closed_delegation_is_refused() {
    let observed = snapshot(CANCELLED);
    let (delegation, plan) = targets(&observed);
    let kept = find(&observed, delegation);
    let emptied = Account {
        lamports: 1,
        ..Account::default()
    };
    let mut plan_changed = simulation(&observed, None);
    let mut changed = find(&observed, plan);
    *changed.data.last_mut().unwrap() ^= 1;
    plan_changed["value"]["accounts"][2] = ui(&changed);
    for reply in [
        simulation(&observed, Some(&kept)),
        simulation(&observed, Some(&emptied)),
        plan_changed,
    ] {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
        let result = rpc::simulate_revoke(&client(reply), &journal, &record.id, delegation).await;
        assert!(matches!(
            result,
            Err(Error::Adapter(AdapterError::DiffMismatch))
        ));
    }
}

#[tokio::test]
async fn an_active_or_not_yet_ended_subscription_is_not_revocable() {
    let mut pending = snapshot(CANCELLED);
    // One second before the cancellation takes effect.
    pending.observation.unix_timestamp -= 1;
    let clock = account(&mut pending, sysvar::clock::id());
    let mut value: Clock = bincode::deserialize(&clock.data).unwrap();
    value.unix_timestamp -= 1;
    clock.data = bincode::serialize(&value).unwrap();
    for observed in [snapshot(ACTIVE), pending] {
        let (delegation, _) = targets(&observed);
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let record = journal.ingest(observed, &catalog()).await.unwrap();
        assert!(matches!(record.projection, Projection::Compiled { .. }));
        let result = rpc::simulate_revoke(
            &RpcClient::new_mock("fails".into()),
            &journal,
            &record.id,
            delegation,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::Adapter(AdapterError::UnsupportedOperation))
        ));
        let app = rpc::action_router(journal, RpcClient::new_mock("fails".into()));
        let response = app
            .oneshot(
                Request::post(format!(
                    "/snapshots/{}/actions/revoke/{delegation}",
                    record.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["error"], "UnsupportedOperation");
    }
}

#[tokio::test]
async fn an_unpinned_subscriptions_build_is_not_supported() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot(CANCELLED);
    let (delegation, _) = targets(&observed);
    // An upgraded program would carry a different version than the verified pin.
    let catalog = catalog_with(&format!("sha256:{}", "1".repeat(64)));
    let record = journal.ingest(observed, &catalog).await.unwrap();
    assert!(matches!(record.projection, Projection::Unsupported { .. }));
    let result = rpc::simulate_revoke(
        &RpcClient::new_mock("fails".into()),
        &journal,
        &record.id,
        delegation,
    )
    .await;
    assert!(matches!(
        result,
        Err(Error::Adapter(AdapterError::UnsupportedVersion))
    ));
}

#[tokio::test]
async fn only_the_delegation_key_names_the_subscription_target() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot(CANCELLED);
    let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
    let Target::Subscription { source, plan, .. } = observed.targets[0] else {
        unreachable!();
    };
    for key in [source, plan.unwrap(), delegator()] {
        let result = rpc::simulate_revoke(
            &RpcClient::new_mock("fails".into()),
            &journal,
            &record.id,
            key,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::Adapter(AdapterError::UnsupportedOperation))
        ));
    }
}

#[tokio::test]
async fn verification_requires_the_delegators_signature() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot(CANCELLED);
    let (delegation, _) = targets(&observed);
    let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
    let simulated = rpc::simulate_revoke(
        &client(simulation(&observed, None)),
        &journal,
        &record.id,
        delegation,
    )
    .await
    .unwrap();
    // The reviewed message with its empty signature slot reaches the subscription's checks.
    let result = rpc::verify_revoke(
        &RpcClient::new_mock("fails".into()),
        &journal,
        &record.id,
        delegation,
        &simulated.signing_transaction,
    )
    .await;
    assert!(matches!(
        result,
        Err(Error::InvalidObservation("invalid transaction signature"))
    ));
}
