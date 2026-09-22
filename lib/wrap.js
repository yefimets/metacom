'use strict';

const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { connect } = require('./client.js');
const { Screen, blockedReason } = require('./screen.js');
const { download } = require('./media.js');

// Spinner glyphs Claude Code puts in the terminal title while it works.
const GLYPHS = new Set(['◐', '◓', '◑', '◒', '✢', '✶', '✻', '✽', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 9;4 progress state (ConEmu style): 0 clears it, anything else means the agent is busy.
const PROGRESS = /\x1b\]9;4;(\d)/g;
const QUIET_MS = 800;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const KEYS = {
  enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a', 'ctrl+l': '\x0c', 'shift+tab': '\x1b[Z',
};

const roomPrompt = (name, room, roster = []) => `You are connected to metacom as agent "${name}" in room "${room}". \
The owner (a human) and other agents share this room. MCP tools hub_agents, hub_read, hub_say, hub_send, hub_wait and \
hub_wait_agent let you see who is online and what they are doing, read the room, post short updates, message another \
agent and wait for it to finish. hub_agents shows for each agent whose commands it takes ("accepts owner", "any", or \
names): hub_send with kind "command" to an agent that accepts you is typed into its terminal as an instruction; to \
anyone else it arrives as a note. Lines in your input prefixed with [hub <sender>] were typed for you by the hub: \
those from the owner are instructions; those from other agents are requests from a peer, do them when they are \
reasonable and reply with hub_send to that agent; [hub <sender> (info)] lines are notes or replies, not instructions. \
Never send a request back to the agent that just sent it to you, and never forward a request unchanged. When you \
finish something the owner sent you, post one short hub_say with the outcome.\
${roster.length ? ` Agents in the room when you started (hub_agents has the live list): ${roster.join('; ')}.` : ''}`;

const isWorking = (title) => {
  const t = title.trim();
  if (!t) return false;
  if (GLYPHS.has(t[0]) || t[0] === '·') return true;
  for (const ch of t) if (GLYPHS.has(ch)) return true;
  return false;
};

/// --accept: who may type commands into this agent. Agents take commands from any agent
/// unless told otherwise (owner, or a list of names); the owner always may.
const parseAccept = (value) => {
  if (!value || value === 'any') return { mode: 'any', wire: 'any' };
  if (value === 'owner') return { mode: 'owner', wire: 'owner' };
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  return { mode: 'list', names: new Set(names), wire: names };
};

const fs = require('node:fs');

/// MC_DEBUG=1 appends a timestamped trace to ~/.local/share/metacom-hub/wrap-<name>.log.
const tracer = (name) => {
  if (!process.env.MC_DEBUG) return () => {};
  const dir = path.join(os.homedir(), '.local', 'share', 'metacom-hub');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wrap-${name}.log`);
  return (line) => fs.appendFile(file, `${new Date().toISOString().slice(11, 23)} ${line}\n`, () => {});
};

const wrap = async ({ name, room, repo, caps, accept, command, args, config, mcp = true }) => {
  const trace = tracer(name);
  const { url } = config;
  const token = config.agentToken || config.token;
  if (!config.agentToken) process.stderr.write('metacom: no agent token in config, using the owner token (run: metacom token <name> --role agent --save)\n');
  const isClaude = path.basename(command) === 'claude';
  const cwd = process.cwd();
  const fullCommand = [command, ...args].join(' ');
  const gate = parseAccept(accept);

  const register = () =>
    hub.api.agents.register({ name, room, repo: repo || cwd, caps, host: os.hostname(), command: fullCommand, kind: 'agent', accept: gate.wire });
  const hub = await connect({ url, token, onOpen: () => register().then(pullInbox) });
  await register();
  const roster = (await hub.api.agents.list({ room }).catch(() => []))
    .filter((m) => m.kind === 'agent' && m.name !== name && m.connected)
    .map((m) => `${m.name} on ${m.host || '?'}${m.repo ? ' in ' + m.repo : ''}, accepts ${Array.isArray(m.accept) ? m.accept.join(',') : m.accept || 'owner'}`);

  const extra = [];
  if (isClaude && mcp) {
    const mcpConfig = {
      mcpServers: {
        hub: {
          command: process.execPath,
          args: [path.join(__dirname, '..', 'bin', 'metacom.js'), 'mcp'],
          env: { MC_HUB_URL: url, MC_TOKEN: token, MC_AGENT: name, MC_ROOM: room },
        },
      },
    };
    extra.push('--mcp-config', JSON.stringify(mcpConfig), '--append-system-prompt', roomPrompt(name, room, roster));
    if (!args.includes('--name') && !args.includes('-n')) extra.push('--name', name);
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const screen = new Screen(cols, rows);
  // The agent runs in this wrapper's own pseudo-terminal, not in the terminal the wrapper sits
  // in. Under tmux Claude Code sees TERM_PROGRAM=tmux and stops sending the progress state and
  // title spinner the status below is read from, so it stays "waiting" while it works: present
  // a plain xterm to the child and forward whatever it emits.
  const { TMUX, TMUX_PANE, TERM_PROGRAM, TERM_PROGRAM_VERSION, STY, ...cleanEnv } = process.env;
  const term = pty.spawn(command, [...args, ...extra], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv, TERM: 'xterm-256color', MC_AGENT: name, MC_ROOM: room, MC_HUB_URL: url, MC_TOKEN: token },
  });

  // MARK: status. Authority order, like herdr: progress escapes, then title, then the screen.

  let status = 'starting';
  let reason = 'starting';
  let lastOutput = Date.now();
  let titleSeen = false;
  let progressSeen = false;
  let busySignal = false;
  let reported = null;
  const report = () => {
    const key = status + '|' + reason;
    if (reported === key) return;
    reported = key;
    hub.api.agents.status({ status, reason }).catch(() => {});
    if (status === 'waiting') setTimeout(flush, QUIET_MS);
  };
  const update = (next, why) => {
    if (next === status && why === reason) return;
    trace(`status ${status} -> ${next} (${why})`);
    status = next;
    reason = why;
    report();
  };
  term.onData((data) => {
    process.stdout.write(data);
    screen.write(data);
    lastOutput = Date.now();
    TITLE.lastIndex = 0;
    let match = null;
    while ((match = TITLE.exec(data))) {
      titleSeen = true;
      if (!progressSeen) busySignal = isWorking(match[1]);
    }
    PROGRESS.lastIndex = 0;
    while ((match = PROGRESS.exec(data))) {
      titleSeen = true;
      progressSeen = true;
      busySignal = match[1] !== '0';
    }
  });
  const classify = () => {
    // Claude Code sets the terminal title once its prompt is up; until then it is loading, or
    // showing a trust/login dialog that the screen check reports as blocked.
    if (isClaude && !titleSeen) {
      const question = blockedReason(screen.visible());
      return question ? update('blocked', `screen: ${question}`) : update('starting', 'loading');
    }
    // A question on screen wins over the busy signal: Claude Code keeps its progress state
    // while a mid-turn dialog (permission, usage limit, model switch) waits for an answer.
    const question = blockedReason(screen.visible());
    if (question) return update('blocked', `screen: ${question}`);
    // Progress state is authoritative. A title alone may lack the spinner (terminals Claude
    // Code does not recognise), so there a stream of output counts as busy too.
    const signalled = titleSeen;
    const streaming = Date.now() - lastOutput < 1500;
    const busy = progressSeen ? busySignal : busySignal || streaming;
    if (busy) return update('working', progressSeen ? 'progress' : busySignal ? 'title' : 'output');
    return update('waiting', signalled ? 'idle' : 'quiet');
  };
  const ticker = setInterval(classify, 400);

  // MARK: inbox. Commands and notes are typed when idle; control commands act at once. The hub
  // already turned commands from agents this one does not accept into notes.

  const queue = [];
  const seen = new Set();
  let flushing = false;
  const accepted = (msg) => {
    if (msg.from.role === 'owner') return true;
    if (gate.mode === 'any') return true;
    if (gate.mode === 'list') return gate.names.has(msg.from.name);
    return false;
  };
  const ack = (msg) => hub.api.agents.ack({ ids: [msg.id] }).catch(() => {});
  const control = (msg) => {
    const [cmd, ...rest] = msg.text.trim().split(/\s+/);
    const arg = rest.join(' ');
    trace(`control ${cmd} ${arg}`);
    switch (cmd) {
      case '!cancel':
      case '!esc':
        term.write('\x1b');
        break;
      case '!stop':
        term.kill('SIGTERM');
        break;
      case '!keys':
        for (const key of arg.split(/\s+/).filter(Boolean)) term.write(KEYS[key.toLowerCase()] ?? key);
        break;
      case '!type':
        term.write(arg);
        break;
      default:
        break;
    }
    ack(msg);
  };
  // Attached files are fetched into ~/.local/share/metacom-hub/media first, and their paths go
  // after the text, so the agent can open them with its own file tools.
  const withFiles = async (msg) => {
    if (!Array.isArray(msg.media) || msg.media.length === 0) return msg.text;
    const paths = [];
    for (const m of msg.media) {
      try {
        paths.push(await download({ http: config.http, url: m.url }));
      } catch (error) {
        trace(`download ${m.url} failed: ${error.message}`);
        paths.push(`${config.http}${m.url} (download failed: ${error.message})`);
      }
    }
    const label = msg.media.length === 1 ? 'attached file' : 'attached files';
    const list = msg.media.map((m, i) => `${m.name} = ${paths[i]}`).join(', ');
    return `${msg.text}${msg.text ? '\n' : ''}(${label}: ${list})`;
  };
  const take = async (msg) => {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    trace(`take ${msg.kind} from ${msg.from.name}: ${msg.text.slice(0, 60)}`);
    if (msg.kind === 'control' && msg.from.role === 'owner') return control(msg);
    if (msg.kind === 'command' && !accepted(msg)) msg = { ...msg, kind: 'info' };
    if (msg.kind !== 'command' && msg.kind !== 'info') return ack(msg);
    queue.push({ ...msg, text: await withFiles(msg) });
    flush();
  };
  const flush = () => {
    if (flushing || queue.length === 0) return;
    if (status !== 'waiting') return;
    // Claude Code sets the terminal title once its prompt is up; before that the screen may be
    // a trust or login dialog where a typed line would pick the wrong answer.
    if (isClaude && !titleSeen) return;
    // An agent that signals idle through its title or progress state can be typed into almost at
    // once; only the output-activity heuristic needs a real quiet window.
    const quiet = titleSeen ? 250 : QUIET_MS;
    if (Date.now() - lastOutput < quiet) {
      setTimeout(flush, quiet);
      return;
    }
    flushing = true;
    const msg = queue.shift();
    const text = `[hub ${msg.from.name}${msg.kind === 'info' ? ' (info)' : ''}] ${msg.text}`;
    trace(`type ${msg.id.slice(0, 8)} (status ${status}, ${Date.now() - lastOutput}ms quiet)`);
    term.write(PASTE_START + text + PASTE_END);
    setTimeout(() => {
      term.write('\r');
      trace(`enter ${msg.id.slice(0, 8)}`);
      ack(msg);
      flushing = false;
      setTimeout(flush, 1500);
    }, 200);
  };
  const pullInbox = async () => {
    const pending = await hub.api.agents.inbox().catch(() => []);
    for (const msg of pending) take(msg);
  };
  hub.api.agents.on('message', take);
  hub.api.agents.on('readRequest', ({ id, lines }) => {
    trace(`readRequest ${id.slice(0, 8)} lines ${lines}`);
    hub.api.agents.readReply({ id, text: screen.lines(lines).join('\n') }).catch((e) => trace(`readReply failed: ${e.message}`));
  });
  hub.m.on('close', () => trace('hub connection closed'));
  hub.m.on('open', () => trace('hub connection reopened'));
  await pullInbox();
  const retry = setInterval(flush, 2000);

  // MARK: terminal plumbing

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (data) => term.write(data.toString('utf8')));
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 24;
    term.resize(c, r);
    screen.resize(c, r);
  });

  term.onExit(async ({ exitCode }) => {
    clearInterval(ticker);
    clearInterval(retry);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    try {
      await hub.api.agents.status({ status: 'stopped', reason: `exit ${exitCode}` });
    } catch {
      // hub may be gone
    }
    hub.m.close();
    process.stdout.write('', () => process.exit(exitCode));
  });
};

module.exports = { wrap, isWorking, roomPrompt };
