'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


/// The directory used to be called metacom-hub; an existing one is moved over on first use.
const inherit = (dir) => {
  const old = dir.replace(/metacom$/, 'metacom-hub');
  try {
    if (!fs.existsSync(dir) && fs.existsSync(old)) fs.renameSync(old, dir);
  } catch {
    // leave both in place
  }
  return dir;
};
const dir = inherit(path.join(os.homedir(), '.config', 'metacom'));
const file = path.join(dir, 'config.json');

const toWs = (url) => url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/';
const toHttp = (url) => url.replace(/^ws/, 'http').replace(/\/+$/, '');

const load = () => {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  const env = process.env;
  const url = env.MC_URL || stored.url || 'ws://127.0.0.1:8900/';
  return {
    url: toWs(url),
    http: toHttp(url),
    token: env.MC_TOKEN || stored.token || null,
    fileToken: stored.token || null,
    tokenFromEnv: Boolean(env.MC_TOKEN),
    agentToken: env.MC_AGENT_TOKEN || stored.agentToken || null,
    room: env.MC_ROOM || stored.room || 'default',
  };
};

const save = (values) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = load();
  const next = {
    url: values.url ? toWs(values.url) : current.url,
    token: values.token ?? current.token,
    agentToken: values.agentToken ?? current.agentToken,
    room: values.room ?? current.room,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
};

/// This machine's device key for room encryption, made on first use (keys.json, mode 600).
/// One per machine: the wrapper, the MCP bridge and the chat here are the same device.
const keysFile = path.join(dir, 'keys.json');
const identity = () => {
  try {
    const stored = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    if (stored.publicKey && stored.privateKey) return stored;
  } catch {
    // none yet
  }
  const { generateKeyPair } = require('./crypto.js');
  const pair = generateKeyPair();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keysFile, JSON.stringify(pair, null, 2) + '\n', { mode: 0o600 });
  return pair;
};

module.exports = { inherit, load, save, identity, file, keysFile, toWs, toHttp };
