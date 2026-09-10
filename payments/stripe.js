const db = require('../db');

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || secretKey.startsWith('sk_test_xxxx')) {
    throw new Error('Stripe Secret Key is not configured in .env');
  }
  return require('stripe')(secretKey);
}

async function createStripeSession({ singerId, votes, voterName, voterMessage, req, battle, preferredMethod }) {
  const stripe = getStripe();
  const singer = db.getSingerById(singerId);
  if (!singer) throw new Error('Singer not found');

  const currency = (process.env.CURRENCY || 'myr').toLowerCase();
  // 1 vote = RM 1.00 (100 cents).
  const unitAmount = parseInt(process.env.PRICE_PER_VOTE_CENTS, 10) || 100;
  let voteCount = parseInt(votes, 10);
  if (isNaN(voteCount) || voteCount < 1) {
    throw new Error('Invalid vote count');
  }

  // Stripe Malaysia strictly enforces a minimum transaction limit of RM 2.00 (200 cents).
  // At RM 1.00 / vote, the minimum transaction is 2 votes. Reject explicitly —
  // never silently bump the user's chosen vote count (that caused double-vote bugs).
  if (currency === 'myr' && voteCount * unitAmount < 200) {
    throw new Error('Stripe requires a minimum of RM 2.00 (2 votes). Use DuitNow QR for 1 vote = RM 1.00.');
  }
  const amountCents = voteCount * unitAmount;

  let methodTag = 'stripe';
  if (preferredMethod === 'qr') methodTag = 'stripe_qr';
  else if (preferredMethod === 'grabpay') methodTag = 'grabpay';

  // Pre-create pending payment in local database
  const paymentId = db.createPayment({
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    voter_message: voterMessage || '',
    method: methodTag,
    vote_count: voteCount,
    amount_cents: amountCents,
    currency: currency.toUpperCase(),
    status: 'pending'
  });

  // Persist the credit context up-front so completePayment can atomically
  // credit singer votes AND the battle tally exactly once, no matter whether
  // the webhook or the polling fallback fires first (or both, or repeatedly).
  db.savePaymentCreditContext(paymentId, {
    singerId,
    voteCount,
    amountCents,
    battleEventId: battle?.eventId || null,
    battleAId: battle?.aId ?? null,
    battleBId: battle?.bId ?? null,
    battleSide: battle?.eventId ? singerId : null,
  });

  const meta = {
    paymentId: String(paymentId),
    singerId: String(singerId),
    votes: String(voteCount),
    voterName: String(voterName || 'Anonymous'),
    voterMessage: String(voterMessage || '')
  };

  if (battle && battle.eventId) {
    meta.battleEvent = String(battle.eventId);
    meta.battleA = String(battle.aId);
    meta.battleB = String(battle.bId);
  }

  // Determine external origin safely across Cloudflare Tunnel & reverse proxies
  const proto = (req && req.headers && req.headers['x-forwarded-proto']) || (req && req.protocol) || 'https';
  const host = (req && req.headers && req.headers['x-forwarded-host']) || (req && req.get && req.get('host')) || 'fame.sentinelai.studio';
  const origin = `${proto}://${host}`;

  // Payment methods:
  // Option 2 (Card / Apple Pay): strictly ['card'] -> provides Card Number, Expiry, CVC, Name + Apple Pay + Google Pay + Link! NO QR.
  // Option 3 (QR): strictly ['grabpay'] for MYR
  let paymentMethodTypes = ['card'];
  if (preferredMethod === 'qr' || preferredMethod === 'grabpay') {
    paymentMethodTypes = currency === 'myr' ? ['grabpay'] : ['card'];
  } else {
    // Strictly card only for direct card & Apple Pay checkout
    paymentMethodTypes = ['card'];
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: paymentMethodTypes,
    line_items: [{
      price_data: {
        currency: currency,
        product_data: {
          name: `${voteCount} vote${voteCount > 1 ? 's' : ''} for ${singer.name}`,
          description: battle?.eventId
            ? `Battle ${battle.eventId} — Best Artist Voting for ${singer.name}`
            : `Hall of Fame Voting — support ${singer.name}`,
          images: singer.image_url && singer.image_url.startsWith('http') ? [singer.image_url] : []
        },
        unit_amount: unitAmount
      },
      quantity: voteCount
    }],
    mode: 'payment',
    success_url: `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    metadata: meta
  });

  try {
    db.db.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).run(session.id, paymentId);
  } catch (e) {
    console.error('Failed to attach reference to payment:', e.message);
  }

  return session;
}

async function verifyAndCompleteSession(sessionId) {
  if (!sessionId) return null;
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session && session.payment_status === 'paid') {
    const paymentId = session.metadata?.paymentId;
    if (paymentId) {
      const completed = db.completePayment(parseInt(paymentId, 10));
      return { session, payment: completed, singer: db.getSingerById(session.metadata?.singerId) };
    }
  }
  return { session, payment: null, singer: null };
}

async function stripeWebhook(req, res) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  if (endpointSecret && secretKey) {
    try {
      const sig = req.headers['stripe-signature'];
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('⚠️ Stripe Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // If webhook secret is not set yet in development, log warning and parse payload
    try {
      event = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body instanceof Buffer ? JSON.parse(req.body.toString('utf8')) : req.body);
    } catch {
      return res.status(400).send('Bad payload');
    }
  }

  if (event && event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paymentId = session.metadata?.paymentId;
    if (paymentId) {
      // completePayment credits singer votes AND battle tally atomically,
      // guarded by payment_credit_claims — retries are safe.
      db.completePayment(parseInt(paymentId, 10));
    }
  }
  res.json({ received: true });
}

module.exports = { createStripeSession, verifyAndCompleteSession, stripeWebhook };
