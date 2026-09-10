// ═════════════════════════════════════════════════════════════════════════
// social-bot.js — Autonomous social media bot
// Posts leaderboard updates + big-vote highlights to Facebook, Threads, TikTok
// Runs via Cloudflare Worker cron triggers (see wrangler.toml [triggers])
// ═════════════════════════════════════════════════════════════════════════

const SITE_URL = 'https://hall-of-fame.sentinelai.studio';

// ─── Post formatting ──────────────────────────────────────────────────────

function formatLeaderboardPost(rows) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) =>
    `${medals[i] || `${i + 1}.`} ${r.name} — ${r.votes} undi`
  );
  return [
    `🏆 CARTA MINGGUAN HALL OF FAME 🏆`,
    ``,
    ...lines,
    ``,
    `Undi penyanyi kegemaran anda di ${SITE_URL}`,
    `#HallOfFame #SentinelFame #CartaMingguan`,
  ].join('\n');
}

function formatBigVotePost(vote) {
  return [
    `🔥 UNDI BESAR MASUK! 🔥`,
    ``,
    `${vote.voter_name || 'Seorang penyokong'} baru sahaja memberi ${vote.votes} undi kepada ${vote.singer_name}!`,
    ``,
    `Boleh anda atasi? Undi sekarang di ${SITE_URL}`,
    `#HallOfFame #SentinelFame`,
  ].join('\n');
}

// ─── Platform adapters ────────────────────────────────────────────────────
// Each adapter: async (env, text) => { ok, platform, id?, error? }
// Tokens are stored as Worker secrets:
//   FB_PAGE_TOKEN, THREADS_TOKEN, TIKTOK_TOKEN

async function postToFacebook(env, text) {
  const token = env.FB_PAGE_TOKEN;
  if (!token) return { ok: false, platform: 'facebook', error: 'FB_PAGE_TOKEN not set' };
  const pageId = env.FB_PAGE_ID;
  if (!pageId) return { ok: false, platform: 'facebook', error: 'FB_PAGE_ID not set' };

  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: text, access_token: token }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return { ok: false, platform: 'facebook', error: data.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true, platform: 'facebook', id: data.post_id };
}

async function postToThreads(env, text) {
  const token = env.THREADS_TOKEN;
  if (!token) return { ok: false, platform: 'threads', error: 'THREADS_TOKEN not set' };
  const userId = env.THREADS_USER_ID;
  if (!userId) return { ok: false, platform: 'threads', error: 'THREADS_USER_ID not set' };

  // Step 1: create media container
  const createRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'text',
      text,
      access_token: token,
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok || created.error) {
    return { ok: false, platform: 'threads', error: created.error?.message || `HTTP ${createRes.status}` };
  }

  // Step 2: publish
  const pubRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      creation_id: created.id,
      access_token: token,
    }),
  });
  const published = await pubRes.json();
  if (!pubRes.ok || published.error) {
    return { ok: false, platform: 'threads', error: published.error?.message || `HTTP ${pubRes.status}` };
  }
  return { ok: true, platform: 'threads', id: published.id };
}

async function postToTikTok(env, text) {
  const token = env.TIKTOK_TOKEN;
  if (!token) return { ok: false, platform: 'tiktok', error: 'TIKTOK_TOKEN not set' };

  // TikTok Content Posting API — text-only posts are NOT supported.
  // Requires a video file. We skip TikTok for text posts and note it.
  // To enable TikTok: generate a video (e.g. image slideshow of top singers)
  // and upload via /v2/post/publish/video/init/ then /upload.
  return { ok: false, platform: 'tiktok', error: 'TikTok requires video content — text-only posts unsupported. Video pipeline not yet enabled.' };
}

const adapters = { facebook: postToFacebook, threads: postToThreads, tiktok: postToTikTok };

async function broadcast(env, text) {
  const results = await Promise.all(
    Object.entries(adapters).map(([name, fn]) =>
      fn(env, text).catch(err => ({ ok: false, platform: name, error: err.message }))
    )
  );
  return results;
}

// ─── Cron jobs ────────────────────────────────────────────────────────────

// Weekly leaderboard — every Monday 12:00 UTC (20:00 MYT)
async function weeklyLeaderboard(env) {
  const { results } = await env.DB.prepare(
    `SELECT name, votes FROM singers WHERE votes > 0 ORDER BY votes DESC LIMIT 5`
  ).all();
  if (!results || results.length === 0) {
    return { skipped: true, reason: 'no votes yet' };
  }
  const text = formatLeaderboardPost(results);
  const results2 = await broadcast(env, text);
  return { posted: text, results: results2 };
}

// Big-vote highlight — runs every 15 minutes, posts when a single payment
// of BIG_VOTE_THRESHOLD votes or more is approved since last check.
const BIG_VOTE_THRESHOLD = 50;

async function bigVoteHighlight(env) {
  // Find approved payments above threshold from the last 20 minutes
  // (overlap window guards against cron jitter)
  const { results } = await env.DB.prepare(
    `SELECT p.votes, p.voter_name, s.name AS singer_name
     FROM payments p JOIN singers s ON s.id = p.singer_id
     WHERE p.status = 'approved' AND p.votes >= ? AND p.created_at >= datetime('now', '-20 minutes')`
  ).bind(BIG_VOTE_THRESHOLD).all();

  if (!results || results.length === 0) return { skipped: true };

  // Post only the biggest one to avoid spam
  const biggest = results.sort((a, b) => b.votes - a.votes)[0];
  const text = formatBigVotePost(biggest);
  const broadcastResults = await broadcast(env, text);
  return { posted: text, results: broadcastResults };
}

// ─── Scheduled handler (called by cron) ───────────────────────────────────

export async function handleScheduled(event, env, ctx) {
  const cron = event.cron;
  const log = { cron, at: new Date().toISOString() };

  try {
    if (cron === '0 12 * * 1') {
      // Weekly leaderboard — Monday 12:00 UTC
      log.action = await weeklyLeaderboard(env);
    } else if (cron === '*/15 * * * *') {
      // Big-vote highlight — every 15 min
      log.action = await bigVoteHighlight(env);
    } else {
      log.skipped = true;
      log.reason = `no handler for cron "${cron}"`;
    }
  } catch (err) {
    log.error = err.message;
  }

  console.log(JSON.stringify(log));
}

// ─── Manual trigger (admin API) ───────────────────────────────────────────
// GET /api/admin/social/post-leaderboard?key=ADMIN_PASSWORD
// GET /api/admin/social/post-bigvote?key=ADMIN_PASSWORD

export async function adminPostLeaderboard(env) {
  return weeklyLeaderboard(env);
}

export async function adminPostBigVote(env) {
  // Manual trigger posts the biggest approved payment in the last 24h
  const { results } = await env.DB.prepare(
    `SELECT p.votes, p.voter_name, s.name AS singer_name
     FROM payments p JOIN singers s ON s.id = p.singer_id
     WHERE p.status = 'approved' AND p.votes >= ?
     ORDER BY p.votes DESC LIMIT 1`
  ).bind(BIG_VOTE_THRESHOLD).all();
  if (!results || results.length === 0) return { skipped: true, reason: 'no big votes in last 24h' };
  const text = formatBigVotePost(results[0]);
  return { posted: text, results: await broadcast(env, text) };
}
