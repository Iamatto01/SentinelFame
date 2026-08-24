const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function fetchWikiImage(name) {
  if (!name) return '';
  const variations = [
    name,
    name.split('/')[0].trim(),
    name.replace(/\([^)]*\)/g, '').trim(),
    name + ' (musician)',
    name + ' (band)',
    name + ' (singer)',
  ];
  for (const v of variations) {
    try {
      const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(v), {
        headers: { 'User-Agent': 'BestArtistVoting/2.0 (contact@sentinelai.studio)' }
      });
      if (res.ok) {
        const d = await res.json();
        if (d.thumbnail?.source) return d.thumbnail.source;
      }
    } catch (e) {}
  }
  // Fallback to Wikipedia search generator API
  try {
    const sRes = await fetch('https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(name) + '&gsrlimit=3&prop=pageimages&pithumbsize=500&format=json', {
      headers: { 'User-Agent': 'BestArtistVoting/2.0 (contact@sentinelai.studio)' }
    });
    if (sRes.ok) {
      const sData = await sRes.json();
      const pages = sData.query?.pages;
      if (pages) {
        for (const k of Object.keys(pages)) {
          if (pages[k]?.thumbnail?.source) return pages[k].thumbnail.source;
        }
      }
    }
  } catch(e) {}
  return '';
}

(async () => {
  console.log('Querying singers from remote D1...');
  const jsonOut = execSync('npx wrangler d1 execute sentinel-fame --remote --json --command="SELECT id, name FROM singers ORDER BY id ASC"', {
    cwd: __dirname,
    encoding: 'utf-8'
  });
  const data = JSON.parse(jsonOut);
  const rows = data[0]?.results || [];
  console.log(`Found ${rows.length} singers in D1. Fetching high-quality images...`);

  const sqlStatements = [];
  let successCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const img = await fetchWikiImage(row.name);
      if (img) {
        const escapedUrl = img.replace(/'/g, "''");
        sqlStatements.push(`UPDATE singers SET image_url = '${escapedUrl}' WHERE id = ${row.id};`);
        successCount++;
        console.log(`[${i + 1}/${rows.length}] ✅ ${row.name}`);
      } else {
        console.log(`[${i + 1}/${rows.length}] ⚠️ No image found for ${row.name}`);
      }
    } catch (err) {
      console.log(`[${i + 1}/${rows.length}] ❌ Error for ${row.name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 60));
  }

  const sqlFile = path.join(__dirname, 'backfill.sql');
  fs.writeFileSync(sqlFile, sqlStatements.join('\n'), 'utf-8');
  console.log(`\nGenerated backfill.sql with ${successCount} updates.`);
  console.log('Executing backfill.sql against remote D1 database...');

  execSync('npx wrangler d1 execute sentinel-fame --remote --file=./backfill.sql', {
    cwd: __dirname,
    stdio: 'inherit'
  });

  console.log('\n🎉 ALL DONE! D1 database has been updated with artist images.');
})();
