'use strict';

/**
 * Headless provider resolver.
 * ---------------------------------------------------------------------------
 * Buzzheavier, FileDitch and friends sit behind Cloudflare. Cloudflare answers
 * the transfer engine's plain socket with a bare 403 challenge - no matter what
 * headers we send - because clearing it needs a JavaScript-capable client.
 *
 * This module runs that client: a *hidden* BrowserWindow (never shown, never in
 * the taskbar) navigates the provider page, lets Cloudflare settle, presses the
 * page's own "Download" control, and reads the URL Chromium was about to
 * download from. That URL is a short-lived signed CDN link that the plain
 * engine *can* fetch, so the file itself comes down through the normal
 * multi-connection, resumable transfer - with no window, tab or site shown to
 * the user.
 *
 * Everything here is best-effort: outside the app (plain `node`, tests) it
 * reports that it is unavailable instead of throwing.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * The Electron main-process API, or null when running outside the app.
 *
 * `require('electron')` resolves to the executable *path* (a string) under
 * plain Node, so this is how the resolver knows to stand down in tests.
 */
function electronApi() {
  try {
    const mod = require('electron');
    if (mod && typeof mod === 'object' && mod.BrowserWindow && mod.app) return mod;
  } catch {
    /* not running inside Electron */
  }
  return null;
}

function browserAvailable() {
  return !!electronApi();
}

/**
 * Presses the provider's own download control.
 *
 * Providers put several lookalikes on the page - "Copy download link",
 * "Slow? Try mirror 2", "Open in browser instead", plus ad buttons that only
 * ever open popups - so candidates are *scored* and the copy/mirror/ad links
 * are rejected outright instead of being clicked first.
 */
const CLICK_SCRIPT = `
(function () {
  try {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]')
    );
    function textOf(el) {
      var t = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.value || '');
      return t.replace(/\\s+/g, ' ').trim().toLowerCase();
    }
    function score(el) {
      var t = textOf(el);
      if (!t) return -1;
      // Never press these: they copy a link, switch mirror, or spawn a popup.
      if (/copy|mirror|open in browser|report|policy|advert|sponsor|discord/.test(t)) return -1;
      if (!/download/.test(t)) return -1;
      var s = 5;
      if (/download file|download now|start download|direct download/.test(t)) s += 20;
      if (/\\d/.test(t)) s += 8; // "Download File 139.0GB" reads like the real one
      var cls = (el.className || '').toString().toLowerCase();
      if (/download/.test(cls)) s += 20;
      if (el.tagName === 'BUTTON') s += 4;
      if (el.getAttribute('href') && /\\.(rar|zip|7z|iso|bin|part\\d*\\.rar)/i.test(el.getAttribute('href'))) s += 30;
      return s;
    }
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i += 1) {
      var s = score(nodes[i]);
      if (s > bestScore) { bestScore = s; best = nodes[i]; }
    }
    if (!best) return 'no-button';
    try { best.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    best.click();
    return 'clicked:' + textOf(best).slice(0, 40);
  } catch (err) {
    return 'error:' + (err && err.message);
  }
})();
`;

const DEFAULT_TIMEOUT_MS = 45000;
const SETTLE_MS = 1500;

/**
 * Navigates `pageUrl` in a hidden window and returns the signed file URL the
 * provider's download control points at.
 *
 * @param {string} pageUrl      provider landing page
 * @param {object} [opts]
 * @param {string} [opts.referrer]   Referer to present (SteamRip gates some CDNs)
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.partition]
 * @returns {Promise<{ok:true,url:string,filename:string|null,size:number,provider:string|null}
 *                  | {ok:false,reason:string}>}
 */
function resolveInBrowser(pageUrl, opts = {}) {
  const e = electronApi();
  if (!e) return Promise.resolve({ ok: false, reason: 'background browser is only available inside the app' });

  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, reason: 'not a web mirror' });

  const userAgent = opts.userAgent || UA;
  const provider = opts.provider || null;
  const timeoutMs = Math.max(5000, Math.min(120000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));

  return new Promise((resolve) => {
    let win;
    try {
      win = new e.BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1100,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          // Hidden windows are throttled by default, which stalls the page's
          // own (challenge-solving, download-starting) scripts.
          backgroundThrottling: false,
          partition: opts.partition || 'persist:apex-mirror'
        }
      });
    } catch (err) {
      resolve({ ok: false, reason: `could not open a background window: ${err.message}` });
      return;
    }

    const sess = win.webContents.session;
    const found = [];
    let settled = false;
    let settleTimer = null;
    let idleTimer = null;
    let tries = 0;

    const cleanup = () => {
      clearTimeout(overallTimer);
      clearTimeout(settleTimer);
      clearTimeout(idleTimer);
      try { sess.removeListener('will-download', onWillDownload); } catch { /* ignore */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const pickBest = () => {
      // A page can offer a decoy (ad) download before the real one; the game
      // archive is always the largest thing on offer.
      const best = found.slice().sort((a, b) => b.size - a.size)[0];
      finish({
        ok: true,
        url: best.url,
        filename: best.filename || null,
        size: best.size || 0,
        provider,
        candidates: found.length
      });
    };

    const onWillDownload = (event, item, webContents) => {
      // The "apex-mirror" partition is shared, so ignore anything that did not
      // come from *this* window (e.g. a concurrent install's transfer).
      if (webContents && webContents !== win.webContents) return;
      let itemUrl = '';
      let size = 0;
      let filename = '';
      try { itemUrl = item.getURL(); } catch { /* ignore */ }
      try { size = Number(item.getTotalBytes()) || 0; } catch { /* ignore */ }
      try { filename = item.getFilename() || ''; } catch { /* ignore */ }
      // The browser's own copy is only used to learn the URL; the engine does
      // the real download.
      try { item.cancel(); } catch { /* ignore */ }

      if (!/^https?:\/\//i.test(itemUrl)) return;
      found.push({ url: itemUrl, size, filename });
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (found.length) pickBest(); }, SETTLE_MS);
    };

    sess.on('will-download', onWillDownload);

    // This window must never become visible, whatever the page asks for.
    win.on('show', () => { try { win.hide(); } catch { /* ignore */ } });

    // Providers (and Cloudflare) call window.open; deny it and keep the
    // navigation here so it can never surface as a new window or tab.
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (/^https?:\/\//i.test(popup)) {
        win.webContents.loadURL(popup, { userAgent }).catch(() => { /* ignore */ });
      }
      return { action: 'deny' };
    });

    win.webContents.on('did-fail-load', () => { /* -3 means a download took over; nothing to do */ });

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (found.length) pickBest();
        else finish({ ok: false, reason: 'the provider page never offered a download' });
      }, 15000);
    };

    const nudge = () => {
      // Once a download has been captured there is nothing left to press;
      // continuing would only spawn (and cancel) more redundant transfers.
      if (settled || found.length) return;
      win.webContents.executeJavaScript(CLICK_SCRIPT, true).catch(() => { /* ignore */ });
      if (++tries < 12) setTimeout(nudge, 900);
    };

    win.webContents.on('did-finish-load', () => {
      armIdle();
      nudge();
    });

    const overallTimer = setTimeout(() => {
      if (found.length) pickBest();
      else finish({ ok: false, reason: 'timed out resolving the provider page in the background' });
    }, timeoutMs);

    armIdle();

    win.loadURL(url, {
      userAgent,
      httpReferrer: opts.referrer ? String(opts.referrer) : undefined
    }).catch((err) => {
      const msg = (err && err.message) || '';
      // ERR_ABORTED is what Chromium reports when the navigation itself turns
      // into a download (a direct file URL) - that is success, not failure.
      if (/-3|ERR_ABORTED/.test(msg)) return;
      finish({ ok: false, reason: `could not open the provider page: ${msg.slice(0, 120)}` });
    });
  });
}

module.exports = {
  UA,
  CLICK_SCRIPT,
  browserAvailable,
  resolveInBrowser
};
