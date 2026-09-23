'use strict';

const c = require('./crypto.js');

/// Room keys as a client sees them: fetched sealed for this device, unsealed here, cached
/// until the server says keys/changed. `open` turns a stored message into text, `close`
/// turns text into what goes on the wire for that room.
class RoomKeys {
  constructor(api, identity) {
    this.api = api;
    this.identity = identity;
    this.cache = new Map();
    // A server without the keys unit has no encrypted rooms: everything below then passes
    // text through untouched, so this client still talks to an older metacom.
    this.enabled = Boolean(api.keys);
    if (this.enabled) api.keys.on('changed', ({ room }) => this.cache.delete(room));
  }

  async key(room) {
    if (!this.enabled) return { encrypted: false, key: null };
    if (this.cache.has(room)) return this.cache.get(room);
    const { encrypted, sealed } = await this.api.keys.get({ room });
    let key = null;
    if (sealed) {
      try {
        key = c.unseal(sealed, this.identity.privateKey);
      } catch {
        key = null;
      }
    }
    const entry = { encrypted, key };
    this.cache.set(room, entry);
    return entry;
  }

  /// Text of a message, or "[encrypted]" when this device holds no key for its room.
  async open(room, text) {
    if (!c.isSealed(text)) return text;
    const { key } = await this.key(room);
    const plain = key ? c.decryptText(text, key, room) : null;
    return plain === null ? '[encrypted]' : plain;
  }

  async close(room, text) {
    const { encrypted, key } = await this.key(room);
    if (!encrypted) return text;
    if (!key) throw new Error(`room ${room} is encrypted and this device has no key for it (ask the owner to share it)`);
    return c.encryptText(text, key, room);
  }

  /// Owner only: make the room encrypted (a fresh key) or extend the existing key to every
  /// device that lacks it. The server's device is skipped unless named in `also`.
  async share(room, { also = [], create = false } = {}) {
    if (!this.enabled) throw new Error('this server does not support encrypted rooms');
    const devices = await this.api.keys.list({ room });
    let { key } = await this.key(room);
    if (!key) {
      if (!create) throw new Error(`no key for ${room} on this device`);
      if (devices.some((d) => d.sealed)) throw new Error(`${room} already has a key this device does not hold`);
      key = c.generateRoomKey();
    }
    const sealed = {};
    for (const d of devices) {
      const wanted = d.role !== 'server' || also.includes('server') || also.includes(d.publicKey);
      const named = also.includes(d.name) || also.includes(d.publicKey);
      if (!d.sealed && (wanted || named)) sealed[d.publicKey] = c.seal(key, d.publicKey);
    }
    if (!sealed[this.identity.publicKey] && !devices.find((d) => d.publicKey === this.identity.publicKey)?.sealed) {
      sealed[this.identity.publicKey] = c.seal(key, this.identity.publicKey);
    }
    const count = Object.keys(sealed).length;
    if (count) await this.api.keys.put({ room, sealed });
    this.cache.delete(room);
    return { room, shared: count, devices: devices.length };
  }
}

module.exports = { RoomKeys };
