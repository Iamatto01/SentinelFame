-- Payment credit integrity for existing D1 databases.
-- The claim table is inserted first inside a D1 batch transaction. Because
-- payment_id is unique, concurrent webhook/polling retries cannot credit one
-- payment more than once. The context table preserves battle metadata without
-- changing the existing payments table.
CREATE TABLE IF NOT EXISTS payment_credit_context (
  payment_id INTEGER PRIMARY KEY,
  singer_id INTEGER NOT NULL,
  vote_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  battle_event_id TEXT,
  battle_singer_a INTEGER,
  battle_singer_b INTEGER,
  battle_side INTEGER
);

CREATE TABLE IF NOT EXISTS payment_credit_claims (
  payment_id INTEGER PRIMARY KEY,
  credited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
