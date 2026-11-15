use crate::models::{NewTriggerEvent, TriggerEvent};
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct TriggerEventRepo {
    db: SqlitePool,
}

impl TriggerEventRepo {
    pub fn new(db: SqlitePool) -> Self {
        Self { db }
    }

    pub async fn insert(
        &self,
        event: &NewTriggerEvent,
    ) -> Result<Option<TriggerEvent>, sqlx::Error> {
        // A NULL position bypasses SQLite's unique index. Do not acknowledge
        // newly ingested evidence that cannot be replayed idempotently.
        if event.signature.is_empty()
            || event.slot.is_none_or(|value| value < 0)
            || event
                .outer_index
                .is_none_or(|value| !(0..=255).contains(&value))
            || event.inner_index.is_none_or(|value| value < 0)
        {
            return Err(sqlx::Error::Protocol("missing event position".into()));
        }
        let row = sqlx::query_as::<_, TriggerEvent>(
            r#"
            INSERT INTO trigger_events (
                    signature, program_id, discriminator, raw_data,
                    plan, subscriber, mint, amount, period_start_ts, period_end_ts, delegation,
                    slot, outer_index, inner_index, amount_units, receiver, receiver_token_account,
                    puller, payer, owner
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(signature, outer_index, inner_index) DO NOTHING
            RETURNING id, signature, program_id, discriminator, raw_data, created_at,
                    plan, subscriber, mint, amount, period_start_ts, period_end_ts, delegation,
                    slot, outer_index, inner_index, amount_units, receiver, receiver_token_account,
                    puller, payer, owner
            "#,
        )
        .bind(&event.signature)
        .bind(&event.program_id)
        .bind(event.discriminator as i64)
        .bind(&event.raw_data)
        .bind(&event.plan)
        .bind(&event.subscriber)
        .bind(&event.mint)
        .bind(event.amount)
        .bind(event.period_start_ts)
        .bind(event.period_end_ts)
        .bind(&event.delegation)
        .bind(event.slot)
        .bind(event.outer_index)
        .bind(event.inner_index)
        .bind(&event.amount_units)
        .bind(&event.receiver)
        .bind(&event.receiver_token_account)
        .bind(&event.puller)
        .bind(&event.payer)
        .bind(&event.owner)
        .fetch_optional(&self.db)
        .await?;

        if row.is_none() {
            let existing: (String, i64, Vec<u8>, Option<i64>) = sqlx::query_as(
                "SELECT program_id, discriminator, raw_data, slot FROM trigger_events \
                 WHERE signature = ? AND outer_index = ? AND inner_index = ?",
            )
            .bind(&event.signature)
            .bind(event.outer_index)
            .bind(event.inner_index)
            .fetch_one(&self.db)
            .await?;
            if existing
                != (
                    event.program_id.clone(),
                    i64::from(event.discriminator),
                    event.raw_data.clone(),
                    event.slot,
                )
            {
                return Err(sqlx::Error::Protocol("conflicting event evidence".into()));
            }
        }
        Ok(row)
    }

    pub async fn list(&self) -> Result<Vec<TriggerEvent>, sqlx::Error> {
        let rows = sqlx::query_as::<_, TriggerEvent>(
            r#"
            SELECT id, signature, program_id, discriminator, raw_data, created_at,
                    plan, subscriber, mint, amount, period_start_ts, period_end_ts, delegation,
                    slot, outer_index, inner_index, amount_units, receiver, receiver_token_account,
                    puller, payer, owner
            FROM trigger_events
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.db)
        .await?;

        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::SUBSCRIPTIONS_PROGRAM_ID;
    use crate::database::connect;

    async fn setup() -> TriggerEventRepo {
        let pool = connect("sqlite::memory:").await.unwrap();
        TriggerEventRepo::new(pool)
    }

    fn make_event() -> NewTriggerEvent {
        NewTriggerEvent {
            signature: "testsig".to_string(),
            program_id: SUBSCRIPTIONS_PROGRAM_ID.to_string(),
            discriminator: 0,
            raw_data: vec![0u8; 9],
            slot: Some(7),
            outer_index: Some(0),
            inner_index: Some(0),
            ..NewTriggerEvent::default()
        }
    }

    #[tokio::test]
    async fn inserts_and_lists_event() {
        let repo = setup().await;
        let event = make_event();

        let inserted = repo.insert(&event).await.unwrap();
        assert!(inserted.is_some());
        assert_eq!(inserted.unwrap().signature, "testsig");

        let all = repo.list().await.unwrap();
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn list_returns_empty_when_no_events() {
        let repo = setup().await;
        let all = repo.list().await.unwrap();
        assert_eq!(all.len(), 0);
    }

    #[tokio::test]
    async fn duplicate_insert_is_skipped_not_errored() {
        let repo = setup().await;
        let event = make_event();

        let first = repo.insert(&event).await.unwrap();
        assert!(first.is_some());

        let second = repo.insert(&event).await.unwrap();
        assert!(second.is_none());

        let all = repo.list().await.unwrap();
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn identical_events_at_two_positions_are_two_rows() {
        let repo = setup().await;
        let first = make_event();
        let second = NewTriggerEvent {
            inner_index: Some(1),
            ..make_event()
        };
        assert!(repo.insert(&first).await.unwrap().is_some());
        assert!(repo.insert(&second).await.unwrap().is_some());
        assert!(repo.insert(&second).await.unwrap().is_none());
        assert_eq!(repo.list().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn conflicting_replay_fails_without_replacing_retained_bytes() {
        let repo = setup().await;
        repo.insert(&make_event()).await.unwrap();
        for changed in [
            NewTriggerEvent {
                raw_data: vec![1; 9],
                ..make_event()
            },
            NewTriggerEvent {
                slot: Some(8),
                ..make_event()
            },
            NewTriggerEvent {
                program_id: "another-program".into(),
                ..make_event()
            },
        ] {
            assert!(repo.insert(&changed).await.is_err());
        }
        let rows = repo.list().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].raw_data, make_event().raw_data);
    }

    #[tokio::test]
    async fn missing_positions_cannot_bypass_replay_deduplication() {
        let repo = setup().await;
        for invalid in [
            NewTriggerEvent {
                signature: String::new(),
                ..make_event()
            },
            NewTriggerEvent {
                slot: None,
                ..make_event()
            },
            NewTriggerEvent {
                outer_index: None,
                ..make_event()
            },
            NewTriggerEvent {
                inner_index: None,
                ..make_event()
            },
        ] {
            assert!(repo.insert(&invalid).await.is_err());
        }
        assert!(repo.list().await.unwrap().is_empty());
    }
}
