'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROLES = new Set(['owner', 'agent']);
const FAIL_LIMIT = 5;
const FAIL_WINDOW = 10 * 60 * 1000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/// Bearer tokens for members. Only hashes are stored. The first start with no tokens
/// creates one owner token and writes it, once, to bootstrap-token.txt (mode 0600).
class Auth {
  constructor(dataDir, console, seeds = []) {
    this.file = path.join(dataDir, 'tokens.json');
    this.console = console;
    this.tokens = readJson(this.file, []);
    this.revoked = new Set();
    this.mtime = this.stamp();
    this.failures = new Map();
    for (const seed of seeds) this.seed(seed);
    if (this.tokens.length === 0) this.bootstrap(dataDir);
  }

  /// A token given through the environment (HUB_OWNER_TOKEN, HUB_AGENT_TOKEN): makes hosts
  /// without a persistent disk usable, since the same token exists after every restart.
  seed({ token, name, role }) {
    if (!token || token.length < 16) return;
    const digest = hash(token);
    if (this.tokens.some((t) => t.hash === digest)) return;
    this.tokens.push({ id: crypto.randomUUID(), name, role, hash: digest, createdAt: new Date().toISOString(), lastUsed: null });
    this.save();
    this.console.log(`auth: seeded ${role} token "${name}" from the environment`);
  }

  bootstrap(dataDir) {
    const { token } = this.create({ name: 'bootstrap-owner', role: 'owner' });
    const file = path.join(dataDir, 'bootstrap-token.txt');
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
    this.console.warn(`auth: no tokens found, created an owner token in ${file}`);
    this.console.warn('auth: run `metacom login <url> <token>` on your machine, then delete that file');
  }

  stamp() {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /// Tokens created while the hub runs, by `node server.js token <name>` on the hub machine,
  /// land in tokens.json; pick them up when the file changed, so no restart is needed.
  reload() {
    const mtime = this.stamp();
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    const known = new Set(this.tokens.map((t) => t.id));
    for (const record of readJson(this.file, [])) {
      if (known.has(record.id) || this.revoked.has(record.id)) continue;
      this.tokens.push(record);
      this.console.log(`auth: picked up ${record.role} token "${record.name}" from tokens.json`);
    }
  }

  save() {
    this.reload();
    fs.writeFileSync(this.file, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    this.mtime = this.stamp();
  }

  create({ name, role }) {
    if (!ROLES.has(role)) throw new Error(`Unknown role: ${role}`);
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      throw new Error('Token name: letters, digits, dot, dash, underscore, up to 64');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const record = {
      id: crypto.randomUUID(),
      name,
      role,
      hash: hash(token),
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };
    this.tokens.push(record);
    this.save();
    return { token, record: this.publicRecord(record) };
  }

  publicRecord({ id, name, role, createdAt, lastUsed }) {
    return { id, name, role, createdAt, lastUsed };
  }

  list() {
    this.reload();
    return this.tokens.map((t) => this.publicRecord(t));
  }

  revoke(id) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) return false;
    this.revoked.add(id);
    this.save();
    return true;
  }

  /// Returns the token record or null. Constant-time compare on the hash.
  verify(token, retry = true) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    const digest = Buffer.from(hash(token), 'hex');
    for (const record of this.tokens) {
      const stored = Buffer.from(record.hash, 'hex');
      if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest)) {
        record.lastUsed = new Date().toISOString();
        return this.publicRecord(record);
      }
    }
    if (retry && this.stamp() !== this.mtime) {
      this.reload();
      return this.verify(token, false);
    }
    return null;
  }

  blocked(ip) {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= FAIL_LIMIT;
  }

  recordFailure(ip) {
    // Behind a local tunnel every remote client looks like loopback; blocking it would lock
    // out the agents on this machine. Tokens are 256-bit random, so per-IP blocking is a
    // nicety there, not the defence.
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return;
    const entry = this.failures.get(ip) || { count: 0, until: Date.now() + FAIL_WINDOW };
    entry.count++;
    entry.until = Date.now() + FAIL_WINDOW;
    this.failures.set(ip, entry);
    if (entry.count >= FAIL_LIMIT) {
      this.console.warn(`auth: ${ip} blocked for 10 minutes after ${entry.count} bad tokens`);
    }
  }
}

module.exports = { Auth, ROLES };
