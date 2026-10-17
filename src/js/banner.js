'use strict';

/**
 * Intelligent fallback banners.
 *
 * Every game artwork slot renders a deterministic, typographic "cover card"
 * underneath the remote image. If the image is missing, blocked or fails to
 * load, that card is what the user sees - so the launcher can never show a
 * broken image.
 *
 * The card is built from:
 *   - a stable colour pair (the game's own `colors`, or hashed from its title)
 *   - the title's initials inside a glowing glass tile
 *   - the title + a short subtitle
 */

// --- deterministic helpers -------------------------------------------------

function hashStr(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', 'to', 'in', 'on']);

/** "Grand Theft Auto V" -> "GTA", "Cyberpunk 2077" -> "C2", "Hollow Knight" -> "HOK" */
function initials(title) {
  const words = String(title || '?')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()));

  if (!words.length) return '?';
  if (words.length === 1) {
    const w = words[0];
    return (w.length <= 3 ? w : w.slice(0, 3)).toUpperCase();
  }
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

/** A stable two-colour palette for a game. */
function gamePalette(g) {
  if (Array.isArray(g.colors) && g.colors.length >= 2) return [g.colors[0], g.colors[1]];
  const h = hashStr((g && (g.title || g.id)) || 'apex');
  const a = h % 360;
  const b = (a + 45 + ((h >> 4) % 120)) % 360;
  return [`hsl(${a} 55% 20%)`, `hsl(${b} 82% 55%)`];
}

/** Inline style declaring the palette + layered gradient background. */
function bannerStyle(g) {
  const [c1, c2] = gamePalette(g);
  const layers = [
    `radial-gradient(120% 95% at 20% 10%, color-mix(in srgb, ${c2} 34%, transparent), transparent 62%)`,
    `linear-gradient(150deg, ${c1}, #04060b 94%)`
  ];
  // A title whose art is only a wordmark can still have a real key visual
  // behind it: `bannerImage` is drawn under a veil so the wordmark stays legible.
  if (g.bannerImage) {
    layers.unshift('linear-gradient(180deg, rgba(4, 6, 11, .14), rgba(4, 6, 11, .56))');
    // `auto 130%` over-scales vertically so the teaser frame's letterbox bars
    // and its caption band fall outside the slot.
    layers.unshift(`url("${g.bannerImage}") center / auto 130% no-repeat`);
  }
  return `--c1:${c1};--c2:${c2};background:${layers.join(',')}`;
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/** Decorative child nodes for the hand-drawn scene banners. */
function themeDecor(key) {
  if (key === 'fortnite') {
    return '<i class="t-storm"></i><i class="t-bolt b1"></i><i class="t-bolt b2"></i>'
      + '<i class="t-hill h1"></i><i class="t-hill h2"></i><i class="t-lama"></i>';
  }
  return '';
}

/** The typographic card markup (sits beneath the <img>). */
function bannerMarkup(g, kind = 'cover') {
  const [, c2] = gamePalette(g);
  const sub = kind === 'cover'
    ? (g.genre || g.developer || '')
    : [g.developer, g.release].filter(Boolean).join(' \u00b7 ');

  const theme = g.artKey
    ? `<span class="art-theme art-${g.artKey}" aria-hidden="true">${themeDecor(g.artKey)}</span>`
    : '';

  return `<div class="art-banner" data-kind="${kind}"${g.artKey ? ` data-theme="${g.artKey}"` : ''}>
    ${theme}
    <span class="art-stripes" aria-hidden="true"></span>
    <span class="art-glow" style="background:radial-gradient(circle, ${c2}, transparent 70%)" aria-hidden="true"></span>
    <span class="art-initials">${escapeText(initials(g.title))}</span>
    <span class="art-banner-text">
      <strong>${escapeText(g.title)}</strong>
      ${sub ? `<small>${escapeText(sub)}</small>` : ''}
    </span>
  </div>`;
}
