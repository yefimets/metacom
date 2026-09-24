import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

/// Messages are written the way people write to agents: numbered steps, bullets, `code`,
/// **bold**, a fenced block now and then. A terminal chat that prints them as one flat
/// paragraph loses the shape of what was said, so the chat reads the markdown and draws it —
/// a list keeps its hanging indent, code keeps its colour, and the text stays selectable,
/// because every line still knows exactly which characters it shows.

export type Tone = "code" | "mention" | "muted" | "rule";
export type Span = { text: string; bold?: boolean; italic?: boolean; tone?: Tone; name?: string };
export type Line = { text: string; spans: Span[] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const CODE = /`([^`\n]+)`/;
const BOLD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/;
const ITALIC = /(?:^|(?<=[^\w*]))\*([^*\n]+)\*(?![\w*])|(?:^|(?<=[^\w_]))_([^_\n]+)_(?![\w_])/;
const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/giu;

type Style = { bold?: boolean; italic?: boolean; tone?: Tone };
type IsMember = (name: string) => boolean;

const add = (out: Span[], text: string, style: Style, name?: string): void => {
  if (!text) return;
  out.push(name ? { text, ...style, name } : { text, ...style });
};

/// @mentions of people who are actually here, so a name lights up in its own colour.
const mentions = (text: string, style: Style, isMember: IsMember): Span[] => {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const word = m[2]!;
    if (!isMember(word)) continue;
    const start = m.index! + m[1]!.length;
    add(out, text.slice(last, start), style);
    add(out, `@${word}`, { ...style, tone: "mention" }, word);
    last = m.index! + m[0].length;
  }
  add(out, text.slice(last), style);
  return out;
};

/// `code`, **bold**, *italic* and mentions, in that order: the marks come off the text, which
/// is what the reader sees and therefore what a selection copies.
export const inline = (text: string, isMember: IsMember, style: Style = {}): Span[] => {
  const code = CODE.exec(text);
  if (code) {
    return [
      ...inline(text.slice(0, code.index), isMember, style),
      { text: code[1]!, ...style, tone: "code" },
      ...inline(text.slice(code.index + code[0].length), isMember, style),
    ];
  }
  const bold = BOLD.exec(text);
  if (bold) {
    return [
      ...inline(text.slice(0, bold.index), isMember, style),
      ...inline(bold[1] ?? bold[2]!, isMember, { ...style, bold: true }),
      ...inline(text.slice(bold.index + bold[0].length), isMember, style),
    ];
  }
  const italic = ITALIC.exec(text);
  if (italic) {
    const body = italic[1] ?? italic[2]!;
    const at = text.indexOf(body, italic.index) - 1;
    return [
      ...inline(text.slice(0, at), isMember, style),
      ...inline(body, isMember, { ...style, italic: true }),
      ...inline(text.slice(at + body.length + 2), isMember, style),
    ];
  }
  return mentions(text, style, isMember);
};

const widthOf = (spans: Span[]): number => spans.reduce((n, s) => n + terminalWidth(s.text), 0);
const lineOf = (spans: Span[]): Line => ({ text: spans.map((s) => s.text).join(""), spans });

/// Words with the style they carry, so wrapping can move them between lines.
const words = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const span of spans) {
    for (const part of span.text.split(/(\s+)/)) {
      if (part) out.push({ ...span, text: part });
    }
  }
  return out;
};

/// A paragraph, list item or quote laid out in `width` columns: the first line starts after
/// `lead`, every line after it under `hang`, which is how a numbered step keeps its shape.
export const wrapSpans = (spans: Span[], width: number, lead: Span[] = [], hang = ""): Line[] => {
  const room = Math.max(1, width);
  const out: Line[] = [];
  let current: Span[] = [...lead];
  let used = widthOf(lead);
  const indent: Span[] = hang ? [{ text: hang }] : [];
  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1]!.text.trim() === "") current.pop();
    out.push(lineOf(current));
    current = [...indent];
    used = terminalWidth(hang);
  };
  for (const word of words(spans)) {
    const w = terminalWidth(word.text);
    const blank = word.text.trim() === "";
    if (blank && current.length === indent.length && out.length > 0) continue; // no space after a wrap
    if (used + w > room && !blank && current.length > (out.length === 0 ? lead.length : indent.length)) flush();
    // a word longer than the line (a url, a path) is cut rather than pushing the layout out
    if (w > room) {
      const rest = splitGraphemes(word.text);
      while (rest.length > 0) {
        const free = room - used;
        const take: string[] = [];
        let taken = 0;
        while (rest.length > 0 && taken + terminalWidth(rest[0]!) <= free) {
          taken += terminalWidth(rest[0]!);
          take.push(rest.shift()!);
        }
        if (take.length === 0) {
          flush();
          continue;
        }
        current.push({ ...word, text: take.join("") });
        used += taken;
        if (rest.length > 0) flush();
      }
      continue;
    }
    current.push(word);
    used += w;
  }
  if (current.length > indent.length || out.length === 0) flush();
  return out;
};

const hardLines = (text: string, width: number, style: Style): Line[] => {
  const out: Line[] = [];
  let rest = splitGraphemes(text);
  do {
    const take: string[] = [];
    let taken = 0;
    while (rest.length > 0 && taken + terminalWidth(rest[0]!) <= Math.max(1, width)) {
      taken += terminalWidth(rest[0]!);
      take.push(rest.shift()!);
    }
    out.push(lineOf([{ text: take.join(""), ...style }]));
  } while (rest.length > 0);
  return out;
};

/// A message body as the screen shows it. One entry per drawn line: `text` is exactly what
/// that line prints (what a selection copies), `spans` how it is coloured.
export const renderBody = (body: string, width: number, isMember: IsMember = () => false): Line[] => {
  const out: Line[] = [];
  let fenced = false;
  for (const raw of body.split("\n")) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(...hardLines("  " + raw.replace(/\t/g, "  "), width, { tone: "code" }));
      continue;
    }
    if (raw.trim() === "") {
      out.push({ text: "", spans: [] });
      continue;
    }
    if (RULE.test(raw)) {
      out.push(lineOf([{ text: "─".repeat(Math.max(1, Math.min(width, 40))), tone: "rule" }]));
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push(...wrapSpans(inline(heading[2]!, isMember, { bold: true }), width));
      continue;
    }
    const quote = QUOTE.exec(raw);
    if (quote) {
      const lead: Span[] = [{ text: `${quote[1]}│ `, tone: "muted" }];
      out.push(...wrapSpans(inline(quote[2]!, isMember, { tone: "muted" }), width, lead, `${quote[1]}│ `));
      continue;
    }
    const item = ORDERED.exec(raw) ?? BULLET.exec(raw);
    if (item) {
      const [, pad, mark, rest] = item as unknown as [string, string, string, string];
      const bullet = /^\d/.test(mark) ? mark : "·";
      const lead: Span[] = [{ text: `${pad}${bullet} `, tone: /^\d/.test(mark) ? undefined : "muted" }];
      out.push(...wrapSpans(inline(rest, isMember), width, lead, " ".repeat(terminalWidth(`${pad}${bullet} `))));
      continue;
    }
    const pad = /^\s*/.exec(raw)![0];
    const lead: Span[] = pad ? [{ text: pad }] : [];
    out.push(...wrapSpans(inline(raw.slice(pad.length), isMember), width, lead, pad));
  }
  return out;
};

/// Just the text of each drawn line: what selection and copy work on.
export const bodyTextLines = (body: string, width: number): string[] => renderBody(body, width).map((l) => l.text);
