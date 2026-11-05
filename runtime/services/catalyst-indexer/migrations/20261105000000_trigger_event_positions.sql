-- An event is one inner instruction, so two identical pulls in one transaction are two rows.
-- Amounts above i64 are kept exactly in amount_units; amount stays empty for them.
ALTER TABLE trigger_events ADD COLUMN slot INTEGER;
ALTER TABLE trigger_events ADD COLUMN outer_index INTEGER;
ALTER TABLE trigger_events ADD COLUMN inner_index INTEGER;
ALTER TABLE trigger_events ADD COLUMN amount_units TEXT;
ALTER TABLE trigger_events ADD COLUMN receiver TEXT;
ALTER TABLE trigger_events ADD COLUMN receiver_token_account TEXT;
ALTER TABLE trigger_events ADD COLUMN puller TEXT;
ALTER TABLE trigger_events ADD COLUMN payer TEXT;
ALTER TABLE trigger_events ADD COLUMN owner TEXT;
DROP INDEX idx_trigger_events_unique;
CREATE UNIQUE INDEX idx_trigger_events_position ON trigger_events(signature, outer_index, inner_index);
CREATE INDEX idx_trigger_events_puller ON trigger_events(puller);
CREATE INDEX idx_trigger_events_receiver ON trigger_events(receiver);
