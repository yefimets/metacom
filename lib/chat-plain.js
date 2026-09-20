'use strict';

const readline = require('node:readline');
const os = require('node:os');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');

/// A human in the room from a terminal: lines are said to the room, `@Name text` is a
/// directed command, `> text` lets the hub pick the agent, `/agents` lists them.
const plainChat = async ({ name, room, config }) => {
  const hub = await connect({ url: config.url, token: config.token, onOpen: () => join() });
  const join = async () => {
    if (hub.me.role === 'owner') {
      await hub.api.agents.register({ name, room, kind: 'human', host: os.hostname() });
      await hub.api.room.join({ room });
    } else {
      await hub.api.agents.register({ name, room, kind: 'agent', host: os.hostname() });
    }
  };
  await join();
  const out = (s) => process.stdout.write(s + '\n');
  out(`metacom: ${name} in room "${room}" at ${config.url} as ${hub.me.role}. @Name text = command, > text = auto-route, /agents, /quit`);
  for (const m of await hub.api.room.history({ room, limit: 20 })) out('  ' + line(m));
  hub.api.room.on('message', (m) => {
    if (m.from.name === name) return;
    out(line(m));
  });
  hub.api.agents.on('changed', () => {});
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${name}> ` });
  rl.prompt();
  rl.on('line', async (input) => {
    const s = input.trim();
    try {
      if (!s) return;
      if (s === '/quit' || s === '/q') return rl.close();
      if (s === '/agents') {
        for (const m of await hub.api.agents.list({})) out('  ' + member(m));
      } else if (s.startsWith('@')) {
        const [to, ...rest] = s.slice(1).split(' ');
        const r = await hub.api.agents.send({ to, text: rest.join(' '), kind: 'command' });
        out(`  ${r.delivered ? 'delivered' : 'queued'} → ${r.to}`);
      } else if (s.startsWith('>')) {
        const r = await hub.api.agents.dispatch({ text: s.slice(1).trim(), room });
        out(`  → ${r.agent} (${r.reason})`);
      } else {
        await hub.api.room.say({ room, text: s });
      }
    } catch (error) {
      out(`  error: ${error.message}`);
    } finally {
      rl.prompt();
    }
  });
  rl.on('close', () => {
    hub.m.close();
    process.exit(0);
  });
};

module.exports = { plainChat };
