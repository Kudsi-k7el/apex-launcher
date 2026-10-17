'use strict';
/* Generates build/icon.png from Apex's own brand mark (the splash-screen flame
   on the #00a8ff -> #6a3de8 gradient tile), plus a preview sheet showing how it
   reads at taskbar sizes. Run with: npx electron _icon.js */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });

const FLAME = 'M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-2 1-3.6 1-3.6S9 11 10.5 11C12 11 12 8.5 12 3z';

/** The tile at any size. Kept as a function so every size renders natively. */
function tile(size) {
  const radius = Math.round(size * 0.235);
  const glyph = Math.round(size * 0.56);
  const ring = Math.max(1, Math.round(size * 0.019));
  return `<div class="tile" style="width:${size}px;height:${size}px;border-radius:${radius}px">
      <svg viewBox="0 0 24 24" style="width:${glyph}px;height:${glyph}px;stroke-width:${(1.95 / (glyph / 24)).toFixed(3)}">
        <path d="${FLAME}"/>
      </svg>
    </div>`;
}

const BASE_CSS = `
  html,body{margin:0;background:transparent;overflow:hidden}
  .tile{
    position:relative;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#00a8ff,#6a3de8);
    overflow:hidden;
  }
  .tile::after{
    content:"";position:absolute;inset:0;border-radius:inherit;
    background:radial-gradient(130% 120% at 24% -6%, rgba(255,255,255,.34), transparent 60%);
  }
  .tile svg{position:relative;stroke:#fff;fill:none;stroke-linecap:round;stroke-linejoin:round;
    filter:drop-shadow(0 ${'6'}px ${'14'}px rgba(0,0,0,.34));}
`;

const page = (body, w, h, bg) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${BASE_CSS}
  html,body{width:${w}px;height:${h}px}
  body{background:${bg};display:flex;align-items:center;justify-content:center}
</style></head><body>${body}</body></html>`;

async function shot(html, w, h, name) {
  const file = path.join(outDir, `_${name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({
    width: w, height: h, useContentSize: true, show: false, frame: false,
    resizable: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, offscreen: false }
  });
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  win.destroy();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return img;
}

app.disableHardwareAcceleration();
// Destroying a window must not end the run: the default behaviour quits the app
// once the last window closes, which would kill the second capture.
app.on('window-all-closed', () => { /* keep going */ });

app.whenReady().then(async () => {
  const icon = await shot(page(tile(512), 512, 512, 'transparent'), 512, 512, 'icon');
  fs.writeFileSync(path.join(outDir, 'icon.png'), icon.toPNG());

  // Preview sheet: the mark at real taskbar sizes on the dark bar it will sit in.
  const strip = [256, 128, 64, 48, 32, 24, 16]
    .map((s) => `<div class="wrap"><span class="cap">${s}</span>${tile(s)}</div>`)
    .join('');
  const sheet = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    html,body{margin:0;width:760px;height:420px;background:#0c0f14;overflow:hidden;
      font-family:"Segoe UI",system-ui,sans-serif}
    .head{color:#5c6678;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;
      padding:18px 22px 0}
    .big{display:flex;align-items:center;justify-content:center;padding:14px 0 6px}
    .row{display:flex;align-items:flex-end;justify-content:center;gap:26px;padding:10px 0 26px}
    .wrap{display:flex;flex-direction:column;align-items:center;gap:9px}
    .cap{color:#4c5566;font-size:11px}
    .taskbar{margin:0 22px;height:46px;border-radius:10px;background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:14px;padding:0 16px}
    .taskbar .tile{outline:1px solid rgba(0,168,255,.35)}
  </style></head><body>
    <div class="head">Apex Launcher &mdash; application icon</div>
    <div class="big">${tile(160)}</div>
    <div class="row">${strip}</div>
    <div class="head" style="padding:0 22px 8px">on the Windows taskbar</div>
    <div class="taskbar">${tile(32)}${tile(32)}${tile(32)}</div>
  </body></html>`;
  const preview = await shot(sheet, 760, 420, 'preview');
  fs.writeFileSync(path.join(outDir, 'icon-preview.png'), preview.toPNG());

  console.log('icon bytes:', fs.statSync(path.join(outDir, 'icon.png')).size);
  console.log('preview bytes:', fs.statSync(path.join(outDir, 'icon-preview.png')).size);
  app.exit(0);
}).catch((e) => { console.log('ERR', (e && e.stack) || e); app.exit(1); });
