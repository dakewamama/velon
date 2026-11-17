-- Independently fetched finalized getBlock signatures and their native block ordinals.
-- Slots remain decimal text; block ordinals are bounded native u32 values.
CREATE TABLE activity_blocks (
    cluster TEXT NOT NULL,
    slot_units TEXT NOT NULL,
    blockhash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    source_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(cluster, slot_units),
    UNIQUE(cluster, blockhash)
);
CREATE TABLE activity_block_signatures (
    cluster TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot_units TEXT NOT NULL,
    transaction_index INTEGER NOT NULL CHECK(transaction_index BETWEEN 0 AND 4294967295),
    PRIMARY KEY(cluster, signature),
    UNIQUE(cluster, slot_units, transaction_index),
    FOREIGN KEY(cluster, slot_units) REFERENCES activity_blocks(cluster, slot_units)
);
-- Attempts preserve unavailable/malformed/conflicting replies. Successful retries
-- resolve transport/data gaps without deleting their original response evidence.
CREATE TABLE activity_block_attempts (
    id TEXT PRIMARY KEY,
    cluster TEXT NOT NULL,
    slot_units TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('pending','unavailable','invalid','conflict')),
    raw_json TEXT,
    sha256 TEXT,
    attempts INTEGER NOT NULL DEFAULT 1 CHECK(typeof(attempts) = 'integer' AND attempts > 0),
    resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
    CHECK((raw_json IS NULL) = (sha256 IS NULL))
);
CREATE INDEX activity_block_gaps ON activity_block_attempts(cluster, slot_units, resolved);
