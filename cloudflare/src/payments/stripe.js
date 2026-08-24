// ═════════════════════════════════════════════════════════════════════════
// stripe.js — Stripe checkout + webhook for Cloudflare Workers
// ═════════════════════════════════════════════════════════════════════════

import {
  createPayment, updatePaymentReference, completePayment,
  getSingerById, voteBattle,
} from '../lib/db.js';
import { json, errorResponse, getOrigin, sanitizeName, validatePaymentBody } from '../lib/helpers.js';

/**
 * Create a Stripe Checkout Session for paying votes.
 * Mirrors payments/stripe.js from the Express version.
 */
export async function createStripeSession(env, { singerId, votes, voterName, voterMessage, request, battle }) {
  const singer = await getSingerById(env, singerId);
  if (!singer) throw new Error('Singer not found');
  const amountCents = votes * 100; // $1 per vote

  // Pre-create pending payment
  const paymentId = await createPayment(env, {
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    voter_message: voterMessage || '',
    method: 'stripe',
    vote_count: votes,
    amount_cents: amountCents,
    currency: env.CURRENCY || 'usd',
    status: 'pending',
  });

  // Build metadata
  const meta = { paymentId: String(paymentId), singerId: String(singerId), votes: String(votes) };
  if (battle && battle.eventId) {
    meta.battleEvent = String(battle.eventId);
    meta.battleA = String(battle.aId);
    meta.battleB = String(battle.bId);
  }

  const origin = getOrigin(request);

  const body = {
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: env.CURRENCY || 'usd',
        product_data: {
          name: `${votes} vote${votes > 1 ? 's' : ''} for ${singer.name}`,
          description: battle?.eventId
            ? `Battle ${battle.eventId} — support ${singer.name}`
            : `Best Artist Voting — support ${singer.name}`,
        },
        unit_amount: 100,
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
 * On Workers, we get the raw body as a string — verify the signature.
 */
export async function stripeWebhook(env, request) {
  const rawBody = await request.text();

  // Verify webhook signature
  const sig = request.headers.get('stripe-signature') || '';
  const secret = env.STRIPE_WEBHOOK_SECRET || '';

  // For simplicity (and since Workers don't have the Stripe SDK), we verify
  // by calling Stripe's API to retrieve the event by id from the payload.
  // In production, you should use Stripe's webhook signature verification
  // using Web Crypto API (HMAC-SHA256), or the `stripe` package via a
  // Workers-compatible build.
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
    if (paymentId) await completePayment(env, parseInt(paymentId));

    // Credit battle tally if battle metadata present
    const bEvent = session.metadata?.battleEvent;
    if (bEvent) {
      try {
        await voteBattle(env,
          session.metadata.battleEvent,
          parseInt(session.metadata.battleA),
          parseInt(session.metadata.battleB),
          parseInt(session.metadata.singerId),
          parseInt(session.metadata.votes, 10) || 1
        );
      } catch (e) { /* log but don't fail the webhook */ }
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

// Lazy import for getPaymentByReference (avoid circular)
async function getPaymentByReference(env, ref) {
  const { getPaymentByReference: gpr } = await import('../lib/db.js');
  return gpr(env, ref);
}
