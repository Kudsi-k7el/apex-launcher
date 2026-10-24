#!/usr/bin/env node
'use strict';

/**
 * One-command release: builds the Project Apex setup, then publishes it and
 * latest.yml to GitHub Releases - which is exactly where every installed copy of
 * the launcher reads its updates from (see updater.js).
 *
 * The setup is the custom WPF wrapper around the electron-builder NSIS payload.
 * It is uploaded at the name electron-updater expects, and its latest.yml points
 * at that wrapper. The wrapper passes /S through to the core installer, so
 * silent updates keep working.
 *
 * Usage:
 *   npm version patch --no-git-tag-version   # or edit "version" by hand
 *   npm run release
 *
 * The version in package.json is the single source of truth for what clients
 * see: electron-updater compares it against its own and only updates when the
 * feed's is newer. Bump it, or nothing happens.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const tag = `v${version}`;
const setup = path.join(root, 'dist', `Apex-Launcher-Setup-${version}.exe`);
const latest = path.join(root, 'dist', 'latest.yml');

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(msg) {
  process.stderr.write(`\n${msg}\n`);
  process.exit(1);
}

/** Runs a command with the terminal attached, so build output stays live. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  return res.status == null ? 1 : res.status;
}

/** Runs a command and captures its trimmed stdout. */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  return {
    code: res.status == null ? 1 : res.status,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim()
  };
}

if (!/^\d+\.\d+\.\d+/.test(version)) die(`package.json has no usable version ("${version}")`);

say(`\nApex Launcher ${version} -> GitHub release ${tag}\n`);

// --- 1. GitHub CLI auth ------------------------------------------------------
if (capture('gh', ['auth', 'status']).code !== 0) {
  die('GitHub CLI is not logged in. Run `gh auth login` once, then retry.');
}
say('  ok  GitHub CLI ready');

// --- 2. say so if this version is already out -------------------------------
// Re-running is legitimate (it is how a half-finished upload is repaired), so
// this only ever warns.
if (capture('gh', ['release', 'view', tag, '--json', 'tagName']).code === 0) {
  say(`  !!  release ${tag} already exists - its assets will be replaced.`);
  say('      Bump "version" in package.json if you meant to ship something new.');
}

// --- 3. the tag, which a published release cannot do without ----------------
const dirty = capture('git', ['status', '--porcelain']).out;
if (dirty) {
  say('  !!  uncommitted changes are in the working tree:');
  for (const line of dirty.split('\n')) say(`        ${line}`);
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'HEAD';
if (run('git', ['push', 'origin', `HEAD:${branch}`]) !== 0) die('Could not push the branch to origin.');
say(`  ok  pushed ${branch}`);

if (capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out) {
  // Already on the remote: the release it points at is what we re-upload to.
  say(`  ok  tag ${tag} already on origin`);
} else {
  if (!capture('git', ['tag', '--list', tag]).out) {
    if (run('git', ['tag', '-a', tag, '-m', `Apex Launcher ${version}`]) !== 0) {
      die(`Could not create tag ${tag}.`);
    }
  }
  if (run('git', ['push', 'origin', tag]) !== 0) die(`Could not push tag ${tag}.`);
  say(`  ok  tagged and pushed ${tag}`);
}

// --- 3b. the release itself, before anything is uploaded --------------------
// electron-builder gives each artifact its own publish task, and with no
// release to attach to, every task tries to create one. On 2.10.0 that produced
// two releases wearing the same tag, one of them short an asset, with GitHub's
// "latest" free to resolve to the incomplete one. Creating the release here
// means the publish tasks find it already there and simply upload to it.
if (capture('gh', ['release', 'view', tag, '--json', 'tagName']).code !== 0) {
  if (run('gh', ['release', 'create', tag, '--title', version, '--notes', '', '--latest']) !== 0) {
    die(`Could not create release ${tag}.`);
  }
  say(`  ok  created release ${tag}`);
}

// --- 4. build the custom setup ---------------------------------------------
say('\nBuilding the Project Apex setup...\n');
if (run(process.execPath, [path.join(root, 'installer', 'build-installer.js')]) !== 0) {
  die('\nRelease failed. The build output above says why.');
}
if (!fs.existsSync(setup) || !fs.existsSync(latest)) {
  die(`The build did not produce ${setup} and ${latest}.`);
}

// --- 5. upload the wrapper and its update feed ------------------------------
// The wrapper is the artifact electron-updater downloads. The core installer
// stays local; uploading it would let an updater pick the wrong file.
say('\nUploading the setup and latest.yml...\n');
if (run('gh', ['release', 'upload', tag, setup, '--clobber']) !== 0) {
  die(`Could not upload ${path.basename(setup)}.`);
}
if (run('gh', ['release', 'upload', tag, latest, '--clobber']) !== 0) {
  die('Could not upload latest.yml.');
}

const pub = pkg.build.publish[0];
say(`\nDone. https://github.com/${pub.owner}/${pub.repo}/releases/tag/${tag}`);
say('Every installed copy picks this up on its own within a few hours (or on next launch).\n');
process.exit(0);
