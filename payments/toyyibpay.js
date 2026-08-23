// ToyyibPay — Malaysian FPX online banking + e-wallets (TNG, GrabPay, Boost via FPX)
const db = require('../db');

const TOYYIB_BASE = process.env.ToyyibPayMode === 'live'
  ? 'https://toyyibpay.com'
  : 'https://dev.toyyibpay.com';

async function createToyyibpayBill({ singerId, votes, voterName, req }) {
  const singer = db.getSingerById(singerId);
  if (!singer) throw new Error('Singer not found');

  const paymentId = db.createPayment({
    singer_id: singerId,
    voter_name: voterName || 'Anonymous',
    method: 'toyyibpay',
    vote_count: votes,
    amount_cents: votes * 100,
    currency: 'MYR',
    status: 'pending'
  });
  const billRef = `BA${Date.now()}P${paymentId}`;

  const body = new URLSearchParams({
    userSecretKey: process.env.TOYYIBPAY_SECRET_KEY,
    categoryCode: process.env.TOYYIBPAY_CATEGORY_CODE || '',
    billName: `Votes for ${singer.name}`,
    billDescription: `${votes} vote(s) — Best Artist Voting`,
    billPriceSetting: 1,
    billPayorInfo: 1,
    billAmount: votes * 100, // in sen (RM1 = 100 sen per vote)
    billReturnUrl: `${req.protocol}://${req.get('host')}/thank-you.html?ref=${billRef}`,
    billCallbackUrl: `${req.protocol}://${req.get('host')}/api/callback/toyyibpay`,
    billExternalReferenceNo: billRef,
    billTo: voterName || 'Anonymous',
    billEmail: 'voter@bestartist.local',
    billPhone: '0000000000'
  });

  const res = await fetch(`${TOYYIB_BASE}/index.php/api/createBill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]?.BillCode) throw new Error('ToyyibPay error');
  db.db.prepare(`UPDATE payments SET reference = ? WHERE id = ?`).run(billRef, paymentId);
  return `${TOYYIB_BASE}/${data[0].BillCode}`;
}

module.exports = { createToyyibpayBill };
