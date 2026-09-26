'use strict';
// Threads with a real Claude Code under the wrapper, on a hub of its own. Costs three short
// model turns, so it is run by hand: node test/threads-e2e.js
//   1. a plain command: remember APPLE           -> the conversation it starts in
//   2. a plain command: which word?              -> /clear first, so the answer is none
//   3. a reply to the first command: which word? -> /resume back, so the answer is APPLE
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pty = require('node-pty');
const { connect } = require('../lib/client.js');
const { Screen } = require('../lib/screen.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 18900 + Math.floor(Math.random() * 1000);
const token = 'threads-e2e-owner-' + Math.random().toString(36).slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-e2e-'));
const name = `threadtest${process.pid}`;
const url = `ws://127.0.0.1:${port}/`;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_'))), MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT_TOKEN: token };

const main = async () => {
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir, HUB_OWNER_TOKEN: token }, stdio: 'ignore' });
  await sleep(800);
  const screen = new Screen(120, 40);
  const agent = pty.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'dev', '-n', name, 'claude'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: path.join(__dirname, '..', '..'), env });
  agent.onData((d) => screen.write(d));
  const owner = await connect({ url, token });
  const waitIdle = async (ms = 90_000) => {
    await sleep(1500);
    const r = await owner.api.agents.wait({ name, until: ['waiting'], timeoutMs: ms });
    if (r.timeout) throw new Error(`${name} never got idle:\n${screen.lines(40).join('\n')}`);
  };
  const ask = async (text, replyTo) => {
    const r = await owner.api.agents.send({ to: name, text, kind: 'command', replyTo });
    await sleep(3000);
    await waitIdle();
    return r;
  };
  const answer = () => screen.lines(40).join('\n');
  const rule = 'Answer on your screen only, in one word; do not use any tools.';
  try {
    await waitIdle(60_000);
    const first = await ask(`Remember the word APPLE. ${rule} Reply: ok`);
    await ask(`Which word did I ask you to remember? ${rule} If you were not asked, reply: none`);
    const cleared = answer();
    await ask(`Which word did I ask you to remember? ${rule} If you were not asked, reply: none`, first.id);
    const resumed = answer();
    const lastLine = (s) => s.split('\n').filter((l) => /\b(APPLE|none|None|NONE)\b/.test(l) && !/Which word|Remember the word/.test(l)).pop() || '(no answer seen)';
    console.log('plain command, new thread ->', lastLine(cleared).trim());
    console.log('reply into thread 1       ->', lastLine(resumed).trim());
    const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'metacom-hub', 'sessions', `${name}.json`), 'utf8'));
    console.log('threads -> sessions:', Object.values(state.byThread).map((s) => s.slice(0, 8)).join(', '));
    if (!/none/i.test(lastLine(cleared))) throw new Error('a plain command still saw the old conversation');
    if (!/APPLE/.test(lastLine(resumed))) throw new Error('the reply did not get its thread back');
    console.log('threads e2e: ok');
  } finally {
    owner.m.close();
    agent.kill();
    hub.kill();
    fs.rmSync(path.join(os.homedir(), '.local', 'share', 'metacom-hub', 'sessions', `${name}.json`), { force: true });
  }
};

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  }
);
