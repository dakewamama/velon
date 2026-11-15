use cataloger::{Catalog, ProgramVersion};
use catalyst_indexer::rpc::{Scope, action_router, observe_catalogued, simulate_revoke};
use catalyst_indexer::{Journal, Snapshot, router};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use std::time::Duration;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {}", redact(&error.to_string()));
            std::process::ExitCode::FAILURE
        }
    }
}

/// A provider URL can carry an API key in its path or query; errors are printed without it.
fn redact(message: &str) -> String {
    let mut message = message.to_owned();
    if let Ok(url) = std::env::var("RPC_URL")
        && !url.is_empty()
    {
        message = message.replace(url.trim_end_matches('/'), "<rpc>");
    }
    message
        .split(' ')
        .map(|word| match word.find("://") {
            Some(_) => match word.split_once("://") {
                Some((scheme, rest)) => {
                    let host = rest.split(['/', '?', ')']).next().unwrap_or_default();
                    let tail = if word.ends_with(')') { ")" } else { "" };
                    format!("{scheme}://{host}/<redacted>{tail}")
                }
                None => word.to_owned(),
            },
            None => word.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let [command, program] = args.as_slice()
        && command == "capture"
    {
        let client = RpcClient::new_with_timeout_and_commitment(
            std::env::var("RPC_URL")?,
            Duration::from_secs(30),
            CommitmentConfig::finalized(),
        );
        let capture = catalyst_indexer::rpc::capture(&client, program.parse()?).await?;
        println!("{}", serde_json::to_string_pretty(&capture)?);
        return Ok(());
    }
    let database_url = std::env::var("DATABASE_URL")?;
    let journal = Journal::open(&database_url).await?;
    match args.as_slice() {
        [command, limit, source] if command == "history-worker" => {
            let limit = limit.parse()?;
            if !(1..=100).contains(&limit) {
                return Err("history worker limit must be 1..100".into());
            }
            let client = RpcClient::new_with_timeout_and_commitment(
                std::env::var("RPC_URL")?,
                Duration::from_secs(15),
                CommitmentConfig::finalized(),
            );
            loop {
                match catalyst_indexer::history::reconcile(&journal, &client, limit, source).await {
                    Ok(result) => println!("{}", serde_json::to_string(&result)?),
                    Err(error) => eprintln!(
                        "history reconciliation failed: {}",
                        redact(&error.to_string())
                    ),
                }
                tokio::select! {
                    _=tokio::signal::ctrl_c()=>break,
                    _=tokio::time::sleep(Duration::from_secs(5))=>{},
                }
            }
        }
        [command, limit, source] if command == "history-reconcile" => {
            let client = RpcClient::new_with_timeout_and_commitment(
                std::env::var("RPC_URL")?,
                Duration::from_secs(15),
                CommitmentConfig::finalized(),
            );
            let result =
                catalyst_indexer::history::reconcile(&journal, &client, limit.parse()?, source)
                    .await?;
            println!("{}", serde_json::to_string(&result)?);
        }
        [command, address, pages, source]
            if command == "history-backfill" || command == "history-recent" =>
        {
            let client = RpcClient::new_with_timeout_and_commitment(
                std::env::var("RPC_URL")?,
                Duration::from_secs(15),
                CommitmentConfig::finalized(),
            );
            let result = catalyst_indexer::history::collect(
                &journal,
                &client,
                address.parse()?,
                pages.parse()?,
                source,
                command == "history-recent",
            )
            .await?;
            println!("{}", serde_json::to_string(&result)?);
        }
        [command, cluster, address] if command == "history" => {
            let result = journal
                .activity(cluster, address.parse()?, Default::default())
                .await?;
            println!("{}", serde_json::to_string(&result)?);
        }
        [command, catalog_path, scope_path] if command == "observe" => {
            let versions: Vec<ProgramVersion> =
                serde_json::from_slice(&std::fs::read(catalog_path)?)?;
            let catalog = Catalog::new(versions)?;
            let scope: Scope = serde_json::from_slice(&std::fs::read(scope_path)?)?;
            let client = RpcClient::new_with_timeout_and_commitment(
                std::env::var("RPC_URL")?,
                Duration::from_secs(30),
                CommitmentConfig::finalized(),
            );
            let snapshot = observe_catalogued(&client, scope, &catalog).await?;
            let record = journal.ingest(snapshot, &catalog).await?;
            // The record is journaled and read back through the API; printing its megabytes of
            // program bytes here would only be parsed again for these three fields.
            println!(
                "{}",
                serde_json::json!({
                    "id": record.id,
                    "scope_id": record.snapshot.scope_id()?,
                    "targets": record.snapshot.targets,
                })
            );
        }
        [command, catalog_path, snapshot_path] if command == "import" => {
            let versions: Vec<ProgramVersion> =
                serde_json::from_slice(&std::fs::read(catalog_path)?)?;
            let snapshot: Snapshot = serde_json::from_slice(&std::fs::read(snapshot_path)?)?;
            let record = journal.ingest(snapshot, &Catalog::new(versions)?).await?;
            println!("{}", serde_json::to_string(&record)?);
        }
        [command, id] if command == "replay" => {
            println!("{}", serde_json::to_string(&journal.replay(id).await?)?);
        }
        [command, id, source] if command == "simulate-revoke" => {
            let client = RpcClient::new_with_timeout_and_commitment(
                std::env::var("RPC_URL")?,
                Duration::from_secs(30),
                CommitmentConfig::finalized(),
            );
            let result = simulate_revoke(&client, &journal, id, source.parse()?).await?;
            println!("{}", serde_json::to_string(&result)?);
        }
        [command, id] if command == "latest" => {
            let record = journal
                .get(id)
                .await?
                .ok_or(catalyst_indexer::Error::NotFound)?;
            let scope_id = record.snapshot.scope_id()?;
            let current = journal
                .latest(&scope_id)
                .await?
                .ok_or(catalyst_indexer::Error::NotFound)?;
            println!(
                "{}",
                serde_json::json!({"scope_id": scope_id, "record": current})
            );
        }
        [command, address] if command == "serve" => {
            let mut app = router(journal.clone());
            if let Ok(url) = std::env::var("RPC_URL") {
                let client = RpcClient::new_with_timeout_and_commitment(
                    url,
                    Duration::from_secs(30),
                    CommitmentConfig::finalized(),
                );
                app = app.merge(action_router(journal, client));
            }
            let listener = tokio::net::TcpListener::bind(address).await?;
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        _ => {
            return Err(
                "usage: authorization-api capture PROGRAM | observe CATALOG SCOPE | import CATALOG SNAPSHOT | replay ID | simulate-revoke ID SOURCE | latest ID | serve ADDRESS | history-backfill ADDRESS PAGES SOURCE | history-recent ADDRESS PAGES SOURCE | history-reconcile LIMIT SOURCE | history-worker LIMIT SOURCE | history CLUSTER ADDRESS"
                    .into(),
            );
        }
    }
    Ok(())
}
