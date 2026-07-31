import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, StreamRenderer } from "../src/markdown.js";

test("markdown: bold, headers, inline code become ANSI — raw symbols gone", () => {
  const r = renderMarkdown("## Detailed Breakdown\n**Purpose**: wraps `_execute` safely");
  assert.ok(!r.includes("##"), "header hashes stripped");
  assert.ok(!r.includes("**"), "bold stars stripped");
  assert.ok(!r.includes("`"), "backticks stripped");
  assert.ok(r.includes("\x1b[1mDetailed Breakdown\x1b[22m"));
  assert.ok(r.includes("\x1b[1mPurpose\x1b[22m"));
  assert.ok(r.includes("\x1b[36m_execute\x1b[39m"));
});

test("markdown: fenced code blocks highlighted, fence markers dropped, content intact", () => {
  const r = renderMarkdown("before\n```python\nreturn a + b\n```\nafter");
  assert.ok(!r.includes("```"));
  const plain = r.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("return a + b"), "code content survives highlighting");
  assert.match(r, /\x1b\[35mreturn\x1b\[39m/);           // keyword highlighted
  assert.ok(r.startsWith("before"));
  assert.ok(r.endsWith("after"));
});

test("markdown: rules become lines; unclosed bold left alone; plain text untouched", () => {
  assert.match(renderMarkdown("---"), /─+/);
  assert.equal(renderMarkdown("a ** b"), "a ** b");         // not a pair -> untouched
  assert.equal(renderMarkdown("plain prose stays plain"), "plain prose stays plain");
});

test("markdown: tables render with box drawing — raw pipes gone, header bold", () => {
  const r = renderMarkdown([
    "| Feature | Status |",
    "|---------|--------|",
    "| Memory  | done   |",
    "| Graph   | **done** |",
  ].join("\n"));
  assert.ok(!r.includes("|-"), "separator row consumed");
  assert.ok(r.includes("┌") && r.includes("┼") && r.includes("┘"), "box drawing present");
  assert.match(r, /\x1b\[1mFeature/);                     // header bold
  assert.ok(r.includes("Memory"), "cells intact");
  assert.match(r, /\x1b\[1mdone\x1b\[22m/);               // inline bold inside a cell
  // columns aligned: both data rows have │ at the same offsets
  const rows = r.split("\n").filter((l) => l.includes("Memory") || l.includes("Graph"));
  const cols = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].flatMap((c, i) => (c === "│" ? [i] : []));
  assert.deepEqual(cols(rows[0]!), cols(rows[1]!));
});

test("markdown: long cells truncate with ellipsis; table inside prose flushes cleanly", () => {
  const long = "x".repeat(80);
  const r = renderMarkdown(`before\n| a |\n|---|\n| ${long} |\nafter`);
  assert.ok(r.includes("…"), "long cell truncated");
  assert.ok(!r.includes(long), "raw overlong cell not emitted");
  assert.ok(r.startsWith("before") && r.trimEnd().endsWith("after"));
});

// ═══════════════════════════════════════════ full style set (v3)
test("markdown: italics, strikethrough, hyperlinks, blockquotes, bullets", () => {
  const r = renderMarkdown([
    "*emphasis* and _also_ and ~~gone~~",
    "> a wise quote",
    "- first item",
    "See [docs](https://example.com/x) here",
  ].join("\n"));
  assert.match(r, /\x1b\[3memphasis\x1b\[23m/);            // italic
  assert.match(r, /\x1b\[3malso\x1b\[23m/);
  assert.match(r, /\x1b\[9mgone\x1b\[29m/);                // strikethrough
  assert.match(r, /▌ /);                                   // blockquote bar
  assert.match(r, /•\x1b\[39m first item/);                // bullet restyle (colored dot)
  assert.ok(r.includes("\x1b]8;;https://example.com/x\x07"), "OSC 8 hyperlink");
  assert.ok(!r.includes("~~") && !r.includes("]("), "raw markers gone");
  // multiplication is not italics
  assert.equal(renderMarkdown("2 * 3 * 4"), "2 * 3 * 4");
});

test("markdown: syntax highlighting — keywords, strings, comments, numbers", () => {
  const r = renderMarkdown("```python\ndef add(a, b):  # sum\n    return a + 42\n```");
  assert.match(r, /\x1b\[35mdef\x1b\[39m/);                // keyword magenta
  assert.match(r, /\x1b\[35mreturn\x1b\[39m/);
  assert.match(r, /\x1b\[33m42\x1b\[39m/);                 // number yellow
  assert.match(r, /\x1b\[2m# sum/);                        // comment dim
  const r2 = renderMarkdown('```js\nconst s = "hi // not comment";\n```');
  assert.match(r2, /\x1b\[32m"hi \/\/ not comment"\x1b\[39m/); // string wins over comment
});

test("markdown: StreamRenderer emits rendered complete lines; state survives chunk splits", () => {
  const sr = new StreamRenderer();
  let out = "";
  out += sr.feed("## Hea");                                // partial line -> nothing yet
  assert.equal(out, "");
  out += sr.feed("der\nplain **bo");
  assert.match(out, /\x1b\[1mHeader\x1b\[22m/);            // completed line rendered
  assert.ok(!out.includes("**"), "no raw markers in emitted lines");
  out += sr.feed("ld** text\n```py\nreturn 1\n");          // bold split across feeds; fence opens
  assert.match(out, /\x1b\[1mbold\x1b\[22m/);
  assert.match(out, /\x1b\[35mreturn\x1b\[39m/);           // highlighted inside fence
  out += sr.feed("```\ntail");
  out += sr.flush();                                       // trailing partial rendered
  assert.match(out, /tail/);
  assert.ok(!out.includes("```"));
});
