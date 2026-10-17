'use strict';

/**
 * Apex Launcher — companion download site.
 *
 * Plain ES5-era browser JS, no build step and no dependencies. Everything the
 * page needs to know about the release lives in CONFIG below; change it in one
 * place and the nav button, the hero button, the download section and the spec
 * table all follow.
 */

// ---------------------------------------------------------------------------
// Release configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  version: '2.7.0',

  // Where the installer is served from.
  //   * Previewing from the repo: keep the relative path to ./dist, which the
  //     bundled backend (server/server.js) serves at /dist/... for you.
  //   * Hosting for real: point this at your release asset, e.g.
  //     'https://github.com/you/apex/releases/download/v2.7.0/Apex-Launcher-Setup-2.7.0.exe'
  downloadUrl: '../dist/Apex-Launcher-Setup-2.7.0.exe',

  // Shown in the spec table until the page can measure the file for itself; on a
  // server that has no installer, the row is left blank instead.
  installerSize: '~82 MB'
};

(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  // -------------------------------------------------------------------------
  // 1. Fill in the release details
  // -------------------------------------------------------------------------
  function paintRelease() {
    $$('[data-version]').forEach(function (el) { el.textContent = CONFIG.version; });
    $$('[data-size]').forEach(function (el) { el.textContent = CONFIG.installerSize || '\u2014'; });

    $$('[data-dl]').forEach(function (el) {
      el.setAttribute('href', CONFIG.downloadUrl);
      // Cross-origin release links should open in a new tab; a local relative
      // path should not.
      if (/^https?:/i.test(CONFIG.downloadUrl)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      }
    });
  }

  /**
   * A HEAD probe so the page can say something useful when the installer has not
   * been built yet (very common while developing the site). Only a definite 404
   * triggers the hint — a CORS or network error tells us nothing, so we stay
   * quiet rather than crying wolf on a correctly deployed site.
   */
  function probeInstaller() {
    // Opened straight off the disk there is nothing to probe (Chromium refuses
    // fetch on file: URLs) and the relative link to ./dist works anyway, so the
    // "not built yet" warning would be crying wolf at a real release.
    if (location.protocol === 'file:') return;
    if (!window.fetch) return;

    fetch(CONFIG.downloadUrl, { method: 'HEAD' })
      .then(function (res) {
        if (res.status === 404) {
          // This server has no installer beside it, so it cannot say how big the
          // release is. Fall silent on the number rather than quoting one that
          // may not match the file served somewhere else.
          $$('[data-size]').forEach(function (el) { el.textContent = '\u2014'; });
          showHint();
          return;
        }
        const len = Number(res.headers.get('content-length'));
        if (len > 0) {
          CONFIG.installerSize = (len / 1048576).toFixed(1) + ' MB';
          $$('[data-size]').forEach(function (el) { el.textContent = CONFIG.installerSize; });
        }
      })
      .catch(function () { /* unknown: say nothing */ });
  }

  function showHint() {
    const hint = $('#dl-hint');
    if (hint) hint.hidden = false;
  }

  // -------------------------------------------------------------------------
  // 2. Sticky nav: shadow once the page has scrolled
  // -------------------------------------------------------------------------
  function wireNav() {
    const nav = $('#nav');
    const toggle = $('#nav-toggle');
    const links = $('#nav-links');
    if (!nav) return;

    let ticking = false;
    const onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        nav.classList.toggle('is-stuck', window.scrollY > 8);
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (!toggle || !links) return;

    const setOpen = function (open) {
      links.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };

    toggle.addEventListener('click', function () {
      setOpen(!links.classList.contains('is-open'));
    });

    // Close on navigation, on Escape, and when the layout leaves phone width.
    $$('a', links).forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 720) setOpen(false); });
  }

  // -------------------------------------------------------------------------
  // 3. Theme picker
  // -------------------------------------------------------------------------
  // The first three themes deliberately mirror the launcher's own Settings >
  // Appearance options, so the site and the app can match.
  const THEME_COLOR = {
    dark: '#0b0d12',
    oled: '#000000',
    neon: '#0a0616',
    ember: '#120d0b',
    day: '#f5f7fa'
  };
  const STORAGE_KEY = 'apex-site-theme';

  function wireTheme() {
    const btn = $('#theme-btn');
    const menu = $('#theme-menu');
    if (!btn || !menu) return;

    const opts = $$('[data-theme-set]', menu);

    const paint = function (id) {
      opts.forEach(function (o) {
        o.setAttribute('aria-checked', o.dataset.themeSet === id ? 'true' : 'false');
      });
      const meta = $('#meta-theme-color');
      if (meta && THEME_COLOR[id]) meta.setAttribute('content', THEME_COLOR[id]);
    };

    const apply = function (id, remember) {
      document.documentElement.setAttribute('data-theme', id);
      paint(id);
      if (remember) {
        try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* storage blocked */ }
      }
    };

    const setOpen = function (open) {
      menu.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        const current = opts.filter(function (o) { return o.getAttribute('aria-checked') === 'true'; })[0];
        if (current) current.focus();
      }
    };

    // Reflect whatever the pre-paint script already applied.
    paint(document.documentElement.getAttribute('data-theme') || 'dark');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!menu.classList.contains('is-open'));
    });

    opts.forEach(function (opt) {
      opt.addEventListener('click', function () {
        apply(opt.dataset.themeSet, true);
        setOpen(false);
        btn.focus();
      });
      // Arrow keys walk the radio group; Enter/Space activate via click.
      opt.addEventListener('keydown', function (e) {
        const i = opts.indexOf(opt);
        let next = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = opts[(i + 1) % opts.length];
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = opts[(i - 1 + opts.length) % opts.length];
        else if (e.key === 'Escape') { setOpen(false); btn.focus(); return; }
        if (!next) return;
        e.preventDefault();
        next.focus();
      });
    });

    // Dismiss on an outside click or Escape, the way a menu should.
    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('is-open')) return;
      if (!menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) { setOpen(false); btn.focus(); }
    });
  }

  // -------------------------------------------------------------------------
  // 4. Screenshot gallery
  // -------------------------------------------------------------------------
  function wireGallery() {
    const tabs = $$('.shot-tab');
    const img = $('#shot-img');
    const caption = $('#shot-caption');
    if (!tabs.length || !img) return;

    const show = function (tab) {
      tabs.forEach(function (t) {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      img.src = tab.dataset.src;
      img.alt = 'Apex Launcher, ' + tab.textContent.trim() + ' view';
      if (caption) caption.textContent = tab.dataset.caption || '';
    };

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { show(tab); });
      // Left/right arrows walk the tabs, as a real tablist should.
      tab.addEventListener('keydown', function (e) {
        const i = tabs.indexOf(tab);
        let next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        show(next);
        next.focus();
      });
    });

    // Warm the cache for the other shots once the page is idle, so switching is
    // instant without slowing the first paint.
    const warm = function () {
      tabs.slice(1).forEach(function (t) { const i = new Image(); i.src = t.dataset.src; });
    };
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1800);
  }

  // -------------------------------------------------------------------------
  // 5. Scroll reveal
  // -------------------------------------------------------------------------
  function wireReveal() {
    const items = $$('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window) ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      items.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }

    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    items.forEach(function (el) { io.observe(el); });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  paintRelease();
  wireTheme();
  wireNav();
  wireGallery();
  wireReveal();
  probeInstaller();
})();
