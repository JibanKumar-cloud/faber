/** Composed-input tests: paste coalescing, marker splits, sentinel round-trips. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createComposedInput, restore, describeComposed, SENTINEL } from "../src/input.js";

function harness() {
  const src = new PassThrough() as unknown as NodeJS.ReadStream;
  const ci = createComposedInput(src);
  let received = "";
  ci.stream.on("data", (c) => (received += c));
  return { src: src as unknown as PassThrough, get: () => received, ci };
}
const tick = () => new Promise((r) => setImmediate(r));

test("paste: newlines inside brackets become sentinels; outside stay real", async () => {
  const { src, get } = harness();
  src.write("before\n\x1b[200~line1\nline2\r\nline3\x1b[201~ typed\n");
  await tick();
  assert.equal(get(), `before\nline1${SENTINEL}line2${SENTINEL}line3 typed\n`);
  // the whole paste + typed tail is ONE readline line; restore() rebuilds it
  const line = get().split("\n")[1]!;
  assert.equal(restore(line), "line1\nline2\nline3 typed");
});

test("paste: multiple pastes + typing compose into one submission", async () => {
  const { src, get } = harness();
  src.write("\x1b[200~const a = 1;\nconst b = 2;\x1b[201~");
  src.write(" // my comment ");
  src.write("\x1b[200~const c = 3;\x1b[201~");
  src.write("\n");                                     // only THIS submits
  await tick();
  const lines = get().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "everything composed into a single line");
  assert.equal(restore(lines[0]!), "const a = 1;\nconst b = 2; // my comment const c = 3;");
});

test("paste: markers split across chunk boundaries still parse", async () => {
  const { src, get } = harness();
  // split ESC[200~ across three writes, ESC[201~ across two
  src.write("\x1b["); src.write("200"); src.write("~a\nb");
  src.write("\x1b[20"); src.write("1~\n");
  await tick();
  assert.equal(get(), `a${SENTINEL}b\n`);
});

test("paste: 50-line paste is one submission, described compactly", async () => {
  const { src, get } = harness();
  const code = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  src.write(`\x1b[200~${code}\x1b[201~\n`);
  await tick();
  const lines = get().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(restore(lines[0]!).split("\n").length, 50);
  assert.match(describeComposed(lines[0]!), /\[pasted 50 lines\]/);
});

test("guard: data is dropped while the selector owns stdin", async () => {
  const { src, get, ci } = harness();
  ci.setGuard(true);
  src.write("3\r");                                    // selector keys — must not leak
  ci.setGuard(false);
  src.write("real input\n");
  await tick();
  assert.equal(get(), "real input\n");
});
