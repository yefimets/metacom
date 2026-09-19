'use strict';

const { fail } = require('../lib/errors.js');

/// Every method is `public` for metacom and authenticates itself through hub.identify():
/// websocket callers sign in once, HTTP callers pass `token` in every call.
const buildApi = ({ hub, auth, console, assistant }) => {
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
      signin: method(async ({ token } = {}, context) => {
        const { client } = context;
        const ip = client.source;
        if (auth.blocked(ip)) throw fail(429, 'Too many failed sign-ins, try later');
        const record = auth.verify(token);
        if (!record) {
          auth.recordFailure(ip);
          setTimeout(() => client.close(), 200);
          throw fail(401, 'Bad token');
        }
        if (hub.conns.has(client)) return hub.from(hub.conns.get(client));
        const conn = hub.bind(client, record, ip);
        return hub.from(conn);
      }),
      whoami: method(async (args, context) => hub.from(hub.identify(context, args))),
    },
    agents: {
      register: method(async (args = {}, context) => hub.register(hub.identify(context, args), args)),
      status: method(async ({ status, reason, ...rest } = {}, context) => hub.setStatus(hub.identify(context, rest), status, reason)),
      seen: method(async ({ name, ...rest } = {}, context) => hub.seen(hub.identify(context, rest), name)),
      wait: method(async ({ name, until, timeoutMs, ...rest } = {}, context) => hub.wait(hub.identify(context, rest), name, until, timeoutMs)),
      read: method(async ({ name, lines, ...rest } = {}, context) => hub.read(hub.identify(context, rest), name, lines)),
      readReply: method(async ({ id, text, ...rest } = {}, context) => hub.readReply(hub.identify(context, rest), id, text)),
      list: method(async ({ room, ...rest } = {}, context) => hub.list(hub.identify(context, rest), room)),
      send: method(async ({ to, text, kind, wait, ...rest } = {}, context) => hub.send(hub.identify(context, rest), to, text, kind, wait)),
      dispatch: method(async ({ text, room, ...rest } = {}, context) => hub.dispatch(hub.identify(context, rest), text, room)),
      inbox: method(async ({ since, ...rest } = {}, context) => hub.inboxFor(hub.identify(context, rest), since)),
      ack: method(async ({ ids, ...rest } = {}, context) => hub.ack(hub.identify(context, rest), ids)),
    },
    room: {
      join: method(async ({ room, ...rest } = {}, context) => hub.join(hub.identify(context, rest), room)),
      say: method(async ({ room, text, ...rest } = {}, context) => hub.say(hub.identify(context, rest), room, text)),
      history: method(async ({ room, limit, since, ...rest } = {}, context) => hub.history(hub.identify(context, rest), room, limit, since)),
      list: method(async (args = {}, context) => {
        hub.identify(context, args);
        return hub.rooms();
      }),
    },
    assistant: {
      ask: method(async ({ token, ...args } = {}, context) => {
        const conn = hub.identify(context, { token });
        hub.owner(conn);
        return assistant.ask(conn, args);
      }),
      resume: method(async ({ token, ...args } = {}, context) => {
        const conn = hub.identify(context, { token });
        hub.owner(conn);
        return assistant.resume(conn, args);
      }),
      tools: method(async (args = {}, context) => {
        hub.identify(context, args);
        return require('../lib/tools.js').TOOLS.map(({ name, where, description }) => ({ name, where, description }));
      }),
    },
    admin: {
      createToken: method(async ({ name, role, ...rest } = {}, context) => {
        hub.owner(hub.identify(context, rest));
        try {
          const created = auth.create({ name, role });
          console.log(`admin: token "${name}" (${role}) created`);
          return created;
        } catch (error) {
          throw fail(400, error.message);
        }
      }),
      tokens: method(async (args = {}, context) => {
        hub.owner(hub.identify(context, args));
        return auth.list();
      }),
      revokeToken: method(async ({ id, ...rest } = {}, context) => {
        hub.owner(hub.identify(context, rest));
        return { revoked: auth.revoke(id) };
      }),
    },
  };
  return units;
};

module.exports = { buildApi };
