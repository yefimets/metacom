'use strict';

const readline = require('node:readline');
const os = require('node:os');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');

/// A human in the room from a terminal: lines are said to the room, `@Name text` is a
/// directed command, `> text` lets the mc pick the agent, `/agents` lists them.
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
  for (const m of await mc.api.room.history({ room, limit: 20 })) out('  ' + line(m));
  mc.api.room.on('message', (m) => {
    if (m.from.name === name) return;
    out(line(m));
  });
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
        const r = await mc.api.agents.send({ to, text: rest.join(' '), kind: 'command' });
        out(`  ${r.delivered ? 'delivered' : 'queued'} → ${r.to}`);
      } else {
        await mc.api.room.say({ room, text: s });
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
