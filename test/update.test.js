'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { update, source } = require('../lib/update.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/// An origin with one commit, and a clone of it, so an update has something real to pull.
const repos = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-update-'));
  const origin = path.join(dir, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.email', 't@example.com');
  git(origin, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: '@metacomdev/cli', version: '0.2.0' }));
  fs.writeFileSync(path.join(origin, 'package-lock.json'), '{"one":1}');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'first');
  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '--quiet', origin, clone);
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'config', 'user.name', 'test');
  const commit = (message, files = {}) => {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(origin, name), body);
    git(origin, 'add', '-A');
    git(origin, 'commit', '--quiet', '--allow-empty', '-m', message);
  };
  return { dir, origin, clone, commit };
};

test('update: a checkout with nothing to pull says so', () => {
  const { clone } = repos();
  const r = update({ root: clone });
  assert.strictEqual(r.kind, 'git');
  assert.strictEqual(r.state, 'current');
  assert.match(r.message, /up to date/);
});

test('update: --check reports what is waiting without touching the checkout', () => {
  const { clone, commit } = repos();
  commit('second');
  commit('third');
  const before = git(clone, 'rev-parse', 'HEAD');
  const r = update({ root: clone, check: true });
  assert.strictEqual(r.state, 'available');
  assert.strictEqual(r.behind, 2);
  assert.deepStrictEqual(r.log.map((l) => l.split(' ').slice(1).join(' ')), ['third', 'second']);
  assert.strictEqual(git(clone, 'rev-parse', 'HEAD'), before, 'nothing was pulled');
});

test('update: pulls, and reinstalls only when the lockfile moved', () => {
  const { clone, commit } = repos();
  commit('second');
  const calls = [];
  const run = (cmd, args, cwd) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'npm' ? '' : git(cwd, ...args);
  };
  const r = update({ root: clone, run });
  assert.strictEqual(r.state, 'updated');
  assert.strictEqual(r.behind, 1);
  assert.strictEqual(r.installed, false, 'the lockfile did not change');
  assert.match(r.head, /second$/);
  assert.strictEqual(git(clone, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/main'));

  commit('third', { 'package-lock.json': '{"two":2}' });
  const after = update({ root: clone, run });
  assert.strictEqual(after.state, 'updated');
  assert.strictEqual(after.installed, true, 'a moved lockfile triggers npm install');
  assert.ok(calls.includes('npm install --no-audit --no-fund'), 'and it is the one npm call');
  assert.strictEqual(fs.readFileSync(path.join(clone, 'package-lock.json'), 'utf8'), '{"two":2}');
});

test('update: local changes and local commits are left alone', () => {
  const { clone, commit } = repos();
  commit('second');
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: '@metacomdev/cli', version: '0.2.0', edited: true }));
  const dirty = update({ root: clone });
  assert.strictEqual(dirty.state, 'dirty');
  assert.match(dirty.message, /local changes/);
  assert.strictEqual(git(clone, 'rev-list', '--count', 'HEAD..origin/main'), '1', 'still behind, nothing was merged');

  git(clone, 'checkout', '--quiet', '--', 'package.json');
  fs.writeFileSync(path.join(clone, 'mine.txt'), 'x');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'mine');
  const diverged = update({ root: clone });
  assert.strictEqual(diverged.state, 'diverged');
  assert.match(diverged.message, /1 commit of its own/);
});

test('update: a detached checkout, and one whose branch tracks nothing', () => {
  const { clone, commit } = repos();
  commit('second');
  git(clone, 'checkout', '--quiet', '--detach', 'HEAD');
  assert.strictEqual(update({ root: clone }).state, 'detached');
  git(clone, 'checkout', '--quiet', 'main');
  git(clone, 'checkout', '--quiet', '-b', 'local-only');
  assert.strictEqual(update({ root: clone }).state, 'no-upstream');
});

test('update: an install that is not a checkout goes through npm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-npm-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@metacomdev/cli', version: '0.2.0' }));
  const src = source(dir, () => false); // no .git anywhere above
  assert.strictEqual(src.kind, 'npm');
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return args[0] === 'view' ? '0.3.0' : '';
  };
  const available = update({ source: src, check: true, run });
  assert.strictEqual(available.state, 'available');
  assert.match(available.message, /0\.3\.0 is out/);
  assert.deepStrictEqual(calls, ['npm view @metacomdev/cli version']);

  const done = update({ source: src, run });
  assert.strictEqual(done.state, 'updated');
  assert.ok(calls.includes('npm install --global @metacomdev/cli@latest'));

  const same = update({ source: src, run: (cmd, args) => (args[0] === 'view' ? '0.2.0' : '') });
  assert.strictEqual(same.state, 'current');
});

test('update: a failure is reported, not thrown', () => {
  const src = { kind: 'npm', root: '/nowhere', name: '@metacomdev/cli', version: '0.2.0' };
  const r = update({
    source: src,
    run: () => {
      const e = new Error('spawn failed');
      e.stderr = 'npm ERR! code E404\nnpm ERR! 404 Not Found';
      throw e;
    },
  });
  assert.strictEqual(r.state, 'failed');
  assert.match(r.message, /404/);
});
