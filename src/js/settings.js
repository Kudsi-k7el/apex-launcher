'use strict';

/**
 * Global app state (mirrored from the main process) plus the Settings view.
 * Everything the user changes here is written to disk via `persist()` so it
 * survives a restart.
 */

const State = {
  settings: {},
  installed: {},
  owned: {},
  updates: {},
  favorites: {},
  stats: {},
  dismissed: {},
  custom: [],
  art: {},             // per-game custom artwork overrides: { [gameId]: dataUrl|url }
  artAuto: {},         // per-game artwork resolved from the web (never overrides `art`)
  logoAuto: {},        // per-game transparent wordmark resolved from the web
  installDirs: {},     // per-game install folders chosen in the installer
  local: { installs: {}, roots: {}, stores: {} },
  profile: { name: '', avatar: null, avatarUrl: null, bio: '' },
  news: { items: [], fetchedAt: null, lang: 'fr' },
  verify: {},          // last real file-verification report per game id
  preorders: {},       // titles the user registered pre-order interest in
  collections: {},     // user-made collections: id -> { name, games: [gameId] }
  bgUrl: null          // runtime data URL for the custom background (not persisted)
};

const THEMES = {
  dark: { label: 'Dark', desc: 'Balanced dark grey', accent: '#00a8ff' },
  oled: { label: 'Pitch Black OLED', desc: 'True black for OLED panels', accent: '#00a8ff' },
  neon: { label: 'Neon Accent', desc: 'Violet glow, vivid highlights', accent: '#ff2fd0' }
};

const BANDWIDTHS = [
  { v: 'unlimited', label: 'Unlimited' },
  { v: '100', label: '100 MB/s' },
  { v: '50', label: '50 MB/s' },
  { v: '25', label: '25 MB/s' },
  { v: '10', label: '10 MB/s' }
];

function applySettings() {
  const s = State.settings;
  const theme = THEMES[s.theme] ? s.theme : 'dark';
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.setProperty('--accent', s.accent || THEMES[theme].accent);
  root.classList.toggle('reduce-motion', !!s.reduceMotion);

  // Custom background picture (path persisted, bytes held as a data URL).
  const hasBg = !!(s.background && State.bgUrl);
  root.classList.toggle('has-bg', hasBg);
  root.style.setProperty('--bg-image', hasBg ? `url("${State.bgUrl}")` : 'none');
  root.style.setProperty('--bg-image-opacity', String((Number(s.backgroundOpacity) || 0) / 100));
  root.style.setProperty('--bg-image-blur', `${Number(s.backgroundBlur) || 0}px`);

  // Frosted-glass sidebar: the wallpaper stays visible (blurred) through it.
  root.classList.toggle('glass-side', s.glassSidebar !== false);
}

async function persist() {
  try { await window.api.saveState(State); } catch { /* renderer can keep running */ }
}

// ---------------------------------------------------------------------------
// Deep links into Settings
// ---------------------------------------------------------------------------
// The profile menu's "Apex account" entry needs Settings to open on one
// particular panel. Set here, consumed by renderSettings, so it still works when
// Settings has to render first (which it usually does).
let settingsJump = '';

// The Updates panel repaints from status the main process pushes. One
// subscription is registered for the life of the page, re-pointed at the newest
// DOM on every render - re-subscribing each render would stack listeners.
let paintUpdate = null;
let updateHooked = false;

/** Opens Settings on the named panel the next time it renders. */
function focusSettingsSection(anchor) {
  settingsJump = String(anchor || '');
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
function renderSettings(el) {
  clearInterval(slideTimer);
  const s = State.settings;
  const linkedCount = Object.keys((State.local && State.local.installs) || {}).length;
  const bgOpacity = Math.max(0, Math.min(100, Number(s.backgroundOpacity ?? 45)));
  const bgBlur = Math.max(0, Math.min(24, Number(s.backgroundBlur) || 0));
  const uiVol = Math.max(0, Math.min(100, Number(s.uiVolume ?? 60)));
  const itchKey = String((s.itch && s.itch.apiKey) || '');
  const itchUser = String((s.itch && s.itch.username) || '');
  const disc = (s.discord && typeof s.discord === 'object') ? s.discord : {};
  const discOn = !!(disc.enabled && disc.clientId);
  const apiUrl = String((s.api && s.api.baseUrl) || '');
  // The token itself never reaches the renderer (see rendererState in main.js);
  // `signedIn` is the main process' answer to "is this session good?".
  const apiSignedIn = !!(s.api && s.api.signedIn);
  const apiName = String((s.api && s.api.name) || '');
  const apiEmail = String((s.api && s.api.email) || '');
  const acctRequired = !((s.auth && typeof s.auth === 'object') ? s.auth.required === false : false);
  const apiStatusText = apiSignedIn
    ? `Signed in as ${apiName || apiEmail || 'your account'}${apiEmail && apiName ? ` (${apiEmail})` : ''}`
    : (apiUrl ? `Server set to ${apiUrl}, not signed in` : 'No server configured');
  const pl = (s.pl && typeof s.pl === 'object') ? s.pl : {};
  const plFixSrc = String(pl.fixSource || '');
  const plSlSrc = String(pl.steamlessSource || '');
  const plGofileToken = String(pl.gofileToken || '');
  const plCatText = 'Bundled copies ship with Apex — refresh to pull the latest Bypass and OnlineFix lists from GitHub.';

  const toggle = (key, ico, label, desc) => `
    <div class="setting-row">
      <div class="s-ico">${icon(ico, 20)}</div>
      <div class="s-text"><h4>${label}</h4><p>${desc}</p></div>
      <label class="switch"><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}><span class="slider"></span></label>
    </div>`;

  const pathRow = (key, ico, label, desc) => `
    <div class="setting-row">
      <div class="s-ico">${icon(ico, 20)}</div>
      <div class="s-text"><h4>${label}</h4><p>${desc}</p><code id="p-${key}">${esc(s[key])}</code></div>
      <button class="btn secondary" data-browse="${key}">${icon('folder', 15)} Browse</button>
    </div>`;

  // Overlay / capture / achievements. Each of these blocks is merged key by key
  // against the defaults (see load()), so reading them here is always safe.
  const ov = (s.overlay && typeof s.overlay === 'object') ? s.overlay : {};
  const sc = (s.screenshot && typeof s.screenshot === 'object') ? s.screenshot : {};
  const ach = (s.achievements && typeof s.achievements === 'object') ? s.achievements : {};
  const achSteam = (ach.steam && typeof ach.steam === 'object') ? ach.steam : {};
  const ovOn = ov.enabled !== false;
  const ovAuto = ov.auto !== false;
  const ovKey = String(ov.key || 'F8');
  const ovCorner = String(ov.corner || 'top-left');
  const ovOpacity = Math.max(55, Math.min(100, Number(ov.opacity ?? 92)));
  const scOn = sc.enabled !== false;
  const scKey = String(sc.key || 'F2');
  const scSound = sc.sound !== false;
  const achOn = ach.enabled !== false;
  const achKey = String(achSteam.apiKey || '');
  const achId = String(achSteam.steamId || '');

  const opt = (v, label, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;

  // The keys the overlay and the capture hotkey are allowed to take. Global
  // shortcuts are exclusive, so a short, explicit list beats a free-text box
  // that could silently swallow a key the user needs elsewhere.
  const HOTKEY_CHOICES = ['F2', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

  el.innerHTML = `
    <h1 class="page-title">Settings</h1>

    <section class="panel">
      <h3>Appearance</h3>
      <div class="setting-row col">
        <div class="s-text wide"><h4>Theme</h4><p>Pick the overall look of Apex Launcher</p></div>
        <div class="theme-grid">
          ${Object.entries(THEMES).map(([k, t]) => `
            <button class="theme-card ${(s.theme || 'dark') === k ? 'active' : ''}" data-theme-pick="${k}">
              <span class="theme-preview" data-theme-preview="${k}">
                <i class="tp-side"></i><i class="tp-panel"></i><i class="tp-accent"></i><i class="tp-panel2"></i>
              </span>
              <span class="tp-text"><strong>${t.label}</strong><small>${t.desc}</small></span>
              <span class="tp-check">${(s.theme || 'dark') === k ? icon('check', 15) : ''}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('palette', 20)}</div>
        <div class="s-text"><h4>Accent color</h4><p>Highlight color used across buttons, tabs and glows</p></div>
        <input type="color" id="accent" value="${s.accent || '#00a8ff'}">
      </div>
      ${toggle('reduceMotion', 'zap', 'Reduce motion', 'Minimize animations and hover effects')}
      ${toggle('glassSidebar', 'layers', 'Frosted sidebar', 'Blur the sidebar so the artwork behind it shows through')}
    </section>

    <section class="panel">
      <h3>Controller &amp; Sound</h3>
      <p class="panel-note">Plug in an Xbox, PlayStation or generic pad and Apex picks it up straight away &mdash; a notice appears the moment it connects. The d-pad and the left stick walk the whole interface, A selects and B goes back, on every screen and in Big Picture alike.</p>

      <div class="setting-row">
        <div class="s-ico">${icon('tv', 20)}</div>
        <div class="s-text"><h4>Big Picture mode</h4><p>A full-screen, controller-first layout: oversized tiles, one hero panel and a key legend along the bottom</p></div>
        <button class="btn primary glow" id="open-bigpic">${icon('tv', 15)} Enter Big Picture</button>
      </div>

      ${toggle('controller', 'gamepad', 'Controller support', 'Detect gamepads, announce them when they connect, and navigate with the d-pad')}

      <div class="setting-row">
        <div class="s-ico">${icon('cpu', 20)}</div>
        <div class="s-text"><h4>Detected controllers</h4><p id="pad-readout">No controller connected</p></div>
        <span class="pill static" id="pad-pill">Idle</span>
      </div>

      <div class="setting-row" id="pad-live-row">
        <div class="s-ico">${icon('gamepad', 20)}</div>
        <div class="s-text"><h4>Live input</h4>
          <p id="pad-live">Press a button or move a stick to test the pad.</p>
          <code id="pad-axes">&nbsp;</code>
        </div>
      </div>

      ${toggle('uiSounds', 'volume', 'UI sound effects', 'Select, back and panel cues, synthesised inside the app')}

      <div class="setting-row">
        <div class="s-ico">${icon('volume', 20)}</div>
        <div class="s-text"><h4>Sound volume</h4><p>How loud the interface cues are</p></div>
        <label class="bg-range set-vol"><span><b id="ui-vol-val">${uiVol}%</b></span>
          <input type="range" id="ui-volume" min="0" max="100" step="5" value="${uiVol}" ${s.uiSounds === false ? 'disabled' : ''}></label>
      </div>

      ${toggle('bigPictureFullscreen', 'fullscreen', 'Big Picture goes full screen', 'The window takes the whole screen while Big Picture is open and comes back on the way out')}

      <div class="keymap">
        <h4>${icon('gamepad', 15)} Controls</h4>
        <div class="keymap-grid">
          ${[
            ['Move focus', '\u2190 \u2191 \u2193 \u2192', 'D-pad / left stick'],
            ['Select', 'Enter', 'A / \u2715'],
            ['Back', 'Esc', 'B / \u25CB'],
            ['Change section', 'Tab', 'LB / RB'],
            ['Menu', '\u2014', 'Start / Options'],
            ['Full screen', 'F11', '\u2014'],
            ['Mute UI sounds', '\u2014', 'X / \u25A1']
          ].map(([what, keys, pad]) => `<div class="km-row">
            <span class="km-what">${esc(what)}</span>
            <span class="km-keys">${keys.split(' ').filter((k) => k && k !== '\u2014').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ') || '<span class="km-none">\u2014</span>'}</span>
            <span class="km-pad">${esc(pad)}</span>
          </div>`).join('')}
        </div>
      </div>
    </section>

    <section class="panel">
      <h3>Performance overlay</h3>
      <div class="setting-row">
        <div class="s-ico">${icon('activity', 20)}</div>
        <div class="s-text"><h4>Show the performance overlay</h4>
          <p>A small always-on-top panel with real CPU, GPU, RAM and game-process numbers.
          It floats over the game, stays click-through, and never takes the keyboard.
          It reports the compositor's own present rate &mdash; never a made-up game FPS.</p></div>
        <label class="switch"><input type="checkbox" id="ov-enabled" ${ovOn ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('rocket', 20)}</div>
        <div class="s-text"><h4>Open it automatically</h4>
          <p>Shows the overlay when a game launches and closes it when the game exits.
          Turning this off leaves it to the hotkey or the title-bar button.</p></div>
        <label class="switch"><input type="checkbox" id="ov-auto" ${ovAuto ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('grid', 20)}</div>
        <div class="s-text"><h4>Corner</h4><p>Where the panel sits. Corners avoid the middle of the screen on purpose.</p></div>
        <select class="select" id="ov-corner">
          ${opt('top-left', 'Top left', ovCorner)}
          ${opt('top-right', 'Top right', ovCorner)}
          ${opt('bottom-left', 'Bottom left', ovCorner)}
          ${opt('bottom-right', 'Bottom right', ovCorner)}
        </select>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('keyboard', 20)}</div>
        <div class="s-text"><h4>Shortcut</h4><p>Works from anywhere, including while a game has focus.</p></div>
        <select class="select" id="ov-key">${HOTKEY_CHOICES.map((k) => opt(k, k, ovKey)).join('')}</select>
      </div>
      <div class="setting-row col">
        <div class="s-text wide"><h4>Opacity</h4><p>How solid the panel is over the game.</p></div>
        <label class="set-range"><span><b id="ov-opacity-val">${ovOpacity}%</b></span>
          <input type="range" id="ov-opacity" min="55" max="100" step="1" value="${ovOpacity}"></label>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('eye', 20)}</div>
        <div class="s-text"><h4>Try it</h4><p>Opens the overlay on the desktop so you can check the placement.</p></div>
        <button class="btn secondary" id="ov-test">${icon('play', 15)} Show overlay</button>
      </div>
    </section>

    <section class="panel">
      <h3>Screenshots</h3>
      <div class="setting-row">
        <div class="s-ico">${icon('camera', 20)}</div>
        <div class="s-text"><h4>Screenshot hotkey</h4>
          <p>Saves a full-quality PNG of the screen &mdash; game or launcher &mdash; into your screenshot folder.</p></div>
        <label class="switch"><input type="checkbox" id="sc-enabled" ${scOn ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('keyboard', 20)}</div>
        <div class="s-text"><h4>Which key</h4><p>It has to be a key no game is likely to want.</p></div>
        <select class="select" id="sc-key">${HOTKEY_CHOICES.filter((k) => k !== ovKey).map((k) => opt(k, k, scKey)).join('')}</select>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('volume', 20)}</div>
        <div class="s-text"><h4>Shutter sound</h4><p>Play the launcher's capture cue when a screenshot is saved.</p></div>
        <label class="switch"><input type="checkbox" id="sc-sound" ${scSound ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('folder', 20)}</div>
        <div class="s-text"><h4>Screenshot folder</h4><p>Every capture lives here, with thumbnails the Gallery can load quickly.</p>
          <code id="sc-dir">pictures / Apex Launcher</code></div>
        <button class="btn secondary" id="sc-open">${icon('external', 15)} Open folder</button>
      </div>
    </section>

    <section class="panel">
      <h3>Achievements</h3>
      <div class="setting-row">
        <div class="s-ico">${icon('trophy', 20)}</div>
        <div class="s-text"><h4>Achievement pop-ups</h4>
          <p>Slide-in notices when you earn something &mdash; Apex's own, and, once connected,
          the real ones from Steam.</p></div>
        <label class="switch"><input type="checkbox" id="ach-enabled" ${achOn ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row col">
        <div class="s-text wide"><h4>Steam Web API key</h4>
          <p>Your own key, kept on this PC and only ever sent to Valve's API. Create one at
          <a class="set-link" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">steamcommunity.com/dev/apikey</a>
          &mdash; it takes a minute and costs nothing. Apex never sees or stores it for you.</p></div>
        <div class="set-inline">
          <input class="set-input" id="ach-key" type="password" spellcheck="false" autocomplete="off"
                 placeholder="32-character key" value="${esc(achKey)}">
          <button class="btn secondary" id="ach-detect">${icon('userCheck', 15)} Detect my account</button>
        </div>
      </div>
      <div class="setting-row col">
        <div class="s-text wide"><h4>SteamID64</h4>
          <p>The 17-digit number for your profile. \"Detect\" reads it from the Steam client on this PC,
          or paste your profile URL and Apex will resolve it.</p></div>
        <div class="set-inline">
          <input class="set-input" id="ach-id" type="text" spellcheck="false" autocomplete="off"
                 placeholder="7656119&hellip; or your profile URL" value="${esc(achId)}">
          <button class="btn primary" id="ach-save">${icon('check', 15)} Save &amp; connect</button>
        </div>
        <small class="set-status" id="ach-status"></small>
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('news', 20)}</div>
        <div class="s-text"><h4>What changed?</h4><p>The bundled changelog for this build, plus everything before it.</p></div>
        <button class="btn secondary" data-act="changelog-open">${icon('list', 15)} Open changelog</button>
      </div>
    </section>

    <section class="panel">
      <h3>Background</h3>
      <div class="setting-row col">
        <div class="s-text wide"><h4>Custom background picture</h4>
          <p>Use your own image behind the whole launcher. It is stored locally and restored every time Apex starts.</p></div>
        <div class="bg-picker">
          <div class="bg-preview ${s.background ? 'has' : ''}" id="bg-preview">
            ${s.background ? '' : `${icon('palette', 26)}<span>No background selected</span>`}
          </div>
          <div class="bg-controls">
            <div class="bg-buttons">
              <button class="btn secondary" id="bg-pick">${icon('folder', 15)} Choose image&hellip;</button>
              <button class="btn danger" id="bg-clear" ${s.background ? '' : 'disabled'}>${icon('trash', 15)} Remove</button>
            </div>
            <label class="bg-range"><span>Opacity <b id="bg-opacity-val">${bgOpacity}%</b></span>
              <input type="range" id="bg-opacity" min="0" max="100" step="1" value="${bgOpacity}"></label>
            <label class="bg-range"><span>Blur <b id="bg-blur-val">${bgBlur}px</b></span>
              <input type="range" id="bg-blur" min="0" max="24" step="1" value="${bgBlur}"></label>
            <code id="bg-path">${esc(s.background || 'No image selected')}</code>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <h3>Downloads &amp; Storage</h3>
      <div class="setting-row col">
        <div class="s-text wide"><h4>Where games install</h4>
          <p>The drive new installs default to, with its real free space. The installer still
          asks every time, so you can put an individual game somewhere else.</p></div>
        <div class="drive-list static" id="set-drives"></div>
        <div class="ip-dest">
          <small>Games go to</small>
          <code id="set-dest">${esc(defaultInstallRoot())}</code>
        </div>
        <button class="btn secondary set-custom-btn" id="set-custom">
          ${icon('folder', 15)} Use a custom folder instead
        </button>
      </div>
      ${pathRow('downloadPath', 'folder', 'Downloads directory', 'Temporary location for downloads')}
      <div class="setting-row">
        <div class="s-ico">${icon('wifi', 20)}</div>
        <div class="s-text"><h4>Download speed limit</h4><p>Cap the bandwidth used by the download manager</p></div>
        <select id="bandwidth" class="select">
          ${BANDWIDTHS.map((b) => `<option value="${b.v}" ${s.bandwidth === b.v ? 'selected' : ''}>${b.label}</option>`).join('')}
        </select>
      </div>
      ${toggle('autoUpdate', 'refresh', 'Auto-update games', 'Keep installed games up to date automatically')}
      ${toggle('cloudSaves', 'cloud', 'Enable Cloud Saves', 'Sync save files across your devices')}
    </section>

    <section class="panel">
      <h3>Game Stores</h3>
      <p class="panel-note">Apex reads each store's own local library so the games you already own appear in your Library with the right launcher. Titles are launched through the store client you bought them from &mdash; nothing is downloaded here on your behalf.</p>
      <div class="store-grid">
        ${STORES.map((st) => {
          const info = ((State.local && State.local.stores) || {})[st.id] || {};
          const found = !!info.path;
          return `<div class="store-tile ${found ? 'found' : ''}">
            <span class="store-ico">${icon(st.ico, 17)}</span>
            <span class="store-text">
              <strong>${esc(st.name)}</strong>
              <small title="${esc(info.path || '')}">${found ? esc(info.path) : 'Not detected on this PC'}</small>
            </span>
            <span class="store-badge">${found ? icon('checkCircle', 16) : ''}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="setting-row">
        <div class="s-ico">${icon('gamepad', 20)}</div>
        <div class="s-text"><h4>Linked games</h4><p>Games with a real executable or launcher link on this PC</p>
          <code id="local-count">${linkedCount} linked \u00b7 ${(State.custom || []).length} custom</code></div>
        <div class="about-actions">
          <button class="btn secondary" data-local="scan">${icon('search', 15)} Scan now</button>
          <button class="btn secondary" data-local="add">${icon('plus', 15)} Add game</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h3>System</h3>
      ${toggle('minimizeToTray', 'tray', 'Keep running in the system tray', 'Closing the window keeps Apex Launcher running so downloads continue')}
      ${toggle('hideOnMinimize', 'min', 'Minimize to tray', 'Minimising hides Apex to the tray instead of the taskbar')}
      ${toggle('startOnBoot', 'power', 'Start app on system boot', 'Launch automatically when you sign in')}
      ${toggle('notifications', 'bell', 'Desktop notifications', 'Show toasts for installs, updates and launches')}
    </section>

    <section class="panel">
      <h3>itch.io</h3>
      <p class="panel-note">Browsing itch.io needs no account at all &mdash; the itch.io tab reads the site's own
      public feeds and game pages. Downloading a build is the part that needs an identity, because itch.io only
      hands out a file link to an account it can recognise. Paste your own API key below and Apex asks itch.io
      on your behalf: the key is stored on this PC and is sent nowhere except itch.io.</p>

      <div class="setting-row col">
        <div class="s-text wide">
          <h4>API key</h4>
          <p>Generate one at <b>itch.io/user/settings/api-keys</b>. A paid title is only ever offered for
          download when the account behind the key already owns it.</p>
        </div>
        <div class="itch-key">
          <input type="password" id="itch-key" class="select" spellcheck="false" autocomplete="off"
            placeholder="Paste your itch.io API key&hellip;" value="${esc(itchKey)}">
          <button class="btn primary" id="itch-save">${icon('check', 15)} Save &amp; connect</button>
          <button class="btn secondary" id="itch-get">${icon('external', 15)} Get a key</button>
          ${itchKey ? `<button class="btn danger" id="itch-clear">${icon('trash', 15)} Disconnect</button>` : ''}
        </div>
        <div class="itch-conn ${itchUser ? 'ok' : ''}" id="itch-conn">
          ${itchUser
            ? `${icon('checkCircle', 16)} Connected as <b>${esc(itchUser)}</b>`
            : `${icon('info', 16)} Not connected &mdash; browsing works, installing from itch.io does not.`}
        </div>
      </div>
    </section>

    <section class="panel">
      <h3>Project Lightning tools</h3>
      <p class="panel-note">The Bypass and OnlineFix catalogues ship with Apex and can be refreshed from the
      project's own GitHub. Applying a fix copies files you already have on disk (or a fix archive you point it
      at) onto a game's install folder; SteamLess swaps the Steamworks DLLs. Apex backs up everything it
      replaces &mdash; find the backups under <b>apex-fix-backups</b> in your Apex data folder.</p>

      <div class="setting-row">
        <div class="s-ico">${icon('shield', 20)}</div>
        <div class="s-text"><h4>Catalogues</h4>
          <p id="pl-cat-text">${plCatText}</p></div>
        <button class="btn primary" id="pl-refresh">${icon('refresh', 15)} Refresh from GitHub</button>
      </div>

      <div class="setting-row">
        <div class="s-ico">${icon('folder', 20)}</div>
        <div class="s-text"><h4>Default fix source folder</h4>
          <p>Where your prepared fix files live. Pre-filled when you apply a Bypass or OnlineFix.</p>
          <code id="pl-fix-src">${esc(plFixSrc || 'No folder selected')}</code></div>
        <button class="btn secondary" data-pl-browse="fixSource">${icon('folder', 15)} Browse</button>
      </div>

      <div class="setting-row">
        <div class="s-ico">${icon('box', 20)}</div>
        <div class="s-text"><h4>Default replacement DLL folder</h4>
          <p>Holds the <code>steam_api.dll</code> / <code>steam_api64.dll</code> copies SteamLess should swap in.</p>
          <code id="pl-sl-src">${esc(plSlSrc || 'No folder selected')}</code></div>
        <button class="btn secondary" data-pl-browse="steamlessSource">${icon('folder', 15)} Browse</button>
      </div>

      <div class="setting-row col">
        <div class="s-text wide">
          <h4>GoFile token</h4>
          <p>Optional. GoFile no longer lets guest accounts list a folder&rsquo;s files, so GoFile mirrors are
          skipped unless you supply your own token &mdash; every other provider keeps working without it.
          Sign in at <b>gofile.io</b> and copy the <code>accountToken</code> cookie value.</p>
        </div>
        <div class="itch-key">
          <input type="text" id="pl-gofile-token" class="select" spellcheck="false" autocomplete="off"
            placeholder="paste your GoFile account token" value="${esc(plGofileToken)}">
          <button class="btn primary" id="pl-gofile-save">${icon('check', 15)} Save</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h3>Discord Rich Presence</h3>
      <p class="panel-note">Shows what you are doing in Apex on your Discord profile &mdash; &ldquo;Browsing Apex Launcher&rdquo;,
      or the game you are playing with a live timer. Apex only writes to the Discord client running on this PC;
      nothing is sent to any server of ours. It needs your own Discord application: create one at
      <b>discord.com/developers/applications</b> and paste its Application ID below.</p>

      <div class="setting-row">
        <div class="s-ico">${icon('gamepad', 20)}</div>
        <div class="s-text"><h4>Show my activity</h4><p>Off by default. The Discord desktop app must be running.</p></div>
        <label class="switch"><input type="checkbox" id="discord-on" ${disc.enabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <div class="setting-row col">
        <div class="s-text wide">
          <h4>Application ID</h4>
          <p>From your own Discord app. Optional: upload an image named <b>apex</b> under Rich Presence &gt; Art Assets
          and it becomes the card&rsquo;s artwork.</p>
        </div>
        <div class="itch-key">
          <input type="text" id="discord-id" class="select" spellcheck="false" autocomplete="off"
            placeholder="e.g. 123456789012345678" value="${esc(disc.clientId || '')}">
          <button class="btn primary" id="discord-save">${icon('check', 15)} Save</button>
          <button class="btn secondary" id="discord-portal">${icon('external', 15)} Create an app</button>
        </div>
        <div class="itch-conn" id="discord-conn">
          ${discOn ? `${icon('info', 16)} Waiting for Discord&hellip;` : `${icon('info', 16)} Off &mdash; paste an Application ID and switch it on.`}
        </div>
      </div>
    </section>

    <section class="panel" data-anchor="account">
      <h3>Apex account</h3>
      <p class="panel-note">Apex Launcher asks for an account before it will play: your profile, achievements and saves
      live on it and follow you to any PC you sign in on. The account is stored on your own backend &mdash; nowhere else.</p>

      <div class="acct-line">
        <span class="acct-dot ${apiSignedIn ? 'is-on' : (apiUrl ? 'is-warn' : '')}"></span>
        <strong>${apiSignedIn ? esc(apiName || 'Signed in') : 'Not signed in'}</strong>
        <span id="api-status-text">${esc(apiStatusText)}</span>
      </div>

      ${apiSignedIn ? `
        <div class="acct-grid">
          <button class="btn secondary" data-acct="site-download">${icon('download', 15)} Get the installer</button>
          <button class="btn secondary" data-acct="site-account">${icon('globe', 15)} Account on the website</button>
          <button class="btn secondary" data-acct="switch">${icon('userCheck', 15)} Switch account</button>
          <button class="btn danger" data-acct="out">${icon('power', 15)} Sign out</button>
        </div>

        <div class="setting-row">
          <div class="s-ico">${icon('key', 20)}</div>
          <div class="s-text"><h4>Password</h4><p>Changing it signs you out of every other device.</p></div>
          <button class="btn secondary" data-acct="pass-open">${icon('edit', 15)} Change</button>
        </div>
        <div class="acct-grid" id="acct-pass-box" hidden>
          <label class="field"><span>Current password</span>
            <input id="acct-pass-cur" type="password" autocomplete="current-password"></label>
          <label class="field"><span>New password</span>
            <input id="acct-pass-new" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
          <button class="btn primary" data-acct="pass-save">${icon('check', 15)} Save new password</button>
        </div>
      ` : `
        <div class="acct-grid">
          <button class="btn primary" data-acct="signin">${icon('userCheck', 15)} Sign in</button>
          <button class="btn secondary" data-acct="signup">${icon('user', 15)} Create an account</button>
          <button class="btn secondary" data-acct="site-account">${icon('globe', 15)} Account on the website</button>
        </div>
      `}

      <div class="setting-row">
        <div class="s-ico">${icon('globe', 20)}</div>
        <div class="s-text"><h4>Server</h4><p>The Apex account server, fixed for this build. It cannot be changed.</p>
          <code id="api-url-code">${esc(apiUrl || 'none')}</code></div>
        <button class="btn secondary" id="api-configure" disabled
          title="Baked into the launcher - it cannot be pointed anywhere else">${icon('lock', 15)} Locked</button>
      </div>

      <div class="setting-row">
        <div class="s-ico">${icon('lock', 20)}</div>
        <div class="s-text"><h4>Require an account</h4><p>Apex refuses to launch, install or download while signed out.</p></div>
        <label class="switch"><input type="checkbox" id="acct-require" ${acctRequired ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <p class="acct-note">Passwords are stored as a salted scrypt hash on your server. Apex keeps only the session
      token, and only ever sends it to the address above.</p>
    </section>

    <section class="panel">
      <h3>Privacy</h3>
      ${toggle('telemetry', 'shield', 'Share anonymous telemetry', 'Help improve Apex Launcher by sharing anonymous usage statistics')}
      <div class="setting-row">
        <div class="s-ico">${icon('globe', 20)}</div>
        <div class="s-text"><h4>Data policy</h4><p>Telemetry is off by default. No personal data is ever collected.</p></div>
        <button class="btn secondary" data-act="toast" data-msg="No data has been collected">Learn more</button>
      </div>
    </section>

    <section class="panel">
      <h3>About</h3>
      <div class="about">
        <span class="logo-lg" data-icon="flame" data-size="22"></span>
        <div class="about-text">
          <strong>Apex Launcher</strong>
          <small id="about-ver">version&hellip;</small>
          <small id="about-sys"></small>
        </div>
        <div class="about-actions">
          <button class="btn secondary" id="about-open">${icon('external', 15)} Install folder</button>
          <button class="btn danger" id="reset-settings">${icon('refresh', 15)} Reset settings</button>
        </div>
      </div>
    </section>

    <section class="panel" data-anchor="updates">
      <h3>Updates</h3>
      <div class="setting-row">
        <div class="s-ico">${icon('download', 20)}</div>
        <div class="s-text">
          <h4 id="upd-title">Checking for updates&hellip;</h4>
          <p id="upd-note">Apex Launcher keeps itself up to date.</p>
        </div>
        <button class="btn secondary" id="upd-check">${icon('refresh', 15)} Check now</button>
      </div>
      <div class="upd-track" id="upd-track" hidden><span id="upd-fill"></span></div>
    </section>`;

  hydrateIcons(el);

  // physical drives + the default install location
  fillSettingsDrives(el);

  // toggles
  el.querySelectorAll('input[data-key]').forEach((i) => i.addEventListener('change', async () => {
    State.settings[i.dataset.key] = i.checked;
    applySettings();
    await persist();
    // Switching the controller layer back on should re-arm it at once rather
    // than waiting for the next launch.
    if (i.dataset.key === 'controller' && i.checked && typeof startControllers === 'function') startControllers();
    SFX.play('toggle');
    toast('Settings saved', 'check');
  }));

  // --- Overlay, capture and achievements -------------------------------------
  // A shared saver: write the group, then let the main process re-read it. The
  // renderer never tells the main process what a shortcut *should* be - it is
  // the state file that decides, and that keeps one source of truth.
  const saveGroup = async (group, patch, opts = {}) => {
    State.settings[group] = { ...(State.settings[group] || {}), ...patch };
    await persist();

    let bound = null;
    if (opts.hotkeys !== false) {
      bound = await window.api.applyHotkeys().catch(() => null);
    }
    if (opts.sound !== false) SFX.play('toggle');

    if (opts.hotkeys !== false && bound) {
      const taken = [];
      if (group === 'overlay' && bound.overlay === false) taken.push(State.settings.overlay.key);
      if (group === 'screenshot' && bound.screenshot === false) taken.push(State.settings.screenshot.key);
      if (taken.length) {
        toast(`Windows would not give Apex ${taken.join(' or ')} — another app is using it`, 'warn');
        return;
      }
    }
    if (opts.toast !== false) toast('Settings saved', 'check');
  };

  const bindEl = (sel, ev, fn) => {
    const n = el.querySelector(sel);
    if (n) n.addEventListener(ev, fn);
    return n;
  };

  // Overlay
  bindEl('#ov-enabled', 'change', (e) => saveGroup('overlay', { enabled: e.target.checked }));
  bindEl('#ov-auto', 'change', (e) => saveGroup('overlay', { auto: e.target.checked }));
  bindEl('#ov-corner', 'change', (e) => saveGroup('overlay', { corner: e.target.value }));
  bindEl('#ov-key', 'change', (e) => saveGroup('overlay', { key: e.target.value }));

  const ovRange = el.querySelector('#ov-opacity');
  if (ovRange) {
    const ovLabel = el.querySelector('#ov-opacity-val');
    let ovDebounce = null;
    ovRange.addEventListener('input', () => {
      const v = Math.max(55, Math.min(100, Number(ovRange.value) || 92));
      if (ovLabel) ovLabel.textContent = `${v}%`;
      clearTimeout(ovDebounce);
      ovDebounce = setTimeout(() => {
        saveGroup('overlay', { opacity: v }, { sound: false, toast: false });
      }, 220);
    });
  }

  bindEl('#ov-test', 'click', async () => {
    const st = await window.api.perfShow().catch(() => null);
    const key = String((State.settings.overlay || {}).key || 'F8');
    if (st && st.open) toast(`Overlay shown — press ${key} again to hide it`, 'check');
    else toast('The overlay is switched off in Settings', 'warn');
  });

  // Screenshots
  bindEl('#sc-enabled', 'change', (e) => saveGroup('screenshot', { enabled: e.target.checked }));
  bindEl('#sc-key', 'change', (e) => saveGroup('screenshot', { key: e.target.value }));
  bindEl('#sc-sound', 'change', (e) => saveGroup('screenshot', { sound: e.target.checked }));
  bindEl('#sc-open', 'click', () => window.api.shotsOpen().catch(() => null));

  // The real folder is wherever the main process put it, not a guess.
  window.api.shotsList().then((data) => {
    const out = document.getElementById('sc-dir');
    if (out && data && data.dir) out.textContent = data.dir;
  }).catch(() => {});

  // Achievements
  bindEl('#ach-enabled', 'change', (e) => saveGroup('achievements', { enabled: e.target.checked }, { hotkeys: false }));

  const achKeyInput = el.querySelector('#ach-key');
  const achIdInput = el.querySelector('#ach-id');
  const achStatusEl = el.querySelector('#ach-status');
  const setAchStatus = (text, tone) => {
    if (!achStatusEl) return;
    achStatusEl.textContent = text || '';
    achStatusEl.dataset.tone = tone || '';
  };

  const saveSteam = async () => {
    const key = String((achKeyInput && achKeyInput.value) || '').trim();
    let id = String((achIdInput && achIdInput.value) || '').trim();
    const base = { ...(State.settings.achievements || {}) };

    // The key has to be on disk before anything can use it: the main process
    // re-reads the state file rather than trusting this window.
    base.steam = { ...(base.steam || {}), apiKey: key };
    State.settings.achievements = base;
    await persist();
    await window.api.steamApiApply().catch(() => null);

    if (id && !/^\d{17}$/.test(id)) {
      const res = await window.api.steamApiResolveId(id).catch(() => null);
      if (res && res.ok && res.steamId) {
        id = res.steamId;
        if (achIdInput) achIdInput.value = id;
      } else if (res && res.error === 'key') {
        setAchStatus('That looks like a profile URL — Apex needs a working API key to look it up.', 'warn');
        return;
      } else {
        setAchStatus('Could not find that Steam profile.', 'warn');
        return;
      }
    }

    State.settings.achievements = { ...base, steam: { ...base.steam, steamId: id } };
    await persist();
    const st = await window.api.steamApiApply().catch(() => null);

    if (!st) setAchStatus('Could not reach Steam right now. The key is saved.', 'warn');
    else if (!st.hasKey) setAchStatus('Add your Web API key first.', 'warn');
    else if (!st.steamId) setAchStatus('Key saved. Add your SteamID64 to finish.', 'warn');
    else if (st.configured) setAchStatus(`Connected. Steam achievements will load for your Steam games (ID ${st.steamId}).`, 'ok');
    else setAchStatus('Saved, but Steam did not confirm the connection.', 'warn');
  };

  bindEl('#ach-save', 'click', saveSteam);
  if (achIdInput) achIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSteam(); }
  });
  if (achKeyInput) achKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSteam(); }
  });

  bindEl('#ach-detect', 'click', async () => {
    const res = await window.api.steamApiDetectId().catch(() => null);
    if (!res || !res.ok) {
      setAchStatus('No Steam account found on this PC — paste your profile URL instead.', 'warn');
      return;
    }
    if (achIdInput) achIdInput.value = res.steamId;
    // Only fills the box: connecting is the user's call, not a side effect of
    // pressing a button called "detect".
    setAchStatus(`Found ${res.persona || 'a Steam account'} (${res.steamId}). Press Save & connect.`, 'info');
  });

  // A key that was saved earlier should say so as soon as the panel is opened.
  if (achKeyInput && achKeyInput.value) {
    window.api.steamApiStatus().then((st) => {
      if (!st) return;
      if (st.configured) setAchStatus(`Connected (ID ${st.steamId}).`, 'ok');
      else if (st.hasKey && !st.steamId) setAchStatus('Key saved. Add your SteamID64 to finish.', 'warn');
    }).catch(() => {});
  }

  // --- Controller & Sound ---------------------------------------------------
  // The live read-out is self-cleaning: it releases its timer as soon as the
  // view it belongs to is gone.
  const padTimer = setInterval(() => {
    const out = document.getElementById('pad-readout');
    if (!out) { clearInterval(padTimer); return; }
    const rec = (typeof GP !== 'undefined') ? GP.first() : null;
    out.textContent = rec ? `${rec.name} \u00b7 ${rec.label}` : 'No controller connected';
    const pill = document.getElementById('pad-pill');
    if (pill) {
      pill.className = `pill static ${rec ? 'play' : 'unowned'}`;
      pill.textContent = rec ? 'Connected' : 'Idle';
    }
    // Live input proves the pad is actually being read, not merely seen.
    const snap = (rec && typeof padSnapshot === 'function') ? padSnapshot() : null;
    const live = document.getElementById('pad-live');
    const axes = document.getElementById('pad-axes');
    if (live) {
      live.textContent = snap
        ? (snap.buttons.length ? `Buttons held: ${snap.buttons.join(', ')}` : 'Ready \u2014 press a button or move a stick')
        : 'Press a button or move a stick to test the pad.';
    }
    if (axes) {
      axes.textContent = snap
        ? `Left stick ${snap.left}  \u00b7  Right stick ${snap.right}  \u00b7  Triggers ${snap.triggers}`
        : '\u00a0';
    }
  }, 120);

  const bpOpen = el.querySelector('#open-bigpic');
  if (bpOpen) bpOpen.addEventListener('click', () => { SFX.play('select'); BP.enter(); });

  const volRange = el.querySelector('#ui-volume');
  if (volRange) {
    const volLabel = el.querySelector('#ui-vol-val');
    volRange.addEventListener('input', () => {
      State.settings.uiVolume = Number(volRange.value);
      if (volLabel) volLabel.textContent = `${State.settings.uiVolume}%`;
      SFX.play('move');           // a tick at the new level, live
    });
    volRange.addEventListener('change', () => persist());
  }

  // theme picker
  el.querySelectorAll('[data-theme-pick]').forEach((card) => card.addEventListener('click', async () => {
    const key = card.dataset.themePick;
    State.settings.theme = key;
    State.settings.accent = THEMES[key].accent;
    applySettings();
    await persist();
    renderSettings(el);
    toast(`${THEMES[key].label} theme applied`, 'check');
  }));

  // accent color
  el.querySelector('#accent').addEventListener('input', async (e) => {
    State.settings.accent = e.target.value;
    applySettings();
    await persist();
  });

  // bandwidth
  el.querySelector('#bandwidth').addEventListener('change', async (e) => {
    State.settings.bandwidth = e.target.value;
    await persist();
    toast('Bandwidth limit updated', 'check');
  });

  // background picture
  const bgPrev = el.querySelector('#bg-preview');
  if (bgPrev && State.bgUrl && s.background) bgPrev.style.backgroundImage = `url("${State.bgUrl}")`;

  const bgPickBtn = el.querySelector('#bg-pick');
  if (bgPickBtn) bgPickBtn.addEventListener('click', async () => {
    const picked = await window.api.pickImage(State.settings.background || undefined);
    if (!picked) return;
    const url = await window.api.readImage(picked);
    if (!url) { toast('That image could not be read (unsupported format or too large)', 'warn'); return; }
    State.settings.background = picked;
    State.bgUrl = url;
    applySettings();
    await persist();
    renderSettings(el);
    toast('Background updated', 'check');
  });

  const bgClearBtn = el.querySelector('#bg-clear');
  if (bgClearBtn) bgClearBtn.addEventListener('click', async () => {
    State.settings.background = null;
    State.bgUrl = null;
    applySettings();
    await persist();
    renderSettings(el);
    toast('Background removed', 'info');
  });

  const opRange = el.querySelector('#bg-opacity');
  if (opRange) {
    opRange.addEventListener('input', () => {
      State.settings.backgroundOpacity = Number(opRange.value);
      const lab = el.querySelector('#bg-opacity-val');
      if (lab) lab.textContent = `${opRange.value}%`;
      applySettings();
    });
    opRange.addEventListener('change', () => persist());
  }

  const blurRange = el.querySelector('#bg-blur');
  if (blurRange) {
    blurRange.addEventListener('input', () => {
      State.settings.backgroundBlur = Number(blurRange.value);
      const lab = el.querySelector('#bg-blur-val');
      if (lab) lab.textContent = `${blurRange.value}px`;
      applySettings();
    });
    blurRange.addEventListener('change', () => persist());
  }

  // folder pickers
  el.querySelectorAll('[data-browse]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.browse;
    const picked = await window.api.pickFolder(State.settings[k]);
    if (picked) {
      State.settings[k] = picked;
      document.getElementById('p-' + k).textContent = picked;
      await persist();
      toast('Path updated', 'check');
    }
  }));

  // --- itch.io --------------------------------------------------------------
  // Browsing needs nothing; this panel only exists so a build can be downloaded
  // with the user's own key. Nothing is stored but the key and the name it
  // resolves to, and the key is only ever sent to itch.io itself.
  const itchSaveBtn = el.querySelector('#itch-save');
  if (itchSaveBtn) itchSaveBtn.addEventListener('click', async () => {
    const input = el.querySelector('#itch-key');
    const key = String((input && input.value) || '').trim();
    if (!key) { toast('Paste an itch.io API key first', 'warn'); return; }

    const prev = itchSaveBtn.innerHTML;
    itchSaveBtn.disabled = true;
    itchSaveBtn.innerHTML = `${icon('refresh', 15)} Checking\u2026`;
    const res = await window.api.itchConnect(key).catch(() => null);
    itchSaveBtn.disabled = false;
    itchSaveBtn.innerHTML = prev;

    if (!res || res.ok === false) {
      toast((res && res.error) || 'That key was not accepted', 'warn');
      return;
    }
    State.settings.itch = { apiKey: key, username: res.username || '' };
    await persist();
    renderSettings(el);
    toast(`Connected to itch.io as ${res.username}`, 'check');
  });

  const itchKeyInput = el.querySelector('#itch-key');
  if (itchKeyInput && itchSaveBtn) itchKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); itchSaveBtn.click(); }
  });

  const itchGetBtn = el.querySelector('#itch-get');
  if (itchGetBtn) itchGetBtn.addEventListener('click', () => {
    if (window.api && window.api.openExternal) {
      window.api.openExternal('https://itch.io/user/settings/api-keys').catch(() => {});
    }
  });

  const itchClearBtn = el.querySelector('#itch-clear');
  if (itchClearBtn) itchClearBtn.addEventListener('click', async () => {
    State.settings.itch = { apiKey: '', username: '' };
    await persist();
    renderSettings(el);
    toast('Disconnected from itch.io', 'info');
  });

  // --- Project Lightning tools ---------------------------------------------
  // The catalogues are metadata only; the folder pickers just remember where
  // the user keeps the fix files, so the Tools dialog pre-fills them.
  const plRefreshBtn = el.querySelector('#pl-refresh');
  if (plRefreshBtn) plRefreshBtn.addEventListener('click', async () => {
    const prev = plRefreshBtn.innerHTML;
    plRefreshBtn.disabled = true;
    plRefreshBtn.innerHTML = `${icon('refresh', 15)} Refreshing…`;
    let res = null;
    try { res = await window.api.plRefresh(); } catch { res = null; }
    plRefreshBtn.disabled = false;
    plRefreshBtn.innerHTML = prev;

    const text = el.querySelector('#pl-cat-text');
    if (!res || res.ok === false) {
      const detail = res && Array.isArray(res.results)
        ? res.results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`).join('; ')
        : (res && res.error) || 'unknown error';
      if (text) text.textContent = `Refresh failed — ${detail}`;
      toast('Could not refresh the catalogues', 'warn');
      return;
    }
    const line = `Refreshed — ${res.counts.bypass} bypass, ${res.counts.onlinefix} OnlineFix entries.`;
    if (text) text.textContent = line;
    // The Tools view caches the lists; drop that cache so it reloads next time.
    if (typeof fxMeta !== 'undefined') { fxMeta = null; }
    if (typeof fxBypass !== 'undefined') { fxBypass = null; }
    if (typeof fxOnlinefix !== 'undefined') { fxOnlinefix = null; }
    toast('Catalogues refreshed from GitHub', 'check');
  });

  el.querySelectorAll('[data-pl-browse]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.plBrowse;
    State.settings.pl = State.settings.pl || {};
    const picked = await window.api.pickFolder(State.settings.pl[key] || undefined);
    if (!picked) return;
    State.settings.pl[key] = picked;
    await persist();
    const code = el.querySelector(key === 'fixSource' ? '#pl-fix-src' : '#pl-sl-src');
    if (code) code.textContent = picked;
    toast('Folder saved', 'check');
  }));

  // GoFile mirrors need an account token; the resolver reads it from settings.pl.
  const gofileSave = el.querySelector('#pl-gofile-save');
  if (gofileSave) gofileSave.addEventListener('click', async () => {
    const input = el.querySelector('#pl-gofile-token');
    State.settings.pl = State.settings.pl || {};
    State.settings.pl.gofileToken = String((input && input.value) || '').trim();
    await persist();
    toast(State.settings.pl.gofileToken ? 'GoFile token saved' : 'GoFile token cleared', 'check');
  });

  // --- Discord Rich Presence ------------------------------------------------
  // The renderer owns the wording; the main process owns the socket (discord.js).
  // Saving persists the toggle/ID and re-applies the live presence at once.
  const discordConn = el.querySelector('#discord-conn');
  const paintDiscordConn = async () => {
    if (!discordConn || !window.api || !window.api.presenceStatus) return;
    const st = await window.api.presenceStatus().catch(() => null);
    const wanted = !!(State.settings.discord && State.settings.discord.enabled && State.settings.discord.clientId);
    discordConn.className = `itch-conn ${st && st.connected ? 'ok' : ''}`;
    discordConn.innerHTML = (st && st.connected)
      ? `${icon('checkCircle', 16)} Connected to Discord`
      : wanted
        ? `${icon('info', 16)} ${esc((st && st.error) || 'Waiting for the Discord client\u2026')}`
        : `${icon('info', 16)} Off &mdash; paste an Application ID and switch it on.`;
  };

  const applyDiscord = async (patch) => {
    State.settings.discord = { ...(State.settings.discord || {}), ...patch };
    await persist();
    if (window.api && window.api.presenceConfigure) {
      await window.api.presenceConfigure(State.settings.discord).catch(() => null);
    }
    if (typeof presenceRefresh === 'function') presenceRefresh();
    paintDiscordConn();
  };

  const discordOn = el.querySelector('#discord-on');
  if (discordOn) discordOn.addEventListener('change', async () => {
    SFX.play('toggle');
    await applyDiscord({ enabled: discordOn.checked });
    toast(discordOn.checked ? 'Rich Presence on' : 'Rich Presence off', discordOn.checked ? 'check' : 'info');
  });

  const discordId = el.querySelector('#discord-id');
  const discordSave = el.querySelector('#discord-save');
  if (discordSave) discordSave.addEventListener('click', async () => {
    await applyDiscord({ clientId: String((discordId && discordId.value) || '').trim() });
    toast('Discord settings saved', 'check');
  });
  if (discordId) discordId.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (discordSave) discordSave.click(); }
  });

  const discordPortal = el.querySelector('#discord-portal');
  if (discordPortal) discordPortal.addEventListener('click', () => {
    if (window.api && window.api.openExternal) {
      window.api.openExternal('https://discord.com/developers/applications').catch(() => {});
    }
  });

  paintDiscordConn();
  // Discord may still be starting up; keep the read-out honest while on screen.
  const discTimer = setInterval(() => {
    if (!document.getElementById('discord-conn')) { clearInterval(discTimer); return; }
    paintDiscordConn();
  }, 5000);

  // --- Apex account -------------------------------------------------------
  // Every action here goes through the main process, which owns the session.
  // Signing in hands the window back to the gate (see src/js/auth.js): there is
  // one sign-in surface, not two that can disagree.
  const acctPanel = el.querySelector('[data-anchor="account"]');
  if (acctPanel) {
    const onAcct = (name, fn) => {
      const b = acctPanel.querySelector(`[data-acct="${name}"]`);
      if (b) b.addEventListener('click', fn);
    };

    onAcct('site-download', () => window.api.openSite('download'));
    onAcct('site-account', () => window.api.openSite('account'));

    onAcct('out', async () => {
      await window.api.authSignOut();
      toast('Signed out of Apex', 'info');
    });

    onAcct('switch', async () => {
      await window.api.authSignOut();
      await window.api.authRequire();
    });

    // Signed out (only reachable while the requirement is off): re-arm it, which
    // puts the sign-in gate back up.
    const arm = async () => {
      const snap = await window.api.authRequire();
      State.settings.auth = { ...(State.settings.auth || {}), required: snap ? snap.required !== false : true };
      await persist();
    };
    onAcct('signin', arm);
    onAcct('signup', arm);

    onAcct('pass-open', () => {
      const box = acctPanel.querySelector('#acct-pass-box');
      if (box) box.hidden = false;
    });

    onAcct('pass-save', async () => {
      const cur = (acctPanel.querySelector('#acct-pass-cur') || {}).value || '';
      const nxt = (acctPanel.querySelector('#acct-pass-new') || {}).value || '';
      if (nxt.length < 8) { toast('Use at least 8 characters for the new password', 'warn'); return; }
      const res = await window.api.authChangePassword({ current: cur, next: nxt });
      if (!res || !res.ok) { toast((res && res.error) || 'Could not change the password', 'warn'); return; }
      toast('Password changed', 'check');
      renderSettings(el);
    });

    const reqBox = acctPanel.querySelector('#acct-require');
    if (reqBox) reqBox.addEventListener('change', async () => {
      const snap = reqBox.checked ? await window.api.authRequire() : await window.api.authRelax();
      State.settings.auth = { ...(State.settings.auth || {}), required: snap ? snap.required !== false : reqBox.checked };
      await persist();
      toast(reqBox.checked ? 'Apex now asks for an account' : 'Apex will open without an account', 'info');
    });
  }

  // --- backend account / cloud sync ---------------------------------------
  // There is deliberately no "change server" control: the address is compiled
  // in (auth.DEFAULT_SERVER) and main.js re-forces it on every load, so the row
  // is shown read-only. #api-configure stays in the DOM, disabled, purely so
  // the setting row keeps its usual shape.

  // local game library
  el.querySelectorAll('[data-local="scan"]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.innerHTML = `${icon('refresh', 15)} Scanning\u2026`;
    const res = await scanLibraries(false);
    renderSettings(el);
    toast(res && res.merged ? `Linked ${res.merged} installed game(s)` : 'Scan complete', res && res.merged ? 'check' : 'info');
  }));
  el.querySelector('[data-local="add"]').addEventListener('click', () => {
    openAddGameModal(async (payload) => {
      await createCustomGame(payload);
      renderSettings(el);
    });
  });

  // about
  el.querySelector('#about-open').addEventListener('click', () => openLocalPath(State.settings.installPath));  el.querySelector('#reset-settings').addEventListener('click', async () => {
    const fresh = await window.api.resetState();
    Object.assign(State, fresh);
    applySettings();
    renderSettings(el);
    toast('Settings reset to defaults', 'warn');
  });

  window.api.appInfo().then((info) => {
    const v = el.querySelector('#about-ver');
    const sys = el.querySelector('#about-sys');
    if (v) v.textContent = `Version ${info.version}`;
    if (sys) sys.textContent = `${info.platform} ${info.arch} \u00b7 Electron ${info.electron} \u00b7 Chrome ${info.chrome}`;
  }).catch(() => {});

  // --- updates (see updater.js) ---------------------------------------------
  // Updating is forced: the app downloads and installs new builds on its own.
  // This panel exists purely so the user can watch it happen.
  const updTitle = el.querySelector('#upd-title');
  const updNote = el.querySelector('#upd-note');
  const updTrack = el.querySelector('#upd-track');
  const updFill = el.querySelector('#upd-fill');
  const updBtn = el.querySelector('#upd-check');

  paintUpdate = (snap) => {
    if (!snap || !updTitle) return;
    const st = String(snap.state || 'idle');
    const pct = Math.max(0, Math.min(100, Math.round(Number(snap.percent) || 0)));
    const ver = snap.version ? ` ${snap.version}` : '';
    const base = String(snap.current || '');
    const paint = (title, note, opts = {}) => {
      updTitle.textContent = title;
      if (updNote) updNote.textContent = note;
      if (updTrack) updTrack.hidden = !opts.bar;
      if (updFill) updFill.style.width = `${opts.pct || 0}%`;
      if (updBtn) updBtn.disabled = !!opts.busy;
    };

    if (st === 'unsupported') return paint('Updates are off in this build', 'Install Apex Launcher from its installer to receive updates.');
    if (st === 'checking') return paint('Checking for updates\u2026', 'Looking for a newer release.', { busy: true });
    if (st === 'available') return paint(`Update${ver} found`, 'Downloading quietly in the background\u2026', { bar: true, busy: true });
    if (st === 'downloading') return paint(`Downloading update${ver} \u2014 ${pct}%`, 'Apex Launcher restarts by itself when it is ready.', { bar: true, pct, busy: true });
    if (st === 'downloaded') return paint(`Update${ver} ready`, 'Waiting for downloads to finish, then restarting to install.', { bar: true, pct: 100, busy: true });
    if (st === 'installing') return paint('Installing update\u2026', 'Apex Launcher is restarting to finish the update.', { bar: true, pct: 100, busy: true });
    if (st === 'error') return paint('Could not update', snap.error || 'The update feed could not be reached.');
    if (st === 'current') return paint('Up to date', `Version ${base} is the newest release.`);
    return paint('Up to date', `Version ${base}. New releases install themselves.`);
  };

  if (!updateHooked) {
    updateHooked = true;
    window.api.onUpdateStatus((snap) => { if (paintUpdate) paintUpdate(snap); });
  }
  window.api.updateStatus().then((snap) => { if (paintUpdate) paintUpdate(snap); }).catch(() => {});
  if (updBtn) updBtn.addEventListener('click', async () => {
    SFX.play('click');
    paintUpdate(await window.api.updateCheck().catch(() => null));
  });

  // A deep link (see focusSettingsSection) lands on its panel and gets a pulse
  // so the eye finds it straight away.
  if (settingsJump) {
    const target = el.querySelector(`[data-anchor="${settingsJump}"]`);
    settingsJump = '';
    if (target) {
      try { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* ignore */ }
      target.classList.remove('set-flash');
      void target.offsetWidth;
      target.classList.add('set-flash');
    }
  }
}

async function openLocalPath(p) {
  const ok = await window.api.openPath(p);
  if (!ok) toast('Could not open folder', 'warn');
}
