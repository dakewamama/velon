-- Raw finalized RPC transaction evidence, separate from provisional webhook events.
-- Decimal text and fixed-width big-endian bytes preserve the complete u64 slot range.
CREATE TABLE activity_transactions (
    cluster TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot_units TEXT NOT NULL,
    slot_order BLOB NOT NULL CHECK(length(slot_order) = 8),
    raw_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY(cluster, signature)
);
CREATE INDEX activity_slot ON activity_transactions(cluster, slot_order DESC, signature DESC);
CREATE TABLE activity_addresses (
    cluster TEXT NOT NULL,
    signature TEXT NOT NULL,
    address TEXT NOT NULL,
    PRIMARY KEY(cluster, signature, address),
    FOREIGN KEY(cluster, signature) REFERENCES activity_transactions(cluster, signature)
);
CREATE INDEX activity_address ON activity_addresses(cluster, address, signature);
CREATE TABLE activity_backfill (
    cluster TEXT NOT NULL,
    address TEXT NOT NULL,
    source_id TEXT NOT NULL,
    before_signature TEXT,
    exhausted INTEGER NOT NULL DEFAULT 0 CHECK(exhausted IN (0, 1)),
    PRIMARY KEY(cluster, address, source_id)
);
CREATE TABLE activity_gaps (
    cluster TEXT NOT NULL,
    address TEXT NOT NULL,
    signature TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts > 0),
    PRIMARY KEY(cluster, address, signature, source_id)
);
-- A webhook is acknowledged only after its original JSON and receipt work are durable.
CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);
CREATE TABLE webhook_receipts (
    signature TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id),
    address TEXT
);
