// What a click in a message body opens. Run: npx tsx --test test/links.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { inline, linkAt } from "../src/chat/markdown.ts";

const here = new Set(["cfo", "opendev", "misha"]);
const ctx = { files: ["image 2.png", "paid-token-deep-dive.pdf"], isMember: (n: string) => here.has(n), me: "misha" };
const col = (line: string, word: string) => line.indexOf(word) + 1;

test("links: a web address, even one that wraps onto the next line", () => {
  const lines = ["see https://github.com/yefimets/metacom/pull/new/feature/raw-sl", "ash for the diff."];
  assert.deepStrictEqual(linkAt(lines, 0, col(lines[0]!, "github"), ctx), { url: "https://github.com/yefimets/metacom/pull/new/feature/raw-slash" });
  const one = ["open https://example.com/a?b=1, then reply"];
  assert.deepStrictEqual(linkAt(one, 0, col(one[0]!, "example"), ctx), { url: "https://example.com/a?b=1" }, "trailing comma is not part of it");
  assert.strictEqual(linkAt(one, 0, col(one[0]!, "then"), ctx), undefined, "plain words are not links");
});

test("links: a [file] token, or the name of a file the message carries", () => {
  const lines = ["i don't need it at all [image 2.png]", "the paid-token-deep-dive.pdf has it"];
  assert.deepStrictEqual(linkAt(lines, 0, col(lines[0]!, "2.png"), ctx), { file: "image 2.png" });
  assert.deepStrictEqual(linkAt(lines, 1, col(lines[1]!, "deep"), ctx), { file: "paid-token-deep-dive.pdf" });
});

test("links: a person — @name or a bare name of someone here — but not me, and not any word", () => {
  const lines = ["@cfo send the wallet to opendev, misha asked; the cmo too"];
  assert.deepStrictEqual(linkAt(lines, 0, col(lines[0]!, "cfo"), ctx), { name: "cfo" });
  assert.deepStrictEqual(linkAt(lines, 0, col(lines[0]!, "opendev"), ctx), { name: "opendev" }, "a trailing comma is not part of the name");
  assert.strictEqual(linkAt(lines, 0, col(lines[0]!, "misha"), ctx), undefined, "your own name does nothing");
  assert.strictEqual(linkAt(lines, 0, col(lines[0]!, "cmo"), ctx), undefined, "nobody called cmo is here");
  assert.strictEqual(linkAt(lines, 0, col(lines[0]!, "wallet"), ctx), undefined);
});

test("links: columns count wide characters as the terminal draws them", () => {
  const lines = ["готово 👍 https://example.com"];
  // "готово " is 7 columns, the emoji 2 and its space 1: the address starts at column 10
  assert.deepStrictEqual(linkAt(lines, 0, 11, ctx), { url: "https://example.com" });
  assert.strictEqual(linkAt(lines, 0, 7, ctx), undefined, "the emoji is not a link");
});

test("links: they are drawn as links, underlined, and the text stays the same", () => {
  const spans = inline("see https://example.com and [image 2.png], @cfo", (n) => here.has(n));
  assert.deepStrictEqual(spans.filter((s) => s.tone === "link").map((s) => s.text), ["https://example.com", "[image 2.png]"]);
  assert.ok(spans.some((s) => s.tone === "mention" && s.text === "@cfo"), "mentions still light up");
  assert.strictEqual(spans.map((s) => s.text).join(""), "see https://example.com and [image 2.png], @cfo");
});
