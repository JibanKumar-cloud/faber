/** Composer tests: chip rendering, expansion on submit, atomic backspace. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Composer } from "../src/editor.js";

function harness() {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  const outChunks: string[] = [];
  const stdout = new PassThrough() as any;
  stdout.isTTY = true;
  stdout.columns = 60;
  stdout.write = (s: string) => { outChunks.push(s); return true; };
  const c = new Composer(stdin, stdout);
  c.start();
  return { c, stdin, screen: () => outChunks.join("") };
}
const tick = () => new Promise((r) => setImmediate(r));

test("composer: paste renders as a chip, submits the FULL text", async () => {
  const { c, stdin, screen } = harness();
  const p = c.readLine("cw> ");
  stdin.write("explain this: ");
  const code = Array.from({ length: 35 }, (_, i) => `line ${i}`).join("\n");
  stdin.write(`\x1b[200~${code}\x1b[201~`);
  stdin.write(" please\r");
  const line = await p;
  // the submitted message contains everything...
  assert.equal(line, `explain this: ${code} please`);
  // ...but the SCREEN only ever showed the chip, never the code
  assert.match(screen(), /\[pasted #1 \+35 lines — paste again to expand\]/);
  assert.ok(!screen().includes("line 17"), "pasted body must not be echoed");
  assert.ok(!screen().includes("\x1b[200~"), "markers must not leak to screen");
  c.stop();
});

test("composer: multi-paste + typing composes; small single-line paste inlines", async () => {
  const { c, stdin, screen } = harness();
  const p = c.readLine("cw> ");
  stdin.write("\x1b[200~a\nb\x1b[201~");
  stdin.write(" and ");
  stdin.write("\x1b[200~tiny\x1b[201~");        // 1 line, short -> inlined, no chip
  stdin.write("\r");
  const line = await p;
  assert.equal(line, "a\nb and tiny");
  assert.match(screen(), /\[pasted #1 \+2 lines — paste again to expand\]/);
  assert.ok(!screen().includes("#2"), "single-line paste should not create a chip");
  c.stop();
});

test("composer: backspace deletes a paste chip atomically", async () => {
  const { c, stdin } = harness();
  const p = c.readLine("cw> ");
  stdin.write("keep ");
  stdin.write("\x1b[200~x\ny\x1b[201~");
  stdin.write("\x7f");                           // one backspace kills the whole chip
  stdin.write("this\r");
  assert.equal(await p, "keep this");
  c.stop();
});

test("composer: paste split across chunks; steer mode fires callback with full text", async () => {
  const { c, stdin } = harness();
  const steered: string[] = [];
  c.enterSteerMode((t) => steered.push(t));
  stdin.write("\x1b[");                          // marker fragmented across writes
  stdin.write("200~long\npaste");
  stdin.write("\x1b[201~");
  stdin.write(" fix this\r");
  await tick();
  assert.deepEqual(steered, ["long\npaste fix this"]);
  c.exitSteerMode();
  c.stop();
});

test("composer: Ctrl-C on empty prompt exits (null); with input clears it", async () => {
  const { c, stdin } = harness();
  const p1 = c.readLine("cw> ");
  stdin.write("half-typed");
  stdin.write("\x03");                           // clears, does not exit
  stdin.write("done\r");
  assert.equal(await p1, "done");
  const p2 = c.readLine("cw> ");
  stdin.write("\x03");                           // empty -> exit signal
  assert.equal(await p2, null);
  c.stop();
});

test("composer: pasting the same block again expands the chip (content once)", async () => {
  const { c, stdin, screen } = harness();
  const p = c.readLine("cw> ");
  const code = "def f():\n    return 1";
  stdin.write(`\x1b[200~${code}\x1b[201~`);       // chip (with expand hint, first chip)
  stdin.write(`\x1b[200~${code}\x1b[201~`);       // same again -> expands
  stdin.write("\r");
  const line = await p;
  assert.equal(line, code);                        // submitted exactly once
  assert.match(screen(), /paste again to expand/); // hint on first chip
  assert.match(screen(), /def f\(\):/);            // body visible after expand
  c.stop();
});

// ═══════════════════════════════════════════ editor v2: cursor editing
test("editor: mid-line editing — arrows, insert, home/end, forward delete", async () => {
  const { c, stdin } = harness();
  const p = c.readLine("cw> ");
  stdin.write("helo world");
  stdin.write("\x1b[D".repeat(8));                 // left x8 -> between 'l' and 'o' of helo
  stdin.write("l");                                 // fix typo: hello
  stdin.write("\x1b[F");                            // End
  stdin.write("!");
  stdin.write("\x01");                              // Ctrl-A home
  stdin.write("\x1b[3~\x1b[3~");                    // forward-delete 'he'
  stdin.write("He");
  stdin.write("\r");
  assert.equal(await p, "Hello world!");
  c.stop();
});

test("editor: long input wraps multi-row; full draft visible; edit at start works", async () => {
  const { c, stdin, screen } = harness();          // columns = 60
  const p = c.readLine("cw> ");
  const path = "/Users/jibankumarshial/Documents/Projects/ai_intelligent_code_engine_vscode/backend/src/agents/base.py";
  stdin.write("explain " + path);                   // ~110 cells -> wraps to 2+ rows
  stdin.write("\x01");                              // home (crosses the wrap upward)
  stdin.write("\x1b[3~".repeat(8));                 // delete "explain "
  stdin.write("read ");
  stdin.write("\r");
  assert.equal(await p, "read " + path);
  assert.ok(screen().includes(path), "full draft rendered, not windowed");
  assert.match(screen(), /\x1b\[1A/);               // cursor moved UP across a wrap row
  assert.doesNotMatch(screen(), /…/);               // no ellipsis window anymore
  c.stop();
});

test("editor: backspace travels backward across a wrap boundary (the stuck bug)", async () => {
  const { c, stdin } = harness();                   // columns = 60
  const p = c.readLine("cw> ");
  const long = "x".repeat(70);                       // prompt(4)+70 -> 2 rows
  stdin.write(long);
  stdin.write("\x7f".repeat(20));                   // backspace across the row boundary
  stdin.write("done\r");
  assert.equal(await p, "x".repeat(50) + "done");   // buffer exact — nothing stuck
  c.stop();
});

test("editor: chip is atomic under cursor — one arrow step, one backspace", async () => {
  const { c, stdin } = harness();
  const p = c.readLine("cw> ");
  stdin.write("a ");
  stdin.write("\x1b[200~x\ny\x1b[201~");            // chip
  stdin.write(" b");
  stdin.write("\x1b[D\x1b[D\x1b[D");                // left over ' ', 'b'... wait: b,space,chip -> cursor before chip
  stdin.write("\x1b[C");                            // right: jumps over whole chip in one step
  stdin.write("!");                                 // insert right after chip
  stdin.write("\r");
  assert.equal(await p, "a x\ny! b");
  // backspace kills whole chip in one keypress
  const p2 = c.readLine("cw> ");
  stdin.write("\x1b[200~m\nn\x1b[201~");
  stdin.write("\x7f");
  stdin.write("ok\r");
  assert.equal(await p2, "ok");
  c.stop();
});

test("editor: up/down history recall, edit recalled line, draft restored", async () => {
  const { c, stdin } = harness();
  const p1 = c.readLine("cw> "); stdin.write("first task\r"); await p1;
  const p2 = c.readLine("cw> "); stdin.write("second task\r"); await p2;
  const p3 = c.readLine("cw> ");
  stdin.write("dra");                               // start a draft
  stdin.write("\x1b[A");                            // up -> "second task"
  stdin.write("\x1b[A");                            // up -> "first task"
  stdin.write("\x1b[B");                            // down -> "second task"
  stdin.write("\x1b[B");                            // down past newest -> draft restored
  stdin.write("ft\r");
  assert.equal(await p3, "draft");
  const p4 = c.readLine("cw> ");
  stdin.write("\x1b[A");                            // recall latest ("draft")
  stdin.write(" edited\r");
  assert.equal(await p4, "draft edited");
  c.stop();
});
