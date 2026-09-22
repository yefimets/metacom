'use strict';
// Drives the chat in a pty against the running mc. Prints screens so a human can look too.
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');
const config = require('../lib/config.js');

const room = 'tuitest';
const main = async () => {
  const cfg = config.load();
  // a fake agent in the room, so @ has something to offer
  const agent = await connect({ url: cfg.url, token: cfg.agentToken || cfg.token });
  await agent.api.agents.register({ name: 'Alex', room, kind: 'agent', host: 'testbox', repo: '/tmp/proj', caps: ['node'] });
  await agent.api.agents.status({ status: 'waiting' });

  const c = spawnChat({ room, name: 'tester', cols: 80, rows: 20 });
  const show = (title) => console.log(`\n=== ${title} ===\n${c.dump()}\n`);
  await c.wait(/enter posts to tuitest|@ to address/);
  show('idle');

  await c.type('hello everyone');
  await c.wait(/hello everyone/);
  await c.type(c.key.enter);
  await c.wait(/tester\s+hello everyone/);
  show('after say');

  await c.type('@');
  await c.wait(/@Alex/);
  show('mention popup');
  await c.type(c.key.tab);
  await c.type('run tests');
  show('directed draft');
  await c.type(c.key.enter);
  await c.wait(/→ @Alex run tests/);
  show('after command');

  // agent goes working then blocked, then done
  await agent.api.agents.status({ status: 'working', reason: 'running tests' });
  await sleep(300);
  show('agent working (spinner)');
  await agent.api.agents.status({ status: 'blocked', reason: 'Do you want to proceed?' });
  await c.wait(/needs you/);
  show('agent blocked');
  await agent.api.agents.status({ status: 'working' });
  await sleep(100);
  await agent.api.agents.status({ status: 'waiting' });
  await c.wait(/finished/);
  show('agent done');

  await c.type('/');
  await c.wait(/\/agents/);
  show('command popup');
  await c.type('ag');
  await c.type(c.key.enter);
  await sleep(100);
  await c.type(c.key.enter);
  await c.wait(/testbox/);
  show('after /agents');

  await c.type('line one');
  await c.type(c.key.ctrlJ);
  await c.type('line two');
  show('multiline');
  await c.type(c.key.ctrlA);
  await c.type(c.key.ctrlW);
  await c.type(c.key.esc, 300);
  await c.type(c.key.esc, 300);
  await c.paste('pasted\nblock');
  show('after paste');
  await c.type(c.key.ctrlC);
  await sleep(50);
  await c.type(c.key.up);
  await c.type(c.key.up);
  await c.wait(/❯ @Alex run tests/);
  show('history');
  await c.type(c.key.esc, 300);
  await c.type(c.key.esc, 300);
  await c.wait(/❯ message tuitest/);
  show('after double esc');

  // long input wrapping and window
  await c.type('x'.repeat(200));
  show('long input');
  await c.type(c.key.ctrlC);
  c.resize(60, 20);
  await sleep(200);
  show('resized');

  // message from someone else while typing
  await c.type('typing here');
  await agent.api.room.say({ room, text: 'incoming from @tester while typing' });
  await c.wait(/incoming from/);
  show('incoming while typing');

  await c.type(c.key.ctrlC);
  await c.type(c.key.ctrlC);
  console.log('exit code:', await Promise.race([c.exited, sleep(2000).then(() => 'still running')]));
  agent.m.close();
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
