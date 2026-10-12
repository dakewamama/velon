use arm::*;
use catalyst_sdk::{
    self as sdk, Action, ActionKind, Adapter, Context, Error, Protocol, SourceRequirements,
};
use solana_instruction::Instruction;
use std::cell::Cell;

struct FixtureAdapter {
    calls: Cell<u32>,
    corrupt: bool,
    duplicate: bool,
    declared: Option<Vec<AuthorizationChange>>,
}
impl FixtureAdapter {
    fn new() -> Self {
        Self {
            calls: Cell::new(0),
            corrupt: false,
            duplicate: false,
            declared: None,
        }
    }
}
struct State {
    remaining: Option<u64>,
}

fn context() -> Context {
    Context {
        program_id: Default::default(),
        native: NativeContext {
            protocol: "fixture".into(),
            deployment: "fixture:local:deployment-1".into(),
            program_version: "1".into(),
            adapter_version: "0.1".into(),
        },
        evidence: EvidenceBundle {
            references: vec!["fixture:account:source".into()],
            observed_at: "fixture:slot:1".into(),
        },
    }
}

impl Adapter for FixtureAdapter {
    type State = State;
    fn protocol(&self) -> Protocol {
        Protocol {
            name: "fixture",
            program_id: Default::default(),
        }
    }
    fn supports(&self, native: &NativeContext) -> bool {
        native == &context().native
    }
    fn source_requirements(&self, _: &State) -> SourceRequirements {
        SourceRequirements {
            accounts: vec![Default::default()],
            clock: false,
        }
    }
    fn compile_state(&self, state: &State, context: &Context) -> Result<Vec<Authorization>, Error> {
        self.calls.set(self.calls.get() + 1);
        let Some(remaining) = state.remaining else {
            return Ok(vec![]);
        };
        let resource = Resource {
            namespace: "fixture:account".into(),
            id: "source".into(),
        };
        let mut authorization = Authorization {
            schema_version: SCHEMA_VERSION.into(),
            id: "fixture:source:delegate:spend".into(),
            subject: Subject::Identity("owner".into()),
            principal: Principal::Identity("delegate".into()),
            resource: resource.clone(),
            capability: Capability::Spend,
            constraints: ConstraintExpr::Constraint(Constraint::AmountAtMost {
                asset: resource,
                amount: remaining,
            }),
            usage: UsageSemantics::Cumulative {
                remaining: Some(remaining),
            },
            lifecycle: Lifecycle::Active {
                valid_from: None,
                valid_until: None,
            },
            delegability: Delegability::None,
            authority_kind: AuthorityKind::Direct,
            enforcement: Enforcement::Native,
            observability: Observability::Exact,
            evidence: context.evidence.clone(),
            native_context: context.native.clone(),
        };
        if self.corrupt {
            authorization.evidence.observed_at = "fixture:wrong-observation".into();
        }
        if self.duplicate {
            return Ok(vec![authorization.clone(), authorization]);
        }
        Ok(vec![authorization])
    }
    fn diff_transaction(
        &self,
        instructions: &[Instruction],
        state: &State,
        context: &Context,
    ) -> Result<Vec<AuthorizationChange>, Error> {
        self.calls.set(self.calls.get() + 1);
        if instructions.len() != 1 || instructions[0].data != [0] {
            return Err(Error::UnsupportedOperation);
        }
        if let Some(changes) = &self.declared {
            return Ok(changes.clone());
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
        _: &State,
        _: &Context,
    ) -> Result<Vec<Action>, Error> {
        self.calls.set(self.calls.get() + 1);
        Ok(vec![Action {
            kind: ActionKind::Revoke,
            authorization_id: authorization.id.clone(),
            instructions: vec![Instruction::new_with_bytes(
                Default::default(),
                &[0],
                vec![],
            )],
        }])
    }
}

#[test]
fn typed_state_compiles_deterministically_with_source_evidence() {
    let adapter = FixtureAdapter::new();
    let context = context();
    let state = State {
        remaining: Some(u64::MAX),
    };
    let first = sdk::compile_state(&adapter, &state, &context).unwrap();
    let second = sdk::compile_state(&adapter, &state, &context).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(first[0].evidence, context.evidence);
    assert_eq!(first[0].native_context, context.native);
    assert_eq!(
        adapter.source_requirements(&state),
        SourceRequirements {
            accounts: vec![Default::default()],
            clock: false
        }
    );
    assert_eq!(adapter.protocol().program_id, context.program_id);
}

#[test]
fn unknown_versions_reject_before_any_adapter_operation() {
    let adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let supported = context();
    let a = sdk::compile_state(&adapter, &state, &supported)
        .unwrap()
        .remove(0);
    let calls = adapter.calls.get();
    for field in 0..5 {
        let mut unknown = context();
        match field {
            0 => unknown.native.program_version = "future".into(),
            1 => unknown.native.deployment = "other".into(),
            2 => unknown.native.adapter_version = "future".into(),
            3 => unknown.native.protocol = "other".into(),
            _ => unknown.program_id = solana_pubkey::Pubkey::new_from_array([1; 32]),
        }
        assert_eq!(
            sdk::compile_state(&adapter, &state, &unknown),
            Err(Error::UnsupportedVersion)
        );
        assert_eq!(
            sdk::diff_transaction(&adapter, &[], &state, &unknown),
            Err(Error::UnsupportedVersion)
        );
        assert_eq!(
            sdk::actions(&adapter, &a, &state, &unknown),
            Err(Error::UnsupportedVersion)
        );
    }
    assert_eq!(adapter.calls.get(), calls);
}

#[test]
fn missing_evidence_and_corrupt_projection_reject() {
    let adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let mut missing = context();
    missing.evidence.references.clear();
    assert_eq!(
        sdk::compile_state(&adapter, &state, &missing),
        Err(Error::InsufficientEvidence)
    );
    assert_eq!(adapter.calls.get(), 0);
    let corrupt = FixtureAdapter {
        calls: Cell::new(0),
        corrupt: true,
        duplicate: false,
        declared: None,
    };
    assert_eq!(
        sdk::compile_state(&corrupt, &state, &context()),
        Err(Error::InvalidProjection)
    );
}

#[test]
fn duplicate_authorization_identity_rejects_the_whole_projection() {
    let adapter = FixtureAdapter {
        calls: Cell::new(0),
        corrupt: false,
        duplicate: true,
        declared: None,
    };
    assert_eq!(
        sdk::compile_state(&adapter, &State { remaining: Some(5) }, &context()),
        Err(Error::InvalidProjection)
    );
}

#[test]
fn declared_revoke_uses_standard_instructions_and_retains_removed_evidence() {
    let adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let context = context();
    let a = sdk::compile_state(&adapter, &state, &context)
        .unwrap()
        .remove(0);
    let actions = sdk::actions(&adapter, &a, &state, &context).unwrap();
    let diff = sdk::diff_transaction(&adapter, &actions[0].instructions, &state, &context).unwrap();
    assert_eq!(
        diff,
        vec![AuthorizationChange::Removed {
            authorization: Box::new(a)
        }]
    );
    assert_eq!(
        sdk::diff_transaction(&adapter, &[], &state, &context),
        Err(Error::UnsupportedOperation)
    );
    assert!(
        sdk::compile_state(&adapter, &State { remaining: None }, &context)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn action_requires_the_current_observation_not_stale_evidence() {
    let adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let mut context = context();
    let a = sdk::compile_state(&adapter, &state, &context)
        .unwrap()
        .remove(0);
    context.evidence.observed_at = "fixture:slot:2".into();
    assert_eq!(
        sdk::actions(&adapter, &a, &state, &context),
        Err(Error::InvalidProjection)
    );
}

#[test]
fn verified_diff_applies_add_change_remove_and_empty_declarations() {
    let before_context = context();
    let mut after_context = context();
    after_context.evidence.observed_at = "fixture:slot:2".into();
    after_context.evidence.references = vec!["fixture:simulation:result".into()];
    let adapter = FixtureAdapter::new();
    let empty = State { remaining: None };
    let old = State { remaining: Some(5) };
    let new = State {
        remaining: Some(u64::MAX),
    };
    let previous = sdk::compile_state(&adapter, &old, &before_context)
        .unwrap()
        .remove(0);
    let next = sdk::compile_state(&adapter, &new, &before_context)
        .unwrap()
        .remove(0);
    let instruction = Instruction::new_with_bytes(Default::default(), &[0], vec![]);
    for (before, after, changes) in [
        (
            &empty,
            &old,
            vec![AuthorizationChange::Added {
                authorization: Box::new(previous.clone()),
            }],
        ),
        (
            &old,
            &new,
            vec![AuthorizationChange::Changed {
                before: Box::new(previous.clone()),
                after: Box::new(next),
            }],
        ),
        (
            &old,
            &empty,
            vec![AuthorizationChange::Removed {
                authorization: Box::new(previous),
            }],
        ),
        (&old, &old, vec![]),
    ] {
        let mut adapter = FixtureAdapter::new();
        adapter.declared = Some(changes.clone());
        assert_eq!(
            sdk::verify_transaction_diff(
                &adapter,
                std::slice::from_ref(&instruction),
                before,
                &before_context,
                after,
                &after_context
            ),
            Ok(changes)
        );
    }
}

#[test]
fn verified_diff_rejects_stale_preconditions_duplicate_effects_and_disagreement() {
    let mut adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let known = context();
    let authorization = sdk::compile_state(&adapter, &state, &known)
        .unwrap()
        .remove(0);
    let mut stale = authorization.clone();
    stale.usage = UsageSemantics::Cumulative { remaining: Some(4) };
    let removed = AuthorizationChange::Removed {
        authorization: Box::new(authorization.clone()),
    };
    let instruction = Instruction::new_with_bytes(Default::default(), &[0], vec![]);
    for changes in [
        vec![AuthorizationChange::Added {
            authorization: Box::new(authorization.clone()),
        }],
        vec![AuthorizationChange::Removed {
            authorization: Box::new(stale),
        }],
        vec![removed.clone(), removed.clone()],
        vec![
            removed,
            AuthorizationChange::Added {
                authorization: Box::new(authorization),
            },
        ],
        vec![],
    ] {
        adapter.declared = Some(changes);
        assert_eq!(
            sdk::verify_transaction_diff(
                &adapter,
                std::slice::from_ref(&instruction),
                &state,
                &known,
                &State { remaining: None },
                &known
            ),
            Err(Error::DiffMismatch)
        );
    }
}

#[test]
fn verified_diff_checks_both_contexts_before_interpretation() {
    let adapter = FixtureAdapter::new();
    let state = State { remaining: Some(5) };
    let known = context();
    let mut unknown = known.clone();
    unknown.native.program_version = "future".into();
    for (before, after) in [(&known, &unknown), (&unknown, &known)] {
        assert_eq!(
            sdk::verify_transaction_diff(&adapter, &[], &state, before, &state, after),
            Err(Error::UnsupportedVersion)
        );
    }
    let mut missing = known.clone();
    missing.evidence.references.clear();
    assert_eq!(
        sdk::verify_transaction_diff(&adapter, &[], &state, &known, &state, &missing),
        Err(Error::InsufficientEvidence)
    );
    assert_eq!(adapter.calls.get(), 0);
}
