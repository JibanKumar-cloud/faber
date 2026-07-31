import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { StatusLine, formatElapsed } from "../src/status.js";

test("status: elapsed formatting", () => {
  assert.equal(formatElapsed(14_000), "14s");
  assert.equal(formatElapsed(89_000), "89s");
  assert.equal(formatElapsed(154_000), "2m 34s");
});

test("status: ticks while running, suspends during streaming, prints final elapsed", async () => {
  const chunks: string[] = [];
  const out = new PassThrough() as any;
  out.write = (s: string) => { chunks.push(s); return true; };
  const st = new StatusLine(out, true);
  st.start();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(chunks.some((c) => c.includes("Working…")), "heartbeat rendered");
  st.suspend();
  const before = chunks.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!chunks.slice(before).some((c) => c.includes("Working…")), "no redraw while streaming");
  st.resume();
  st.stop();
  assert.ok(chunks.at(-1)!.includes("Worked for"), "final summary printed");
});

test("status: disabled (non-TTY) writes nothing", async () => {
  const chunks: string[] = [];
  const out = new PassThrough() as any;
  out.write = (s: string) => { chunks.push(s); return true; };
  const st = new StatusLine(out, false);
  st.start();
  await new Promise((r) => setTimeout(r, 350));
  st.stop();
  assert.equal(chunks.length, 0);
});
