'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { connect } = require('./client.js');
const { line, member } = require('./format.js');
const { download, upload } = require('./media.js');

const text = (value) => ({ content: [{ type: 'text', text: value }] });

/// stdio MCP server spawned by the agent (claude --mcp-config). It joins the hub as the same
/// member as the wrapper, so the agent can read and post in its room while it works.
const serveMcp = async (config) => {
  const name = process.env.MC_AGENT;
  const room = process.env.MC_ROOM || config.room;
  if (!name) throw new Error('MC_AGENT is not set; `metacom mcp` is started by the wrapper');
  const token = config.agentToken || config.token;
  // The wrapper owns the member's presence; the bridge only follows it. Claude Code can hand a
  // session to its background daemon, which keeps this process alive after the wrapper is gone:
  // leave with the wrapper instead of lingering in the room under its name.
  const wrapper = Number(process.env.MC_WRAPPER_PID);
  if (wrapper) {
    setInterval(() => {
      try {
        process.kill(wrapper, 0);
      } catch (err) {
        if (err.code === 'ESRCH') process.exit(0);
      }
    }, 2000).unref();
  }
  const hub = await connect({ url: config.url, token, onOpen: () => hub.api.agents.register({ name, room, follow: true }) });
  await hub.api.agents.register({ name, room, follow: true });
  // attachments come back as local files so the agent can open them with its own tools
  const local = async (msg) => {
    if (!Array.isArray(msg.media) || msg.media.length === 0) return line(msg);
    const files = await Promise.all(msg.media.map((m) => download({ http: config.http, url: m.url }).catch(() => `${config.http}${m.url}`)));
    return line({ ...msg, media: msg.media.map((m, i) => ({ ...m, url: files[i] })) });
  };

  // local paths the agent wants to hand over: uploaded with the agent's token, attached by url
  const files = z.array(z.string()).max(8).optional().describe('Absolute paths of local files to attach (md, txt, pdf, csv, json, log, patch, zip, images; up to 20 MB each). The recipient gets them as downloadable files.');
  const attach = async (paths) => {
    if (!paths || !paths.length) return undefined;
    return Promise.all(paths.map((file) => upload({ http: config.http, token, file })));
  };
  const attached = (media) => (media && media.length ? ` with ${media.map((m) => m.name).join(', ')}` : '');

  const waiters = new Set();
  const onMessage = (msg) => {
    if (msg.from.name === name) return;
    for (const w of waiters) w(msg);
  };
  hub.api.room.on('message', onMessage);

  const server = new McpServer({ name: 'metacom', version: '0.1.0' });

  server.tool('hub_agents', 'List the agents and humans on the hub with status (working, waiting, stopped), room, host, repo, and whose commands each agent accepts (owner, any, or names): you can hub_send a command to the ones that accept you.', {}, async () => {
    const list = await hub.api.agents.list({});
    return text(list.map(member).join('\n') || 'nobody');
  });

  server.tool(
    'hub_read',
    `Read the last messages of room "${room}": what the owner and other agents said, and directed messages. Each line starts with the message's #id; pass it as replyTo to answer that message in its thread.`,
    { limit: z.number().int().min(1).max(200).optional().describe('How many, default 30') },
    async ({ limit }) => {
      const list = await hub.api.room.history({ room, limit: limit || 30 });
      return text((await Promise.all(list.map(async (m) => `#${m.id.slice(0, 8)} ${await local(m)}`))).join('\n') || '(empty)');
    },
  );

  // Threads: a command that replies to nothing starts a clean context in the agent that gets it;
  // one that replies to a message carries on that message's conversation.
  const replyTo = z
    .string()
    .optional()
    .describe('The #id (from hub_read) of the message you answer. Keeps the thread: a command sent with it continues the conversation the receiver had there; without it, the receiver starts a clean context. Your answers to the command you are working on join its thread by themselves.');

  server.tool(
    'hub_say',
    'Post a short message to the room. Everyone in the room and the owner see it. Use it to report an outcome or a decision that affects others. Attach `files` to hand over a report, a log or a screenshot instead of pasting it.',
    { text: z.string().min(1).max(16000), files, replyTo },
    async ({ text: body, files: paths, replyTo: re }) => {
      const media = await attach(paths);
      const msg = await hub.api.room.say({ room, text: body, media, replyTo: re });
      return text(`posted ${msg.id}${attached(media)}`);
    },
  );

  server.tool(
    'hub_send',
    'Send a directed message to another agent by name. kind "command" (default) is typed into its terminal as an instruction when it is idle, if that agent accepts commands from you (see hub_agents), otherwise it arrives as a note; kind "info" is a note or a reply. Works for humans too (the owner): send them a file with `files`. Use hub_wait_agent afterwards to know when it finished, and hub_read or hub_wait for its reply.',
    { to: z.string(), text: z.string().min(1).max(16000), kind: z.enum(['info', 'command']).optional(), files, replyTo },
    async ({ to, text: body, kind, files: paths, replyTo: re }) => {
      const media = await attach(paths);
      const result = await hub.api.agents.send({ to, text: body, kind: kind || 'command', media, replyTo: re });
      const how = result.kind === 'command' ? 'as a command' : result.downgraded ? `as a note (${result.to} does not take commands from you)` : 'as a note';
      return text((result.delivered ? `delivered to ${result.to} ${how}` : `${result.to} is offline, queued ${how}`) + attached(media));
    },
  );

  server.tool(
    'hub_wait',
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
    'hub_wait_agent',
    'Wait until another agent is ready (waiting, blocked or stopped), for up to `seconds` (default 120). Returns its status. Use after hub_send to collect a result.',
    { name: z.string(), seconds: z.number().int().min(1).max(600).optional() },
    async ({ name: who, seconds }) => {
      const r = await hub.api.agents.wait({ name: who, timeoutMs: (seconds || 120) * 1000 });
      return text(r.timeout ? `timeout, ${who} is still ${r.status}` : `${who} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on('close', () => {
    hub.m.close();
    process.exit(0);
  });
};

module.exports = { serveMcp };
