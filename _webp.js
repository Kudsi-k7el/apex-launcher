'use strict';

/**
 * Website image pipeline.
 *
 * Takes the full-size captures from the shot pass and writes the WebP assets
 * the landing page actually ships. Chromium does the encoding via a canvas —
 * WebP is dramatically better than JPEG on flat-coloured UI screenshots with
 * text in them, which is exactly what these are.
 *
 *   $env:APEX_SHOTS_OUT='apex-shots-hi'; $env:APEX_SHOTS_SIZE='1920x1032'
 *   npx electron _shots.js
 *   npx electron _webp.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const SRC = path.join(os.tmpdir(), process.env.APEX_SHOTS_SRC || 'apex-shots-hi');
const OUT = path.join(__dirname, 'website', 'assets', 'img');

// source capture -> [output name, target width, webp quality]
const MAP = {
  '21-dock-favourites.png': ['hero-dock.webp', 1920, 0.95],
  '14-store-hero.png': ['shot-store.webp', 1920, 0.95],
  '05-library.png': ['shot-library.webp', 1920, 0.95],
  '07-bigpicture-store.png': ['shot-bigpicture.webp', 1920, 0.95],
  '09-itch-browse.png': ['shot-itch.webp', 1920, 0.95],
  '18-search-unified.png': ['shot-search.webp', 1920, 0.95],
  '16-profile.png': ['shot-profile.webp', 1920, 0.95],
  // 2.8.0: the ROM shelving, the screenshot wall and the contact page.
  '25-emulators.png': ['shot-emulators.webp', 1920, 0.95],
  '28-gallery.png': ['shot-gallery.webp', 1920, 0.95],
  '33-contact.png': ['shot-contact.webp', 1920, 0.95]
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('no captures at ' + SRC + ' — run the shot pass first');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  let total = 0;

  for (const src of Object.keys(MAP)) {
    const [outName, targetW, quality] = MAP[src];
    const inPath = path.join(SRC, src);
    if (!fs.existsSync(inPath)) { console.log('MISSING  ' + src); continue; }

    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(inPath).toString('base64');

    const res = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();

      const scale = Math.min(1, ${targetW} / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);

      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      return { w: w, h: h, data: c.toDataURL('image/webp', ${quality}) };
    })()`);

    if (!res || !res.data || res.data.indexOf('image/webp') === -1) {
      console.error('ENCODE FAILED ' + src);
      continue;
    }

    const buf = Buffer.from(res.data.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, outName), buf);
    total += buf.length;

    const before = Math.round(fs.statSync(inPath).size / 1024);
    console.log(
      outName.padEnd(22) + String(res.w) + 'x' + res.h +
      '  ' + before + ' KB PNG -> ' + Math.round(buf.length / 1024) + ' KB WebP'
    );
  }

  console.log('--- total webp ' + Math.round(total / 1024) + ' KB ---');
  app.exit(0);
});
