# Retained historical activity

The existing indexer now journals full finalized RPC transaction results in the
same SQLite database as observations, using the existing event decoder and
extractor. Provisional `trigger_events` rows remain provisional. No webhook row
alone appears as finalized activity.

Webhook delivery JSON and receipt work are committed together before an
acknowledgment. Unsupported layouts remain retained for later reconciliation.
The webhook database uses FULL synchronization, matching the observation journal.

## Operator commands

All commands use DATABASE_URL and RPC_URL. SOURCE is a non-secret operator label,
not an authenticated provider identity. Do not put credentials in it.

```sh
authorization-api history-backfill ADDRESS MAX_PAGES SOURCE
authorization-api history-recent ADDRESS MAX_PAGES SOURCE
authorization-api history-reconcile MAX_SIGNATURES SOURCE
authorization-api history-worker MAX_SIGNATURES SOURCE
authorization-api history CLUSTER_GENESIS ADDRESS
```

Backfill reads backwards in pages of 25 and stores a separate cursor per cluster,
address and source. It advances only after every transaction in a page is durable.
Requests have bounded timeouts and three transport attempts. Missing/inconsistent
transactions create durable gaps; a retry retains previous work and clears a gap
only after collecting that signature successfully from that source. A short page
ends that provider's current page sequence, **not** proof of complete chain history.
Empty pages preserve the last cursor and can be retried if archival data later
becomes available. An in-progress page has a durable gap marker, cleared in the
same transaction that advances its cursor.

Recent collection re-reads the bounded tip without advancing the backwards cursor.
The console invokes it on history reads and then displays retained records. A
refresh failure keeps previous evidence and is disclosed. `history-worker` runs
continuous receipt reconciliation against the webhook's database. A bounded tip read cannot guarantee
that high-volume activity between reads was captured. Do not call this a complete
live ledger. Archival retention and historical range completeness remain unproven.

Reconciliation selects provisional webhook signatures, fetches them independently
at finalized commitment, and uses the fetched transaction's slot and data. It
never trusts the webhook's amount or slot as final evidence. Durable retry counts
prioritize less-attempted signatures so an unavailable receipt cannot indefinitely
block later transactions. Failed finalized transactions are retained but produce
no successful transfer events.

## Read API

`GET /activity/CLUSTER/ADDRESS?limit=25&before=SIGNATURE` pages by retained
transactions, retaining all event positions within a transaction. Limit is 1–100.
The cursor orders by unsigned slot then signature; signature order is **not**
execution order within a slot. A native block ordinal remains unknown unless a
matching finalized block signature list has been independently retained.

`GET /activity/transactions/CLUSTER/SIGNATURE` returns the retained RPC result
after checksum verification. The console exposes a validated read-only proxy at
`/api/activity/transactions/CLUSTER/SIGNATURE`. It does not accept arbitrary URLs.

Transaction identity is `(cluster, signature)`. Event identity hashes the JSON
tuple `["velon:event:1", cluster, program, signature, "outer:inner"]`. Replaying
identical bytes is idempotent; conflicting evidence cannot overwrite a record.
Amounts and slots in normalized activity are decimal strings. The full RPC result
and original event bytes remain available. Checksums detect changes, not a database
owner who rewrites both evidence and checksums.

## Attribution and version boundary

Every historical event currently has unresolved authorization incarnation,
deployment and historical state version. A transaction mentioning an address is
not proof of the current permission's lifecycle. Current plan terms, current
pullers, names and token decimals never fill historical gaps. Known event layouts
are labelled unverified against the historical deployment; unknown layouts retain
raw bytes rather than inventing transfers. Missing ALT keys or inner-instruction
metadata produces an incomplete interpretation with the full transaction retained.

Instruction evidence is checked with Solana's existing RPC message types before
event decoding. Orphan/duplicate CPI groups, invalid instruction account indices,
inconsistent lookup counts, unsupported transaction versions and malformed event
bytes cannot masquerade as a successful decode. Unknown layouts retain their raw
events and mark the transaction interpretation incomplete.

RPC commitment and cluster checks are provider assertions, not cryptographic state
proofs. Inconsistent cluster replies fail collection. Historical executable
resolution, creation/closure reconstruction, complete transaction ordering and
verified plan configuration at the execution slot remain unresolved. No current
ARM ID is used to guess a historical incarnation.

Tests exercise local HTTP RPC collection, page interruption and restart, receipt
reconciliation, fair retries, duplicate replay, conflicting bytes, full-u64 values,
ALT resolution, failed transactions, corruption detection and API pagination.
These tests do not prove archival completeness or public-chain action execution.

## Optional finalized block positions

`authorization-api history-block SLOT SOURCE` independently fetches one block with
finalized commitment, signatures-only transaction details and no rewards. It checks
genesis before and after the request and reuses bounded RPC retries. It neither
backfills additional transactions nor advances address-history cursors.

The same journal retains the complete serialized RPC result, its raw-content hash,
cluster, requested slot, source label and a metadata-bound evidence ID. JSON result
fields are preserved, including unknown fields and exact u64 values; transport
whitespace and the HTTP/JSON-RPC envelope are not retained. Native `UiConfirmedBlock`,
`RpcBlockConfig`, hashes and signatures validate the response. Duplicate signatures,
missing lists, mixed transaction formats and invalid headers cannot supply positions.

`GET /activity/blocks/CLUSTER/SLOT` and
`authorization-api history-block-evidence CLUSTER SLOT` read retained evidence after
checksum, metadata and derived-index verification. Activity transactions carry a
`block_position` object. Events additionally carry `transaction_index`, the ordinal
in the provider's finalized block signature vector. This does not establish physical
execution timing. Pagination continues to use slot/signature order, so callers must
not treat page order as block order.

Writes of the raw block, signature positions and successful attempt resolution are
atomic. Retries are idempotent. Null/pruned/failed replies produce durable visible
attempts; malformed/conflicting result JSON is retained in
`activity_block_attempts`. Coverage gaps expose attempt IDs and reason metadata;
raw failed replies are inspected in that SQLite table, without a separate read API.
A successful retry resolves availability/data gaps from that source without deleting their original
response evidence. Byte-different finalized replies remain unresolved conflicts;
a repeat of the first reply does not automatically choose a winner. A late transaction
missing from an already stored block, or assigned another slot, invalidates position
claims for the whole affected block while preserving both facts.

This feature is optional and operator-invoked. There is no automatic block-range
completion or conflict-resolution policy. Provider labels are not authenticated
identities, and finalized RPC replies are not cryptographic block proofs. Coverage
stays incomplete, historical deployment interpretation stays unverified and
incarnation attribution stays unresolved. Failed transactions can have block positions
but never become successful transfers.

Migration `20261117000000` adds tables without changing retained transaction/event
bytes. Restart and old-schema migration are tested. Older rollback binaries whose
migrator rejects later migrations need a compatible rollback build; do not delete
these tables or evidence to make an old binary start.
