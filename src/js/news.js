'use strict';

/**
 * News view.
 *
 * Articles come from news.instant-gaming.com, fetched by the main process (see
 * news.js there) so the renderer's CSP never has to allow a remote origin. The
 * last successful payload is kept in State.news, which means the tab renders
 * instantly on start and still shows yesterday's headlines with a clear
 * "offline" note when there is no connection.
 */

let newsFilter = '';        // live text in the news search box
let newsCat = '';           // active category chip
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

function newsMatches(it) {
  if (newsCat && newsTopic(it) !== newsCat) return false;
  const q = newsFilter.trim().toLowerCase();
  if (!q) return true;
  return `${it.title} ${it.summary}`.toLowerCase().includes(q);
}

function newsCard(it) {
  const when = newsWhen(it.date);
  const thumb = it.image
    ? `<span class="news-thumb"><img src="${esc(it.image)}" alt="" loading="lazy" draggable="false"></span>`
    : `<span class="news-thumb empty">${icon('news', 22)}</span>`;
  return `<article class="news-card">
    ${thumb}
    <div class="news-body">
      <div class="news-meta">
        <span class="news-tag">${esc(newsTopic(it))}</span>
        ${when ? `<span class="news-when">${icon('clock', 12)} ${esc(when)}</span>` : ''}
      </div>
      <h3 class="news-title">${esc(it.title)}</h3>
      ${it.summary ? `<p class="news-sum">${esc(it.summary)}</p>` : ''}
      <div class="news-actions">
        <button class="btn secondary sm" data-news-open="${esc(it.url)}">${icon('external', 14)} Read on Instant Gaming</button>
      </div>
    </div>
  </article>`;
}

function paintNewsList(el) {
  const list = el.querySelector('#news-list');
  if (!list) return;

  const items = ((State.news && State.news.items) || []).filter(newsMatches);
  if (!items.length) {
    const total = ((State.news && State.news.items) || []).length;
    list.innerHTML = `<div class="empty show">
      ${icon('news', 36)}
      <h3>${total ? 'No stories match that filter' : 'No news loaded yet'}</h3>
      <p>${total ? 'Try a different search term or category.' : 'Hit refresh to pull the latest gaming headlines.'}</p>
    </div>`;
    return;
  }
  list.innerHTML = items.map(newsCard).join('');
}

function newsHeader(el) {
  const fetchedAt = State.news && State.news.fetchedAt;
  const count = ((State.news && State.news.items) || []).length;
  const fresh = el.querySelector('#news-fresh');
  if (fresh) {
    fresh.innerHTML = fetchedAt
      ? `${icon('clock', 13)} Updated ${esc(newsWhen(new Date(fetchedAt).toISOString()))} &middot; ${count} stories`
      : 'Not loaded yet';
  }
}

/**
 * Fetches the feed into State.news. Shared by the News view and by Big Picture,
 * which needs the headlines even when the News page was never opened.
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

async function loadNews(el, force) {
  if (newsBusy) return;
  const btn = el.querySelector('#news-refresh');
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('refresh', 15)} Loading\u2026`; }

  const res = await fetchNewsIntoState(force);

  if (res && res.ok && Array.isArray(res.items)) {
    if (res.stale) toast('Showing the last saved headlines \u2014 could not reach the feed', 'warn');
    else if (force) toast(`Loaded ${res.items.length} stories`, 'check');
  } else if (res) {
    toast(`News unavailable: ${res.error || 'unknown error'}`, 'warn');
  }

  if (btn) { btn.disabled = false; btn.innerHTML = `${icon('refresh', 15)} Refresh`; }
  paintNewsList(el);
  newsHeader(el);
  paintNewsCategories(el);
}

function paintNewsCategories(el) {
  const wrap = el.querySelector('#news-cats');
  if (!wrap) return;
  const cats = ['', 'GTA', 'Steam', 'Consoles', 'Releases', 'Updates', 'Gaming'];
  const items = (State.news && State.news.items) || [];
  const counts = {};
  for (const it of items) counts[newsTopic(it)] = (counts[newsTopic(it)] || 0) + 1;

  wrap.innerHTML = cats.map((c) => {
    const label = c || 'All';
    const n = c ? (counts[c] || 0) : items.length;
    if (c && !n) return '';
    return `<button class="chip ${newsCat === c ? 'active' : ''}" data-news-cat="${esc(c)}">${label}<em>${n}</em></button>`;
  }).join('');
}

function renderNews(el) {
  clearInterval(slideTimer);

  el.innerHTML = `
    <h1 class="page-title">News</h1>
    <div class="toolbar news-toolbar">
      <div class="search-box">
        ${icon('search', 16)}
        <input id="news-search" type="search" placeholder="Search headlines\u2026" value="${esc(newsFilter)}" spellcheck="false" autocomplete="off">
      </div>
      <div class="news-toolbar-right">
        <span class="news-fresh" id="news-fresh"></span>
        <button class="icon-btn sm" id="news-lang" title="Switch language">${esc(newsLang.toUpperCase())}</button>
        <button class="btn secondary sm" id="news-refresh">${icon('refresh', 15)} Refresh</button>
      </div>
    </div>
    <div class="page-intro"><p>Headlines pulled live from
      <b>news.instant-gaming.com</b>. Apex only reads the feed &mdash; every story opens on the
      original site.</p></div>
    <div class="chip-row" id="news-cats"></div>
    <div class="news-list" id="news-list"></div>`;

  const search = el.querySelector('#news-search');
  search.addEventListener('input', (e) => { newsFilter = e.target.value; paintNewsList(el); });

  el.querySelector('#news-refresh').addEventListener('click', () => loadNews(el, true));

  el.querySelector('#news-lang').addEventListener('click', async () => {
    newsLang = newsLang === 'fr' ? 'en' : 'fr';
    el.querySelector('#news-lang').textContent = newsLang.toUpperCase();
    State.news = { items: [], fetchedAt: null, lang: newsLang };
    await loadNews(el, true);
  });

  el.querySelector('#news-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-news-cat]');
    if (!chip) return;
    newsCat = chip.dataset.newsCat || '';
    paintNewsCategories(el);
    paintNewsList(el);
  });

  el.querySelector('#news-list').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-news-open]');
    if (!open) return;
    const ok = await window.api.openExternal(open.dataset.newsOpen);
    if (!ok) toast('Could not open that story', 'warn');
  });

  // Render whatever is cached immediately, then refresh if it is stale.
  paintNewsCategories(el);
  paintNewsList(el);
  newsHeader(el);

  const age = State.news && State.news.fetchedAt ? Date.now() - State.news.fetchedAt : Infinity;
  if (age > 10 * 60 * 1000) loadNews(el, false);
}
