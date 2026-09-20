'use strict';

const path = require('node:path');
const pty = require('node-pty');
const { Screen } = require('../lib/screen.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Runs `metacom <room> -n <name>` inside a pseudo-terminal and exposes the rendered screen.
const spawnChat = ({ room, name, cols = 80, rows = 24, env = {} }) => {
  const bin = path.join(__dirname, '..', 'bin', 'metacom.js');
  const screen = new Screen(cols, rows);
  let raw = '';
  let exit = null;
  const exited = new Promise((r) => { exit = r; });
  const p = pty.spawn(process.execPath, [bin, room, '-n', name], {
    cols,
    rows,
    cwd: path.join(__dirname, '..'),
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), TERM: 'xterm-256color', FORCE_COLOR: '3', ...env },
  });
  p.onExit((e) => exit(e.exitCode));
  p.onData((d) => {
    raw += d;
    screen.write(d);
  });
  const type = async (s, wait = 60) => {
    p.write(s);
    await sleep(wait);
  };
  const key = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', ctrlC: '\x03', ctrlJ: '\n', ctrlA: '\x01', ctrlW: '\x17', altEnter: '\x1b\r', backspace: '\x7f' };
  const paste = (text) => type(`\x1b[200~${text}\x1b[201~`, 100);
  const view = () => screen.visible();
  const dump = () => view().join('\n');
  const wait = async (re, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(dump())) return true;
      await sleep(40);
    }
    throw new Error(`timeout waiting for ${re}\n--- screen ---\n${dump()}`);
  };
  const resize = (c, r) => {
    p.resize(c, r);
    screen.resize(c, r);
  };
  return { p, exited, screen, type, key, paste, view, dump, wait, resize, raw: () => raw, kill: () => p.kill() };
};

module.exports = { spawnChat, sleep };
