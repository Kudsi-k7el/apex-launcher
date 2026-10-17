# Apex Launcher — companion site

A single-page, dark-themed landing page and download page for the launcher.
No framework, no build step, no external fonts or CDNs — three files and a
folder of images.

```
website/
├── index.html              # the whole page
├── assets/
│   ├── css/styles.css      # one stylesheet, 5 switchable themes
│   ├── js/main.js          # release config, theme picker, nav, gallery, reveal
│   └── img/                # logo + real screenshots (WebP, 1920px)
└── README.md
```

## Previewing it

The page uses relative asset paths, so serve the **repository root** and open
`/website/` — that way the download button's `../dist/…` path resolves too.

```powershell
python -m http.server 8080
# then open http://localhost:8080/website/
```

Opening `index.html` straight from disk (`file://`) also works, but the
installer probe is skipped there, so the download button will not warn you when
the build is missing.

## Themes

Five themes, switchable from the palette button in the top-right. The first
three deliberately match the launcher's own **Settings → Appearance** options,
so the site and the app can be set to the same look:

| Theme | Accent | Notes |
|---|---|---|
| **Dark** | `#00a8ff` | default |
| **Pitch Black OLED** | `#00a8ff` | true `#000` backgrounds |
| **Neon Accent** | `#ff2fd0` | violet glow, matches the app's neon preset |
| **Ember** | `#ff7a2f` | warm sunset accent |
| **Daylight** | `#0079c8` | the light option, `color-scheme: light` |

The choice is saved to `localStorage` under `apex-site-theme` and applied by a
small inline script in `<head>` — **before first paint**, so a returning visitor
never sees the default theme flash. The `<meta name="theme-color">` is updated
too, so mobile browser chrome follows along.

### Adding a theme

1. Add a variable block in `styles.css`:

   ```css
   [data-theme="mint"] {
     --accent: #2fd6a8;
     --accent-2: #35b0ff;
     --on-accent: #04231a;
     --bg: #07120f;
     --bg-2: #05100d;
     --panel: #101d1a;
     --panel-2: #0b1614;
     --text: #eafaf5;
     --muted: #8aa8a0;
     --border: #1e2f2b;
     --border-2: #2a403a;
     --nav-bg: rgb(7 18 15 / .74);
     --nav-bg-solid: rgb(7 18 15 / .93);
   }
   ```

2. Add a matching `<button role="menuitemradio" data-theme-set="mint">` inside
   `#theme-menu` in `index.html`, with a `.sw` swatch carrying the two colours
   inline: `style="--sw-bg:#07120f;--sw-accent:#2fd6a8"`.

3. Add the id to `THEME_COLOR` in `main.js` (that is the `theme-color` meta).

Nothing else is needed — every accent-tinted value in the stylesheet is derived
at use-time with `color-mix()`, so glows, buttons, focus rings, card hovers and
the hero gradient all follow the new accent automatically.

A light theme only has to flip two extra tokens: `--tint` (the overlay colour,
white on dark themes, near-black on light ones) and `--overlay` (its alpha),
plus lighter `--shadow-lg` / `--shadow-md`. See the `day` block for the shape.

## Pointing the download button somewhere real

Everything release-related lives in one object at the top of
`assets/js/main.js`:

```js
const CONFIG = {
  version: '2.6.0',
  downloadUrl: '../dist/Apex-Launcher-Setup-2.6.0.exe',
  installerSize: '~74 MB'
};
```

Change `downloadUrl` to your release asset and the nav button, the hero button,
the download section button and the spec table all follow:

```js
downloadUrl: 'https://github.com/you/apex/releases/download/v2.6.0/Apex-Launcher-Setup-2.6.0.exe'
```

An `http(s)` URL is automatically given `target="_blank" rel="noopener"`; a
relative path is not.

### The "installer not built yet" hint

On load the page sends a `HEAD` request to `downloadUrl`. A **404** reveals the
orange hint under the download button (`run npm run dist …`). Any other outcome
— success, a CORS block, a network error — stays quiet, so a correctly deployed
site never shows it. `installerSize` is also overwritten from the response's
`Content-Length` when the file is reachable over http(s).

## Building the installer the button expects

```powershell
npm run dist          # electron-builder → dist/Apex-Launcher-Setup-<version>.exe
```

Keep `CONFIG.version` in step with `package.json` (and bump it when you ship).

## Images

`assets/img/` holds real captures taken from the running app, served as
**WebP at 1920px wide** and quality 95 — about 1.5 MB for the whole set. WebP
is markedly better than JPEG on flat-coloured UI screenshots with text in them:
no ringing around glyph edges, and a smaller file for the same sharpness. Only
the hero loads eagerly — the Big Picture shot is `loading="lazy"` and the
gallery warms the rest during idle time.

Every capture is taken with the launcher on its **Neon Accent** theme, so the
imagery shares the site's violet/pink palette instead of the default blue.

### Regenerating them

Two throwaway harnesses at the repository root do the work:

```powershell
# 1. capture the app at the full 1920x1032 maximised layout, on the neon theme
$env:APEX_SHOTS_SIZE='1920x1032'; $env:APEX_SHOTS_OUT='apex-shots-neon'
npx electron _shots.js          # -> %TEMP%\apex-shots-neon\*.png

# 2. downscale + encode WebP straight into website/assets/img
npx electron _webp.js
```

`_shots.js` sets `State.settings.theme = 'neon'` (and the matching accent) in
its setup block, before any shot is taken — change that line to shoot a
different theme. `_webp.js` holds the `MAP` of which capture becomes which
asset, along with its target width and quality; edit that table to add or swap a
screenshot.

Three notes for anyone re-running this:

- The capture window is clamped to the display's work area, so
  `APEX_SHOTS_SIZE` cannot exceed it. On a 1920×1080 screen the ceiling is
  `1920x1032`; forcing `--force-device-scale-factor=2` does **not** give you a
  2× bitmap, it shrinks the available DIP space and the app lays out for a
  smaller window instead.
- Chromium does the WebP encoding (a canvas `toDataURL`), so no image library
  is needed. `_webp.js` disables hardware acceleration to keep it deterministic.
- itch.io rate-limits bursty clients with a `429`, which would otherwise be
  captured as a page full of error text. The `itch:browse` stub retries four
  times with a two-second gap so a screenshot can never show that state.

## What's in the page

| Section | Notes |
|---|---|
| Sticky nav | blurs the backdrop, gains a border on scroll, hamburger under 720px |
| Theme picker | palette button + `role="menu"` radio group, arrow-key navigable |
| Hero | headline, dual CTA, a window-chrome mockup of the app |
| Storefront strip | the eight stores the launcher unifies |
| Features | six cards, inline SVG icons |
| Screenshots | real `role="tablist"` gallery with arrow-key navigation |
| Big Picture | split panel with a `<kbd>` reference |
| Download | version / platform / size / licence spec table + direct button |
| FAQ | native `<details>` accordions |
| Footer | trademark disclaimer |

## Accessibility & robustness

- Content is visible with JavaScript disabled: the scroll-reveal animation is
  scoped to a `.js` class set by the inline `<head>` script, so nothing is ever
  hidden by an animation that cannot run.
- `prefers-reduced-motion` disables the reveal, the smooth scrolling and the
  hero's 3D tilt.
- The gallery implements the ARIA tab pattern and the theme picker the ARIA
  menu-radio pattern (roving focus, arrow keys, Home/End, Escape).
- The theme picker closes on outside click and on Escape.
- Visible focus rings throughout, plus a skip link.
- The mobile menu closes on link click, on Escape, and when the viewport grows
  past the breakpoint.
- Theme tokens are the only source of colour, so every theme keeps the same
  contrast relationships rather than being a filter over the default.
