use arm::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    at: i64,
    expected: Availability,
    authorization: Authorization,
}

fn fixtures() -> Vec<Fixture> {
    serde_json::from_str(include_str!("fixtures/canonical.json")).unwrap()
}

fn direct() -> Authorization {
    fixtures().remove(0).authorization
}

fn amount(n: u64) -> ConstraintExpr {
    ConstraintExpr::Constraint(Constraint::AmountAtMost {
        asset: Resource {
            namespace: "asset".into(),
            id: "coin".into(),
        },
        amount: n,
    })
}

#[test]
fn canonical_semantics_and_serialization() {
    let raw: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/canonical.json")).unwrap();
    let cases = fixtures();
    assert_eq!(cases.len(), 10);
    for (index, case) in cases.into_iter().enumerate() {
        assert_eq!(case.authorization.validate(), Ok(()), "{}", case.name);
        assert_eq!(
            case.authorization.availability_at(case.at),
            Ok(case.expected),
            "{}",
            case.name
        );
        assert_eq!(
            serde_json::to_value(&case.authorization).unwrap(),
            raw[index]["authorization"],
            "{}",
            case.name
        );
        let first = serde_json::to_vec(&case.authorization).unwrap();
        let restored: Authorization = serde_json::from_slice(&first).unwrap();
        assert_eq!(first, serde_json::to_vec(&restored).unwrap());
    }
}

#[test]
fn lifecycle_is_half_open() {
    let mut a = direct();
    a.lifecycle = Lifecycle::Active {
        valid_from: Some(-10),
        valid_until: Some(10),
    };
    for (now, expected) in [
        (-11, Availability::Inactive),
        (-10, Availability::Conditional),
        (9, Availability::Conditional),
        (10, Availability::Inactive),
    ] {
        assert_eq!(a.availability_at(now), Ok(expected));
    }
    a.lifecycle = Lifecycle::Active {
        valid_from: Some(10),
        valid_until: Some(10),
    };
    assert_eq!(
        a.availability_at(10),
        Err(ValidationError::InvalidLifecycle)
    );
}

#[test]
fn recurring_budget_never_resets_without_evidence() {
    let mut a = direct();
    a.usage = UsageSemantics::Recurring {
        period_seconds: 60,
        anchor_unix_seconds: 0,
        observed_period_start: 60,
        remaining: Some(0),
    };
    assert_eq!(a.availability_at(59), Ok(Availability::Unknown));
    assert_eq!(a.availability_at(60), Ok(Availability::Inactive));
    assert_eq!(a.availability_at(119), Ok(Availability::Inactive));
    assert_eq!(a.availability_at(120), Ok(Availability::Unknown));
    for (period, anchor, start) in [
        (0, 0, 0),
        (u64::MAX, 0, 0),
        (60, 0, 61),
        (60, 0, -60),
        (60, i64::MIN, i64::MAX),
        (60, i64::MAX, i64::MAX),
    ] {
        a.usage = UsageSemantics::Recurring {
            period_seconds: period,
            anchor_unix_seconds: anchor,
            observed_period_start: start,
            remaining: Some(1),
        };
        assert_eq!(a.validate(), Err(ValidationError::InvalidPeriod));
    }
}

#[test]
fn absent_evidence_and_unknown_schema_fail_closed() {
    let mut a = direct();
    a.schema_version = "0.2".into();
    assert_eq!(
        a.availability_at(0),
        Err(ValidationError::UnsupportedSchema)
    );
    a.schema_version = SCHEMA_VERSION.into();
    a.evidence.references.clear();
    assert_eq!(a.validate(), Err(ValidationError::MissingEvidence));
    a.observability = Observability::Partial;
    assert_eq!(a.availability_at(0), Ok(Availability::Unknown));
    a.principal = Principal::AllOf(vec![]);
    assert_eq!(a.validate(), Err(ValidationError::EmptyIdentity));
}

#[test]
fn malformed_lineage_is_rejected_and_parents_are_not_assumed_active() {
    let mut a = direct();
    for parents in [
        vec![],
        vec![a.id.clone()],
        vec!["p".into(), "p".into()],
        vec![String::new()],
    ] {
        a.authority_kind = AuthorityKind::Derived { parents };
        assert_eq!(a.validate(), Err(ValidationError::InvalidLineage));
    }
    a.authority_kind = AuthorityKind::Derived {
        parents: vec!["parent".into()],
    };
    assert_eq!(a.availability_at(0), Ok(Availability::Unknown));
}

#[test]
fn one_shot_is_not_a_persistent_allowance() {
    let mut a = direct();
    a.usage = UsageSemantics::OneShot { consumed: None };
    assert_eq!(a.availability_at(0), Ok(Availability::Unknown));
    a.usage = UsageSemantics::OneShot {
        consumed: Some(false),
    };
    assert_eq!(a.availability_at(0), Ok(Availability::Conditional));
    a.usage = UsageSemantics::OneShot {
        consumed: Some(true),
    };
    assert_eq!(a.availability_at(0), Ok(Availability::Inactive));
}

#[test]
fn attenuation_preserves_asset_usage_and_enforcement() {
    let mut parent = direct();
    parent.constraints = amount(20);
    let mut child = parent.clone();
    child.id = "child".into();
    child.constraints = amount(10);
    assert!(child.is_proven_attenuation_of(&parent));
    assert!(!parent.is_proven_attenuation_of(&child));
    child.usage = UsageSemantics::PerOperation;
    assert!(!child.is_proven_attenuation_of(&parent));
    child.usage = parent.usage.clone();
    child.enforcement = Enforcement::Gateway;
    assert!(!child.is_proven_attenuation_of(&parent));
    let other_asset = ConstraintExpr::Constraint(Constraint::AmountAtMost {
        asset: Resource {
            namespace: "asset".into(),
            id: "other".into(),
        },
        amount: 1,
    });
    assert!(!other_asset.is_proven_subset_of(&parent.constraints));
}

fn permits(expr: &ConstraintExpr, value: u64) -> bool {
    match expr {
        ConstraintExpr::True => true,
        ConstraintExpr::False => false,
        ConstraintExpr::Constraint(Constraint::AmountAtMost { amount, .. }) => value <= *amount,
        ConstraintExpr::All(items) => items.iter().all(|x| permits(x, value)),
        ConstraintExpr::Any(items) => items.iter().any(|x| permits(x, value)),
        ConstraintExpr::Not(item) => !permits(item, value),
        _ => panic!("not in this test domain"),
    }
}

#[test]
fn boolean_implication_proofs_are_sound_over_exhaustive_small_domain() {
    let atoms = vec![
        ConstraintExpr::True,
        ConstraintExpr::False,
        amount(0),
        amount(1),
        amount(2),
        ConstraintExpr::All(vec![]),
        ConstraintExpr::Any(vec![]),
    ];
    let mut expressions = atoms.clone();
    for left in &atoms {
        expressions.push(ConstraintExpr::Not(Box::new(left.clone())));
        for right in &atoms {
            expressions.push(ConstraintExpr::All(vec![left.clone(), right.clone()]));
            expressions.push(ConstraintExpr::Any(vec![left.clone(), right.clone()]));
        }
    }
    for child in &expressions {
        for parent in &expressions {
            if child.is_proven_subset_of(parent) {
                for value in 0..=3 {
                    assert!(
                        !permits(child, value) || permits(parent, value),
                        "{child:?} is not a subset of {parent:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn json_rejects_unknown_fields_and_variants_without_dropping_constraints() {
    let mut value = serde_json::to_value(direct()).unwrap();
    value["constraints"]["kind"] = "future_constraint".into();
    assert!(serde_json::from_value::<Authorization>(value).is_err());
    let mut value = serde_json::to_value(direct()).unwrap();
    value["future_field"] = true.into();
    assert!(serde_json::from_value::<Authorization>(value).is_err());
    let mut value = serde_json::to_value(direct()).unwrap();
    value["resource"]["future_field"] = true.into();
    assert!(serde_json::from_value::<Authorization>(value).is_err());
}

#[test]
fn base_units_preserve_full_u64_range() {
    let expr = amount(u64::MAX);
    let json = serde_json::to_string(&expr).unwrap();
    assert!(json.contains("18446744073709551615"));
    assert_eq!(serde_json::from_str::<ConstraintExpr>(&json).unwrap(), expr);
}

#[test]
fn timestamp_attenuation_directions_are_not_interchangeable() {
    let before = |unix_seconds| ConstraintExpr::Constraint(Constraint::Before { unix_seconds });
    let after = |unix_seconds| ConstraintExpr::Constraint(Constraint::NotBefore { unix_seconds });
    assert!(before(-10).is_proven_subset_of(&before(10)));
    assert!(!before(10).is_proven_subset_of(&before(-10)));
    assert!(after(10).is_proven_subset_of(&after(-10)));
    assert!(!after(-10).is_proven_subset_of(&after(10)));
    assert!(!before(10).is_proven_subset_of(&after(10)));
}

#[test]
fn intent_grant_effective_state_and_change_are_separate_wire_shapes() {
    let a = direct();
    let intent = PermissionIntent {
        subject: a.subject.clone(),
        principal: a.principal.clone(),
        resource: a.resource.clone(),
        capability: a.capability.clone(),
        constraints: a.constraints.clone(),
        usage: a.usage.clone(),
        lifecycle: a.lifecycle.clone(),
        delegability: a.delegability.clone(),
        required_enforcement: Enforcement::Native,
    };
    let grant = AuthorizationGrant {
        authorization: a.clone(),
        granted_by: Principal::Identity("owner".into()),
    };
    let effective = a.effective_at(100).unwrap();
    let change = AuthorizationChange::Changed {
        before: Box::new(a.clone()),
        after: Box::new(a.clone()),
    };
    let intent_json = serde_json::to_value(&intent).unwrap();
    assert!(intent_json.get("evidence").is_none());
    assert!(serde_json::from_value::<Authorization>(intent_json.clone()).is_err());
    assert_eq!(
        serde_json::from_value::<PermissionIntent>(intent_json).unwrap(),
        intent
    );
    assert_eq!(
        serde_json::from_value::<AuthorizationGrant>(serde_json::to_value(&grant).unwrap())
            .unwrap(),
        grant
    );
    assert_eq!(
        serde_json::from_value::<EffectiveAuthorization>(serde_json::to_value(&effective).unwrap())
            .unwrap(),
        effective
    );
    assert_eq!(
        serde_json::from_value::<AuthorizationChange>(serde_json::to_value(&change).unwrap())
            .unwrap(),
        change
    );
    assert_eq!(effective.authorization, a);
    assert_eq!(effective.evaluated_at_unix_seconds, 100);
    assert_eq!(effective.availability, Availability::Conditional);
}
