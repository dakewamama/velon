use crate::{Action, ActionKind, Adapter, Context, Error, Protocol, SourceRequirements};
use arm::*;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface::{
    instruction,
    state::{Account as TokenAccount, Mint},
};

pub const PROGRAM_VERSION: &str =
    "sha256:8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697";
pub const DEPLOYMENT: &str = "fixture:mollusk:token:0.15.1";
pub const LIVE_DEPLOYMENT: &str =
    "solana:loader-v3:3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2:419472000";
pub const DEVNET_DEPLOYMENT: &str =
    "solana:loader-v3:3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2:451008000";

pub struct DelegateAdapter;

pub struct MintAdapter;

pub struct CloseAdapter;

pub struct AuthorityState {
    pub address: Pubkey,
    pub account: Account,
    pub authorities: Vec<(Pubkey, Account)>,
}

fn reset_close_authority(state: &AuthorityState) -> Result<Instruction, Error> {
    let account = decode(&state.account)?;
    let authority =
        Option::<Pubkey>::from(account.close_authority).ok_or(Error::UnsupportedOperation)?;
    if account.is_frozen() || account.is_owned_by_system_program_or_incinerator() {
        return Err(Error::UnsupportedOperation);
    }
    check_authority(state, authority)?;
    instruction::set_authority(
        &spl_token_interface::id(),
        &state.address,
        None,
        instruction::AuthorityType::CloseAccount,
        &authority,
        &[],
    )
    .map_err(|error| Error::InvalidState(error.to_string()))
}

impl Adapter for CloseAdapter {
    type State = AuthorityState;

    fn protocol(&self) -> Protocol {
        DelegateAdapter.protocol()
    }

    fn supports(&self, native: &NativeContext) -> bool {
        DelegateAdapter.supports(native)
    }

    fn source_requirements(&self, state: &AuthorityState) -> SourceRequirements {
        let mut accounts = vec![state.address];
        if let Ok(account) = decode(&state.account) {
            let authority = account.close_authority.unwrap_or(account.owner);
            for key in [authority, account.owner] {
                if !accounts.contains(&key) {
                    accounts.push(key);
                }
            }
        }
        SourceRequirements {
            accounts,
            clock: false,
        }
    }

    fn compile_state(
        &self,
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<Authorization>, Error> {
        if state.account.owner == Pubkey::default()
            && !state.account.executable
            && state.account.lamports == 0
            && state.account.data.is_empty()
        {
            return Ok(vec![]);
        }
        let account = decode(&state.account)?;
        // Native system/incinerator ownership bypasses signer checks and restricts the recipient.
        if account.is_owned_by_system_program_or_incinerator() {
            return Err(Error::UnsupportedOperation);
        }
        let authority = account.close_authority.unwrap_or(account.owner);
        check_authority(state, authority)?;
        let resource = Resource {
            namespace: "solana:token-account".into(),
            id: state.address.to_string(),
        };
        Ok(vec![Authorization {
            schema_version: SCHEMA_VERSION.into(),
            id: format!("{}:{}:close", context.program_id, state.address),
            subject: Subject::Resource(resource.clone()),
            principal: Principal::Identity(authority.to_string()),
            resource,
            capability: Capability::Close,
            constraints: ConstraintExpr::True,
            usage: UsageSemantics::OneShot {
                consumed: Some(false),
            },
            lifecycle: Lifecycle::Active {
                valid_from: None,
                valid_until: None,
            },
            delegability: Delegability::Unknown,
            authority_kind: AuthorityKind::Direct,
            enforcement: Enforcement::Native,
            observability: Observability::Exact,
            evidence: context.evidence.clone(),
            native_context: context.native.clone(),
        }])
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        if instructions != [reset_close_authority(state)?] {
            return Err(Error::UnsupportedOperation);
        }
        let before = self.compile_state(state, context)?.remove(0);
        let account = decode(&state.account)?;
        check_authority(state, account.owner)?;
        let mut after = before.clone();
        after.principal = Principal::Identity(account.owner.to_string());
        if before == after {
            return Ok(vec![]);
        }
        Ok(vec![AuthorizationChange::Changed {
            before: Box::new(before),
            after: Box::new(after),
        }])
    }

    fn actions(
        &self,
        authorization: &Authorization,
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<Action>, Error> {
        if !self.compile_state(state, context)?.contains(authorization) {
            return Err(Error::InvalidProjection);
        }
        let account = decode(&state.account)?;
        if Option::<Pubkey>::from(account.close_authority).is_none() {
            return Ok(vec![]);
        }
        check_authority(state, account.owner)?;
        Ok(vec![Action {
            kind: ActionKind::ResetAuthority,
            authorization_id: authorization.id.clone(),
            instructions: vec![reset_close_authority(state)?],
        }])
    }
}

fn decode_mint(state: &AuthorityState) -> Result<Mint, Error> {
    if state.account.owner != spl_token_interface::id() || state.account.executable {
        return Err(Error::InvalidState("mint program owner".into()));
    }
    Mint::unpack(&state.account.data).map_err(|error| Error::InvalidState(error.to_string()))
}

pub(crate) fn check_authority(state: &AuthorityState, key: Pubkey) -> Result<(), Error> {
    let mut observations = state
        .authorities
        .iter()
        .filter(|(address, _)| *address == key);
    let (_, account) = observations.next().ok_or(Error::InsufficientEvidence)?;
    if observations.next().is_some() {
        return Err(Error::InvalidState(
            "duplicate authority observation".into(),
        ));
    }
    if account.owner != Pubkey::default() || !account.data.is_empty() || account.executable {
        return Err(Error::UnsupportedOperation);
    }
    Ok(())
}

fn remove_mint_authority(
    state: &AuthorityState,
    mint: &Mint,
    capability: &Capability,
) -> Result<Instruction, Error> {
    let (authority_type, authority) = match capability {
        Capability::Mint => (instruction::AuthorityType::MintTokens, mint.mint_authority),
        Capability::Freeze | Capability::Thaw => (
            instruction::AuthorityType::FreezeAccount,
            mint.freeze_authority,
        ),
        _ => return Err(Error::UnsupportedOperation),
    };
    let authority = Option::<Pubkey>::from(authority).ok_or(Error::UnsupportedOperation)?;
    check_authority(state, authority)?;
    instruction::set_authority(
        &spl_token_interface::id(),
        &state.address,
        None,
        authority_type,
        &authority,
        &[],
    )
    .map_err(|error| Error::InvalidState(error.to_string()))
}

impl Adapter for MintAdapter {
    type State = AuthorityState;

    fn protocol(&self) -> Protocol {
        DelegateAdapter.protocol()
    }

    fn supports(&self, native: &NativeContext) -> bool {
        DelegateAdapter.supports(native)
    }

    fn source_requirements(&self, state: &AuthorityState) -> SourceRequirements {
        let mut accounts = vec![state.address];
        if let Ok(mint) = decode_mint(state) {
            for key in [
                Option::<Pubkey>::from(mint.mint_authority),
                Option::<Pubkey>::from(mint.freeze_authority),
            ]
            .into_iter()
            .flatten()
            {
                if !accounts.contains(&key) {
                    accounts.push(key);
                }
            }
        }
        SourceRequirements {
            accounts,
            clock: false,
        }
    }

    fn compile_state(
        &self,
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<Authorization>, Error> {
        let mint = decode_mint(state)?;
        let resource = Resource {
            namespace: "solana:mint".into(),
            id: state.address.to_string(),
        };
        let mut authorizations = Vec::new();
        for (role, capability, authority) in [
            ("mint", Capability::Mint, mint.mint_authority),
            ("freeze", Capability::Freeze, mint.freeze_authority),
            ("thaw", Capability::Thaw, mint.freeze_authority),
        ] {
            let Some(authority) = Option::<Pubkey>::from(authority) else {
                continue;
            };
            check_authority(state, authority)?;
            let token_accounts = capability != Capability::Mint;
            authorizations.push(Authorization {
                schema_version: SCHEMA_VERSION.into(),
                id: format!("{}:{}:{role}", context.program_id, state.address),
                subject: Subject::Resource(resource.clone()),
                principal: Principal::Identity(authority.to_string()),
                resource: if token_accounts {
                    Resource {
                        namespace: "solana:mint-token-accounts".into(),
                        id: state.address.to_string(),
                    }
                } else {
                    resource.clone()
                },
                capability,
                constraints: ConstraintExpr::True,
                usage: UsageSemantics::Unlimited,
                lifecycle: Lifecycle::Active {
                    valid_from: None,
                    valid_until: None,
                },
                delegability: Delegability::Unknown,
                authority_kind: AuthorityKind::Direct,
                enforcement: Enforcement::Native,
                observability: Observability::Exact,
                evidence: context.evidence.clone(),
                native_context: context.native.clone(),
            });
        }
        Ok(authorizations)
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        if instructions.len() != 1 {
            return Err(Error::UnsupportedOperation);
        }
        let mint = decode_mint(state)?;
        let before = self.compile_state(state, context)?;
        let mut changes = Vec::new();
        for authorization in before {
            if remove_mint_authority(state, &mint, &authorization.capability)? == instructions[0] {
                changes.push(AuthorizationChange::Removed {
                    authorization: Box::new(authorization),
                });
            }
        }
        if changes.is_empty() {
            return Err(Error::UnsupportedOperation);
        }
        Ok(changes)
    }

    fn actions(
        &self,
        authorization: &Authorization,
        state: &AuthorityState,
        context: &Context,
    ) -> Result<Vec<Action>, Error> {
        if !self.compile_state(state, context)?.contains(authorization) {
            return Err(Error::InvalidProjection);
        }
        Ok(vec![Action {
            kind: ActionKind::Revoke,
            authorization_id: authorization.id.clone(),
            instructions: vec![remove_mint_authority(
                state,
                &decode_mint(state)?,
                &authorization.capability,
            )?],
        }])
    }
}

pub struct State {
    pub address: Pubkey,
    pub account: Account,
    /// Observation of the token account owner's account, not the token delegate.
    pub owner: Account,
    pub delegate: Account,
}

fn decode(account: &Account) -> Result<TokenAccount, Error> {
    if account.owner != spl_token_interface::id() || account.executable {
        return Err(Error::InvalidState("token account program owner".into()));
    }
    TokenAccount::unpack(&account.data).map_err(|error| Error::InvalidState(error.to_string()))
}

fn revoke(state: &State) -> Result<Instruction, Error> {
    let account = decode(&state.account)?;
    if account.is_frozen() {
        return Err(Error::UnsupportedOperation);
    }
    // Multisig and program-controlled owners require their own native signer evidence.
    if state.owner.owner != Pubkey::default()
        || !state.owner.data.is_empty()
        || state.owner.executable
    {
        return Err(Error::UnsupportedOperation);
    }
    instruction::revoke(
        &spl_token_interface::id(),
        &state.address,
        &account.owner,
        &[],
    )
    .map_err(|error| Error::InvalidState(error.to_string()))
}

impl Adapter for DelegateAdapter {
    type State = State;

    fn protocol(&self) -> Protocol {
        Protocol {
            name: "spl-token",
            program_id: spl_token_interface::id(),
        }
    }

    fn supports(&self, native: &NativeContext) -> bool {
        native.protocol == "spl-token"
            && matches!(
                native.deployment.as_str(),
                DEPLOYMENT | LIVE_DEPLOYMENT | DEVNET_DEPLOYMENT
            )
            && native.program_version == PROGRAM_VERSION
            && native.adapter_version == "0.1"
    }

    fn source_requirements(&self, state: &State) -> SourceRequirements {
        let mut accounts = vec![state.address];
        if let Ok(account) = decode(&state.account) {
            accounts.push(account.owner);
            if let Some(delegate) = Option::<Pubkey>::from(account.delegate) {
                accounts.push(delegate);
            }
        }
        SourceRequirements {
            accounts,
            clock: false,
        }
    }

    fn compile_state(&self, state: &State, context: &Context) -> Result<Vec<Authorization>, Error> {
        if state.account.owner == Pubkey::default()
            && !state.account.executable
            && state.account.lamports == 0
            && state.account.data.is_empty()
        {
            return Ok(vec![]);
        }
        let account = decode(&state.account)?;
        let Some(delegate) = Option::<Pubkey>::from(account.delegate) else {
            return Ok(vec![]);
        };
        // A multisig principal needs threshold interpretation, not an ordinary signer identity.
        if state.delegate.owner != Pubkey::default()
            || !state.delegate.data.is_empty()
            || state.delegate.executable
        {
            return Err(Error::UnsupportedOperation);
        }
        Ok(vec![Authorization {
            schema_version: SCHEMA_VERSION.into(),
            id: format!("{}:{}:delegate:spend", context.program_id, state.address),
            subject: Subject::Identity(account.owner.to_string()),
            principal: Principal::Identity(delegate.to_string()),
            resource: Resource {
                namespace: "solana:token-account".into(),
                id: state.address.to_string(),
            },
            capability: Capability::Spend,
            constraints: ConstraintExpr::Constraint(Constraint::AmountAtMost {
                asset: Resource {
                    namespace: "solana:mint".into(),
                    id: account.mint.to_string(),
                },
                amount: account.delegated_amount,
            }),
            usage: UsageSemantics::Cumulative {
                remaining: Some(account.delegated_amount),
            },
            lifecycle: if account.is_frozen() {
                Lifecycle::Suspended
            } else {
                Lifecycle::Active {
                    valid_from: None,
                    valid_until: None,
                }
            },
            delegability: Delegability::Unknown,
            authority_kind: AuthorityKind::Direct,
            enforcement: Enforcement::Native,
            observability: Observability::Exact,
            evidence: context.evidence.clone(),
            native_context: context.native.clone(),
        }])
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &State,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        if instructions != [revoke(state)?] {
            return Err(Error::UnsupportedOperation);
        }
        Ok(self
            .compile_state(state, context)?
            .into_iter()
            .map(|authorization| AuthorizationChange::Removed {
                authorization: Box::new(authorization),
            })
            .collect())
    }

    fn actions(
        &self,
        authorization: &Authorization,
        state: &State,
        context: &Context,
    ) -> Result<Vec<Action>, Error> {
        if !self.compile_state(state, context)?.contains(authorization) {
            return Err(Error::InvalidProjection);
        }
        Ok(vec![Action {
            kind: ActionKind::Revoke,
            authorization_id: authorization.id.clone(),
            instructions: vec![revoke(state)?],
        }])
    }
}
