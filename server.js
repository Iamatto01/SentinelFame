require('dotenv').config();
const express = require('express');
const path = require('path');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const { seedSingers } = require('./seed');
const { createStripeSession, verifyAndCompleteSession, stripeWebhook } = require('./payments/stripe');

const app = express();
app.enable('trust proxy');
const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Sila cuba sebentar lagi.' }
});

const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Had permintaan dicapai. Sila tunggu sebentar.' }
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/api/', generalLimiter);
app.use('/api/pay/', sensitiveLimiter);
app.use('/api/animations', sensitiveLimiter);

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// uploads dir
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_EXTS.includes(ext) ? ext : '.jpg';
      cb(null, `receipt-${Date.now()}-${Math.round(Math.random()*1e6)}${safeExt}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isMimeOk = /image\/(jpeg|png|jpg|webp)/.test(file.mimetype);
    const isExtOk = ALLOWED_EXTS.includes(ext);
    if (isMimeOk && isExtOk) return cb(null, true);
    cb(new Error('Format fail tidak dibenarkan. Hanya JPG, PNG, dan WebP dibenarkan.'));
  }
});

app.use('/uploads', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
}, express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Seed on first run ----------
seedSingers();

// ---------- Helpers: sanitize & validate ----------
const SANE_NAME_RE = /^[\p{L}\p{N}\s,.'&()!+\-–—/:;@#*"«»„”“‘’″‒–—―…\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+$/u;
const MAX_NAME = 120;
const MAX_SEARCH = 80;
const MAX_VOTER = 60;

function sanitizeName(raw) {
  const s = String(raw || '').trim().slice(0, MAX_NAME);
  return s.replace(/[<>]/g, '');          // strip angle brackets
}

function validateName(name) {
  if (!name || name.length < 2) return false;
  return SANE_NAME_RE.test(name);
}

// ---------- API: singers ----------
app.get('/api/singers', (req, res) => {
  let search = String(req.query.search || '').trim().slice(0, MAX_SEARCH);
  // strip anything that looks like SQL injection or HTML
  search = search.replace(/[<>;'`"]/g, '');

  const limit = req.query.limit ? Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 10)) : null;
  const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10) || 0) : 0;

  const singers = db.getSingers({ search, limit, offset });
  res.json(singers);
});

app.get('/api/singers/:id', (req, res) => {
  const s = db.getSingerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// ---------- API: countries ----------
app.get('/api/countries', (req, res) => {
  res.json(db.getCountries());
});

app.get('/api/countries/:name', (req, res) => {
  const name = sanitizeName(decodeURIComponent(req.params.name)).slice(0, MAX_SEARCH);
  if (!name) return res.status(400).json({ error: 'Invalid country' });
  res.json(db.getSingersByCountry(name));
});

// ---------- Page: country filter (/country/USA etc.) ----------
// Serves the ORIGINAL homepage — app.js reads the country from the URL and
// filters the artist lists client-side. No separate UI.
app.get('/country/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- API: Battle A vs B ----------
app.get('/api/battle', (req, res) => {
  try {
    const eventId = sanitizeName(String(req.query.event || '')).slice(0, 60);
    const aId = parseInt(req.query.a, 10);
    const bId = parseInt(req.query.b, 10);
    if (!eventId) return res.status(400).json({ error: 'Missing event id' });
    if (isNaN(aId) || isNaN(bId)) return res.status(400).json({ error: 'Missing artist ids' });
    let battle = db.getBattle(eventId, aId, bId) || db.createBattle(eventId, aId, bId);
    const a = db.getSingerById(aId);
    const b = db.getSingerById(bId);
    if (!a || !b) return res.status(404).json({ error: 'Artist not found' });
    // votes_a always belongs to singer_a column; map to requested order
    const votesForA = (+aId === battle.singer_a) ? battle.votes_a : battle.votes_b;
    const votesForB = (+bId === battle.singer_b) ? battle.votes_b : battle.votes_a;
    res.json({ eventId, battleId: battle.id, a, b, votesA: votesForA, votesB: votesForB });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/battle/vote', async (req, res) => {
  try {
    const eventId = sanitizeName(String(req.body.event || '')).slice(0, 60);
    const aId = parseInt(req.body.a, 10);
    const bId = parseInt(req.body.b, 10);
    const side = parseInt(req.body.side, 10);   // artist id being voted
    if (!eventId || isNaN(aId) || isNaN(bId) || isNaN(side)) {
      return res.status(400).json({ error: 'Missing battle params' });
    }
    if (side !== aId && side !== bId) return res.status(400).json({ error: 'Invalid side' });

    // Paid vote — same concept as the main voting flow ($1/vote via Stripe).
    // Battle tally is credited in the stripe webhook when payment completes
    // (metadata carries event/a/b so we know which side to credit).
    const v = validatePaymentBody({ singerId: side, votes: req.body.count, voterName: req.body.voterName });
    if (v.error) return res.status(400).json({ error: v.error });
    const session = await createStripeSession({
      singerId: v.singerId, votes: v.votes, voterName: v.voterName, req,
      battle: { eventId, aId, bId }
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Page: Battle A vs B (/battle?event=...&a=...&b=...) ----------
app.get('/battle', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'battle.html'));
});

// ---------- API: competition list (distinct battles grouped by event) ----------
app.get('/api/competitions', (req, res) => {
  try {
    const rows = db.db.prepare(`
      SELECT b.event_id, b.singer_a, b.singer_b, b.votes_a, b.votes_b, b.created_at,
             sa.name AS name_a, sa.image_url AS img_a, sa.country AS country_a,
             sb.name AS name_b, sb.image_url AS img_b, sb.country AS country_b
      FROM battles b
      JOIN singers sa ON sa.id = b.singer_a
      JOIN singers sb ON sb.id = b.singer_b
      ORDER BY b.created_at DESC
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Page: competitions list ----------
app.get('/competitions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'competitions.html'));
});

// ---------- API: lookup or create singer ----------
app.post('/api/singers/lookup', (req, res) => {
  try {
    const raw = String(req.body.name || '').trim();
    const name = sanitizeName(raw);
    const country = sanitizeName(req.body.country || '');
    const genre = sanitizeName(req.body.genre || '');

    if (!validateName(name)) {
      return res.status(400).json({ error: 'Invalid artist name. Use letters, numbers, and common punctuation only.' });
    }

    let singer = db.getSingerByName(name);
    const created = !singer;

    if (!singer) {
      singer = db.createSinger(name, country, genre);
    }

    res.json({ singer, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: payment methods available ----------
app.get('/api/payment-methods', (req, res) => {
  const currency = (process.env.CURRENCY || 'myr').toLowerCase();
  const unitPrice = (parseInt(process.env.PRICE_PER_VOTE_CENTS, 10) || 100) / 100;
  res.json({
    stripe: !!process.env.STRIPE_SECRET_KEY,
    stripe_qr: !!process.env.STRIPE_SECRET_KEY,
    ewallet: true,
    grabpay: !!process.env.STRIPE_SECRET_KEY,
    tng: true,
    shopeepay: true,
    currency: currency,
    currency_symbol: currency === 'myr' ? 'RM ' : '$',
    price_per_vote: unitPrice,
    paypal: false,
    toyyibpay: false,
    manual: true
  });
});

// ---------- Helpers for payment validation ----------
function validatePaymentBody(body) {
  const singerId = parseInt(body.singerId, 10);
  const votes = parseInt(body.votes, 10);
  const voterName = sanitizeName(body.voterName || '');
  const voterMessage = String(body.voterMessage || '').slice(0, 280).trim(); // fan message to artist
  if (isNaN(singerId) || singerId < 1) return { error: 'Invalid singer ID' };
  if (isNaN(votes) || votes < 1 || votes > 10000) return { error: 'Invalid vote count (1-10000)' };
  return { singerId, votes, voterName, voterMessage };
}

// ---------- API: create payment ----------
app.post('/api/pay/stripe', async (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const session = await createStripeSession({
      singerId: v.singerId,
      votes: v.votes,
      voterName: v.voterName,
      voterMessage: v.voterMessage,
      preferredMethod: req.body.preferredMethod,
      req
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- API: check payment status (for live in-modal QR polling) ----------
app.get('/api/pay/status', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const result = await verifyAndCompleteSession(session_id);
    if (result && result.session && result.session.payment_status === 'paid') {
      return res.json({ paid: true, votes: result.payment?.vote_count, singer: result.singer?.name });
    }
    return res.json({ paid: false, status: result?.session?.payment_status || 'unpaid' });
  } catch (e) {
    res.json({ paid: false, error: e.message });
  }
});

app.post('/api/pay/paypal/order', async (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const order = await createPaypalOrder({ singerId: v.singerId, votes: v.votes, voterName: v.voterName });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pay/paypal/capture', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId || typeof orderId !== 'string' || orderId.length > 200) return res.status(400).json({ error: 'Invalid order ID' });
    const result = await capturePaypalOrder(orderId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pay/toyyibpay', async (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const billUrl = await createToyyibpayBill({ singerId: v.singerId, votes: v.votes, voterName: v.voterName, req });
    res.json({ url: billUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual bank transfer with receipt upload
app.post('/api/pay/manual', upload.single('receipt'), (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const reference = sanitizeName(req.body.reference || '');
    const id = db.createPayment({
      singer_id: v.singerId,
      voter_name: v.voterName || 'Anonymous',
      voter_message: v.voterMessage || '',
      method: 'manual',
      vote_count: v.votes,
      amount_cents: v.votes * 100,
      currency: 'USD',
      reference: reference || null,
      receipt_image: req.file ? `/uploads/${req.file.filename}` : null,
      status: 'pending'
    });
    res.json({ ok: true, paymentId: id, message: 'Receipt submitted! Votes will be added after admin approval.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Malaysian e-Wallet payment (TNG, ShopeePay, DuitNow QR) ----------
app.get('/api/ewallet-config', (req, res) => {
  res.json({
    recipientName: process.env.EWALLET_RECIPIENT_NAME || 'Sentinel Fame Official',
    tngNumber: process.env.EWALLET_TNG_NUMBER || '012-3456789',
    shopeePayName: process.env.EWALLET_SHOPEEPAY_NAME || 'Sentinel Fame Official',
    qrImage: process.env.EWALLET_QR_IMAGE || '/images/duitnow-qr.svg',
    currency: (process.env.CURRENCY || 'myr').toLowerCase(),
    pricePerVote: (parseInt(process.env.PRICE_PER_VOTE_CENTS, 10) || 100) / 100
  });
});

app.post('/api/pay/ewallet', upload.single('receipt'), (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const reference = sanitizeName(req.body.reference || req.body.ref || '');
    const ewalletType = sanitizeName(req.body.ewalletType || 'ewallet');
    const currency = (process.env.CURRENCY || 'myr').toUpperCase();
    const unitAmount = parseInt(process.env.PRICE_PER_VOTE_CENTS, 10) || 100;
    const amountCents = v.votes * unitAmount;

    const id = db.createPayment({
      singer_id: v.singerId,
      voter_name: v.voterName || 'Anonymous',
      voter_message: v.voterMessage || '',
      method: ewalletType, // 'tng', 'shopeepay', 'duitnow'
      vote_count: v.votes,
      amount_cents: amountCents,
      currency: currency,
      reference: reference || `ewallet-${Date.now()}`,
      receipt_image: req.file ? `/uploads/${req.file.filename}` : null,
      status: 'pending'
    });
    res.json({
      ok: true,
      paymentId: id,
      message: '✅ Pengesahan bayaran e-Wallet berjaya dihantar! Undian akan dikreditkan selepas pengesahan pentadbir.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Crypto payment ----------
app.get('/api/crypto-config', (req, res) => {
  res.json({
    wallet: process.env.CRYPTO_WALLET || null,
    currency: process.env.CRYPTO_CURRENCY || 'USDT (TRC20)',
    network: process.env.CRYPTO_NETWORK || 'TRON'
  });
});

app.post('/api/pay/crypto', (req, res) => {
  try {
    const v = validatePaymentBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const txHash = sanitizeName(req.body.txHash || req.body.reference || '').slice(0, 100);
    if (!txHash) {
      return res.status(400).json({ error: 'Sila sertakan Hash Transaksi Crypto / TXID untuk pengesahan.' });
    }
    const id = db.createPayment({
      singer_id: v.singerId,
      voter_name: v.voterName || 'Anonymous',
      voter_message: v.voterMessage || '',
      method: 'crypto',
      vote_count: v.votes,
      amount_cents: v.votes * 100,
      currency: process.env.CRYPTO_CURRENCY || 'USDT',
      reference: txHash,
      status: 'pending'
    });
    // SECURITY FIX: Do not auto-complete crypto; wait for admin or on-chain verification
    res.json({
      ok: true,
      paymentId: id,
      message: '✅ Transaksi Crypto berjaya direkodkan! Undian akan dikreditkan selepas pengesahan pentadbir/on-chain.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Webhooks / callbacks ----------
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhook);

// Toyyibpay callback (GET with ref & status)
app.get('/api/callback/toyyibpay', async (req, res) => {
  const { ref, status } = req.query;
  // SECURITY FIX: Never complete payments blindly from URL parameters
  res.redirect(`/thank-you.html?ref=${encodeURIComponent(ref || '')}`);
});

// Generic return URL for Stripe success
app.get('/payment-success', async (req, res) => {
  const { session_id } = req.query;
  if (session_id) {
    try {
      await verifyAndCompleteSession(session_id);
    } catch (e) {
      console.error('Session verify error:', e.message);
    }
  }
  res.redirect(`/thank-you.html?session_id=${encodeURIComponent(session_id || '')}`);
});

// ---------- API: YouTube top-track lookup ----------
app.get('/api/youtube-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 80);
    if (!q) return res.status(400).json({ error: 'missing q' });
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' songs')}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en' } });
    const html = await r.text();
    // Extract first videoId from the initial data JSON
    const m = html.match(/"videoId":"([\w-]{11})"/);
    res.json({ videoId: m ? m[1] : null });
  } catch (e) { res.json({ videoId: null }); }
});

// ---------- API: Image proxy (with SSRF protection & safe domain whitelist) ----------
const ALLOWED_IMAGE_DOMAINS = [
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
  'en.wikipedia.org',
  'commons.wikimedia.org',
  'cdn-images.dzcdn.net',
  'e-cdns-images.dzcdn.net',
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com',
  'is5-ssl.mzstatic.com',
  'i.scdn.co',
  'images.unsplash.com',
  'i.imgur.com',
  'ui-avatars.com'
];

function isSafeImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();
    // Block internal, loopback, private ranges
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
    return ALLOWED_IMAGE_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

app.get('/api/proxy-image', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!isSafeImageUrl(url)) {
      return res.status(403).json({ error: 'Domain imej disekat atas faktor keselamatan (SSRF protection)' });
    }
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return res.status(r.status).end();
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Pautan bukan imej yang sah' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// ---------- API: Wikipedia bio extract ----------
app.get('/api/wiki-bio', async (req, res) => {
  try {
    const name = String(req.query.q || '').slice(0, 100);
    if (!name) return res.status(400).json({ error: 'missing q' });
    const encoded = encodeURIComponent(name);

    // Search for the best matching page
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&srlimit=1&origin=*`;
    const sr = await fetch(searchUrl, {
      headers: { 'User-Agent': 'BestArtistVoting/2.0 (halloffame@example.com)' }
    });
    if (!sr.ok) return res.json({ bio: null });
    const searchData = await sr.json();
    const page = searchData?.query?.search?.[0];
    if (!page) return res.json({ bio: null });

    // Get the extract (intro paragraph)
    const pageTitle = encodeURIComponent(page.title);
    const exUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${pageTitle}&prop=extracts&exintro=1&explaintext=1&exsentences=3&format=json&origin=*`;
    const er = await fetch(exUrl, {
      headers: { 'User-Agent': 'BestArtistVoting/2.0' }
    });
    if (!er.ok) return res.json({ bio: null });
    const exData = await er.json();
    const pages = exData?.query?.pages;
    if (!pages) return res.json({ bio: null });

    for (const key of Object.keys(pages)) {
      const extract = pages[key]?.extract;
      if (extract && extract.length > 30) {
        return res.json({ bio: extract, title: pages[key].title });
      }
    }
    res.json({ bio: null });
  } catch (e) { res.json({ bio: null }); }
});

// ---------- API: fan donations for one artist (name + comment) ----------
app.get('/api/singers/:id/donations', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid artist ID' });
    const rows = db.db.prepare(`
      SELECT voter_name, voter_message, vote_count, amount_cents, method, created_at
      FROM payments
      WHERE singer_id = ? AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(id);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- API: recent votes for live ticker ----------
app.get('/api/recent-votes', (req, res) => {
  try {
    const rows = db.db.prepare(`
      SELECT p.voter_name, p.vote_count, p.amount_cents, p.method, p.created_at,
             s.name AS singer_name, s.id AS singer_id
      FROM payments p
      JOIN singers s ON s.id = p.singer_id
      WHERE p.status = 'completed'
      ORDER BY p.created_at DESC
      LIMIT 30
    `).all();
    res.json(rows);
  } catch (e) { res.json([]); }
});

// ---------- Animations (AI nod / wave from artist photo) ----------
const { generateAnimation, MOTIONS } = require('./animation-engine');

// Serve generated animation files
app.use('/animations', express.static(path.join(__dirname, 'public', 'animations'), {
  maxAge: '1d',
}));

// Create an animation job for a singer (or a raw uploaded image)
app.post('/api/animations', upload.single('image'), async (req, res) => {
  try {
    const motion = String(req.body.motion || 'nod').toLowerCase();
    if (!MOTIONS[motion]) return res.status(400).json({ error: `Invalid motion. Use: ${Object.keys(MOTIONS).join(', ')}` });

    const singerId = req.body.singerId ? parseInt(req.body.singerId, 10) : null;
    let sourceUrl = '';

    if (req.file) {
      sourceUrl = `/uploads/${req.file.filename}`;
    } else if (singerId) {
      const singer = db.getSingerById(singerId);
      if (!singer) return res.status(404).json({ error: 'Artist not found' });
      if (!singer.image_url) return res.status(400).json({ error: 'Artist has no photo. Upload one or set image_url first.' });
      sourceUrl = singer.image_url;
    } else {
      return res.status(400).json({ error: 'Provide either an image file or a singerId' });
    }

    // If the source is remote, route through our own proxy endpoint so
    // hotlink-blocked images still download reliably.
    let engineSource = sourceUrl;
    if (/^https?:\/\//.test(sourceUrl)) {
      engineSource = `http://localhost:${PORT}/api/proxy-image?url=${encodeURIComponent(sourceUrl)}`;
    }

    const anim = db.createAnimation({
      singer_id: singerId,
      motion,
      source_url: sourceUrl.slice(0, 500),
    });

    // Generate in background; client polls GET /api/animations/:id
    generateAnimation({ animationId: anim.id, source: engineSource.startsWith('/') ? path.join(__dirname, engineSource) : engineSource, motion })
      .then((result) => {
        db.updateAnimationStatus(anim.id, {
          status: 'completed',
          file_url: result.file_url,
          thumb_url: result.thumb_url,
          frames: result.frames,
          duration_ms: result.duration_ms,
        });
        console.log(`✨ Animation ${anim.id} completed → ${result.file_url}`);
      })
      .catch((err) => {
        console.error(`Animation ${anim.id} failed:`, err.message);
        db.updateAnimationStatus(anim.id, { status: 'failed', error: err.message });
      });

    res.json({ success: true, id: anim.id, status: 'pending', poll: `/api/animations/${anim.id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll job status / fetch result
app.get('/api/animations/:id', (req, res) => {
  const anim = db.getAnimationById(req.params.id);
  if (!anim) return res.status(404).json({ error: 'Not found' });
  res.json(anim);
});

// List animations (optionally filtered by singer)
app.get('/api/animations', (req, res) => {
  res.json(db.listAnimations({ singer_id: req.query.singerId || null, limit: req.query.limit }));
});

// ---------- Admin ----------
const adminRouter = require('./routes/admin');
app.use('/admin', adminRouter);

const PORT = process.env.PORT || 3000;

// Prevent crashes from background tasks (e.g. image fetching)
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

app.listen(PORT, () => console.log(`🎤 Best Artist voting running → http://localhost:${PORT}`));
