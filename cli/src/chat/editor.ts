import { splitGraphemes } from "@/lib/terminal-text";

const WORD = /[\p{L}\p{N}_@/.-]/u;

/// A multi-line text buffer with a cursor, readline-style motions and a history.
/// Pure model with no terminal access, so it is testable and framework-free.
export class Editor {
  text = "";
  cursor = 0;
  history: string[] = [];
  historySize: number;
  index = -1; // -1: editing a fresh line; otherwise browsing history[index]
  draft = "";

  constructor({ historySize = 200 } = {}) {
    this.historySize = historySize;
  }

  get lines(): string[] {
    return this.text.split("\n");
  }

  /// Zero-based row and column (in code units) of the cursor.
  get pos(): { row: number; col: number } {
    const before = this.text.slice(0, this.cursor);
    const row = (before.match(/\n/g) || []).length;
    const col = before.length - (before.lastIndexOf("\n") + 1);
    return { row, col };
  }

  set(text: string, cursor = text.length): void {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
  }

  clear(): void {
    this.set("");
    this.index = -1;
  }

  insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
  }

  prev(i = this.cursor): number {
    if (i <= 0) return 0;
    const gs = splitGraphemes(this.text.slice(0, i));
    return i - (gs[gs.length - 1]?.length ?? 1);
  }

  next(i = this.cursor): number {
    if (i >= this.text.length) return this.text.length;
    const g = splitGraphemes(this.text.slice(i))[0] ?? "";
    return i + Math.max(1, g.length);
  }

  backspace(): boolean {
    if (this.cursor === 0) return false;
    const p = this.prev();
    this.text = this.text.slice(0, p) + this.text.slice(this.cursor);
    this.cursor = p;
    return true;
  }

  delete(): boolean {
    if (this.cursor >= this.text.length) return false;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.next());
    return true;
  }

  left(): void {
    this.cursor = this.prev();
  }

  right(): void {
    this.cursor = this.next();
  }

  home(): void {
    this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  end(): void {
    const nl = this.text.indexOf("\n", this.cursor);
    this.cursor = nl === -1 ? this.text.length : nl;
  }

  /// Move a row up or down keeping the column; false when there is no such row, so the
  /// caller can fall back to history browsing.
  vertical(delta: number): boolean {
    const { row, col } = this.pos;
    const lines = this.lines;
    const target = row + delta;
    if (target < 0 || target >= lines.length) return false;
    let offset = 0;
    for (let i = 0; i < target; i++) offset += lines[i]!.length + 1;
    this.cursor = offset + Math.min(col, lines[target]!.length);
    return true;
  }

  wordLeft(): void {
    let i = this.cursor;
    while (i > 0 && !WORD.test(this.text[i - 1]!)) i--;
    while (i > 0 && WORD.test(this.text[i - 1]!)) i--;
    this.cursor = i;
  }

  wordRight(): void {
    let i = this.cursor;
    const n = this.text.length;
    while (i < n && !WORD.test(this.text[i]!)) i++;
    while (i < n && WORD.test(this.text[i]!)) i++;
    this.cursor = i;
  }

  deleteWordLeft(): void {
    const end = this.cursor;
    this.wordLeft();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  deleteWordRight(): void {
    const at = this.cursor;
    this.wordRight();
    this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
    this.cursor = at;
  }

  killToEnd(): void {
    const nl = this.text.indexOf("\n", this.cursor);
    const end = nl === -1 ? this.text.length : nl;
    if (end === this.cursor && nl !== -1) this.text = this.text.slice(0, this.cursor) + this.text.slice(end + 1);
    else this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  killToStart(): void {
    const start = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  /// The word the cursor is in or right after: `{ start, text }`, with `text` ending at the cursor.
  token(): { start: number; text: string } {
    let start = this.cursor;
    while (start > 0 && !/\s/.test(this.text[start - 1]!)) start--;
    return { start, text: this.text.slice(start, this.cursor) };
  }

  replaceToken(replacement: string): void {
    const { start } = this.token();
    this.text = this.text.slice(0, start) + replacement + this.text.slice(this.cursor);
    this.cursor = start + replacement.length;
  }

  /// Take the text out for submission and remember it.
  submit(): string {
    const text = this.text;
    if (text.trim()) {
      if (this.history[this.history.length - 1] !== text) this.history.push(text);
      if (this.history.length > this.historySize) this.history.shift();
    }
    this.clear();
    return text;
  }

  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.index === -1) {
      this.draft = this.text;
      this.index = this.history.length;
    }
    if (this.index === 0) return false;
    this.index--;
    this.set(this.history[this.index]!);
    return true;
  }

  historyNext(): boolean {
    if (this.index === -1) return false;
    this.index++;
    if (this.index >= this.history.length) {
      this.index = -1;
      this.set(this.draft);
    } else {
      this.set(this.history[this.index]!);
    }
    return true;
  }
}
