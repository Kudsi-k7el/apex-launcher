'use strict';
/* Generates build/icon.png from Apex's white A mark (src/img/apex-mark.png) on
   a charcoal tile, plus a preview sheet showing how it reads at taskbar sizes.
   Run with: npx electron _icon.js */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });

const markPath = path.join(__dirname, 'src', 'img', 'apex-mark.png');
const mark = `data:image/png;base64,${fs.readFileSync(markPath).toString('base64')}`;

/** The tile at any size. Kept as a function so every size renders natively. */
function tile(size) {
  const radius = Math.round(size * 0.225);
  return `<div class="tile" style="width:${size}px;height:${size}px;border-radius:${radius}px">
      <img src="${mark}" alt="" style="width:${(size * 0.58).toFixed(2)}px">
    </div>`;
}

const BASE_CSS = `
  html,body{margin:0;background:transparent;overflow:hidden}
  .tile{
    position:relative;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(148deg,#1d1e23 0%,#101114 42%,#060607 100%);
    overflow:hidden;
  }
  .tile::before{
    content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.075), inset 0 -18% 34% rgba(0,0,0,.5);
  }
  .tile::after{
    content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    background:radial-gradient(120% 110% at 22% -8%, rgba(255,255,255,.11), transparent 58%);
  }
  .tile img{
    position:relative;height:auto;display:block;
    filter:drop-shadow(0 6% 10% rgba(0,0,0,.55));
  }
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
  const strip = [128, 96, 64, 48, 32, 24, 16]
    .map((s) => `<div class="wrap"><span class="cap">${s}</span>${tile(s)}</div>`)
    .join('');
  const sheet = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    html,body{margin:0;width:760px;height:500px;background:#0c0f14;overflow:hidden;
      font-family:"Segoe UI",system-ui,sans-serif}
    .head{color:#5c6678;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;
      padding:18px 22px 0}
    .big{display:flex;align-items:center;justify-content:center;padding:14px 0 6px}
    .row{display:flex;align-items:flex-end;justify-content:center;gap:26px;padding:10px 0 22px}
    .wrap{display:flex;flex-direction:column;align-items:center;gap:9px}
    .cap{color:#4c5566;font-size:11px}
    .taskbar{margin:0 22px;height:46px;border-radius:10px;background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:14px;padding:0 16px}
  </style></head><body>
    <div class="head">Apex Launcher &mdash; application icon</div>
    <div class="big">${tile(192)}</div>
    <div class="row">${strip}</div>
    <div class="head" style="padding:0 22px 8px">on the Windows taskbar</div>
    <div class="taskbar">${tile(32)}${tile(32)}${tile(32)}</div>
  </body></html>`;
  const preview = await shot(sheet, 760, 500, 'preview');
  fs.writeFileSync(path.join(outDir, 'icon-preview.png'), preview.toPNG());

  console.log('icon bytes:', fs.statSync(path.join(outDir, 'icon.png')).size);
  console.log('preview bytes:', fs.statSync(path.join(outDir, 'icon-preview.png')).size);
  app.exit(0);
}).catch((e) => { console.log('ERR', (e && e.stack) || e); app.exit(1); });
