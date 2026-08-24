var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/db.js
var db_exports = {};
__export(db_exports, {
  addVotes: () => addVotes,
  completePayment: () => completePayment,
  createAnimation: () => createAnimation,
  createBattle: () => createBattle,
  createPayment: () => createPayment,
  createSinger: () => createSinger,
  getAnimationById: () => getAnimationById,
  getBattle: () => getBattle,
  getCountries: () => getCountries,
  getDonationsBySinger: () => getDonationsBySinger,
  getPaymentById: () => getPaymentById,
  getPaymentByReference: () => getPaymentByReference,
  getRecentVotes: () => getRecentVotes,
  getSingerById: () => getSingerById,
  getSingerByName: () => getSingerByName,
  getSingers: () => getSingers,
  getSingersByCountry: () => getSingersByCountry,
  listAllBattles: () => listAllBattles,
  listAnimations: () => listAnimations,
  listBattlesByEvent: () => listBattlesByEvent,
  listPayments: () => listPayments,
  rejectPayment: () => rejectPayment,
  updateAnimationStatus: () => updateAnimationStatus,
  updatePaymentReference: () => updatePaymentReference,
  voteBattle: () => voteBattle
});
async function getSingers(env, { search = "", limit = null, offset = 0 } = {}) {
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
async function getSingerById(env, id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1)
    return null;
  return await env.DB.prepare(`SELECT * FROM singers WHERE id = ?`).bind(n).first();
}
async function getSingerByName(env, name) {
  return await env.DB.prepare(`SELECT * FROM singers WHERE LOWER(name) = LOWER(?)`).bind(name).first();
}
async function getCountries(env) {
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
async function getSingersByCountry(env, country) {
  const { results } = await env.DB.prepare(`
    SELECT *, RANK() OVER (ORDER BY votes DESC, name ASC) AS country_rank
    FROM singers
    WHERE LOWER(country) = LOWER(?)
    ORDER BY votes DESC, name ASC
  `).bind(String(country).slice(0, 80)).all();
  return results;
}
async function createSinger(env, name, country, genre, imageUrl = "") {
  const info = await env.DB.prepare(`
    INSERT INTO singers (name, country, genre, image_url, votes, revenue_cents)
    VALUES (?, ?, ?, ?, 0, 0)
  `).bind(name, country || "Global", genre || "Music", imageUrl || "").run();
  return await getSingerById(env, info.meta.last_row_id);
}
async function addVotes(env, singerId, count, amountCents) {
  const n = parseInt(singerId, 10);
  if (isNaN(n) || n < 1)
    return;
  await env.DB.prepare(`UPDATE singers SET votes = votes + ?, revenue_cents = revenue_cents + ? WHERE id = ?`).bind(parseInt(count, 10) || 0, parseInt(amountCents, 10) || 0, n).run();
}
async function createPayment(env, p) {
  const info = await env.DB.prepare(`
    INSERT INTO payments (singer_id, voter_name, voter_message, method, vote_count, amount_cents, currency, reference, receipt_image, status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).bind(
    p.singer_id,
    p.voter_name || "Anonymous",
    p.voter_message || "",
    p.method,
    p.vote_count,
    p.amount_cents,
    p.currency || "USD",
    p.reference || null,
    p.receipt_image || null,
    p.status || "pending"
  ).run();
  return info.meta.last_row_id;
}
async function getPaymentById(env, id) {
  return await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first();
}
async function getPaymentByReference(env, ref) {
  return await env.DB.prepare(`SELECT * FROM payments WHERE reference = ?`).bind(ref).first();
}
async function completePayment(env, id) {
  const p = await getPaymentById(env, id);
  if (!p || p.status === "completed")
    return p;
  await env.DB.prepare(`UPDATE payments SET status = 'completed' WHERE id = ?`).bind(id).run();
  await addVotes(env, p.singer_id, p.vote_count, p.amount_cents);
  return await getPaymentById(env, id);
}
async function listPayments(env, status) {
  if (status) {
    const { results: results2 } = await env.DB.prepare(`SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC LIMIT 200`).bind(status).all();
    return results2;
  }
  const { results } = await env.DB.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT 200`).all();
  return results;
}
async function updatePaymentReference(env, id, reference) {
  await env.DB.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).bind(reference, id).run();
}
async function rejectPayment(env, id) {
  await env.DB.prepare(`UPDATE payments SET status = 'rejected' WHERE id = ?`).bind(id).run();
}
async function getBattle(env, eventId, aId, bId) {
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]];
  return await env.DB.prepare(`SELECT * FROM battles WHERE event_id = ? AND singer_a = ? AND singer_b = ?`).bind(String(eventId).slice(0, 60), lo, hi).first();
}
async function createBattle(env, eventId, aId, bId) {
  const [lo, hi] = [+aId < +bId ? [+aId, +bId] : [+bId, +aId]];
  await env.DB.prepare(`INSERT OR IGNORE INTO battles (event_id, singer_a, singer_b) VALUES (?, ?, ?)`).bind(String(eventId).slice(0, 60), lo, hi).run();
  return await getBattle(env, eventId, lo, hi);
}
async function voteBattle(env, eventId, aId, bId, side, count) {
  let b = await getBattle(env, eventId, aId, bId) || await createBattle(env, eventId, aId, bId);
  if (!b)
    return null;
  const n = Math.max(1, Math.min(1e3, parseInt(count, 10) || 1));
  const col = +side === b.singer_a ? "votes_a" : "votes_b";
  await env.DB.prepare(`UPDATE battles SET ${col} = ${col} + ? WHERE id = ?`).bind(n, b.id).run();
  return await getBattle(env, eventId, aId, bId);
}
async function listBattlesByEvent(env, eventId) {
  const { results } = await env.DB.prepare(`SELECT * FROM battles WHERE event_id = ? ORDER BY created_at DESC`).bind(String(eventId).slice(0, 60)).all();
  return results;
}
async function listAllBattles(env) {
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
async function createAnimation(env, { singer_id = null, motion = "nod", source_url = "" }) {
  const info = await env.DB.prepare(`
    INSERT INTO animations (singer_id, motion, status, source_url)
    VALUES (?, ?, 'pending', ?)
  `).bind(singer_id, String(motion).slice(0, 20), String(source_url || "").slice(0, 500)).run();
  return await getAnimationById(env, info.meta.last_row_id);
}
async function getAnimationById(env, id) {
  const n = parseInt(id, 10);
  if (isNaN(n) || n < 1)
    return null;
  return await env.DB.prepare(`SELECT * FROM animations WHERE id = ?`).bind(n).first();
}
async function updateAnimationStatus(env, id, { status, file_url, thumb_url, error, duration_ms, frames }) {
  const sets = [];
  const params = [];
  if (status !== void 0) {
    sets.push("status = ?");
    params.push(String(status));
  }
  if (file_url !== void 0) {
    sets.push("file_url = ?");
    params.push(String(file_url));
  }
  if (thumb_url !== void 0) {
    sets.push("thumb_url = ?");
    params.push(String(thumb_url));
  }
  if (error !== void 0) {
    sets.push("error = ?");
    params.push(String(error).slice(0, 500));
  }
  if (duration_ms !== void 0) {
    sets.push("duration_ms = ?");
    params.push(parseInt(duration_ms, 10) || 0);
  }
  if (frames !== void 0) {
    sets.push("frames = ?");
    params.push(parseInt(frames, 10) || 0);
  }
  if (!sets.length)
    return await getAnimationById(env, id);
  params.push(parseInt(id, 10));
  await env.DB.prepare(`UPDATE animations SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  return await getAnimationById(env, id);
}
async function listAnimations(env, { singer_id = null, limit = 50 } = {}) {
  let sql = `SELECT * FROM animations`;
  const params = [];
  if (singer_id) {
    sql += ` WHERE singer_id = ?`;
    params.push(parseInt(singer_id, 10));
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 50)));
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results;
}
async function getDonationsBySinger(env, id) {
  const { results } = await env.DB.prepare(`
    SELECT voter_name, voter_message, vote_count, amount_cents, method, created_at
    FROM payments
    WHERE singer_id = ? AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT 100
  `).bind(id).all();
  return results;
}
async function getRecentVotes(env) {
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
var init_db = __esm({
  "src/lib/db.js"() {
    __name(getSingers, "getSingers");
    __name(getSingerById, "getSingerById");
    __name(getSingerByName, "getSingerByName");
    __name(getCountries, "getCountries");
    __name(getSingersByCountry, "getSingersByCountry");
    __name(createSinger, "createSinger");
    __name(addVotes, "addVotes");
    __name(createPayment, "createPayment");
    __name(getPaymentById, "getPaymentById");
    __name(getPaymentByReference, "getPaymentByReference");
    __name(completePayment, "completePayment");
    __name(listPayments, "listPayments");
    __name(updatePaymentReference, "updatePaymentReference");
    __name(rejectPayment, "rejectPayment");
    __name(getBattle, "getBattle");
    __name(createBattle, "createBattle");
    __name(voteBattle, "voteBattle");
    __name(listBattlesByEvent, "listBattlesByEvent");
    __name(listAllBattles, "listAllBattles");
    __name(createAnimation, "createAnimation");
    __name(getAnimationById, "getAnimationById");
    __name(updateAnimationStatus, "updateAnimationStatus");
    __name(listAnimations, "listAnimations");
    __name(getDonationsBySinger, "getDonationsBySinger");
    __name(getRecentVotes, "getRecentVotes");
  }
});

// src/lib/helpers.js
function sanitizeName(raw) {
  const s = String(raw || "").trim().slice(0, MAX_NAME);
  return s.replace(/[<>]/g, "");
}
function validateName(name) {
  if (!name || name.length < 2)
    return false;
  return SANE_NAME_RE.test(name);
}
function sanitizeSearch(raw) {
  let s = String(raw || "").trim().slice(0, MAX_SEARCH);
  return s.replace(/[<>;'`"]/g, "");
}
function validatePaymentBody(body) {
  const singerId = parseInt(body.singerId, 10);
  const votes = parseInt(body.votes, 10);
  const voterName = sanitizeName(body.voterName || "");
  const voterMessage = String(body.voterMessage || "").slice(0, 280).trim();
  if (isNaN(singerId) || singerId < 1)
    return { error: "Invalid singer ID" };
  if (isNaN(votes) || votes < 1 || votes > 1e4)
    return { error: "Invalid vote count (1-10000)" };
  return { singerId, votes, voterName, voterMessage };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}
function getOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
var SANE_NAME_RE, MAX_NAME, MAX_SEARCH;
var init_helpers = __esm({
  "src/lib/helpers.js"() {
    SANE_NAME_RE = /^[\p{L}\p{N}\s,.'&()!+\-–—/:;@#*"«»„”“‘’″‒–—―…\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+$/u;
    MAX_NAME = 120;
    MAX_SEARCH = 80;
    __name(sanitizeName, "sanitizeName");
    __name(validateName, "validateName");
    __name(sanitizeSearch, "sanitizeSearch");
    __name(validatePaymentBody, "validatePaymentBody");
    __name(json, "json");
    __name(errorResponse, "errorResponse");
    __name(getOrigin, "getOrigin");
  }
});

// src/payments/stripe.js
var stripe_exports = {};
__export(stripe_exports, {
  createStripeSession: () => createStripeSession,
  stripeWebhook: () => stripeWebhook,
  verifyAndComplete: () => verifyAndComplete
});
async function createStripeSession(env, { singerId, votes, voterName, voterMessage, request, battle }) {
  const singer = await getSingerById(env, singerId);
  if (!singer)
    throw new Error("Singer not found");
  const amountCents = votes * 100;
  const paymentId = await createPayment(env, {
    singer_id: singerId,
    voter_name: voterName || "Anonymous",
    voter_message: voterMessage || "",
    method: "stripe",
    vote_count: votes,
    amount_cents: amountCents,
    currency: env.CURRENCY || "usd",
    status: "pending"
  });
  const meta = { paymentId: String(paymentId), singerId: String(singerId), votes: String(votes) };
  if (battle && battle.eventId) {
    meta.battleEvent = String(battle.eventId);
    meta.battleA = String(battle.aId);
    meta.battleB = String(battle.bId);
  }
  const origin = getOrigin(request);
  const body = {
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: env.CURRENCY || "usd",
        product_data: {
          name: `${votes} vote${votes > 1 ? "s" : ""} for ${singer.name}`,
          description: battle?.eventId ? `Battle ${battle.eventId} \u2014 support ${singer.name}` : `Best Artist Voting \u2014 support ${singer.name}`
        },
        unit_amount: 100
      },
      quantity: votes
    }],
    mode: "payment",
    success_url: battle?.eventId ? `${origin}/battle?event=${encodeURIComponent(battle.eventId)}&a=${battle.aId}&b=${battle.bId}&paid=1` : `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    metadata: meta
  };
  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(flattenParams(body)).toString()
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe error: ${err}`);
  }
  const session = await resp.json();
  await updatePaymentReference(env, paymentId, session.id);
  return session;
}
function flattenParams(obj, prefix = "") {
  const pairs = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      pairs.push(...flattenParams(val, fullKey));
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v !== null && typeof v === "object") {
          pairs.push(...flattenParams(v, `${fullKey}[${i}]`));
        } else {
          pairs.push([`${fullKey}[${i}]`, String(v)]);
        }
      });
    } else if (val !== null && val !== void 0) {
      pairs.push([fullKey, String(val)]);
    }
  }
  return pairs;
}
async function stripeWebhook(env, request) {
  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature") || "";
  const secret = env.STRIPE_WEBHOOK_SECRET || "";
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResponse("Bad payload", 400);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object;
    if (!session)
      return json({ received: true });
    const paymentId = session.metadata?.paymentId;
    if (paymentId)
      await completePayment(env, parseInt(paymentId));
    const bEvent = session.metadata?.battleEvent;
    if (bEvent) {
      try {
        await voteBattle(
          env,
          session.metadata.battleEvent,
          parseInt(session.metadata.battleA),
          parseInt(session.metadata.battleB),
          parseInt(session.metadata.singerId),
          parseInt(session.metadata.votes, 10) || 1
        );
      } catch (e) {
      }
    }
  }
  return json({ received: true });
}
async function verifyAndComplete(env, sessionId) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  if (!resp.ok)
    return null;
  const session = await resp.json();
  if (session.payment_status === "paid") {
    const payment = await getPaymentByReference2(env, session.id);
    if (payment)
      await completePayment(env, payment.id);
  }
  return session;
}
async function getPaymentByReference2(env, ref) {
  const { getPaymentByReference: gpr } = await Promise.resolve().then(() => (init_db(), db_exports));
  return gpr(env, ref);
}
var init_stripe = __esm({
  "src/payments/stripe.js"() {
    init_db();
    init_helpers();
    __name(createStripeSession, "createStripeSession");
    __name(flattenParams, "flattenParams");
    __name(stripeWebhook, "stripeWebhook");
    __name(verifyAndComplete, "verifyAndComplete");
    __name(getPaymentByReference2, "getPaymentByReference");
  }
});

// src/worker.js
init_stripe();

// src/routes/api.js
init_db();
init_helpers();
init_stripe();
async function apiSingers(env, request, params, query) {
  let search = sanitizeSearch(query.search || "");
  const limit = query.limit ? Math.min(300, Math.max(1, parseInt(query.limit, 10) || 10)) : null;
  const offset = query.offset ? Math.max(0, parseInt(query.offset, 10) || 0) : 0;
  const singers = await getSingers(env, { search, limit, offset });
  return json(singers);
}
__name(apiSingers, "apiSingers");
async function apiSingerById(env, request, params) {
  const s = await getSingerById(env, params.id);
  if (!s)
    return errorResponse("Not found", 404);
  return json(s);
}
__name(apiSingerById, "apiSingerById");
async function apiSingerLookup(env, request) {
  const body = await request.json();
  const raw = String(body.name || "").trim();
  const name = sanitizeName(raw);
  let country = sanitizeName(body.country || "");
  let genre = sanitizeName(body.genre || "");
  let imageUrl = body.imageUrl || "";
  if (!validateName(name)) {
    return errorResponse("Invalid artist name. Use letters, numbers, and common punctuation only.", 400);
  }
  let singer = await getSingerByName(env, name);
  const created = !singer;
  if (!singer) {
    try {
      const variations = [
        name,
        name.split("/")[0].trim(),
        name.replace(/\([^)]*\)/g, "").trim(),
        name + " (musician)",
        name + " (band)",
        name + " (singer)",
        name + " (penyanyi)"
      ];
      const langs = ["en", "ms", "id"];
      for (const lang of langs) {
        if (imageUrl)
          break;
        for (const v of variations) {
          try {
            const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(v)}`, {
              headers: { "User-Agent": "BestArtistVoting/2.0 (contact@sentinelai.studio)" }
            });
            if (res.ok) {
              const d = await res.json();
              if (d.thumbnail?.source && !imageUrl)
                imageUrl = d.thumbnail.source;
              if (d.description && !genre)
                genre = d.description.slice(0, 40);
              if (imageUrl)
                break;
            }
          } catch (e) {
          }
        }
      }
    } catch (e) {
      console.error("Wikipedia lookup error:", e);
    }
    singer = await createSinger(env, name, country || "Global", genre || "Music", imageUrl);
  }
  return json({ singer, created });
}
__name(apiSingerLookup, "apiSingerLookup");
async function apiSingerDonations(env, request, params) {
  const id = parseInt(params.id, 10);
  if (isNaN(id) || id < 1)
    return errorResponse("Invalid artist ID", 400);
  const rows = await getDonationsBySinger(env, id);
  return json(rows);
}
__name(apiSingerDonations, "apiSingerDonations");
async function apiCountries(env) {
  return json(await getCountries(env));
}
__name(apiCountries, "apiCountries");
async function apiCountriesByName(env, request, params) {
  const name = sanitizeName(decodeURIComponent(params.name)).slice(0, 80);
  if (!name)
    return errorResponse("Invalid country", 400);
  return json(await getSingersByCountry(env, name));
}
__name(apiCountriesByName, "apiCountriesByName");
async function apiGetBattle(env, request, params, query) {
  const eventId = sanitizeName(String(query.event || "")).slice(0, 60);
  const aId = parseInt(query.a, 10);
  const bId = parseInt(query.b, 10);
  if (!eventId)
    return errorResponse("Missing event id", 400);
  if (isNaN(aId) || isNaN(bId))
    return errorResponse("Missing artist ids", 400);
  let battle = await getBattle(env, eventId, aId, bId) || await createBattle(env, eventId, aId, bId);
  const a = await getSingerById(env, aId);
  const b = await getSingerById(env, bId);
  if (!a || !b)
    return errorResponse("Artist not found", 404);
  const votesForA = +aId === battle.singer_a ? battle.votes_a : battle.votes_b;
  const votesForB = +bId === battle.singer_b ? battle.votes_b : battle.votes_a;
  return json({ eventId, battleId: battle.id, a, b, votesA: votesForA, votesB: votesForB });
}
__name(apiGetBattle, "apiGetBattle");
async function apiBattleVote(env, request) {
  const body = await request.json();
  const eventId = sanitizeName(String(body.event || "")).slice(0, 60);
  const aId = parseInt(body.a, 10);
  const bId = parseInt(body.b, 10);
  const side = parseInt(body.side, 10);
  if (!eventId || isNaN(aId) || isNaN(bId) || isNaN(side)) {
    return errorResponse("Missing battle params", 400);
  }
  if (side !== aId && side !== bId)
    return errorResponse("Invalid side", 400);
  const v = validatePaymentBody({ singerId: side, votes: body.count, voterName: body.voterName });
  if (v.error)
    return errorResponse(v.error, 400);
  const session = await createStripeSession(env, {
    singerId: v.singerId,
    votes: v.votes,
    voterName: v.voterName,
    request,
    battle: { eventId, aId, bId }
  });
  return json({ url: session.url });
}
__name(apiBattleVote, "apiBattleVote");
async function apiCompetitions(env) {
  return json(await listAllBattles(env));
}
__name(apiCompetitions, "apiCompetitions");
async function apiPaymentMethods(env) {
  return json({
    stripe: !!env.STRIPE_SECRET_KEY,
    paypal: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    toyyibpay: !!env.TOYYIBPAY_SECRET_KEY,
    crypto: !!env.CRYPTO_WALLET,
    manual: true
  });
}
__name(apiPaymentMethods, "apiPaymentMethods");
async function apiPayStripe(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error)
    return errorResponse(v.error, 400);
  const session = await createStripeSession(env, {
    singerId: v.singerId,
    votes: v.votes,
    voterName: v.voterName,
    voterMessage: v.voterMessage,
    request
  });
  return json({ url: session.url });
}
__name(apiPayStripe, "apiPayStripe");
async function apiPayPaypalOrder(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error)
    return errorResponse(v.error, 400);
  const order = await createPaypalOrder(env, { singerId: v.singerId, votes: v.votes, voterName: v.voterName });
  return json(order);
}
__name(apiPayPaypalOrder, "apiPayPaypalOrder");
async function apiPayPaypalCapture(env, request) {
  const body = await request.json();
  const { orderId } = body;
  if (!orderId || typeof orderId !== "string" || orderId.length > 200)
    return errorResponse("Invalid order ID", 400);
  const result = await capturePaypalOrder(env, orderId);
  return json(result);
}
__name(apiPayPaypalCapture, "apiPayPaypalCapture");
async function apiPayToyyibpay(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error)
    return errorResponse(v.error, 400);
  const billUrl = await createToyyibpayBill(env, { singerId: v.singerId, votes: v.votes, voterName: v.voterName, request });
  return json({ url: billUrl });
}
__name(apiPayToyyibpay, "apiPayToyyibpay");
async function apiPayManual(env, request) {
  const formData = await request.formData();
  const singerId = parseInt(formData.get("singerId"), 10);
  const votes = parseInt(formData.get("votes"), 10);
  const voterName = sanitizeName(formData.get("voterName") || "");
  const voterMessage = String(formData.get("voterMessage") || "").slice(0, 280).trim();
  const reference = sanitizeName(formData.get("reference") || "");
  if (isNaN(singerId) || singerId < 1)
    return errorResponse("Invalid singer ID", 400);
  if (isNaN(votes) || votes < 1 || votes > 1e4)
    return errorResponse("Invalid vote count (1-10000)", 400);
  let receiptPath = null;
  const receipt = formData.get("receipt");
  if (receipt && receipt.size > 0 && receipt.size < 5 * 1024 * 1024) {
    if (env.BUCKET) {
      const ext = (receipt.name || ".jpg").match(/\.(\w+)$/)?.[1] || "jpg";
      const key = `receipts/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      await env.BUCKET.put(key, receipt.stream(), {
        customMetadata: { contentType: receipt.type || "image/jpeg" }
      });
      receiptPath = `/uploads/${key}`;
    } else {
      receiptPath = "receipt-uploaded";
    }
  }
  const id = await createPayment(env, {
    singer_id: singerId,
    voter_name: voterName || "Anonymous",
    voter_message: voterMessage,
    method: "manual",
    vote_count: votes,
    amount_cents: votes * 100,
    currency: "USD",
    reference: reference || null,
    receipt_image: receiptPath,
    status: "pending"
  });
  return json({ ok: true, paymentId: id, message: "Receipt submitted! Votes will be added after admin approval." });
}
__name(apiPayManual, "apiPayManual");
async function apiCryptoConfig(env) {
  return json({
    wallet: env.CRYPTO_WALLET || null,
    currency: env.CRYPTO_CURRENCY || "USDT (TRC20)",
    network: env.CRYPTO_NETWORK || "TRON"
  });
}
__name(apiCryptoConfig, "apiCryptoConfig");
async function apiPayCrypto(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error)
    return errorResponse(v.error, 400);
  const id = await createPayment(env, {
    singer_id: v.singerId,
    voter_name: v.voterName || "Anonymous",
    voter_message: v.voterMessage || "",
    method: "crypto",
    vote_count: v.votes,
    amount_cents: v.votes * 100,
    currency: env.CRYPTO_CURRENCY || "USDT",
    reference: `crypto-${Date.now()}`,
    status: "pending"
  });
  await completePayment(env, id);
  return json({ ok: true, paymentId: id, message: "Crypto payment confirmed! Votes added." });
}
__name(apiPayCrypto, "apiPayCrypto");
async function apiToyyibpayCallback(env, request, params, query) {
  const { ref, status } = query;
  const payment = await getPaymentByReference(env, ref);
  if (payment && status === "1")
    await completePayment(env, payment.id);
  return Response.redirect(`${getOrigin(request)}/thank-you.html?ref=${ref || ""}`, 302);
}
__name(apiToyyibpayCallback, "apiToyyibpayCallback");
async function paymentSuccess(env, request, params, query) {
  const { session_id } = query;
  if (session_id) {
    try {
      const stripe = await Promise.resolve().then(() => (init_stripe(), stripe_exports));
      await stripe.verifyAndComplete(env, session_id);
    } catch {
    }
  }
  return Response.redirect(`${getOrigin(request)}/thank-you.html?ref=${session_id || ""}`, 302);
}
__name(paymentSuccess, "paymentSuccess");
async function apiYoutubeSearch(env, request, params, query) {
  const q = String(query.q || "").slice(0, 80);
  if (!q)
    return errorResponse("missing q", 400);
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q + " songs")}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept-Language": "en-US,en" } });
    const html = await r.text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    return json({ videoId: m ? m[1] : null });
  } catch {
    return json({ videoId: null });
  }
}
__name(apiYoutubeSearch, "apiYoutubeSearch");
async function apiProxyImage(env, request, params, query) {
  const url = String(query.url || "");
  if (!/^https?:\/\//.test(url))
    return new Response(null, { status: 400 });
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    if (!r.ok)
      return new Response(null, { status: r.status });
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
__name(apiProxyImage, "apiProxyImage");
async function apiWikiBio(env, request, params, query) {
  const name = String(query.q || "").slice(0, 100);
  if (!name)
    return errorResponse("missing q", 400);
  try {
    const encoded = encodeURIComponent(name);
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&srlimit=1&origin=*`;
    const sr = await fetch(searchUrl, { headers: { "User-Agent": "BestArtistVoting/2.0" } });
    if (!sr.ok)
      return json({ bio: null });
    const searchData = await sr.json();
    const page = searchData?.query?.search?.[0];
    if (!page)
      return json({ bio: null });
    const pageTitle = encodeURIComponent(page.title);
    const exUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${pageTitle}&prop=extracts&exintro=1&explaintext=1&exsentences=3&format=json&origin=*`;
    const er = await fetch(exUrl, { headers: { "User-Agent": "BestArtistVoting/2.0" } });
    if (!er.ok)
      return json({ bio: null });
    const exData = await er.json();
    const pages = exData?.query?.pages;
    if (!pages)
      return json({ bio: null });
    for (const key of Object.keys(pages)) {
      const extract = pages[key]?.extract;
      if (extract && extract.length > 30)
        return json({ bio: extract, title: pages[key].title });
    }
    return json({ bio: null });
  } catch {
    return json({ bio: null });
  }
}
__name(apiWikiBio, "apiWikiBio");
async function apiRecentVotes(env) {
  try {
    return json(await getRecentVotes(env));
  } catch {
    return json([]);
  }
}
__name(apiRecentVotes, "apiRecentVotes");
var MOTIONS = { nod: true, wave: true, dance: true };
async function apiCreateAnimation(env, request) {
  const formData = await request.formData();
  const motion = String(formData.get("motion") || "nod").toLowerCase();
  if (!MOTIONS[motion])
    return errorResponse(`Invalid motion. Use: ${Object.keys(MOTIONS).join(", ")}`, 400);
  const singerId = formData.get("singerId") ? parseInt(formData.get("singerId"), 10) : null;
  let sourceUrl = "";
  const imageFile = formData.get("image");
  if (imageFile && imageFile.size > 0) {
    if (env.BUCKET) {
      const ext = (imageFile.name || ".jpg").match(/\.(\w+)$/)?.[1] || "jpg";
      const key = `anim-sources/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      await env.BUCKET.put(key, imageFile.stream(), {
        customMetadata: { contentType: imageFile.type || "image/jpeg" }
      });
      sourceUrl = `/uploads/${key}`;
    } else {
      sourceUrl = "/placeholder.jpg";
    }
  } else if (singerId) {
    const singer = await getSingerById(env, singerId);
    if (!singer)
      return errorResponse("Artist not found", 404);
    if (!singer.image_url)
      return errorResponse("Artist has no photo. Upload one or set image_url first.", 400);
    sourceUrl = singer.image_url;
  } else {
    return errorResponse("Provide either an image file or a singerId", 400);
  }
  const anim = await createAnimation(env, { singer_id: singerId, motion, source_url: sourceUrl.slice(0, 500) });
  await updateAnimationStatus(env, anim.id, {
    status: "failed",
    error: "Animation generation is not supported on Cloudflare Workers. Use a separate compute service."
  });
  return json({ success: true, id: anim.id, status: "failed", poll: `/api/animations/${anim.id}` });
}
__name(apiCreateAnimation, "apiCreateAnimation");
async function apiGetAnimation(env, request, params) {
  const anim = await getAnimationById(env, params.id);
  if (!anim)
    return errorResponse("Not found", 404);
  return json(anim);
}
__name(apiGetAnimation, "apiGetAnimation");
async function apiListAnimations(env, request, params, query) {
  return json(await listAnimations(env, { singer_id: query.singerId || null, limit: query.limit }));
}
__name(apiListAnimations, "apiListAnimations");
async function adminPayments(env, request, params, query) {
  return json(await listPayments(env, query.status));
}
__name(adminPayments, "adminPayments");
async function adminApprovePayment(env, request, params) {
  const p = await completePayment(env, parseInt(params.id));
  if (!p)
    return errorResponse("Not found", 404);
  return json(p);
}
__name(adminApprovePayment, "adminApprovePayment");
async function adminRejectPayment(env, request, params) {
  const { rejectPayment: rejectPayment2 } = await Promise.resolve().then(() => (init_db(), db_exports));
  await rejectPayment2(env, parseInt(params.id));
  return json({ ok: true });
}
__name(adminRejectPayment, "adminRejectPayment");
async function adminAddSinger(env, request) {
  const body = await request.json();
  const { name, country, genre, bio, image_url } = body;
  const { createSinger: cs } = await Promise.resolve().then(() => (init_db(), db_exports));
  const singer = await cs(env, name, country || "Global", genre || "Music", image_url || "");
  if (bio) {
    await env.DB.prepare(`UPDATE singers SET bio = ? WHERE id = ?`).bind(bio, singer.id).run();
  }
  return json(await getSingerById(env, singer.id));
}
__name(adminAddSinger, "adminAddSinger");
async function adminDeleteSinger(env, request, params) {
  await env.DB.prepare(`DELETE FROM singers WHERE id = ?`).bind(parseInt(params.id)).run();
  return json({ ok: true });
}
__name(adminDeleteSinger, "adminDeleteSinger");
async function createPaypalOrder(env, { singerId, votes, voterName }) {
  const singer = await getSingerById(env, singerId);
  if (!singer)
    throw new Error("Singer not found");
  const amount = votes.toFixed(2);
  const origin = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const token = await getPaypalToken(env);
  const resp = await fetch(`${origin}/v2/checkout/orders`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: (env.CURRENCY || "usd").toUpperCase(), value: amount },
        description: `${votes} votes for ${singer.name}`
      }]
    })
  });
  return await resp.json();
}
__name(createPaypalOrder, "createPaypalOrder");
async function capturePaypalOrder(env, orderId) {
  const origin = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const token = await getPaypalToken(env);
  const resp = await fetch(`${origin}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
  const data = await resp.json();
  if (data.status === "COMPLETED") {
    const payment = await getPaymentByReference(env, orderId);
    if (payment)
      await completePayment(env, payment.id);
  }
  return data;
}
__name(capturePaypalOrder, "capturePaypalOrder");
async function getPaypalToken(env) {
  const origin = env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const resp = await fetch(`${origin}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await resp.json();
  return data.access_token;
}
__name(getPaypalToken, "getPaypalToken");
async function createToyyibpayBill(env, { singerId, votes, voterName, request }) {
  const singer = await getSingerById(env, singerId);
  if (!singer)
    throw new Error("Singer not found");
  const origin = getOrigin(request);
  const resp = await fetch("https://toyyibpay.com/index.php/api/createBill", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      userSecretKey: env.TOYYIBPAY_SECRET_KEY,
      categoryCode: env.TOYYIBPAY_CATEGORY_CODE || "",
      billTitle: `Votes for ${singer.name}`,
      billDescription: `${votes} votes`,
      billAmount: String(votes * 100),
      // in cents
      billPhone: "0000000000",
      billEmail: "noreply@bestartist voting.com",
      billName: voterName || "Anonymous",
      billReturnUrl: `${origin}/api/callback/toyyibpay`,
      billCallbackUrl: `${origin}/api/callback/toyyibpay`
    })
  });
  const data = await resp.json();
  return `https://toyyibpay.com/${data[0]?.BillCode || ""}`;
}
__name(createToyyibpayBill, "createToyyibpayBill");

// src/worker.js
init_helpers();
function checkAdminAuth(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-admin-key");
  return key && key === env.ADMIN_PASSWORD;
}
__name(checkAdminAuth, "checkAdminAuth");
var routes = [
  // Singers
  ["GET", "/api/singers", apiSingers],
  ["GET", "/api/singers/:id", apiSingerById],
  ["POST", "/api/singers/lookup", apiSingerLookup],
  ["GET", "/api/singers/:id/donations", apiSingerDonations],
  // Countries
  ["GET", "/api/countries", apiCountries],
  ["GET", "/api/countries/:name", apiCountriesByName],
  // Battle
  ["GET", "/api/battle", apiGetBattle],
  ["POST", "/api/battle/vote", apiBattleVote],
  // Competitions
  ["GET", "/api/competitions", apiCompetitions],
  // Payment methods
  ["GET", "/api/payment-methods", apiPaymentMethods],
  // Payments
  ["POST", "/api/pay/stripe", apiPayStripe],
  ["POST", "/api/pay/paypal/order", apiPayPaypalOrder],
  ["POST", "/api/pay/paypal/capture", apiPayPaypalCapture],
  ["POST", "/api/pay/toyyibpay", apiPayToyyibpay],
  ["POST", "/api/pay/manual", apiPayManual],
  // Crypto
  ["GET", "/api/crypto-config", apiCryptoConfig],
  ["POST", "/api/pay/crypto", apiPayCrypto],
  // Webhooks & callbacks
  ["POST", "/api/webhook/stripe", (env, req) => stripeWebhook(env, req)],
  ["GET", "/api/callback/toyyibpay", apiToyyibpayCallback],
  ["GET", "/payment-success", paymentSuccess],
  // External API proxies
  ["GET", "/api/youtube-search", apiYoutubeSearch],
  ["GET", "/api/proxy-image", apiProxyImage],
  ["GET", "/api/wiki-bio", apiWikiBio],
  // Recent votes
  ["GET", "/api/recent-votes", apiRecentVotes],
  // Animations
  ["POST", "/api/animations", apiCreateAnimation],
  ["GET", "/api/animations/:id", apiGetAnimation],
  ["GET", "/api/animations", apiListAnimations]
];
var adminRoutes = [
  ["GET", "/api/admin/payments", adminPayments],
  ["POST", "/api/admin/payments/:id/approve", adminApprovePayment],
  ["POST", "/api/admin/payments/:id/reject", adminRejectPayment],
  ["POST", "/api/admin/singers", adminAddSinger],
  ["DELETE", "/api/admin/singers/:id", adminDeleteSinger]
];
var compiledRoutes = [...routes, ...adminRoutes].map(([method, pattern, handler]) => {
  const regexPattern = pattern.replace(/:([^/]+)/g, "(?<$1>[^/]+)");
  const regex = new RegExp(`^${regexPattern}$`);
  return { method, pattern, regex, handler };
});
function matchRoute(method, pathname) {
  for (const r of compiledRoutes) {
    if (r.method !== method)
      continue;
    const m = pathname.match(r.regex);
    if (m) {
      if (adminRoutes.some(([, , h]) => h === r.handler)) {
        return { handler: r.handler, params: m.groups, isAdmin: true };
      }
      return { handler: r.handler, params: m.groups, isAdmin: false };
    }
  }
  return null;
}
__name(matchRoute, "matchRoute");
async function serveR2Upload(env, path) {
  const obj = await env.BUCKET.get(path);
  if (!obj)
    return new Response(null, { status: 404 });
  const contentType = obj.customMetadata?.contentType || "application/octet-stream";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400"
    }
  });
}
__name(serveR2Upload, "serveR2Upload");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { method } = request;
    const pathname = url.pathname;
    if (pathname.startsWith("/uploads/")) {
      const key = pathname.replace("/uploads/", "");
      return serveR2Upload(env, key);
    }
    const match = matchRoute(method, pathname);
    if (match) {
      if (match.isAdmin && !checkAdminAuth(request, env)) {
        return errorResponse("Unauthorized", 401);
      }
      try {
        const query = Object.fromEntries(url.searchParams.entries());
        return await match.handler(env, request, match.params || {}, query);
      } catch (err) {
        console.error("Route error:", err);
        return errorResponse(err.message || "Internal server error", 500);
      }
    }
    if (!pathname.includes(".") || pathname.endsWith(".html")) {
      if (pathname === "/battle") {
        return env.ASSETS.fetch(new Request(`${url.origin}/battle.html`, request));
      }
      if (pathname === "/competitions") {
        return env.ASSETS.fetch(new Request(`${url.origin}/competitions.html`, request));
      }
      if (pathname.startsWith("/country/")) {
        return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
      }
      if (pathname === "/" || pathname === "/index.html") {
        return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
      }
      return env.ASSETS.fetch(request);
    }
    try {
      return env.ASSETS.fetch(request);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
