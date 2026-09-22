'use strict';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/// One chat completion with function tools. Returns the text, the parsed tool calls and the
/// assistant message to replay into the conversation before the tool results.
const chat = async ({ apiKey, model, messages, tools, fetchImpl = fetch }) => {
  const body = { model, messages };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/metarhia/metacom',
      'X-Title': 'metacom',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error('OpenRouter: unexpected response shape');
  const text = typeof message.content === 'string' ? message.content : '';
  const calls = [];
  for (const [i, tc] of (message.tool_calls || []).entries()) {
    const fn = tc.function;
    if (!fn || !fn.name) continue;
    let args = {};
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = {};
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments;
    }
    calls.push({ id: tc.id || `call_${i}`, name: fn.name, arguments: args });
  }
  const assistantMessage = { role: 'assistant', content: text };
  if (message.tool_calls) assistantMessage.tool_calls = message.tool_calls;
  return { text, calls, assistantMessage };
};

module.exports = { chat };
