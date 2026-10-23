use crate::Error;
use agave_feature_set::{FEATURE_NAMES, FeatureSet};
use serde::{Deserialize, Serialize};
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    request::RpcRequest,
    response::{Response, RpcKeyedAccount},
};
use solana_svm_feature_set::SVMFeatureSet;
use std::{collections::BTreeSet, sync::LazyLock};

/// Active on devnet or mainnet, absent from agave-feature-set 4.3.2, 4.4.0-beta.1 and 4.5.0-alpha.2.
/// Their behaviour is unconditional in the pinned runtime; anything else unknown fails closed.
static RETIRED: LazyLock<BTreeSet<Pubkey>> = LazyLock::new(|| {
    include_str!("retired_features.txt")
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.parse().expect("retired feature id"))
        .collect()
});

/// Every feature account the cluster reported active at or before the observed slot.
/// Activations are append-only, so a later bank reproduces the observed bank's set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Features {
    pub slot: u64,
    pub active: Vec<(Pubkey, u64)>,
}

impl Features {
    pub fn runtime(&self, observed: u64) -> Result<SVMFeatureSet, Error> {
        // Observation records the observed slot itself; anything else was not produced here.
        if self.slot != observed || self.active.iter().any(|(_, at)| *at > observed) {
            return Err(Error::InvalidObservation(
                "feature evidence outside observed bank",
            ));
        }
        let mut set = FeatureSet::default();
        for (id, slot) in &self.active {
            if FEATURE_NAMES.contains_key(id) {
                set.activate(id, *slot);
            } else if !RETIRED.contains(id) {
                return Err(Error::InvalidObservation(
                    "feature unknown to the pinned runtime",
                ));
            }
        }
        Ok(set.runtime_features())
    }
}

pub async fn observe(client: &RpcClient, slot: u64) -> Result<Features, Error> {
    let response: Response<Vec<RpcKeyedAccount>> = client
        .send(
            RpcRequest::GetProgramAccounts,
            serde_json::json!([
                solana_sdk_ids::feature::id().to_string(),
                RpcProgramAccountsConfig {
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64),
                        commitment: Some(client.commitment()),
                        min_context_slot: Some(slot),
                        ..Default::default()
                    },
                    with_context: Some(true),
                    ..Default::default()
                }
            ]),
        )
        .await?;
    if response.context.slot < slot {
        return Err(Error::InvalidObservation(
            "feature bank precedes observation",
        ));
    }
    let mut active = Vec::new();
    for keyed in response.value {
        let id: Pubkey = keyed
            .pubkey
            .parse()
            .map_err(|_| Error::InvalidObservation("invalid feature address"))?;
        let account = keyed
            .account
            .to_account()
            .ok_or(Error::InvalidObservation("undecodable feature account"))?;
        if account.owner != solana_sdk_ids::feature::id() || account.lamports == 0 {
            return Err(Error::InvalidObservation("invalid feature account"));
        }
        // Feature { activated_at: Option<u64> } is the account's leading bincode value.
        let activated: Option<u64> = bincode::deserialize(&account.data)
            .map_err(|_| Error::InvalidObservation("invalid feature data"))?;
        if let Some(at) = activated.filter(|at| *at <= slot) {
            active.push((id, at));
        }
    }
    active.sort();
    // The set is the observed bank's, whichever later bank answered; recording the observed
    // slot keeps two observations of one bank identical.
    Ok(Features { slot, active })
}
