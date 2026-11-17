//! Optional finalized RPC block positions. These are native block-list ordinals,
//! not wall-clock execution order, ledger completeness or incarnation evidence.
use super::{INVALID, hash, request};
use crate::{Error, Journal};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{config::RpcBlockConfig, request::RpcRequest};
use solana_transaction::{Hash, Signature};
use solana_transaction_status_client_types::{
    TransactionDetails, UiConfirmedBlock, UiTransactionEncoding,
};
use sqlx::Row;
use std::collections::BTreeSet;

fn decoded(raw: &Value, slot: u64) -> Result<UiConfirmedBlock, Error> {
    let block: UiConfirmedBlock = serde_json::from_value(raw.clone()).map_err(|_| INVALID)?;
    block.blockhash.parse::<Hash>().map_err(|_| INVALID)?;
    block
        .previous_blockhash
        .parse::<Hash>()
        .map_err(|_| INVALID)?;
    if block.parent_slot > slot
        || (slot != 0 && block.parent_slot == slot)
        || block.transactions.is_some()
    {
        return Err(INVALID);
    }
    let signatures = block.signatures.as_ref().ok_or(INVALID)?;
    u32::try_from(signatures.len()).map_err(|_| INVALID)?;
    let mut seen = BTreeSet::new();
    for signature in signatures {
        signature.parse::<Signature>().map_err(|_| INVALID)?;
        if !seen.insert(signature) {
            return Err(INVALID);
        }
    }
    Ok(block)
}

fn block_id(cluster: &str, slot: u64, source: &str, raw: &str) -> Result<String, Error> {
    Ok(hash(&serde_json::to_string(&(
        "velon:block:1",
        cluster,
        slot.to_string(),
        source,
        raw,
    ))?))
}

impl Journal {
    /// Trusted ingestion boundary, like retain_activity: the caller must fetch
    /// this result independently with finalized commitment for this cluster/slot.
    pub async fn retain_block(
        &self,
        cluster: &str,
        slot: u64,
        source: &str,
        raw: Value,
    ) -> Result<(), Error> {
        if cluster.is_empty() || source.is_empty() || source.len() > 128 {
            return Err(INVALID);
        }
        let block = decoded(&raw, slot)?;
        let signatures = block.signatures.as_ref().ok_or(INVALID)?;
        let encoded = serde_json::to_string(&raw)?;
        let digest = hash(&encoded);
        let units = slot.to_string();
        let mut tx = self.database.begin().await?;
        let previous: Option<(String, String, String, String, String)> = sqlx::query_as(
            "SELECT raw_json,sha256,source_id,evidence_id,blockhash FROM activity_blocks WHERE cluster=? AND slot_units=?",
        )
        .bind(cluster)
        .bind(&units)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((old_raw, old_hash, old_source, old_id, old_blockhash)) = previous {
            let old_value: Value =
                serde_json::from_str(&old_raw).map_err(|_| Error::ReplayMismatch)?;
            if hash(&old_raw) != old_hash
                || block_id(cluster, slot, &old_source, &old_raw)? != old_id
                || old_value["blockhash"] != old_blockhash
            {
                return Err(Error::ReplayMismatch);
            }
            if old_hash != digest {
                return Err(Error::Conflict);
            }
            // A replay cannot repair or silently accept damaged derived rows.
            let positions: Vec<(String,i64)> = sqlx::query_as("SELECT signature,transaction_index FROM activity_block_signatures WHERE cluster=? AND slot_units=? ORDER BY transaction_index")
                .bind(cluster).bind(&units).fetch_all(&mut *tx).await?;
            if positions.len() != signatures.len()
                || positions.iter().enumerate().any(|(i, (signature, index))| {
                    *index != i as i64 || signature != &signatures[i]
                })
            {
                return Err(Error::ReplayMismatch);
            }
        } else {
            let same_hash: Option<String> = sqlx::query_scalar(
                "SELECT slot_units FROM activity_blocks WHERE cluster=? AND blockhash=?",
            )
            .bind(cluster)
            .bind(&block.blockhash)
            .fetch_optional(&mut *tx)
            .await?;
            if same_hash.is_some() {
                return Err(Error::Conflict);
            }
            let retained: Vec<String> = sqlx::query_scalar(
                "SELECT signature FROM activity_transactions WHERE cluster=? AND slot_units=?",
            )
            .bind(cluster)
            .bind(&units)
            .fetch_all(&mut *tx)
            .await?;
            if retained
                .iter()
                .any(|signature| !signatures.contains(signature))
            {
                return Err(Error::Conflict);
            }
            for signature in signatures {
                let slots: Vec<String> = sqlx::query_scalar("SELECT slot_units FROM activity_block_signatures WHERE cluster=? AND signature=? UNION SELECT slot_units FROM activity_transactions WHERE cluster=? AND signature=?")
                    .bind(cluster).bind(signature).bind(cluster).bind(signature).fetch_all(&mut *tx).await?;
                if slots.iter().any(|old| old != &units) {
                    return Err(Error::Conflict);
                }
            }
            sqlx::query("INSERT INTO activity_blocks VALUES (?,?,?,?,?,?,?)")
                .bind(cluster)
                .bind(&units)
                .bind(&block.blockhash)
                .bind(&encoded)
                .bind(&digest)
                .bind(source)
                .bind(block_id(cluster, slot, source, &encoded)?)
                .execute(&mut *tx)
                .await?;
            for (index, signature) in signatures.iter().enumerate() {
                sqlx::query("INSERT INTO activity_block_signatures VALUES (?,?,?,?)")
                    .bind(cluster)
                    .bind(signature)
                    .bind(&units)
                    .bind(index as i64)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        // Conflicting finalized replies remain unresolved until independently
        // reviewed; a later repeat of the first answer cannot erase disagreement.
        sqlx::query("UPDATE activity_block_attempts SET resolved=1 WHERE cluster=? AND slot_units=? AND source_id=? AND reason != 'conflict'")
            .bind(cluster).bind(&units).bind(source).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn block_attempt(
        &self,
        cluster: &str,
        slot: u64,
        source: &str,
        reason: &str,
        raw: Option<&Value>,
    ) -> Result<(), Error> {
        let encoded = raw.map(serde_json::to_string).transpose()?;
        let digest = encoded.as_deref().map(hash);
        let id = hash(&serde_json::to_string(&(
            "velon:block-attempt:1",
            cluster,
            slot.to_string(),
            source,
            reason,
            &encoded,
        ))?);
        let mut tx = self.database.begin().await?;
        sqlx::query("INSERT INTO activity_block_attempts(id,cluster,slot_units,source_id,reason,raw_json,sha256) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN attempts < 9223372036854775807 THEN attempts+1 ELSE attempts END,resolved=0")
            .bind(&id).bind(cluster).bind(slot.to_string()).bind(source).bind(reason).bind(&encoded).bind(&digest).execute(&mut *tx).await?;
        let previous: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT raw_json,sha256 FROM activity_block_attempts WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if previous != (encoded, digest) {
            return Err(Error::ReplayMismatch);
        }
        if reason != "pending" {
            sqlx::query("UPDATE activity_block_attempts SET resolved=1 WHERE cluster=? AND slot_units=? AND source_id=? AND reason='pending'")
                .bind(cluster).bind(slot.to_string()).bind(source).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn activity_block(&self, cluster: &str, slot: u64) -> Result<Value, Error> {
        let row = sqlx::query("SELECT raw_json,sha256,source_id,evidence_id,blockhash FROM activity_blocks WHERE cluster=? AND slot_units=?")
            .bind(cluster).bind(slot.to_string()).fetch_optional(&self.database).await?.ok_or(Error::NotFound)?;
        let encoded: String = row.try_get("raw_json")?;
        let digest: String = row.try_get("sha256")?;
        let source: String = row.try_get("source_id")?;
        let id: String = row.try_get("evidence_id")?;
        if hash(&encoded) != digest || block_id(cluster, slot, &source, &encoded)? != id {
            return Err(Error::ReplayMismatch);
        }
        let raw: Value = serde_json::from_str(&encoded)?;
        let block = decoded(&raw, slot)?;
        if block.blockhash != row.try_get::<String, _>("blockhash")? {
            return Err(Error::ReplayMismatch);
        }
        let signatures = block.signatures.ok_or(INVALID)?;
        let positions: Vec<(String,i64)> = sqlx::query_as("SELECT signature,transaction_index FROM activity_block_signatures WHERE cluster=? AND slot_units=? ORDER BY transaction_index")
            .bind(cluster).bind(slot.to_string()).fetch_all(&self.database).await?;
        if positions.len() != signatures.len()
            || positions
                .iter()
                .enumerate()
                .any(|(i, (signature, index))| *index != i as i64 || signature != &signatures[i])
        {
            return Err(Error::ReplayMismatch);
        }
        let conflicts: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_block_attempts WHERE cluster=? AND slot_units=? AND reason='conflict' AND resolved=0")
            .bind(cluster).bind(slot.to_string()).fetch_one(&self.database).await?;
        let mismatches: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_block_signatures b JOIN activity_transactions t USING(cluster,signature) WHERE b.cluster=? AND b.slot_units=? AND b.slot_units != t.slot_units")
            .bind(cluster).bind(slot.to_string()).fetch_one(&self.database).await?;
        let missing: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_transactions t WHERE t.cluster=? AND t.slot_units=? AND NOT EXISTS(SELECT 1 FROM activity_block_signatures b WHERE b.cluster=t.cluster AND b.slot_units=t.slot_units AND b.signature=t.signature)")
            .bind(cluster).bind(slot.to_string()).fetch_one(&self.database).await?;
        Ok(
            json!({"cluster":cluster,"slot":slot.to_string(),"source":source,"sha256":digest,"evidence_id":id,
            "finality":"finalized_rpc","position_status":if conflicts == 0 && mismatches == 0 && missing == 0 {"finalized_rpc_block"}else{"conflict"},"result":raw}),
        )
    }

    pub async fn activity_position(
        &self,
        cluster: &str,
        slot: u64,
        signature: &str,
    ) -> Result<Value, Error> {
        let block = match self.activity_block(cluster, slot).await {
            Ok(block) => block,
            Err(Error::NotFound) => {
                let other: Option<String> = sqlx::query_scalar("SELECT slot_units FROM activity_block_signatures WHERE cluster=? AND signature=?")
                    .bind(cluster).bind(signature).fetch_optional(&self.database).await?;
                return Ok(
                    json!({"status":if other.is_some(){"conflict"}else{"unavailable"},"transaction_index":null}),
                );
            }
            Err(error) => return Err(error),
        };
        let signatures = block["result"]["signatures"].as_array().ok_or(INVALID)?;
        let index = signatures
            .iter()
            .position(|value| value.as_str() == Some(signature));
        let known = block["position_status"] == "finalized_rpc_block" && index.is_some();
        Ok(
            json!({"status":if known{"finalized_rpc_block"}else{"conflict"},"transaction_index":if known{index}else{None},
            "evidence":format!("/activity/blocks/{cluster}/{slot}"),"source":block["source"],"sha256":block["sha256"]}),
        )
    }

    pub async fn block_gaps(&self, cluster: &str, address: &str) -> Result<Value, Error> {
        let rows = sqlx::query("SELECT a.* FROM activity_block_attempts a WHERE a.cluster=? AND a.resolved=0 AND a.slot_units IN (SELECT t.slot_units FROM activity_transactions t JOIN activity_addresses d USING(cluster,signature) WHERE t.cluster=? AND d.address=?) ORDER BY a.id LIMIT 100")
            .bind(cluster).bind(cluster).bind(address).fetch_all(&self.database).await?;
        let mut result = Vec::new();
        for row in rows {
            let raw: Option<String> = row.try_get("raw_json")?;
            let digest: Option<String> = row.try_get("sha256")?;
            let source: String = row.try_get("source_id")?;
            let reason: String = row.try_get("reason")?;
            let slot: String = row.try_get("slot_units")?;
            let id: String = row.try_get("id")?;
            if raw.as_deref().map(hash) != digest
                || hash(&serde_json::to_string(&(
                    "velon:block-attempt:1",
                    cluster,
                    &slot,
                    &source,
                    &reason,
                    &raw,
                ))?) != id
            {
                return Err(Error::ReplayMismatch);
            }
            result.push(json!({"id":id,"slot":slot,"source":source,"reason":reason,"attempts":row.try_get::<i64,_>("attempts")?}));
        }
        Ok(json!(result))
    }
}

pub async fn collect(
    journal: &Journal,
    client: &RpcClient,
    slot: u64,
    source: &str,
) -> Result<Value, Error> {
    if !client.commitment().is_finalized() || source.is_empty() || source.len() > 128 {
        return Err(INVALID);
    }
    let cluster = request(client, RpcRequest::GetGenesisHash, json!([]))
        .await?
        .as_str()
        .ok_or(INVALID)?
        .to_owned();
    cluster.parse::<Hash>().map_err(|_| INVALID)?;
    journal
        .block_attempt(&cluster, slot, source, "pending", None)
        .await?;
    let config = RpcBlockConfig {
        encoding: Some(UiTransactionEncoding::Json),
        transaction_details: Some(TransactionDetails::Signatures),
        rewards: Some(false),
        commitment: Some(CommitmentConfig::finalized()),
        max_supported_transaction_version: Some(0),
    };
    let raw = match request(client, RpcRequest::GetBlock, json!([slot, config])).await {
        Ok(raw) => raw,
        Err(error) => {
            journal
                .block_attempt(&cluster, slot, source, "unavailable", None)
                .await?;
            return Err(error);
        }
    };
    let result = async {
        if request(client, RpcRequest::GetGenesisHash, json!([]))
            .await?
            .as_str()
            != Some(&cluster)
        {
            return Err(Error::Conflict);
        }
        journal
            .retain_block(&cluster, slot, source, raw.clone())
            .await
    }
    .await;
    if let Err(error) = result {
        if matches!(error, Error::Database(_)) {
            return Err(error);
        }
        let reason = match &error {
            Error::Conflict | Error::ReplayMismatch => "conflict",
            Error::Rpc(_) => "unavailable",
            _ if raw.is_null() => "unavailable",
            _ => "invalid",
        };
        journal
            .block_attempt(&cluster, slot, source, reason, Some(&raw))
            .await?;
        return Err(error);
    }
    Ok(
        json!({"cluster":cluster,"slot":slot.to_string(),"source":source,"finality":"finalized_rpc","complete":false}),
    )
}

pub async fn evidence(
    State(journal): State<Journal>,
    Path((cluster, slot)): Path<(String, u64)>,
) -> Result<Json<Value>, StatusCode> {
    journal
        .activity_block(&cluster, slot)
        .await
        .map(Json)
        .map_err(super::status)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{address, raw};
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::Request,
        routing::post,
    };
    use sqlx::sqlite::SqliteConnectOptions;
    use std::{
        borrow::Cow,
        sync::{Arc, Mutex},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tower::ServiceExt;
    fn cluster() -> String {
        Hash::new_from_array([42; 32]).to_string()
    }
    fn sig(byte: u8) -> String {
        Signature::from([byte; 64]).to_string()
    }
    fn block(slot: u64, signatures: &[String]) -> Value {
        let mut bytes = [0; 32];
        bytes[..8].copy_from_slice(&slot.to_le_bytes());
        json!({"blockhash":Hash::new_from_array(bytes).to_string(),"previousBlockhash":address(3),"parentSlot":slot.saturating_sub(1),"blockHeight":u64::MAX,"blockTime":null,"signatures":signatures,"provider_extra":{"retained":true}})
    }
    async fn provider(
        response: Value,
        error: bool,
        flip: bool,
    ) -> (
        RpcClient,
        tokio::task::JoinHandle<()>,
        Arc<Mutex<Vec<Value>>>,
    ) {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = requests.clone();
        let app=Router::new().route("/",post(move |Json(request):Json<Value>| {
            let requests=received.clone();let response=response.clone();async move {
                let mut calls=requests.lock().unwrap();let previous=calls.iter().filter(|r|r["method"]=="getGenesisHash").count();calls.push(request.clone());
                let result=match request["method"].as_str().unwrap() {
                    "getGenesisHash"=>json!(if flip&&previous>0{address(99)}else{cluster()}),
                    "getBlock"=>{assert_eq!(request["params"][1]["commitment"],"finalized");assert_eq!(request["params"][1]["transactionDetails"],"signatures");assert_eq!(request["params"][1]["maxSupportedTransactionVersion"],0);assert_eq!(request["params"][1]["rewards"],false);
                        if error{return Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32009,"message":"Block unavailable or pruned"}}));}response},
                    method=>panic!("unexpected RPC {method}"),
                };Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            RpcClient::new_with_timeout_and_commitment(
                format!("http://{endpoint}"),
                Duration::from_secs(3),
                CommitmentConfig::finalized(),
            ),
            task,
            requests,
        )
    }
    #[tokio::test]
    async fn finalized_ordinals_enrich_history_without_promoting_coverage_or_reordering_pages() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let mut signatures = vec![sig(1), sig(2)];
        signatures.sort();
        let slot = u64::MAX;
        for signature in &signatures {
            journal
                .retain_activity(&cluster(), signature, slot, "tx", raw(signature, slot))
                .await
                .unwrap();
        }
        let absent = journal
            .activity(&cluster(), address(1).parse().unwrap(), Default::default())
            .await
            .unwrap();
        assert!(
            absent["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["transaction_index"].is_null())
        );
        let evidence = block(slot, &signatures);
        let (client, task, calls) = provider(evidence.clone(), false, false).await;
        collect(&journal, &client, slot, "archive").await.unwrap();
        collect(&journal, &client, slot, "archive").await.unwrap();
        task.abort();
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "getBlock")
                .count(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM activity_blocks")
                .fetch_one(&journal.database)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM activity_block_signatures")
                .fetch_one(&journal.database)
                .await
                .unwrap(),
            2
        );
        let page = journal
            .activity(&cluster(), address(1).parse().unwrap(), Default::default())
            .await
            .unwrap();
        assert_eq!(page["transactions"][0]["signature"], signatures[1]);
        assert_eq!(
            page["transactions"][0]["block_position"]["transaction_index"],
            1
        );
        assert_eq!(
            page["transactions"][1]["block_position"]["transaction_index"],
            0
        );
        for event in page["events"].as_array().unwrap() {
            let index = signatures
                .iter()
                .position(|signature| event["signature"] == *signature)
                .unwrap();
            assert_eq!(event["transaction_index"], index);
            assert_eq!(event["attribution"]["status"], "unresolved");
            assert!(event["attribution"]["incarnation"].is_null());
        }
        assert_eq!(page["complete"], false);
        assert_eq!(page["coverage"]["archive"], "unproven");
        assert_eq!(
            page["transaction_order"],
            "slot_then_signature_not_execution_order"
        );
        let response = crate::router(journal.clone())
            .oneshot(
                Request::get(format!("/activity/blocks/{}/{slot}", cluster()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let kept: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(kept["result"], evidence);
        assert_eq!(kept["result"]["blockHeight"].as_u64(), Some(u64::MAX));
        assert_eq!(kept["slot"], slot.to_string());
    }
    #[tokio::test]
    async fn conflicting_finalized_positions_cannot_replace_original_evidence_or_silently_heal() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let signature = sig(1);
        let signatures = vec![signature.clone(), sig(2)];
        journal
            .retain_activity(&cluster(), &signature, 50, "tx", raw(&signature, 50))
            .await
            .unwrap();
        let original = block(50, &signatures);
        journal
            .retain_block(&cluster(), 50, "first", original.clone())
            .await
            .unwrap();
        let mut changed = original.clone();
        changed["signatures"].as_array_mut().unwrap().reverse();
        let (client, task, _) = provider(changed.clone(), false, false).await;
        assert!(matches!(
            collect(&journal, &client, 50, "second").await,
            Err(Error::Conflict)
        ));
        task.abort();
        let kept = journal.activity_block(&cluster(), 50).await.unwrap();
        assert_eq!(kept["result"], original);
        assert_eq!(kept["source"], "first");
        assert_eq!(kept["position_status"], "conflict");
        assert!(
            journal
                .activity_position(&cluster(), 50, &signature)
                .await
                .unwrap()["transaction_index"]
                .is_null()
        );
        assert_eq!(
            journal.block_gaps(&cluster(), &address(1)).await.unwrap()[0]["reason"],
            "conflict"
        );
        let stored: String = sqlx::query_scalar(
            "SELECT raw_json FROM activity_block_attempts WHERE reason='conflict'",
        )
        .fetch_one(&journal.database)
        .await
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), changed);
        journal
            .retain_block(&cluster(), 50, "second", original.clone())
            .await
            .unwrap();
        assert_eq!(
            journal.activity_block(&cluster(), 50).await.unwrap()["position_status"],
            "conflict"
        );
        assert!(matches!(
            journal
                .retain_block(&cluster(), 51, "third", block(51, &signatures))
                .await,
            Err(Error::Conflict)
        ));
        sqlx::query("UPDATE activity_blocks SET raw_json='{}'")
            .execute(&journal.database)
            .await
            .unwrap();
        assert!(matches!(
            journal.activity_block(&cluster(), 50).await,
            Err(Error::ReplayMismatch)
        ));
        assert!(matches!(
            journal
                .retain_block(&cluster(), 50, "first", original)
                .await,
            Err(Error::ReplayMismatch)
        ));
    }
    #[tokio::test]
    async fn null_pruned_malformed_and_changed_cluster_replies_never_produce_positions() {
        for case in [
            "null",
            "pruned",
            "duplicates",
            "signature",
            "missing",
            "mixed",
            "parent",
            "hash",
            "cluster",
        ] {
            let journal = Journal::open("sqlite::memory:").await.unwrap();
            let signature = sig(1);
            journal
                .retain_activity(&cluster(), &signature, 60, "tx", raw(&signature, 60))
                .await
                .unwrap();
            let mut response = block(60, std::slice::from_ref(&signature));
            match case {
                "null" => response = Value::Null,
                "duplicates" => response["signatures"] = json!([signature, signature]),
                "signature" => response["signatures"] = json!(["bad"]),
                "missing" => {
                    response.as_object_mut().unwrap().remove("signatures");
                }
                "mixed" => response["transactions"] = json!([]),
                "parent" => response["parentSlot"] = json!(60),
                "hash" => response["blockhash"] = json!("bad"),
                _ => {}
            }
            let (client, task, calls) =
                provider(response.clone(), case == "pruned", case == "cluster").await;
            assert!(
                collect(&journal, &client, 60, "archive").await.is_err(),
                "{case}"
            );
            task.abort();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM activity_blocks")
                    .fetch_one(&journal.database)
                    .await
                    .unwrap(),
                0,
                "{case}"
            );
            let page = journal
                .activity(&cluster(), address(1).parse().unwrap(), Default::default())
                .await
                .unwrap();
            assert!(
                page["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|event| event["transaction_index"].is_null())
            );
            assert_eq!(page["complete"], false);
            assert!(
                !page["coverage"]["block_position_gaps"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            if case == "pruned" {
                assert_eq!(
                    calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|r| r["method"] == "getBlock")
                        .count(),
                    3
                );
            } else {
                let stored: String = sqlx::query_scalar(
                    "SELECT raw_json FROM activity_block_attempts WHERE reason != 'pending'",
                )
                .fetch_one(&journal.database)
                .await
                .unwrap();
                assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), response);
            }
        }
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let weak = RpcClient::new_with_timeout_and_commitment(
            "http://127.0.0.1:1".into(),
            Duration::from_millis(10),
            CommitmentConfig::confirmed(),
        );
        assert!(matches!(
            collect(&journal, &weak, 60, "archive").await,
            Err(Error::InvalidObservation(_))
        ));
    }
    #[tokio::test]
    async fn additive_migration_restart_and_retry_preserve_transactions_and_failed_replies() {
        let path = std::env::temp_dir().join(format!(
            "velon-block-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let url = format!("sqlite://{}", path.display());
        let pool = sqlx::SqlitePool::connect_with(
            url.parse::<SqliteConnectOptions>()
                .unwrap()
                .create_if_missing(true),
        )
        .await
        .unwrap();
        let mut old = sqlx::migrate!("./migrations");
        old.migrations = Cow::Owned(
            old.iter()
                .filter(|migration| migration.version < 20261117000000)
                .cloned()
                .collect(),
        );
        old.run(&pool).await.unwrap();
        let legacy = Journal {
            database: pool.clone(),
        };
        let signature = sig(1);
        let original = raw(&signature, 70);
        legacy
            .retain_activity(&cluster(), &signature, 70, "tx", original.clone())
            .await
            .unwrap();
        pool.close().await;
        let upgraded = Journal::open(&url).await.unwrap();
        assert_eq!(
            upgraded
                .activity_transaction(&cluster(), &signature)
                .await
                .unwrap(),
            original
        );
        upgraded
            .block_attempt(&cluster(), 70, "archive", "pending", None)
            .await
            .unwrap();
        upgraded.database.close().await;
        let reopened = Journal::open(&url).await.unwrap();
        assert_eq!(
            reopened.block_gaps(&cluster(), &address(1)).await.unwrap()[0]["reason"],
            "pending"
        );
        let (missing, task, _) = provider(Value::Null, false, false).await;
        assert!(collect(&reopened, &missing, 70, "archive").await.is_err());
        task.abort();
        let (available, task, _) =
            provider(block(70, std::slice::from_ref(&signature)), false, false).await;
        collect(&reopened, &available, 70, "archive").await.unwrap();
        task.abort();
        assert!(
            reopened
                .block_gaps(&cluster(), &address(1))
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        let stored: (String, i64) = sqlx::query_as(
            "SELECT raw_json,resolved FROM activity_block_attempts WHERE reason='unavailable'",
        )
        .fetch_one(&reopened.database)
        .await
        .unwrap();
        assert_eq!(stored, ("null".into(), 1));
        reopened.database.close().await;
        let final_read = Journal::open(&url).await.unwrap();
        assert_eq!(
            final_read
                .activity_position(&cluster(), 70, &signature)
                .await
                .unwrap()["transaction_index"],
            0
        );
        assert_eq!(
            final_read
                .activity_transaction(&cluster(), &signature)
                .await
                .unwrap(),
            original
        );
    }
    #[tokio::test]
    async fn derived_index_corruption_is_detected_and_failed_transactions_have_no_transfer_events()
    {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let signature = sig(1);
        let mut failed = raw(&signature, 80);
        failed["meta"]["err"] = json!({"InstructionError":[0,"Custom"]});
        journal
            .retain_activity(&cluster(), &signature, 80, "tx", failed)
            .await
            .unwrap();
        journal
            .retain_block(
                &cluster(),
                80,
                "archive",
                block(80, std::slice::from_ref(&signature)),
            )
            .await
            .unwrap();
        let page = journal
            .activity(&cluster(), address(1).parse().unwrap(), Default::default())
            .await
            .unwrap();
        assert!(page["events"].as_array().unwrap().is_empty());
        assert_eq!(page["transactions"][0]["status"], "failed_execution");
        assert_eq!(
            page["transactions"][0]["block_position"]["transaction_index"],
            0
        );
        sqlx::query("UPDATE activity_block_signatures SET transaction_index=12")
            .execute(&journal.database)
            .await
            .unwrap();
        assert!(matches!(
            journal.activity_block(&cluster(), 80).await,
            Err(Error::ReplayMismatch)
        ));
    }
    #[tokio::test]
    async fn late_contradictory_transactions_invalidate_the_whole_block_without_losing_facts() {
        let journal = Journal::open("sqlite::memory:").await.unwrap();
        let listed = sig(1);
        let absent = sig(2);
        journal
            .retain_block(
                &cluster(),
                90,
                "archive",
                block(90, std::slice::from_ref(&listed)),
            )
            .await
            .unwrap();
        journal
            .retain_activity(&cluster(), &listed, 90, "tx", raw(&listed, 90))
            .await
            .unwrap();
        assert_eq!(
            journal
                .activity_position(&cluster(), 90, &listed)
                .await
                .unwrap()["transaction_index"],
            0
        );
        journal
            .retain_activity(&cluster(), &absent, 90, "tx", raw(&absent, 90))
            .await
            .unwrap();
        assert_eq!(
            journal
                .activity_position(&cluster(), 90, &listed)
                .await
                .unwrap()["status"],
            "conflict"
        );
        assert!(
            journal
                .activity_position(&cluster(), 90, &listed)
                .await
                .unwrap()["transaction_index"]
                .is_null()
        );
        assert_eq!(
            journal
                .activity_position(&cluster(), 90, &absent)
                .await
                .unwrap()["status"],
            "conflict"
        );
        let response = crate::router(journal.clone())
            .oneshot(
                Request::get(format!("/activity/blocks/{}/90", cluster()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let proof: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(proof["position_status"], "conflict");
        assert_eq!(proof["result"], block(90, std::slice::from_ref(&listed)));
        assert_eq!(
            journal
                .activity_transaction(&cluster(), &absent)
                .await
                .unwrap(),
            raw(&absent, 90)
        );
        let other = Journal::open("sqlite::memory:").await.unwrap();
        other
            .retain_block(
                &cluster(),
                90,
                "archive",
                block(90, std::slice::from_ref(&listed)),
            )
            .await
            .unwrap();
        other
            .retain_activity(&cluster(), &listed, 91, "tx", raw(&listed, 91))
            .await
            .unwrap();
        assert_eq!(
            other.activity_block(&cluster(), 90).await.unwrap()["position_status"],
            "conflict"
        );
        assert_eq!(
            other
                .activity_position(&cluster(), 91, &listed)
                .await
                .unwrap()["status"],
            "conflict"
        );
        for column in ["source_id", "blockhash"] {
            let clean = Journal::open("sqlite::memory:").await.unwrap();
            clean
                .retain_block(
                    &cluster(),
                    90,
                    "archive",
                    block(90, std::slice::from_ref(&listed)),
                )
                .await
                .unwrap();
            let query = format!("UPDATE activity_blocks SET {column}='corrupt'");
            sqlx::query(&query).execute(&clean.database).await.unwrap();
            assert!(matches!(
                clean.activity_block(&cluster(), 90).await,
                Err(Error::ReplayMismatch)
            ));
        }
    }
}
