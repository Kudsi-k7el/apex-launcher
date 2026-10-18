'use strict';

/**
 * Store / Discover view.
 *
 * The curated front page: a search box, a featured hero carousel, the three
 * themed rows and a full "All Games" grid, all driven by CATALOG in data.js.
 * Titles the account owns can be installed from here; the rest link out to
 * their own store page.
 */

let slide = 0;
let slideTimer = null;

/** Curated catalogue games that are still available to install. */
const available = () => storeGames();

/** Live text in the store search box. */
let storeSearch = '';

// ---------------------------------------------------------------------------
// Live Steam store search
// ---------------------------------------------------------------------------
// The curated catalogue above is a short list; this searches the real Steam
// storefront so any of its tens of thousands of titles can be found. Results
// carry genuine AppIDs and prices and are metadata only — installing one still
// goes through the store that owns the licence.
let liveResults = [];
let liveBusy = false;
let liveError = null;
let liveTimer = null;
let repaintTimer = null;  // coalesces Store rebuilds while the user is typing
let liveFor = '';      // the query liveResults belongs to

/** Loose match across title, studio, genre, year and tags. */
function matchesQuery(g, q) {
  if (!q) return true;
  const hay = [g.title, g.developer, g.genre, g.release, ...(g.tags || [])].join(' ').toLowerCase();
  return hay.includes(q);
}

function storeCard(g, opts = {}) {
  const st = statusOf(g.id);
  const unowned = st === 'unowned';
  return `<article class="scard clickable${unowned ? ' is-unowned' : ''}" data-card="${g.id}" title="Open details">
    <div class="scard-art">
      ${art(g, 'wide')}
      ${isFree(g) ? `<span class="scard-badge free">Free</span>` : ''}
      ${st === 'notinstalled' ? `<span class="scard-badge owned">${icon('check', 12)} Owned</span>` : ''}
      ${unowned ? `<span class="scard-badge noown">${icon('lock', 12)} Not owned</span>` : ''}
      <button class="fav ${State.favorites[g.id] ? 'on' : ''}" data-act="fav" data-id="${g.id}" title="Favorite">${icon('heart', 15)}</button>
      <span class="card-open">${icon('arrowUpRight', 13)} Details</span>
    </div>
    <div class="scard-info">
      <div class="scard-title"><h4>${esc(g.title)}</h4>${platformBadge(g)}<span class="scard-year">${g.release}</span></div>
      <div class="scard-dev">${esc(g.developer)} &middot; ${fmtSize(g.size)}${isFree(g) ? '' : ` &middot; ${esc(g.price)}`}</div>
      <div class="tags">${(g.tags || []).slice(0, 2).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      ${consoleBadges(g)}
      <div class="actions" data-actions="${g.id}">${actionHtml(g.id, opts)}</div>
    </div>
  </article>`;
}

function storeRow(title, ico, ids, key) {
  const q = storeSearch.trim().toLowerCase();
  const games = ids.map(byId).filter((g) => g && !isInstalled(g.id) && matchesQuery(g, q));
  if (!games.length) return '';
  return `<section class="store-section">
    <div class="section-head">
      <h2 class="section-title">${icon(ico, 20)} ${title}</h2>
      <div class="row-nav">
        <button class="icon-btn sm" data-scroll="-1" data-target="${key}" title="Scroll left">${icon('left', 16)}</button>
        <button class="icon-btn sm" data-scroll="1" data-target="${key}" title="Scroll right">${icon('right', 16)}</button>
      </div>
    </div>
    <div class="store-row" id="${key}">${games.map((g) => storeCard(g)).join('')}</div>
  </section>`;
}

function renderStore(el) {
  clearInterval(slideTimer);
  clearTimeout(repaintTimer);

  const pool = available();

  // Everything from the curated list is installed -> nothing left to sell,
  // but the live Steam search must still work.
  if (!pool.length) {
    el.innerHTML = `
      <h1 class="page-title">Store</h1>
      ${favDock()}
      <div class="toolbar">
        <div class="search-box store-search">${icon('search', 16)}
          <input id="store-search" type="search" placeholder="Search the whole Steam store\u2026" value="${esc(storeSearch)}" spellcheck="false" autocomplete="off">
        </div>
      </div>
      <div class="empty show big">
        ${icon('checkCircle', 40)}
        <h3>Every curated game is already installed</h3>
        <p>New games you install will move straight into your Library. In the
        meantime, search above to browse the full Steam store.</p>
        <div class="empty-actions">
          <button class="btn primary glow" data-act="goto-library">${icon('library', 15)} Open Library</button>
        </div>
      </div>
      <div id="store-live"></div>`;

    const search = el.querySelector('#store-search');
    search.addEventListener('input', (e) => { storeSearch = e.target.value; queueLiveSearch(el); });
    if (storeSearch.trim().length >= 2) queueLiveSearch(el);
    return;
  }

  // Hero: featured titles that are still available, else the newest ones.
  // Owned titles are shown first so the opening slide is something playable.
  let feats = FEATURED.map(byId).filter((g) => g && !isInstalled(g.id));
  feats = [...feats.filter((g) => isOwned(g.id)), ...feats.filter((g) => !isOwned(g.id))];
  if (!feats.length) feats = [...pool].sort((a, b) => b.release - a.release).slice(0, 5);

  el.innerHTML = `
    <h1 class="page-title">Store</h1>
    ${favDock()}
    <div class="toolbar">
      <div class="search-box store-search">${icon('search', 16)}
        <input id="store-search" type="search" placeholder="Search ${pool.length} curated games and the whole Steam store\u2026" value="${esc(storeSearch)}" spellcheck="false" autocomplete="off">
      </div>
    </div>

    <div id="store-hero">
      <div class="carousel" id="carousel">
        ${feats.map((g, i) => `
          <div class="slide ${i === 0 ? 'active' : ''}" data-i="${i}">
            ${art(g, 'hero')}
            <div class="slide-shade"></div>
            <div class="slide-body">
              <span class="tag">${icon('sparkles', 14)} FEATURED</span>
              <h1>${esc(g.title)}</h1>
              <div class="slide-chips">
                <span class="meta-chip">${icon('user', 13)} ${esc(g.developer)}</span>
                <span class="meta-chip">${icon('calendar', 13)} ${g.release}</span>
                <span class="meta-chip">${icon('star', 13)} ${g.rating}</span>
                <span class="meta-chip">${icon('tag', 13)} ${esc(g.genre)}</span>
              </div>
              <p>${esc(g.blurb)}</p>
              <div class="slide-meta">${priceTag(g)} &middot; ${fmtSize(g.size)}</div>
              <div class="actions" data-actions="${g.id}">${actionHtml(g.id)}</div>
            </div>
          </div>`).join('')}
        <button class="car-btn left" data-car="-1" title="Previous">${icon('left', 22)}</button>
        <button class="car-btn right" data-car="1" title="Next">${icon('right', 22)}</button>
        <div class="dots">${feats.map((_, i) => `<i class="${i === 0 ? 'active' : ''}" data-dot="${i}"></i>`).join('')}</div>
      </div>
    </div>

    <div id="store-live"></div>
    <div id="store-body"></div>`;

  const search = el.querySelector('#store-search');
  // Typing must not rebuild the Store on every keystroke. Below the hero is the
  // whole curated catalogue: five carousels plus the All Games grid, which is
  // the same ~60 cards rendered twice. Re-creating that per character is the
  // single largest source of jank in this view, so the repaint is coalesced and
  // the live Steam search keeps its own, separate debounce.
  search.addEventListener('input', (e) => {
    storeSearch = e.target.value;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      paintStoreBody(el, pool);
    }, 90);
    queueLiveSearch(el);
  });

  paintStoreBody(el, pool);
  if (storeSearch.trim().length >= 2) queueLiveSearch(el);

  // Pause auto-advance while the pointer is over the hero
  const carousel = document.getElementById('carousel');
  if (carousel) {
    carousel.addEventListener('mouseenter', () => clearInterval(slideTimer));
    carousel.addEventListener('mouseleave', startCarousel);
  }

  slide = 0;
  goSlide(0);
  startCarousel();
}

/**
 * Renders everything below the hero: the curated rows plus the full grid.
 * Kept separate so typing in the search box never rebuilds the carousel.
 */
function paintStoreBody(el, pool) {
  const body = el.querySelector('#store-body');
  if (!body) return;

  const q = storeSearch.trim().toLowerCase();
  const list = pool.filter((g) => matchesQuery(g, q));

  const hero = el.querySelector('#store-hero');
  if (hero) hero.classList.toggle('is-hidden', !!q);

  if (!list.length) {
    body.innerHTML = `
      <div class="empty show big">
        ${icon('search', 40)}
        <h3>No games match that search</h3>
        <p>Nothing in the curated catalogue matches \u201c${esc(storeSearch.trim())}\u201d. Try another title,
        studio or genre \u2014 or use the live Steam results above.</p>
      </div>`;
    paintUpcoming(el);
    return;
  }

  const ownedCount = list.filter((g) => isOwned(g.id)).length;
  const lockedCount = list.length - ownedCount;

  body.innerHTML = `
    <div class="page-intro"><p>${list.length} title${list.length === 1 ? '' : 's'} shown &middot;
      <b>${ownedCount}</b> owned on this account and ready to install &middot;
      <b>${lockedCount}</b> not owned. Ownership is verified against your local Steam
      licence data and Epic manifests; for anything else Apex points you at the store page.</p></div>

    ${STORE_ROWS.map((row, i) => storeRow(row.title, row.ico, row.ids, `scroll-${i}`)).join('')}

    <section class="store-section">
      <div class="section-head">
        <h2 class="section-title">${icon('store', 20)} All Games</h2>
        <span class="section-note">${ownedCount} installable \u00b7 ${lockedCount} locked</span>
      </div>
      <div class="grid" id="store-grid">${list.map((g) => storeCard(g)).join('')}</div>
    </section>`;

  body.querySelectorAll('[data-scroll]').forEach((b) => b.addEventListener('click', () => {
    const row = document.getElementById(b.dataset.target);
    if (row) row.scrollBy({ left: +b.dataset.scroll * Math.max(340, row.clientWidth * 0.85), behavior: 'smooth' });
  }));

  paintUpcoming(el);
}

function goSlide(n) {
  const slides = document.querySelectorAll('.slide');
  if (!slides.length) return;
  slide = (n + slides.length) % slides.length;
  slides.forEach((s, i) => s.classList.toggle('active', i === slide));
  document.querySelectorAll('[data-dot]').forEach((d, i) => d.classList.toggle('active', i === slide));
}

function startCarousel() {
  clearInterval(slideTimer);
  slideTimer = setInterval(() => {
    if (typeof current !== 'undefined' && current === 'store') goSlide(slide + 1);
  }, 6000);
}

// ---------------------------------------------------------------------------
// Live Steam store search
// ---------------------------------------------------------------------------
/** Debounced: typing shouldn't hammer Valve's endpoint on every keystroke. */
function queueLiveSearch(el) {
  clearTimeout(liveTimer);
  const q = storeSearch.trim();
  if (q.length < 2) {
    liveResults = [];
    liveError = null;
    liveFor = '';
    paintStoreLive(el);
    return;
  }
  liveFor = q;
  liveBusy = true;
  liveError = null;
  paintStoreLive(el);
  liveTimer = setTimeout(() => runLiveSearch(el, q), 320);
}

async function runLiveSearch(el, q) {
  let res = null;
  try { res = await window.api.storeSearch(q); }
  catch (err) { res = { ok: false, error: err.message }; }

  // A newer keystroke has already superseded this request.
  if (liveFor !== q) return;

  liveBusy = false;
  if (res && res.ok) {
    liveResults = res.items || [];
    liveError = null;
  } else {
    liveResults = [];
    liveError = (res && res.error) || 'Search failed';
  }
  paintStoreLive(el);
}

/** Ordered image URLs for a live result, so a missing `header.jpg` is not fatal. */
function liveArtChain(it) {
  const a = it.art || {};
  const chain = [a.wide, a.hero, it.tinyImage].filter(Boolean);
  if (it.appId) steamArtChain(it.appId, 'wide').forEach((u) => { if (!chain.includes(u)) chain.push(u); });
  return chain;
}

/** Maps a live Steam result onto the catalogue shape so the art/badges match. */
function liveCard(it) {
  const known = allGames().find((g) => g.steamAppId && String(g.steamAppId) === String(it.appId));
  const installed = known ? isInstalled(known.id) : false;
  const owned = known ? isOwned(known.id) : false;
  const chain = liveArtChain(it);
  const alts = chain.slice(1);
  return `<article class="live-card" data-live="${esc(it.appId)}">
    <div class="live-art">
      ${chain.length ? `<img src="${esc(chain[0])}"${alts.length ? ` data-alt="${esc(alts.join('|'))}"` : ''} alt="" loading="lazy" draggable="false">` : ''}
      ${it.discountPct ? `<span class="live-off">-${it.discountPct}%</span>` : ''}
      ${installed ? `<span class="scard-badge owned">${icon('check', 12)} Installed</span>`
        : owned ? `<span class="scard-badge owned">${icon('check', 12)} Owned</span>` : ''}
    </div>
    <div class="live-info">
      <h4 title="${esc(it.name)}">${esc(it.name)}</h4>
      <div class="live-meta">
        ${it.metascore ? `<span class="live-score" title="Metascore">${it.metascore}</span>` : ''}
        <span class="live-price">${esc(it.priceLabel || '')}</span>
        ${it.listPrice ? `<span class="live-was">${esc(it.listPrice)}</span>` : ''}
      </div>
      <div class="live-actions">
        <button class="btn secondary sm" data-live-info="${esc(it.appId)}">${icon('info', 13)} Details</button>
        ${known
          ? `<button class="btn primary sm" data-act="install" data-id="${known.id}">${icon('download', 13)} Install</button>`
          : `<button class="btn primary sm" data-live-buy="${esc(it.url)}">${icon('external', 13)} Steam page</button>`}
      </div>
    </div>
  </article>`;
}

function paintStoreLive(el) {
  const box = el.querySelector('#store-live');
  if (!box) return;

  const q = storeSearch.trim();
  if (q.length < 2) { box.innerHTML = ''; return; }

  if (liveBusy) {
    box.innerHTML = `<section class="store-section">
      <div class="section-head"><h2 class="section-title">${icon('globe', 20)} Steam store</h2></div>
      <div class="live-status">${icon('refresh', 15)} Searching the Steam store for \u201c${esc(q)}\u201d\u2026</div>
    </section>`;
    return;
  }

  if (liveError) {
    box.innerHTML = `<section class="store-section">
      <div class="section-head"><h2 class="section-title">${icon('globe', 20)} Steam store</h2></div>
      <div class="live-status warn">${icon('warning', 15)} Could not reach the Steam store (${esc(liveError)}).
      Your own catalogue below still works.</div>
    </section>`;
    return;
  }

  if (!liveResults.length) {
    box.innerHTML = `<section class="store-section">
      <div class="section-head"><h2 class="section-title">${icon('globe', 20)} Steam store</h2></div>
      <div class="live-status">${icon('search', 15)} No Steam titles match \u201c${esc(q)}\u201d.</div>
    </section>`;
    return;
  }

  box.innerHTML = `<section class="store-section">
    <div class="section-head">
      <h2 class="section-title">${icon('globe', 20)} Steam store</h2>
      <span class="section-note">${liveResults.length} live result${liveResults.length === 1 ? '' : 's'} \u00b7 real AppIDs &amp; prices</span>
    </div>
    <div class="live-grid">${liveResults.map(liveCard).join('')}</div>
  </section>`;
}

/** Full record for one AppID, fetched on demand and shown in a dialog. */
async function openStorePreview(appId) {
  openModal({
    title: 'Loading store record\u2026',
    ico: 'store',
    body: `<div class="store-preview loading">${icon('refresh', 26)}<p>Fetching this title from the Steam store\u2026</p></div>`,
    onMount: async (root) => {
      const body = root.querySelector('.modal-body');
      const head = root.querySelector('.modal-head h3');

      const res = await window.api.storeDetails(appId);
      if (!res || !res.ok) {
        if (head) head.textContent = 'Store record unavailable';
        body.innerHTML = `<div class="store-preview"><p>${icon('warning', 20)} ${esc((res && res.error) || 'Could not load this title.')}</p></div>`;
        return;
      }

      const d = res.data;
      if (head) head.textContent = d.name;

      const known = allGames().find((g) => g.steamAppId && String(g.steamAppId) === String(d.appId));
      const facts = [
        d.developers.length ? ['Developer', d.developers.join(', ')] : null,
        d.publishers.length ? ['Publisher', d.publishers.join(', ')] : null,
        d.genres.length ? ['Genres', d.genres.join(', ')] : null,
        d.release ? ['Release', d.release] : null
      ].filter(Boolean);

      const heroChain = [d.header, d.art && d.art.wide, d.art && d.art.hero, d.art && d.art.cover]
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i);
      body.innerHTML = `
        <div class="store-preview">
          <div class="sp-hero">${heroChain.length ? `<img src="${esc(heroChain[0])}"${heroChain.length > 1 ? ` data-alt="${esc(heroChain.slice(1).join('|'))}"` : ''} alt="" draggable="false">` : ''}</div>
          <div class="sp-price">
            <span class="sp-now">${esc(d.priceLabel || '')}</span>
            ${d.listPrice ? `<span class="sp-was">${esc(d.listPrice)}</span>` : ''}
            ${d.discountPct ? `<span class="sp-off">-${d.discountPct}%</span>` : ''}
            ${d.comingSoon ? `<span class="sp-soon">${icon('hourglass', 13)} Coming soon</span>` : ''}
          </div>
          <p class="sp-desc">${esc(d.shortDescription)}</p>
          <dl class="sp-facts">
            ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
            <div><dt>AppID</dt><dd>${esc(d.appId)}</dd></div>
          </dl>
          ${d.screenshots.length ? `<div class="sp-shots">${d.screenshots.slice(0, 3).map((s) => `<img src="${esc(s)}" alt="" loading="lazy" draggable="false">`).join('')}</div>` : ''}
          <div class="sp-actions">
            <button class="btn secondary" data-live-buy="${esc(d.url)}">${icon('external', 15)} Open on Steam</button>
            ${known ? `<button class="btn primary glow" data-act="install" data-id="${known.id}">${icon('download', 15)} Install</button>`
              : `<button class="btn primary glow" data-live-add="${esc(d.appId)}" data-live-name="${esc(d.name)}">${icon('plus', 15)} Add to my library</button>`}
          </div>
          <p class="sp-note">${icon('shield', 13)} ${d.comingSoon
            ? 'Not released yet — the Steam page is where a pre-order is placed.'
            : 'Apex shows this title\'s real store data. Buying and downloading stay with Steam.'}</p>
        </div>`;
    }
  });
}

// ---------------------------------------------------------------------------
// Upcoming & pre-orders
// ---------------------------------------------------------------------------
function paintUpcoming(el) {
  const body = el.querySelector('#store-body');
  if (!body) return;

  // Only shown on the unfiltered front page.
  const q = storeSearch.trim().toLowerCase();
  const games = upcomingGames().filter((g) => !q || matchesQuery(g, q));
  if (!games.length) return;

  const section = document.createElement('section');
  section.className = 'store-section';
  section.innerHTML = `
    <div class="section-head">
      <h2 class="section-title">${icon('hourglass', 20)} Upcoming &amp; Pre-orders</h2>
      <span class="section-note">announced \u00b7 not released on PC yet</span>
    </div>
    <div class="upcoming-row">${games.map(upcomingCard).join('')}</div>`;
  body.prepend(section);

  if (q) {
    // A search is active: fold the upcoming matches into the filtered view.
    const hero = el.querySelector('#store-hero');
    if (hero) hero.classList.add('is-hidden');
  }
}

function upcomingCard(g) {
  const onList = typeof isPreordered === 'function' && isPreordered(g.id);
  const iso = typeof releaseDateOf === 'function' ? releaseDateOf(g.id) : null;
  // The art is a 16:9 header across the top of the card (see catalog.css), which
  // is the shape these key visuals are actually drawn in — so nothing is cropped
  // to a strip. The release label lives in the info column, where a long line
  // like "PS5 & Xbox Series X|S · 19 Nov 2026" has room to sit on one line.
  const flag = onList
    ? `<span class="up-flag on">${icon('check', 12)} Pre-ordered</span>`
    : `<span class="up-flag soon">${icon('hourglass', 12)} ${esc(g.release || 'TBA')}</span>`;
  return `<article class="upcoming-card">
    <div class="up-art">${art(g, 'cover')}
      ${flag}
    </div>
    <div class="up-info">
      <h4>${esc(g.title)}</h4>
      <p class="up-dev">${esc(g.developer)}</p>
      <p class="up-blurb">${esc(g.blurb)}</p>
      <div class="up-meta">
        <span>${icon('calendar', 12)} ${esc(g.releaseLabel || 'Unreleased')}</span>
        <span class="price">${icon('tag', 12)} ${esc(g.price || 'TBA')}</span>
      </div>
      ${consoleBadges(g)}
      ${iso ? `<div class="cd-row">${countdownHtml(iso, { big: true })}</div>` : ''}
      <div class="actions" data-actions="${g.id}">${actionHtml(g.id)}</div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Adding a live Steam result to the local library
// ---------------------------------------------------------------------------
/**
 * Turns a live store result into a catalogue entry the rest of the app can
 * work with. It is *not* an install: the entry is registered so the user can
 * track the title, and the Store then offers the normal ownership-gated
 * actions for it.
 */
async function addLiveGame(appId, name) {
  const known = allGames().find((g) => g.steamAppId && String(g.steamAppId) === String(appId));
  if (known) { closeModal(); refreshActions(); toast(`${known.title} is already in your catalogue`, 'info'); return; }

  const res = await window.api.storeDetails(appId).catch(() => null);
  const d = res && res.ok ? res.data : null;

  const g = makeCustomGame({
    title: (d && d.name) || name || `Steam app ${appId}`,
    developer: (d && d.developers && d.developers[0]) || 'Steam',
    genre: (d && d.genres && d.genres[0]) || 'Steam',
    imageUrl: (d && d.art && d.art.cover) || null
  });
  g.steamAppId = String(appId);
  g.price = (d && d.priceLabel) || 'See Steam';
  if (d && d.release) g.release = Number(String(d.release).slice(-4)) || g.release;
  // An exact release day (when Steam published one) powers the countdown.
  if (d && d.releaseIso) g.releaseDate = d.releaseIso;
  g.blurb = (d && d.shortDescription) || g.blurb;
  if (d && d.art) { g.cover = d.art.cover; g.wide = d.art.wide; g.hero = d.art.hero; }
  g.tags = ['Steam', 'Catalogue'];

  State.custom = State.custom || [];
  State.custom.push(g);
  // Owned is decided by the real scan, never assumed here.
  await persist();
  closeModal();
  afterLibraryChange();
  toast(`${g.title} added to your catalogue \u2014 run a scan to check ownership`, 'check');
  return g;
}
