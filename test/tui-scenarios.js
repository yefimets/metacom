'use strict';
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
const config = require('../lib/config.js');

const room = 'tuitest';
const main = async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('MC_')) delete process.env[k];
  const cfg = config.load();
  const ownerHub = await connect({ url: cfg.url, token: cfg.token });
  const owner = ownerHub.me.role === 'owner';
  ownerHub.m.close();
  console.log('owner token:', owner);
  const agent = await connect({ url: cfg.url, token: cfg.agentToken || cfg.token });
  await agent.api.agents.register({ name: 'Alex', room, kind: 'agent', host: 'testbox' });
  await agent.api.agents.status({ status: 'blocked', reason: 'Do you want to proceed?' });
  agent.api.agents.on('readRequest', ({ id }) => agent.api.agents.readReply({ id, text: 'some output\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No' }));

  const a = spawnChat({ room, name: 'ann', cols: 70, rows: 18 });
  const b = spawnChat({ room, name: 'bob', cols: 70, rows: 18 });
  const show = (c, title) => console.log(`\n=== ${title} ===\n${c.dump().replace(/\n+$/, '')}\n`);
  await a.wait(/@ to address/);
  await b.wait(/@ to address/);

  // 409 when commanding a blocked agent
  await a.type('@Alex do it');
  await a.type(a.key.enter);
  await a.wait(/blocked on a question/);
  show(a, 'ann: blocked agent refuses a command');

  if (owner) {
  // /read shows the screen
  await a.type('/read Alex');
  await a.type(a.key.enter);
  await a.wait(/2\. No/);
  show(a, 'ann: /read Alex');

  // answer through control command
  await a.type('@Alex !keys enter');
  await a.type(a.key.enter);
  await a.wait(/⌘ @Alex !keys enter/);
  show(a, 'ann: control command');
  }

  // directed message to a human, mention to another
  await a.type('@bob can you check the deploy?');
  await a.type(a.key.enter);
  await b.wait(/ann.*→ @bob can you check/);
  await b.type('sure @ann, on it');
  await b.type(b.key.enter);
  await a.wait(/bob.*sure @ann, on it/);
  show(a, 'ann: after exchange');
  show(b, 'bob: after exchange');

  // unknown @ falls back to room text
  await b.type('@nobody hello?');
  show(b, 'bob: unknown mention hint');
  await b.type(b.key.enter);
  await b.wait(/posted to the room as text/);
  show(b, 'bob: unknown mention sent');

  // wide chars: cursor column must match
  await a.type('héllo 日本 👋 x');
  await a.type(a.key.left);
  await a.type(a.key.left);
  await sleep(100);
  const buf = a.screen.term.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY).translateToString(true);
  console.log('cursor line:', JSON.stringify(line), 'cursorX', buf.cursorX, 'char under cursor:', JSON.stringify(line[buf.cursorX]));
  show(a, 'ann: wide chars');
  await a.type(a.key.backspace);
  await sleep(50);
  show(a, 'ann: after backspace over emoji');

  // popup filtering
  await a.type(a.key.ctrlC);
  await a.type('@b');
  await sleep(100);
  show(a, 'ann: popup filtered by b');
  await a.type(a.key.esc, 300);
  await a.type(a.key.esc, 300);

  // tiny terminal
  a.resize(40, 8);
  await sleep(300);
  await a.type('/');
  await sleep(100);
  show(a, 'ann: 40x8 with popup');

  await a.type(a.key.ctrlC, 200);
  await a.type(a.key.ctrlC, 200);
  await b.type(b.key.ctrlC, 200);
  console.log('exits:', await Promise.all([a.exited, b.exited]));
  agent.m.close();
  process.exit(0);
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
