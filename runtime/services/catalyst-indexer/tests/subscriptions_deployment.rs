use cataloger::{AdapterRef, Catalog, ProgramVersion, Provenance, SchemaSource};
use catalyst_indexer::{Journal, Observation, Origin, Projection, SDK_REVISION, Snapshot, Target};
use catalyst_sdk::{Adapter, spl, subscriptions};
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account_decoder_client_types::UiAccount;
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_pubkey::Pubkey;
use solana_sdk_ids::sysvar;

mod support;

const RAW: &[u8] = include_bytes!("fixtures/devnet-subscriptions-response.json");
const RESPONSE_HASH: &str = "794c6c9fbb35697eabf1931fb42440cca8b8a8dc2a42de95fb95b1a945651f53";
const SLOT: u64 = 509_022_453;

fn metadata() -> Value {
    serde_json::from_str(include_str!("fixtures/devnet-subscriptions-capture.json")).unwrap()
}

fn snapshot() -> Snapshot {
    let metadata = metadata();
    let response: Value = serde_json::from_slice(RAW).unwrap();
    let keys = metadata["keys"].as_array().unwrap();
    let values = response["result"]["value"].as_array().unwrap();
    assert_eq!(keys.len(), values.len());
    let mut snapshot = Snapshot {
        observation: Observation {
            cluster: metadata["cluster"].as_str().unwrap().into(),
            bank: format!("rpc:finalized:{SLOT}"),
            slot: SLOT,
            unix_timestamp: metadata["unix_timestamp"].as_i64().unwrap(),
            origin: Origin::Finalized,
        },
        accounts: keys
            .iter()
            .zip(values)
            .map(|(key, value)| {
                let account: UiAccount = serde_json::from_value(value.clone()).unwrap();
                (
                    key.as_str().unwrap().parse().unwrap(),
                    account.to_account().unwrap(),
                )
            })
            .collect(),
        // The capture proves deployment identity; these selected target accounts remain unobserved.
        targets: vec![Target::Subscription {
            delegation: Pubkey::new_from_array([1; 32]),
            authority: Pubkey::new_from_array([2; 32]),
            source: Pubkey::new_from_array([3; 32]),
            mint: Pubkey::new_from_array([4; 32]),
            plan: None,
        }],
        features: Some(support::features(support::DEVNET_FEATURES, SLOT)),
    };
    snapshot.accounts.sort_by_key(|(key, _)| *key);
    snapshot
}

fn versions() -> Vec<ProgramVersion> {
    let metadata = metadata();
    [
        (
            subscriptions::DelegationAdapter.protocol(),
            subscriptions::DEVNET_DEPLOYMENT,
            subscriptions::DEVNET_PROGRAM_VERSION,
            subscriptions::ADAPTER_VERSION,
            "subscriptions",
            "0.5.0",
        ),
        (
            spl::DelegateAdapter.protocol(),
            spl::DEVNET_DEPLOYMENT,
            spl::PROGRAM_VERSION,
            "0.1",
            "spl-token-interface",
            "3.0.0",
        ),
    ]
    .into_iter()
    .map(
        |(protocol, deployment, version, adapter_version, schema, revision)| ProgramVersion {
            cluster: metadata["cluster"].as_str().unwrap().into(),
            program_id: protocol.program_id,
            deployment: deployment.into(),
            version: version.into(),
            executable: (schema == "subscriptions").then(|| {
                serde_json::from_str(include_str!("fixtures/subscriptions-executable.json"))
                    .unwrap()
            }),
            supported_from_slot: SLOT,
            supported_until_slot_exclusive: SLOT + 1,
            schema: SchemaSource {
                uri: format!("https://docs.rs/{schema}/{revision}"),
                revision: revision.into(),
            },
            adapter: AdapterRef {
                protocol: protocol.name.into(),
                version: adapter_version.into(),
                source: format!("https://github.com/dakewamama/catalyst-sdk/tree/{SDK_REVISION}"),
            },
            provenance: Provenance {
                source: metadata["rpc"].as_str().unwrap().into(),
                revision: format!("sha256:{RESPONSE_HASH}"),
                evidence_reference: format!(
                    "rpc:devnet-subscriptions-response.json:sha256:{RESPONSE_HASH}"
                ),
            },
        },
    )
    .collect()
}

#[test]
fn observed_mainnet_capture_binds_the_native_test_payload_to_loader_state_and_clock() {
    let raw = include_bytes!("fixtures/mainnet-subscriptions-response.json");
    let metadata: Value =
        serde_json::from_str(include_str!("fixtures/mainnet-subscriptions-capture.json")).unwrap();
    assert_eq!(
        metadata["response_sha256"],
        format!("{:x}", Sha256::digest(raw))
    );
    assert_eq!(
        metadata["cluster"],
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    );
    assert_eq!(metadata["params"][1]["commitment"], "finalized");
    let response: Value = serde_json::from_slice(raw).unwrap();
    let slot = response["result"]["context"]["slot"].as_u64().unwrap();
    assert_eq!(metadata["observed_slot"], slot);
    let account = |index: usize| {
        serde_json::from_value::<UiAccount>(response["result"]["value"][index].clone())
            .unwrap()
            .to_account()
            .unwrap()
    };
    let program = subscriptions::DelegationAdapter.protocol().program_id;
    let data_address = get_program_data_address(&program);
    assert_eq!(metadata["keys"][0], program.to_string());
    assert_eq!(metadata["keys"][1], data_address.to_string());
    assert_eq!(metadata["keys"][2], sysvar::clock::id().to_string());
    let program_account = account(0);
    let data_account = account(1);
    assert_eq!(
        program_account.owner,
        solana_sdk_ids::bpf_loader_upgradeable::id()
    );
    assert_eq!(data_account.owner, program_account.owner);
    assert!(program_account.executable && !data_account.executable);
    assert_eq!(
        bincode::deserialize::<UpgradeableLoaderState>(&program_account.data).unwrap(),
        UpgradeableLoaderState::Program {
            programdata_address: data_address
        }
    );
    let offset = UpgradeableLoaderState::size_of_programdata_metadata();
    let UpgradeableLoaderState::ProgramData { slot: deployed, .. } =
        bincode::deserialize(&data_account.data[..offset]).unwrap()
    else {
        panic!("not ProgramData")
    };
    assert_eq!(deployed, metadata["deployment_slot"].as_u64().unwrap());
    assert!(deployed < slot);
    assert!(subscriptions::MAINNET_DEPLOYMENT.ends_with(&format!(":{deployed}")));
    let elf = &data_account.data[offset..];
    assert_eq!(
        elf,
        include_bytes!("../../../../sdk/tests/fixtures/subscriptions-mainnet-program.so")
    );
    assert_eq!(
        subscriptions::MAINNET_PROGRAM_VERSION,
        format!("sha256:{:x}", Sha256::digest(elf))
    );
    let verification_raw = include_bytes!("fixtures/mainnet-subscriptions-verification.json");
    assert_eq!(
        metadata["verification_status_sha256"],
        format!("{:x}", Sha256::digest(verification_raw))
    );
    let verification: Value = serde_json::from_slice(verification_raw).unwrap();
    assert_eq!(verification["is_verified"], true);
    assert_eq!(verification["commit"], metadata["source_revision"]);
    let end = elf.iter().rposition(|byte| *byte != 0).unwrap() + 1;
    let normalized = format!("{:x}", Sha256::digest(&elf[..end]));
    assert_eq!(verification["executable_hash"], normalized);
    assert_eq!(verification["on_chain_hash"], normalized);
    let clock: solana_clock::Clock = bincode::deserialize(&account(2).data).unwrap();
    assert_eq!(clock.slot, slot);
    // This capture contains no user state, historical account incarnation or chain action.
}

#[tokio::test]
async fn verified_deployments_do_not_turn_unobserved_grants_into_complete_authority() {
    assert_eq!(format!("{:x}", Sha256::digest(RAW)), RESPONSE_HASH);
    assert_eq!(metadata()["response_sha256"], RESPONSE_HASH);
    let snapshot = snapshot();
    assert_eq!(snapshot.accounts.len(), 5);
    for version in versions() {
        let data = &snapshot
            .accounts
            .iter()
            .find(|(key, _)| *key == get_program_data_address(&version.program_id))
            .unwrap()
            .1;
        let offset = UpgradeableLoaderState::size_of_programdata_metadata();
        assert_eq!(
            version.version,
            format!("sha256:{:x}", Sha256::digest(&data.data[offset..]))
        );
    }
    let catalog = Catalog::new(versions()).unwrap();
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let record = journal.ingest(snapshot.clone(), &catalog).await.unwrap();
    assert_eq!(record.snapshot, snapshot);
    let mut expected_versions = versions();
    expected_versions.sort_by_key(|version| version.program_id);
    assert_eq!(record.versions, expected_versions);
    assert!(matches!(record.projection, Projection::Incomplete { .. }));
    assert!(!record.coverage_complete);
    assert_eq!(journal.replay(&record.id).await.unwrap(), record);
}

#[tokio::test]
async fn changed_program_bytes_and_missing_bank_evidence_fail_before_grant_decoding() {
    let catalog = Catalog::new(versions()).unwrap();
    for version in versions() {
        let key = get_program_data_address(&version.program_id);
        let mut changed = snapshot();
        let data = &mut changed
            .accounts
            .iter_mut()
            .find(|(address, _)| *address == key)
            .unwrap()
            .1;
        *data.data.last_mut().unwrap() ^= 1;
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let record = journal.ingest(changed, &catalog).await.unwrap();
        assert!(matches!(record.projection, Projection::Unsupported { .. }));
        assert!(!record.coverage_complete);
    }
    for key in [
        sysvar::clock::id(),
        get_program_data_address(&subscriptions::DelegationAdapter.protocol().program_id),
        get_program_data_address(&spl::DelegateAdapter.protocol().program_id),
    ] {
        let mut missing = snapshot();
        missing.accounts.retain(|(address, _)| *address != key);
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let record = journal.ingest(missing, &catalog).await.unwrap();
        assert!(matches!(record.projection, Projection::Incomplete { .. }));
    }
}
