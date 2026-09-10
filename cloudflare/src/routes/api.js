// ═════════════════════════════════════════════════════════════════════════
// api.js — All API route handlers for the Worker
// Each function receives (env, request, params, query) and returns a Response
// ═════════════════════════════════════════════════════════════════════════

import {
  getSingers, getSingerById, getSingerByName, createSinger, addVotes,
  getCountries, getSingersByCountry,
  getBattle, createBattle, listAllBattles,
  createPayment, getPaymentById, getPaymentByReference, completePayment, listPayments,
  createAnimation, getAnimationById, updateAnimationStatus, listAnimations,
  getDonationsBySinger, getRecentVotes,
} from '../lib/db.js';
import {
  sanitizeName, validateName, sanitizeSearch, validatePaymentBody, MIN_VOTES,
  json, errorResponse, getOrigin,
} from '../lib/helpers.js';
import { createStripeSession, verifyAndComplete } from '../payments/stripe.js';

// ─── Singers ─────────────────────────────────────────────────────────────
export async function apiSingers(env, request, params, query) {
  let search = sanitizeSearch(query.search || '');
  const limit = query.limit ? Math.min(300, Math.max(1, parseInt(query.limit, 10) || 10)) : null;
  const offset = query.offset ? Math.max(0, parseInt(query.offset, 10) || 0) : 0;
  const singers = await getSingers(env, { search, limit, offset });
  return json(singers);
}

export async function apiSingerById(env, request, params) {
  const s = await getSingerById(env, params.id);
  if (!s) return errorResponse('Not found', 404);
  return json(s);
}

export async function apiSingerLookup(env, request) {
  const body = await request.json();
  const raw = String(body.name || '').trim();
  const name = sanitizeName(raw);
  let country = sanitizeName(body.country || '');
  let genre = sanitizeName(body.genre || '');
  let imageUrl = body.imageUrl || '';

  if (!validateName(name)) {
    return errorResponse('Invalid artist name. Use letters, numbers, and common punctuation only.', 400);
  }

  let singer = await getSingerByName(env, name);
  const created = !singer;
  if (!singer) {
    // Dynamic real-time lookup from Wikipedia REST API (multi-lingual: en, ms, id)!
    try {
      const variations = [
        name,
        name.split('/')[0].trim(),
        name.replace(/\([^)]*\)/g, '').trim(),
        name + ' (musician)',
        name + ' (band)',
        name + ' (singer)',
        name + ' (penyanyi)'
      ];
      const langs = ['en', 'ms', 'id'];
      for (const lang of langs) {
        if (imageUrl) break;
        for (const v of variations) {
          try {
            const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(v)}`, {
              headers: { 'User-Agent': 'BestArtistVoting/2.0 (contact@sentinelai.studio)' }
            });
            if (res.ok) {
              const d = await res.json();
              if (d.thumbnail?.source && !imageUrl) imageUrl = d.thumbnail.source;
              if (d.description && !genre) genre = d.description.slice(0, 40);
              if (imageUrl) break;
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error('Wikipedia lookup error:', e);
    }
    singer = await createSinger(env, name, country || 'Global', genre || 'Music', imageUrl);
  }
  return json({ singer, created });
}

export async function apiSingerDonations(env, request, params) {
  const id = parseInt(params.id, 10);
  if (isNaN(id) || id < 1) return errorResponse('Invalid artist ID', 400);
  const rows = await getDonationsBySinger(env, id);
  return json(rows);
}

// ─── Countries ────────────────────────────────────────────────────────────
export async function apiCountries(env) {
  return json(await getCountries(env));
}

export async function apiCountriesByName(env, request, params) {
  const name = sanitizeName(decodeURIComponent(params.name)).slice(0, 80);
  if (!name) return errorResponse('Invalid country', 400);
  return json(await getSingersByCountry(env, name));
}

// ─── Battle ───────────────────────────────────────────────────────────────
export async function apiGetBattle(env, request, params, query) {
  const eventId = sanitizeName(String(query.event || '')).slice(0, 60);
  const aId = parseInt(query.a, 10);
  const bId = parseInt(query.b, 10);
  if (!eventId) return errorResponse('Missing event id', 400);
  if (isNaN(aId) || isNaN(bId)) return errorResponse('Missing artist ids', 400);

  let battle = await getBattle(env, eventId, aId, bId) || await createBattle(env, eventId, aId, bId);
  const a = await getSingerById(env, aId);
  const b = await getSingerById(env, bId);
  if (!a || !b) return errorResponse('Artist not found', 404);

  const votesForA = (+aId === battle.singer_a) ? battle.votes_a : battle.votes_b;
  const votesForB = (+bId === battle.singer_b) ? battle.votes_b : battle.votes_a;
  return json({ eventId, battleId: battle.id, a, b, votesA: votesForA, votesB: votesForB });
}

export async function apiBattleVote(env, request) {
  const body = await request.json();
  const eventId = sanitizeName(String(body.event || '')).slice(0, 60);
  const aId = parseInt(body.a, 10);
  const bId = parseInt(body.b, 10);
  const side = parseInt(body.side, 10);
  if (!eventId || isNaN(aId) || isNaN(bId) || isNaN(side)) {
    return errorResponse('Missing battle params', 400);
  }
  if (side !== aId && side !== bId) return errorResponse('Invalid side', 400);

  const v = validatePaymentBody({ singerId: side, votes: body.count, voterName: body.voterName });
  if (v.error) return errorResponse(v.error, 400);

  const session = await createStripeSession(env, {
    singerId: v.singerId, votes: v.votes, voterName: v.voterName, request,
    battle: { eventId, aId, bId },
  });
  return json({ url: session.url });
}

// ─── Competitions ─────────────────────────────────────────────────────────
export async function apiCompetitions(env) {
  return json(await listAllBattles(env));
}

// ─── Payment Methods ──────────────────────────────────────────────────────
export async function apiPaymentMethods(env) {
  const currency = (env.CURRENCY || 'myr').toLowerCase();
  const unitPrice = (parseInt(env.PRICE_PER_VOTE_CENTS, 10) || 100) / 100;
  return json({
    stripe: !!env.STRIPE_SECRET_KEY,
    stripe_qr: !!env.STRIPE_SECRET_KEY,
    currency: currency,
    currency_symbol: currency === 'myr' ? 'RM ' : '$',
    price_per_vote: unitPrice,
    paypal: false,
    toyyibpay: false,
    crypto: false,
    manual: false,
  });
}

// ─── Payments ─────────────────────────────────────────────────────────────
export async function apiPayStripe(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error) return errorResponse(v.error, 400);
  const session = await createStripeSession(env, {
    singerId: v.singerId,
    votes: v.votes,
    voterName: v.voterName,
    voterMessage: v.voterMessage,
    preferredMethod: body.preferredMethod,
    request,
  });
  return json({ url: session.url, sessionId: session.id });
}

export async function apiPayStatus(env, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return errorResponse('Missing session_id', 400);
  try {
    const session = await verifyAndComplete(env, sessionId);
    if (session && session.payment_status === 'paid') {
      return json({ paid: true, status: 'paid' });
    }
    return json({ paid: false, status: session?.payment_status || 'unpaid' });
  } catch (e) {
    return json({ paid: false, error: e.message });
  }
}

export async function apiPayPaypalOrder(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error) return errorResponse(v.error, 400);
  // PayPal order creation via fetch (no SDK needed)
  const order = await createPaypalOrder(env, { singerId: v.singerId, votes: v.votes, voterName: v.voterName });
  return json(order);
}

export async function apiPayPaypalCapture(env, request) {
  const body = await request.json();
  const { orderId } = body;
  if (!orderId || typeof orderId !== 'string' || orderId.length > 200) return errorResponse('Invalid order ID', 400);
  const result = await capturePaypalOrder(env, orderId);
  return json(result);
}

export async function apiPayToyyibpay(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error) return errorResponse(v.error, 400);
  const billUrl = await createToyyibpayBill(env, { singerId: v.singerId, votes: v.votes, voterName: v.voterName, request });
  return json({ url: billUrl });
}

export async function apiPayManual(env, request) {
  const formData = await request.formData();
  const singerId = parseInt(formData.get('singerId'), 10);
  const votes = parseInt(formData.get('votes'), 10);
  const voterName = sanitizeName(formData.get('voterName') || '');
  const voterMessage = String(formData.get('voterMessage') || '').slice(0, 280).trim();
  const reference = sanitizeName(formData.get('reference') || '');

  if (isNaN(singerId) || singerId < 1) return errorResponse('Invalid singer ID', 400);
  if (isNaN(votes) || votes < MIN_VOTES || votes > 10000) return errorResponse(`Invalid vote count (${MIN_VOTES}-10000)`, 400);

  let receiptPath = null;
  const receipt = formData.get('receipt');
  if (receipt && receipt.size > 0 && receipt.size < 5 * 1024 * 1024) {
    if (env.BUCKET) {
      const ext = (receipt.name || '.jpg').match(/\.(\w+)$/)?.[1] || 'jpg';
      const key = `receipts/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      await env.BUCKET.put(key, receipt.stream(), {
        customMetadata: { contentType: receipt.type || 'image/jpeg' },
      });
      receiptPath = `/uploads/${key}`;
    } else {
      receiptPath = 'receipt-uploaded';
    }
  }

  const id = await createPayment(env, {
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    voter_message: voterMessage,
    method: 'manual',
    vote_count: votes,
    amount_cents: votes * 100,
    currency: 'USD',
    reference: reference || null,
    receipt_image: receiptPath,
    status: 'pending',
  });
  return json({ ok: true, paymentId: id, message: 'Receipt submitted! Votes will be added after admin approval.' });
}

// ─── Crypto ───────────────────────────────────────────────────────────────
export async function apiCryptoConfig(env) {
  return json({
    wallet: env.CRYPTO_WALLET || null,
    currency: env.CRYPTO_CURRENCY || 'USDT (TRC20)',
    network: env.CRYPTO_NETWORK || 'TRON',
  });
}

export async function apiPayCrypto(env, request) {
  const body = await request.json();
  const v = validatePaymentBody(body);
  if (v.error) return errorResponse(v.error, 400);
  const id = await createPayment(env, {
    singer_id: v.singerId,
    voter_name: v.voterName || 'Anonymous',
    voter_message: v.voterMessage || '',
    method: 'crypto',
    vote_count: v.votes,
    amount_cents: v.votes * 100,
    currency: env.CRYPTO_CURRENCY || 'USDT',
    reference: `crypto-${Date.now()}`,
    status: 'pending',
  });
  // SECURITY: crypto payments stay PENDING until the admin verifies the
  // on-chain transaction. Never auto-complete — that granted free votes.
  return json({ ok: true, paymentId: id, message: 'Payment recorded. Send the exact amount, then your votes will be verified and added after admin approval.' });
}

// ─── Callbacks / Success ──────────────────────────────────────────────────
export async function apiToyyibpayCallback(env, request, params, query) {
  const { ref, status } = query;
  // SECURITY: never trust GET query params to complete a payment.
  // ToyyibPay posts the real callback with a hash signature; without
  // verifying it we cannot trust status=1. Mark as "callback received"
  // and let the admin (or a signed server-to-server verify call) confirm.
  if (ref) {
    const payment = await getPaymentByReference(env, ref);
    if (payment && payment.status === 'pending' && status === '1') {
      // Record that ToyyibPay reported success, but require admin verification
      // unless TOYYIBPAY_SECRET is configured and hash validation is implemented.
      // For now: leave pending — admin approves in dashboard.
      console.log(`ToyyibPay callback received for payment ${payment.id} (status=${status}) — awaiting admin verification`);
    }
  }
  return Response.redirect(`${getOrigin(request)}/thank-you.html?ref=${ref || ''}`, 302);
}

export async function paymentSuccess(env, request, params, query) {
  const { session_id } = query;
  if (session_id) {
    try {
      const stripe = await import('../payments/stripe.js');
      await stripe.verifyAndComplete(env, session_id);
    } catch { /* ignore */ }
  }
  return Response.redirect(`${getOrigin(request)}/thank-you.html?ref=${session_id || ''}`, 302);
}

// ─── YouTube search ────────────────────────────────────────────────────────
export async function apiYoutubeSearch(env, request, params, query) {
  const q = String(query.q || '').slice(0, 80);
  if (!q) return errorResponse('missing q', 400);
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' songs')}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en' } });
    const html = await r.text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    return json({ videoId: m ? m[1] : null });
  } catch {
    return json({ videoId: null });
  }
}

// ─── Image proxy ───────────────────────────────────────────────────────────
// SSRF protection: only proxy allowlisted image hosts.
const ALLOWED_IMAGE_DOMAINS = new Set([
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'commons.wikimedia.org',
  'img.youtube.com',
  'i.ytimg.com',
  'yt3.ggpht.com',
  'yt3.googleusercontent.com',
  'lastfm.freetls.fastly.net',
  'lastfm-img2.akamaized.net',
  'user-images.githubusercontent.com',
  'avatars.githubusercontent.com',
  'cdn.sstatic.net',
  'i.scdn.co',   // Spotify
  'pbs.twimg.com',
  'images.unsplash.com',
]);

export async function apiProxyImage(env, request, params, query) {
  const url = String(query.url || '');
  if (!/^https?:\/\//.test(url)) return new Response(null, { status: 400 });

  // SSRF guard: parse the host and check the allowlist
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return new Response(null, { status: 400 }); }
  if (!ALLOWED_IMAGE_DOMAINS.has(host)) return new Response(null, { status: 403 });

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!r.ok) return new Response(null, { status: r.status });
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return new Response(null, { status: 415 });
    return new Response(r.body, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

// ─── Wikipedia bio ─────────────────────────────────────────────────────────
export async function apiWikiBio(env, request, params, query) {
  const name = String(query.q || '').slice(0, 100);
  if (!name) return errorResponse('missing q', 400);
  try {
    const encoded = encodeURIComponent(name);
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&srlimit=1&origin=*`;
    const sr = await fetch(searchUrl, { headers: { 'User-Agent': 'BestArtistVoting/2.0' } });
    if (!sr.ok) return json({ bio: null });
    const searchData = await sr.json();
    const page = searchData?.query?.search?.[0];
    if (!page) return json({ bio: null });

    const pageTitle = encodeURIComponent(page.title);
    const exUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${pageTitle}&prop=extracts&exintro=1&explaintext=1&exsentences=3&format=json&origin=*`;
    const er = await fetch(exUrl, { headers: { 'User-Agent': 'BestArtistVoting/2.0' } });
    if (!er.ok) return json({ bio: null });
    const exData = await er.json();
    const pages = exData?.query?.pages;
    if (!pages) return json({ bio: null });
    for (const key of Object.keys(pages)) {
      const extract = pages[key]?.extract;
      if (extract && extract.length > 30) return json({ bio: extract, title: pages[key].title });
    }
    return json({ bio: null });
  } catch {
    return json({ bio: null });
  }
}

// ─── Recent Votes ──────────────────────────────────────────────────────────
export async function apiRecentVotes(env) {
  try {
    return json(await getRecentVotes(env));
  } catch {
    return json([]);
  }
}

// ─── Animations ───────────────────────────────────────────────────────────
const MOTIONS = { nod: true, wave: true, dance: true };

export async function apiCreateAnimation(env, request) {
  const formData = await request.formData();
  const motion = String(formData.get('motion') || 'nod').toLowerCase();
  if (!MOTIONS[motion]) return errorResponse(`Invalid motion. Use: ${Object.keys(MOTIONS).join(', ')}`, 400);

  const singerId = formData.get('singerId') ? parseInt(formData.get('singerId'), 10) : null;
  let sourceUrl = '';

  const imageFile = formData.get('image');
  if (imageFile && imageFile.size > 0) {
    if (env.BUCKET) {
      const ext = (imageFile.name || '.jpg').match(/\.(\w+)$/)?.[1] || 'jpg';
      const key = `anim-sources/${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      await env.BUCKET.put(key, imageFile.stream(), {
        customMetadata: { contentType: imageFile.type || 'image/jpeg' },
      });
      sourceUrl = `/uploads/${key}`;
    } else {
      sourceUrl = '/placeholder.jpg';
    }
  } else if (singerId) {
    const singer = await getSingerById(env, singerId);
    if (!singer) return errorResponse('Artist not found', 404);
    if (!singer.image_url) return errorResponse('Artist has no photo. Upload one or set image_url first.', 400);
    sourceUrl = singer.image_url;
  } else {
    return errorResponse('Provide either an image file or a singerId', 400);
  }

  const anim = await createAnimation(env, { singer_id: singerId, motion, source_url: sourceUrl.slice(0, 500) });

  // NOTE: On Workers, heavy CPU tasks like jimp/gifenc cannot run synchronously.
  // Animation generation is stubbed — for production, use Cloudflare Queues
  // with a separate Node.js worker, or a Cloudflare Worker AI binding.
  await updateAnimationStatus(env, anim.id, {
    status: 'failed',
    error: 'Animation generation is not supported on Cloudflare Workers. Use a separate compute service.',
  });

  return json({ success: true, id: anim.id, status: 'failed', poll: `/api/animations/${anim.id}` });
}

export async function apiGetAnimation(env, request, params) {
  const anim = await getAnimationById(env, params.id);
  if (!anim) return errorResponse('Not found', 404);
  return json(anim);
}

export async function apiListAnimations(env, request, params, query) {
  return json(await listAnimations(env, { singer_id: query.singerId || null, limit: query.limit }));
}

// ─── Admin ─────────────────────────────────────────────────────────────────
export async function adminPayments(env, request, params, query) {
  return json(await listPayments(env, query.status));
}

export async function adminApprovePayment(env, request, params) {
  const p = await completePayment(env, parseInt(params.id));
  if (!p) return errorResponse('Not found', 404);
  return json(p);
}

export async function adminRejectPayment(env, request, params) {
  const { rejectPayment } = await import('../lib/db.js');
  await rejectPayment(env, parseInt(params.id));
  return json({ ok: true });
}

export async function adminAddSinger(env, request) {
  const body = await request.json();
  const { name, country, genre, bio, image_url } = body;
  const { createSinger: cs } = await import('../lib/db.js');
  const singer = await cs(env, name, country || 'Global', genre || 'Music', image_url || '');
  if (bio) {
    await env.DB.prepare(`UPDATE singers SET bio = ? WHERE id = ?`).bind(bio, singer.id).run();
  }
  return json(await getSingerById(env, singer.id));
}

export async function adminDeleteSinger(env, request, params) {
  await env.DB.prepare(`DELETE FROM singers WHERE id = ?`).bind(parseInt(params.id)).run();
  return json({ ok: true });
}

// ─── PayPal helpers (fetch-based, no SDK) ──────────────────────────────────
async function createPaypalOrder(env, { singerId, votes, voterName }) {
  const singer = await getSingerById(env, singerId);
  if (!singer) throw new Error('Singer not found');
  const amount = (votes).toFixed(2); // $1 per vote
  const origin = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await getPaypalToken(env);
  const resp = await fetch(`${origin}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: (env.CURRENCY || 'usd').toUpperCase(), value: amount },
        description: `${votes} votes for ${singer.name}`,
      }],
    }),
  });
  return await resp.json();
}

async function capturePaypalOrder(env, orderId) {
  const origin = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await getPaypalToken(env);
  const resp = await fetch(`${origin}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const data = await resp.json();
  if (data.status === 'COMPLETED') {
    // Add votes — look up pending payment by reference
    const payment = await getPaymentByReference(env, orderId);
    if (payment) await completePayment(env, payment.id);
  }
  return data;
}

async function getPaypalToken(env) {
  const origin = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const resp = await fetch(`${origin}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  return data.access_token;
}

// ─── ToyyibPay helper ──────────────────────────────────────────────────────
async function createToyyibpayBill(env, { singerId, votes, voterName, request }) {
  const singer = await getSingerById(env, singerId);
  if (!singer) throw new Error('Singer not found');
  const origin = getOrigin(request);
  const resp = await fetch('https://toyyibpay.com/index.php/api/createBill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      userSecretKey: env.TOYYIBPAY_SECRET_KEY,
      categoryCode: env.TOYYIBPAY_CATEGORY_CODE || '',
      billTitle: `Votes for ${singer.name}`,
      billDescription: `${votes} votes`,
      billAmount: String(votes * 100), // in cents
      billPhone: '0000000000',
      billEmail: 'noreply@bestartist voting.com',
      billName: voterName || 'Anonymous',
      billReturnUrl: `${origin}/api/callback/toyyibpay`,
      billCallbackUrl: `${origin}/api/callback/toyyibpay`,
    }),
  });
  const data = await resp.json();
  return `https://toyyibpay.com/${data[0]?.BillCode || ''}`;
}
