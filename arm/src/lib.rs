//! Protocol-neutral authorization meaning. Native decoding and enforcement belong to adapters.
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: &str = "0.1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    pub schema_version: String,
    /// Source-scoped identity supplied by the adapter, stable across observations.
    pub id: String,
    pub subject: Subject,
    pub principal: Principal,
    pub resource: Resource,
    pub capability: Capability,
    pub constraints: ConstraintExpr,
    pub usage: UsageSemantics,
    pub lifecycle: Lifecycle,
    pub delegability: Delegability,
    pub authority_kind: AuthorityKind,
    pub enforcement: Enforcement,
    pub observability: Observability,
    pub evidence: EvidenceBundle,
    pub native_context: NativeContext,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Subject {
    Identity(String),
    Resource(Resource),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Principal {
    Identity(String),
    AnyOf(Vec<Principal>),
    AllOf(Vec<Principal>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub namespace: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Spend,
    Execute,
    Mint,
    Burn,
    Freeze,
    Thaw,
    Close,
    ModifyAuthority,
    RevokeAuthority,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ConstraintExpr {
    True,
    False,
    Constraint(Constraint),
    All(Vec<ConstraintExpr>),
    Any(Vec<ConstraintExpr>),
    Not(Box<ConstraintExpr>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Constraint {
    /// Integer base units scoped to an explicit asset.
    AmountAtMost {
        asset: Resource,
        amount: u64,
    },
    NotBefore {
        unix_seconds: i64,
    },
    Before {
        unix_seconds: i64,
    },
    AllowedProgram {
        program: Resource,
    },
    Recipient {
        principal: Principal,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UsageSemantics {
    Unlimited,
    PerOperation,
    Cumulative {
        remaining: Option<u64>,
    },
    Recurring {
        period_seconds: u64,
        anchor_unix_seconds: i64,
        observed_period_start: i64,
        remaining: Option<u64>,
    },
    OneShot {
        consumed: Option<bool>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Lifecycle {
    /// Half-open interval [valid_from, valid_until), in Unix seconds.
    Active {
        valid_from: Option<i64>,
        valid_until: Option<i64>,
    },
    Suspended,
    Revoked,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delegability {
    None,
    Attenuated,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorityKind {
    Direct,
    Administrative,
    Derived { parents: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Enforcement {
    Native,
    Gateway,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Observability {
    Exact,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceBundle {
    pub references: Vec<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeContext {
    pub protocol: String,
    pub deployment: String,
    pub program_version: String,
    pub adapter_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionIntent {
    pub subject: Subject,
    pub principal: Principal,
    pub resource: Resource,
    pub capability: Capability,
    pub constraints: ConstraintExpr,
    pub usage: UsageSemantics,
    pub lifecycle: Lifecycle,
    pub delegability: Delegability,
    pub required_enforcement: Enforcement,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationGrant {
    pub authorization: Authorization,
    pub granted_by: Principal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveAuthorization {
    pub authorization: Authorization,
    pub evaluated_at_unix_seconds: i64,
    pub availability: Availability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Inactive,
    Conditional,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorizationChange {
    Added {
        authorization: Box<Authorization>,
    },
    Removed {
        authorization: Box<Authorization>,
    },
    Changed {
        before: Box<Authorization>,
        after: Box<Authorization>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationError {
    UnsupportedSchema,
    EmptyIdentity,
    InvalidLifecycle,
    InvalidPeriod,
    MissingEvidence,
    InvalidLineage,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ValidationError {}

impl Resource {
    fn valid(&self) -> bool {
        !self.namespace.is_empty() && !self.id.is_empty()
    }
}

impl Principal {
    fn valid(&self) -> bool {
        match self {
            Self::Identity(id) => !id.is_empty(),
            Self::AnyOf(items) | Self::AllOf(items) => {
                !items.is_empty() && items.iter().all(Self::valid)
            }
        }
    }
}

impl ConstraintExpr {
    fn valid(&self) -> bool {
        match self {
            Self::Constraint(Constraint::AmountAtMost { asset, .. }) => asset.valid(),
            Self::Constraint(Constraint::AllowedProgram { program }) => program.valid(),
            Self::Constraint(Constraint::Recipient { principal }) => principal.valid(),
            Self::All(items) | Self::Any(items) => items.iter().all(Self::valid),
            Self::Not(item) => item.valid(),
            _ => true,
        }
    }
    /// A sufficient implication proof. False means unproven, not necessarily disjoint.
    pub fn is_proven_subset_of(&self, parent: &Self) -> bool {
        if !self.valid() || !parent.valid() {
            return false;
        }
        if self == parent || matches!(self, Self::False) || matches!(parent, Self::True) {
            return true;
        }
        match (self, parent) {
            (_, Self::All(items)) => items.iter().all(|item| self.is_proven_subset_of(item)),
            (Self::Any(items), _) => items.iter().all(|item| item.is_proven_subset_of(parent)),
            (Self::All(items), _) => items.iter().any(|item| item.is_proven_subset_of(parent)),
            (_, Self::Any(items)) => items.iter().any(|item| self.is_proven_subset_of(item)),
            (Self::Constraint(child), Self::Constraint(parent)) => match (child, parent) {
                (
                    Constraint::AmountAtMost {
                        asset: a,
                        amount: x,
                    },
                    Constraint::AmountAtMost {
                        asset: b,
                        amount: y,
                    },
                ) => a == b && x <= y,
                (
                    Constraint::Before { unix_seconds: x },
                    Constraint::Before { unix_seconds: y },
                ) => x <= y,
                (
                    Constraint::NotBefore { unix_seconds: x },
                    Constraint::NotBefore { unix_seconds: y },
                ) => x >= y,
                _ => false,
            },
            _ => false,
        }
    }
}

impl Authorization {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(ValidationError::UnsupportedSchema);
        }
        let subject_valid = match &self.subject {
            Subject::Identity(id) => !id.is_empty(),
            Subject::Resource(resource) => resource.valid(),
        };
        if self.id.is_empty()
            || !subject_valid
            || !self.principal.valid()
            || !self.resource.valid()
            || !self.constraints.valid()
            || [
                &self.native_context.protocol,
                &self.native_context.deployment,
                &self.native_context.program_version,
                &self.native_context.adapter_version,
            ]
            .iter()
            .any(|s| s.is_empty())
        {
            return Err(ValidationError::EmptyIdentity);
        }
        if let Lifecycle::Active {
            valid_from: Some(start),
            valid_until: Some(end),
        } = self.lifecycle
        {
            if start >= end {
                return Err(ValidationError::InvalidLifecycle);
            }
        }
        if let UsageSemantics::Recurring {
            period_seconds,
            anchor_unix_seconds,
            observed_period_start,
            ..
        } = self.usage
        {
            let period =
                i64::try_from(period_seconds).map_err(|_| ValidationError::InvalidPeriod)?;
            let offset = observed_period_start
                .checked_sub(anchor_unix_seconds)
                .ok_or(ValidationError::InvalidPeriod)?;
            if period == 0
                || offset < 0
                || offset % period != 0
                || observed_period_start.checked_add(period).is_none()
            {
                return Err(ValidationError::InvalidPeriod);
            }
        }
        if self.evidence.observed_at.is_empty()
            || self.evidence.references.iter().any(|s| s.is_empty())
            || (self.observability == Observability::Exact && self.evidence.references.is_empty())
        {
            return Err(ValidationError::MissingEvidence);
        }
        if let AuthorityKind::Derived { parents } = &self.authority_kind {
            if parents.is_empty()
                || parents.iter().any(|id| id.is_empty() || id == &self.id)
                || parents
                    .iter()
                    .enumerate()
                    .any(|(i, id)| parents[..i].contains(id))
            {
                return Err(ValidationError::InvalidLineage);
            }
        }
        Ok(())
    }

    /// Availability never authorizes a transaction: native constraints still require checking.
    pub fn availability_at(&self, now: i64) -> Result<Availability, ValidationError> {
        self.validate()?;
        match self.lifecycle {
            Lifecycle::Revoked | Lifecycle::Suspended => return Ok(Availability::Inactive),
            Lifecycle::Unknown => return Ok(Availability::Unknown),
            Lifecycle::Active {
                valid_from,
                valid_until,
            } => {
                if valid_from.is_some_and(|start| now < start)
                    || valid_until.is_some_and(|end| now >= end)
                {
                    return Ok(Availability::Inactive);
                }
            }
        }
        if self.constraints == ConstraintExpr::False {
            return Ok(Availability::Inactive);
        }
        match self.usage {
            UsageSemantics::OneShot {
                consumed: Some(true),
            }
            | UsageSemantics::Cumulative { remaining: Some(0) } => {
                return Ok(Availability::Inactive)
            }
            UsageSemantics::Recurring {
                period_seconds,
                observed_period_start,
                remaining,
                ..
            } => {
                // A later period requires new evidence; resetting a native budget here invents state.
                let end = observed_period_start + period_seconds as i64;
                if now < observed_period_start || now >= end {
                    return Ok(Availability::Unknown);
                }
                if remaining == Some(0) {
                    return Ok(Availability::Inactive);
                }
                if remaining.is_none() {
                    return Ok(Availability::Unknown);
                }
            }
            UsageSemantics::OneShot { consumed: None }
            | UsageSemantics::Cumulative { remaining: None } => return Ok(Availability::Unknown),
            _ => {}
        }
        if self.observability != Observability::Exact
            || matches!(self.authority_kind, AuthorityKind::Derived { .. })
        {
            return Ok(Availability::Unknown);
        }
        Ok(Availability::Conditional)
    }

    pub fn effective_at(&self, now: i64) -> Result<EffectiveAuthorization, ValidationError> {
        let availability = self.availability_at(now)?;
        Ok(EffectiveAuthorization {
            authorization: self.clone(),
            evaluated_at_unix_seconds: now,
            availability,
        })
    }

    /// Constraint attenuation foundation; does not prove delegation or principal substitution.
    pub fn is_proven_attenuation_of(&self, parent: &Self) -> bool {
        if self.validate().is_err() || parent.validate().is_err() {
            return false;
        }
        self.subject == parent.subject
            && self.principal == parent.principal
            && self.resource == parent.resource
            && self.capability == parent.capability
            && self.usage == parent.usage
            && self.lifecycle == parent.lifecycle
            && self.delegability == parent.delegability
            && self.authority_kind == parent.authority_kind
            && self.enforcement == parent.enforcement
            && self.native_context == parent.native_context
            && self.constraints.is_proven_subset_of(&parent.constraints)
    }
}
