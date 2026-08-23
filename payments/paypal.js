const db = require('../db');

const PAYPAL_BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal auth failed');
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

async function createPaypalOrder({ singerId, votes, voterName }) {
  const singer = db.getSingerById(singerId);
  if (!singer) throw new Error('Singer not found');
  const token = await getAccessToken();

  const paymentId = db.createPayment({
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    method: 'paypal',
    vote_count: votes,
    amount_cents: votes * 100,
    currency: 'USD',
    status: 'pending'
  });

  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        description: `${votes} vote(s) for ${singer.name}`,
        amount: { currency_code: 'USD', value: votes.toFixed(2) },
        custom_id: String(paymentId)
      }]
    })
  });
  const order = await res.json();
  db.db.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).run(order.id, paymentId);
  return order;
}

async function capturePaypalOrder(orderId) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const result = await res.json();
  if (result.status === 'COMPLETED') {
    const payment = db.getPaymentByReference(orderId);
    if (payment) db.completePayment(payment.id);
  }
  return { status: result.status };
}

module.exports = { createPaypalOrder, capturePaypalOrder };
