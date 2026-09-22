'use strict';

const { Metacom } = require('metacom');

/// Connects, scaffolds the mc API, signs in, and signs in again after every reconnect.
/// `onOpen` runs after each re-sign-in, so a wrapper can re-register its member.
const connect = async ({ url, token, onOpen = null, callTimeout = 620_000 }) => {
  if (!token) throw new Error('No token. Run: metacom login <url> <token>');
  const m = await Metacom.connect(url, { callTimeout, reconnectTimeout: 2_000 });
  m.on('error', () => {});
  await m.load('auth', 'agents', 'room', 'admin');
  const me = await m.api.auth.signin({ token });
  m.on('open', async () => {
    try {
      await m.api.auth.signin({ token });
      if (onOpen) await onOpen();
    } catch (error) {
      process.stderr.write(`metacom: reconnect failed: ${error.message}\n`);
    }
  });
  return { m, api: m.api, me };
};

module.exports = { connect };
