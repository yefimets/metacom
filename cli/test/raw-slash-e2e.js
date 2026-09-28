'use strict';
// `@agent !/command` with a real Claude Code under the wrapper: the owner's slash command must
// run in the agent as if typed at its terminal, not arrive as "[hub …] /command" text. /clear
// is the witness: it costs no model turn, and Claude's SessionStart hook reports it.
//   node test/raw-slash-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pty = require('node-pty');
const { connect } = require('../lib/client.js');
const { Screen } = require('../lib/screen.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 18900 + Math.floor(Math.random() * 1000);
const token = 'raw-e2e-owner-' + Math.random().toString(36).slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-e2e-'));
const hookFile = path.join(dir, 'hook.jsonl');
const name = `rawtest${process.pid}`;
const url = `ws://127.0.0.1:${port}/`;
// not a child of whatever Claude session runs this test: that would save no transcript
const skip = new Set(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MC_') && !skip.has(k))), MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT_TOKEN: token, MC_SESSION_FILE: hookFile };
const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat >> "$MC_SESSION_FILE"; echo >> "$MC_SESSION_FILE"' }] }] } });
const sources = () => (fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).source) : []);

const main = async () => {
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir, HUB_OWNER_TOKEN: token }, stdio: 'ignore' });
  await sleep(800);
  const screen = new Screen(120, 40);
  const agent = pty.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'metacom.js'), 'dev', '-n', name, 'claude', '--settings', settings], { name: 'xterm-256color', cols: 120, rows: 40, cwd: path.join(__dirname, '..', '..'), env });
  agent.onData((d) => screen.write(d));
  const owner = await connect({ url, token });
  try {
    // the wrapper registers the agent once it is connected: wait for the name first
    for (let i = 0; i < 50 && !(await owner.api.agents.list({})).some((m) => m.name === name); i++) await sleep(200);
    const ready = await owner.api.agents.wait({ name, until: ['waiting'], timeoutMs: 60_000 });
    if (ready.timeout) throw new Error(`never ready:\n${screen.lines(40).join('\n')}`);
    await sleep(1500);
    const r = await owner.api.agents.send({ to: name, text: '!/clear', kind: 'command' });
    console.log('sent as', r.kind);
    const t0 = Date.now();
    while (!sources().includes('clear') && Date.now() - t0 < 15_000) await sleep(300);
    console.log('sessions Claude reported:', sources().join(' → '));
    const typed = screen.lines(40).filter((l) => /\/clear/.test(l));
    console.log('on its screen:', typed.map((l) => l.trim()).join(' | ') || '(nothing)');
    if (!sources().includes('clear')) throw new Error('the slash command did not run');
    if (typed.some((l) => /\[hub /.test(l))) throw new Error('it was typed as a hub message');
    console.log('raw slash e2e: ok');
  } finally {
    owner.m.close();
    agent.kill();
    hub.kill();
  }
};

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  }
);
