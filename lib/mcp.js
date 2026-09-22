'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');
const { download } = require('./media.js');

const text = (value) => ({ content: [{ type: 'text', text: value }] });

/// stdio MCP server spawned by the agent (claude --mcp-config). It joins the mc as the same
/// member as the wrapper, so the agent can read and post in its room while it works.
const serveMcp = async (config) => {
  const name = process.env.MC_AGENT;
  const room = process.env.MC_ROOM || config.room;
  if (!name) throw new Error('MC_AGENT is not set; `metacom mcp` is started by the wrapper');
  const token = config.agentToken || config.token;
  const mc = await connect({ url: config.url, token, onOpen: () => mc.api.agents.register({ name, room }) });
  await mc.api.agents.register({ name, room });
  // attachments come back as local files so the agent can open them with its own tools
  const local = async (msg) => {
    if (!Array.isArray(msg.media) || msg.media.length === 0) return line(msg);
    const files = await Promise.all(msg.media.map((m) => download({ http: config.http, url: m.url }).catch(() => `${config.http}${m.url}`)));
    return line({ ...msg, media: msg.media.map((m, i) => ({ ...m, url: files[i] })) });
  };

  const waiters = new Set();
  const onMessage = (msg) => {
    if (msg.from.name === name) return;
    for (const w of waiters) w(msg);
  };
  mc.api.room.on('message', onMessage);

  const server = new McpServer({ name: 'metacom', version: '0.1.0' });

  server.tool('mc_agents', 'List the agents and humans on the mc with status (working, waiting, stopped), room, host, repo, and whose commands each agent accepts (owner, any, or names): you can mc_send a command to the ones that accept you.', {}, async () => {
    const list = await mc.api.agents.list({});
    return text(list.map(member).join('\n') || 'nobody');
  });

  server.tool(
    'mc_read',
    `Read the last messages of room "${room}": what the owner and other agents said, and directed messages.`,
    { limit: z.number().int().min(1).max(200).optional().describe('How many, default 30') },
    async ({ limit }) => {
      const list = await mc.api.room.history({ room, limit: limit || 30 });
      return text((await Promise.all(list.map(local))).join('\n') || '(empty)');
    },
  );

  server.tool(
    'mc_say',
    'Post a short message to the room. Everyone in the room and the owner see it. Use it to report an outcome or a decision that affects others.',
    { text: z.string().min(1).max(16000) },
    async ({ text: body }) => {
      const msg = await mc.api.room.say({ room, text: body });
      return text(`posted ${msg.id}`);
    },
  );

  server.tool(
    'mc_send',
    'Send a directed message to another agent by name. kind "command" (default) is typed into its terminal as an instruction when it is idle, if that agent accepts commands from you (see mc_agents), otherwise it arrives as a note; kind "info" is a note or a reply. Use mc_wait_agent afterwards to know when it finished, and mc_read or mc_wait for its reply.',
    { to: z.string(), text: z.string().min(1).max(16000), kind: z.enum(['info', 'command']).optional() },
    async ({ to, text: body, kind }) => {
      const result = await mc.api.agents.send({ to, text: body, kind: kind || 'command' });
      const how = result.kind === 'command' ? 'as a command' : result.downgraded ? `as a note (${result.to} does not take commands from you)` : 'as a note';
      return text(result.delivered ? `delivered to ${result.to} ${how}` : `${result.to} is offline, queued ${how}`);
    },
  );

  server.tool(
    'mc_wait',
    'Wait for the next message in the room from someone else (up to `seconds`, default 60). Returns it, or "timeout".',
    { seconds: z.number().int().min(1).max(600).optional() },
    async ({ seconds }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(text('timeout'));
        }, (seconds || 60) * 1000);
        const waiter = (msg) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          local(msg).then((s) => resolve(text(s)));
        };
        waiters.add(waiter);
      }),
  );

  server.tool(
    'mc_wait_agent',
    'Wait until another agent is ready (waiting, blocked or stopped), for up to `seconds` (default 120). Returns its status. Use after mc_send to collect a result.',
    { name: z.string(), seconds: z.number().int().min(1).max(600).optional() },
    async ({ name: who, seconds }) => {
      const r = await mc.api.agents.wait({ name: who, timeoutMs: (seconds || 120) * 1000 });
      return text(r.timeout ? `timeout, ${who} is still ${r.status}` : `${who} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on('close', () => {
    mc.m.close();
    process.exit(0);
  });
};

module.exports = { serveMcp };
