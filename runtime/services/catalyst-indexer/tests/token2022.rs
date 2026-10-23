use arm::{AuthorizationChange, Constraint, ConstraintExpr, Principal};
use base64::{Engine, engine::general_purpose::STANDARD};
use cataloger::{AdapterRef, Catalog, ProgramVersion, Provenance, SchemaSource};
use catalyst_indexer::{Error, Journal, Projection, SDK_REVISION, Snapshot, rpc};
use catalyst_sdk::{Adapter, Error as AdapterError, token2022};
use serde_json::{Value, json};
use solana_account::Account;
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::request::RpcRequest;
use solana_sdk_ids::sysvar;
use spl_token_2022_interface::{
    extension::{StateWithExtensions, StateWithExtensionsMut},
    state::Account as TokenAccount,
};

mod support;

// A real unlimited Token-2022 approval, observed on mainnet at this finalized slot by
// `authorization-api observe`. Program bytes are kept as raw files next to the snapshot.
const SLOT: u64 = 460_489_890;
const CLUSTER: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

fn key(value: &str) -> Pubkey {
    value.parse().unwrap()
}

fn source() -> Pubkey {
    key("3AZuzDS8yxVm6EwTmVzf1ZqruWVfLKsGFF5f4R5dJqX9")
}

fn owner() -> Pubkey {
    key("GLatJCDu47TJphKSVH2NiVX7WuSyM9RaaZdXMxMqoSmf")
}

fn delegate() -> Pubkey {
    key("2CnvNTjFsiBusfkVSNb5WFB2i6YF43J4ARRXqjFbrZw8")
}

fn snapshot() -> Snapshot {
    let mut snapshot: Snapshot =
        serde_json::from_str(include_str!("fixtures/token2022-snapshot.json")).unwrap();
    for (program, bytes) in [
        (
            token2022::Token2022Adapter.protocol().program_id,
            &include_bytes!("fixtures/token2022-programdata.bin")[..],
        ),
        (
            key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            &include_bytes!("fixtures/token-programdata.bin")[..],
        ),
    ] {
        account(&mut snapshot, get_program_data_address(&program)).data = bytes.to_vec();
    }
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

fn data(snapshot: &Snapshot, key: Pubkey) -> Vec<u8> {
    snapshot
        .accounts
        .iter()
        .find(|(address, _)| *address == key)
        .unwrap()
        .1
        .data
        .clone()
}

fn version(program_version: &str) -> ProgramVersion {
    let program = token2022::Token2022Adapter.protocol().program_id;
    let mut version = ProgramVersion {
        cluster: CLUSTER.into(),
        program_id: program,
        deployment: token2022::LIVE_DEPLOYMENT.into(),
        version: program_version.into(),
        executable: None,
        supported_from_slot: SLOT,
        supported_until_slot_exclusive: SLOT + 2,
        schema: SchemaSource {
            uri: "https://docs.rs/spl-token-2022-interface/3.1.2".into(),
            revision: "3.1.2".into(),
        },
        adapter: AdapterRef {
            protocol: "token-2022".into(),
            version: "0.1".into(),
            source: format!(
                "https://github.com/dakewamama/velon/blob/{SDK_REVISION}/sdk/src/token2022.rs"
            ),
        },
        provenance: Provenance {
            source: "fixture:mainnet-token2022-observation".into(),
            revision: format!("slot:{SLOT}"),
            evidence_reference: format!("rpc:finalized:{CLUSTER}:{SLOT}"),
        },
    };
    let snapshot = snapshot();
    let programdata = data(&snapshot, get_program_data_address(&program));
    support::attest_fixture(
        &mut version,
        &programdata[UpgradeableLoaderState::size_of_programdata_metadata()..],
        SLOT,
        snapshot.features.as_ref().unwrap(),
    );
    version
}

fn catalog() -> Catalog {
    Catalog::new(vec![version(token2022::LIVE_PROGRAM_VERSION)]).unwrap()
}

/// Token-2022's Revoke clears the delegate (option and key) and the allowance, nothing else.
fn revoked(data: &[u8]) -> Vec<u8> {
    let mut data = data.to_vec();
    let mut account = StateWithExtensionsMut::<TokenAccount>::unpack(&mut data).unwrap();
    account.base.delegate = None.into();
    account.base.delegated_amount = 0;
    account.pack_base();
    data[76..108].fill(0);
    data
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

fn simulation(snapshot: &Snapshot, source_data: Vec<u8>) -> Value {
    let find = |key: Pubkey| {
        snapshot
            .accounts
            .iter()
            .find(|(address, _)| *address == key)
            .unwrap()
            .1
            .clone()
    };
    let mut source_account = find(source());
    source_account.data = source_data;
    json!({
        "context": {"slot": SLOT},
        "value": {
            "err": null,
            "logs": ["Program log: Instruction: Revoke"],
            "accounts": [ui(&source_account), ui(&find(owner())), ui(&find(sysvar::clock::id()))],
            "unitsConsumed": null,
            "replacementBlockhash": {"blockhash": "5LyjeY4xs2T6RWFAYsxXX3mb3znxqEwSzX4hLyHZxsVE", "lastValidBlockHeight": 100}
        }
    })
}

fn client(reply: Value) -> RpcClient {
    RpcClient::new_mock_with_mocks(
        "succeeds".into(),
        [
            (RpcRequest::GetGenesisHash, json!(CLUSTER)),
            (RpcRequest::SimulateTransaction, reply),
        ]
        .into_iter()
        .collect(),
    )
}

#[tokio::test]
async fn a_real_mainnet_token_2022_approval_compiles_to_its_exact_delegate() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let record = journal.ingest(snapshot(), &catalog()).await.unwrap();
    let Projection::Compiled { authorizations } = record.projection else {
        panic!("{:?}", record.projection);
    };
    assert_eq!(authorizations.len(), 1);
    let grant = &authorizations[0];
    assert_eq!(grant.principal, Principal::Identity(delegate().to_string()));
    assert_eq!(grant.resource.namespace, "solana:token-account");
    assert_eq!(grant.resource.id, source().to_string());
    assert!(matches!(
        grant.constraints,
        ConstraintExpr::Constraint(Constraint::AmountAtMost {
            amount: u64::MAX,
            ..
        })
    ));
    assert_eq!(grant.native_context.protocol, "token-2022");
    assert_eq!(grant.native_context.deployment, token2022::LIVE_DEPLOYMENT);
}

#[tokio::test]
async fn the_revoke_runs_on_the_verified_program_and_leaves_extensions_untouched() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot();
    let before = data(&observed, source());
    let after = revoked(&before);
    // The account carries ImmutableOwner after the 165-byte base; Revoke must not touch it.
    assert!(before.len() > 165);
    assert_eq!(before[165..], after[165..]);
    let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
    let simulated = rpc::simulate_revoke(
        &client(simulation(&observed, after.clone())),
        &journal,
        &record.id,
        source(),
    )
    .await
    .unwrap();
    let message = &simulated.transaction.message;
    let revoke = message.instructions.last().unwrap();
    assert_eq!(
        message.account_keys[revoke.program_id_index as usize],
        token2022::Token2022Adapter.protocol().program_id
    );
    assert_eq!(message.account_keys[0], owner());
    assert!(matches!(
        simulated.changes.as_slice(),
        [AuthorizationChange::Removed { authorization }]
            if authorization.principal == Principal::Identity(delegate().to_string())
    ));
    let base = StateWithExtensions::<TokenAccount>::unpack(&after)
        .unwrap()
        .base;
    assert!(Option::<Pubkey>::from(base.delegate).is_none());
    assert_eq!(base.delegated_amount, 0);
}

#[tokio::test]
async fn a_provider_that_keeps_the_delegate_is_refused() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    let observed = snapshot();
    let record = journal.ingest(observed.clone(), &catalog()).await.unwrap();
    let unchanged = data(&observed, source());
    let result = rpc::simulate_revoke(
        &client(simulation(&observed, unchanged)),
        &journal,
        &record.id,
        source(),
    )
    .await;
    assert!(matches!(
        result,
        Err(Error::Adapter(AdapterError::DiffMismatch))
    ));
}

#[tokio::test]
async fn an_unpinned_token_2022_build_is_not_supported() {
    let journal = Journal::open("sqlite::memory:").await.unwrap();
    // An upgraded program would carry a different version than the verified pin.
    let catalog = Catalog::new(vec![version(&format!("sha256:{}", "1".repeat(64)))]).unwrap();
    let record = journal.ingest(snapshot(), &catalog).await.unwrap();
    assert!(matches!(record.projection, Projection::Unsupported { .. }));
}
