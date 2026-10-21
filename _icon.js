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

  // Every size Windows asks for gets rendered natively, then packed into one
  // .ico so Explorer, the installer and alt-tab all start from a crisp bitmap.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) {
    // eslint-disable-next-line no-await-in-loop
    const shotImg = await shot(page(tile(size), size, size, 'transparent'), size, size, `ico-${size}`);
    frames.push({ size, png: shotImg.toPNG() });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(frames.length, 4);
  const entries = Buffer.alloc(16 * frames.length);
  let offset = 6 + entries.length;
  frames.forEach((f, i) => {
    const at = i * 16;
    entries[at] = f.size >= 256 ? 0 : f.size;      // width (0 means 256)
    entries[at + 1] = f.size >= 256 ? 0 : f.size;  // height
    entries[at + 2] = 0;                            // palette
    entries[at + 3] = 0;                            // reserved
    entries.writeUInt16LE(1, at + 4);               // colour planes
    entries.writeUInt16LE(32, at + 6);              // bits per pixel
    entries.writeUInt32LE(f.png.length, at + 8);    // bytes in resource
    entries.writeUInt32LE(offset, at + 12);         // offset
    offset += f.png.length;
  });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, entries, ...frames.map((f) => f.png)]));

  // The tray sits at 16-32px. A tile at that size swallows the mark, so the
  // tray is the mark itself on transparency, rendered natively at 32px.
  const trayPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:32px;height:32px;background:transparent;overflow:hidden}
    body{display:flex;align-items:center;justify-content:center}
    img{width:29px;height:auto;display:block}
  </style></head><body><img src="${mark}" alt=""></body></html>`;
  const trayFile = path.join(outDir, '_tray.html');
  fs.writeFileSync(trayFile, trayPage, 'utf8');
  const trayWin = new BrowserWindow({
    width: 32, height: 32, useContentSize: true, show: false, frame: false,
    resizable: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, offscreen: false }
  });
  await trayWin.loadFile(trayFile);
  await new Promise((r) => setTimeout(r, 500));
  const tray = await trayWin.webContents.capturePage({ x: 0, y: 0, width: 32, height: 32 });
  trayWin.destroy();
  try { fs.unlinkSync(trayFile); } catch { /* ignore */ }
  fs.mkdirSync(path.join(__dirname, 'src', 'img'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'src', 'img', 'apex-tray.png'), tray.toPNG());

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
  console.log('ico bytes:', fs.statSync(path.join(outDir, 'icon.ico')).size);
  console.log('tray bytes:', fs.statSync(path.join(__dirname, 'src', 'img', 'apex-tray.png')).size);
  console.log('preview bytes:', fs.statSync(path.join(outDir, 'icon-preview.png')).size);
  app.exit(0);
}).catch((e) => { console.log('ERR', (e && e.stack) || e); app.exit(1); });
