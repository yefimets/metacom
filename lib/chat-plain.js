'use strict';

const readline = require('node:readline');
const os = require('node:os');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');

/// A human in the room from a terminal: lines are said to the room, `@Name text` is a
/// directed command, `/agents` lists them.
const plainChat = async ({ name, room, config }) => {
  const mc = await connect({ url: config.url, token: config.token, onOpen: () => join() });
  const join = async () => {
    if (mc.me.role === 'owner') {
      await mc.api.agents.register({ name, room, kind: 'human', host: os.hostname() });
      await mc.api.room.join({ room });
    } else {
      await mc.api.agents.register({ name, room, kind: 'agent', host: os.hostname() });
    }
  };
  await join();
  const out = (s) => process.stdout.write(s + '\n');
  out(`metacom: ${name} in room "${room}" at ${config.url} as ${mc.me.role}. @Name text = command, /agents, /quit`);
  const opened = async (m) => ({ ...m, text: await mc.rooms.open(m.room, m.text) });
  for (const m of await mc.api.room.history({ room, limit: 20 })) out('  ' + line(await opened(m)));
  mc.api.room.on('message', async (m) => {
    if (m.from.name === name) return;
    out(line(await opened(m)));
  });
  // an owner device shares the room key with devices that joined since
  if (mc.me.role === 'owner') mc.rooms.share(room).catch(() => {});
  mc.api.agents.on('changed', () => {});
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${name}> ` });
  rl.prompt();
  rl.on('line', async (input) => {
    const s = input.trim();
    try {
      if (!s) return;
      if (s === '/quit' || s === '/q') return rl.close();
      if (s === '/agents') {
        for (const m of await mc.api.agents.list({})) out('  ' + member(m));
      } else if (s.startsWith('@')) {
        const [to, ...rest] = s.slice(1).split(' ');
        const toRoom = (await mc.api.agents.list({})).find((m) => m.name === to)?.room || room;
        const r = await mc.api.agents.send({ to, text: await mc.rooms.close(toRoom, rest.join(' ')), kind: 'command' });
        out(`  ${r.delivered ? 'delivered' : 'queued'} → ${r.to}`);
      } else {
        await mc.api.room.say({ room, text: await mc.rooms.close(room, s) });
      }
    } catch (error) {
      out(`  error: ${error.message}`);
    } finally {
      rl.prompt();
    }
  });
  rl.on('close', () => {
    mc.m.close();
    process.exit(0);
  });
};

module.exports = { plainChat };
