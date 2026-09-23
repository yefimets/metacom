'use strict';

const { fail } = require('../lib/errors.js');

/// Every method is `public` for metacom and authenticates itself through org.identify():
/// websocket callers sign in once, HTTP callers pass `token` in every call.
const buildApi = ({ org, auth, console }) => {
  const method = (handler) => ({ access: 'public', handler });
  const units = {
    system: {
      introspect: method(async (unitNames) => {
        const result = {};
        for (const unit of Array.isArray(unitNames) ? unitNames : []) {
          if (!units[unit]) continue;
          result[unit] = Object.fromEntries(Object.keys(units[unit]).map((m) => [m, {}]));
        }
        return result;
      }),
    },
    auth: {
      signin: method(async ({ token, publicKey } = {}, context) => {
        const { client } = context;
        const ip = client.source;
        if (auth.blocked(ip)) throw fail(429, 'Too many failed sign-ins, try later');
        const record = auth.verify(token);
        if (!record) {
          auth.recordFailure(ip);
          setTimeout(() => client.close(), 200);
          throw fail(401, 'Bad token');
        }
        if (org.conns.has(client)) return org.from(org.conns.get(client));
        const conn = org.bind(client, record, ip, publicKey || null);
        return { ...org.from(conn), serverPublicKey: org.keys.serverPublicKey };
      }),
      whoami: method(async (args, context) => org.from(org.identify(context, args))),
    },
    agents: {
      register: method(async (args = {}, context) => org.register(org.identify(context, args), args)),
      status: method(async ({ status, reason, ...rest } = {}, context) => org.setStatus(org.identify(context, rest), status, reason)),
      seen: method(async ({ name, ...rest } = {}, context) => org.seen(org.identify(context, rest), name)),
      wait: method(async ({ name, until, timeoutMs, ...rest } = {}, context) => org.wait(org.identify(context, rest), name, until, timeoutMs)),
      read: method(async ({ name, lines, ...rest } = {}, context) => org.read(org.identify(context, rest), name, lines)),
      readReply: method(async ({ id, text, ...rest } = {}, context) => org.readReply(org.identify(context, rest), id, text)),
      list: method(async ({ room, ...rest } = {}, context) => org.list(org.identify(context, rest), room)),
      send: method(async ({ to, text, kind, wait, media, ...rest } = {}, context) => org.send(org.identify(context, rest), to, text, kind, wait, media)),
      inbox: method(async ({ since, ...rest } = {}, context) => org.inboxFor(org.identify(context, rest), since)),
      ack: method(async ({ ids, ...rest } = {}, context) => org.ack(org.identify(context, rest), ids)),
    },
    room: {
      join: method(async ({ room, ...rest } = {}, context) => org.join(org.identify(context, rest), room)),
      say: method(async ({ room, text, media, ...rest } = {}, context) => org.say(org.identify(context, rest), room, text, media)),
      history: method(async ({ room, limit, since, ...rest } = {}, context) => org.history(org.identify(context, rest), room, limit, since)),
      list: method(async (args = {}, context) => {
        org.identify(context, args);
        return org.rooms();
      }),
    },
    /// Room encryption: devices seal room keys to each other; the server only stores them.
    keys: {
      list: method(async ({ room, ...rest } = {}, context) => {
        org.owner(org.identify(context, rest));
        if (!room) throw fail(400, 'room is required');
        return org.keys.list(String(room).slice(0, 64));
      }),
      put: method(async ({ room, sealed, ...rest } = {}, context) => {
        org.owner(org.identify(context, rest));
        if (!room) throw fail(400, 'room is required');
        const result = org.keys.put(String(room).slice(0, 64), sealed);
        org.broadcast('keys/changed', { room: result.room });
        org.system(result.room, `room key shared with ${result.devices} device${result.devices === 1 ? '' : 's'}`);
        return result;
      }),
      revoke: method(async ({ room, publicKey, ...rest } = {}, context) => {
        org.owner(org.identify(context, rest));
        const removed = org.keys.revoke(String(room || '').slice(0, 64), String(publicKey || ''));
        if (removed) org.broadcast('keys/changed', { room });
        return { removed };
      }),
      get: method(async ({ room, publicKey, ...rest } = {}, context) => {
        const conn = org.identify(context, rest);
        const pub = conn.publicKey || publicKey;
        if (!pub) throw fail(400, 'sign in with a publicKey first');
        const target = String(room || '').slice(0, 64);
        return { room: target, encrypted: org.keys.encrypted(target), sealed: org.keys.sealedFor(target, pub) };
      }),
    },
    admin: {
      createToken: method(async ({ name, role, ...rest } = {}, context) => {
        org.owner(org.identify(context, rest));
        try {
          const created = auth.create({ name, role });
          console.log(`admin: token "${name}" (${role}) created`);
          return created;
        } catch (error) {
          throw fail(400, error.message);
        }
      }),
      tokens: method(async (args = {}, context) => {
        org.owner(org.identify(context, args));
        return auth.list();
      }),
      revokeToken: method(async ({ id, ...rest } = {}, context) => {
        org.owner(org.identify(context, rest));
        return { revoked: auth.revoke(id) };
      }),
    },
  };
  return units;
};

module.exports = { buildApi };
