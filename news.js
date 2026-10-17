'use strict';

/**
 * Gaming news (main process).
 * ------------------------------------------------------------------
 * Fetches the article index from news.instant-gaming.com and turns it into
 * plain objects the renderer can lay out. Doing it in the main process keeps
 * the renderer's Content-Security-Policy locked down (no remote origin is
 * allowed to be scripted from the page) and lets us set a normal User-Agent.
 *
 * The site publishes no RSS or JSON feed, so the index HTML is parsed. That
 * parser is written defensively and tolerantly: if the markup changes shape we
 * return whatever we could recognise rather than throwing, and the previous
 * payload stays on screen.
 */

const LANGS = ['fr', 'en'];

let lastGood = null;   // in-memory copy of the most recent successful parse
let lastAt = 0;
const CACHE_MS = 10 * 60 * 1000;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#0?34;|&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&laquo;/g, '\u00ab')
    .replace(/&raquo;/g, '\u00bb')
    .replace(/&eacute;/g, '\u00e9')
    .replace(/&egrave;/g, '\u00e8')
    .replace(/&agrave;/g, '\u00e0')
    .replace(/&ecirc;/g, '\u00ea')
    .replace(/&ocirc;/g, '\u00f4')
    .replace(/&ccedil;/g, '\u00e7')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The site's article covers are not in the markup as <img> tags — it lazy-loads
 * them in the browser — but every listing cover is present in the SSR payload
 * (`window.appData.content`). We read that payload and map each article id to
 * its cover, in two sizes: the listing crop for the cards and a larger crop for
 * a hero backdrop. The CDN serves the same file at several preset sizes, so the
 * larger one is the listing URL with its size segment swapped.
 */
function coverAt(url, size) {
  const s = String(url || '');
  if (!/^https?:\/\//i.test(s)) return s || null;
  return /\/cover\/\d+x\d+\//.test(s) ? s.replace(/\/cover\/\d+x\d+\//, `/cover/${size}/`) : s;
}

/** id -> { image, imageLarge } for every cover the home payload carries. */
function parseImages(html) {
  const map = new Map();
  const src = String(html || '');
  const at = src.indexOf('window.appData.content');
  if (at < 0) return map;
  const open = src.indexOf('{', at);
  if (open < 0) return map;

  // Pull out the JSON object literal, matching braces while ignoring any that
  // sit inside a string. The payload is followed by more script, so we cannot
  // simply read to the end of the document.
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return map;

  let data;
  try { data = JSON.parse(src.slice(open, end + 1)); } catch { return map; }

  for (const key of ['latestBreakingNews', 'latestNews', 'latestStories', 'latestReviews']) {
    const list = Array.isArray(data[key]) ? data[key] : [];
    for (const it of list) {
      if (!it || !it.id || !it.cover_listing_default_path) continue;
      const image = it.cover_listing_default_path;
      map.set(String(it.id), { image, imageLarge: coverAt(image, '1000x563') });
    }
  }
  return map;
}

/** Very forgiving date parse: Steam-like ISO from <time datetime>, else null. */
function parseDate(iso, fallbackText) {
  const d = iso ? new Date(iso) : (fallbackText ? new Date(String(fallbackText).trim()) : null);
  return d && !isNaN(d.getTime()) ? d.toISOString() : null;
}

/**
 * Pulls articles out of the index HTML.
 * The index nests each story as
 *   <li><h3><a href="…/articles/NNNN-slug">Title</a></h3>
 *       <time datetime="…">…</time><p>Summary</p></li>
 */
function parseArticles(html) {
  const src = String(html || '');
  const items = [];
  const seen = new Set();
  const images = parseImages(src);

  // Anchor on every article link, then read the siblings that follow it.
  const linkRe = /<a\s+href="(https?:\/\/news\.instant-gaming\.com\/[a-z]{2}\/articles\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(src))) {
    const url = m[1];
    const title = decodeEntities(stripTags(m[2]));
    if (!title || seen.has(url)) continue;
    seen.add(url);

    // Everything between this link and the end of its list item holds the
    // date and the summary.
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const stop = tail.search(/<\/li>/i);
    const block = stop >= 0 ? tail.slice(0, stop) : tail;

    const time = block.match(/<time[^>]*datetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/i);
    const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const slug = (url.split('/articles/')[1] || '').replace(/^\d+-/, '');
    const id = (url.match(/\/articles\/(\d+)/) || [])[1] || slug;
    const cover = images.get(String(id)) || null;

    items.push({
      id,
      title,
      url,
      date: parseDate(time && time[1], time && time[2]),
      summary: decodeEntities(stripTags(para ? para[1] : '')).slice(0, 320),
      slug,
      // The article's own cover (when the home payload carried it) so the cards
      // and the Big Picture hero show the same image the site does.
      image: cover ? cover.image : null,
      imageLarge: cover ? cover.imageLarge : null,
      // The slug is a readable stand-in for a tag until we read categories.
      tags: []
    });
  }

  return items;
}

/** Category chips from the site navigation. */
function parseCategories(html) {
  const out = [];
  const seen = new Set();
  const re = /href="https?:\/\/news\.instant-gaming\.com\/([a-z]{2})\/categories\/([^"\/]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const name = decodeEntities(stripTags(m[3]));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ lang: m[1], slug: m[2], name });
  }
  return out.slice(0, 14);
}

/**
 * Fetches the news index.
 * @param {{lang?:string, force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, items:Array<object>, categories:Array<object>,
 *                    fetchedAt:number|null, stale:boolean, source:string, error?:string}>}
 */
async function list(opts = {}) {
  const lang = LANGS.includes(opts.lang) ? opts.lang : 'fr';
  const source = `https://news.instant-gaming.com/${lang}/`;

  const fresh = lastGood && (Date.now() - lastAt) < CACHE_MS;
  if (fresh && !opts.force) {
    return { ok: true, ...lastGood, stale: false, source };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(source, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': `${lang},en;q=0.8`
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const items = parseArticles(html);
    const categories = parseCategories(html);
    if (!items.length) throw new Error('No articles found in the page');

    lastGood = { items, categories };
    lastAt = Date.now();
    return { ok: true, items, categories, fetchedAt: lastAt, stale: false, source };
  } catch (err) {
    // Offline, blocked, or the markup moved. Hand back the last good payload
    // and say so, rather than showing an empty screen.
    if (lastGood) {
      return { ok: true, ...lastGood, fetchedAt: lastAt, stale: true, source, error: (err && err.message) || 'Fetch failed' };
    }
    return { ok: false, items: [], categories: [], fetchedAt: null, stale: false, source, error: (err && err.message) || 'Could not reach the news feed' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { list, parseArticles, parseImages, parseCategories, decodeEntities };
