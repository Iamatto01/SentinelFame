-- ════════════════════════════════════════════════════════════════════════
-- Best Artist Voting — D1 Schema (SQLite at the edge)
-- Mirrors the original better-sqlite3 schema from db.js
-- ════════════════════════════════════════════════════════════════════════

-- ─── Singers ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS singers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  votes INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_singers_votes ON singers(votes DESC);
CREATE INDEX IF NOT EXISTS idx_singers_country ON singers(country);

-- ─── Payments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  singer_id INTEGER NOT NULL REFERENCES singers(id),
  voter_name TEXT DEFAULT 'Anonymous',
  voter_message TEXT DEFAULT '',
  method TEXT NOT NULL,           -- stripe | paypal | toyyibpay | manual | crypto
  vote_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  reference TEXT,                  -- Stripe session ID, PayPal order ID, etc.
  receipt_image TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | rejected
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_singer ON payments(singer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);

-- ─── Battles (A vs B competitions) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  singer_a INTEGER NOT NULL REFERENCES singers(id),
  singer_b INTEGER NOT NULL REFERENCES singers(id),
  votes_a INTEGER NOT NULL DEFAULT 0,
  votes_b INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(event_id, singer_a, singer_b)
);
CREATE INDEX IF NOT EXISTS idx_battles_event ON battles(event_id);

-- ─── Animations (AI nod / wave from artist photo) ────────────────────────
-- NOTE: On Workers, heavy CPU tasks (jimp/gifenc) cannot run synchronously.
-- Animation generation would need a separate service or Cloudflare Queue +
-- external worker. This table is kept for API compatibility; generation
-- is stubbed to "unavailable" in the worker.
CREATE TABLE IF NOT EXISTS animations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  singer_id INTEGER REFERENCES singers(id),
  motion TEXT NOT NULL DEFAULT 'nod',
  status TEXT NOT NULL DEFAULT 'pending',
  file_url TEXT DEFAULT '',
  thumb_url TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  error TEXT DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  frames INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_animations_singer ON animations(singer_id);
CREATE INDEX IF NOT EXISTS idx_animations_status ON animations(status);
