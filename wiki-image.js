// Fetch artist image from Wikipedia (primary) + fallback sources
// Uses multiple name variations and returns the best available thumbnail URL

async function fetchWikipediaImage(name) {
  if (!name) return '';

  // Try multiple search variations for better hit rate
  const variations = [name];
  // Try name after slash e.g. "Queen / Freddie Mercury" -> "Queen"
  const slashPart = name.split('/')[0].trim();
  if (slashPart && slashPart !== name) variations.push(slashPart);
  // Try name without parentheses e.g. "Lady Gaga (Stefani)" -> "Lady Gaga"
  const noParen = name.replace(/\([^)]*\)/g, '').trim();
  if (noParen && !variations.includes(noParen)) variations.push(noParen);

  for (const q of variations) {
    try {
      const url = await tryWikipedia(q);
      if (url) return url;
    } catch (e) { /* try next variation */ }
    await sleep(100);
  }
  return '';
}

async function tryWikipedia(query) {
  const encoded = encodeURIComponent(query);
  // Wikipedia REST API: search for page, then get thumbnail
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&srlimit=1&origin=*`;
  const searchRes = await fetch(searchUrl, {
    headers: { 'User-Agent': 'BestArtistVoting/2.0 (https://github.com; halloffame@example.com)' }
  });
  if (!searchRes.ok) return '';
  const searchData = await searchRes.json();
  const page = searchData?.query?.search?.[0];
  if (!page) return '';

  const pageTitle = encodeURIComponent(page.title);
  // Get page image
  const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${pageTitle}&prop=pageimages&pithumbsize=500&format=json&origin=*`;
  const imgRes = await fetch(imgUrl, {
    headers: { 'User-Agent': 'BestArtistVoting/2.0' }
  });
  if (!imgRes.ok) return '';
  const imgData = await imgRes.json();
  const pages = imgData?.query?.pages;
  if (!pages) return '';

  for (const key of Object.keys(pages)) {
    const thumb = pages[key]?.thumbnail?.source;
    if (thumb && !thumb.includes('.svg') && !thumb.includes('Ambox') && !thumb.includes('Disambig')) {
      return thumb;
    }
  }
  return '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchWikipediaImage };