use crate::{
    spl::{check_authority, AuthorityState},
    Action, ActionKind, Adapter, Context, Error, Protocol, SourceRequirements,
};
use arm::*;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;
use spl_token_2022_interface::{
    extension::{
        permanent_delegate::PermanentDelegate, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    instruction,
    state::{Account as TokenAccount, Mint},
};

pub const PROGRAM_VERSION: &str =
    "sha256:b2a7ce1ea6dfbcbc5ccb0e7f48f7c61dced1a86582d1c7d2e059ac54ed612da4";
pub const DEPLOYMENT: &str = "fixture:mollusk:token-2022:0.15.1";

pub struct Token2022Adapter;

pub struct State {
    pub source: AuthorityState,
    pub mint: (Pubkey, Account),
}

fn decode(state: &State) -> Result<(TokenAccount, Option<Pubkey>), Error> {
    if state.source.account.owner != spl_token_2022_interface::id()
        || state.source.account.executable
    {
        return Err(Error::InvalidState("token account program owner".into()));
    }
    let account = StateWithExtensions::<TokenAccount>::unpack(&state.source.account.data)
        .map_err(|error| Error::InvalidState(error.to_string()))?;
    let extensions = account
        .get_extension_types()
        .map_err(|error| Error::InvalidState(error.to_string()))?;
    if !extensions.is_empty() {
        return Err(Error::UnsupportedOperation);
    }
    if state.mint.0 != account.base.mint {
        return Err(Error::InvalidState("mint identity".into()));
    }
    if state.mint.1.data.is_empty() {
        return Err(Error::InsufficientEvidence);
    }
    if state.mint.1.owner != spl_token_2022_interface::id() || state.mint.1.executable {
        return Err(Error::InvalidState("mint program owner".into()));
    }
    let mint = StateWithExtensions::<Mint>::unpack(&state.mint.1.data)
        .map_err(|error| Error::InvalidState(error.to_string()))?;
    let extensions = mint
        .get_extension_types()
        .map_err(|error| Error::InvalidState(error.to_string()))?;
    if extensions
        .iter()
        .any(|extension| *extension != ExtensionType::PermanentDelegate)
    {
        return Err(Error::UnsupportedOperation);
    }
    if extensions.len() > 1 {
        return Err(Error::InvalidState("duplicate extension".into()));
    }
    let permanent = if extensions.is_empty() {
        None
    } else {
        let extension = mint
            .get_extension::<PermanentDelegate>()
            .map_err(|error| Error::InvalidState(error.to_string()))?;
        Option::<Pubkey>::from(extension.delegate)
    };
    // The permanent branch bypasses delegated_amount; it is not an independently consumed budget.
    if permanent.is_some() && permanent == Option::<Pubkey>::from(account.base.delegate) {
        return Err(Error::UnsupportedOperation);
    }
    Ok((account.base, permanent))
}

fn revoke(state: &State, signer: Pubkey) -> Result<Instruction, Error> {
    let (account, _) = decode(state)?;
    if account.is_frozen()
        || (signer != account.owner && Some(signer) != Option::<Pubkey>::from(account.delegate))
    {
        return Err(Error::UnsupportedOperation);
    }
    check_authority(&state.source, signer)?;
    instruction::revoke(
        &spl_token_2022_interface::id(),
        &state.source.address,
        &signer,
        &[],
    )
    .map_err(|error| Error::InvalidState(error.to_string()))
}

impl Adapter for Token2022Adapter {
    type State = State;

    fn protocol(&self) -> Protocol {
        Protocol {
            name: "token-2022",
            program_id: spl_token_2022_interface::id(),
        }
    }

    fn supports(&self, native: &NativeContext) -> bool {
        native.protocol == "token-2022"
            && native.deployment == DEPLOYMENT
            && native.program_version == PROGRAM_VERSION
            && native.adapter_version == "0.1"
    }

    fn source_requirements(&self, state: &State) -> SourceRequirements {
        let mut accounts = vec![state.source.address];
        if let Ok(account) = StateWithExtensions::<TokenAccount>::unpack(&state.source.account.data)
        {
            for key in [
                Some(account.base.mint),
                Some(account.base.owner),
                Option::<Pubkey>::from(account.base.delegate),
            ]
            .into_iter()
            .flatten()
            {
                if !accounts.contains(&key) {
                    accounts.push(key);
                }
            }
        }
        if let Ok((_, Some(permanent))) = decode(state) {
            if !accounts.contains(&permanent) {
                accounts.push(permanent);
            }
        }
        SourceRequirements {
            accounts,
            clock: false,
        }
    }

    fn compile_state(&self, state: &State, context: &Context) -> Result<Vec<Authorization>, Error> {
        let (account, permanent) = decode(state)?;
        let mint = Resource {
            namespace: "solana:mint".into(),
            id: account.mint.to_string(),
        };
        let mut authorizations = Vec::new();
        for (role, principal) in [
            ("delegate", Option::<Pubkey>::from(account.delegate)),
            ("permanent-delegate", permanent),
        ] {
            let Some(principal) = principal else { continue };
            check_authority(&state.source, principal)?;
            let cumulative = role == "delegate";
            authorizations.push(Authorization {
                schema_version: SCHEMA_VERSION.into(),
                id: format!(
                    "{}:{}:{role}:spend",
                    context.program_id,
                    if cumulative {
                        state.source.address
                    } else {
                        account.mint
                    }
                ),
                subject: if cumulative {
                    Subject::Identity(account.owner.to_string())
                } else {
                    Subject::Resource(mint.clone())
                },
                principal: Principal::Identity(principal.to_string()),
                resource: Resource {
                    namespace: if cumulative {
                        "solana:token-account"
                    } else {
                        "solana:mint-token-accounts"
                    }
                    .into(),
                    id: if cumulative {
                        state.source.address
                    } else {
                        account.mint
                    }
                    .to_string(),
                },
                capability: Capability::Spend,
                constraints: if cumulative {
                    ConstraintExpr::Constraint(Constraint::AmountAtMost {
                        asset: mint.clone(),
                        amount: account.delegated_amount,
                    })
                } else {
                    ConstraintExpr::True
                },
                usage: if cumulative {
                    UsageSemantics::Cumulative {
                        remaining: Some(account.delegated_amount),
                    }
                } else {
                    UsageSemantics::Unlimited
                },
                lifecycle: if cumulative && account.is_frozen() {
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
            });
        }
        Ok(authorizations)
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &State,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        if instructions.len() != 1 {
            return Err(Error::UnsupportedOperation);
        }
        let (account, _) = decode(state)?;
        let instruction = &instructions[0];
        let signer = instruction
            .accounts
            .get(1)
            .ok_or(Error::UnsupportedOperation)?
            .pubkey;
        if *instruction != revoke(state, signer)? {
            return Err(Error::UnsupportedOperation);
        }
        let delegate = Option::<Pubkey>::from(account.delegate);
        Ok(self
            .compile_state(state, context)?
            .into_iter()
            .filter(|authorization| {
                delegate.is_some() && authorization.resource.namespace == "solana:token-account"
            })
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
        if authorization.resource.namespace != "solana:token-account" {
            return Err(Error::UnsupportedOperation);
        }
        let (account, _) = decode(state)?;
        let mut actions = Vec::new();
        for signer in [
            Some(account.owner),
            Option::<Pubkey>::from(account.delegate),
        ]
        .into_iter()
        .flatten()
        {
            let instruction = revoke(state, signer)?;
            if actions
                .iter()
                .any(|action: &Action| action.instructions.first() == Some(&instruction))
            {
                continue;
            }
            actions.push(Action {
                kind: ActionKind::Revoke,
                authorization_id: authorization.id.clone(),
                instructions: vec![instruction],
            });
        }
        Ok(actions)
    }
}
