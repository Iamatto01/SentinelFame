const db = require('./db');
const { fetchWikipediaImage } = require('./wiki-image');

function seedSingers() {
  const count = db.db.prepare(`SELECT COUNT(*) as c FROM singers`).get().c;
  if (count > 0) return; // already seeded

  const list = require('./seed-singers');
  const insert = db.db.prepare(`INSERT INTO singers (name, country, genre, image_url) VALUES (?, ?, ?, '')`);
  const tx = db.db.transaction(() => {
    for (const [name, country, genre] of list) insert.run(name, country, genre);
  });
  tx();
  console.log(`✅ Seeded ${list.length} singers`);

  // Async: fetch Wikipedia images in background (best-effort, non-blocking)
  (async () => {
    const singers = db.getSingers({});
    let found = 0;
    for (const s of singers) {
      try {
        const url = await fetchWikipediaImage(s.name);
        if (url) {
          db.db.prepare(`UPDATE singers SET image_url = ? WHERE id = ?`).run(url, s.id);
          found++;
        }
      } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 150)); // be polite to the API
    }
    console.log(`🖼️  Fetched ${found}/${singers.length} artist images from Wikipedia`);
  })();
}

module.exports = { seedSingers };
