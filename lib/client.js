'use strict';

const { Metacom } = require('metacom');
const { identity } = require('./config.js');
const { RoomKeys } = require('./rooms.js');

/// Connects, scaffolds the metacom API, signs in with this device's public key, and signs in
/// again after every reconnect. `onOpen` runs after each re-sign-in, so a wrapper can
/// re-register its member. `rooms` opens and closes text for encrypted rooms.
const connect = async ({ url, token, onOpen = null, callTimeout = 620_000 }) => {
  if (!token) throw new Error('No token. Run: metacom login <url> <token>');
  const device = identity();
  const m = await Metacom.connect(url, { callTimeout, reconnectTimeout: 2_000 });
  m.on('error', () => {});
  // 'keys' is missing on an older server; the client works without it, unencrypted
  await m.load('auth', 'agents', 'room', 'admin', 'keys');
  const me = await m.api.auth.signin({ token, publicKey: device.publicKey });
  m.on('open', async () => {
    try {
      await m.api.auth.signin({ token, publicKey: device.publicKey });
      if (onOpen) await onOpen();
    } catch (error) {
      process.stderr.write(`metacom: reconnect failed: ${error.message}\n`);
    }
  });
  const rooms = new RoomKeys(m.api, device);
  return { m, api: m.api, me, rooms, device };
};

module.exports = { connect };
