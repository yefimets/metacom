import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

/// Messages are written the way people write to agents: numbered steps, bullets, `code`,
/// **bold**, a fenced block now and then. A terminal chat that prints them as one flat
/// paragraph loses the shape of what was said, so the chat reads the markdown and draws it —
/// a list keeps its hanging indent, code keeps its colour, and the text stays selectable,
/// because every line still knows exactly which characters it shows.

export type Tone = "code" | "mention" | "muted" | "rule" | "link";
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
// What a click opens: a web address, or a file token as the chat writes it, "[image 2.png]".
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const FILE_TOKEN = /\[([^\[\]\n]{1,120}\.[a-z0-9]{1,6})\]/gi;

type Style = { bold?: boolean; italic?: boolean; tone?: Tone };
type IsMember = (name: string) => boolean;

const add = (out: Span[], text: string, style: Style, name?: string): void => {
  if (!text) return;
  out.push(name ? { text, ...style, name } : { text, ...style });
};

/// Web addresses and "[file.ext]" tokens, underlined: a click opens them. The rest goes on to
/// the mentions.
const links = (text: string, style: Style, isMember: IsMember): Span[] => {
  const found = [...text.matchAll(URL_RE), ...text.matchAll(FILE_TOKEN)].sort((a, b) => a.index! - b.index!);
  const out: Span[] = [];
  let last = 0;
  for (const m of found) {
    if (m.index! < last) continue;
    out.push(...mentions(text.slice(last, m.index), style, isMember));
    add(out, m[0], { ...style, tone: "link" });
    last = m.index! + m[0].length;
  }
  out.push(...mentions(text.slice(last), style, isMember));
  return out;
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
  return links(text, style, isMember);
};

export type LinkTarget = { url: string } | { file: string } | { name: string };

/// What sits under a click in a message body: `lines` are the body's drawn lines, `row` the
/// one clicked, `col` the terminal column within it. A web address (followed onto the next
/// line when it wraps there), a "[file.ext]" token or a name of an attached file, or a person —
/// "@name", or a bare name of someone here.
export const linkAt = (lines: string[], row: number, col: number, ctx: { files: string[]; isMember: IsMember; me: string }): LinkTarget | undefined => {
  const line = lines[row];
  if (line === undefined || col < 0) return;
  // the character under the column, counting wide characters as the terminal does
  let at = -1;
  let x = 0;
  let i = 0;
  for (const g of splitGraphemes(line)) {
    const w = terminalWidth(g);
    if (col >= x && col < x + Math.max(1, w)) {
      at = i;
      break;
    }
    x += w;
    i += g.length;
  }
  if (at < 0) return;
  const hit = (re: RegExp, text: string) => [...text.matchAll(re)].find((m) => m.index! <= at && at < m.index! + m[0].length);
  // a web address that runs to the end of the line goes on at the start of the next one
  const next = lines[row + 1] ?? "";
  const joined = line + (/\S$/.test(line) && /^\S/.test(next) ? next.match(/^\S+/)![0] : "");
  const url = hit(URL_RE, joined);
  if (url) return { url: url[0] };
  const token = hit(FILE_TOKEN, line);
  if (token) return { file: token[1]! };
  for (const f of ctx.files) {
    for (let k = line.indexOf(f); k >= 0; k = line.indexOf(f, k + 1)) if (k <= at && at < k + f.length) return { file: f };
  }
  const word = hit(/@?[a-z0-9][a-z0-9._-]*/giu, line);
  if (word) {
    const name = word[0].replace(/^@/, "").replace(/[._-]+$/, "");
    if (name !== ctx.me && ctx.isMember(name)) return { name };
  }
  return;
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
          // not even one character fits: on a fresh line take one anyway (a wide glyph in a
          // one-column room, or a hang as wide as the room), or this loops until memory runs out
          if (used <= terminalWidth(hang) || current.length === 0) {
            const g = rest.shift()!;
            take.push(g);
            taken += terminalWidth(g);
          }
          else {
            flush();
            continue;
          }
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
    // a character wider than the room still goes on a line of its own, or rest never shrinks
    if (take.length === 0 && rest.length > 0) take.push(rest.shift()!);
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
