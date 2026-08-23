const Database = require('better-sqlite3');
const db = new Database('f:/INI KALI LA/data/votes.db');
const r = db.prepare("SELECT COUNT(*) as c FROM singers WHERE image_url IS NOT NULL AND image_url != ''").get();
const t = db.prepare("SELECT COUNT(*) as c FROM singers").get();
console.log('Images: ' + r.c + ' / ' + t.c + ' (' + Math.round(r.c/t.c*100) + '%)');
// Show top 10 still missing
const m = db.prepare("SELECT name FROM singers WHERE image_url IS NULL OR image_url = '' ORDER BY votes DESC LIMIT 10").all();
console.log('Still missing: ' + m.length + ' total. First 10:');
m.forEach(s => console.log('  - ' + s.name));
process.exit(0);