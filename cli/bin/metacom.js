#!/usr/bin/env node
'use strict';

const os = require('node:os');
const config = require('../lib/config.js');
const { line, member } = require('../lib/format.js');


const RESERVED = new Set(['login', 'token', 'tokens', 'agents', 'send', 'say', 'tail', 'rooms', 'read', 'wait', 'seen', 'mcp', 'update', 'help', '-h', '--help']);

const usage = `metacom – join agents and yourself to metacom (mc is a short alias)

  metacom login <url> <token> [--room R]     save hub url and token (~/.config/metacom-hub/config.json)
      --agent-token T    token agents on this machine use (role agent); owner token stays for you
  metacom <room> -n <name> [opts] [-- cmd…]  join the room; with a command, run it (claude, codex, …) and
                                        type owner instructions into it when it is idle. Without a
                                        command, an interactive chat (--theme dracula, --plain for a bare one).
      --repo PATH        repository the agent works in (default: cwd)
      --caps a,b,c       capabilities used for routing, e.g. swift,ios,node
      --accept any|owner|a,b   whose commands get typed in: any agent (default), only you, or named agents
      --no-mcp           do not give claude the hub_* MCP tools
  metacom agents [--room R]                  who is on the hub and their status
                                             ● online  ! blocked on a question  * done, not looked at yet
  metacom read <name> [--lines N]            the agent's screen (owner only)
  metacom wait <name> [--until a,b] [--timeout S]   block until the agent is waiting/blocked/stopped
  metacom seen <name>                        clear the done badge
  metacom send <name|auto> <text…> [--wait]  instruction to an agent; auto lets the hub pick;
                                             --wait returns when the agent finishes the turn
      --file PATH        attach an image or document (repeatable); the agent gets it as a local path
      !cancel  !stop  !keys enter|esc|up|y  !type text    control commands: act at once, never typed as text
  metacom say <text…> [--room R] [--file P]  post to the room
  metacom tail [--room R]                    follow the room
  metacom rooms                              list rooms
  metacom token <name> --role owner|agent    create a token (owner only), prints it once
      --save             store it as this machine's agent token in the config
  metacom tokens                             list tokens (owner only)
  metacom update [--check]                   update this installation (git pull, or npm for a global install)
  --json on any command prints the raw hub reply
`;

const parse = (argv, { command = false } = {}) => {
  const opts = {};
  const rest = [];
  let i = 0;
  let passthrough = false;
  while (i < argv.length) {
    const a = argv[i];
    if (passthrough) {
      rest.push(a);
    } else if (a === '--') {
      passthrough = true;
    } else if (a === '-n' || a === '--name') {
      opts.name = argv[++i];
    } else if (a === '--room') {
      opts.room = argv[++i];
    } else if (a === '--repo') {
      opts.repo = argv[++i];
    } else if (a === '--caps') {
      opts.caps = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--accept') {
      opts.accept = argv[++i];
    } else if (a === '--role') {
      opts.role = argv[++i];
    } else if (a === '--agent-token') {
      opts.agentToken = argv[++i];
    } else if (a === '--save') {
      opts.save = true;
    } else if (a === '--check') {
      opts.check = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--wait') {
      opts.wait = true;
    } else if (a === '--file') {
      (opts.files = opts.files || []).push(argv[++i]);
    } else if (a === '--lines') {
      opts.lines = Number(argv[++i]);
    } else if (a === '--until') {
      opts.until = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--timeout') {
      opts.timeout = Number(argv[++i]);
    } else if (a === '--no-mcp') {
      opts.mcp = false;
    } else if (a === '--plain') {
      opts.plain = true;
    } else if (a === '--theme') {
      opts.theme = argv[++i];
    } else if (a.startsWith('-') && a.length > 1) {
      throw new Error(`unknown option ${a}`);
    } else {
      rest.push(a);
      if (command) passthrough = true;
    }
    i++;
  }
  return { opts, rest };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first || first === 'help' || first === '-h' || first === '--help') {
    process.stdout.write(usage);
    return;
  }
  if (first === 'login') {
    const [, url, token] = argv;
    if (!url || !token) throw new Error('usage: metacom login <url> <token>');
    const { opts } = parse(argv.slice(3));
    const saved = config.save({ url, token, room: opts.room, agentToken: opts.agentToken });
    process.stdout.write(`saved ${config.file} (url ${saved.url}, room ${saved.room})\n`);
    return;
  }
  if (first === 'update') {
    const { opts } = parse(argv.slice(1));
    const r = require('../lib/update.js').update({ check: Boolean(opts.check) });
    if (opts.json) return process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    const where = r.kind === 'git' ? r.repo : 'npm';
    process.stdout.write(`metacom ${r.version} (${where}): ${r.message}\n`);
    if (r.log && r.log.length && r.state !== 'updated') for (const l of r.log) process.stdout.write(`  ${l}\n`);
    if (r.state === 'updated') {
      if (r.head) process.stdout.write(`  now at ${r.head}\n`);
      if (r.installed) process.stdout.write('  dependencies reinstalled\n');
      process.stdout.write('  restart the chat and any agents to pick it up\n');
    }
    if (r.state === 'failed') process.exitCode = 1;
    return;
  }
  if (first === 'mcp') {
    const { serveMcp } = require('../lib/mcp.js');
    await serveMcp(config.load());
    return;
  }

  const cfg = config.load();
  const { connect } = require('../lib/client.js');

  if (!RESERVED.has(first)) {
    const { opts, rest } = parse(argv.slice(1), { command: true });
    const room = first;
    const name = opts.name || os.userInfo().username;
    if (rest.length === 0) {
      const { chat } = require('../lib/chat.js');
      // The chat is you, not an agent: the token saved by `metacom login` wins over MC_TOKEN,
      // which the wrapper exports into agent sessions and any shell opened from them.
      await chat({ name, room, config: { ...cfg, room, token: cfg.fileToken || cfg.token }, plain: opts.plain, theme: opts.theme });
      return;
    }
    const { wrap } = require('../lib/wrap.js');
    await wrap({ name, room, repo: opts.repo, caps: opts.caps || [], accept: opts.accept || 'any', command: rest[0], args: rest.slice(1), config: cfg, mcp: opts.mcp !== false });
    return;
  }

  const { opts, rest } = parse(argv.slice(1));
  const hub = await connect({ url: cfg.url, token: cfg.token });
  const done = () => {
    hub.m.close();
    process.stdout.write('', () => process.exit(0));
  };
  const out = (s) => process.stdout.write(s + '\n');
  const show = (value, render) => out(opts.json ? JSON.stringify(value, null, 2) : render(value));
  const uploads = async () => {
    if (!opts.files || opts.files.length === 0) return undefined;
    const { upload, resolvePath } = require('../lib/media.js');
    const media = [];
    for (const f of opts.files) media.push(await upload({ http: cfg.http, token: cfg.token, file: resolvePath(f) }));
    return media;
  };
  try {
    switch (first) {
      case 'agents': {
        show(await hub.api.agents.list({ room: opts.room }), (list) => list.map(member).join('\n') || '(nobody)');
        break;
      }
      case 'rooms': {
        show(await hub.api.room.list({}), (rooms) =>
          rooms.map((r) => `${r.room.padEnd(16)} ${r.online}/${r.agents} online, ${r.working} working, ${r.blocked} blocked, ${r.attention} done`).join('\n'));
        break;
      }
      case 'read': {
        const [name] = rest;
        if (!name) throw new Error('usage: metacom read <name> [--lines N]');
        show(await hub.api.agents.read({ name, lines: opts.lines || 40 }), (r) => r.text);
        break;
      }
      case 'wait': {
        const [name] = rest;
        if (!name) throw new Error('usage: metacom wait <name> [--until a,b] [--timeout S]');
        const r = await hub.api.agents.wait({ name, until: opts.until, timeoutMs: (opts.timeout || 600) * 1000 });
        show(r, (x) => (x.timeout ? `timeout, ${x.name} is ${x.status}` : `${x.name} is ${x.status}${x.reason ? ' (' + x.reason + ')' : ''} after ${Math.round(x.elapsedMs / 1000)}s`));
        break;
      }
      case 'seen': {
        const [name] = rest;
        if (!name) throw new Error('usage: metacom seen <name>');
        show(await hub.api.agents.seen({ name }), (m) => `${m.name}: ${m.status}`);
        break;
      }
      case 'send': {
        const [to, ...words] = rest;
        const text = words.join(' ');
        if (!to || (!text && !opts.files)) throw new Error('usage: metacom send <name|auto> <text…> [--file PATH]');
        const wait = opts.wait ? { timeoutMs: (opts.timeout || 600) * 1000 } : null;
        const media = await uploads();
        if (to === 'auto') {
          const r = await hub.api.agents.dispatch({ text, room: opts.room, media });
          show(r, (x) => `→ ${x.agent} (${x.reason})${x.delivered ? '' : ', queued'}`);
        } else {
          const r = await hub.api.agents.send({ to, text, kind: 'command', wait, media });
          show(r, (x) => `${x.delivered ? 'delivered' : 'queued'} → ${x.to}${x.turn ? (x.turn.stalled ? ', but nothing happened (stalled)' : `, now ${x.turn.status}`) : ''}`);
        }
        break;
      }
      case 'say': {
        const text = rest.join(' ');
        if (!text && !opts.files) throw new Error('usage: metacom say <text…> [--file PATH]');
        await hub.api.room.say({ room: opts.room || cfg.room, text, media: await uploads() });
        break;
      }
      case 'tail': {
        const room = opts.room || cfg.room;
        await hub.api.room.join({ room });
        const render = (m) => (opts.json ? JSON.stringify(m) : line(m, cfg.http));
        for (const m of await hub.api.room.history({ room, limit: 20 })) out(render(m));
        hub.api.room.on('message', (m) => out(render(m)));
        return;
      }
      case 'token': {
        const [name] = rest;
        if (!name || !opts.role) throw new Error('usage: metacom token <name> --role owner|agent');
        const r = await hub.api.admin.createToken({ name, role: opts.role });
        if (opts.save && opts.role === 'agent') {
          config.save({ agentToken: r.token });
          out(`agent token for ${r.record.name} saved to ${config.file}`);
        } else {
          out(`token for ${r.record.name} (${r.record.role}), shown once:\n${r.token}`);
        }
        break;
      }
      case 'tokens': {
        for (const t of await hub.api.admin.tokens({})) out(`${t.id}  ${t.role.padEnd(5)} ${t.name.padEnd(20)} last used ${t.lastUsed || 'never'}`);
        break;
      }
      default:
        throw new Error(`unknown command ${first}`);
    }
  } finally {
    if (first !== 'tail') done();
  }
};

main().catch((error) => {
  process.stderr.write(`metacom: ${error.message}\n`);
  process.exit(1);
});
