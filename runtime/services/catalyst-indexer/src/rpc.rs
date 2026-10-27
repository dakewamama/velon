use crate::{Coverage, Error, Journal, Observation, Origin, Record, Snapshot, Target};
use arm::{AuthorityKind, AuthorizationChange};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::post,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use cataloger::{Catalog, ProgramVersion};
use catalyst_sdk::{
    self as sdk, ActionKind, Adapter, Error as AdapterError, spl, subscriptions, token2022,
};
use mollusk_svm::{Mollusk, program::ProgramCache};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_clock::Clock;
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_program_runtime::execution_budget::SVMTransactionExecutionBudget;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{
        RpcAccountInfoConfig, RpcSimulateTransactionAccountsConfig, RpcSimulateTransactionConfig,
        RpcTransactionConfig,
    },
    request::RpcRequest,
    response::{Response, RpcSimulateTransactionResult},
};
use solana_sdk_ids::{bpf_loader_upgradeable, system_program, sysvar};
use solana_svm_feature_set::SVMFeatureSet;
use solana_transaction::Transaction;
use solana_transaction_status_client_types::{
    EncodedConfirmedTransactionWithStatusMeta, EncodedTransaction, TransactionBinaryEncoding,
    UiTransactionEncoding,
};
use spl_token_2022_interface::{
    extension::{StateWithExtensions, StateWithExtensionsMut},
    state::Account as TokenAccount,
};
use std::{collections::BTreeSet, sync::Arc};

/// Interpret an ELF in the loader environment that a cluster's activated features define.
pub fn executable_identity(
    elf: &[u8],
    features: &SVMFeatureSet,
) -> Result<cataloger::executable::ExecutableIdentity, Box<dyn std::error::Error>> {
    let loader = solana_syscalls::create_program_runtime_environment(
        features,
        &SVMTransactionExecutionBudget::new_with_defaults(features.raise_cpi_nesting_limit_to_8),
        false,
        false,
    )?;
    cataloger::executable::inspect(elf, Arc::clone(&loader))
}

#[derive(Serialize)]
pub struct Capture {
    pub cluster: String,
    pub observed_slot: u64,
    pub programdata_address: Pubkey,
    pub deployment_slot: u64,
    pub version: String,
    pub features: crate::features::Features,
    pub identity: cataloger::executable::ExecutableIdentity,
    pub runtime: cataloger::executable::RuntimeEvidence,
}

/// Fingerprint a loader-v3 program's finalized code under the cluster's activated features.
pub async fn capture(client: &RpcClient, program: Pubkey) -> Result<Capture, Error> {
    let programdata_address = get_program_data_address(&program);
    let keys = [program, programdata_address, sysvar::clock::id()];
    let response = client
        .get_multiple_accounts_with_commitment(&keys, CommitmentConfig::finalized())
        .await?;
    let [Some(_), Some(data), Some(clock_account)] = response.value.as_slice() else {
        return Err(Error::NotFound);
    };
    let clock = clock(
        &[(sysvar::clock::id(), clock_account.clone())],
        response.context.slot,
    )
    .map_err(|_| Error::InvalidObservation("invalid bank clock"))?;
    let offset = UpgradeableLoaderState::size_of_programdata_metadata();
    let Ok(UpgradeableLoaderState::ProgramData { slot, .. }) =
        bincode::deserialize(data.data.get(..offset).unwrap_or_default())
    else {
        return Err(AdapterError::InvalidState("loader programdata state".into()).into());
    };
    let features = crate::features::observe(client, clock.slot).await?;
    let identity = executable_identity(&data.data[offset..], &features.runtime(clock.slot)?)
        .map_err(|_| AdapterError::UnsupportedVersion)?;
    let cluster = client.get_genesis_hash().await?.to_string();
    let runtime = cataloger::executable::RuntimeEvidence {
        revision: cataloger::executable::AGAVE_REVISION.into(),
        environment_hash: identity.environment_hash.clone(),
        evidence_reference: format!(
            "features:{cluster}:{}:sha256:{:x}",
            features.slot,
            Sha256::digest(serde_json::to_vec(&features.active)?)
        ),
    };
    Ok(Capture {
        cluster,
        observed_slot: clock.slot,
        programdata_address,
        deployment_slot: slot,
        version: format!("sha256:{:x}", Sha256::digest(&data.data[offset..])),
        features,
        identity,
        runtime,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub cluster: String,
    pub accounts: Vec<Pubkey>,
    pub targets: Vec<Target>,
    pub min_context_slot: Option<u64>,
}

impl Scope {
    pub fn accounts(&self) -> Result<Vec<Pubkey>, Error> {
        if self.cluster.is_empty() || self.targets.is_empty() {
            return Err(Error::InvalidObservation("empty scope"));
        }
        let mut targets = BTreeSet::new();
        let mut keys: BTreeSet<_> = self.accounts.iter().copied().collect();
        keys.insert(sysvar::clock::id());
        keys.insert(spl::DelegateAdapter.protocol().program_id);
        for target in &self.targets {
            if !targets.insert(target.key()) {
                return Err(Error::InvalidObservation("duplicate target"));
            }
            match target {
                Target::SplDelegate { source } => {
                    keys.insert(*source);
                }
                Target::Token2022Delegate { source, mint } => {
                    keys.extend([*source, *mint]);
                    keys.insert(token2022::Token2022Adapter.protocol().program_id);
                }
                Target::Subscription {
                    delegation,
                    authority,
                    source,
                    mint,
                    plan,
                } => {
                    keys.extend([*delegation, *authority, *source, *mint]);
                    keys.extend(*plan);
                    keys.insert(subscriptions::DelegationAdapter.protocol().program_id);
                }
            }
        }
        for program in [
            spl::DelegateAdapter.protocol().program_id,
            token2022::Token2022Adapter.protocol().program_id,
            subscriptions::DelegationAdapter.protocol().program_id,
        ] {
            if keys.contains(&program) {
                keys.insert(get_program_data_address(&program));
            }
        }
        // Splitting the RPC limit into chunks would combine different banks.
        if keys.len() > 100 {
            return Err(Error::InvalidObservation("scope exceeds one RPC batch"));
        }
        Ok(keys.into_iter().collect())
    }
}

fn clock(accounts: &[(Pubkey, Account)], slot: u64) -> Result<Clock, AdapterError> {
    let account = accounts
        .iter()
        .find(|(key, _)| *key == sysvar::clock::id())
        .map(|(_, account)| account)
        .ok_or(AdapterError::InsufficientEvidence)?;
    if account.lamports == 0
        || account.owner != sysvar::id()
        || account.executable
        || account.data.len() != solana_clock::SIZE
    {
        return Err(AdapterError::InvalidState("clock account".into()));
    }
    let clock: Clock = bincode::deserialize(&account.data)
        .map_err(|_| AdapterError::InvalidState("clock data".into()))?;
    if clock.slot != slot {
        return Err(AdapterError::InvalidState(
            "clock/context slot mismatch".into(),
        ));
    }
    Ok(clock)
}

pub async fn observe(client: &RpcClient, scope: Scope) -> Result<Snapshot, Error> {
    let keys = scope.accounts()?;
    if !client.commitment().is_finalized() {
        return Err(Error::InvalidObservation("finalized commitment required"));
    }
    if client.get_genesis_hash().await?.to_string() != scope.cluster {
        return Err(Error::InvalidObservation("cluster genesis mismatch"));
    }
    let response = client
        .get_multiple_ui_accounts_with_config(
            &keys,
            RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                commitment: Some(client.commitment()),
                min_context_slot: scope.min_context_slot,
                ..Default::default()
            },
        )
        .await?;
    if response.value.len() != keys.len()
        || scope
            .min_context_slot
            .is_some_and(|minimum| response.context.slot < minimum)
    {
        return Err(Error::InvalidObservation("invalid finalized response"));
    }
    let accounts = keys
        .into_iter()
        .zip(response.value)
        .map(|(key, value)| {
            let account = match value {
                None => Account::default(),
                Some(value) => {
                    let account = value
                        .to_account()
                        .ok_or(Error::InvalidObservation("undecodable RPC account"))?;
                    if value
                        .space
                        .is_some_and(|space| space != account.data.len() as u64)
                    {
                        return Err(Error::InvalidObservation("truncated RPC account"));
                    }
                    account
                }
            };
            Ok((key, account))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let clock = clock(&accounts, response.context.slot)
        .map_err(|_| Error::InvalidObservation("invalid bank clock"))?;
    let features = crate::features::observe(client, clock.slot).await?;
    Ok(Snapshot {
        observation: Observation {
            cluster: scope.cluster,
            bank: format!("rpc:finalized:{}", clock.slot),
            slot: clock.slot,
            unix_timestamp: clock.unix_timestamp,
            origin: Origin::Finalized,
        },
        accounts,
        targets: scope.targets,
        features: Some(features),
    })
}

// The fixed budget prevents wallet-added fees from changing the reviewed message.
const REVOKE_UNIT_LIMIT: u32 = 10_000;
const REVOKE_UNIT_PRICE: u64 = 1_000_000;

fn revoke_transaction(action: &sdk::Action, payer: Pubkey) -> Transaction {
    let mut instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(REVOKE_UNIT_LIMIT),
        ComputeBudgetInstruction::set_compute_unit_price(REVOKE_UNIT_PRICE),
    ];
    instructions.extend_from_slice(&action.instructions);
    Transaction::new_with_payer(&instructions, Some(&payer))
}

#[derive(Serialize)]
pub struct SimulatedRevoke {
    pub id: String,
    pub state_version: String,
    pub observation: Observation,
    pub coverage: Coverage,
    pub versions: Vec<ProgramVersion>,
    pub runtime_version: String,
    pub sdk_revision: String,
    pub arm_schema_version: &'static str,
    pub transaction: Transaction,
    pub signing_transaction: String,
    pub config: RpcSimulateTransactionConfig,
    pub response: Response<RpcSimulateTransactionResult>,
    pub changes: Vec<AuthorizationChange>,
}

/// Simulate one canonical SPL revoke against the retained finalized bank.
/// The result is unsigned simulation evidence, never finalized journal state.
pub async fn simulate_revoke(
    client: &RpcClient,
    journal: &Journal,
    id: &str,
    source: Pubkey,
) -> Result<SimulatedRevoke, Error> {
    let record = journal.replay(id).await?;
    let snapshot = &record.snapshot;
    if snapshot.observation.origin != Origin::Finalized || !client.commitment().is_finalized() {
        return Err(Error::InvalidObservation("finalized evidence required"));
    }
    let token = Token::of(&snapshot.targets, source)?;
    if journal
        .latest(&snapshot.scope_id()?)
        .await?
        .is_none_or(|latest| latest.id != id)
    {
        return Err(Error::Conflict);
    }
    let (context, token_version) = token.context(snapshot, &record.versions, &record.id)?;
    let action = token.action(snapshot, (&context, &token_version), source)?;
    let payer = token.payer(snapshot, source, &action)?;
    let transaction = revoke_transaction(&action, payer);
    let mut keys = execution_keys(&action);
    // Revoke runs in the observed bank itself, so no provider bank has to coincide with it.
    let executed = execute_revoke(snapshot, &action, &keys, token.program())?;
    keys.push(sysvar::clock::id());
    let config = RpcSimulateTransactionConfig {
        sig_verify: false,
        replace_recent_blockhash: true,
        commitment: Some(client.commitment()),
        accounts: Some(RpcSimulateTransactionAccountsConfig {
            encoding: Some(UiAccountEncoding::Base64),
            addresses: keys.iter().map(ToString::to_string).collect(),
        }),
        min_context_slot: Some(snapshot.observation.slot),
        ..Default::default()
    };
    if client.get_genesis_hash().await?.to_string() != snapshot.observation.cluster {
        return Err(Error::InvalidObservation("cluster genesis mismatch"));
    }
    let response = client
        .simulate_transaction_with_config(&transaction, config.clone())
        .await?;
    if response.value.err.is_some() {
        return Err(Error::SimulationFailed(Box::new(response)));
    }
    // The provider simulates in its own later bank and must reach the same token data.
    if response.context.slot < snapshot.observation.slot {
        return Err(Error::InvalidObservation("simulation precedes observation"));
    }
    let values = response
        .value
        .accounts
        .as_ref()
        .filter(|values| values.len() == keys.len())
        .ok_or(Error::InvalidObservation("missing simulated accounts"))?;
    let mut simulated = Vec::new();
    for (key, value) in keys.into_iter().zip(values) {
        let account = match value {
            Some(value) => {
                let account = value
                    .to_account()
                    .ok_or(Error::InvalidObservation("undecodable RPC account"))?;
                if value
                    .space
                    .is_some_and(|space| space != account.data.len() as u64)
                {
                    return Err(Error::InvalidObservation("truncated RPC account"));
                }
                account
            }
            // A closed delegation is absent; a token account never is.
            None if key == source && !matches!(token, Token::Subscription { .. }) => {
                return Err(Error::InvalidObservation("missing simulated source"));
            }
            None => Account::default(),
        };
        simulated.push((key, account));
    }
    clock(&simulated, response.context.slot)
        .map_err(|_| Error::InvalidObservation("simulation/context slot mismatch"))?;
    let mut after = snapshot.clone();
    for (key, account) in &executed {
        let entry = after
            .accounts
            .iter_mut()
            .find(|(address, _)| address == key)
            .ok_or(AdapterError::InsufficientEvidence)?;
        entry.1 = account.clone();
    }
    let agrees = match token {
        Token::Spl | Token::Token2022 { .. } => {
            // The delegate projection omits owner authority; require Revoke's full token-data change.
            let expected = revoked(source_data(snapshot, source)?, token)?;
            source_data(&after, source)? == expected.as_slice() && simulated[0].1.data == expected
        }
        Token::Subscription { delegation, .. } => {
            // The provider's later bank must match every account but the fee payer's exactly,
            // and the delegation must no longer exist.
            let expected = closed(snapshot, &action)?;
            let agrees = |key: &Pubkey, expected: &Account, actual: &Account| {
                if *key == delegation {
                    is_closed(actual)
                } else {
                    expected == actual
                }
            };
            expected.len() == executed.len()
                && expected.iter().zip(&executed).all(
                    |((key, account), (executed_key, executed))| {
                        key == executed_key && agrees(key, account, executed)
                    },
                )
                && expected
                    .iter()
                    .zip(&simulated)
                    .all(|((key, account), (_, simulated))| {
                        *key == payer || agrees(key, account, simulated)
                    })
        }
    };
    if !agrees {
        return Err(AdapterError::DiffMismatch.into());
    }
    let simulation_id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &record.id,
            &transaction,
            &config,
            &response
        ))?)
    );
    let mut observed = context.clone();
    observed
        .evidence
        .references
        .push(format!("simulation:sha256:{simulation_id}"));
    observed.evidence.observed_at = format!(
        "{}:execution:{}",
        snapshot.observation.cluster, snapshot.observation.slot
    );
    let changes = token.changes(
        &action,
        (snapshot, &context, &token_version),
        (&after, &observed, &token_version),
        source,
    )?;
    let replacement = response
        .value
        .replacement_blockhash
        .as_ref()
        .filter(|replacement| replacement.last_valid_block_height > 0)
        .ok_or(Error::InvalidObservation(
            "missing simulation blockhash lifetime",
        ))?;
    let mut signing_transaction = transaction.clone();
    signing_transaction.message.recent_blockhash = replacement
        .blockhash
        .parse()
        .map_err(|_| Error::InvalidObservation("invalid simulation blockhash"))?;
    if signing_transaction.message.recent_blockhash == Default::default() {
        return Err(Error::InvalidObservation("invalid simulation blockhash"));
    }
    let signing_transaction = STANDARD.encode(
        bincode::serialize(&signing_transaction)
            .map_err(|_| Error::InvalidObservation("transaction encoding failed"))?,
    );
    // A checkpoint observed during RPC must invalidate the older simulation input.
    if journal
        .latest(&snapshot.scope_id()?)
        .await?
        .is_none_or(|latest| latest.id != id)
    {
        return Err(Error::Conflict);
    }
    Ok(SimulatedRevoke {
        id: simulation_id,
        state_version: record.id,
        observation: snapshot.observation.clone(),
        coverage: Coverage {
            complete: false,
            accounts: snapshot.accounts.iter().map(|(key, _)| *key).collect(),
            targets: snapshot.targets.clone(),
        },
        versions: record.versions,
        runtime_version: record.runtime_version,
        sdk_revision: record.sdk_revision,
        arm_schema_version: arm::SCHEMA_VERSION,
        transaction,
        signing_transaction,
        config,
        response,
        changes,
    })
}

/// The program a revocable target belongs to. A Token-2022 account's first 165 bytes use
/// SPL Token's account layout, so the base fields read and change the same way for both.
/// A subscription grant is keyed by its delegation account, which RevokeDelegation closes.
#[derive(Clone, Copy)]
enum Token {
    Spl,
    Token2022 {
        mint: Pubkey,
    },
    Subscription {
        delegation: Pubkey,
        authority: Pubkey,
        source: Pubkey,
        mint: Pubkey,
        plan: Option<Pubkey>,
    },
}

impl Token {
    /// The snapshot's single revocable target, which must name `source`.
    fn of(targets: &[Target], source: Pubkey) -> Result<Self, Error> {
        match Self::source(targets)? {
            (key, token) if key == source => Ok(token),
            _ => Err(AdapterError::UnsupportedOperation.into()),
        }
    }

    fn source(targets: &[Target]) -> Result<(Pubkey, Self), Error> {
        match targets {
            [Target::SplDelegate { source }] => Ok((*source, Self::Spl)),
            [Target::Token2022Delegate { source, mint }] => {
                Ok((*source, Self::Token2022 { mint: *mint }))
            }
            [
                Target::Subscription {
                    delegation,
                    authority,
                    source,
                    mint,
                    plan,
                },
            ] => Ok((
                *delegation,
                Self::Subscription {
                    delegation: *delegation,
                    authority: *authority,
                    source: *source,
                    mint: *mint,
                    plan: *plan,
                },
            )),
            _ => Err(AdapterError::UnsupportedOperation.into()),
        }
    }

    fn program(self) -> Pubkey {
        match self {
            Self::Spl => spl::DelegateAdapter.protocol().program_id,
            Self::Token2022 { .. } => token2022::Token2022Adapter.protocol().program_id,
            Self::Subscription { .. } => subscriptions::DelegationAdapter.protocol().program_id,
        }
    }

    /// The target program's context and the version of the token program it spends through,
    /// both resolved from the reviewed catalog. A subscription verifies both deployments.
    fn context(
        self,
        snapshot: &Snapshot,
        versions: &[ProgramVersion],
        id: &str,
    ) -> Result<(sdk::Context, String), Error> {
        let catalog = Catalog::new(versions.to_vec()).map_err(|_| Error::ReplayMismatch)?;
        if let Self::Subscription { .. } = self {
            let (context, token) =
                crate::subscription_contexts(snapshot, &catalog, id, &mut Vec::new())?;
            return Ok((context, token.native.program_version));
        }
        let context = crate::context(self.program(), snapshot, &catalog, id, &mut Vec::new())?;
        let version = context.native.program_version.clone();
        Ok((context, version))
    }

    /// The owner-signed Revoke of the account's delegate, or the delegator-signed
    /// RevokeDelegation of an ended subscription.
    fn action(
        self,
        snapshot: &Snapshot,
        (context, token_version): (&sdk::Context, &str),
        source: Pubkey,
    ) -> Result<sdk::Action, Error> {
        match self {
            Self::Spl => {
                let adapter = spl::DelegateAdapter;
                let state = crate::spl_state(snapshot, source)?;
                let authorization = sdk::compile_state(&adapter, &state, context)?
                    .into_iter()
                    .next()
                    .ok_or(Error::NotFound)?;
                Ok(sdk::actions(&adapter, &authorization, &state, context)?.remove(0))
            }
            Self::Token2022 { mint } => {
                let adapter = token2022::Token2022Adapter;
                let state = crate::token2022_state(snapshot, source, mint)?;
                // The mint's permanent delegate is not revocable; only the account's delegate is.
                let authorization = sdk::compile_state(&adapter, &state, context)?
                    .into_iter()
                    .find(|authorization| {
                        authorization.resource.namespace == "solana:token-account"
                    })
                    .ok_or(Error::NotFound)?;
                // Actions list the owner's revoke first, then the delegate's own.
                Ok(sdk::actions(&adapter, &authorization, &state, context)?.remove(0))
            }
            Self::Subscription { delegation, .. } => {
                let adapter = subscriptions::DelegationAdapter;
                let state = self.state(snapshot, token_version)?;
                let authorization = sdk::compile_state(&adapter, &state, context)?
                    .into_iter()
                    .find(|authorization| {
                        matches!(authorization.authority_kind, AuthorityKind::Derived { .. })
                    })
                    .ok_or(Error::NotFound)?;
                // An active or not yet ended subscription can only be cancelled, which keeps
                // the grant; only an ended one closes.
                let action = sdk::actions(&adapter, &authorization, &state, context)?
                    .into_iter()
                    .find(|action| action.kind == ActionKind::Revoke)
                    .ok_or(AdapterError::UnsupportedOperation)?;
                match action.instructions.as_slice() {
                    [instruction]
                        if instruction.program_id == self.program()
                            && instruction.data == [REVOKE_DELEGATION]
                            && instruction.accounts.len() >= 2
                            && instruction.accounts[0].is_signer
                            && instruction.accounts[1].pubkey == delegation =>
                    {
                        Ok(action)
                    }
                    _ => Err(AdapterError::DiffMismatch.into()),
                }
            }
        }
    }

    fn state(
        self,
        snapshot: &Snapshot,
        token_version: &str,
    ) -> Result<subscriptions::DelegationState, Error> {
        let Self::Subscription {
            delegation,
            authority,
            source,
            mint,
            plan,
        } = self
        else {
            return Err(AdapterError::UnsupportedOperation.into());
        };
        Ok(crate::subscription_state(
            snapshot,
            delegation,
            authority,
            source,
            mint,
            plan,
            token_version.into(),
        )?)
    }

    /// The transaction's fee payer and only signer: the token account's owner, or the delegator.
    fn payer(
        self,
        snapshot: &Snapshot,
        source: Pubkey,
        action: &sdk::Action,
    ) -> Result<Pubkey, Error> {
        match self {
            Self::Spl | Self::Token2022 { .. } => owner_of(source_data(snapshot, source)?),
            Self::Subscription { .. } => Ok(action.instructions[0].accounts[0].pubkey),
        }
    }

    /// What the revoke removed, checked by the adapter against both observations.
    fn changes(
        self,
        action: &sdk::Action,
        before: (&Snapshot, &sdk::Context, &str),
        after: (&Snapshot, &sdk::Context, &str),
        source: Pubkey,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        Ok(match self {
            Self::Spl => sdk::verify_transaction_diff(
                &spl::DelegateAdapter,
                &action.instructions,
                &crate::spl_state(before.0, source)?,
                before.1,
                &crate::spl_state(after.0, source)?,
                after.1,
            )?,
            Self::Token2022 { mint } => sdk::verify_transaction_diff(
                &token2022::Token2022Adapter,
                &action.instructions,
                &crate::token2022_state(before.0, source, mint)?,
                before.1,
                &crate::token2022_state(after.0, source, mint)?,
                after.1,
            )?,
            Self::Subscription { .. } => sdk::verify_transaction_diff(
                &subscriptions::DelegationAdapter,
                &action.instructions,
                &self.state(before.0, before.2)?,
                before.1,
                &self.state(after.0, after.2)?,
                after.1,
            )?,
        })
    }

    /// The state Revoke must leave: SPL Token and Token-2022 clear the account's delegate, while
    /// RevokeDelegation closes the delegation account.
    fn check_revoked(
        self,
        before: &Snapshot,
        after: &Snapshot,
        source: Pubkey,
    ) -> Result<(), Error> {
        let cleared = match self {
            Self::Spl | Self::Token2022 { .. } => {
                source_data(after, source)? == revoked(source_data(before, source)?, self)?
            }
            Self::Subscription { delegation, .. } => is_closed(account(after, delegation)?),
        };
        if !cleared {
            return Err(AdapterError::DiffMismatch.into());
        }
        Ok(())
    }
}

/// RevokeDelegation's discriminator in the pinned Subscriptions program.
const REVOKE_DELEGATION: u8 = 3;

/// The accounts the reviewed instruction names, in order. Revoke reads nothing else.
fn execution_keys(action: &sdk::Action) -> Vec<Pubkey> {
    action
        .instructions
        .iter()
        .flat_map(|instruction| instruction.accounts.iter().map(|meta| meta.pubkey))
        .collect()
}

/// The accounts after RevokeDelegation: the delegation closed and its lamports credited to the
/// rent recipient, the sponsoring payer if named and otherwise the delegator. Nothing else
/// changes.
fn closed(snapshot: &Snapshot, action: &sdk::Action) -> Result<Vec<(Pubkey, Account)>, Error> {
    let [instruction] = action.instructions.as_slice() else {
        return Err(AdapterError::DiffMismatch.into());
    };
    let delegation = instruction.accounts[1].pubkey;
    let recipient = instruction.accounts[2..]
        .iter()
        .find(|meta| meta.is_writable)
        .unwrap_or(&instruction.accounts[0])
        .pubkey;
    let rent = account(snapshot, delegation)?.lamports;
    let mut accounts = Vec::new();
    for key in execution_keys(action) {
        let mut account = account(snapshot, key)?.clone();
        if key == delegation {
            account = Account::default();
        } else if key == recipient {
            account.lamports = account
                .lamports
                .checked_add(rent)
                .ok_or(AdapterError::InvalidState("rent recipient lamports".into()))?;
        }
        accounts.push((key, account));
    }
    Ok(accounts)
}

/// A closed account no longer exists: no lamports, no data, owned by the system program and not
/// executable. Its rent epoch is not account state; providers report the exempt sentinel for it.
fn is_closed(account: &Account) -> bool {
    account.lamports == 0
        && account.data.is_empty()
        && account.owner == system_program::id()
        && !account.executable
}

fn account(snapshot: &Snapshot, key: Pubkey) -> Result<&Account, Error> {
    Ok(&snapshot
        .accounts
        .iter()
        .find(|(address, _)| *address == key)
        .ok_or(AdapterError::InsufficientEvidence)?
        .1)
}

fn source_data(snapshot: &Snapshot, source: Pubkey) -> Result<&[u8], Error> {
    Ok(&account(snapshot, source)?.data)
}

fn owner_of(data: &[u8]) -> Result<Pubkey, Error> {
    Ok(StateWithExtensions::<TokenAccount>::unpack(data)
        .map_err(|error| AdapterError::InvalidState(error.to_string()))?
        .base
        .owner)
}

/// The account's bytes after Revoke: delegate and allowance cleared, everything else, including
/// any extensions, unchanged. SPL Token clears only the delegate's option tag and leaves the old
/// key in place; Token-2022 writes its pod `None`, which zeroes the key as well.
fn revoked(data: &[u8], token: Token) -> Result<Vec<u8>, Error> {
    const DELEGATE_KEY: std::ops::Range<usize> = 76..108;
    let mut data = data.to_vec();
    let mut account = StateWithExtensionsMut::<TokenAccount>::unpack(&mut data)
        .map_err(|error| AdapterError::InvalidState(error.to_string()))?;
    account.base.delegate = None.into();
    account.base.delegated_amount = 0;
    account.pack_base();
    if let Token::Token2022 { .. } = token {
        data[DELEGATE_KEY].fill(0);
    }
    Ok(data)
}

/// Run the canonical Revoke through the verified token program under the observed features.
fn execute_revoke(
    snapshot: &Snapshot,
    action: &sdk::Action,
    keys: &[Pubkey],
    program: Pubkey,
) -> Result<Vec<(Pubkey, Account)>, Error> {
    let features = snapshot
        .features
        .as_ref()
        .ok_or(AdapterError::InsufficientEvidence)?
        .runtime(snapshot.observation.slot)?;
    let offset = UpgradeableLoaderState::size_of_programdata_metadata();
    let elf = snapshot
        .accounts
        .iter()
        .find(|(key, _)| *key == get_program_data_address(&program))
        .and_then(|(_, account)| account.data.get(offset..))
        .ok_or(AdapterError::InsufficientEvidence)?;
    let mut compute_budget =
        ComputeBudget::new_with_defaults(features.raise_cpi_nesting_limit_to_8);
    // The transaction's two compute-budget instructions use 150 units each before Revoke runs.
    compute_budget.compute_unit_limit = (REVOKE_UNIT_LIMIT - 2 * 150).into();
    let mut mollusk = Mollusk {
        compute_budget,
        ..Default::default()
    };
    mollusk.program_cache = ProgramCache::new(&features, &mollusk.compute_budget, false);
    mollusk.feature_set = features;
    mollusk.sysvars.clock = clock(&snapshot.accounts, snapshot.observation.slot)?;
    mollusk.add_program_with_loader_and_elf(&program, &bpf_loader_upgradeable::id(), elf);
    let accounts: Vec<_> = keys
        .iter()
        .map(|key| {
            snapshot
                .accounts
                .iter()
                .find(|(address, _)| address == key)
                .cloned()
                .ok_or(AdapterError::InsufficientEvidence)
        })
        .collect::<Result<_, _>>()?;
    let result = mollusk.process_instruction_chain(&action.instructions, &accounts);
    // Rent-state and other post-execution failures surface only in program_result.
    if result.raw_result.is_err() || !result.program_result.is_ok() {
        return Err(Error::InvalidObservation("native execution failed"));
    }
    Ok(result.resulting_accounts)
}

pub const CURRENT_BANK_ATTEMPTS: usize = 8;

/// Observe the scope's finalized bank, then simulate one revoke in that same bank.
/// Finalized slots advance between requests, so a retained record cannot be simulated later.
pub async fn simulate_current_revoke(
    client: &RpcClient,
    journal: &Journal,
    scope_id: &str,
    source: Pubkey,
) -> Result<SimulatedRevoke, Error> {
    for _ in 0..CURRENT_BANK_ATTEMPTS {
        let record = journal.latest(scope_id).await?.ok_or(Error::NotFound)?;
        let snapshot = record.snapshot;
        if snapshot.observation.origin != Origin::Finalized {
            return Err(Error::InvalidObservation("finalized evidence required"));
        }
        Token::of(&snapshot.targets, source)?;
        let catalog = Catalog::new(record.versions).map_err(|_| Error::ReplayMismatch)?;
        let current = match observe(
            client,
            Scope {
                cluster: snapshot.observation.cluster,
                accounts: snapshot.accounts.iter().map(|(key, _)| *key).collect(),
                targets: snapshot.targets,
                min_context_slot: Some(snapshot.observation.slot),
            },
        )
        .await
        {
            // A node can answer with a Clock from the bank next to the one it names; read again.
            Err(Error::InvalidObservation("invalid bank clock")) => continue,
            current => current?,
        };
        let id = journal.ingest(current, &catalog).await?.id;
        match simulate_revoke(client, journal, &id, source).await {
            Err(Error::InvalidObservation("simulation/context slot mismatch")) => continue,
            result => return result,
        }
    }
    Err(Error::InvalidObservation(
        "simulation/context slot mismatch",
    ))
}

#[derive(Serialize)]
pub struct VerifiedRevoke {
    pub verification_id: String,
    pub state_version: String,
    pub transaction: EncodedConfirmedTransactionWithStatusMeta,
    pub observation: Record,
    pub changes: Vec<AuthorizationChange>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeEvidence {
    state_version: String,
    observation_id: String,
    transaction: EncodedConfirmedTransactionWithStatusMeta,
}

impl Journal {
    pub async fn replay_revoke(&self, id: &str) -> Result<VerifiedRevoke, Error> {
        let raw: String =
            sqlx::query_scalar("SELECT evidence FROM revoke_verifications WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.database)
                .await?
                .ok_or(Error::NotFound)?;
        if format!("{:x}", Sha256::digest(raw.as_bytes())) != id {
            return Err(Error::ReplayMismatch);
        }
        let evidence: RevokeEvidence = serde_json::from_str(&raw)?;
        let record = self
            .replay(&evidence.state_version)
            .await
            .map_err(|error| match error {
                Error::NotFound => Error::ReplayMismatch,
                error => error,
            })?;
        let observation =
            self.replay(&evidence.observation_id)
                .await
                .map_err(|error| match error {
                    Error::NotFound => Error::ReplayMismatch,
                    error => error,
                })?;
        let (source, _) =
            Token::source(&record.snapshot.targets).map_err(|_| Error::ReplayMismatch)?;
        let signed = evidence
            .transaction
            .transaction
            .transaction
            .decode()
            .and_then(|transaction| transaction.into_legacy_transaction())
            .ok_or(Error::ReplayMismatch)?;
        let action = checked_revoke(&record, source, &signed).map_err(|_| Error::ReplayMismatch)?;
        check_receipt(
            &evidence.transaction,
            &signed,
            record.snapshot.observation.slot,
        )
        .map_err(|_| Error::ReplayMismatch)?;
        let changes = revoke_changes(&record, &observation, &action, evidence.transaction.slot)
            .map_err(|_| Error::ReplayMismatch)?;
        Ok(VerifiedRevoke {
            verification_id: id.into(),
            state_version: record.id,
            transaction: evidence.transaction,
            observation,
            changes,
        })
    }
}

pub(crate) async fn retained_revoke(
    State(journal): State<Journal>,
    Path(id): Path<String>,
) -> Result<Json<VerifiedRevoke>, (StatusCode, Json<serde_json::Value>)> {
    journal.replay_revoke(&id).await.map(Json).map_err(|error| {
        if matches!(error, Error::NotFound) {
            action_error(error)
        } else {
            action_error(Error::ReplayMismatch)
        }
    })
}

fn checked_revoke(
    record: &Record,
    source: Pubkey,
    signed: &Transaction,
) -> Result<sdk::Action, Error> {
    let snapshot = &record.snapshot;
    if snapshot.observation.origin != Origin::Finalized {
        return Err(Error::InvalidObservation("finalized evidence required"));
    }
    let token = Token::of(&snapshot.targets, source)?;
    signed
        .verify()
        .map_err(|_| Error::InvalidObservation("invalid transaction signature"))?;
    let (context, token_version) = token.context(snapshot, &record.versions, &record.id)?;
    let action = token.action(snapshot, (&context, &token_version), source)?;
    let payer = token.payer(snapshot, source, &action)?;
    // Earlier receipts contain only Revoke; both historical formats remain exact.
    let mut expected = if signed.message.instructions.len() == 1 {
        Transaction::new_with_payer(&action.instructions, Some(&payer))
    } else {
        revoke_transaction(&action, payer)
    };
    expected.message.recent_blockhash = signed.message.recent_blockhash;
    if signed.message != expected.message {
        return Err(AdapterError::DiffMismatch.into());
    }
    Ok(action)
}

fn check_receipt(
    transaction: &EncodedConfirmedTransactionWithStatusMeta,
    signed: &Transaction,
    before_slot: u64,
) -> Result<(), Error> {
    let executed = transaction
        .transaction
        .transaction
        .decode()
        .and_then(|transaction| transaction.into_legacy_transaction())
        .ok_or(Error::InvalidObservation("invalid finalized transaction"))?;
    if executed != *signed || transaction.slot <= before_slot {
        return Err(Error::InvalidObservation("finalized transaction mismatch"));
    }
    let meta = transaction
        .transaction
        .meta
        .as_ref()
        .ok_or(Error::InvalidObservation(
            "missing transaction execution metadata",
        ))?;
    if meta.err.is_some() || meta.status.is_err() {
        return Err(Error::InvalidObservation("finalized transaction failed"));
    }
    Ok(())
}

fn revoke_changes(
    record: &Record,
    observation: &Record,
    action: &sdk::Action,
    transaction_slot: u64,
) -> Result<Vec<AuthorizationChange>, Error> {
    let snapshot = &record.snapshot;
    let after = &observation.snapshot;
    if after.observation.origin != Origin::Finalized
        || after.scope_id()? != snapshot.scope_id()?
        || after.observation.slot < transaction_slot
    {
        return Err(Error::InvalidObservation("revoke observation mismatch"));
    }
    let (source, token) = Token::source(&snapshot.targets)?;
    let (context, token_version) = token.context(snapshot, &record.versions, &record.id)?;
    // The later observation is checked against the catalog the revoke was reviewed with.
    let (after_context, after_version) = token.context(after, &record.versions, &observation.id)?;
    token.check_revoked(snapshot, after, source)?;
    token.changes(
        action,
        (snapshot, &context, &token_version),
        (after, &after_context, &after_version),
        source,
    )
}

/// Verify a finalized canonical revoke and a later scoped observation.
/// The observation is not the transaction's immediate post-state.
pub async fn verify_revoke(
    client: &RpcClient,
    journal: &Journal,
    id: &str,
    source: Pubkey,
    signed_transaction: &str,
) -> Result<VerifiedRevoke, Error> {
    let record = journal.replay(id).await?;
    let snapshot = &record.snapshot;
    if snapshot.observation.origin != Origin::Finalized || !client.commitment().is_finalized() {
        return Err(Error::InvalidObservation("finalized evidence required"));
    }
    Token::of(&snapshot.targets, source)?;
    let signed =
        EncodedTransaction::Binary(signed_transaction.into(), TransactionBinaryEncoding::Base64)
            .decode()
            .and_then(|transaction| transaction.into_legacy_transaction())
            .ok_or(Error::InvalidObservation(
                "invalid signed legacy transaction",
            ))?;
    let supplied = STANDARD
        .decode(signed_transaction)
        .map_err(|_| Error::InvalidObservation("invalid transaction encoding"))?;
    let canonical = bincode::serialize(&signed)
        .map_err(|_| Error::InvalidObservation("transaction encoding failed"))?;
    if supplied != canonical {
        return Err(Error::InvalidObservation("noncanonical signed transaction"));
    }
    let action = checked_revoke(&record, source, &signed)?;
    let catalog = Catalog::new(record.versions.clone()).map_err(|_| Error::ReplayMismatch)?;
    if client.get_genesis_hash().await?.to_string() != snapshot.observation.cluster {
        return Err(Error::InvalidObservation("cluster genesis mismatch"));
    }
    let transaction: Option<EncodedConfirmedTransactionWithStatusMeta> = client
        .send(
            RpcRequest::GetTransaction,
            serde_json::json!([
                signed.signatures[0].to_string(),
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(client.commitment()),
                    max_supported_transaction_version: None,
                }
            ]),
        )
        .await?;
    let transaction = transaction.ok_or(Error::NotFound)?;
    check_receipt(&transaction, &signed, snapshot.observation.slot)?;
    let after = observe(
        client,
        Scope {
            cluster: snapshot.observation.cluster.clone(),
            accounts: snapshot.accounts.iter().map(|(key, _)| *key).collect(),
            targets: snapshot.targets.clone(),
            min_context_slot: Some(transaction.slot),
        },
    )
    .await?;
    // Retain upgrades and incomplete evidence too, so stale grants stop being current.
    let observation = journal.ingest(after, &catalog).await?;
    let changes = revoke_changes(&record, &observation, &action, transaction.slot)?;
    if journal
        .latest(&snapshot.scope_id()?)
        .await?
        .is_none_or(|latest| latest.id != observation.id)
    {
        return Err(Error::Conflict);
    }
    let evidence = RevokeEvidence {
        state_version: record.id,
        observation_id: observation.id.clone(),
        transaction,
    };
    let raw = serde_json::to_string(&evidence)?;
    let verification_id = format!("{:x}", Sha256::digest(raw.as_bytes()));
    sqlx::query(
        "INSERT INTO revoke_verifications (id, evidence) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(&verification_id)
    .bind(&raw)
    .execute(&journal.database)
    .await?;
    let retained: String =
        sqlx::query_scalar("SELECT evidence FROM revoke_verifications WHERE id = ?")
            .bind(&verification_id)
            .fetch_one(&journal.database)
            .await?;
    if retained != raw {
        return Err(Error::ReplayMismatch);
    }
    Ok(VerifiedRevoke {
        verification_id,
        state_version: evidence.state_version,
        transaction: evidence.transaction,
        observation,
        changes,
    })
}

pub fn action_router(journal: Journal, client: RpcClient) -> Router {
    Router::new()
        .route("/snapshots/:id/actions/revoke/:source", post(revoke))
        .route("/snapshots/:id/actions/revoke/:source/verify", post(verify))
        .route(
            "/scopes/:scope_id/actions/revoke/:source",
            post(current_revoke),
        )
        .with_state((journal, Arc::new(client)))
}

async fn current_revoke(
    State((journal, client)): State<(Journal, Arc<RpcClient>)>,
    Path((scope_id, source)): Path<(String, String)>,
) -> Result<Json<SimulatedRevoke>, (StatusCode, Json<serde_json::Value>)> {
    let source = source.parse().map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid account address"})),
        )
    })?;
    simulate_current_revoke(&client, &journal, &scope_id, source)
        .await
        .map(Json)
        .map_err(action_error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedRevoke {
    signed_transaction: String,
}

async fn verify(
    State((journal, client)): State<(Journal, Arc<RpcClient>)>,
    Path((id, source)): Path<(String, String)>,
    Json(request): Json<SignedRevoke>,
) -> Result<Json<VerifiedRevoke>, (StatusCode, Json<serde_json::Value>)> {
    let source = source.parse().map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid account address"})),
        )
    })?;
    verify_revoke(&client, &journal, &id, source, &request.signed_transaction)
        .await
        .map(Json)
        .map_err(action_error)
}

async fn revoke(
    State((journal, client)): State<(Journal, Arc<RpcClient>)>,
    Path((id, source)): Path<(String, String)>,
) -> Result<Json<SimulatedRevoke>, (StatusCode, Json<serde_json::Value>)> {
    let source = source.parse().map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid account address"})),
        )
    })?;
    simulate_revoke(&client, &journal, &id, source)
        .await
        .map(Json)
        .map_err(action_error)
}

fn action_error(error: Error) -> (StatusCode, Json<serde_json::Value>) {
    let status = match &error {
        Error::NotFound => StatusCode::NOT_FOUND,
        Error::Conflict
        | Error::AmbiguousScope
        | Error::InvalidObservation("simulation/context slot mismatch") => StatusCode::CONFLICT,
        Error::Rpc(_) => StatusCode::BAD_GATEWAY,
        Error::Adapter(_) | Error::InvalidObservation(_) | Error::SimulationFailed(_) => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let body = match error {
        Error::SimulationFailed(response) => {
            serde_json::json!({"error": "Native simulation failed", "response": response})
        }
        _ if status == StatusCode::INTERNAL_SERVER_ERROR => {
            serde_json::json!({"error": "Journal verification failed"})
        }
        Error::Rpc(_) => serde_json::json!({"error": "RPC provider unavailable"}),
        error => serde_json::json!({"error": error.to_string()}),
    };
    (status, Json(body))
}

pub(crate) fn verify_program(
    snapshot: &Snapshot,
    version: &ProgramVersion,
) -> Result<(), AdapterError> {
    let observed = &snapshot.observation;
    if clock(&snapshot.accounts, observed.slot)?.unix_timestamp != observed.unix_timestamp {
        return Err(AdapterError::InvalidState(
            "clock timestamp mismatch".into(),
        ));
    }
    let account = |key| {
        snapshot
            .accounts
            .iter()
            .find(|(address, _)| *address == key)
            .map(|(_, account)| account)
            .ok_or(AdapterError::InsufficientEvidence)
    };
    let program = account(version.program_id)?;
    if program.owner != bpf_loader_upgradeable::id() {
        return Err(AdapterError::UnsupportedVersion);
    }
    if program.lamports == 0
        || !program.executable
        || program.data.len() != UpgradeableLoaderState::size_of_program()
    {
        return Err(AdapterError::InvalidState("loader program account".into()));
    }
    let state: UpgradeableLoaderState = bincode::deserialize(&program.data)
        .map_err(|_| AdapterError::InvalidState("loader program data".into()))?;
    let UpgradeableLoaderState::Program {
        programdata_address,
    } = state
    else {
        return Err(AdapterError::InvalidState("loader program state".into()));
    };
    if programdata_address != get_program_data_address(&version.program_id) {
        return Err(AdapterError::InvalidState(
            "loader programdata address".into(),
        ));
    }
    let data = account(programdata_address)?;
    let offset = UpgradeableLoaderState::size_of_programdata_metadata();
    if data.lamports == 0
        || data.owner != bpf_loader_upgradeable::id()
        || data.executable
        || data.data.len() <= offset
    {
        return Err(AdapterError::InvalidState(
            "loader programdata account".into(),
        ));
    }
    let state: UpgradeableLoaderState = bincode::deserialize(&data.data[..offset])
        .map_err(|_| AdapterError::InvalidState("loader programdata metadata".into()))?;
    let UpgradeableLoaderState::ProgramData { slot, .. } = state else {
        return Err(AdapterError::InvalidState(
            "loader programdata state".into(),
        ));
    };
    // Loader-v3 activates new code in the slot after its deployment.
    if slot >= observed.slot
        || version.deployment != format!("solana:loader-v3:{programdata_address}:{slot}")
        || version.version != format!("sha256:{:x}", Sha256::digest(&data.data[offset..]))
    {
        return Err(AdapterError::UnsupportedVersion);
    }
    let features = snapshot
        .features
        .as_ref()
        .ok_or(AdapterError::InsufficientEvidence)?
        .runtime(observed.slot)
        .map_err(|_| AdapterError::UnsupportedVersion)?;
    let identity = executable_identity(&data.data[offset..], &features)
        .map_err(|_| AdapterError::UnsupportedVersion)?;
    version
        .verify_execution(programdata_address, observed.slot, &identity)
        .map_err(|error| match error {
            cataloger::Error::InsufficientExecutableEvidence => AdapterError::InsufficientEvidence,
            _ => AdapterError::UnsupportedVersion,
        })?;
    Ok(())
}
