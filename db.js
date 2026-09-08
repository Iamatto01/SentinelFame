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
  `).run(name, country || '', genre || '');
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
  const info = db.prepare(`
    INSERT INTO payments (singer_id, voter_name, voter_message, method, vote_count, amount_cents, currency, reference, receipt_image, status)
    VALUES (@singer_id, @voter_name, @voter_message, @method, @vote_count, @amount_cents, @currency, @reference, @receipt_image, @status)
  `).run({
    voter_name: 'Anonymous', voter_message: '', currency: 'USD', reference: null, receipt_image: null,
    status: 'pending', ...p
  });
  return info.lastInsertRowid;
}

function getPaymentById(id) {
  return db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id);
}

function getPaymentByReference(ref) {
  return db.prepare(`SELECT * FROM payments WHERE reference = ?`).get(ref);
}

function completePayment(id) {
  const p = getPaymentById(id);
  if (!p || p.status === 'completed') return p;
  db.prepare(`UPDATE payments SET status = 'completed' WHERE id = ?`).run(id);
  addVotes(p.singer_id, p.vote_count, p.amount_cents);
  return getPaymentById(id);
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
  createAnimation, getAnimationById, updateAnimationStatus, listAnimations
};
