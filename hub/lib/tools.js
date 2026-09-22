'use strict';

/// The closed, typed tool set of the assistant. `where` says who executes a call: the org
/// itself, or Flow on the Mac. Calls are validated against these schemas before anything
/// runs or is returned; a call that does not fit is refused, never executed.
const flow = { type: 'integer', minimum: 1, maximum: 9, description: 'Flow number 1-9' };
const direction = { type: 'string', enum: ['left', 'right', 'up', 'down'] };

const tool = (name, where, description, properties = {}, required = []) => ({
  name,
  where,
  description,
  parameters: { type: 'object', properties, required },
});

const TOOLS = [
  tool('message_agent', 'org', 'Send an instruction to a coding agent, by its exact name from "Agents", wherever it runs (this Mac or a server).',
    { agent: { type: 'string' }, text: { type: 'string' } }, ['agent', 'text']),
  tool('read_agent', 'org', 'Read the last lines of an agent\'s terminal screen, to tell the user what it is doing or what question it is blocked on.',
    { agent: { type: 'string' }, lines: { type: 'integer', minimum: 5, maximum: 200 } }, ['agent']),
  tool('say_to_room', 'org', 'Post a short message to the room that every agent will read. Use it for information meant for all agents, not for an instruction to one.',
    { text: { type: 'string' } }, ['text']),
  tool('switch_flow', 'flow', 'Switch to a flow (workspace). Creates it if missing.', { flow }, ['flow']),
  tool('move_window_to_flow', 'flow', 'Move the focused window to a flow and follow it.', { flow }, ['flow']),
  tool('new_flow', 'flow', 'Create a new empty flow and switch to it.'),
  tool('remove_flow', 'flow', 'Remove the current flow and close its windows.'),
  tool('focus', 'flow', 'Focus the neighbouring window in a direction.', { direction }, ['direction']),
  tool('swap', 'flow', 'Swap the focused window with its neighbour in a direction.', { direction }, ['direction']),
  tool('toggle_float', 'flow', 'Toggle the focused window between floating and tiled.'),
  tool('toggle_fullscreen', 'flow', 'Toggle fullscreen for the focused window.'),
  tool('close_window', 'flow', 'Close the focused window.'),
  tool('open_browser', 'flow', 'Open a new browser window in the current flow.'),
  tool('open_terminal', 'flow', 'Open a new terminal window in the current flow.'),
  tool('open_app', 'flow', 'Launch or bring forward a macOS application by name, e.g. Notes, Telegram, Messages.', { name: { type: 'string' } }, ['name']),
  tool('open_url', 'flow', 'Open a URL in the default browser.', { url: { type: 'string' } }, ['url']),
  tool('screenshot_flow', 'flow', 'Capture every window of a flow to PNG files (current flow if omitted).', { flow }),
  tool('say', 'flow', 'Tell the user something short. Use it only to ask one clarifying question or to report that you cannot proceed.', { text: { type: 'string' } }, ['text']),
  tool('start_agent', 'flow', 'Start a coding agent (Claude Code) in a repository: a new flow named after it with a terminal running the agent, joined to the org.',
    { repo: { type: 'string', description: 'Folder path, ~ allowed' }, name: { type: 'string' } }, ['repo']),
  tool('send_to_agent', 'flow', 'Type a message into the agent terminal of a flow on this Mac and press return. Only for terminals that are not listed under "Agents".',
    { flow, text: { type: 'string' } }, ['flow', 'text']),
  tool('web_search', 'flow', 'Open Chrome in the current flow with a Google search for the query.', { query: { type: 'string' } }, ['query']),
  tool('create_note', 'flow', 'Create a note in Apple Notes with a title and body text.', { title: { type: 'string' }, body: { type: 'string' } }, ['title']),
  tool('type_text', 'flow', 'Type text into whatever has keyboard focus, as if on the keyboard. Focus the right app first.', { text: { type: 'string' } }, ['text']),
  tool('press_key', 'flow', 'Press a key in the focused app.',
    { key: { type: 'string', enum: ['return', 'escape', 'tab', 'find', 'address_bar', 'select_all', 'copy', 'paste', 'new_tab', 'save'] } }, ['key']),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/// OpenAI-style function list for the model.
const schema = () => TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));

const checkValue = (schemaNode, value) => {
  if (schemaNode.type === 'integer' || schemaNode.type === 'number') {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || Number.isNaN(n)) return { error: 'not a number' };
    if (schemaNode.type === 'integer' && !Number.isInteger(n)) return { error: 'not an integer' };
    if (schemaNode.minimum !== undefined && n < schemaNode.minimum) return { error: `below ${schemaNode.minimum}` };
    if (schemaNode.maximum !== undefined && n > schemaNode.maximum) return { error: `above ${schemaNode.maximum}` };
    return { value: n };
  }
  if (schemaNode.type === 'string') {
    if (typeof value !== 'string') return { error: 'not a string' };
    if (schemaNode.enum && !schemaNode.enum.includes(value)) return { error: `must be one of ${schemaNode.enum.join(', ')}` };
    if (value.length > 16000) return { error: 'too long' };
    return { value };
  }
  return { error: 'unsupported type' };
};

/// Returns { tool, args } for a valid call, or { error } for anything else.
const validate = (name, rawArgs) => {
  const tool = byName.get(name);
  if (!tool) return { error: `unknown tool ${name}` };
  const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const args = {};
  for (const [key, node] of Object.entries(tool.parameters.properties)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      if (tool.parameters.required.includes(key)) return { error: `missing ${key}` };
      continue;
    }
    const checked = checkValue(node, input[key]);
    if (checked.error) return { error: `${key}: ${checked.error}` };
    args[key] = checked.value;
  }
  return { tool, args };
};

module.exports = { TOOLS, schema, validate };
