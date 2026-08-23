const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db');

async function createStripeSession({ singerId, votes, voterName, req, battle }) {
  const singer = db.getSingerById(singerId);
  if (!singer) throw new Error('Singer not found');
  const amountCents = votes * 100; // $1 per vote

  // Pre-create pending payment
  const paymentId = db.createPayment({
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    method: 'stripe',
    vote_count: votes,
    amount_cents: amountCents,
    currency: (process.env.CURRENCY || 'usd'),
    status: 'pending'
  });

  // Optional battle context — credited to the battle tally on webhook completion
  const meta = { paymentId: String(paymentId), singerId: String(singerId), votes: String(votes) };
  if (battle && battle.eventId) {
    meta.battleEvent = String(battle.eventId);
    meta.battleA = String(battle.aId);
    meta.battleB = String(battle.bId);
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: process.env.CURRENCY || 'usd',
        product_data: {
          name: `${votes} vote${votes > 1 ? 's' : ''} for ${singer.name}`,
          description: battle?.eventId
            ? `Battle ${battle.eventId} — support ${singer.name}`
            : `Best Artist Voting — support ${singer.name}`
        },
        unit_amount: 100
      },
      quantity: votes
    }],
    mode: 'payment',
    success_url: battle?.eventId
      ? `${req.protocol}://${req.get('host')}/battle?event=${encodeURIComponent(battle.eventId)}&a=${battle.aId}&b=${battle.bId}&paid=1`
      : `${req.protocol}://${req.get('host')}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.protocol}://${req.get('host')}/`,
    metadata: meta
  });

  db.db.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).run(session.id, paymentId);
  return session;
}

async function stripeWebhook(req, res) {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch { return res.status(400).send('Bad payload'); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paymentId = session.metadata?.paymentId;
    if (paymentId) db.completePayment(parseInt(paymentId));

    // Credit the battle tally if this payment was a battle vote
    const bEvent = session.metadata?.battleEvent;
    if (bEvent) {
      try {
        db.voteBattle(
          bEvent,
          session.metadata.battleA,
          session.metadata.battleB,
          session.metadata.singerId,
          parseInt(session.metadata.votes, 10) || 1
        );
      } catch (e) { console.error('Battle credit failed:', e.message); }
    }
  }
  res.json({ received: true });
}

module.exports = { createStripeSession, stripeWebhook };
