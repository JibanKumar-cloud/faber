#!/usr/bin/env node
/**
 * Faber self-test harness.
 *
 * Run from inside the faber folder:   node selftest.mjs
 * Writes a full report to selftest-report.txt — paste that file back.
 *
 * Sections:
 *   A. Environment   (node version, faber on PATH, exec bit, API key presence)
 *   B. Offline core  (checkpoints undo/redo, session search, memory, git, approval gating)
 *   C. Live agent    (only if ANTHROPIC_API_KEY set: 4 small one-shot tasks, ~cents of usage)
 *
 * Nothing here touches your real projects: all live tests run in a fresh temp folder.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";

const report = [];
let pass = 0, fail = 0, skip = 0;
const log = (line) => { console.log(line); report.push(line); };
const ok = (name, extra = "") => { pass++; log(`PASS  ${name}${extra ? "  — " + extra : ""}`); };
const bad = (name, err) => { fail++; log(`FAIL  ${name}  — ${String(err).split("\n")[0].slice(0, 200)}`); };
const skipped = (name, why) => { skip++; log(`SKIP  ${name}  — ${why}`); };
const t = async (name, fn) => { try { const extra = await fn(); ok(name, extra || ""); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const HERE = process.cwd();
log(`Faber self-test — ${new Date().toISOString()}`);
log(`cwd: ${HERE}\n`);

// ───────────────────────────────────────────── A. Environment
log("== A. Environment ==");
await t("A1 node version >= 22.5", () => {
  const [maj, min] = process.versions.node.split(".").map(Number);
  assert(maj > 22 || (maj === 22 && min >= 5), `found ${process.versions.node}`);
  return `v${process.versions.node}`;
});
await t("A2 dist/index.js exists and is executable", () => {
  const p = path.join(HERE, "dist", "index.js");
  assert(fs.existsSync(p), "dist/index.js missing — run: npm run build");
  fs.accessSync(p, fs.constants.X_OK);
});
await t("A3 postbuild hook present in package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  assert(pkg.scripts?.postbuild?.includes("chmod"), "postbuild missing");
});
await t("A4 `faber` resolves on PATH", () => {
  const out = execSync("faber --version", { encoding: "utf8" }).trim();
  assert(out.includes("faber"), out);
  return out;
});
const hasKey = !!process.env.ANTHROPIC_API_KEY?.trim();
if (hasKey) {
  const k = process.env.ANTHROPIC_API_KEY.trim();
  ok("A5 ANTHROPIC_API_KEY set", `${k.slice(0, 10)}…${k.slice(-4)} (${k.length} chars)`);
  if (/\s/.test(k)) bad("A5b key contains whitespace", "likely a paste error");
} else {
  skipped("A5 ANTHROPIC_API_KEY", "not set — section C will be skipped");
}

// ───────────────────────────────────────────── B. Offline core
log("\n== B. Offline core (no API needed) ==");
const mods = {};
await t("B0 compiled modules import", async () => {
  mods.cp = await import(path.join(HERE, "dist", "checkpoints.js"));
  mods.sess = await import(path.join(HERE, "dist", "memory", "sessions.js"));
  mods.ltm = await import(path.join(HERE, "dist", "memory", "longTerm.js"));
  mods.git = await import(path.join(HERE, "dist", "git.js"));
});

const tmp = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "faber-selftest-"));
  const state = path.join(ws, ".codewright");
  fs.mkdirSync(path.join(state, "sessions"), { recursive: true });
  return { ws, state };
};

await t("B1 checkpoints: undo → redo round-trip", () => {
  const { ws, state } = tmp();
  const cp = new mods.cp.CheckpointManager(state, ws);
  const f = path.join(ws, "x.txt");
  fs.writeFileSync(f, "before");
  cp.begin("test task"); cp.snapshot(f); fs.writeFileSync(f, "after"); cp.commit();
  cp.undoLast();
  assert(fs.readFileSync(f, "utf8") === "before", "undo did not restore");
  cp.redo();
  assert(fs.readFileSync(f, "utf8") === "after", "redo did not re-apply");
});
await t("B2 checkpoints: /history lists task with label + files", () => {
  const { ws, state } = tmp();
  const cp = new mods.cp.CheckpointManager(state, ws);
  const f = path.join(ws, "y.txt"); fs.writeFileSync(f, "1");
  cp.begin("label me"); cp.snapshot(f); cp.commit();
  const h = cp.list();
  assert(h.some((c) => c.label === "label me" && c.files.includes("y.txt")), JSON.stringify(h));
});
await t("B3 sessions: search finds past snippets, stopwords ignored", () => {
  const { state } = tmp();
  const dir = path.join(state, "sessions");
  const s = new mods.sess.SessionStore(dir, "2026-01-01T00-00-00");
  s.append({ role: "user", content: [{ type: "text", text: "explain the JWT authentication middleware" }] });
  const hits = mods.sess.SessionStore.search(dir, "what did we say about JWT authentication?");
  assert(hits.length === 1 && hits[0].snippet.includes("JWT"), JSON.stringify(hits));
});
await t("B4 sessions: last-session digest", () => {
  const { state } = tmp();
  const dir = path.join(state, "sessions");
  const s = new mods.sess.SessionStore(dir, "2026-01-01T00-00-00");
  s.append({ role: "user", content: [{ type: "text", text: "first question" }] });
  s.append({ role: "assistant", content: [{ type: "text", text: "final answer" }] });
  const info = mods.sess.SessionStore.lastSessionInfo(dir);
  assert(info?.digest.includes("first question") && info.digest.includes("final answer"), info?.digest);
});
await t("B5 memory: remember → recall → archive excludes → unarchive", () => {
  const { state } = tmp();
  const db = new mods.ltm.LongTermMemory(path.join(state, "memory.db"));
  const id = db.remember("fact", "backend speaks GraphQL");
  assert(db.recall("GraphQL backend").some((m) => m.id === id), "recall miss");
  db.archive(id, true);
  assert(!db.recall("GraphQL backend").some((m) => m.id === id), "archived still recalled");
  db.archive(id, false);
  assert(db.recall("GraphQL backend").some((m) => m.id === id), "unarchive failed");
  db.close();
});
await t("B6 git: repo detect, dirty detect, one commit per task", () => {
  const { ws } = tmp();
  execSync("git init -q && git config user.email t@t.co && git config user.name t", { cwd: ws });
  fs.writeFileSync(path.join(ws, "a.txt"), "hi");
  assert(mods.git.isRepo(ws) && mods.git.isDirty(ws), "detect failed");
  const hash = mods.git.commitTask(ws, "test task");
  assert(hash && !mods.git.isDirty(ws), "commit failed");
  assert(mods.git.commitTask(ws, "again") === undefined, "committed on clean tree");
});

// ───────────────────────────────────────────── C. Live agent
log("\n== C. Live agent (uses your API key; 4 small tasks in a temp folder) ==");
if (!hasKey) {
  skipped("C1-C4 live agent tests", "no API key in this shell");
} else {
  const { ws } = tmp();
  fs.writeFileSync(path.join(ws, "README.md"), "# Temp test project\nA scratch folder for Faber self-tests.\n");
  const CW = path.join(HERE, "dist", "index.js");
  const run = (task, extraEnv = {}) =>
    execFileSync("node", [CW, task], {
      cwd: ws, encoding: "utf8", timeout: 180_000,
      env: { ...process.env, CW_APPROVAL: "auto", ...extraEnv },
    });

  await t("C1 read-only loop (list/read tools, sensible answer)", () => {
    const out = run("Briefly: what files are in this folder?");
    assert(/list_dir|README/i.test(out), out.slice(0, 300));
    return "used tools + answered";
  });
  await t("C2 edit loop (creates a real file)", () => {
    const out = run("Create a file named hello.txt containing exactly: hello faber");
    assert(fs.existsSync(path.join(ws, "hello.txt")), "file not created\n" + out.slice(0, 300));
    const body = fs.readFileSync(path.join(ws, "hello.txt"), "utf8");
    assert(/hello faber/i.test(body), "wrong content: " + body);
  });
  await t("C3 long-term memory persists across invocations", () => {
    run("Use your remember tool to store this fact: the secret project codename is BLUEFALCON");
    const out = run("What is the secret project codename? Answer from memory only.");
    assert(/BLUEFALCON/i.test(out), out.slice(-400));
  });
  await t("C4 session recall across invocations", () => {
    const out = run("What did I ask you to create in an earlier conversation? Search past sessions if needed.");
    assert(/hello\.txt|hello faber|recall_sessions/i.test(out), out.slice(-400));
  });
  log(`   (live-test scratch folder: ${ws})`);
}

// ───────────────────────────────────────────── report
log(`\n== Summary: ${pass} passed, ${fail} failed, ${skip} skipped ==`);
fs.writeFileSync(path.join(HERE, "selftest-report.txt"), report.join("\n") + "\n");
log(`\nReport written to selftest-report.txt.`);
process.exit(fail ? 1 : 0);
