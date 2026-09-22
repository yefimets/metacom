'use strict';

const crypto = require('node:crypto');
const { chat } = require('./openrouter.js');
const { schema, validate } = require('./tools.js');
const { fail } = require('./errors.js');

const MAX_ROUNDS = 5;
const SESSION_TTL = 5 * 60 * 1000;

/// The voice assistant's brain, moved from Flow into the org. Flow sends the transcript and
/// what it sees on screen; the org runs the model over the typed tool set, executes the org
/// tools itself (agents, room) and hands Flow only validated local actions to perform. Flow
/// reports their results with `resume`, and the loop continues, at most five model rounds.
class Assistant {
  constructor({ org, console, apiKey, model }) {
    this.org = org;
    this.console = console;
    this.apiKey = apiKey || null;
    this.model = model || 'google/gemini-2.5-flash';
    this.sessions = new Map();
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.createdAt > SESSION_TTL) this.sessions.delete(id);
  }

  system({ conn, room, state, history, name }) {
    const agents = this.org.list(conn, room).filter((m) => m.kind === 'agent');
    const online = agents.filter((m) => m.connected);
    const listed = (online.length ? online : agents)
      .map((m) => `  ${m.name}: ${m.connected ? m.status : 'offline'}, room ${m.room}${m.host ? ', host ' + m.host : ''}${m.repo ? ', repo ' + m.repo : ''}${m.caps?.length ? ', can: ' + m.caps.join(' ') : ''}`)
      .join('\n');
    return `You are ${name}, a voice assistant that operates the user's Mac through Flow, a tiling window manager \
with numbered flows (workspaces), and coordinates the user's coding agents through metacom. \
Agent statuses: working, waiting (idle), blocked (stuck on a question or permission: read_agent shows it, and \
the owner answers with a control command like "!keys enter" or "!cancel"), done (finished, not looked at yet). \
To answer "what is X doing", call read_agent and then say a one-sentence summary. \
Do what the user asks by calling tools; call several when the request needs it. \
message_agent sends an instruction to an agent listed under "Agents", by exact name; when the user does not name \
one, pick the agent whose repository or capabilities fit, or ask with say. Prefer it over send_to_agent, which only \
types into a terminal on this Mac. \
say_to_room is for information every agent should know. For notes use create_note. For searching the web use web_search. \
type_text and press_key act on the focused app; start_agent needs an existing repository path from the list in the \
current state; if the user names a project you cannot match to that list, ask with say instead of guessing. \
open_app first when you need a particular app to have focus, and wait for the tool result before typing. \
Only use type_text when the user explicitly asks to type, write or enter something. \
Do the job silently: do not narrate or confirm. Use say only when you cannot proceed and need one \
clarifying question, in the user's language. Never invent flow numbers the user did not mention. \
Use the conversation history and the recent actions to resolve references like "again", "that one", \
"the other flow" and "go back".
Agents:
${listed || '  (none connected)'}
Current state on the Mac:
${state || '(unknown)'}
Conversation so far, oldest first:
${history || '(none)'}`;
  }

  async ask(conn, { text, state = '', history = '', room, model, name = 'Flow' } = {}) {
    if (!this.enabled) throw fail(501, 'The org has no OPENROUTER_API_KEY; the assistant is off');
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'text is required');
    this.sweep();
    const session = {
      id: crypto.randomUUID(),
      conn,
      room: room || conn.room,
      model: model || this.model,
      rounds: 0,
      pending: [],
      actions: [],
      createdAt: Date.now(),
      messages: [
        { role: 'system', content: this.system({ conn, room, state, history, name }) },
        { role: 'user', content: text },
      ],
    };
    this.sessions.set(session.id, session);
    this.console.log(`assistant: heard "${text.slice(0, 80)}"`);
    return this.run(session);
  }

  async resume(conn, { session: id, results = [], state = '' } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw fail(404, 'No such assistant session, or it expired');
    if (session.conn.record.id !== conn.record.id) throw fail(403, 'Not your session');
    const given = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.id), String(r.result ?? 'ok').slice(0, 8000)]));
    for (const callId of session.pending) {
      session.messages.push({ role: 'tool', tool_call_id: callId, content: given.get(callId) || 'done' });
    }
    session.pending = [];
    if (state) session.messages[0].content = session.messages[0].content.replace(/Current state on the Mac:\n[\s\S]*?\nConversation so far/, `Current state on the Mac:\n${state}\nConversation so far`);
    return this.run(session);
  }

  async run(session) {
    while (session.rounds < MAX_ROUNDS) {
      session.rounds++;
      const reply = await chat({ apiKey: this.apiKey, model: session.model, messages: session.messages, tools: schema() });
      if (reply.calls.length === 0) return this.finish(session, { reply: reply.text });
      session.messages.push(reply.assistantMessage);
      const forFlow = [];
      let sayCalled = false;
      for (const call of reply.calls) {
        const checked = validate(call.name, call.arguments);
        if (checked.error) {
          this.console.warn(`assistant: refused ${call.name}: ${checked.error}`);
          session.messages.push({ role: 'tool', tool_call_id: call.id, content: `refused: ${checked.error}` });
          continue;
        }
        if (checked.tool.where === 'org') {
          const result = await this.execute(session, call.name, checked.args);
          session.actions.push(`${call.name}: ${result}`);
          session.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
          continue;
        }
        if (call.name === 'say') sayCalled = true;
        forFlow.push({ id: call.id, name: call.name, arguments: checked.args });
      }
      if (forFlow.length === 0) continue;
      session.pending = forFlow.map((c) => c.id);
      if (sayCalled) return this.finish(session, { reply: reply.text, calls: forFlow });
      const actions = session.actions.splice(0);
      return { session: session.id, done: false, calls: forFlow, actions, reply: '' };
    }
    return this.finish(session, { reply: '' });
  }

  finish(session, { reply = '', calls = [] }) {
    this.sessions.delete(session.id);
    const actions = session.actions.splice(0);
    this.console.log(`assistant: done in ${session.rounds} round${session.rounds === 1 ? '' : 's'}${actions.length ? ', ' + actions.join('; ') : ''}`);
    return { session: session.id, done: true, calls, actions, reply };
  }

  async execute(session, name, args) {
    const { conn } = session;
    try {
      if (name === 'message_agent') {
        const r = this.org.send(conn, args.agent, args.text, 'command');
        return `${r.delivered ? 'delivered to' : 'queued for offline'} ${r.to}`;
      }
      if (name === 'read_agent') {
        const r = await this.org.read(conn, args.agent, args.lines || 40);
        return r.text.trim() ? r.text : '(empty screen)';
      }
      if (name === 'say_to_room') {
        const msg = this.org.say(conn, session.room, args.text);
        return `posted to room ${msg.room}`;
      }
      return 'refused: not a org tool';
    } catch (error) {
      return `failed: ${error.message}`;
    }
  }
}

module.exports = { Assistant };
