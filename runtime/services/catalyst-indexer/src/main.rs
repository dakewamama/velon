use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    middleware as axum_middleware,
    routing::{get, post},
};
use tokio::net::TcpListener;

mod constants;
mod extractor;
mod types;

use extractor::extract_events;
use types::WebhookPayload;

mod database;
mod models;
mod repositories;
mod state;

use constants::SUBSCRIPTIONS_PROGRAM_ID;
use models::NewTriggerEvent;
use state::AppState;

mod decoder;
mod events;

mod middleware;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt::init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://catalyst.db".to_string());
    let state: AppState = AppState::new(&database_url).await.unwrap();

    let app = Router::new()
        .route("/health", get(health))
        .route(
            "/webhook/helius",
            post(webhook).layer(axum_middleware::from_fn(
                middleware::verify_helius_signature,
            )),
        )
        .with_state(state);

    let listener = TcpListener::bind("0.0.0.0:3000").await.unwrap();
    tracing::info!("catalyst-indexer listening on port 3000");
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

/// The stored row for one event: where it sits, its raw bytes, and every field the decoder read.
/// Amounts above i64 stay exact in `amount_units`; `amount` is left empty rather than wrapped.
fn record(
    event: &extractor::ExtractedEvent,
    decoded: Option<&events::CatalystEvent>,
) -> NewTriggerEvent {
    use events::CatalystEvent::*;
    let mut row = NewTriggerEvent {
        signature: event.signature.clone(),
        program_id: SUBSCRIPTIONS_PROGRAM_ID.to_string(),
        discriminator: event.bytes[8],
        raw_data: event.bytes.clone(),
        slot: i64::try_from(event.slot).ok(),
        outer_index: Some(i64::from(event.outer_index)),
        inner_index: i64::try_from(event.inner_index).ok(),
        ..NewTriggerEvent::default()
    };
    let units = |amount: u64| (i64::try_from(amount).ok(), Some(amount.to_string()));
    match decoded {
        Some(SubscriptionCreated(e)) => {
            row.plan = Some(e.plan.clone());
            row.subscriber = Some(e.subscriber.clone());
            row.mint = Some(e.mint.clone());
            row.payer = e.payer.clone();
        }
        Some(SubscriptionCancelled(e)) => {
            row.plan = Some(e.plan.clone());
            row.subscriber = Some(e.subscriber.clone());
            row.period_end_ts = Some(e.expires_at_ts);
        }
        Some(SubscriptionTransfer(e)) => {
            row.plan = Some(e.plan.clone());
            row.subscriber = Some(e.delegator.clone());
            row.mint = Some(e.mint.clone());
            (row.amount, row.amount_units) = units(e.amount);
            row.period_start_ts = Some(e.period_start_ts);
            row.period_end_ts = Some(e.period_end_ts);
            row.delegation = Some(e.subscription.clone());
            row.receiver = Some(e.receiver.clone());
            row.receiver_token_account = e.receiver_token_account.clone();
            row.puller = e.puller.clone();
        }
        // The program requires the delegatee's signature on every fixed and recurring pull.
        Some(FixedTransfer(e)) => {
            row.subscriber = Some(e.delegator.clone());
            row.mint = Some(e.mint.clone());
            (row.amount, row.amount_units) = units(e.amount);
            row.delegation = Some(e.delegation.clone());
            row.receiver = Some(e.receiver.clone());
            row.receiver_token_account = e.receiver_token_account.clone();
            row.puller = Some(e.delegatee.clone());
        }
        Some(RecurringTransfer(e)) => {
            row.subscriber = Some(e.delegator.clone());
            row.mint = Some(e.mint.clone());
            (row.amount, row.amount_units) = units(e.amount);
            row.period_start_ts = Some(e.period_start_ts);
            row.period_end_ts = Some(e.period_end_ts);
            row.delegation = Some(e.delegation.clone());
            row.receiver = Some(e.receiver.clone());
            row.receiver_token_account = e.receiver_token_account.clone();
            row.puller = Some(e.delegatee.clone());
        }
        Some(SubscriptionResumed(e)) => {
            row.plan = Some(e.plan.clone());
            row.subscriber = Some(e.subscriber.clone());
        }
        Some(PlanUpdated(e)) => {
            row.plan = Some(e.plan.clone());
            row.owner = Some(e.owner.clone());
            row.period_end_ts = Some(e.end_ts);
        }
        None => {}
    }
    row
}

async fn webhook(State(state): State<AppState>, Json(payload): Json<WebhookPayload>) -> StatusCode {
    let raw_events = extract_events(&payload);

    for event in &raw_events {
        let discriminator = event.bytes[8];
        let decoded = decoder::decode_event(&event.bytes);
        let new_event = record(event, decoded.as_ref());

        match state.trigger_event_repo.insert(&new_event).await {
            Ok(Some(e)) => {
                tracing::info!(
                    id = e.id,
                    slot = event.slot,
                    discriminator,
                    "event persisted"
                );
                if let Some(ev) = decoded {
                    let _ = state.event_tx.send(ev);
                }
            }
            Ok(None) => {
                tracing::info!(discriminator, "duplicate event skipped");
            }
            Err(err) => {
                tracing::error!(error = %err, "failed to persist event");
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
    }

    tracing::info!(count = raw_events.len(), "webhook processed");
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::util::ServiceExt;

    async fn build_app() -> Router {
        let state: AppState = AppState::new("sqlite::memory:").await.unwrap();
        Router::new()
            .route("/health", get(health))
            .route("/webhook/helius", post(webhook))
            .with_state(state)
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn webhook_with_no_events_returns_ok() {
        let app = build_app().await;
        let body = r#"[{
            "slot": 123,
            "meta": { "innerInstructions": [] },
            "transaction": {
                "message": { "accountKeys": [] },
                "signatures": ["sig123"]
            }
        }]"#;
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhook/helius")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn a_pull_above_i64_is_kept_exact_and_names_who_pulled() {
        let mut bytes = crate::constants::EVENT_IX_TAG.to_vec();
        bytes.push(4);
        for byte in 1..=4u8 {
            bytes.extend_from_slice(&[byte; 32]);
        }
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        bytes.extend_from_slice(&[0; 24]);
        bytes.extend_from_slice(&[5; 32]);
        bytes.extend_from_slice(&[6; 32]);
        let event = extractor::ExtractedEvent {
            signature: "sig".into(),
            slot: 9,
            outer_index: 1,
            inner_index: 3,
            bytes,
        };
        let row = record(&event, decoder::decode_event(&event.bytes).as_ref());
        assert_eq!(
            (row.amount, row.amount_units.as_deref()),
            (None, Some("18446744073709551615"))
        );
        assert_eq!(
            (row.slot, row.outer_index, row.inner_index),
            (Some(9), Some(1), Some(3))
        );
        assert_eq!(row.puller, Some(bs58::encode([3u8; 32]).into_string()));
        assert_eq!(
            row.receiver_token_account,
            Some(bs58::encode([6u8; 32]).into_string())
        );
    }
}
