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
}
