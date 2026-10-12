use crate::{
    spl::{check_authority, AuthorityState},
    Action, ActionKind, Adapter, Context, Error, Protocol, SourceRequirements,
};
use ::subscriptions::{
    accounts::{
        EventAuthority, FixedDelegation, Plan, RecurringDelegation, SubscriptionAuthority,
        SubscriptionDelegation,
    },
    instructions::{
        CancelSubscription, CancelSubscriptionNow, CancelSubscriptionNowInstructionArgs,
        ResumeSubscription, ResumeSubscriptionInstructionArgs, RevokeDelegation,
    },
    types::{CancelSubscriptionNowData, Header, ResumeData},
    SUBSCRIPTIONS_ID,
};
use arm::*;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use spl_token_interface::state::{Account as TokenAccount, Mint};

pub const PROGRAM_VERSION: &str =
    "sha256:a59467f0b2d0a0211b06ddf9a3f3141a90eaea6faeeaa3d19541288eaa082107";
pub const DEPLOYMENT: &str = "fixture:mollusk:subscriptions:0.5.0";
pub const DEVNET_PROGRAM_VERSION: &str =
    "sha256:2675ad1d2b5068d47fc5d169156cf4859a9c21c0406ce63e3828e3b7320fddbf";
pub const DEVNET_DEPLOYMENT: &str =
    "solana:loader-v3:HaYb5J9eXooZuNzN3z6TfuzVDcaTfiDdDPWCFtexFfMg:506642674";

pub const ADAPTER_VERSION: &str = "0.3";

pub struct DelegationAdapter;

pub struct DelegationState {
    pub delegation: (Pubkey, Account),
    pub authority: (Pubkey, Account),
    pub source: AuthorityState,
    pub mint: (Pubkey, Account),
    pub token_program_version: String,
    pub unix_timestamp: Option<i64>,
    pub plan: Option<(Pubkey, Account)>,
}

enum Delegation {
    Fixed(FixedDelegation),
    Recurring(RecurringDelegation),
    Subscription(SubscriptionDelegation),
}

impl Delegation {
    fn header(&self) -> &Header {
        match self {
            Self::Fixed(grant) => &grant.header,
            Self::Recurring(grant) => &grant.header,
            Self::Subscription(grant) => &grant.header,
        }
    }

    fn terms(
        &self,
        now: Option<i64>,
        plan: Option<&Plan>,
    ) -> Result<(u64, UsageSemantics, Lifecycle), Error> {
        let (amount, usage, start, expiry) = match self {
            Self::Fixed(grant) => (
                grant.amount,
                UsageSemantics::Cumulative {
                    remaining: Some(grant.amount),
                },
                None,
                grant.expiry_ts,
            ),
            Self::Recurring(grant) => (
                grant.amount_per_period,
                recurring_usage(
                    grant.amount_per_period,
                    grant.period_length_s,
                    grant.current_period_start_ts,
                    grant.amount_pulled_in_period,
                    grant.expiry_ts,
                    now.ok_or(Error::InsufficientEvidence)?,
                )?,
                Some(grant.current_period_start_ts),
                grant.expiry_ts,
            ),
            Self::Subscription(grant) => {
                let plan = plan.ok_or(Error::InsufficientEvidence)?;
                let period = grant
                    .terms
                    .period_hours
                    .checked_mul(3_600)
                    .filter(|_| {
                        (1..=8_760).contains(&grant.terms.period_hours) && grant.terms.amount != 0
                    })
                    .ok_or_else(|| Error::InvalidState("subscription terms".into()))?;
                (
                    grant.terms.amount,
                    recurring_usage(
                        grant.terms.amount,
                        period,
                        grant.current_period_start_ts,
                        grant.amount_pulled_in_period,
                        plan.data.end_ts,
                        now.ok_or(Error::InsufficientEvidence)?
                            .min(if grant.expires_at_ts == 0 {
                                i64::MAX
                            } else {
                                grant.expires_at_ts.saturating_sub(1)
                            }),
                    )?,
                    Some(grant.current_period_start_ts),
                    plan.data.end_ts,
                )
            }
        };
        let mut until = if expiry == 0 {
            None
        } else {
            expiry.checked_add(1)
        };
        if let Self::Subscription(grant) = self {
            // Cancellation is exclusive; the plan's native end remains inclusive.
            if grant.expires_at_ts != 0 {
                until = Some(until.map_or(grant.expires_at_ts, |end| end.min(grant.expires_at_ts)));
            }
        }
        let lifecycle = if start.zip(until).is_some_and(|(start, end)| start >= end) {
            Lifecycle::Revoked
        } else {
            Lifecycle::Active {
                valid_from: start,
                valid_until: until,
            }
        };
        Ok((amount, usage, lifecycle))
    }
}

fn recurring_usage(
    amount: u64,
    period: u64,
    anchor: i64,
    mut pulled: u64,
    expiry: i64,
    now: i64,
) -> Result<UsageSemantics, Error> {
    let length = i64::try_from(period)
        .ok()
        .filter(|period| *period > 0)
        .ok_or_else(|| Error::InvalidState("recurring period".into()))?;
    if pulled > amount {
        return Err(Error::InvalidState("recurring consumption".into()));
    }
    let mut start = anchor;
    if now >= anchor && (expiry == 0 || now <= expiry) {
        // Inclusive expiry retains the last period starting strictly before it.
        let until = if expiry == 0 {
            now
        } else {
            now.min(expiry.saturating_sub(1))
        };
        let elapsed = until
            .checked_sub(anchor)
            .ok_or(Error::UnsupportedOperation)?;
        if elapsed >= length {
            start = anchor
                .checked_add(elapsed / length * length)
                .ok_or(Error::UnsupportedOperation)?;
            pulled = 0;
        }
    }
    if start.checked_add(length).is_none() {
        return Err(Error::UnsupportedOperation);
    }
    Ok(UsageSemantics::Recurring {
        period_seconds: period,
        anchor_unix_seconds: anchor,
        observed_period_start: start,
        remaining: Some(amount - pulled),
    })
}

fn plan(state: &DelegationState) -> Result<Option<Plan>, Error> {
    let Some((address, account)) = &state.plan else {
        return Ok(None);
    };
    if absent(account) {
        return Err(Error::UnsupportedOperation);
    }
    if account.owner != SUBSCRIPTIONS_ID
        || account.executable
        || account.data.len() != 491
        || account.data.first() != Some(&1)
    {
        return Err(Error::InvalidState("plan owner, kind or length".into()));
    }
    let plan =
        Plan::from_bytes(&account.data).map_err(|error| Error::InvalidState(error.to_string()))?;
    let (expected, bump) = Plan::find_pda(&plan.owner, plan.data.plan_id);
    if *address != expected
        || plan.bump != bump
        || plan.status > 1
        || plan.data.mint != state.mint.0
        || plan.data.terms.amount == 0
        || !(1..=8_760).contains(&plan.data.terms.period_hours)
    {
        return Err(Error::InvalidState("plan identity, status or terms".into()));
    }
    Ok(Some(plan))
}

fn principal(keys: impl IntoIterator<Item = Pubkey>) -> Principal {
    let mut principals = Vec::new();
    for key in keys {
        let item = Principal::Identity(key.to_string());
        if key != Pubkey::default() && !principals.contains(&item) {
            principals.push(item);
        }
    }
    if principals.len() == 1 {
        principals.remove(0)
    } else {
        Principal::AnyOf(principals)
    }
}

fn absent(account: &Account) -> bool {
    account.owner == Pubkey::default()
        && account.lamports == 0
        && account.data.is_empty()
        && !account.executable
}

fn delegation(state: &DelegationState) -> Result<Option<Delegation>, Error> {
    let account = &state.delegation.1;
    if absent(account) {
        return Ok(None);
    }
    if account.owner != SUBSCRIPTIONS_ID || account.executable || account.data.len() < 2 {
        return Err(Error::InvalidState("delegation owner or header".into()));
    }
    if account.data[1] != 1 {
        return Err(Error::UnsupportedVersion);
    }
    match account.data[0] {
        2 if account.data.len() == 187 => FixedDelegation::from_bytes(&account.data)
            .map(Delegation::Fixed)
            .map(Some)
            .map_err(|error| Error::InvalidState(error.to_string())),
        3 if account.data.len() == 211 => RecurringDelegation::from_bytes(&account.data)
            .map(Delegation::Recurring)
            .map(Some)
            .map_err(|error| Error::InvalidState(error.to_string())),
        4 if account.data.len() == 155 => SubscriptionDelegation::from_bytes(&account.data)
            .map(Delegation::Subscription)
            .map(Some)
            .map_err(|error| Error::InvalidState(error.to_string())),
        2..=4 => Err(Error::InvalidState("delegation length".into())),
        _ => Err(Error::UnsupportedOperation),
    }
}

fn revoke(state: &DelegationState) -> Result<Instruction, Error> {
    let grant = delegation(state)?.ok_or(Error::UnsupportedOperation)?;
    let header = grant.header();
    check_authority(&state.source, header.delegator)?;
    let mut recipients = if matches!(grant, Delegation::Subscription(_)) {
        vec![AccountMeta::new_readonly(header.delegatee, false)]
    } else {
        vec![]
    };
    if header.payer != header.delegator {
        recipients.push(AccountMeta::new(header.payer, false));
    }
    Ok(RevokeDelegation {
        authority: header.delegator,
        delegation_account: state.delegation.0,
    }
    .instruction_with_remaining_accounts(&recipients))
}

fn cancel_cutoff(grant: &SubscriptionDelegation, plan: &Plan, now: i64) -> Result<i64, Error> {
    if grant.terms != plan.data.terms {
        return Ok(now);
    }
    let period = grant
        .terms
        .period_hours
        .checked_mul(3_600)
        .and_then(|period| i64::try_from(period).ok())
        .filter(|period| *period > 0)
        .ok_or_else(|| Error::InvalidState("subscription period".into()))?;
    let elapsed = now.saturating_sub(grant.current_period_start_ts);
    let cutoff = (elapsed / period)
        .checked_add(1)
        .and_then(|periods| periods.checked_mul(period))
        .and_then(|offset| grant.current_period_start_ts.checked_add(offset))
        .ok_or(Error::UnsupportedOperation)?;
    Ok(if plan.data.end_ts == 0 {
        cutoff
    } else {
        cutoff.min(plan.data.end_ts.saturating_add(1))
    })
}

fn controls(
    state: &DelegationState,
    grant: &Delegation,
    plan: Option<&Plan>,
) -> Result<Vec<(ActionKind, Instruction)>, Error> {
    let Delegation::Subscription(grant) = grant else {
        return Ok(vec![(ActionKind::Revoke, revoke(state)?)]);
    };
    let now = state.unix_timestamp.ok_or(Error::InsufficientEvidence)?;
    let plan = plan.ok_or(Error::InsufficientEvidence)?;
    let (event_authority, _) = EventAuthority::find_pda();
    if grant.expires_at_ts != 0 && now >= grant.expires_at_ts {
        return Ok(vec![(ActionKind::Revoke, revoke(state)?)]);
    }
    let mut actions = Vec::new();
    if grant.expires_at_ts == 0 {
        cancel_cutoff(grant, plan, now)?;
        actions.push((
            ActionKind::Cancel,
            CancelSubscription {
                subscriber: grant.header.delegator,
                plan_pda: grant.header.delegatee,
                subscription_pda: state.delegation.0,
                event_authority,
                self_program: SUBSCRIPTIONS_ID,
            }
            .instruction(),
        ));
    } else if grant.terms == plan.data.terms
        && (plan.data.end_ts == 0 || now <= plan.data.end_ts)
        && !absent(&state.authority.1)
    {
        let authority = SubscriptionAuthority::from_bytes(&state.authority.1.data)
            .map_err(|error| Error::InvalidState(error.to_string()))?;
        if authority.init_id == grant.header.init_id {
            actions.push((
                ActionKind::Resume,
                ResumeSubscription {
                    subscriber: grant.header.delegator,
                    plan_pda: grant.header.delegatee,
                    subscription_pda: state.delegation.0,
                    subscription_authority: state.authority.0,
                    event_authority,
                    self_program: SUBSCRIPTIONS_ID,
                }
                .instruction(ResumeSubscriptionInstructionArgs {
                    resume_data: ResumeData {
                        expected_expires_at_ts: grant.expires_at_ts,
                    },
                }),
            ));
        }
    }
    actions.push((
        ActionKind::CancelNow,
        CancelSubscriptionNow {
            subscriber: grant.header.delegator,
            merchant: plan.owner,
            plan_pda: grant.header.delegatee,
            subscription_pda: state.delegation.0,
            event_authority,
            self_program: SUBSCRIPTIONS_ID,
        }
        .instruction(CancelSubscriptionNowInstructionArgs {
            cancel_subscription_now_data: CancelSubscriptionNowData {
                expected_current_period_start_ts: grant.current_period_start_ts,
            },
        }),
    ));
    Ok(actions)
}

impl Adapter for DelegationAdapter {
    type State = DelegationState;

    fn protocol(&self) -> Protocol {
        Protocol {
            name: "subscriptions",
            program_id: SUBSCRIPTIONS_ID,
        }
    }

    fn supports(&self, native: &NativeContext) -> bool {
        native.protocol == "subscriptions"
            && matches!(
                (native.deployment.as_str(), native.program_version.as_str()),
                (DEPLOYMENT, PROGRAM_VERSION) | (DEVNET_DEPLOYMENT, DEVNET_PROGRAM_VERSION)
            )
            && native.adapter_version == ADAPTER_VERSION
    }

    fn source_requirements(&self, state: &DelegationState) -> SourceRequirements {
        let mut accounts = vec![
            state.delegation.0,
            state.authority.0,
            state.source.address,
            state.mint.0,
        ];
        if let Ok(account) = TokenAccount::unpack(&state.source.account.data) {
            if !accounts.contains(&account.owner) {
                accounts.push(account.owner);
            }
        }
        if let Ok(Some(grant)) = delegation(state) {
            if !accounts.contains(&grant.header().delegatee) {
                accounts.push(grant.header().delegatee);
            }
        }
        if let Ok(Some(plan)) = plan(state) {
            for key in [plan.owner].into_iter().chain(plan.data.pullers) {
                if key != Pubkey::default() && !accounts.contains(&key) {
                    accounts.push(key);
                }
            }
            if let Some((address, _)) = &state.plan {
                if !accounts.contains(address) {
                    accounts.push(*address);
                }
            }
        }
        SourceRequirements {
            accounts,
            clock: state.plan.is_some() || matches!(state.delegation.1.data.first(), Some(3 | 4)),
        }
    }

    fn compile_state(
        &self,
        state: &DelegationState,
        context: &Context,
    ) -> Result<Vec<Authorization>, Error> {
        if state.token_program_version != crate::spl::PROGRAM_VERSION {
            return Err(Error::UnsupportedVersion);
        }
        let token_id = spl_token_interface::id();
        if state.source.account.owner != token_id
            || state.source.account.executable
            || state.mint.1.owner != token_id
            || state.mint.1.executable
        {
            return Err(Error::InvalidState("token account or mint owner".into()));
        }
        let source = TokenAccount::unpack(&state.source.account.data)
            .map_err(|error| Error::InvalidState(error.to_string()))?;
        Mint::unpack(&state.mint.1.data).map_err(|error| Error::InvalidState(error.to_string()))?;
        let (authority_address, bump) =
            SubscriptionAuthority::find_pda(&source.owner, &source.mint);
        let source_address = Pubkey::find_program_address(
            &[
                source.owner.as_ref(),
                token_id.as_ref(),
                source.mint.as_ref(),
            ],
            &solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        )
        .0;
        if state.mint.0 != source.mint
            || state.authority.0 != authority_address
            || state.source.address != source_address
        {
            return Err(Error::InvalidState(
                "source, mint or authority binding".into(),
            ));
        }
        let authority = if absent(&state.authority.1) {
            None
        } else {
            let account = &state.authority.1;
            if account.owner != SUBSCRIPTIONS_ID
                || account.executable
                || account.data.len() != 106
                || account.data.first() != Some(&0)
            {
                return Err(Error::InvalidState(
                    "authority kind, owner or length".into(),
                ));
            }
            let authority = SubscriptionAuthority::from_bytes(&account.data)
                .map_err(|error| Error::InvalidState(error.to_string()))?;
            if authority.user != source.owner
                || authority.token_mint != source.mint
                || authority.bump != bump
            {
                return Err(Error::InvalidState("authority identity".into()));
            }
            Some(authority)
        };
        let grant = delegation(state)?;
        let plan = plan(state)?;
        if let Some(grant) = &grant {
            let header = grant.header();
            let (authority, mint) = match grant {
                Delegation::Fixed(grant) => (grant.subscription_authority, grant.mint),
                Delegation::Recurring(grant) => (grant.subscription_authority, grant.mint),
                Delegation::Subscription(_) => {
                    let plan = plan.as_ref().ok_or(Error::InsufficientEvidence)?;
                    let address = state.plan.as_ref().ok_or(Error::InsufficientEvidence)?.0;
                    let (expected, bump) =
                        SubscriptionDelegation::find_pda(&address, &header.delegator);
                    if header.delegatee != address
                        || state.delegation.0 != expected
                        || header.bump != bump
                    {
                        return Err(Error::InvalidState("subscription binding".into()));
                    }
                    check_authority(&state.source, header.delegator)?;
                    for key in [plan.owner].into_iter().chain(plan.data.pullers) {
                        if key != Pubkey::default() {
                            check_authority(&state.source, key)?;
                        }
                    }
                    (authority_address, source.mint)
                }
            };
            if header.delegator != source.owner
                || mint != source.mint
                || authority != authority_address
            {
                return Err(Error::InvalidState("delegation binding".into()));
            }
            if !matches!(grant, Delegation::Subscription(_)) {
                check_authority(&state.source, grant.header().delegatee)?;
            }
        }
        let approved = Option::<Pubkey>::from(source.delegate) == Some(authority_address);
        let asset = Resource {
            namespace: "solana:mint".into(),
            id: source.mint.to_string(),
        };
        let technical = Authorization {
            schema_version: SCHEMA_VERSION.into(),
            id: format!(
                "{}:{}:technical:spend",
                context.program_id, state.source.address
            ),
            subject: Subject::Identity(source.owner.to_string()),
            principal: Principal::Identity(authority_address.to_string()),
            resource: Resource {
                namespace: "solana:token-account".into(),
                id: state.source.address.to_string(),
            },
            capability: Capability::Spend,
            constraints: ConstraintExpr::Constraint(Constraint::AmountAtMost {
                asset: asset.clone(),
                amount: source.delegated_amount,
            }),
            usage: UsageSemantics::Cumulative {
                remaining: Some(source.delegated_amount),
            },
            lifecycle: if source.is_frozen() {
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
        };
        let mut authorizations = if approved {
            vec![technical.clone()]
        } else {
            vec![]
        };
        if let Some(grant) = grant {
            let (amount, usage, lifecycle) = grant.terms(state.unix_timestamp, plan.as_ref())?;
            let mut active = approved
                && !source.is_frozen()
                && source.amount != 0
                && source.delegated_amount != 0
                && authority.is_some_and(|authority| authority.init_id == grant.header().init_id);
            let parent = technical.id.clone();
            let mut authorization = technical.clone();
            authorization.id = format!(
                "{}:{}:{}:spend",
                context.program_id,
                state.delegation.0,
                grant.header().init_id
            );
            authorization.principal = Principal::Identity(grant.header().delegatee.to_string());
            authorization.constraints =
                ConstraintExpr::Constraint(Constraint::AmountAtMost { asset, amount });
            if let Delegation::Subscription(grant) = &grant {
                let plan = plan.as_ref().ok_or(Error::InsufficientEvidence)?;
                active &= plan.data.terms == grant.terms;
                authorization.principal =
                    principal([plan.owner].into_iter().chain(plan.data.pullers));
                let destinations = plan
                    .data
                    .destinations
                    .into_iter()
                    .filter(|key| *key != Pubkey::default())
                    .collect::<Vec<_>>();
                if !destinations.is_empty() {
                    authorization.constraints = ConstraintExpr::All(vec![
                        authorization.constraints,
                        ConstraintExpr::Constraint(Constraint::Recipient {
                            principal: principal(destinations),
                        }),
                    ]);
                }
            }
            authorization.usage = usage;
            authorization.authority_kind = AuthorityKind::Derived {
                parents: vec![parent],
            };
            authorization.lifecycle = if active {
                lifecycle
            } else {
                Lifecycle::Suspended
            };
            authorizations.push(authorization);
        }
        if let Some(plan) = plan {
            let now = state.unix_timestamp.ok_or(Error::InsufficientEvidence)?;
            check_authority(&state.source, plan.owner)?;
            let mut administrative = technical;
            administrative.id = format!(
                "{}:{}:{}:modify-authority",
                context.program_id,
                state.plan.as_ref().ok_or(Error::InsufficientEvidence)?.0,
                plan.data.terms.created_at
            );
            administrative.resource = Resource {
                namespace: "solana:authority-set".into(),
                id: state
                    .plan
                    .as_ref()
                    .ok_or(Error::InsufficientEvidence)?
                    .0
                    .to_string(),
            };
            administrative.subject = Subject::Resource(administrative.resource.clone());
            administrative.principal = Principal::Identity(plan.owner.to_string());
            administrative.capability = Capability::ModifyAuthority;
            administrative.constraints = ConstraintExpr::True;
            administrative.usage = UsageSemantics::Unlimited;
            administrative.lifecycle =
                if plan.status == 1 && plan.data.end_ts != 0 && now > plan.data.end_ts {
                    Lifecycle::Suspended
                } else {
                    Lifecycle::Active {
                        valid_from: None,
                        valid_until: None,
                    }
                };
            administrative.authority_kind = AuthorityKind::Administrative;
            // ARM describes membership control; native edit restrictions remain in evidence.
            administrative.observability = Observability::Partial;
            authorizations.push(administrative);
        }
        Ok(authorizations)
    }

    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &DelegationState,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        let before = self
            .compile_state(state, context)?
            .into_iter()
            .find(|authorization| {
                matches!(authorization.authority_kind, AuthorityKind::Derived { .. })
            })
            .ok_or(Error::UnsupportedOperation)?;
        let grant = delegation(state)?.ok_or(Error::UnsupportedOperation)?;
        let plan = plan(state)?;
        let (kind, _) = controls(state, &grant, plan.as_ref())?
            .into_iter()
            .find(|(_, instruction)| instructions == std::slice::from_ref(instruction))
            .ok_or(Error::UnsupportedOperation)?;
        if kind == ActionKind::Revoke {
            return Ok(vec![AuthorizationChange::Removed {
                authorization: Box::new(before),
            }]);
        }
        let Delegation::Subscription(mut grant) = grant else {
            return Err(Error::UnsupportedOperation);
        };
        let now = state.unix_timestamp.ok_or(Error::InsufficientEvidence)?;
        let plan = plan.ok_or(Error::InsufficientEvidence)?;
        grant.expires_at_ts = match kind {
            ActionKind::Cancel => cancel_cutoff(&grant, &plan, now)?,
            ActionKind::CancelNow => now,
            ActionKind::Resume => 0,
            _ => return Err(Error::UnsupportedOperation),
        };
        let mut after = before.clone();
        let (_, usage, lifecycle) =
            Delegation::Subscription(grant).terms(Some(now), Some(&plan))?;
        after.usage = usage;
        if !matches!(before.lifecycle, Lifecycle::Suspended) {
            after.lifecycle = lifecycle;
        }
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
        state: &DelegationState,
        context: &Context,
    ) -> Result<Vec<Action>, Error> {
        if !self.compile_state(state, context)?.contains(authorization) {
            return Err(Error::InvalidProjection);
        }
        if !matches!(authorization.authority_kind, AuthorityKind::Derived { .. }) {
            return Ok(vec![]);
        }
        let grant = delegation(state)?.ok_or(Error::UnsupportedOperation)?;
        let plan = plan(state)?;
        Ok(controls(state, &grant, plan.as_ref())?
            .into_iter()
            .map(|(kind, instruction)| Action {
                kind,
                authorization_id: authorization.id.clone(),
                instructions: vec![instruction],
            })
            .collect())
    }
}
