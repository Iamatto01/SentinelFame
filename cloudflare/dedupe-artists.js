const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  console.log('Fetching all singers from D1...');
  const jsonOut = execSync('npx wrangler d1 execute sentinel-fame --remote --json --command="SELECT id, name, country, genre, votes, image_url FROM singers ORDER BY id ASC"', {
    cwd: __dirname,
    encoding: 'utf-8'
  });
  const data = JSON.parse(jsonOut);
  const rows = data[0]?.results || [];
  console.log(`Loaded ${rows.length} singers.`);

  // Manual known alias mappings to merge into canonical name:
  // [duplicateNameRegex, canonicalName]
  const aliasRules = [
    [/^Adele Adkins$/i, 'Adele'],
    [/^Agnes Mo$/i, 'Agnez Mo'],
    [/^Agnez Mo \(Agnes Monica\)$/i, 'Agnez Mo'],
    [/^Hikaru Utada$/i, 'Utada Hikaru'],
    [/^The Weeknd Abel$/i, 'The Weeknd'],
    [/^Ke\$ha \/ Kesha$/i, 'Kesha'],
    [/^Girls\' Generation \(SNSD\)$/i, 'Girls\' Generation'],
    [/^Bunga Citra Lestari \(BCL\)$/i, 'Bunga Citra Lestari'],
    [/^Charice Pempengco \(Jake Zyrus\)$/i, 'Charice Pempengco'],
    [/^Arnel Pineda \(Journey\)$/i, 'Arnel Pineda'],
    [/^Peterpan \/ Noah \/ Ariel$/i, 'Noah'],
    [/^Peterpan$/i, 'Noah'],
    [/^Dewa 19 \/ Ahmad Dhani$/i, 'Dewa 19'],
    [/^Gigi \/ Armand Maulana$/i, 'Gigi'],
    [/^Padi \/ Fadly$/i, 'Padi'],
    [/^Kotak \/ Tantri$/i, 'Kotak'],
    [/^Ungu \/ Pasha$/i, 'Ungu'],
    [/^Kangen Band \/ Andika$/i, 'Kangen Band'],
    [/^Kahitna \/ Yovie Widianto$/i, 'Kahitna'],
    [/^Hindia \/ Feast$/i, 'Hindia'],
    [/^Payung Teduh \/ Pusakata$/i, 'Payung Teduh'],
    [/^Search$/i, 'Amy Search'],
    [/^Wings$/i, 'Awie'],
    [/^Kugiran Masdo$/i, 'Masdo'],
    [/^Hujan \/ Noh Salleh$/i, 'Hujan'],
    [/^Slam \/ Zamani$/i, 'Slam'],
    [/^Iklim \/ Saleem$/i, 'Iklim'],
    [/^Eraserheads \/ Ely Buendia$/i, 'Eraserheads'],
    [/^Parokya ni Edgar \/ Chito Miranda$/i, 'Parokya ni Edgar'],
    [/^Bamboo Manalac \/ Rivermaya$/i, 'Bamboo'],
    [/^Romeo Santos \/ Aventura$/i, 'Romeo Santos'],
    [/^Gloria Estefan \/ Miami Sound Machine$/i, 'Gloria Estefan'],
    [/^Buena Vista Social Club \/ Ibrahim Ferrer$/i, 'Buena Vista Social Club'],
    [/^Master KG \/ Nomcebo$/i, 'Master KG'],
    [/^Toots and the Maytals$/i, 'Toots & The Maytals'],
    [/^King \(Rocco\)$/i, 'King'],
  ];

  // Group by normalized name
  const nameMap = new Map(); // normalized -> array of rows

  function normalize(name) {
    let n = name.trim().toLowerCase();
    // Check alias rules first
    for (const [re, target] of aliasRules) {
      if (re.test(name.trim())) {
        n = target.toLowerCase();
        break;
      }
    }
    // Remove punctuation, slashes, brackets
    return n.replace(/[^a-z0-9]/g, '');
  }

  for (const row of rows) {
    const norm = normalize(row.name);
    if (!nameMap.has(norm)) nameMap.set(norm, []);
    nameMap.get(norm).push(row);
  }

  const deleteIds = [];
  const updateSql = [];
  let duplicateCount = 0;

  for (const [norm, group] of nameMap.entries()) {
    if (group.length > 1) {
      duplicateCount += (group.length - 1);
      // Pick best canonical record: one with highest votes, then one with image, then lowest id
      group.sort((a, b) => {
        if (b.votes !== a.votes) return b.votes - a.votes;
        const aHasImg = (a.image_url && a.image_url.length > 10) ? 1 : 0;
        const bHasImg = (b.image_url && b.image_url.length > 10) ? 1 : 0;
        if (bHasImg !== aHasImg) return bHasImg - aHasImg;
        return a.id - b.id;
      });

      const canonical = group[0];
      const dupes = group.slice(1);
      console.log(`Duplicate found for [${canonical.name}]: keeping ID ${canonical.id}, removing IDs: ${dupes.map(d => `${d.id} (${d.name})`).join(', ')}`);

      for (const d of dupes) {
        deleteIds.push(d.id);
        // Move votes to canonical if any
        if (d.votes > 0) {
          updateSql.push(`UPDATE singers SET votes = votes + ${d.votes} WHERE id = ${canonical.id};`);
        }
        // Update any payments or battles pointing to duplicate id
        updateSql.push(`UPDATE payments SET singer_id = ${canonical.id} WHERE singer_id = ${d.id};`);
        updateSql.push(`DELETE FROM singers WHERE id = ${d.id};`);
      }
    }
  }

  console.log(`\nFound ${duplicateCount} duplicate artist entries across database.`);
  if (updateSql.length === 0) {
    console.log('No duplicates to delete.');
    return;
  }

  const sqlFile = path.join(__dirname, 'dedupe.sql');
  fs.writeFileSync(sqlFile, updateSql.join('\n'), 'utf-8');
  console.log(`Generated dedupe.sql with ${updateSql.length} statements.`);

  console.log('Executing dedupe.sql on remote D1 database...');
  execSync('npx wrangler d1 execute sentinel-fame --remote --file=./dedupe.sql', {
    cwd: __dirname,
    stdio: 'inherit'
  });

  console.log('\n🎉 ALL DUPLICATES REMOVED AND MERGED SUCCESSFULLY!');
})();
