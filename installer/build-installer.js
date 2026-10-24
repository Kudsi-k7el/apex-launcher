#!/usr/bin/env node
'use strict';

/**
 * Builds the Project Apex setup file.
 *
 * The electron-builder NSIS installer is still the thing that copies files,
 * writes shortcuts and registers the uninstaller. It is built first as a
 * "core" installer, then wrapped in the small WPF window in ApexSetup.cs. The
 * wrapper can hand a manual install to the core silently and can also pass
 * electron-updater's /S through untouched, so the update path keeps working.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const dist = path.join(root, 'dist');
const setup = path.join(dist, `Apex-Launcher-Setup-${version}.exe`);
const core = path.join(dist, `Apex-Launcher-Core-${version}.exe`);
const source = path.join(root, 'installer', 'ApexSetup.cs');
const manifest = path.join(root, 'installer', 'app.manifest');
const icon = path.join(root, 'build', 'icon.ico');
const mark = path.join(root, 'src', 'img', 'apex-mark.png');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(framework, 'csc.exe');
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

const wrapperOnly = process.argv.includes('--wrapper-only');

function say(message) {
  process.stdout.write(`${message}\n`);
}

function die(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  return result.status == null ? 1 : result.status;
}

if (!/^\d+\.\d+\.\d+/.test(version)) {
  die(`package.json has no usable version ("${version}")`);
}

for (const file of [source, manifest, icon, mark]) {
  if (!fs.existsSync(file)) {
    die(`Missing installer asset: ${file}`);
  }
}

fs.mkdirSync(dist, { recursive: true });

if (!wrapperOnly) {
  if (!fs.existsSync(builderCli)) {
    die(`electron-builder is missing at ${builderCli}. Run npm install.`);
  }

  say(`\nBuilding the Apex Launcher ${version} core installer...\n`);
  if (run(process.execPath, [builderCli, '--win', 'nsis', '--publish', 'never']) !== 0) {
    die('The core installer build failed.');
  }

  if (!fs.existsSync(setup)) {
    die(`electron-builder did not produce ${setup}`);
  }

  // Keep the core payload out of the way, then put the custom GUI at the
  // artifact name electron-builder and the updater expect.
  if (fs.existsSync(core)) {
    fs.unlinkSync(core);
  }
  fs.renameSync(setup, core);

  const oldBlockmap = `${setup}.blockmap`;
  if (fs.existsSync(oldBlockmap)) {
    fs.unlinkSync(oldBlockmap);
  }
}

if (!fs.existsSync(core)) {
  die(`No core installer at ${core}. Run without --wrapper-only first.`);
}

say('\nCompiling the Project Apex setup window...\n');

const references = [
  path.join(framework, 'System.dll'),
  path.join(framework, 'System.Core.dll'),
  path.join(framework, 'System.Drawing.dll'),
  path.join(framework, 'System.Windows.Forms.dll'),
  path.join(framework, 'System.Xaml.dll'),
  path.join(framework, 'WPF', 'WindowsBase.dll'),
  path.join(framework, 'WPF', 'PresentationCore.dll'),
  path.join(framework, 'WPF', 'PresentationFramework.dll')
];

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/codepage:65001',
  '/optimize+',
  `/out:${setup}`,
  `/win32icon:${icon}`,
  `/win32manifest:${manifest}`,
  `/resource:${core},ApexCore`,
  `/resource:${icon},AppIcon`,
  `/resource:${mark},Mark`,
  ...references.map((reference) => `/r:${reference}`),
  source
];

if (run(csc, args) !== 0) {
  die('The setup window failed to compile.');
}

const bytes = fs.readFileSync(setup);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const latest = [
  `version: ${version}`,
  'files:',
  `  - url: ${path.basename(setup)}`,
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  `path: ${path.basename(setup)}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n');
fs.writeFileSync(path.join(dist, 'latest.yml'), latest, 'utf8');

say('');
say(`  core    ${core} (${fs.statSync(core).size.toLocaleString()} bytes)`);
say(`  setup   ${setup} (${bytes.length.toLocaleString()} bytes)`);
say(`  sha512  ${sha512}`);
say('');
say('Done. The custom setup is ready.\n');
