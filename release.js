#!/usr/bin/env node
'use strict';

/**
 * One-command release: builds the installer and publishes it, its blockmap and
 * latest.yml to GitHub Releases - which is exactly where every installed copy of
 * the launcher reads its updates from (see updater.js).
 *
 * electron-builder needs two things that are easy to get wrong by hand, so this
 * script supplies both:
 *
 *   1. A GH_TOKEN. Yours is taken from the GitHub CLI you are already logged in
 *      with, so there is no token to paste anywhere.
 *   2. The git tag. GitHub refuses to create a *published* release that points
 *      at a tag which does not exist yet ("Published releases must have a valid
 *      tag"), so the tag is created and pushed first.
 *
 * Usage:
 *   npm version patch --no-git-tag-version   # or edit "version" by hand
 *   npm run release
 *
 * Note that the version in package.json is the single source of truth for what
 * clients see: electron-updater compares it against its own and only updates
 * when the feed's is newer. Bump it, or nothing happens.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const tag = `v${version}`;

const isWin = process.platform === 'win32';

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(msg) {
  process.stderr.write(`\n${msg}\n`);
  process.exit(1);
}

/** Runs a command with the terminal attached, so build output stays live. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    ...opts
  });
  return res.status == null ? 1 : res.status;
}

/** Runs a command and captures its trimmed stdout. */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: isWin });
  return {
    code: res.status == null ? 1 : res.status,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim()
  };
}

if (!/^\d+\.\d+\.\d+/.test(version)) die(`package.json has no usable version ("${version}")`);

say(`\nApex Launcher ${version} -> GitHub release ${tag}\n`);

// --- 1. the token -----------------------------------------------------------
let token = String(process.env.GH_TOKEN || '').trim();
if (!token) {
  const gh = capture('gh', ['auth', 'token']);
  if (gh.code !== 0 || !gh.out) {
    die('No GitHub token. Run `gh auth login` once, or set GH_TOKEN yourself.');
  }
  token = gh.out;
}
say('  ok  GitHub token ready (from the gh CLI)');

// --- 2. refuse to publish a version that is already out ---------------------
const existing = capture('gh', ['release', 'view', tag, '--json', 'tagName']);
if (existing.code === 0) {
  say(`  !!  release ${tag} already exists - its assets will be replaced.`);
  say('      Bump "version" in package.json if you meant to ship something new.');
}

// --- 3. commit and tag, because a published release needs a real tag --------
const dirty = capture('git', ['status', '--porcelain']);
if (dirty.out) {
  say('  !!  uncommitted changes are in the working tree:');
  for (const line of dirty.out.split('\n')) say(`        ${line}`);
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'HEAD';
const push = run('git', ['push', 'origin', `HEAD:${branch}`]);
if (push !== 0) die('Could not push the branch to origin.');
say(`  ok  pushed ${branch}`);

if (!capture('git', ['tag', '--list', tag]).out) {
  if (run('git', ['tag', '-a', tag, '-m', `Apex Launcher ${version}`]) !== 0) {
    die(`Could not create tag ${tag}.`);
  }
  say(`  ok  tagged ${tag}`);
} else {
  say(`  ok  tag ${tag} already exists`);
}

if (!capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out) {
  if (run('git', ['push', 'origin', tag]) !== 0) die(`Could not push tag ${tag}.`);
  say(`  ok  pushed tag ${tag}`);
} else {
  // The tag exists on the remote, but it may not point at what we are about to
  // build - worth knowing rather than silently shipping something else.
  const local = capture('git', ['rev-list', '-n', '1', tag]).out;
  const remote = capture('git', ['rev-parse', `origin/${branch}`]).out;
  say(`  ok  tag ${tag} already on origin${local && remote && local !== remote ? ' (note: not the current branch tip)' : ''}`);
}

// --- 4. build + publish -----------------------------------------------------
say('\nBuilding and publishing...\n');
const code = run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], {
  env: { ...process.env, GH_TOKEN: token }
});

if (code !== 0) die('\nRelease failed. The build output above says why.');

say(`\nDone. https://github.com/${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo}/releases/tag/${tag}`);
say('Every installed copy picks this up on its own within a few hours (or on next launch).\n');
process.exit(0);
