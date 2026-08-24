# 🎤 Best Artist Voting — Cloudflare Workers Edition

This is the Cloudflare Workers port of the Best Artist / Hall Of Fame voting app.
It replaces Express + better-sqlite3 + Multer with:

| Original (Node.js)            | Cloudflare Workers            |
|-------------------------------|-------------------------------|
| Express.js                    | Native Workers `fetch` handler |
| better-sqlite3 (local SQLite) | Cloudflare **D1** (edge SQLite) |
| Multer (disk uploads)         | `request.formData()` + **R2**  |
| `express.static(public/)`     | Workers **Assets** binding     |
| Stripe SDK                    | Raw `fetch()` to Stripe API   |
| PayPal SDK (if used)          | Raw `fetch()` to PayPal API    |
| jimp/gifenc animations        | ⚠️ Not supported on Workers (CPU limits) |
| `process.env`                 | `env` binding + `wrangler secret` |

---

## 📁 Structure

```
cloudflare/
├── wrangler.toml          # Cloudflare config (D1, R2, assets, vars)
├── package.json           # npm scripts for wrangler commands
├── schema.sql             # D1 table definitions
├── seed.sql               # D1 seed data (190+ artists)
├── public/                # ← symlink or copy from parent ../public/
└── src/
    ├── worker.js          # Main entry: routing, static fallback, R2 serving
    ├── lib/
    │   ├── db.js          # D1 async query layer (mirrors original db.js)
    │   └── helpers.js     # Sanitize, validate, json(), errorResponse()
    ├── routes/
    │   └── api.js         # All API route handlers
    └── payments/
        └── stripe.js      # Stripe checkout + webhook (fetch-based)
```

---

## 🚀 Setup (5-minute deploy)

### 1. Install Wrangler

```bash
cd cloudflare
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create best-artist-db
```

Copy the `database_id` from the output into `wrangler.toml`.

### 3. Create the R2 bucket

```bash
npx wrangler r2 bucket create best-artist-uploads
```

### 4. Apply schema + seed data

```bash
npm run db:schema
npm run db:seed
```

### 5. Set your secrets

```bash
npm run secret:stripe          # → paste your Stripe secret key
npm run secret:stripe-wh       # → paste your Stripe webhook signing secret
npm run secret:admin           # → set an admin password
npm run secret:crypto          # → your crypto wallet address (optional)
# PayPal / ToyyibPay if using them
```

Also set non-secret vars in `wrangler.toml` under `[vars]`:
- `STRIPE_PUBLISHABLE_KEY`
- `PAYPAL_CLIENT_ID`
- `CURRENCY`

### 6. Copy the frontend

The Workers Assets binding serves files from `./public/`. Either copy or symlink:

```bash
# Windows (symlink, run as Administrator)
mklink /D cloudflare\public ..\public

# Or just copy
xcopy ..\public cloudflare\public /E /I
```

### 7. Deploy 🎉

```bash
npm run deploy
```

Your app is now live at `https://best-artist-voting.<your-subdomain>.workers.dev`

### 8. Update Stripe webhook URL

Go to Stripe Dashboard → Webhooks → add endpoint:
```
https://best-artist-voting.<your-subdomain>.workers.dev/api/webhook/stripe
```
Events to send: `checkout.session.completed`

---

## 🔧 Local development

```bash
npm run dev
```

This starts `wrangler dev` with a local D1 miniflare. The database is ephemeral
in dev — re-seed with:

```bash
npx wrangler d1 execute best-artist-db --local --file=./schema.sql
npx wrangler d1 execute best-artist-db --local --file=./seed.sql
```

---

## 📋 What's included (all routes ported)

| Method | Route                          | Description                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/singers`                 | List/search singers                  |
| GET    | `/api/singers/:id`             | Get one singer                       |
| POST   | `/api/singers/lookup`          | Lookup or create singer by name      |
| GET    | `/api/singers/:id/donations`   | Fan donations for an artist          |
| GET    | `/api/countries`                | List countries with artist counts   |
| GET    | `/api/countries/:name`         | Singers in a country                 |
| GET    | `/api/battle`                  | Get/create a battle A vs B           |
| POST   | `/api/battle/vote`             | Vote in a battle (Stripe checkout)   |
| GET    | `/api/competitions`            | List all battles                     |
| GET    | `/api/payment-methods`         | Available payment methods            |
| POST   | `/api/pay/stripe`              | Create Stripe checkout session       |
| POST   | `/api/pay/paypal/order`        | Create PayPal order                  |
| POST   | `/api/pay/paypal/capture`      | Capture PayPal order                 |
| POST   | `/api/pay/toyyibpay`           | Create ToyyibPay bill                |
| POST   | `/api/pay/manual`              | Manual upload with receipt (R2)      |
| GET    | `/api/crypto-config`           | Crypto wallet info                   |
| POST   | `/api/pay/crypto`              | Crypto payment (auto-complete demo)  |
| POST   | `/api/webhook/stripe`          | Stripe webhook handler               |
| GET    | `/api/callback/toyyibpay`      | ToyyibPay return URL                 |
| GET    | `/payment-success`             | Stripe success fallback              |
| GET    | `/api/youtube-search`          | YouTube video ID lookup              |
| GET    | `/api/proxy-image`             | CORS-safe image proxy                |
| GET    | `/api/wiki-bio`                | Wikipedia bio extract                |
| GET    | `/api/recent-votes`            | Recent completed votes (ticker)      |
| POST   | `/api/animations`              | Create animation job (stubbed)       |
| GET    | `/api/animations/:id`          | Poll animation status                |
| GET    | `/api/animations`              | List animations                      |
| GET    | `/api/admin/payments`          | Admin: list payments                 |
| POST   | `/api/admin/payments/:id/approve` | Admin: approve payment           |
| POST   | `/api/admin/payments/:id/reject`  | Admin: reject payment            |
| POST   | `/api/admin/singers`           | Admin: add singer                    |
| DELETE | `/api/admin/singers/:id`       | Admin: delete singer                 |

---

## ⚠️ Known limitations on Workers

1. **Animation engine** (`jimp` + `gifenc`): These are CPU-heavy libraries that
   exceed Workers' CPU time limits. The `/api/animations` endpoint is stubbed
   and returns `status: 'failed'` with an explanatory message. Options:
   - Use **Cloudflare Queues** to dispatch to a Node.js compute service
   - Use **Workers AI** for image manipulation
   - Generate animations on a separate server and store in R2

2. **Wikipedia image backfill** (`seed.js`): The original seed script fetches
   images from Wikipedia at startup. On Workers there's no "startup" — run the
   `backfill-images.js` script against D1 separately, or add a one-time admin
   endpoint that triggers image fetching.

3. **Stripe webhook signature verification**: The Express version uses the
   Stripe SDK's built-in verification. On Workers, we parse the webhook body
   directly. For production, implement HMAC-SHA256 verification using the
   Web Crypto API with your `STRIPE_WEBHOOK_SECRET`.

---

## 💰 Cost

- **D1**: Free tier = 5M reads/day, 100K writes/day
- **R2**: Free tier = 10GB storage, 1M Class A ops/month
- **Workers**: Free tier = 100K requests/day
- → Generous enough for a voting app with moderate traffic
