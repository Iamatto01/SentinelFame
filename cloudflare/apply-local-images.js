// Bulk-assign local artist images.
// 1. Drop image files into  cloudflare/public/images/artists/
//    Name them by singer id OR a slug of the name, e.g.:
//      612.jpg                     (Kenshi Yonezu)
//      official-hige-dandism.jpg   (Official HIGE DANdism)
// 2. Run:  node apply-local-images.js
// It matches files in public/images/artists/ to singers that still have no
// image, points image_url at the local path, and updates remote D1.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const IMG_DIR = path.join(__dirname, 'public', 'images', 'artists');

function slug(name) {
  return name.toLowerCase()
    .replace(/\([^)]*\)/g, '')      // drop (..)
    .replace(/[^a-z0-9]+/g, '-')    // non-alnum -> -
    .replace(/^-+|-+$/g, '');       // trim -
}

(async () => {
  if (!fs.existsSync(IMG_DIR)) {
    console.log('No images folder. Create public/images/artists/ and drop files in.');
    return;
  }
  const files = fs.readdirSync(IMG_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  if (!files.length) {
    console.log('No image files found in public/images/artists/.');
    console.log('Add files named <id>.jpg or <slug>.jpg then re-run.');
    return;
  }

  const jsonOut = execSync('npx wrangler d1 execute sentinel-fame --remote --json --command="SELECT id, name FROM singers WHERE image_url IS NULL OR image_url = \'\' ORDER BY id"', {
    cwd: __dirname, encoding: 'utf-8'
  });
  const rows = JSON.parse(jsonOut)[0]?.results || [];

  const byId = new Map(), bySlug = new Map();
  for (const f of files) {
    const base = f.replace(/\.(jpe?g|png|webp)$/i, '').toLowerCase();
    if (/^\d+$/.test(base)) byId.set(parseInt(base, 10), f);
    bySlug.set(base, f);
  }

  const sql = [];
  for (const r of rows) {
    let file = byId.get(r.id) || bySlug.get(slug(r.name));
    // also try first part of "A / B"
    if (!file && r.name.includes('/')) file = bySlug.get(slug(r.name.split('/')[0]));
    if (file) {
      const url = `/images/artists/${file}`;
      sql.push(`UPDATE singers SET image_url = '${url}' WHERE id = ${r.id};`);
      console.log(`✅ ${r.name}  ->  ${url}`);
    } else {
      console.log(`⚠️  ${r.name}  (no matching file: try ${r.id}.jpg or ${slug(r.name)}.jpg)`);
    }
  }

  if (sql.length) {
    fs.writeFileSync(path.join(__dirname, 'local-images.sql'), sql.join('\n'), 'utf-8');
    console.log(`\nApplying ${sql.length} updates to remote D1...`);
    execSync('npx wrangler d1 execute sentinel-fame --remote --file=./local-images.sql', { cwd: __dirname, stdio: 'inherit' });
    fs.unlinkSync(path.join(__dirname, 'local-images.sql'));
    console.log('\nDone. Local images are served directly (no proxy needed).');
  } else {
    console.log('\nNothing matched. No DB changes made.');
  }
})();
