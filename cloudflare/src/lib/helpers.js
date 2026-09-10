// ═════════════════════════════════════════════════════════════════════════
// helpers.js — Sanitization, validation, and shared utilities
// ═════════════════════════════════════════════════════════════════════════

const SANE_NAME_RE = /^[\p{L}\p{N}\s,.'&()!+\-–—/:;@#*"«»„”“‘’″‒–—―…\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]+$/u;
const MAX_NAME = 120;
const MAX_SEARCH = 80;
const MAX_VOTER = 60;

export function sanitizeName(raw) {
  const s = String(raw || '').trim().slice(0, MAX_NAME);
  return s.replace(/[<>]/g, '');
}

export function validateName(name) {
  if (!name || name.length < 2) return false;
  return SANE_NAME_RE.test(name);
}

export function sanitizeSearch(raw) {
  let s = String(raw || '').trim().slice(0, MAX_SEARCH);
  return s.replace(/[<>;'`"]/g, '');
}

export const MIN_VOTES = 1;

export function validatePaymentBody(body) {
  const singerId = parseInt(body.singerId, 10);
  const votes = parseInt(body.votes, 10);
  const voterName = sanitizeName(body.voterName || '');
  const voterMessage = String(body.voterMessage || '').slice(0, 280).trim();
  if (isNaN(singerId) || singerId < 1) return { error: 'Invalid singer ID' };
  if (isNaN(votes) || votes < 1 || votes > 10000) return { error: 'Invalid vote count (1-10000)' };
  return { singerId, votes, voterName, voterMessage };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

export function getOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
