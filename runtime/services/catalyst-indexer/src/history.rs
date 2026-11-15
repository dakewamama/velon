//! Retained transaction facts under finalized RPC trust. No account incarnation,
//! historical program deployment or business identity is inferred from an event.
use crate::{Error, Journal, constants::SUBSCRIPTIONS_PROGRAM_ID, decoder, extractor, types};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::request::RpcRequest;
use solana_transaction_status_client_types::{
    UiCompiledInstruction, UiInnerInstructions, UiInstruction, UiRawMessage,
};
use sqlx::Row;
use std::{collections::BTreeSet, time::Duration};

const PAGE: usize = 25;
const INVALID: Error = Error::InvalidObservation("invalid historical transaction evidence");

fn hash(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

pub async fn receive(database: &sqlx::SqlitePool, payload: &Value) -> Result<(), Error> {
    let transactions = payload.as_array().ok_or(INVALID)?;
    let raw = serde_json::to_string(payload)?;
    let id = hash(&raw);
    let mut transaction = database.begin().await?;
    sqlx::query("INSERT INTO webhook_deliveries VALUES (?,?) ON CONFLICT DO NOTHING")
        .bind(&id)
        .bind(&raw)
        .execute(&mut *transaction)
        .await?;
    let previous: String = sqlx::query_scalar("SELECT payload FROM webhook_deliveries WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *transaction)
        .await?;
    if hash(&previous) != id {
        return Err(Error::ReplayMismatch);
    }
    for value in transactions {
        if let Some(signature) = value
            .pointer("/transaction/signatures/0")
            .and_then(Value::as_str)
        {
            let address = value
                .pointer("/transaction/message/accountKeys/0")
                .and_then(Value::as_str);
            sqlx::query("INSERT INTO webhook_receipts VALUES (?,?,?) ON CONFLICT DO NOTHING")
                .bind(signature)
                .bind(&id)
                .bind(address)
                .execute(&mut *transaction)
                .await?;
        }
    }
    transaction.commit().await?;
    Ok(())
}

fn keys(raw: &Value) -> Result<BTreeSet<String>, Error> {
    if !raw
        .pointer("/transaction/message/accountKeys")
        .is_some_and(Value::is_array)
    {
        return Err(INVALID);
    }
    let mut keys = BTreeSet::new();
    for values in [
        raw.pointer("/transaction/message/accountKeys"),
        raw.pointer("/meta/loadedAddresses/writable"),
        raw.pointer("/meta/loadedAddresses/readonly"),
    ]
    .into_iter()
    .flatten()
    {
        for value in values.as_array().ok_or(INVALID)? {
            let key = value.as_str().ok_or(INVALID)?;
            key.parse::<Pubkey>().map_err(|_| INVALID)?;
            keys.insert(key.into());
        }
    }
    if keys.is_empty() {
        return Err(INVALID);
    }
    Ok(keys)
}

impl Journal {
    /// Caller must obtain this response with finalized commitment, independently
    /// of webhook delivery. This trusted ingestion API cannot authenticate an RPC.
    pub async fn retain_activity(
        &self,
        cluster: &str,
        signature: &str,
        slot: u64,
        source: &str,
        raw: Value,
    ) -> Result<(), Error> {
        if cluster.is_empty()
            || source.is_empty()
            || source.len() > 128
            || raw["slot"].as_u64() != Some(slot)
            || raw
                .pointer("/transaction/signatures/0")
                .and_then(Value::as_str)
                != Some(signature)
            || raw.pointer("/meta/err").is_none()
        {
            return Err(INVALID);
        }
        let addresses = keys(&raw)?;
        let encoded = serde_json::to_string(&raw)?;
        let digest = hash(&encoded);
        let mut transaction = self.database.begin().await?;
        sqlx::query("INSERT INTO activity_transactions \
            (cluster,signature,slot_units,slot_order,raw_json,sha256,source_id) VALUES (?,?,?,?,?,?,?) \
            ON CONFLICT(cluster,signature) DO NOTHING")
            .bind(cluster).bind(signature).bind(slot.to_string()).bind(slot.to_be_bytes().as_slice())
            .bind(&encoded).bind(&digest).bind(source).execute(&mut *transaction).await?;
        let previous: String = sqlx::query_scalar(
            "SELECT sha256 FROM activity_transactions WHERE cluster=? AND signature=?",
        )
        .bind(cluster)
        .bind(signature)
        .fetch_one(&mut *transaction)
        .await?;
        if previous != digest {
            return Err(Error::Conflict);
        }
        for address in addresses {
            sqlx::query("INSERT INTO activity_addresses VALUES (?,?,?) ON CONFLICT DO NOTHING")
                .bind(cluster)
                .bind(signature)
                .bind(address)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn activity_transaction(
        &self,
        cluster: &str,
        signature: &str,
    ) -> Result<Value, Error> {
        let row = sqlx::query(
            "SELECT raw_json,sha256 FROM activity_transactions WHERE cluster=? AND signature=?",
        )
        .bind(cluster)
        .bind(signature)
        .fetch_optional(&self.database)
        .await?
        .ok_or(Error::NotFound)?;
        let raw: String = row.try_get("raw_json")?;
        if hash(&raw) != row.try_get::<String, _>("sha256")? {
            return Err(Error::ReplayMismatch);
        }
        Ok(serde_json::from_str(&raw)?)
    }

    pub async fn activity(
        &self,
        cluster: &str,
        address: Pubkey,
        query: Page,
    ) -> Result<Value, Error> {
        let limit = query.limit.unwrap_or(PAGE);
        if !(1..=100).contains(&limit) {
            return Err(INVALID);
        }
        let cursor_slot: Option<Vec<u8>> = match query.before.as_deref() {
            Some(signature) => Some(
                sqlx::query_scalar(
                    "SELECT slot_order FROM activity_transactions WHERE cluster=? AND signature=?",
                )
                .bind(cluster)
                .bind(signature)
                .fetch_optional(&self.database)
                .await?
                .ok_or(Error::NotFound)?,
            ),
            None => None,
        };
        let rows = sqlx::query(
            "SELECT t.signature,t.raw_json,t.sha256,t.source_id FROM activity_transactions t \
            JOIN activity_addresses a USING(cluster,signature) WHERE t.cluster=? AND a.address=? \
            AND (? IS NULL OR t.slot_order < ? OR (t.slot_order = ? AND t.signature < ?)) \
            ORDER BY t.slot_order DESC,t.signature DESC LIMIT ?",
        )
        .bind(cluster)
        .bind(address.to_string())
        .bind(&cursor_slot)
        .bind(&cursor_slot)
        .bind(&cursor_slot)
        .bind(&query.before)
        .bind(limit as i64)
        .fetch_all(&self.database)
        .await?;
        let mut events = Vec::new();
        let mut transactions = Vec::new();
        for row in &rows {
            let raw: String = row.try_get("raw_json")?;
            let digest: String = row.try_get("sha256")?;
            if hash(&raw) != digest {
                return Err(Error::ReplayMismatch);
            }
            let raw: Value = serde_json::from_str(&raw)?;
            let signature: String = row.try_get("signature")?;
            let source: String = row.try_get("source_id")?;
            let decoded = normalize(cluster, &address.to_string(), &raw, &digest);
            let (entries, mut status) = match decoded {
                Ok(entries) => {
                    let status = if entries.iter().any(|entry| entry["kind"] == "unknown") {
                        "incomplete"
                    } else {
                        "decoded_unverified_deployment"
                    };
                    (entries, status)
                }
                Err(_) => (vec![], "incomplete"),
            };
            if !raw["meta"]["err"].is_null() {
                status = "failed_execution";
            }
            events.extend(entries);
            transactions.push(json!({"signature":signature,"source":source,"status":status,
                "evidence":format!("/activity/transactions/{cluster}/{signature}"),"sha256":digest}));
        }
        let gaps: Vec<(String,String,String)> = sqlx::query_as(
            "SELECT signature,source_id,reason FROM activity_gaps WHERE cluster=? AND address=? ORDER BY signature LIMIT 100")
            .bind(cluster).bind(address.to_string()).fetch_all(&self.database).await?;
        let gap_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM activity_gaps WHERE cluster=? AND address=?")
                .bind(cluster)
                .bind(address.to_string())
                .fetch_one(&self.database)
                .await?;
        let gaps:Vec<_>=gaps.into_iter().map(|(signature,source,reason)|json!({"signature":signature,"source":source,"reason":reason})).collect();
        let next = if rows.len() == limit {
            rows.last().map(|row| row.get::<String, _>("signature"))
        } else {
            None
        };
        Ok(
            json!({"schema_version":"1","cluster":cluster,"delegation":address.to_string(),
            "complete":false,"coverage":{"archive":"unproven","protocols":["subscriptions"],"gaps":gaps,"gap_count":gap_count},
            "attribution":"unresolved","transaction_order":"slot_then_signature_not_execution_order",
            "events":events,"transactions":transactions,"next":next}),
        )
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub limit: Option<usize>,
    pub before: Option<String>,
}

pub async fn page(
    State(journal): State<Journal>,
    Path((cluster, address)): Path<(String, String)>,
    Query(query): Query<Page>,
) -> Result<Json<Value>, StatusCode> {
    let address = address.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    journal
        .activity(&cluster, address, query)
        .await
        .map(Json)
        .map_err(status)
}

pub async fn transaction(
    State(journal): State<Journal>,
    Path((cluster, signature)): Path<(String, String)>,
) -> Result<Json<Value>, StatusCode> {
    journal
        .activity_transaction(&cluster, &signature)
        .await
        .map(Json)
        .map_err(status)
}

fn status(error: Error) -> StatusCode {
    match error {
        Error::NotFound => StatusCode::NOT_FOUND,
        Error::InvalidObservation(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// Use the native RPC representations for message/header and instruction formats.
// Account lookup resolution still comes from the retained RPC metadata, not today's tables.
fn validate_instructions(raw: &Value, tx: &types::RawTransaction) -> Result<(), Error> {
    let message: UiRawMessage =
        serde_json::from_value(raw.pointer("/transaction/message").ok_or(INVALID)?.clone())?;
    if raw
        .get("version")
        .is_some_and(|version| version != 0 && version != "legacy")
    {
        return Err(INVALID);
    }
    let static_count = message.account_keys.len();
    let required = usize::from(message.header.num_required_signatures);
    if required == 0
        || required > static_count
        || required != tx.transaction.signatures.len()
        || usize::from(message.header.num_readonly_signed_accounts) >= required
        || usize::from(message.header.num_readonly_unsigned_accounts) > static_count - required
    {
        return Err(INVALID);
    }
    let mut writable = 0;
    let mut readonly = 0;
    if message
        .address_table_lookups
        .as_ref()
        .is_some_and(|lookups| !lookups.is_empty())
        && raw.get("version") != Some(&json!(0))
    {
        return Err(INVALID);
    }
    for lookup in message.address_table_lookups.as_deref().unwrap_or_default() {
        lookup.account_key.parse::<Pubkey>().map_err(|_| INVALID)?;
        writable += lookup.writable_indexes.len();
        readonly += lookup.readonly_indexes.len();
    }
    if writable != tx.meta.loaded_addresses.writable.len()
        || readonly != tx.meta.loaded_addresses.readonly.len()
        || static_count + writable + readonly > 256
    {
        return Err(INVALID);
    }
    let keys = message
        .account_keys
        .iter()
        .chain(&tx.meta.loaded_addresses.writable)
        .chain(&tx.meta.loaded_addresses.readonly)
        .collect::<Vec<_>>();
    let check = |instruction: &UiCompiledInstruction| -> Result<(), Error> {
        if usize::from(instruction.program_id_index) >= keys.len()
            || instruction
                .accounts
                .iter()
                .any(|index| usize::from(*index) >= keys.len())
        {
            return Err(INVALID);
        }
        let bytes = bs58::decode(&instruction.data)
            .into_vec()
            .map_err(|_| INVALID)?;
        if keys[usize::from(instruction.program_id_index)].as_str() == SUBSCRIPTIONS_PROGRAM_ID
            && bytes.as_slice() == crate::constants::EVENT_IX_TAG
        {
            return Err(INVALID);
        }
        Ok(())
    };
    for instruction in &message.instructions {
        check(instruction)?;
    }
    let groups: Vec<UiInnerInstructions> =
        serde_json::from_value(raw["meta"]["innerInstructions"].clone())?;
    let mut positions = BTreeSet::new();
    for group in groups {
        if usize::from(group.index) >= message.instructions.len() || !positions.insert(group.index)
        {
            return Err(INVALID);
        }
        for instruction in group.instructions {
            let UiInstruction::Compiled(instruction) = instruction else {
                return Err(INVALID);
            };
            check(&instruction)?;
        }
    }
    Ok(())
}

fn normalize(cluster: &str, address: &str, raw: &Value, digest: &str) -> Result<Vec<Value>, Error> {
    let meta = raw.get("meta").ok_or(INVALID)?;
    if !meta["err"].is_null() {
        return Ok(vec![]);
    }
    if !meta["innerInstructions"].is_array() {
        return Err(INVALID);
    }
    let tx: types::RawTransaction = serde_json::from_value(raw.clone())?;
    validate_instructions(raw, &tx)?;
    let mut result = Vec::new();
    let mut positions = BTreeSet::new();
    for event in extractor::extract_events(&vec![tx]) {
        if !positions.insert((event.outer_index, event.inner_index)) {
            return Err(INVALID);
        }
        let mut decoded = serde_json::to_value(decoder::decode_event(&event.bytes))?;
        // Unknown layouts remain present as raw events for transactions mentioning
        // the queried address, never as a guessed transfer or permission.
        let mut mentions = decoded.is_null();
        if let Some(data) = decoded.as_object_mut() {
            mentions = data.values().any(|value| value.as_str() == Some(address));
            for field in ["amount", "remaining_amount", "amount_pulled_in_period"] {
                if let Some(value) = data.get_mut(field) {
                    *value = Value::String(value.to_string());
                }
            }
            let kind = data["kind"].as_str().ok_or(INVALID)?.to_owned();
            match kind.as_str() {
                "subscription_transfer" | "fixed_transfer" | "recurring_transfer" => {
                    data.insert("kind".into(), json!("pull"));
                    if let Some(value) = data.remove("subscription") {
                        data.insert("delegation".into(), value);
                    }
                    if !data.contains_key("puller")
                        && let Some(value) = data.get("delegatee").cloned()
                    {
                        data.insert("puller".into(), value);
                    }
                    if let Some(value) = data.remove("receiver_token_account") {
                        data.insert("receiverTokenAccount".into(), value);
                    }
                }
                "subscription_created" | "subscription_cancelled" | "subscription_resumed" => {
                    let plan = data["plan"]
                        .as_str()
                        .ok_or(INVALID)?
                        .parse::<Pubkey>()
                        .map_err(|_| INVALID)?;
                    let subscriber = data["subscriber"]
                        .as_str()
                        .ok_or(INVALID)?
                        .parse::<Pubkey>()
                        .map_err(|_| INVALID)?;
                    let program = SUBSCRIPTIONS_PROGRAM_ID
                        .parse::<Pubkey>()
                        .map_err(|_| INVALID)?;
                    let (pda, _) = Pubkey::find_program_address(
                        &[b"subscription", plan.as_ref(), subscriber.as_ref()],
                        &program,
                    );
                    mentions |= pda.to_string() == address;
                    let (label, from, to) = match kind.as_str() {
                        "subscription_created" => ("created", "created_ts", "at"),
                        "subscription_cancelled" => ("cancelled", "expires_at_ts", "expiresAt"),
                        _ => ("resumed", "resumed_ts", "at"),
                    };
                    data.insert("kind".into(), json!(label));
                    if let Some(value) = data.remove(from) {
                        data.insert(to.into(), Value::String(value.to_string()));
                    }
                }
                _ => {}
            }
        }
        if !mentions {
            continue;
        }
        let position = format!("{}:{}", event.outer_index, event.inner_index);
        let id = hash(&serde_json::to_string(&(
            "velon:event:1",
            cluster,
            SUBSCRIPTIONS_PROGRAM_ID,
            &event.signature,
            &position,
        ))?);
        let mut value = decoded.as_object().cloned().unwrap_or_default();
        value.entry("kind").or_insert(json!("unknown"));
        value.extend(serde_json::from_value::<serde_json::Map<String, Value>>(
            json!({
                "id":id,"signature":event.signature,"slot":event.slot.to_string(),
                "time":raw["blockTime"].as_i64().map(|time| time.to_string()),
                "outer":event.outer_index,"inner":event.inner_index,"transaction_index":null,
                "rawEvent":STANDARD.encode(event.bytes),"program":SUBSCRIPTIONS_PROGRAM_ID,
            "evidence":format!("rpc-transaction:sha256:{digest}"),"finality":"finalized_rpc",
            "interpretation":"unverified_event_layout",
                "attribution":{"status":"unresolved","incarnation":null,"authorization":null,
                    "deployment":null,"stateVersion":null}
            }),
        )?);
        result.push(Value::Object(value));
    }
    Ok(result)
}

async fn request(client: &RpcClient, method: RpcRequest, params: Value) -> Result<Value, Error> {
    let mut last = None;
    for attempt in 0..3 {
        match client.send(method, params.clone()).await {
            Ok(value) => return Ok(value),
            Err(error) => last = Some(error),
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(200 << attempt)).await;
        }
    }
    Err(last.unwrap().into())
}

/// Resumable backwards pagination. A short or empty provider page is never an
/// archival completeness proof. `recent` re-reads the tip without moving backfill.
pub async fn collect(
    journal: &Journal,
    client: &RpcClient,
    address: Pubkey,
    pages: usize,
    source: &str,
    recent: bool,
) -> Result<Value, Error> {
    if !(1..=1000).contains(&pages) || source.is_empty() || source.len() > 128 {
        return Err(INVALID);
    }
    let cluster = request(client, RpcRequest::GetGenesisHash, json!([]))
        .await?
        .as_str()
        .ok_or(INVALID)?
        .to_owned();
    let address = address.to_string();
    let progress: Option<(Option<String>,i64)> = sqlx::query_as(
        "SELECT before_signature,exhausted FROM activity_backfill WHERE cluster=? AND address=? AND source_id=?")
        .bind(&cluster).bind(&address).bind(source).fetch_optional(&journal.database).await?;
    let mut before = if recent {
        None
    } else {
        progress.as_ref().and_then(|p| p.0.clone())
    };
    let mut retained = 0;
    for _ in 0..pages {
        let page_key = format!("page:{}", before.as_deref().unwrap_or("tip"));
        sqlx::query("INSERT INTO activity_gaps(cluster,address,signature,source_id,reason) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET attempts=activity_gaps.attempts+1")
            .bind(&cluster).bind(&address).bind(&page_key).bind(source)
            .bind("Signature page collection is incomplete")
            .execute(&journal.database).await?;
        let mut config = json!({"limit":PAGE,"commitment":"finalized"});
        if let Some(before) = &before {
            config["before"] = json!(before);
        }
        let page = request(
            client,
            RpcRequest::GetSignaturesForAddress,
            json!([address, config]),
        )
        .await?;
        let entries = page.as_array().ok_or(INVALID)?;
        if entries.len() > PAGE {
            return Err(INVALID);
        }
        let mut seen = BTreeSet::new();
        let mut previous_slot = u64::MAX;
        for entry in entries {
            let signature = entry["signature"].as_str().ok_or(INVALID)?;
            let slot = entry["slot"].as_u64().ok_or(INVALID)?;
            if !seen.insert(signature)
                || before.as_deref() == Some(signature)
                || slot > previous_slot
            {
                return Err(INVALID);
            }
            previous_slot = slot;
            let result = async {
                let raw = request(client,RpcRequest::GetTransaction,json!([signature,
                    {"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])).await?;
                if !keys(&raw)?.contains(&address) { return Err(INVALID); }
                if request(client,RpcRequest::GetGenesisHash,json!([])).await?.as_str() != Some(&cluster) {
                    return Err(Error::InvalidObservation("RPC cluster changed during collection"));
                }
                journal.retain_activity(&cluster,signature,slot,source,raw).await
            }.await;
            if let Err(error) = result {
                sqlx::query("INSERT INTO activity_gaps(cluster,address,signature,source_id,reason) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET reason=excluded.reason,attempts=activity_gaps.attempts+1")
                    .bind(&cluster).bind(&address).bind(signature).bind(source)
                    .bind("Finalized transaction evidence unavailable or inconsistent")
                    .execute(&journal.database).await?;
                return Err(error);
            }
            sqlx::query("DELETE FROM activity_gaps WHERE cluster=? AND address=? AND signature=? AND source_id=?")
                .bind(&cluster).bind(&address).bind(signature).bind(source).execute(&journal.database).await?;
            retained += 1;
        }
        let next = entries
            .last()
            .and_then(|entry| entry["signature"].as_str())
            .map(str::to_owned)
            .or_else(|| before.clone());
        let exhausted = entries.len() < PAGE;
        let mut checkpoint = journal.database.begin().await?;
        if !recent {
            sqlx::query(
                "INSERT INTO activity_backfill VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET \
                before_signature=excluded.before_signature,exhausted=excluded.exhausted",
            )
            .bind(&cluster)
            .bind(&address)
            .bind(source)
            .bind(&next)
            .bind(exhausted)
            .execute(&mut *checkpoint)
            .await?;
        }
        sqlx::query("DELETE FROM activity_gaps WHERE cluster=? AND address=? AND signature=? AND source_id=?")
            .bind(&cluster).bind(&address).bind(&page_key).bind(source).execute(&mut *checkpoint).await?;
        checkpoint.commit().await?;
        before = next;
        if exhausted {
            break;
        }
    }
    Ok(
        json!({"cluster":cluster,"address":address,"retained_transactions":retained,"complete":false,"before":before}),
    )
}

/// Reconcile provisional webhook signatures through independent finalized RPC.
/// Provisional decoded rows never supply definitive history fields.
pub async fn reconcile(
    journal: &Journal,
    client: &RpcClient,
    limit: usize,
    source: &str,
) -> Result<Value, Error> {
    if !(1..=100).contains(&limit) || source.is_empty() || source.len() > 128 {
        return Err(INVALID);
    }
    let cluster = request(client, RpcRequest::GetGenesisHash, json!([]))
        .await?
        .as_str()
        .ok_or(INVALID)?
        .to_owned();
    let pending: Vec<(String,Option<String>)> = sqlx::query_as(
        "SELECT e.signature,min(e.address) FROM \
         (SELECT signature,coalesce(delegation,subscriber,plan) address FROM trigger_events \
          UNION ALL SELECT signature,address FROM webhook_receipts) e \
         WHERE NOT EXISTS(SELECT 1 FROM activity_transactions t WHERE t.cluster=? AND t.signature=e.signature) \
         GROUP BY e.signature ORDER BY coalesce((SELECT max(g.attempts) FROM activity_gaps g WHERE g.cluster=? AND g.signature=e.signature),0),e.signature LIMIT ?")
        .bind(&cluster).bind(&cluster).bind(limit as i64).fetch_all(&journal.database).await?;
    let mut finalized = 0;
    let mut unresolved = 0;
    for (signature, address) in pending {
        let address = address.unwrap_or_else(|| "unresolved-address".into());
        let delivery:Option<(String,String)>=sqlx::query_as("SELECT d.id,d.payload FROM webhook_deliveries d JOIN webhook_receipts r ON r.delivery_id=d.id WHERE r.signature=?")
            .bind(&signature).fetch_optional(&journal.database).await?;
        if delivery.is_some_and(|(id, raw)| hash(&raw) != id) {
            return Err(Error::ReplayMismatch);
        }
        let result = async {
            let raw = request(
                client,
                RpcRequest::GetTransaction,
                json!([signature,
                {"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]),
            )
            .await?;
            if request(client, RpcRequest::GetGenesisHash, json!([]))
                .await?
                .as_str()
                != Some(&cluster)
            {
                return Err(INVALID);
            }
            let slot = raw["slot"].as_u64().ok_or(INVALID)?;
            journal
                .retain_activity(&cluster, &signature, slot, source, raw)
                .await
        }
        .await;
        let result = match result {
            Err(Error::Database(error)) => return Err(Error::Database(error)),
            other => other,
        };
        if result.is_ok() {
            finalized += 1;
            sqlx::query("DELETE FROM activity_gaps WHERE cluster=? AND address=? AND signature=? AND source_id=?")
                .bind(&cluster).bind(&address).bind(&signature).bind(source).execute(&journal.database).await?;
        } else {
            unresolved += 1;
            sqlx::query("INSERT INTO activity_gaps(cluster,address,signature,source_id,reason) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET reason=excluded.reason,attempts=activity_gaps.attempts+1")
                .bind(&cluster).bind(&address).bind(&signature).bind(source)
                .bind("Webhook signature has no matching finalized transaction evidence")
                .execute(&journal.database).await?;
        }
    }
    Ok(
        json!({"cluster":cluster,"finalized_transactions":finalized,"unresolved_transactions":unresolved,"complete":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::post};
    use std::sync::{Arc, Mutex};

    fn address(byte: u8) -> String {
        Pubkey::new_from_array([byte; 32]).to_string()
    }
    fn raw(signature: &str, slot: u64) -> Value {
        let mut event = crate::constants::EVENT_IX_TAG.to_vec();
        event.push(3);
        for byte in 1..=4 {
            event.extend_from_slice(&[byte; 32]);
        }
        event.extend_from_slice(&u64::MAX.to_le_bytes());
        event.extend_from_slice(&0u64.to_le_bytes());
        event.extend_from_slice(&[5; 32]);
        event.extend_from_slice(&[6; 32]);
        let data = bs58::encode(event).into_string();
        json!({"slot":slot,"blockTime":1800000000,"version":0,
            "transaction":{"signatures":[signature],"message":{"accountKeys":[address(1)],
                "header":{"numRequiredSignatures":1,"numReadonlySignedAccounts":0,"numReadonlyUnsignedAccounts":0},
                "recentBlockhash":address(8),
                "addressTableLookups":[{"accountKey":address(7),"writableIndexes":[0],"readonlyIndexes":[1]}],
                "instructions":[{"programIdIndex":2,"accounts":[0,1],"data":"1"}]}},
            "meta":{"err":null,"loadedAddresses":{"writable":[address(9)],"readonly":[SUBSCRIPTIONS_PROGRAM_ID]},
                "innerInstructions":[{"index":0,"instructions":[{"programIdIndex":2,"accounts":[],"data":data},
                    {"programIdIndex":2,"accounts":[],"data":data}]}]}})
    }

    #[tokio::test]
    async fn malformed_instruction_evidence_is_retained_without_inventing_valid_positions() {
        for case in [
            "orphan",
            "duplicate_group",
            "invalid_base58",
            "missing_discriminator",
            "account_index",
            "lookup_count",
            "unsupported_version",
            "legacy_lookup",
            "missing_version",
            "readonly_payer",
            "outer_program_index",
        ] {
            let mut evidence = raw(case, 10);
            match case {
                "orphan" => evidence["meta"]["innerInstructions"][0]["index"] = json!(1),
                "duplicate_group" => evidence["meta"]["innerInstructions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"index":0,"instructions":[]})),
                "invalid_base58" => {
                    evidence["meta"]["innerInstructions"][0]["instructions"][0]["data"] =
                        json!("0OIl")
                }
                "missing_discriminator" => {
                    evidence["meta"]["innerInstructions"][0]["instructions"][0]["data"] =
                        json!(bs58::encode(crate::constants::EVENT_IX_TAG).into_string())
                }
                "account_index" => {
                    evidence["meta"]["innerInstructions"][0]["instructions"][0]["accounts"] =
                        json!([200])
                }
                "lookup_count" => evidence["meta"]["loadedAddresses"]["readonly"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(address(8))),
                "unsupported_version" => evidence["version"] = json!(1),
                "legacy_lookup" => evidence["version"] = json!("legacy"),
                "missing_version" => {
                    evidence.as_object_mut().unwrap().remove("version");
                }
                "readonly_payer" => {
                    evidence["transaction"]["message"]["header"]["numReadonlySignedAccounts"] =
                        json!(1)
                }
                "outer_program_index" => {
                    evidence["transaction"]["message"]["instructions"][0]["programIdIndex"] =
                        json!(200)
                }
                _ => unreachable!(),
            }
            let journal = Journal::open("sqlite::memory:").await.unwrap();
            journal
                .retain_activity("cluster", case, 10, "fixture", evidence.clone())
                .await
                .unwrap();
            let page = journal
                .activity("cluster", address(1).parse().unwrap(), Page::default())
                .await
                .unwrap();
            assert_eq!(page["transactions"][0]["status"], "incomplete", "{case}");
            assert_eq!(page["events"], json!([]), "{case}");
            assert_eq!(
                journal.activity_transaction("cluster", case).await.unwrap(),
                evidence
            );
        }
    }

    #[tokio::test]
    async fn unknown_event_layout_retains_bytes_and_marks_interpretation_incomplete() {
        let mut evidence = raw("unknown", 10);
        let mut bytes = crate::constants::EVENT_IX_TAG.to_vec();
        bytes.push(255);
        evidence["meta"]["innerInstructions"][0]["instructions"][0]["data"] =
            json!(bs58::encode(&bytes).into_string());
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        journal
            .retain_activity("cluster", "unknown", 10, "fixture", evidence)
            .await
            .unwrap();
        let page = journal
            .activity("cluster", address(1).parse().unwrap(), Page::default())
            .await
            .unwrap();
        assert_eq!(page["transactions"][0]["status"], "incomplete");
        assert_eq!(page["events"][0]["kind"], "unknown");
        assert_eq!(page["events"][0]["rawEvent"], STANDARD.encode(bytes));
        assert_eq!(page["events"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn replay_positions_lossless_values_and_corruption() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        journal
            .retain_activity("cluster", "sig", u64::MAX, "fixture", raw("sig", u64::MAX))
            .await
            .unwrap();
        journal
            .retain_activity("cluster", "sig", u64::MAX, "fixture", raw("sig", u64::MAX))
            .await
            .unwrap();
        let page = journal
            .activity("cluster", address(1).parse().unwrap(), Page::default())
            .await
            .unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 2);
        assert_ne!(page["events"][0]["id"], page["events"][1]["id"]);
        assert_eq!(page["events"][0]["amount"], u64::MAX.to_string());
        assert_eq!(page["events"][0]["slot"], u64::MAX.to_string());
        assert_eq!(page["events"][0]["attribution"]["status"], "unresolved");
        assert!(page["events"][0]["attribution"]["incarnation"].is_null());
        assert_eq!(page["transactions"].as_array().unwrap().len(), 1);
        let mut changed = raw("sig", u64::MAX);
        changed["blockTime"] = json!(1);
        assert!(matches!(
            journal
                .retain_activity("cluster", "sig", u64::MAX, "fixture", changed)
                .await,
            Err(Error::Conflict)
        ));
        sqlx::query("UPDATE activity_transactions SET raw_json='{}'")
            .execute(&journal.database)
            .await
            .unwrap();
        assert!(matches!(
            journal.activity_transaction("cluster", "sig").await,
            Err(Error::ReplayMismatch)
        ));
        assert!(matches!(
            journal
                .activity("cluster", address(1).parse().unwrap(), Page::default())
                .await,
            Err(Error::ReplayMismatch)
        ));
    }

    #[tokio::test]
    async fn api_pagination_and_retained_evidence_fail_closed() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        journal
            .retain_activity("cluster", "sig", 10, "fixture", raw("sig", 10))
            .await
            .unwrap();
        let app = crate::router(journal.clone());
        let path = format!("/activity/cluster/{}", address(1));
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["events"].as_array().unwrap().len(), 2);
        for suffix in ["?limit=0", "?limit=101", "?unexpected=1"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("{path}{suffix}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/activity/transactions/cluster/unknown")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        sqlx::query("UPDATE activity_transactions SET raw_json='{}'")
            .execute(&journal.database)
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/activity/transactions/cluster/sig")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn failed_transactions_and_missing_lookup_evidence_never_invent_activity() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let mut failed = raw("failed", 10);
        failed["meta"]["err"] = json!({"InstructionError":[0,{"Custom":1}]});
        journal
            .retain_activity("cluster", "failed", 10, "fixture", failed)
            .await
            .unwrap();
        let mut missing = raw("missing", 11);
        missing["meta"]["loadedAddresses"] = json!({});
        journal
            .retain_activity("cluster", "missing", 11, "fixture", missing)
            .await
            .unwrap();
        let page = journal
            .activity("cluster", address(1).parse().unwrap(), Page::default())
            .await
            .unwrap();
        assert_eq!(page["events"], json!([]));
        assert_eq!(page["transactions"][0]["status"], "incomplete");
        assert_eq!(page["complete"], false);
    }

    struct Provider {
        transactions: Vec<Value>,
        missing: Option<String>,
    }

    async fn provider(state: Arc<Mutex<Provider>>) -> (RpcClient, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/",post(move |Json(request): Json<Value>| {
            let state=state.clone();
            async move {
                let state=state.lock().unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "getGenesisHash" => json!("cluster"),
                    "getSignaturesForAddress" => {
                        assert_eq!(request["params"][1]["commitment"],"finalized");
                        let before=request["params"][1]["before"].as_str();
                        let start=before.map(|signature|state.transactions.iter().position(|tx| tx["transaction"]["signatures"][0]==signature).unwrap()+1).unwrap_or(0);
                        Value::Array(state.transactions.iter().skip(start).take(PAGE).map(|tx|json!({"signature":tx["transaction"]["signatures"][0],"slot":tx["slot"],"err":null})).collect())
                    }
                    "getTransaction" => {
                        assert_eq!(request["params"][1]["commitment"],"finalized");
                        assert_eq!(request["params"][1]["maxSupportedTransactionVersion"],0);
                        let signature=request["params"][0].as_str().unwrap();
                        if state.missing.as_deref()==Some(signature) { Value::Null }
                        else { state.transactions.iter().find(|tx|tx["transaction"]["signatures"][0]==signature).unwrap().clone() }
                    }
                    other => panic!("unexpected RPC {other}"),
                };
                Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
            }
        }));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            RpcClient::new_with_timeout(format!("http://127.0.0.1:{port}"), Duration::from_secs(2)),
            task,
        )
    }

    #[tokio::test]
    async fn webhook_delivery_is_not_finality_and_cannot_supply_authoritative_amounts() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let received = json!([{"unknown_future_layout":u64::MAX,
            "transaction":{"signatures":["sig-00"],"message":{"accountKeys":[address(1)]}}}]);
        receive(&journal.database, &received).await.unwrap();
        receive(&journal.database, &received).await.unwrap();
        let deliveries: i64 = sqlx::query_scalar("SELECT count(*) FROM webhook_deliveries")
            .fetch_one(&journal.database)
            .await
            .unwrap();
        assert_eq!(deliveries, 1);
        sqlx::query("INSERT INTO trigger_events(signature,program_id,discriminator,raw_data,slot,outer_index,inner_index,subscriber,amount_units) VALUES (?,?,3,?,100,0,0,?,'1')")
            .bind("sig-00").bind(SUBSCRIPTIONS_PROGRAM_ID).bind(vec![0u8;9]).bind(address(1))
            .execute(&journal.database).await.unwrap();
        let account = address(1).parse().unwrap();
        assert_eq!(
            journal
                .activity("cluster", account, Page::default())
                .await
                .unwrap()["events"],
            json!([])
        );
        let state = Arc::new(Mutex::new(Provider {
            transactions: vec![raw("sig-00", 100)],
            missing: Some("sig-00".into()),
        }));
        let (client, task) = provider(state.clone()).await;
        let pending = reconcile(&journal, &client, 10, "loopback").await.unwrap();
        assert_eq!(pending["unresolved_transactions"], 1);
        assert_eq!(
            journal
                .activity("cluster", account, Page::default())
                .await
                .unwrap()["events"],
            json!([])
        );
        state.lock().unwrap().missing = None;
        assert_eq!(
            reconcile(&journal, &client, 10, "loopback").await.unwrap()["finalized_transactions"],
            1
        );
        let page = journal
            .activity("cluster", account, Page::default())
            .await
            .unwrap();
        assert_eq!(page["events"][0]["amount"], u64::MAX.to_string());
        assert_eq!(page["coverage"]["gap_count"], 0);
        assert_eq!(
            reconcile(&journal, &client, 10, "loopback").await.unwrap()["finalized_transactions"],
            0
        );
        task.abort();
    }

    #[tokio::test]
    async fn short_pages_and_empty_pages_do_not_permanently_hide_later_archival_data() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let state = Arc::new(Mutex::new(Provider {
            transactions: vec![raw("sig-00", 100)],
            missing: None,
        }));
        let (client, task) = provider(state.clone()).await;
        let account = address(1).parse().unwrap();
        assert_eq!(
            collect(&journal, &client, account, 1, "loopback", false)
                .await
                .unwrap()["retained_transactions"],
            1
        );
        assert_eq!(
            collect(&journal, &client, account, 1, "loopback", false)
                .await
                .unwrap()["retained_transactions"],
            0
        );
        state.lock().unwrap().transactions.push(raw("sig-01", 99));
        assert_eq!(
            collect(&journal, &client, account, 1, "loopback", false)
                .await
                .unwrap()["retained_transactions"],
            1
        );
        let page = journal
            .activity("cluster", account, Page::default())
            .await
            .unwrap();
        assert_eq!(page["transactions"].as_array().unwrap().len(), 2);
        assert_eq!(page["complete"], false);
        task.abort();
    }

    #[tokio::test]
    async fn unavailable_webhook_receipts_do_not_starve_later_finalized_transactions() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        for signature in ["sig-00", "sig-01"] {
            sqlx::query("INSERT INTO trigger_events(signature,program_id,discriminator,raw_data,slot,outer_index,inner_index,subscriber) VALUES (?,?,3,?,999,0,0,?)")
                .bind(signature).bind(SUBSCRIPTIONS_PROGRAM_ID).bind(vec![0u8;9]).bind(address(1))
                .execute(&journal.database).await.unwrap();
        }
        let state = Arc::new(Mutex::new(Provider {
            transactions: vec![raw("sig-00", 100), raw("sig-01", 99)],
            missing: Some("sig-00".into()),
        }));
        let (client, task) = provider(state.clone()).await;
        assert_eq!(
            reconcile(&journal, &client, 1, "loopback").await.unwrap()["unresolved_transactions"],
            1
        );
        assert_eq!(
            reconcile(&journal, &client, 1, "loopback").await.unwrap()["finalized_transactions"],
            1
        );
        state.lock().unwrap().missing = None;
        assert_eq!(
            reconcile(&journal, &client, 1, "loopback").await.unwrap()["finalized_transactions"],
            1
        );
        let page = journal
            .activity("cluster", address(1).parse().unwrap(), Page::default())
            .await
            .unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 4);
        assert_eq!(page["events"][0]["slot"], "100");
        task.abort();
    }

    #[tokio::test]
    async fn interruption_gap_repair_pagination_and_restart_do_not_skip_or_duplicate() {
        let path = std::env::temp_dir().join(format!(
            "velon-history-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let url = format!("sqlite://{}", path.display());
        let journal = Journal::open(&url).await.unwrap();
        let state = Arc::new(Mutex::new(Provider {
            transactions: (0..26)
                .map(|i| raw(&format!("sig-{i:02}"), 100 - i))
                .collect(),
            missing: Some("sig-01".into()),
        }));
        let (client, task) = provider(state.clone()).await;
        let account = address(1).parse().unwrap();
        assert!(
            collect(&journal, &client, account, 1, "loopback", false)
                .await
                .is_err()
        );
        let checkpoints: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_backfill")
            .fetch_one(&journal.database)
            .await
            .unwrap();
        assert_eq!(checkpoints, 0);
        let page = journal
            .activity("cluster", account, Page::default())
            .await
            .unwrap();
        assert_eq!(page["transactions"].as_array().unwrap().len(), 1);
        assert_eq!(page["coverage"]["gaps"].as_array().unwrap().len(), 2);
        assert!(
            page["coverage"]["gaps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|gap| gap["signature"] == "sig-01")
        );
        journal.database.close().await;
        let journal = Journal::open(&url).await.unwrap();
        state.lock().unwrap().missing = None;
        let first = collect(&journal, &client, account, 1, "loopback", false)
            .await
            .unwrap();
        assert_eq!(first["before"], "sig-24");
        let second = collect(&journal, &client, account, 1, "loopback", false)
            .await
            .unwrap();
        assert_eq!(second["retained_transactions"], 1);
        assert_eq!(second["complete"], false);
        collect(&journal, &client, account, 1, "loopback", true)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_transactions")
            .fetch_one(&journal.database)
            .await
            .unwrap();
        assert_eq!(count, 26);
        let page = journal
            .activity(
                "cluster",
                account,
                Page {
                    limit: Some(25),
                    before: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 50);
        assert_eq!(page["coverage"]["gaps"], json!([]));
        let last = journal
            .activity(
                "cluster",
                account,
                Page {
                    limit: Some(25),
                    before: page["next"].as_str().map(str::to_owned),
                },
            )
            .await
            .unwrap();
        assert_eq!(last["transactions"].as_array().unwrap().len(), 1);
        task.abort();
        journal.database.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
