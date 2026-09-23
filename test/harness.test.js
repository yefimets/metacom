'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { configure, kindOf } = require('../lib/harness.js');
const { blockedReason } = require('../lib/screen.js');

const opts = (command, extra = {}) => ({
  command,
  name: 'Bob',
  room: 'dev',
  url: 'ws://127.0.0.1:8900/',
  token: 'TOKEN',
  prompt: 'You are connected to metacom as agent "Bob" in room "dev".',
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-harness-')),
  ...extra,
});

test('harness: recognises the agents it configures, by path and by extension', () => {
  assert.strictEqual(kindOf('claude'), 'claude');
  assert.strictEqual(kindOf('/usr/local/bin/codex'), 'codex');
  assert.strictEqual(kindOf('opencode.cmd'), 'opencode');
  assert.strictEqual(kindOf('bash'), 'other');
  assert.strictEqual(kindOf(''), 'other');
});

test('harness: claude gets the mcp config and the briefing as a system prompt', () => {
  const r = configure(opts('claude'));
  assert.strictEqual(r.tools, true);
  const i = r.args.indexOf('--mcp-config');
  const config = JSON.parse(r.args[i + 1]);
  assert.deepStrictEqual(config.mcpServers.mc.env, { MC_URL: 'ws://127.0.0.1:8900/', MC_TOKEN: 'TOKEN', MC_AGENT: 'Bob', MC_ROOM: 'dev', MC_PROMPT: opts('claude').prompt });
  assert.match(r.args[r.args.indexOf('--append-system-prompt') + 1], /agent "Bob" in room "dev"/);
});

test('harness: codex gets -c overrides that parse as TOML values', () => {
  const r = configure(opts('codex'));
  const pairs = r.args.filter((a) => a !== '-c');
  assert.strictEqual(r.args.filter((a) => a === '-c').length, pairs.length);
  const command = pairs.find((p) => p.startsWith('mcp_servers.metacom.command='));
  assert.strictEqual(JSON.parse(command.split('=').slice(1).join('=')), process.execPath);
  const args = pairs.find((p) => p.startsWith('mcp_servers.metacom.args='));
  assert.deepStrictEqual(JSON.parse(args.slice('mcp_servers.metacom.args='.length)), [path.join(__dirname, '..', 'bin', 'metacom.js'), 'mcp']);
  const env = pairs.find((p) => p.startsWith('mcp_servers.metacom.env='));
  assert.match(env, /MC_AGENT="Bob"/);
  assert.match(env, /MC_ROOM="dev"/);
});

test('harness: opencode gets a merged config and a briefing file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-xdg-'));
  fs.mkdirSync(path.join(home, 'opencode'));
  fs.writeFileSync(path.join(home, 'opencode', 'opencode.json'), JSON.stringify({ model: 'anthropic/claude', mcp: { other: { type: 'local' } }, instructions: ['./AGENTS.md'] }));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    const r = configure(opts('opencode'));
    const config = JSON.parse(r.env.OPENCODE_CONFIG_CONTENT);
    assert.strictEqual(config.model, 'anthropic/claude', 'the user keeps their own settings');
    assert.ok(config.mcp.other, 'and their own mcp servers');
    assert.strictEqual(config.mcp.metacom.enabled, true);
    assert.deepStrictEqual(config.mcp.metacom.command, [process.execPath, path.join(__dirname, '..', 'bin', 'metacom.js'), 'mcp']);
    assert.strictEqual(config.mcp.metacom.environment.MC_AGENT, 'Bob');
    assert.strictEqual(config.instructions[0], './AGENTS.md');
    const brief = config.instructions[1];
    assert.strictEqual(r.files[0].file, brief);
    assert.match(r.files[0].content, /agent "Bob" in room "dev"/);
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});

test('harness: an unknown command is wrapped without tools, and --no-mcp turns them off', () => {
  const plain = configure(opts('bash'));
  assert.deepStrictEqual([plain.kind, plain.tools, plain.args, plain.files], ['other', false, [], []]);
  for (const agent of ['claude', 'codex', 'opencode']) {
    const off = configure(opts(agent, { mcp: false }));
    assert.strictEqual(off.tools, false);
    assert.deepStrictEqual(off.args, []);
    assert.deepStrictEqual(off.env, {});
  }
});

test('screen: approval prompts of all three, and nothing when they are answered', () => {
  assert.strictEqual(blockedReason(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), 'Do you want to proceed');
  assert.strictEqual(blockedReason(['Run `rm -rf build`?', '  1. Yes', '❯ 2. No, tell me what to do', 'esc to cancel']), 'Run `rm -rf build`?');
  assert.strictEqual(blockedReason(['output', 'Permission required', '❯ Allow', '  Allow always', '  Deny']), 'Permission required');
  assert.strictEqual(blockedReason(['Permission required', 'and then ordinary output']), null);
  assert.strictEqual(blockedReason(['building…', 'done']), null);
});

/// With the real binaries installed (npm i @openai/codex opencode-ai), check that each one
/// actually accepts what harness.js builds and lists metacom among its MCP servers.
const bin = (name) => {
  for (const dir of (process.env.MC_TEST_AGENTS || '').split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
};

test('codex accepts the -c overrides and lists metacom', { skip: bin('codex') ? false : 'codex not installed (set MC_TEST_AGENTS)' }, () => {
  const r = configure(opts('codex'));
  const home = fs.mkdtempSync(path.join(os.homedir(), '.mc-codex-'));
  try {
    const out = execFileSync(bin('codex'), [...r.args, 'mcp', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 60_000 });
    assert.match(out, /metacom/);
    assert.match(out, /metacom\.js/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('opencode accepts the merged config and lists metacom', { skip: bin('opencode') ? false : 'opencode not installed (set MC_TEST_AGENTS)' }, () => {
  const r = configure(opts('opencode'));
  const out = execFileSync(bin('opencode'), ['mcp', 'list'], { encoding: 'utf8', env: { ...process.env, ...r.env }, timeout: 120_000 });
  assert.match(out, /metacom/);
});
