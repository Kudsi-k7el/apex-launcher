'use strict';

/**
 * The interface language.
 *
 * English is the key: `t('Downloads')`, and `applyI18n()` walks the DOM after a
 * render swapping in whatever the active language has for those strings. Views
 * keep writing English straight into their templates, so a new screen ships in
 * English and picks up every language that already covers it, and a string with
 * no entry simply stays English - never a raw key, never a blank label.
 *
 * The reverse index is what makes switching languages work. A label that is
 * currently French is resolved back to its English source before being
 * re-translated, so flipping between two languages never translates a
 * translation - and it makes the pass idempotent, which is what lets it run
 * safely over a subtree that has already been through it.
 *
 * Product and store names keep their own spelling in every language (see the
 * house style in i18n-strings.js); user content - a game title, a typed name -
 * can opt out of the pass entirely with `data-i18n-skip`.
 */

const I18N_LANGS = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'pt', name: 'Portuguese', native: 'Português' }
];

// Attributes that carry text a reader sees. `value` is deliberately absent: a
// field the user has typed into holds their words, not ours.
const I18N_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

// Tags whose text is code, markup or a template, never a label.
const I18N_SKIP_TAGS = /^(script|style|textarea|code|pre|template)$/i;

let i18nLang = 'en';
let i18nIndexCache = null;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
/**
 * Every dictionary plus the two tables that make a pass possible: the English
 * strings any language covers, and the way back from a translated word to the
 * English it came from.
 *
 * Built lazily. This file may be parsed before the strings file has run, and
 * reading its `const` in that window would throw.
 */
function i18nIndex() {
  if (i18nIndexCache) return i18nIndexCache;

  const dicts = (typeof I18N_STRINGS === 'object' && I18N_STRINGS) ? I18N_STRINGS : {};
  const keys = Object.create(null);   // English -> 1, for every string we can translate
  const rev = Object.create(null);    // translation -> English, where it is unambiguous

  for (const dict of Object.values(dicts)) {
    if (!dict || typeof dict !== 'object') continue;
    for (const [src, out] of Object.entries(dict)) {
      if (!src) continue;
      keys[src] = 1;
      if (typeof out !== 'string' || !out.trim()) continue;
      if (rev[out] === undefined) rev[out] = src;
      // Two English strings sharing one wording ("Local" is the same word in
      // several languages) cannot be resolved backwards, so they are dropped
      // rather than guessed at.
      else if (rev[out] !== src) rev[out] = '';
    }
  }

  i18nIndexCache = { dicts, keys, rev };
  return i18nIndexCache;
}

function i18nLangs() { return I18N_LANGS.slice(); }

function currentLang() { return i18nLang; }

function isI18nLang(code) { return I18N_LANGS.some((l) => l.code === code); }

/** The active dictionary, or null for English - whose words are the keys. */
function i18nDict() {
  if (i18nLang === 'en') return null;
  const dict = i18nIndex().dicts[i18nLang];
  return (dict && typeof dict === 'object') ? dict : null;
}

/** The English behind a piece of text: it is English, or it is a translation. */
function i18nSource(body) {
  if (!body) return null;
  const { keys, rev } = i18nIndex();
  if (keys[body]) return body;
  return rev[body] || null;
}

// ---------------------------------------------------------------------------
// Translating
// ---------------------------------------------------------------------------
/**
 * `t('Downloads')` -> the active language's word for it.
 *
 * Falls back to the English it was handed, so a string nobody has translated
 * yet reads exactly as it always did. `{name}` placeholders are filled from
 * `vars`, which lets a sentence be reordered by a translation without the call
 * site caring.
 */
function t(text, vars) {
  if (text === undefined || text === null) return '';
  const src = String(text);
  const dict = i18nDict();
  const out = dict ? dict[src] : undefined;
  let str = (typeof out === 'string' && out.trim()) ? out : src;
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (m, key) => (
      vars[key] === undefined || vars[key] === null ? m : String(vars[key])
    ));
  }
  return str;
}

/** One text node. Whitespace around the label is kept exactly as it was. */
function i18nTextNode(node) {
  const raw = node.nodeValue;
  if (!raw) return false;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  const src = i18nSource(m[2]);
  if (!src) return false;
  const next = m[1] + t(src) + m[3];
  if (next === raw) return false;
  node.nodeValue = next;
  return true;
}

/** The readable attributes on one element. */
function i18nElement(el) {
  let touched = false;
  for (const attr of I18N_ATTRS) {
    if (typeof el.hasAttribute !== 'function' || !el.hasAttribute(attr)) continue;
    const raw = el.getAttribute(attr);
    const src = i18nSource(raw);
    if (!src) continue;
    const next = t(src);
    if (next !== raw) { el.setAttribute(attr, next); touched = true; }
  }
  return touched;
}

/**
 * Translates everything under `root` (the whole body by default) and returns
 * how many pieces it changed.
 *
 * Repeat-safe by design: see the note at the top of the file. Subtrees holding
 * user content are left alone via `data-i18n-skip`.
 */
function applyI18n(root) {
  if (typeof document === 'undefined' || !document.createTreeWalker) return 0;
  const scope = root || document.body;
  if (!scope) return 0;

  let hits = 0;
  if (scope.nodeType === 1 && i18nElement(scope)) hits++;

  // FILTER_REJECT (not SKIP) so a skipped subtree is not descended into at all.
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (I18N_SKIP_TAGS.test(node.tagName)) return NodeFilter.FILTER_REJECT;
      if (node.hasAttribute && node.hasAttribute('data-i18n-skip')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 3) { if (i18nTextNode(node)) hits++; }
    else if (i18nElement(node)) hits++;
    node = walker.nextNode();
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------
/** Mirrors the choice onto <html lang>, for hyphenation and screen readers. */
function applyI18nLangAttr() {
  try { document.documentElement.lang = i18nLang; } catch { /* no document yet */ }
}

/**
 * Adopts the stored language at start-up. Translating the body here is what
 * covers the static shell - the sidebar, the title bar, the drawer frame and
 * the sign-in gate - none of which is ever re-rendered.
 */
function i18nBoot(code) {
  i18nLang = isI18nLang(code) ? code : 'en';
  applyI18nLangAttr();
  return applyI18n(typeof document !== 'undefined' ? document.body : null);
}

/**
 * Switches language from the Settings picker.
 *
 * The views are rebuilt rather than retranslated: a page holds live nodes (the
 * drawer's rows, the settings sheet, Big Picture) and rendering them again from
 * the templates keeps every one of them honest. The pass over the body then
 * picks up the static shell, which never re-renders at all.
 */
function setLang(code) {
  i18nLang = isI18nLang(code) ? code : 'en';
  if (typeof State !== 'undefined' && State && State.settings) State.settings.lang = i18nLang;
  applyI18nLangAttr();
  if (typeof render === 'function') render(false);
  if (typeof renderDrawer === 'function') renderDrawer();
  applyI18n(typeof document !== 'undefined' ? document.body : null);
  if (typeof persist === 'function') persist();
  return i18nLang;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
/**
 * What the dictionaries cover. `missing` is the English a language has no entry
 * for, `blank` an entry that would render nothing, and `drift` a count per
 * language of entries the others do not have - the way a fully translated
 * language set stays in step.
 */
function i18nAudit() {
  const { dicts } = i18nIndex();
  const codes = I18N_LANGS.map((l) => l.code);
  const translated = codes.filter((c) => dicts[c] && typeof dicts[c] === 'object' && c !== 'en');

  const union = new Set();
  translated.forEach((c) => Object.keys(dicts[c]).forEach((k) => union.add(k)));

  const counts = {};
  const missing = {};
  const drift = {};
  const blank = [];
  codes.forEach((c) => {
    const dict = dicts[c];
    counts[c] = (dict && typeof dict === 'object') ? Object.keys(dict).length : 0;
  });
  translated.forEach((c) => {
    const keys = new Set(Object.keys(dicts[c]));
    missing[c] = [...union].filter((k) => !keys.has(k));
    drift[c] = [...keys].filter((k) => translated.some((o) => !(k in dicts[o])));
    for (const [src, out] of Object.entries(dicts[c])) {
      if (typeof out !== 'string' || !out.trim()) blank.push(`${c}: ${src}`);
    }
  });

  return { lang: i18nLang, langs: codes, keys: union.size, counts, missing, drift, blank };
}

/**
 * English still on screen in a language that should have covered it - what a
 * half-finished translation look like from the outside. Used by the smoke suite
 * to keep the dictionaries honest; not shown to users.
 */
function i18nPending(root, limit = 40) {
  const dict = i18nDict();
  if (!dict || typeof document === 'undefined') return [];
  const scope = root || document.body;
  if (!scope) return [];

  const { keys } = i18nIndex();
  const out = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (el && I18N_SKIP_TAGS.test(el.tagName)) return NodeFilter.FILTER_REJECT;
      if (el && el.closest && el.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while (out.length < limit && (node = walker.nextNode())) {
    const body = (node.nodeValue || '').trim();
    if (body && keys[body] && dict[body] === undefined) out.push(body);
  }
  return out;
}
