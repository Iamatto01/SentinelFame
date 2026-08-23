// Backfill missing artist images from Wikipedia — run: node backfill-images.js
const Database = require('better-sqlite3');
const path = require('path');
const { fetchWikipediaImage } = require('./wiki-image');

const dbPath = path.join(__dirname, '..', 'data', 'votes.db');
const db = new Database(dbPath);

const DELAY_MS = 600; // slower to avoid Wikipedia rate limits
const RETRY_MAX = 3;

(async () => {
  const missing = db.prepare(`SELECT id, name FROM singers WHERE image_url = '' OR image_url IS NULL`).all();
  console.log(`Fetching ${missing.length} missing images...`);
  let found = 0;
  for (let i = 0; i < missing.length; i++) {
    const s = missing[i];
    let url = null;
    // Retry up to RETRY_MAX times
    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        url = await fetchWikipediaImage(s.name);
        if (url) break;
      } catch (e) {
        console.log(`[${i + 1}/${missing.length}] ⚠️ ${s.name} (attempt ${attempt}) — ${e.message}`);
      }
      if (attempt < RETRY_MAX) await new Promise(r => setTimeout(r, 2000));
    }
    if (url) {
      db.prepare(`UPDATE singers SET image_url = ? WHERE id = ?`).run(url, s.id);
      found++;
      console.log(`[${i + 1}/${missing.length}] ✅ ${s.name}`);
    } else {
      console.log(`[${i + 1}/${missing.length}] ❌ ${s.name}`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`\n✅ Done! Fetched ${found}/${missing.length} images`);
  process.exit(0);
})();