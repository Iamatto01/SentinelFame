const express = require('express');
const router = express.Router();
const db = require('../db');

// Simple auth middleware
router.use((req, res, next) => {
  if (req.query.key === process.env.ADMIN_PASSWORD || req.headers['x-admin-key'] === process.env.ADMIN_PASSWORD) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
});

// Pending payments
router.get('/payments', (req, res) => {
  res.json(db.listPayments(req.query.status));
});

// Approve payment → add votes
router.post('/payments/:id/approve', (req, res) => {
  const p = db.completePayment(parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

router.post('/payments/:id/reject', (req, res) => {
  db.db.prepare(`UPDATE payments SET status = 'rejected' WHERE id = ?`).run(parseInt(req.params.id));
  res.json({ ok: true });
});

// Add a singer
router.post('/singers', (req, res) => {
  const { name, country, genre, bio, image_url } = req.body;
  const info = db.db.prepare(`INSERT INTO singers (name, country, genre, bio, image_url) VALUES (?, ?, ?, ?, ?)`)
    .run(name, country || '', genre || '', bio || '', image_url || '');
  res.json(db.getSingerById(info.lastInsertRowid));
});

router.delete('/singers/:id', (req, res) => {
  db.db.prepare(`DELETE FROM singers WHERE id = ?`).run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
