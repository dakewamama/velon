#![allow(dead_code)]

use cataloger::{
    ProgramVersion,
    executable::{AGAVE_REVISION, ExecutableEvidence, RuntimeEvidence},
};
use catalyst_indexer::{features::Features, rpc};
use serde_json::Value;
use solana_loader_v3_interface::get_program_data_address;

pub const MAINNET_FEATURES: &str = include_str!("../fixtures/mainnet-features-response.json");
pub const DEVNET_FEATURES: &str = include_str!("../fixtures/devnet-features-response.json");

/// The getProgramAccounts result a finalized node returned for the Feature program.
pub fn feature_response(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap()["result"].take()
}

/// The active set the runtime derives from a capture for an observation at `slot`.
pub fn features(raw: &str, slot: u64) -> Features {
    let result = feature_response(raw);
    let mut active: Vec<_> = result["value"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|keyed| {
            let data = keyed["account"]["data"][0].as_str().unwrap();
            let data =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).unwrap();
            let at: Option<u64> = bincode::deserialize(&data).unwrap();
            at.filter(|at| *at <= slot)
                .map(|at| (keyed["pubkey"].as_str().unwrap().parse().unwrap(), at))
        })
        .collect();
    active.sort();
    Features {
        slot: result["context"]["slot"].as_u64().unwrap(),
        active,
    }
}

// These operator attestations exercise trust checks; they are not evidence about a public bank.
pub fn attest_fixture(
    version: &mut ProgramVersion,
    elf: &[u8],
    observed_slot: u64,
    features: &Features,
) {
    let programdata_address = get_program_data_address(&version.program_id);
    let identity =
        rpc::executable_identity(elf, &features.runtime(observed_slot).unwrap()).unwrap();
    version.executable = Some(ExecutableEvidence {
        programdata_address,
        observed_slot,
        source_revision: Some("fixture:source-attestation".into()),
        build_toolchain: Some("fixture:build-attestation".into()),
        runtime: Some(RuntimeEvidence {
            revision: AGAVE_REVISION.into(),
            environment_hash: identity.environment_hash.clone(),
            evidence_reference: "fixture:runtime-attestation".into(),
        }),
        identity,
    });
}
