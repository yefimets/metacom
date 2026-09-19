'use strict';

const path = require('node:path');

const WORD = /[a-z0-9_-]{3,}/gi;

const words = (text) => new Set((text.toLowerCase().match(WORD) || []));

/// Picks the agent for a task from live members. Heuristic first: name mentioned, repo
/// name mentioned, capability words, then prefer an idle agent. Returns null when no
/// agent is connected. Ties go to the most recently active.
const heuristic = (text, members) => {
  const lower = text.toLowerCase();
  const tokens = words(text);
  const candidates = members.filter((m) => m.kind === 'agent' && m.connected && m.status !== 'stopped' && m.status !== 'blocked');
  if (candidates.length === 0) return null;
  const scored = candidates.map((m) => {
    let score = 0;
    const reasons = [];
    const name = m.name.toLowerCase();
    if (lower.includes(name)) {
      score += 10;
      reasons.push(`named "${m.name}"`);
    }
    const repo = m.repo ? path.basename(m.repo).toLowerCase() : '';
    if (repo && lower.includes(repo)) {
      score += 6;
      reasons.push(`repo "${repo}"`);
    }
    for (const cap of m.caps || []) {
      const c = String(cap).toLowerCase();
      if (tokens.has(c) || lower.includes(c)) {
        score += 3;
        reasons.push(`capability "${cap}"`);
      }
    }
    if (m.status === 'waiting') {
      score += 1;
      reasons.push('idle');
    }
    return { member: m, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score || (b.member.lastSeen || '').localeCompare(a.member.lastSeen || ''));
  const best = scored[0];
  const tied = scored.filter((s) => s.score === best.score);
  return {
    agent: best.member.name,
    reason: best.reasons.length ? best.reasons.join(', ') : 'only or most recently active agent',
    confident: best.score > 1 && tied.length === 1,
    candidates: scored.map((s) => ({ name: s.member.name, score: s.score })),
  };
};

/// Optional model-based pick through OpenRouter when the heuristic is not confident.
const llmPick = async (text, members, { apiKey, model, fetchImpl = fetch }) => {
  const candidates = members.filter((m) => m.kind === 'agent' && m.connected && m.status !== 'stopped' && m.status !== 'blocked');
  if (candidates.length < 2) return null;
  const list = candidates
    .map((m) => `- ${m.name}: repo=${m.repo || '-'} caps=${(m.caps || []).join(',') || '-'} status=${m.status} host=${m.host || '-'}`)
    .join('\n');
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content:
          'You route a task to one of the coding agents below. Reply with JSON only: {"agent": "<name>", "reason": "<short>"}.',
      },
      { role: 'user', content: `Agents:\n${list}\n\nTask: ${text}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  };
  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '{}';
  const pick = JSON.parse(content);
  const found = candidates.find((m) => m.name === pick.agent);
  if (!found) return null;
  return { agent: found.name, reason: `model: ${pick.reason || 'chosen'}`, confident: true };
};

const route = async (text, members, options = {}) => {
  const first = heuristic(text, members);
  if (!first) return null;
  if (first.confident || !options.apiKey) return first;
  try {
    const second = await llmPick(text, members, options);
    return second || first;
  } catch (error) {
    options.console?.warn(`router: model pick failed (${error.message}), using heuristic`);
    return first;
  }
};

module.exports = { route, heuristic, llmPick };
