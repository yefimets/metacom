'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPair, isPublicKey, unseal, decryptText, encryptText, isSealed } = require('./crypto.js');
const { fail } = require('./errors.js');

/// Device public keys and sealed room keys. The server never sees a room key in the clear
/// unless the owner grants a room to the server's own device key (needed by anything living in
/// this process: the Telegram connector, the assistant). keys.json:
///   { server: { publicKey, privateKey }, devices: { [pub]: { name, role, lastSeen } },
///     rooms: { [room]: { [pub]: { epk, iv, ct } } } }
class Keys {
  constructor(dataDir, console) {
    this.file = path.join(dataDir, 'keys.json');
    this.console = console;
    this.state = { server: null, devices: {}, rooms: {} };
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      // first start
    }
    if (!this.state.server) {
      this.state.server = generateKeyPair();
      this.save();
      this.console.log(`keys: created the server device key ${this.state.server.publicKey.slice(0, 12)}…`);
    }
    this.cache = new Map();
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
  }

  get serverPublicKey() {
    return this.state.server.publicKey;
  }

  /// A device showed up (sign-in or register): remember whose it is.
  touch(publicKey, { name, role }) {
    if (!isPublicKey(publicKey)) throw fail(400, 'publicKey must be a base64url P-256 public key');
    const d = this.state.devices[publicKey] || {};
    this.state.devices[publicKey] = { name: name || d.name || null, role: role || d.role || null, lastSeen: new Date().toISOString() };
    this.save();
  }

  encrypted(room) {
    return Object.keys(this.state.rooms[room] || {}).length > 0;
  }

  /// The sealed room key for one device, or null.
  sealedFor(room, publicKey) {
    return (this.state.rooms[room] || {})[publicKey] || null;
  }

  /// Every device this server knows, with whether it holds the room key already. The server's
  /// own device is listed under the name "server" so the owner can grant it a room.
  list(room) {
    const sealed = this.state.rooms[room] || {};
    const out = [{ publicKey: this.serverPublicKey, name: 'server', role: 'server', lastSeen: null, sealed: Boolean(sealed[this.serverPublicKey]) }];
    for (const [publicKey, d] of Object.entries(this.state.devices)) {
      out.push({ publicKey, name: d.name, role: d.role, lastSeen: d.lastSeen, sealed: Boolean(sealed[publicKey]) });
    }
    return out;
  }

  /// Owner stored sealed copies of a room key for some devices.
  put(room, map) {
    if (!map || typeof map !== 'object') throw fail(400, 'sealed must be an object of publicKey -> { epk, iv, ct }');
    const entries = Object.entries(map);
    if (entries.length === 0) return { room, devices: 0 };
    const target = (this.state.rooms[room] = this.state.rooms[room] || {});
    for (const [publicKey, blob] of entries) {
      if (!isPublicKey(publicKey) || !blob || typeof blob.epk !== 'string' || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') {
        throw fail(400, `bad sealed key for ${String(publicKey).slice(0, 12)}`);
      }
      target[publicKey] = { epk: blob.epk, iv: blob.iv, ct: blob.ct };
    }
    this.save();
    this.cache.delete(room);
    return { room, devices: entries.length };
  }

  revoke(room, publicKey) {
    const target = this.state.rooms[room];
    if (target && target[publicKey]) {
      delete target[publicKey];
      this.save();
      this.cache.delete(room);
      return true;
    }
    return false;
  }

  /// The room key in the clear, for this process only, when the owner granted it. Null otherwise.
  roomKey(room) {
    if (this.cache.has(room)) return this.cache.get(room);
    const sealed = this.sealedFor(room, this.serverPublicKey);
    let key = null;
    if (sealed) {
      try {
        key = unseal(sealed, this.state.server.privateKey);
      } catch (error) {
        this.console.warn(`keys: cannot unseal ${room} for the server: ${error.message}`);
      }
    }
    this.cache.set(room, key);
    return key;
  }

  /// Helpers for code that lives in the server process.
  open(room, text) {
    if (!isSealed(text)) return text;
    const key = this.roomKey(room);
    return key ? decryptText(text, key, room) : null;
  }

  close(room, text) {
    if (!this.encrypted(room)) return text;
    const key = this.roomKey(room);
    if (!key) throw fail(403, `room ${room} is encrypted and the server was not granted its key`);
    return encryptText(text, key, room);
  }
}

module.exports = { Keys };
