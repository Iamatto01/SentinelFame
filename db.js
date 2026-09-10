const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const candidateDirs = [
  path.join(__dirname, '..', 'SentinelData'),
  path.join(__dirname, '..', 'data'),
  path.join(__dirname, 'data'),
  __dirname
];

let dataDir = candidateDirs.find(d => fs.existsSync(path.join(d, 'votes.db')));
if (!dataDir) {
  dataDir = candidateDirs[0];
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'votes.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  singer_id INTEGER NOT NULL REFERENCES singers(id),
  voter_name TEXT DEFAULT 'Anonymous',
  voter_message TEXT DEFAULT '',
  method TEXT NOT NULL,
  vote_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  reference TEXT,
  receipt_image TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_singers_votes ON singers(votes DESC);
`);

// ---------- Singers ----------
function getSingers({ search = '', limit = null, offset = 0 } = {}) {
  let sql = `SELECT * FROM singers`;
  const params = [];
  if (search) {
    sql += ` WHERE name LIKE ? OR country LIKE ? OR genre LIKE ?`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY votes DESC, name ASC`;
  if (limit) sql += ` LIMIT ? OFFSET ?`, params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function getSingerById(id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1) return null;        // reject non‑integer ids
  return db.prepare(`SELECT * FROM singers WHERE id = ?`).get(n);
}

function getSingerByName(name) {
  // case‑insensitive exact match via parameterized LIKE
  return db.prepare(`SELECT * FROM singers WHERE LOWER(name) = LOWER(?)`).get(name);
}

// Distinct countries with artist counts + total votes (for the country page)
function getCountries() {
  return db.prepare(`
    SELECT country,
           COUNT(*) AS artists,
           SUM(votes) AS total_votes
    FROM singers
    WHERE country != ''
    GROUP BY country
    ORDER BY total_votes DESC, artists DESC
  `).all();
}

// Ranking within one country (1 = top of that country)
function getSingersByCountry(country) {
  return db.prepare(`
    SELECT *, RANK() OVER (ORDER BY votes DESC, name ASC) AS country_rank
    FROM singers
    WHERE LOWER(country) = LOWER(?)
    ORDER BY votes DESC, name ASC
  `).all(String(country).slice(0, 80));
}

function createSinger(name, country, genre) {
  const info = db.prepare(`
    INSERT INTO singers (name, country, genre, votes, revenue_cents)
    VALUES (?, ?, ?, 0, 0)
  `).run(String(name), String(country || ''), String(genre || ''));
  return db.prepare(`SELECT * FROM singers WHERE id = ?`).get(info.lastInsertRowid);
}

function addVotes(singerId, count, amountCents) {
  const n = parseInt(singerId, 10);
  if (isNaN(n) || n < 1) return;
  db.prepare(`UPDATE singers SET votes = votes + ?, revenue_cents = revenue_cents + ? WHERE id = ?`)
    .run(parseInt(count, 10) || 0, parseInt(amountCents, 10) || 0, n);
}

// ---------- Payments ----------
function createPayment(p) {
  const merged = {
    voter_name: 'Anonymous', voter_message: '', currency: 'USD', reference: null, receipt_image: null,
    status: 'pending', ...p
  };
  // Coerce to bindable primitives (better-sqlite3 rejects undefined/objects)
  const info = db.prepare(`
    INSERT INTO payments (singer_id, voter_name, voter_message, method, vote_count, amount_cents, currency, reference, receipt_image, status)
    VALUES (@singer_id, @voter_name, @voter_message, @method, @vote_count, @amount_cents, @currency, @reference, @receipt_image, @status)
  `).run({
    singer_id: parseInt(merged.singer_id, 10),
    voter_name: String(merged.voter_name || 'Anonymous'),
    voter_message: String(merged.voter_message || ''),
    method: String(merged.method || 'manual'),
    vote_count: parseInt(merged.vote_count, 10) || 0,
    amount_cents: parseInt(merged.amount_cents, 10) || 0,
    currency: String(merged.currency || 'USD'),
    reference: merged.reference == null ? null : String(merged.reference),
    receipt_image: merged.receipt_image == null ? null : String(merged.receipt_image),
    status: String(merged.status || 'pending'),
  });
  return info.lastInsertRowid;
}

function getPaymentById(id) {
  return db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id);
}

function getPaymentByReference(ref) {
  return db.prepare(`SELECT * FROM payments WHERE reference = ?`).get(ref);
}

// ---------- Payment credit integrity (idempotent crediting) ----------
db.exec(`
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
`);

function savePaymentCreditContext(paymentId, ctx) {
  db.prepare(`
    INSERT OR IGNORE INTO payment_credit_context
      (payment_id, singer_id, vote_count, amount_cents, battle_event_id, battle_singer_a, battle_singer_b, battle_side)
    VALUES (@payment_id, @singer_id, @vote_count, @amount_cents, @battle_event_id, @battle_singer_a, @battle_singer_b, @battle_side)
  `).run({
    payment_id: parseInt(paymentId, 10),
    singer_id: parseInt(ctx.singerId, 10),
    vote_count: parseInt(ctx.voteCount, 10) || 0,
    amount_cents: parseInt(ctx.amountCents, 10) || 0,
    battle_event_id: ctx.battleEventId ? String(ctx.battleEventId).slice(0, 60) : null,
    battle_singer_a: ctx.battleAId != null ? parseInt(ctx.battleAId, 10) : null,
    battle_singer_b: ctx.battleBId != null ? parseInt(ctx.battleBId, 10) : null,
    battle_side: ctx.battleSide != null ? parseInt(ctx.battleSide, 10) : null,
  });
}

function getPaymentCreditContext(paymentId) {
  return db.prepare(`SELECT * FROM payment_credit_context WHERE payment_id = ?`).get(parseInt(paymentId, 10));
}

/**
 * Atomically credit a payment exactly once.
 * better-sqlite3 transactions are synchronous and serialized on the Node
 * event loop, so the INSERT into payment_credit_claims (PK on payment_id)
 * guarantees webhook + polling fallbacks can never double-credit.
 */
function completePayment(id) {
  const pid = parseInt(id, 10);
  if (isNaN(pid) || pid < 1) return null;

  const p = getPaymentById(pid);
  if (!p) return null;
  if (p.status === 'completed') return p;

  const ctx = getPaymentCreditContext(pid);
  const singerId = ctx ? ctx.singer_id : p.singer_id;
  const voteCount = ctx ? ctx.vote_count : p.vote_count;
  const amountCents = ctx ? ctx.amount_cents : p.amount_cents;

  const credit = db.transaction(() => {
    // Idempotency guard: PK violation means already credited — abort silently.
    db.prepare(`INSERT INTO payment_credit_claims (payment_id) VALUES (?)`).run(pid);
    db.prepare(`UPDATE payments SET status = 'completed' WHERE id = ?`).run(pid);
    db.prepare(`UPDATE singers SET votes = votes + ?, revenue_cents = revenue_cents + ? WHERE id = ?`)
      .run(voteCount, amountCents, singerId);

    if (ctx && ctx.battle_event_id && ctx.battle_singer_a != null && ctx.battle_singer_b != null) {
      const [lo, hi] = [+ctx.battle_singer_a < +ctx.battle_singer_b]
        ? [+ctx.battle_singer_a, +ctx.battle_singer_b]
        : [+ctx.battle_singer_b, +ctx.battle_singer_a];
      const col = (+ctx.battle_side === lo) ? 'votes_a' : 'votes_b';
      db.prepare(`INSERT OR IGNORE INTO battles (event_id, singer_a, singer_b) VALUES (?, ?, ?)`)
        .run(ctx.battle_event_id, lo, hi);
      db.prepare(`UPDATE battles SET ${col} = ${col} + ? WHERE event_id = ? AND singer_a = ? AND singer_b = ?`)
        .run(voteCount, ctx.battle_event_id, lo, hi);
    }
  });

  try {
    credit();
  } catch (e) {
    if (String(e?.message || e).match(/UNIQUE|PRIMARY KEY/i)) {
      // Another path already credited this payment — idempotent no-op.
      return getPaymentById(pid);
    }
    throw e;
  }
  return getPaymentById(pid);
}

function listPayments(status) {
  if (status) return db.prepare(`SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC LIMIT 200`).all(status);
  return db.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT 200`).all();
}

// ---------- Migration: add voter_message to existing DBs ----------
try {
  db.exec(`ALTER TABLE payments ADD COLUMN voter_message TEXT DEFAULT ''`);
} catch { /* column already exists */ }

// ---------- Battles (A vs B) ----------
db.exec(`
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
`);

function getBattle(eventId, aId, bId) {
  // Normalize order so A vs B === B vs A
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]][0];
  return db.prepare(`SELECT * FROM battles WHERE event_id = ? AND singer_a = ? AND singer_b = ?`)
    .get(String(eventId).slice(0, 60), lo, hi);
}

function createBattle(eventId, aId, bId) {
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]][0];
  db.prepare(`INSERT OR IGNORE INTO battles (event_id, singer_a, singer_b) VALUES (?, ?, ?)`)
    .run(String(eventId).slice(0, 60), lo, hi);
  return getBattle(eventId, lo, hi);
}

function voteBattle(eventId, aId, bId, side, count) {
  const b = getBattle(eventId, aId, bId) || createBattle(eventId, aId, bId);
  if (!b) return null;
  const n = Math.max(1, Math.min(1000, parseInt(count, 10) || 1));
  // Map the voted side back to column a/b regardless of input order
  const col = (+side === b.singer_a) ? 'votes_a' : 'votes_b';
  db.prepare(`UPDATE battles SET ${col} = ${col} + ? WHERE id = ?`).run(n, b.id);
  return getBattle(eventId, aId, bId);
}

function listBattlesByEvent(eventId) {
  return db.prepare(`SELECT * FROM battles WHERE event_id = ? ORDER BY created_at DESC`)
    .all(String(eventId).slice(0, 60));
}

// ---------- Animations (AI nod / wave videos from artist photos) ----------
db.exec(`
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
`);

function createAnimation({ singer_id = null, motion = 'nod', source_url = '' }) {
  const info = db.prepare(`
    INSERT INTO animations (singer_id, motion, status, source_url)
    VALUES (?, ?, 'pending', ?)
  `).run(singer_id, String(motion).slice(0, 20), String(source_url || '').slice(0, 500));
  return getAnimationById(info.lastInsertRowid);
}

function getAnimationById(id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1) return null;
  return db.prepare(`SELECT * FROM animations WHERE id = ?`).get(n);
}

function updateAnimationStatus(id, { status, file_url, thumb_url, error, duration_ms, frames }) {
  const sets = [];
  const params = {};
  if (status !== undefined)      { sets.push('status = @status');           params.status = String(status); }
  if (file_url !== undefined)    { sets.push('file_url = @file_url');       params.file_url = String(file_url); }
  if (thumb_url !== undefined)   { sets.push('thumb_url = @thumb_url');     params.thumb_url = String(thumb_url); }
  if (error !== undefined)       { sets.push('error = @error');             params.error = String(error).slice(0, 500); }
  if (duration_ms !== undefined) { sets.push('duration_ms = @duration_ms'); params.duration_ms = parseInt(duration_ms, 10) || 0; }
  if (frames !== undefined)      { sets.push('frames = @frames');           params.frames = parseInt(frames, 10) || 0; }
  if (!sets.length) return getAnimationById(id);
  params.id = parseInt(id, 10);
  db.prepare(`UPDATE animations SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getAnimationById(id);
}

function listAnimations({ singer_id = null, limit = 50 } = {}) {
  let sql = `SELECT * FROM animations`;
  const params = [];
  if (singer_id) { sql += ` WHERE singer_id = ?`; params.push(parseInt(singer_id, 10)); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)));
  return db.prepare(sql).all(...params);
}

module.exports = {
  db,
  getSingers, getSingerById, getSingerByName, createSinger, addVotes,
  getCountries, getSingersByCountry,
  getBattle, createBattle, voteBattle, listBattlesByEvent,
  createPayment, getPaymentById, getPaymentByReference, completePayment, listPayments,
  savePaymentCreditContext, getPaymentCreditContext,
  createAnimation, getAnimationById, updateAnimationStatus, listAnimations
};
