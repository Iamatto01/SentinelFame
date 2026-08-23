/* Best Artist â€” fullscreen hero + tree-root leaderboard logic */
const state = {
  offset: 0,          // next row index to render (starts after podium top3)
  pageSize: 10,       // rows per batch
  preload: null,      // prefetched next batch
  loading: false,
  currentSinger: null,
  methods: {},
  all: []             // cached full list for search/autocomplete
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avatar = (s) => s.image_url || `https://ui-avatars.com/api/?background=16130e&color=f5f0e6&bold=true&name=${encodeURIComponent(s.name)}`;

// ================= HERO =================
async function loadHero() {
  // In country-filter mode, reuse the already-filtered list
  const singers = state.countryMode ? state.all : await fetch('/api/singers?limit=12').then(r => r.json());
  if (!state.countryMode) state.all = singers;
  const champ = singers[0];
  if (!champ) return;

  // Champion tag — GLOBAL vs COUNTRY mode
  const tag = $('#champTag');
  if (tag) {
    tag.textContent = state.countryMode
      ? `👑 ${state.countryName.toUpperCase()} FAMOUS NUMBER ONE #1`
      : '👑 GLOBAL FAMOUS NUMBER ONE #1';
  }

  // Champion name + votes
  $('#champName').textContent = champ.name;
  $('#champVotes').textContent = `${champ.votes.toLocaleString()} VOTES · ${champ.country || ''}`;

  // Left portrait — first image, then the random-effect swap loop takes over
  const img = $('#heroImg');
  img.onerror = () => {
    img.src = `https://ui-avatars.com/api/?background=000000&color=d93a26&bold=true&name=${encodeURIComponent(champ.name)}`;
  };
  img.src = `/api/proxy-image?url=${encodeURIComponent(avatar(champ))}`;

  // Start the random-effect portrait swapper with the top artists
  initPortraitSwapper(singers.slice(0, 5));

  // Ticker: load live vote feed
  loadTicker();

  // Top 5 carousel cards (bottom-right)
  renderTop5(singers.slice(0, 5));

  // YouTube video of #1 song (top-right)
  loadChampVideo(champ.name);
}

// ================= PORTRAIT SWAPPER =================
// One image at a time. Every few seconds it swaps to the next artist
// portrait using ONE randomly-picked transition/effect.
const SWAP_EFFECTS = ['fade', 'zoom-pan', 'glitch', 'shake', 'pop', 'distort'];
let swapTimer = null;

function initPortraitSwapper(singers) {
  if (!singers || singers.length < 2) return;
  const img = $('#heroImg');
  const wrap = $('#heroPortrait');
  if (!img || !wrap) return;

  let idx = 0;
  const urls = singers.map(s => `/api/proxy-image?url=${encodeURIComponent(avatar(s))}`);
  urls.forEach(u => { const i = new Image(); i.src = u; }); // preload

  function applyEffect(effect) {
    wrap.classList.remove('fx-fade', 'fx-zoom-pan', 'fx-glitch', 'fx-shake', 'fx-pop', 'fx-distort');
    void wrap.offsetWidth; // force reflow so animations restart
    wrap.classList.add('fx-' + effect);
  }

  function swap() {
    idx = (idx + 1) % urls.length;
    const effect = SWAP_EFFECTS[Math.floor(Math.random() * SWAP_EFFECTS.length)];

    applyEffect(effect); // OUT animation

    setTimeout(() => {
      img.src = urls[idx];
      const onReady = () => {
        img.removeEventListener('load', onReady);
        applyEffect(effect); // IN animation, same effect
      };
      img.addEventListener('load', onReady);
      if (img.complete) onReady();
    }, 420); // matches out-animation duration in CSS
  }

  clearInterval(swapTimer);
  swapTimer = setInterval(swap, 5000);
}
function renderTop5(top5) {
  const cards = top5.map((s, i) => `
    <div class="top5-card" onclick="openVote(${s.id})" title="${esc(s.name)}">
      <span class="top5-badge r${i+1}">${i+1}</span>
      <img src="${esc(avatar(s))}" alt="" loading="lazy"
           onerror="this.src='https://ui-avatars.com/api/?background=000&color=f0c040&bold=true&size=80&name=${encodeURIComponent(s.name)}'">
      <div class="top5-card-label">${esc(s.name)}</div>
    </div>
  `).join('');
  $('#top5Track').innerHTML = cards;
}

// ================= LIVE TICKER =================
async function loadTicker() {
  try {
    const votes = await fetch('/api/recent-votes').then(r => r.json());
    if (!votes.length) {
      $('#tickerTrack').innerHTML = '<span class="ticker-item"><span class="t-dot">â—</span> No votes yet â€” be the first!</span>';
      return;
    }
    const items = votes.map(v =>
      `<span class="ticker-item">
        <span class="t-dot">â—</span>
        <span class="t-voter">${esc(v.voter_name || 'Anon')}</span>
        voted
        <span class="t-amount">$${(v.amount_cents / 100).toFixed(0)}</span>
        to <span class="t-singer">${esc(v.singer_name)}</span>
      </span>`
    ).join('');
    // Duplicate for seamless loop
    $('#tickerTrack').innerHTML = items + items;
  } catch { $('#tickerTrack').innerHTML = '<span class="ticker-item">â— LIVE VOTES LOADINGâ€¦</span>'; }
}

async function loadChampVideo(name) {
  try {
    const { videoId } = await fetch(`/api/youtube-search?q=${encodeURIComponent(name)}`).then(r => r.json());
    if (videoId) {
      $('#videoFrame').innerHTML =
        `<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&rel=0&playsinline=1"
                 allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    } else {
      $('#videoFrame').innerHTML = '<div class="video-off">â™ª radio offline</div>';
    }
  } catch { $('#videoFrame').innerHTML = '<div class="video-off">â™ª radio offline</div>'; }
}

// ================= PODIUM (top 3) =================
function renderPodium(top3) {
  const order = [1, 0, 2]; // 2nd, 1st, 3rd
  $('#podium').innerHTML = order.map(i => {
    const s = top3[i];
    if (!s) return '';
    return `
    <div class="pod-card rank-${i + 1}" onclick="openVote(${s.id})">
      ${i === 0 ? '<span class="pod-crown">ðŸ‘‘</span>' : ''}
      <span class="pod-rank">${i + 1}</span>
      <img src="${esc(avatar(s))}" alt="${esc(s.name)}" onerror="this.src='https://ui-avatars.com/api/?background=16130e&color=f5f0e6&bold=true&name=${encodeURIComponent(s.name)}'">
      <div class="pod-body">
        <div class="pod-name">${esc(s.name)}</div>
        <div class="pod-votes"><b>${s.votes.toLocaleString()}</b> VOTES</div>
      </div>
    </div>`;
  }).join('');
}

// ================= TREE-ROOT LIST =================
// Each row is a "root": alternating left/right drift, depth grows downward.
function renderRootRows(singers, startRank) {
  const html = singers.map((s, i) => {
    const rank = startRank + i + 1;
    const side = i % 2 === 0 ? 'left' : 'right';
    return `
    <div class="root-row ${side}" onclick="openVote(${s.id})">
      <div class="root-node"></div>
      <div class="root-card">
        <span class="root-rank">#${rank}</span>
        <img src="${esc(avatar(s))}" alt="" loading="lazy"
             onerror="this.src='https://ui-avatars.com/api/?background=d93a26&color=f5f0e6&bold=true&name=${encodeURIComponent(s.name)}'">
        <div class="root-info">
          <div class="root-name">${esc(s.name)}</div>
          <div class="root-meta">${esc(s.genre || '')} Â· ${esc(s.country || '')}</div>
        </div>
        <div class="root-votes"><b>${s.votes.toLocaleString()}</b> VOTES</div>
      </div>
    </div>`;
  }).join('');
  $('#rootList').insertAdjacentHTML('beforeend', html);
}

// Fetch next batch with one-batch-ahead preload.
// In country-filter mode, serve from the filtered cache instead of the API.
async function fetchBatch() {
  if (state.countryMode) {
    return state.all.slice(state.offset, state.offset + state.pageSize);
  }
  const url = `/api/singers?limit=${state.pageSize}&offset=${state.offset}`;
  if (state.preload && state.preload.url === url) {
    const singers = await state.preload.promise;
    state.preload = null;
    return singers;
  }
  return fetch(url).then(r => r.json());
}

function preloadNext() {
  if (state.countryMode) return; // everything is already cached
  const url = `/api/singers?limit=${state.pageSize}&offset=${state.offset}`;
  if (!state.preload) {
    state.preload = { url, promise: fetch(url).then(r => r.json()) };
  }
}

async function growRoots() {
  if (state.loading) return;
  state.loading = true;
  $('#sentinel').classList.add('active');
  const singers = await fetchBatch();
  if (singers.length) {
    renderRootRows(singers, state.offset);
    state.offset += singers.length;
  }
  preloadNext(); // always keep the next 10 ready
  $('#sentinel').classList.remove('active');
  state.loading = false;
}

// Infinite scroll observer
const io = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) growRoots();
}, { rootMargin: '600px 0px' }); // trigger well before reaching bottom

// ================= PUSH PANEL =================
async function initAutocomplete() {
  const singers = await fetch('/api/singers?limit=300').then(r => r.json());
  state.all = singers;
  $('#singerList').innerHTML = singers.map(s => `<option value="${esc(s.name)}">`).join('');
}

// ================= SEARCH DIALOG =================
async function openSearch() {
  $('#searchModal').classList.remove('hidden');
  const input = $('#searchInput');
  input.value = '';
  renderSearchResults('');
  setTimeout(() => input.focus(), 60);
  // Refresh full artist list in background (cache may be stale or partial)
  try {
    const fresh = await fetch('/api/singers?limit=500').then(r => r.json());
    if (fresh.length > (state.all?.length || 0)) {
      state.all = fresh;
      renderSearchResults(input.value);
    }
  } catch { /* keep cached list */ }
}
function closeSearch() { $('#searchModal').classList.add('hidden'); }
$('#searchModal')?.addEventListener('click', e => { if (e.target.id === 'searchModal') closeSearch(); });

function renderSearchResults(q) {
  const query = q.trim().toLowerCase();
  const pool = state.all || [];
  const matches = query
    ? pool.filter(s => s.name.toLowerCase().includes(query))
    : pool;
  const grid = $('#searchGrid');

  // Cap rendering to avoid overlapping/lag with hundreds of cards
  const MAX_SHOWN = 30;
  const shown = matches.slice(0, MAX_SHOWN);

  $('#searchCount').textContent = matches.length > MAX_SHOWN
    ? `${matches.length} ARTISTS FOUND · SHOWING TOP ${MAX_SHOWN} · KEEP TYPING TO NARROW`
    : query
      ? `${matches.length} ARTIST${matches.length === 1 ? '' : 'S'} MATCHED "${q.trim().toUpperCase()}"`
      : `ALL ${matches.length} ARTISTS · CLICK A CARD TO VOTE`;

  if (!matches.length) {
    grid.innerHTML = `<p style="grid-column:1/-1;color:rgba(245,240,230,.5);text-align:center;padding:40px 0;font-size:.9rem">
      😢 No artist found for "<b>${esc(q)}</b>"</p>`;
    return;
  }

  grid.innerHTML = shown.map((s, i) => `
    <div class="s-card" onclick="openVote(${s.id})" title="${esc(s.name)}">
      <img src="${esc(avatar(s))}" alt="" loading="lazy"
           onerror="this.src='https://ui-avatars.com/api/?background=000&color=f0c040&bold=true&size=160&name=${encodeURIComponent(s.name)}'">
      <span class="s-card-votes">${s.votes.toLocaleString()} ♡</span>
      <div class="s-card-label">${esc(s.name)}</div>
    </div>
  `).join('');
}

// Debounced live filter — re-renders only after the user stops typing (~350ms)
let searchDebounce = null;
$('#searchInput')?.addEventListener('input', e => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderSearchResults(e.target.value), 350);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#searchModal').classList.contains('hidden')) closeSearch();
  if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) &&
      $('#voteModal').classList.contains('hidden') &&
      document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    openSearch();
  }
});

// ================= VOTING MODAL â€” MASSIVE =================
async function openVote(id, presetVotes) {
  const s = await fetch(`/api/singers/${id}`).then(r => r.json());
  state.currentSinger = s;
  // Left: full image
  $('#mImg').src = avatar(s);
  $('#mImg').onerror = () => { $('#mImg').src = `https://ui-avatars.com/api/?background=000&color=d93a26&bold=true&size=400&name=${encodeURIComponent(s.name)}`; };
  // Right: header
  $('#mName').textContent = s.name;
  $('#mMeta').textContent = `${s.country || 'Unknown'} Â· ${s.votes.toLocaleString()} votes`;
  $('#mGenre').textContent = s.genre || '';
  $('#mGenre').style.display = s.genre ? 'inline-block' : 'none';
  // Votes
  $('#totalAmt').textContent = (presetVotes || 1).toFixed(2); // currency format
  updateTotal();
  $('#payMsg').textContent = '';
  $('#voterMessage').value = ''; // clear previous message
  $('#msgArtistName').textContent = s.name.toUpperCase();
  state.methods = await fetch('/api/payment-methods').then(r => r.json());

  // Preload crypto config
  try {
    state.cryptoConfig = await fetch('/api/crypto-config').then(r => r.json());
    $('#cryptoCoin').textContent = state.cryptoConfig.currency || 'USDT';
    $('#cryptoAddr').textContent = state.cryptoConfig.wallet || 'Not configured';
  } catch { state.cryptoConfig = null; }

  // Reset to Stripe tab
  switchPayTab('stripe');

  // Bottom: Bio, Top Song, Social, Donations
  loadBio(s);
  loadTopSong(s);
  loadSocial(s);
  loadDonations(s.id);

  $('#voteModal').classList.remove('hidden');
}

async function loadBio(s) {
  let bio = s.bio;
  if (!bio) {
    // Try Wikipedia
    try {
      const r = await fetch(`/api/wiki-bio?q=${encodeURIComponent(s.name)}`).then(r => r.json());
      if (r.bio) bio = r.bio;
    } catch { /* fallback */ }
  }
  if (!bio) {
    bio = `${s.name} is a ${s.genre || 'music'} artist${s.country ? ' from ' + s.country : ''}. Vote to support them on the Hall of Fame chart!`;
  }
  $('#mBio').textContent = bio;
}

async function loadTopSong(s) {
  try {
    const { videoId } = await fetch(`/api/youtube-search?q=${encodeURIComponent(s.name)}`).then(r => r.json());
    if (videoId) {
      $('#mSongEmbed').innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}?rel=0" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
      document.querySelector('.m-song-name').textContent = `"${s.name} â€” Top Track"`;
    } else {
      $('#mSongEmbed').innerHTML = '<p style="color:#999">No video found</p>';
    }
  } catch { $('#mSongEmbed').innerHTML = '<p style="color:#999">No video found</p>'; }
}

function loadSocial(s) {
  const q = encodeURIComponent(s.name);
  $('#mWiki').href = `https://en.wikipedia.org/wiki/${q.replace(/%20/g, '_')}`;
  $('#mYT').href = `https://www.youtube.com/results?search_query=${q}`;
  $('#mSpotify').href = `https://open.spotify.com/search/${q}`;
}

// ================= FAN DONATIONS =================
let donationsCache = [];
let donationSort = 'latest';

async function loadDonations(singerId) {
  donationsCache = [];
  donationSort = 'latest';
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'latest'));
  try {
    donationsCache = await fetch(`/api/singers/${singerId}/donations`).then(r => r.json());
  } catch { donationsCache = []; }
  renderDonations();
}

function renderDonations() {
  const listEl = $('#donationsList');
  const topEl = $('#topDonorsList');
  if (!listEl || !topEl) return;

  const withMsg = donationsCache.filter(d => (d.voter_message || '').trim());

  // Column 2: fan comments — sorted latest / highest
  const sorted = [...withMsg].sort((a, b) => donationSort === 'highest'
    ? (b.amount_cents - a.amount_cents)
    : new Date(b.created_at) - new Date(a.created_at));

  listEl.innerHTML = sorted.length
    ? sorted.map(d => `
      <div class="donation-item">
        <div class="d-head">
          <span class="d-name">${esc(d.voter_name || 'Anonymous')}</span>
          <span class="d-amt">$${(d.amount_cents / 100).toFixed(2)}</span>
        </div>
        <div class="d-msg">"${esc(d.voter_message)}"</div>
        <div class="d-date">${new Date(d.created_at).toLocaleDateString()} · ${d.vote_count} vote${d.vote_count > 1 ? 's' : ''}</div>
      </div>`).join('')
    : '<p class="muted" style="font-size:.8rem">No fan messages yet — be the first! 💬</p>';

  // Column 3: top donors by amount (all, with or without message)
  const top = [...donationsCache].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 10);
  topEl.innerHTML = top.length
    ? top.map((d, i) => `
      <div class="donation-item">
        <div class="d-head">
          <span class="d-name">${i + 1}. ${esc(d.voter_name || 'Anonymous')}</span>
          <span class="d-amt">$${(d.amount_cents / 100).toFixed(2)}</span>
        </div>
        ${d.voter_message ? `<div class="d-msg">"${esc(d.voter_message)}"</div>` : ''}
      </div>`).join('')
    : '<p class="muted" style="font-size:.8rem">No donations yet.</p>';
}

function sortDonations(mode) {
  donationSort = mode;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  renderDonations();
}

function closeModal() { $('#voteModal').classList.add('hidden'); }
$('#voteModal')?.addEventListener('click', e => { if (e.target.id === 'voteModal') closeModal(); });

// ---------- Editable TOTAL amount (currency style) ----------
// The total is the source of truth: typing $12.50 = 12 votes ($1 each).
let totalEditing = false;

function getVotes() {
  // Votes derive from the editable total ($1 = 1 vote)
  const raw = parseFloat(($('#totalAmt')?.textContent || '1').replace(/[^0-9.]/g, ''));
  return isNaN(raw) || raw < 1 ? 1 : Math.round(raw);
}
function setVotes(n) {
  const el = $('#totalAmt');
  if (el) el.textContent = (+n).toFixed(2);
  clearCustomChip();
  document.querySelectorAll('.vote-picker button').forEach(b => b.classList.toggle('active', +b.dataset.v === +n));
  updateTotal();
}

// Mark all preset buttons unselected and show a "CUSTOM" chip in the picker
function markCustomTotal() {
  const picker = document.querySelector('.vote-picker');
  if (!picker) return;
  document.querySelectorAll('.vote-picker button').forEach(b => b.classList.remove('active'));
  let chip = picker.querySelector('.custom-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'custom-chip';
    picker.appendChild(chip);
  }
  chip.textContent = 'CUSTOM';
  chip.style.display = 'inline-flex';
}

// Hide the CUSTOM chip (used when a preset is clicked again)
function clearCustomChip() {
  const chip = document.querySelector('.vote-picker .custom-chip');
  if (chip) chip.style.display = 'none';
}

function getTotalAmount() {
  if (!totalEditing) {
    const raw = parseFloat(($('#totalAmt')?.textContent || '1').replace(/[^0-9.]/g, ''));
    if (!isNaN(raw) && raw > 0) return Math.round(raw * 100) / 100;
  }
  return getVotes();
}

function updateTotal() {
  const amount = getTotalAmount();
  // Null-safe: some amount displays may be removed from the layout
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('#stripeAmtBtn', amount.toFixed(2));
  set('#cryptoAmtDollar', `$${amount.toFixed(2)}`);
}

function initEditableTotal() {
  const el = $('#totalAmt');
  if (!el) return;

  // Only digits + one dot while typing
  el.addEventListener('input', () => {
    let clean = el.textContent.replace(/[^0-9.]/g, '');
    const parts = clean.split('.');
    if (parts.length > 2) clean = parts[0] + '.' + parts.slice(1).join('');
    if (el.textContent !== clean) el.textContent = clean;
    // Place caret at end after sanitizing
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    markCustomTotal(); // manual edit → unselect presets, show CUSTOM
    updateTotal();
  });

  el.addEventListener('focus', () => { totalEditing = true; });

  el.addEventListener('blur', () => {
    totalEditing = false;
    // Normalize to currency format on exit
    let raw = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
    if (isNaN(raw) || raw < 1) raw = 1;
    raw = Math.round(raw * 100) / 100;
    el.textContent = raw.toFixed(2);
    // If the final amount matches a preset, re-select that button instead
    const presetBtn = [...document.querySelectorAll('.vote-picker button')]
      .find(b => +b.dataset.v === Math.round(raw));
    if (presetBtn) {
      clearCustomChip();
      document.querySelectorAll('.vote-picker button').forEach(b => b.classList.remove('active'));
      presetBtn.classList.add('active');
    } else {
      markCustomTotal();
    }
    updateTotal();
  });

  // Enter = commit & blur; Escape = revert
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') {
      el.textContent = getVotes().toFixed(2);
      el.blur();
    }
  });
}
initEditableTotal();

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function payStripe() {
  const r = await postJSON('/api/pay/stripe', { singerId: state.currentSinger.id, votes: getVotes(), voterName: $('#voterName').value, voterMessage: $('#voterMessage').value });
  if (r.url) location.href = r.url; else showMsg(r.error || 'Stripe not configured');
}

// ================= PAYMENT TABS =================
function switchPayTab(tab) {
  document.querySelectorAll('.pay-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.pay-panel').forEach(p => p.classList.toggle('active', p.id === `payPanel${tab.charAt(0).toUpperCase() + tab.slice(1)}`));
  $('#payMsg').textContent = '';
}

// ================= CRYPTO PAYMENT =================
function copyCrypto() {
  const addr = $('#cryptoAddr').textContent;
  navigator.clipboard.writeText(addr).then(() => showMsg('Address copied! âœ“')).catch(() => showMsg('Copy failed'));
}
async function confirmCrypto() {
  const r = await postJSON('/api/pay/crypto', { singerId: state.currentSinger.id, votes: getVotes(), voterName: $('#voterName').value, voterMessage: $('#voterMessage').value });
  if (r.ok) { showMsg('Thank you! Payment received â€” votes counted!'); setTimeout(closeModal, 2000); }
  else showMsg(r.error || 'Confirmation failed');
}
function showMsg(t) { $('#payMsg').textContent = t; }

// The hero is sticky. As you scroll, it irises CLOSE (circle shrinks) and the
// leaderboard scrolls up over a dark backdrop â€” React Bits "Scroll Mask" style.
(function initScrollMask() {
  const hero = $('#hero');
  const roots = $('#roots');
  if (!hero || !roots) return;

  let ticking = false;
  function update() {
    ticking = false;
    const vh = window.innerHeight;
    // progress: 0 while hero fully on screen â†’ 1 after scrolling one viewport
    const raw = window.scrollY / vh;
    const progress = Math.min(1, Math.max(0, raw));
    // hero-mask: 1 â†’ 0 as you scroll away
    hero.style.setProperty('--hero-mask', (1 - progress).toFixed(3));
    // Only interactive when (mostly) visible â€” avoids blocking leaderboard clicks
    hero.classList.toggle('hero-active', progress < 0.85);
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
})();

// ================= COUNTRY FILTER =================
// /country/USA → same homepage, but every artist list is filtered to that country.
function countryFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'country' || parts.length < 2) return '';
  return decodeURIComponent(parts.slice(1).join('/')).trim();
}

// ================= TOP NAV MENU =================
function initTopNav(currentCountry) {
  // Highlight active nav item
  if (currentCountry) {
    const dropBtn = document.querySelector('.nav-drop-btn');
    if (dropBtn) { dropBtn.classList.add('current'); dropBtn.textContent = currentCountry.toUpperCase() + ' ▾'; }
  }

  const panel = $('#countryPanel');
  const drop = $('#navCountryDrop');
  const list = $('#countryList');
  if (!panel || !drop || !list) return;

  // Load countries once
  let countries = [];
  const renderList = (q = '') => {
    const query = q.trim().toLowerCase();
    const shown = query ? countries.filter(c => c.country.toLowerCase().includes(query)) : countries;
    list.innerHTML = shown.length
      ? shown.map(c => `
        <div class="country-item" onclick="location.href='/country/${encodeURIComponent(c.country)}'">
          <span>${esc(c.country)}</span><span class="n">${c.artists} ♪</span>
        </div>`).join('')
      : '<div class="country-item">No country found</div>';
  };

  fetch('/api/countries').then(r => r.json()).then(cs => {
    countries = cs;
    renderList();
  }).catch(() => {});

  // Toggle panel on button click (click-only, like a normal dropdown)
  document.querySelector('.nav-drop-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = panel.classList.toggle('open');
    if (isOpen) {
      $('#countryFilter').value = '';
      renderList();
      setTimeout(() => $('#countryFilter').focus(), 50);
    }
  });

  // Filter as you type
  $('#countryFilter')?.addEventListener('input', e => renderList(e.target.value));

  // Close when clicking outside or pressing Escape
  document.addEventListener('click', e => {
    if (!drop.contains(e.target)) panel.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') panel.classList.remove('open');
  });
}

// ================= INIT =================
(async () => {
  const country = countryFromUrl();
  const qs = country ? `&search=${encodeURIComponent(country)}` : '';
  const top = await fetch(`/api/singers?limit=300${qs}`).then(r => r.json());
  // search matches name OR country OR genre — keep only exact-country hits for the filter
  state.all = country ? top.filter(s => (s.country || '').toLowerCase() === country.toLowerCase()) : top;

  if (country) {
    state.countryMode = true;
    state.countryName = country;
    document.title = `${country.toUpperCase()} — HALL OF FAME`;
  }
  initTopNav(country);

  loadHero();
  renderPodium(state.all.slice(0, 3));
  state.offset = 3;
  growRoots();
  io.observe($('#sentinel'));

  // Refresh ticker every 15s for live vote updates
  setInterval(loadTicker, 15000);
})();
