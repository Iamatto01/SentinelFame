// ═════════════════════════════════════════════════════════════════════════
// worker.js — Cloudflare Worker entry point
// Serves static assets (via [assets] binding) + API routes
// Uses D1 for database, R2 for file uploads
// ═════════════════════════════════════════════════════════════════════════

import { stripeWebhook } from './payments/stripe.js';
import {
  apiSingers, apiSingerById, apiSingerLookup, apiSingerDonations,
  apiCountries, apiCountriesByName,
  apiGetBattle, apiBattleVote, apiCompetitions,
  apiPaymentMethods, apiEwalletConfig, apiPayStripe, apiPayStatus, apiPayPaypalOrder, apiPayPaypalCapture,
  apiPayToyyibpay, apiPayManual, apiCryptoConfig, apiPayCrypto,
  apiToyyibpayCallback, paymentSuccess,
  apiYoutubeSearch, apiProxyImage, apiWikiBio, apiRecentVotes,
  apiCreateAnimation, apiGetAnimation, apiListAnimations,
  adminPayments, adminApprovePayment, adminRejectPayment, adminAddSinger, adminDeleteSinger,
} from './routes/api.js';
import { errorResponse } from './lib/helpers.js';

// ─── Admin auth middleware ────────────────────────────────────────────────
function checkAdminAuth(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
  const expected = env.ADMIN_PASSWORD || '';
  if (!key || !expected) return false;
  // Constant-time comparison (timing-attack safe)
  const a = new TextEncoder().encode(String(key));
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── Route table ──────────────────────────────────────────────────────────
// Each entry: [method, pattern, handler]
// Pattern uses URLPattern-style string, with :param capture.
const routes = [
  // Singers
  ['GET',    '/api/singers',                   apiSingers],
  ['GET',    '/api/singers/:id',                 apiSingerById],
  ['POST',   '/api/singers/lookup',              apiSingerLookup],
  ['GET',    '/api/singers/:id/donations',       apiSingerDonations],

  // Countries
  ['GET',    '/api/countries',                   apiCountries],
  ['GET',    '/api/countries/:name',             apiCountriesByName],

  // Battle
  ['GET',    '/api/battle',                      apiGetBattle],
  ['POST',   '/api/battle/vote',                 apiBattleVote],

  // Competitions
  ['GET',    '/api/competitions',                apiCompetitions],

  // Payment methods
  ['GET',    '/api/payment-methods',             apiPaymentMethods],
  ['GET',    '/api/ewallet-config',              apiEwalletConfig],

  // Payments
  ['POST',   '/api/pay/stripe',                  apiPayStripe],
  ['GET',    '/api/pay/status',                  apiPayStatus],
  ['POST',   '/api/pay/paypal/order',            apiPayPaypalOrder],
  ['POST',   '/api/pay/paypal/capture',          apiPayPaypalCapture],
  ['POST',   '/api/pay/toyyibpay',               apiPayToyyibpay],
  ['POST',   '/api/pay/manual',                  apiPayManual],

  // Crypto
  ['GET',    '/api/crypto-config',               apiCryptoConfig],
  ['POST',   '/api/pay/crypto',                  apiPayCrypto],

  // Webhooks & callbacks
  ['POST',   '/api/webhook/stripe',              (env, req) => stripeWebhook(env, req)],
  ['GET',    '/api/callback/toyyibpay',          apiToyyibpayCallback],
  ['GET',    '/payment-success',                paymentSuccess],

  // External API proxies
  ['GET',    '/api/youtube-search',               apiYoutubeSearch],
  ['GET',    '/api/proxy-image',                 apiProxyImage],
  ['GET',    '/api/wiki-bio',                    apiWikiBio],

  // Recent votes
  ['GET',    '/api/recent-votes',                apiRecentVotes],

  // Animations
  ['POST',   '/api/animations',                  apiCreateAnimation],
  ['GET',    '/api/animations/:id',              apiGetAnimation],
  ['GET',    '/api/animations',                  apiListAnimations],
];

// Admin routes (protected)
const adminRoutes = [
  ['GET',    '/api/admin/payments',              adminPayments],
  ['POST',   '/api/admin/payments/:id/approve',  adminApprovePayment],
  ['POST',   '/api/admin/payments/:id/reject',   adminRejectPayment],
  ['POST',   '/api/admin/singers',               adminAddSinger],
  ['DELETE', '/api/admin/singers/:id',            adminDeleteSinger],
];

// ─── Pattern matching ─────────────────────────────────────────────────────
const compiledRoutes = [...routes, ...adminRoutes].map(([method, pattern, handler]) => {
  // Convert :param to named capture groups
  const regexPattern = pattern.replace(/:([^/]+)/g, '(?<$1>[^/]+)');
  const regex = new RegExp(`^${regexPattern}$`);
  return { method, pattern, regex, handler };
});

function matchRoute(method, pathname) {
  for (const r of compiledRoutes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      // Check if it's an admin route
      if (adminRoutes.some(([,,h]) => h === r.handler)) {
        return { handler: r.handler, params: m.groups, isAdmin: true };
      }
      return { handler: r.handler, params: m.groups, isAdmin: false };
    }
  }
  return null;
}

// ─── R2 upload serving ─────────────────────────────────────────────────────
async function serveR2Upload(env, path) {
  // path = "receipts/123-abc.jpg" or "anim-sources/456-def.png"
  const obj = await env.BUCKET.get(path);
  if (!obj) return new Response(null, { status: 404 });
  const contentType = obj.customMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// ─── Main fetch handler ───────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { method } = request;
      const pathname = url.pathname;

      // ── R2 upload serving (/uploads/receipts/... or /uploads/anim-sources/...)
      if (pathname.startsWith('/uploads/')) {
        const key = pathname.replace('/uploads/', '');
        return await serveR2Upload(env, key);
      }

      // ── API routes
      const match = matchRoute(method, pathname);
      if (match) {
        // Admin auth check
        if (match.isAdmin && !checkAdminAuth(request, env)) {
          return errorResponse('Unauthorized', 401);
        }

        try {
          const query = Object.fromEntries(url.searchParams.entries());
          return await match.handler(env, request, match.params || {}, query);
        } catch (err) {
          console.error('Route error:', err);
          return errorResponse(err.message || 'Internal server error', 500);
        }
      }

      // ── Static asset fallback
      if (!env.ASSETS) {
        return new Response('Assets binding not available', { status: 500 });
      }

      if (!pathname.includes('.') || pathname.endsWith('.html')) {
        if (pathname === '/battle') {
          return await env.ASSETS.fetch(new Request(`${url.origin}/battle.html`, request));
        }
        if (pathname === '/competitions') {
          return await env.ASSETS.fetch(new Request(`${url.origin}/competitions.html`, request));
        }
        if (pathname === '/admin') {
          return await env.ASSETS.fetch(new Request(`${url.origin}/admin.html`, request));
        }
        if (pathname === '/animate') {
          return await env.ASSETS.fetch(new Request(`${url.origin}/animate.html`, request));
        }
        if (pathname.startsWith('/country/')) {
          return await env.ASSETS.fetch(new Request(`${url.origin}/country.html`, request));
        }
        if (pathname === '/' || pathname === '/index.html') {
          return await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
        }
        return await env.ASSETS.fetch(request);
      }

      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled Worker error:', err);
      return new Response(`Worker error: ${err.message || err}`, { status: 500 });
    }
  },
};
