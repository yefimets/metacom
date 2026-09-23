'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/// How to hand a coding agent its room: the MCP server that gives it mc_* tools, and the
/// briefing that tells it what those lines in its terminal mean. Every agent is wrapped the
/// same way (pty, status, typing); this is only the part each one configures differently.
///
///   claude    --mcp-config JSON, --append-system-prompt
///   codex     -c mcp_servers.metacom.{command,args,env}  (merged over ~/.codex/config.toml)
///   opencode  OPENCODE_CONFIG_CONTENT: { mcp, instructions } merged over the user's config
///   anything else: no tools, and the agent is driven by what the owner types into it
///
/// The briefing also travels inside the MCP server itself (its `instructions`, which clients
/// put in the model's context), so a harness we do not know still gets it with the tools.
const KNOWN = ['claude', 'codex', 'opencode'];

const mcpCommand = () => ({
  command: process.execPath,
  args: [path.join(__dirname, '..', 'bin', 'metacom.js'), 'mcp'],
});

const kindOf = (command) => {
  const base = path.basename(String(command || '')).replace(/\.(exe|cmd|js)$/, '');
  return KNOWN.includes(base) ? base : 'other';
};

/// Reads the user's own opencode config so ours is a merge, not a replacement: OPENCODE_CONFIG_CONTENT
/// stands in for the global config file, and losing their model or provider would break the agent.
const opencodeConfig = () => {
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  for (const file of [process.env.OPENCODE_CONFIG, path.join(home, 'opencode', 'opencode.json'), path.join(home, 'opencode', 'opencode.jsonc')]) {
    if (!file) continue;
    try {
      // jsonc: strip // comments and trailing commas, the two things opencode's own config allows
      const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(raw);
    } catch {
      // unreadable or absent: fall through to the next candidate
    }
  }
  return {};
};

/// `args` are appended to the command line, `env` is added to its environment, `files` are
/// written first (the briefing file an instructions list points at).
const configure = ({ command, name, room, url, token, prompt, mcp = true, dataDir }) => {
  const kind = kindOf(command);
  const out = { kind, args: [], env: {}, files: [], tools: false };
  if (!mcp || kind === 'other') return out;
  const { command: node, args: mcpArgs } = mcpCommand();
  const env = { MC_URL: url, MC_TOKEN: token, MC_AGENT: name, MC_ROOM: room, MC_PROMPT: prompt };
  out.tools = true;

  if (kind === 'claude') {
    out.args.push('--mcp-config', JSON.stringify({ mcpServers: { mc: { command: node, args: mcpArgs, env } } }), '--append-system-prompt', prompt);
    return out;
  }

  if (kind === 'codex') {
    // TOML values on the command line; codex merges them over the user's config.toml
    const toml = (v) => JSON.stringify(v);
    out.args.push(
      '-c', `mcp_servers.metacom.command=${toml(node)}`,
      '-c', `mcp_servers.metacom.args=[${mcpArgs.map(toml).join(',')}]`,
      '-c', `mcp_servers.metacom.env={${Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`,
    );
    return out;
  }

  if (kind === 'opencode') {
    const file = path.join(dataDir, `room-${name}.md`);
    out.files.push({ file, content: prompt + '\n' });
    const base = opencodeConfig();
    const merged = {
      ...base,
      mcp: { ...(base.mcp || {}), metacom: { type: 'local', command: [node, ...mcpArgs], enabled: true, environment: env } },
      instructions: [...(Array.isArray(base.instructions) ? base.instructions : []), file],
    };
    out.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(merged);
    return out;
  }

  return out;
};

module.exports = { configure, kindOf, KNOWN };
