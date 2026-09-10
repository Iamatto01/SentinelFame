// ═════════════════════════════════════════════════════════════════════════
// stripe.js — Stripe checkout + webhook for Cloudflare Workers
// ═════════════════════════════════════════════════════════════════════════

import {
  createPayment, updatePaymentReference, completePayment,
  getSingerById, savePaymentCreditContext, getPaymentByReference,
} from '../lib/db.js';
import { json, errorResponse, getOrigin, sanitizeName, validatePaymentBody, MIN_VOTES } from '../lib/helpers.js';

/**
 * Create a Stripe Checkout Session for paying votes.
 * Mirrors payments/stripe.js from the Express version.
 */
export async function createStripeSession(env, { singerId, votes, voterName, voterMessage, request, battle, preferredMethod }) {
  const singer = await getSingerById(env, singerId);
  if (!singer) throw new Error('Singer not found');
  const voteCount = parseInt(votes, 10);
  if (isNaN(voteCount) || voteCount < 1) throw new Error('Invalid vote count');
  const currency = (env.CURRENCY || 'myr').toLowerCase();
  const unitAmount = parseInt(env.PRICE_PER_VOTE_CENTS, 10) || 100;
  if (currency === 'myr' && voteCount * unitAmount < 200) {
    throw new Error('Stripe requires a minimum of RM 2.00 (2 votes).');
  }
  const amountCents = voteCount * unitAmount;

  // Pre-create pending payment
  const paymentId = await createPayment(env, {
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    voter_message: voterMessage || '',
    method: preferredMethod === 'qr' ? 'stripe_qr' : (preferredMethod === 'grabpay' ? 'grabpay' : 'stripe'),
    vote_count: votes,
    amount_cents: amountCents,
    currency: currency.toUpperCase(),
    status: 'pending',
  });

  // Persist the credit context up-front so completePayment can atomically
  // credit singer votes AND the battle tally exactly once, no matter whether
  // the webhook or the polling fallback fires first (or both, or repeatedly).
  await savePaymentCreditContext(env, paymentId, {
    singerId,
    voteCount: votes,
    amountCents,
    battleEventId: battle?.eventId || null,
    battleAId: battle?.aId ?? null,
    battleBId: battle?.bId ?? null,
    battleSide: battle?.eventId ? singerId : null,
  });

  // Build metadata
  const meta = { paymentId: String(paymentId), singerId: String(singerId), votes: String(votes) };
  if (battle && battle.eventId) {
    meta.battleEvent = String(battle.eventId);
    meta.battleA = String(battle.aId);
    meta.battleB = String(battle.bId);
  }

  const origin = getOrigin(request);

  let paymentMethodTypes = ['card'];
  if (preferredMethod === 'qr' || preferredMethod === 'grabpay') {
    paymentMethodTypes = currency === 'myr' ? ['grabpay'] : ['card'];
  } else {
    paymentMethodTypes = ['card'];
  }

  const body = {
    payment_method_types: paymentMethodTypes,
    line_items: [{
      price_data: {
        currency: currency,
        product_data: {
          name: `${votes} vote${votes > 1 ? 's' : ''} for ${singer.name}`,
          description: battle?.eventId
            ? `Battle ${battle.eventId} — support ${singer.name}`
            : `Best Artist Voting — support ${singer.name}`,
          images: singer.image_url && singer.image_url.startsWith('http') ? [singer.image_url] : [],
        },
        unit_amount: unitAmount,
      },
      quantity: votes,
    }],
    mode: 'payment',
    success_url: battle?.eventId
      ? `${origin}/battle?event=${encodeURIComponent(battle.eventId)}&a=${battle.aId}&b=${battle.bId}&paid=1`
      : `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    metadata: meta,
  };

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(flattenParams(body)).toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe error: ${err}`);
  }

  const session = await resp.json();
  await updatePaymentReference(env, paymentId, session.id);
  return session;
}

// Flatten nested params for Stripe's application/x-www-form-urlencoded API
function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      pairs.push(...flattenParams(val, fullKey));
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v !== null && typeof v === 'object') {
          pairs.push(...flattenParams(v, `${fullKey}[${i}]`));
        } else {
          pairs.push([`${fullKey}[${i}]`, String(v)]);
        }
      });
    } else if (val !== null && val !== undefined) {
      pairs.push([fullKey, String(val)]);
    }
  }
  return pairs;
}

/**
 * Stripe webhook handler.
 * Verifies the Stripe-Signature header (HMAC-SHA256 via Web Crypto) before
 * trusting ANY payload. Without this, anyone could POST a fake
 * checkout.session.completed event and receive free votes.
 */
export async function stripeWebhook(env, request) {
  const rawBody = await request.text();

  // ── Signature verification (MANDATORY) ─────────────────────────────────
  const sig = request.headers.get('stripe-signature') || '';
  const secret = env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook');
    return errorResponse('Webhook not configured', 503);
  }
  if (!sig) return errorResponse('Missing signature', 400);

  const valid = await verifyStripeSignature(rawBody, sig, secret);
  if (!valid) return errorResponse('Invalid signature', 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResponse('Bad payload', 400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data && event.data.object;
    if (!session) return json({ received: true });

    const paymentId = session.metadata?.paymentId;
    if (paymentId) {
      // completePayment credits singer votes AND battle tally atomically,
      // guarded by payment_credit_claims — retries are safe.
      await completePayment(env, parseInt(paymentId));
    }
  }

  return json({ received: true });
}

/**
 * Fallback: verify a Stripe checkout session by id (for /payment-success)
 */
export async function verifyAndComplete(env, sessionId) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!resp.ok) return null;
  const session = await resp.json();
  if (session.payment_status === 'paid') {
    const payment = await getPaymentByReference(env, session.id);
    if (payment) await completePayment(env, payment.id);
  }
  return session;
}

/**
 * Verify Stripe-Signature header: "t=timestamp,v1=signature".
 * Scheme: HMAC-SHA256(secret, `${timestamp}.${payload}`) — constant-time compare.
 */
async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries(
    header.split(',').map(p => p.split('=', 2).map(s => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Replay protection: reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (isNaN(age) || age > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${timestamp}.${payload}`)
  );
  const expected = [...new Uint8Array(mac)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
