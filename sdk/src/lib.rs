//! Semantic adapters consume typed native state. Byte decoding belongs to native clients.

use arm::{Authorization, AuthorizationChange, EvidenceBundle, NativeContext};
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;

pub mod spl;
pub mod squads;
pub mod subscriptions;
pub mod token2022;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Protocol {
    pub name: &'static str,
    pub program_id: Pubkey,
}

/// Native source positions and versions have already been resolved by Cataloger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    pub program_id: Pubkey,
    pub native: NativeContext,
    pub evidence: EvidenceBundle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceRequirements {
    pub accounts: Vec<Pubkey>,
    pub clock: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Revoke,
    ResetAuthority,
    Cancel,
    CancelNow,
    Resume,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Action {
    pub kind: ActionKind,
    pub authorization_id: String,
    /// Native account metas carry signer requirements; no execution or signing occurs here.
    pub instructions: Vec<Instruction>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    UnsupportedVersion,
    UnsupportedOperation,
    InsufficientEvidence,
    InvalidState(String),
    InvalidProjection,
    DiffMismatch,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidState(message) => write!(f, "invalid native state: {message}"),
            _ => write!(f, "{self:?}"),
        }
    }
}

impl std::error::Error for Error {}

pub trait Adapter {
    type State;

    fn protocol(&self) -> Protocol;
    fn supports(&self, native: &NativeContext) -> bool;
    fn source_requirements(&self, state: &Self::State) -> SourceRequirements;
    fn compile_state(
        &self,
        state: &Self::State,
        context: &Context,
    ) -> Result<Vec<Authorization>, Error>;
    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &Self::State,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error>;
    fn actions(
        &self,
        authorization: &Authorization,
        state: &Self::State,
        context: &Context,
    ) -> Result<Vec<Action>, Error>;
}

fn check_context(adapter: &impl Adapter, context: &Context) -> Result<(), Error> {
    let protocol = adapter.protocol();
    if protocol.name != context.native.protocol
        || protocol.program_id != context.program_id
        || !adapter.supports(&context.native)
    {
        return Err(Error::UnsupportedVersion);
    }
    if context.evidence.observed_at.is_empty()
        || context.evidence.references.is_empty()
        || context
            .evidence
            .references
            .iter()
            .any(|reference| reference.is_empty())
    {
        return Err(Error::InsufficientEvidence);
    }
    Ok(())
}

fn check_projection(authorization: &Authorization, context: &Context) -> Result<(), Error> {
    if authorization.validate().is_err()
        || authorization.native_context != context.native
        || authorization.evidence != context.evidence
    {
        return Err(Error::InvalidProjection);
    }
    Ok(())
}

/// Runtime dispatch boundary: reject unknown versions before invoking protocol interpretation.
pub fn compile_state<A: Adapter>(
    adapter: &A,
    state: &A::State,
    context: &Context,
) -> Result<Vec<Authorization>, Error> {
    check_context(adapter, context)?;
    let authorizations = adapter.compile_state(state, context)?;
    for (index, authorization) in authorizations.iter().enumerate() {
        check_projection(authorization, context)?;
        if authorizations[..index]
            .iter()
            .any(|previous| previous.id == authorization.id)
        {
            return Err(Error::InvalidProjection);
        }
    }
    Ok(authorizations)
}

pub fn diff_transaction<A: Adapter>(
    adapter: &A,
    instructions: &[Instruction],
    state: &A::State,
    context: &Context,
) -> Result<Vec<AuthorizationChange>, Error> {
    check_context(adapter, context)?;
    let changes = adapter.diff_transaction(instructions, state, context)?;
    for change in &changes {
        match change {
            AuthorizationChange::Added { authorization }
            | AuthorizationChange::Removed { authorization } => {
                check_projection(authorization, context)?
            }
            AuthorizationChange::Changed { before, after } => {
                check_projection(before, context)?;
                check_projection(after, context)?;
                if before.id != after.id {
                    return Err(Error::InvalidProjection);
                }
            }
        }
    }
    Ok(changes)
}

/// Compare declared changes with a successful simulation's recompiled state.
/// The caller binds account scope, clock and execution evidence; coverage is unchanged.
pub fn verify_transaction_diff<A: Adapter>(
    adapter: &A,
    instructions: &[Instruction],
    before: &A::State,
    before_context: &Context,
    after: &A::State,
    after_context: &Context,
) -> Result<Vec<AuthorizationChange>, Error> {
    check_context(adapter, before_context)?;
    check_context(adapter, after_context)?;
    if before_context.program_id != after_context.program_id
        || before_context.native != after_context.native
    {
        return Err(Error::UnsupportedVersion);
    }
    let mut expected = compile_state(adapter, before, before_context)?;
    let changes = diff_transaction(adapter, instructions, before, before_context)?;
    let mut touched = Vec::new();
    for change in &changes {
        let (id, previous, next) = match change {
            AuthorizationChange::Added { authorization } => (
                authorization.id.as_str(),
                None,
                Some(authorization.as_ref()),
            ),
            AuthorizationChange::Removed { authorization } => (
                authorization.id.as_str(),
                Some(authorization.as_ref()),
                None,
            ),
            AuthorizationChange::Changed { before, after } => (
                before.id.as_str(),
                Some(before.as_ref()),
                Some(after.as_ref()),
            ),
        };
        if touched.contains(&id) {
            return Err(Error::DiffMismatch);
        }
        touched.push(id);
        if let Some(previous) = previous {
            let index = expected
                .iter()
                .position(|authorization| authorization == previous)
                .ok_or(Error::DiffMismatch)?;
            expected.remove(index);
        }
        if let Some(next) = next {
            if expected.iter().any(|authorization| authorization.id == id) {
                return Err(Error::DiffMismatch);
            }
            expected.push(next.clone());
        }
    }
    let mut observed = compile_state(adapter, after, after_context)?;
    // Observation evidence changes independently of permission semantics.
    for authorization in &mut observed {
        authorization.evidence = before_context.evidence.clone();
    }
    expected.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    observed.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    if expected != observed {
        return Err(Error::DiffMismatch);
    }
    Ok(changes)
}

pub fn actions<A: Adapter>(
    adapter: &A,
    authorization: &Authorization,
    state: &A::State,
    context: &Context,
) -> Result<Vec<Action>, Error> {
    check_context(adapter, context)?;
    check_projection(authorization, context)?;
    let actions = adapter.actions(authorization, state, context)?;
    if actions
        .iter()
        .any(|action| action.authorization_id != authorization.id || action.instructions.is_empty())
    {
        return Err(Error::InvalidProjection);
    }
    Ok(actions)
}
