// ═════════════════════════════════════════════════════════════════════════
// db.js — D1 database helper layer for Cloudflare Workers
// Mirrors the original better-sqlite3 db.js but uses D1's async prepare/bind API
// ═════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} D1Result
 * @property {any[]} results
 * @property {number} success
 * @property {Object} meta
 */

// ─── Singers ─────────────────────────────────────────────────────────────
export async function getSingers(env, { search = '', limit = null, offset = 0 } = {}) {
  let sql = `SELECT * FROM singers`;
  const params = [];
  if (search) {
    sql += ` WHERE name LIKE ? OR country LIKE ? OR genre LIKE ?`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY votes DESC, name ASC`;
  if (limit) {
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results;
}

export async function getSingerById(env, id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1) return null;
  return await env.DB.prepare(`SELECT * FROM singers WHERE id = ?`).bind(n).first();
}

export async function getSingerByName(env, name) {
  return await env.DB.prepare(`SELECT * FROM singers WHERE LOWER(name) = LOWER(?)`).bind(name).first();
}

export async function getCountries(env) {
  const { results } = await env.DB.prepare(`
    SELECT country,
           COUNT(*) AS artists,
           SUM(votes) AS total_votes
    FROM singers
    WHERE country != ''
    GROUP BY country
    ORDER BY total_votes DESC, artists DESC
  `).all();
  return results;
}

export async function getSingersByCountry(env, country) {
  const { results } = await env.DB.prepare(`
    SELECT *, RANK() OVER (ORDER BY votes DESC, name ASC) AS country_rank
    FROM singers
    WHERE LOWER(country) = LOWER(?)
    ORDER BY votes DESC, name ASC
  `).bind(String(country).slice(0, 80)).all();
  return results;
}

export async function createSinger(env, name, country, genre, imageUrl = '') {
  const info = await env.DB.prepare(`
    INSERT INTO singers (name, country, genre, image_url, votes, revenue_cents)
    VALUES (?, ?, ?, ?, 0, 0)
  `).bind(name, country || 'Global', genre || 'Music', imageUrl || '').run();
  return await getSingerById(env, info.meta.last_row_id);
}

export async function addVotes(env, singerId, count, amountCents) {
  const n = parseInt(singerId, 10);
  if (isNaN(n) || n < 1) return;
  await env.DB.prepare(`UPDATE singers SET votes = votes + ?, revenue_cents = revenue_cents + ? WHERE id = ?`)
    .bind(parseInt(count, 10) || 0, parseInt(amountCents, 10) || 0, n).run();
}

// ─── Payments ─────────────────────────────────────────────────────────────
export async function createPayment(env, p) {
  const info = await env.DB.prepare(`
    INSERT INTO payments (singer_id, voter_name, voter_message, method, vote_count, amount_cents, currency, reference, receipt_image, status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).bind(
    p.singer_id,
    p.voter_name || 'Anonymous',
    p.voter_message || '',
    p.method,
    p.vote_count,
    p.amount_cents,
    p.currency || 'USD',
    p.reference || null,
    p.receipt_image || null,
    p.status || 'pending'
  ).run();
  return info.meta.last_row_id;
}

export async function getPaymentById(env, id) {
  return await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first();
}

export async function getPaymentByReference(env, ref) {
  return await env.DB.prepare(`SELECT * FROM payments WHERE reference = ?`).bind(ref).first();
}

export async function completePayment(env, id) {
  const p = await getPaymentById(env, id);
  if (!p || p.status === 'completed') return p;
  await env.DB.prepare(`UPDATE payments SET status = 'completed' WHERE id = ?`).bind(id).run();
  await addVotes(env, p.singer_id, p.vote_count, p.amount_cents);
  return await getPaymentById(env, id);
}

export async function listPayments(env, status) {
  if (status) {
    const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC LIMIT 200`).bind(status).all();
    return results;
  }
  const { results } = await env.DB.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT 200`).all();
  return results;
}

export async function updatePaymentReference(env, id, reference) {
  await env.DB.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).bind(reference, id).run();
}

export async function rejectPayment(env, id) {
  await env.DB.prepare(`UPDATE payments SET status = 'rejected' WHERE id = ?`).bind(id).run();
}

// ─── Battles ─────────────────────────────────────────────────────────────
export async function getBattle(env, eventId, aId, bId) {
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]];
  return await env.DB.prepare(`SELECT * FROM battles WHERE event_id = ? AND singer_a = ? AND singer_b = ?`)
    .bind(String(eventId).slice(0, 60), lo, hi).first();
}

export async function createBattle(env, eventId, aId, bId) {
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]];
  await env.DB.prepare(`INSERT OR IGNORE INTO battles (event_id, singer_a, singer_b) VALUES (?, ?, ?)`)
    .bind(String(eventId).slice(0, 60), lo, hi).run();
  return await getBattle(env, eventId, lo, hi);
}

export async function voteBattle(env, eventId, aId, bId, side, count) {
  let b = await getBattle(env, eventId, aId, bId) || await createBattle(env, eventId, aId, bId);
  if (!b) return null;
  const n = Math.max(1, Math.min(1000, parseInt(count, 10) || 1));
  const col = (+side === b.singer_a) ? 'votes_a' : 'votes_b';
  // D1 doesn't support column interpolation in bind, but these are validated column names
  await env.DB.prepare(`UPDATE battles SET ${col} = ${col} + ? WHERE id = ?`).bind(n, b.id).run();
  return await getBattle(env, eventId, aId, bId);
}

export async function listBattlesByEvent(env, eventId) {
  const { results } = await env.DB.prepare(`SELECT * FROM battles WHERE event_id = ? ORDER BY created_at DESC`)
    .bind(String(eventId).slice(0, 60)).all();
  return results;
}

// ─── Competitions (distinct battles joined with singer names) ────────────
export async function listAllBattles(env) {
  const { results } = await env.DB.prepare(`
    SELECT b.event_id, b.singer_a, b.singer_b, b.votes_a, b.votes_b, b.created_at,
           sa.name AS name_a, sa.image_url AS img_a, sa.country AS country_a,
           sb.name AS name_b, sb.image_url AS img_b, sb.country AS country_b
    FROM battles b
    JOIN singers sa ON sa.id = b.singer_a
    JOIN singers sb ON sb.id = b.singer_b
    ORDER BY b.created_at DESC
  `).all();
  return results;
}

// ─── Animations ───────────────────────────────────────────────────────────
export async function createAnimation(env, { singer_id = null, motion = 'nod', source_url = '' }) {
  const info = await env.DB.prepare(`
    INSERT INTO animations (singer_id, motion, status, source_url)
    VALUES (?, ?, 'pending', ?)
  `).bind(singer_id, String(motion).slice(0, 20), String(source_url || '').slice(0, 500)).run();
  return await getAnimationById(env, info.meta.last_row_id);
}

export async function getAnimationById(env, id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1) return null;
  return await env.DB.prepare(`SELECT * FROM animations WHERE id = ?`).bind(n).first();
}

export async function updateAnimationStatus(env, id, { status, file_url, thumb_url, error, duration_ms, frames }) {
  const sets = [];
  const params = [];
  if (status !== undefined)      { sets.push('status = ?');      params.push(String(status)); }
  if (file_url !== undefined)    { sets.push('file_url = ?');    params.push(String(file_url)); }
  if (thumb_url !== undefined)   { sets.push('thumb_url = ?');   params.push(String(thumb_url)); }
  if (error !== undefined)       { sets.push('error = ?');       params.push(String(error).slice(0, 500)); }
  if (duration_ms !== undefined) { sets.push('duration_ms = ?'); params.push(parseInt(duration_ms, 10) || 0); }
  if (frames !== undefined)      { sets.push('frames = ?');      params.push(parseInt(frames, 10) || 0); }
  if (!sets.length) return await getAnimationById(env, id);
  params.push(parseInt(id, 10));
  await env.DB.prepare(`UPDATE animations SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return await getAnimationById(env, id);
}

export async function listAnimations(env, { singer_id = null, limit = 50 } = {}) {
  let sql = `SELECT * FROM animations`;
  const params = [];
  if (singer_id) { sql += ` WHERE singer_id = ?`; params.push(parseInt(singer_id, 10)); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)));
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results;
}

// ─── Donations & Recent Votes ─────────────────────────────────────────────
export async function getDonationsBySinger(env, id) {
  const { results } = await env.DB.prepare(`
    SELECT voter_name, voter_message, vote_count, amount_cents, method, created_at
    FROM payments
    WHERE singer_id = ? AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT 100
  `).bind(id).all();
  return results;
}

export async function getRecentVotes(env) {
  const { results } = await env.DB.prepare(`
    SELECT p.voter_name, p.vote_count, p.amount_cents, p.method, p.created_at,
           s.name AS singer_name, s.id AS singer_id
    FROM payments p
    JOIN singers s ON s.id = p.singer_id
    WHERE p.status = 'completed'
    ORDER BY p.created_at DESC
    LIMIT 30
  `).all();
  return results;
}
