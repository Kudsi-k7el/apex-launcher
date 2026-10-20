'use strict';

/**
 * The gaming feed.
 *
 * Articles come from news.instant-gaming.com, fetched by the main process (see
 * news.js in the root) so the renderer's CSP never has to allow a remote
 * origin. The last successful payload is kept in State.news, which is what the
 * startup panel paints from while a fresh fetch is in flight.
 *
 * There is no News tab any more: the feed opens once per launch, over the home
 * screen, and every story opens on the original site.
 */

let newsBusy = false;       // guards against double refreshes
let newsLang = 'fr';

/** "3 hours ago" / "12 Oct" — see timeAgo() in library.js for the shared one. */
function newsWhen(iso) {
  return timeAgo(iso);
}

/** Sentence-case bucket from an article slug, used as a lightweight tag. */
function newsTopic(it) {
  const s = String(it.slug || '');
  if (/gta|rockstar/.test(s)) return 'GTA';
  if (/steam|valve/.test(s)) return 'Steam';
  if (/playstation|ps5|xbox|nintendo|switch/.test(s)) return 'Consoles';
  if (/sortie|release|date/.test(s)) return 'Releases';
  if (/maj|patch|update|beta/.test(s)) return 'Updates';
  return 'Gaming';
}

/**
 * Fetches the feed into State.news. Used by the startup panel and by Big
 * Picture, which needs the headlines even when that panel was never opened.
 * @returns {Promise<object|null>} the raw IPC result, or null if a fetch was
 *   already in flight.
 */
async function fetchNewsIntoState(force) {
  if (newsBusy) return null;
  newsBusy = true;
  let res = null;
  try { res = await window.api.newsList({ lang: newsLang, force: !!force }); }
  catch (err) { res = { ok: false, error: err.message }; }

  if (res && res.ok && Array.isArray(res.items)) {
    State.news = { items: res.items, fetchedAt: res.fetchedAt || Date.now(), lang: newsLang };
    await persist();
  }
  newsBusy = false;
  return res;
}

// ---------------------------------------------------------------------------
// The startup panel
// ---------------------------------------------------------------------------
let newsBootEl = null;

function newsBootCard(it) {
  const thumb = it.image
    ? `<span class="nb-thumb"><img src="${esc(it.image)}" alt="" loading="lazy" draggable="false"></span>`
    : `<span class="nb-thumb empty">${icon('news', 20)}</span>`;
  return `<button class="nb-card" data-news-open="${esc(it.url)}" title="${esc(it.title)}">
    ${thumb}
    <span class="nb-card-tag">${esc(newsTopic(it))}</span>
    <span class="nb-card-title">${esc(it.title)}</span>
  </button>`;
}

function newsBootPaint() {
  if (!newsBootEl) return;
  const items = (State.news && State.news.items) || [];
  const hero = items[0] || null;
  const rest = items.slice(1, 5);

  const heroHtml = hero ? `
    <div class="nb-hero">
      <div class="nb-hero-art">
        ${hero.image
          ? `<img src="${esc(hero.image)}" alt="" draggable="false">`
          : `<span class="nb-hero-blank">${icon('news', 34)}</span>`}
        <span class="nb-hero-fade"></span>
      </div>
      <div class="nb-hero-text">
        <span class="nb-hero-tag">${esc(newsTopic(hero))}</span>
        <h3>${esc(hero.title)}</h3>
        ${hero.summary ? `<p>${esc(hero.summary)}</p>` : ''}
        <button class="btn primary" data-news-open="${esc(hero.url)}">
          ${icon('external', 15)} Read on Instant Gaming
        </button>
      </div>
    </div>` : `
    <div class="nb-hero nb-hero-offline">
      <span class="nb-hero-blank">${icon('wifi', 30)}</span>
      <div>
        <h3>The feed did not answer</h3>
        <p>You are still offline, or Instant Gaming is unreachable. Everything else works.</p>
      </div>
    </div>`;

  newsBootEl.querySelector('.nb-body').innerHTML = `
    ${heroHtml}
    ${rest.length ? `<div class="nb-row">${rest.map(newsBootCard).join('')}</div>` : ''}`;

  const stamp = newsBootEl.querySelector('.nb-stamp');
  const fresh = State.news && State.news.fetchedAt;
  if (stamp) {
    stamp.innerHTML = fresh
      ? `${icon('clock', 12)} ${esc(newsWhen(new Date(fresh).toISOString()))} &middot; news.instant-gaming.com`
      : 'Headlines from news.instant-gaming.com';
  }
}

function closeNewsBoot() {
  if (!newsBootEl) return;
  const el = newsBootEl;
  newsBootEl = null;
  document.removeEventListener('keydown', newsBootEsc);
  document.body.classList.remove('nb-open');
  el.classList.add('closing');
  setTimeout(() => el.remove(), 220);
}

function newsBootEsc(e) {
  if (e.key === 'Escape') closeNewsBoot();
}

/**
 * Opens the startup panel. Called once from app.js after the first paint.
 * @param {{refresh?: boolean}} opts  refresh the feed even if the cache is warm.
 */
async function openNewsBoot(opts = {}) {
  if (newsBootEl) return newsBootEl;

  const el = document.createElement('div');
  el.className = 'news-boot';
  el.id = 'news-boot';
  el.innerHTML = `
    <div class="nb-panel" role="dialog" aria-modal="true" aria-label="Last news">
      <header class="nb-head">
        <h2>LAST NEWS</h2>
        <div class="nb-head-right">
          <span class="nb-stamp"></span>
          <button class="nb-close" title="Close (Esc)" aria-label="Close">${icon('close', 18)}</button>
        </div>
      </header>
      <div class="nb-body"></div>
      <footer class="nb-foot">
        <span>Apex only reads the feed. Every story opens on the original site.</span>
        <button class="btn secondary sm" id="nb-open-feed">${icon('external', 14)} Browse the feed</button>
      </footer>
    </div>`;

  document.body.appendChild(el);
  document.body.classList.add('nb-open');
  newsBootEl = el;

  el.addEventListener('click', async (e) => {
    if (e.target === el || e.target.closest('.nb-close')) { closeNewsBoot(); return; }
    if (e.target.closest('#nb-open-feed')) {
      closeNewsBoot();
      window.api.openExternal('https://news.instant-gaming.com/').catch(() => {});
      return;
    }
    const open = e.target.closest('[data-news-open]');
    if (open) {
      const ok = await window.api.openExternal(open.dataset.newsOpen).catch(() => false);
      if (!ok) toast('Could not open that story', 'warn');
    }
  });

  document.addEventListener('keydown', newsBootEsc);
  newsBootPaint();

  const age = State.news && State.news.fetchedAt ? Date.now() - State.news.fetchedAt : Infinity;
  if (opts.refresh || age > 10 * 60 * 1000) {
    const opened = newsBootEl;
    await fetchNewsIntoState(!!opts.refresh);
    // The panel may have been closed while the feed was in flight.
    if (newsBootEl === opened) newsBootPaint();
  }

  return el;
}
