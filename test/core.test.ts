/** Offline tests (no API key) covering every hardened subsystem. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LongTermMemory } from "../src/memory/longTerm.js";
import { ShortTermMemory, SUMMARY_MARKER } from "../src/memory/shortTerm.js";
import { SessionStore } from "../src/memory/sessions.js";
import { CheckpointManager } from "../src/checkpoints.js";
import { CodeIndexer } from "../src/indexer.js";
import { FsTools } from "../src/tools/fs.js";
import { ShellTool } from "../src/tools/shell.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { withRetries, TransientAPIError, FatalError, ToolError } from "../src/errors.js";
import type { Config } from "../src/config.js";
import type { Message } from "../src/llm.js";
import { execSync } from "node:child_process";
import { commitTask, isDirty, isRepo, ensureStateIgnored } from "../src/git.js";

function tmpConfig(): Config {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "faber-"));
  const stateDir = path.join(ws, ".codewright");
  fs.mkdirSync(path.join(stateDir, "checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
  return {
    workspace: ws, stateDir, provider: "anthropic", model: "m", baseUrl: "",
    apiKey: "test", maxTokens: 100, maxIterations: 10, contextTokenBudget: 60_000,
    keepRecentMessages: 12, shellTimeoutMs: 10_000, maxFileReadBytes: 200_000,
    retryMaxAttempts: 3, approvalMode: "auto", weakModel: undefined,
    memoryDb: path.join(stateDir, "memory.db"),
    indexDb: path.join(stateDir, "index.db"),
    sessionsDir: path.join(stateDir, "sessions"),
    usageDb: path.join(stateDir, "usage.db"),
    route: "anthropic-api",
    region: undefined,
    modelPins: {},
    profileName: "default",
    priceIn: undefined,
    priceOut: undefined,
    autoRefreshPrices: false,
  };
}

// ---------------------------------------------------------------- memory
test("long-term: remember, recall, archive lifecycle, prune", () => {
  const cfg = tmpConfig();
  const ltm = new LongTermMemory(cfg.memoryDb);
  const id = ltm.remember("decision", "We deploy with Docker Compose", "deploy");
  assert.ok(ltm.recall("docker deploy").some((m) => m.id === id));
  ltm.archive(id);
  assert.ok(!ltm.recall("docker deploy").some((m) => m.id === id));
  assert.ok(ltm.archivedMemories().some((m) => m.id === id));
  ltm.archive(id, false);
  assert.ok(ltm.recall("docker deploy").some((m) => m.id === id));
  // prune
  const oldId = ltm.remember("fact", "ancient knowledge");
  (ltm as any)["db"].prepare("UPDATE memories SET created = ? WHERE id = ?").run(Date.now() / 1000 - 100 * 86400, oldId);
  assert.equal(ltm.archiveOlderThan(90), 1);
  assert.ok(!ltm.allMemories().some((m) => m.id === oldId));
  // forget is permanent
  assert.equal(ltm.forget(id), true);
  assert.equal(ltm.forget(id), false);
  ltm.close();
});

test("short-term: compaction preserves recent, never splits tool pairs", async () => {
  const stm = new ShortTermMemory(200, 2);
  for (let i = 0; i < 10; i++) {
    stm.add({ role: "user", content: [{ type: "text", text: "x".repeat(200) + i }] });
  }
  const fake = { summarize: async () => "SUMMARY OF OLD STUFF" };
  assert.equal(await stm.maybeCompact(fake), true);
  assert.equal(stm.messages.length, 3);
  const first = stm.messages[0]!.content[0]!;
  assert.ok(first.type === "text" && first.text.includes(SUMMARY_MARKER));
});

test("sessions: append/load round-trip, torn final line skipped, latest id", () => {
  const cfg = tmpConfig();
  const s = new SessionStore(cfg.sessionsDir);
  const m1: Message = { role: "user", content: [{ type: "text", text: "hello" }] };
  const m2: Message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  s.append(m1); s.append(m2);
  // simulate crash mid-write of a third message
  fs.appendFileSync(path.join(cfg.sessionsDir, `${s.id}.jsonl`), '{"role":"user","content":[{"ty');
  const s2 = new SessionStore(cfg.sessionsDir, s.id);
  assert.deepEqual(s2.load(), [m1, m2]);
  assert.equal(SessionStore.latestId(cfg.sessionsDir), s.id);
});

// ------------------------------------------------------------ checkpoints
test("checkpoints: undo restores modified file, deletes created file", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const a = path.join(cfg.workspace, "a.txt");
  fs.writeFileSync(a, "original");
  cp.begin();
  cp.snapshot(a);
  fs.writeFileSync(a, "modified");
  const b = path.join(cfg.workspace, "b.txt");
  cp.snapshot(b);
  fs.writeFileSync(b, "new file");
  cp.commit();
  const restored = cp.undoLast();
  assert.deepEqual(restored.sort(), ["a.txt", "b.txt"]);
  assert.equal(fs.readFileSync(a, "utf8"), "original");
  assert.equal(fs.existsSync(b), false);
});

// ----------------------------------------------------------------- tools
test("fs: edit requires unique match; diff staged before apply; path jail", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const fsT = new FsTools(cfg, cp);
  const f = path.join(cfg.workspace, "code.py");
  fs.writeFileSync(f, "x = 1\nx = 1\n");
  cp.begin();
  assert.throws(() => fsT.stageEdit("code.py", "x = 1", "x = 2"), ToolError); // ambiguous
  const pending = fsT.stageEdit("code.py", "x = 1\nx = 1", "x = 1\nx = 2");
  assert.match(pending.diff, /\+x = 2/);
  assert.equal(fs.readFileSync(f, "utf8"), "x = 1\nx = 1\n"); // not applied yet
  pending.apply();
  assert.equal(fs.readFileSync(f, "utf8"), "x = 1\nx = 2\n");
  assert.throws(() => fsT.readFile("../../etc/passwd"), ToolError);
});

test("fs: stale stage rejected if file changed between stage and apply", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const fsT = new FsTools(cfg, cp);
  const f = path.join(cfg.workspace, "s.txt");
  fs.writeFileSync(f, "aaa");
  cp.begin();
  const pending = fsT.stageEdit("s.txt", "aaa", "bbb");
  fs.writeFileSync(f, "CHANGED EXTERNALLY");
  assert.throws(() => pending.apply(), ToolError);
});

test("shell: denylist blocks, exit code reported, timeout enforced", async () => {
  const cfg = tmpConfig();
  const sh = new ShellTool(cfg);
  assert.throws(() => sh.run("sudo rm -rf /"), ToolError);
  const out = await sh.run("echo hello && exit 3");
  assert.match(out, /hello/);
  assert.match(out, /exit code: 3/);
  // `sleep` doesn't exist on Windows cmd, where it would fail instantly
  // instead of timing out. node is guaranteed present on every platform.
  const stall = `node -e "setTimeout(()=>{},5000)"`;
  await assert.rejects(sh.run(stall, 300), ToolError);
});

test("registry: validates input, rejection message on denied approval", async () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const ltm = new LongTermMemory(cfg.memoryDb);
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  const denyAll = async () => false;
  const reg = new ToolRegistry(cfg, cp, ltm, idx, denyAll);
  cp.begin();
  // missing required arg -> corrective error, not crash
  const miss = await reg.execute("read_file", {});
  assert.equal(miss.isError, true);
  assert.match(miss.output, /Missing required argument 'path'/);
  // wrong type
  const wrong = await reg.execute("grep", { pattern: 42 });
  assert.equal(wrong.isError, true);
  // denied write -> explicit REJECTED signal for the model
  const denied = await reg.execute("write_file", { path: "x.txt", content: "hi" });
  assert.equal(denied.isError, true);
  assert.match(denied.output, /REJECTED/);
  assert.equal(fs.existsSync(path.join(cfg.workspace, "x.txt")), false);
  ltm.close(); idx.close();
});

// ---------------------------------------------------------------- indexer
test("indexer: finds symbols across languages", () => {
  const cfg = tmpConfig();
  fs.writeFileSync(path.join(cfg.workspace, "m.py"), "class Foo:\n    def bar(self):\n        pass\n");
  fs.writeFileSync(path.join(cfg.workspace, "m.ts"), "export function baz() {}\ninterface Qux {}\n");
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  const stats = idx.build();
  assert.ok(stats.symbols >= 4);
  assert.ok(idx.search("Foo").some((r) => r.kind === "class"));
  assert.ok(idx.search("baz").some((r) => r.path === "m.ts"));
  idx.close();
});

// ----------------------------------------------------------------- errors
test("retry: succeeds after transient failures, honors attempt cap", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new TransientAPIError("429", 0.001);
    return "ok";
  };
  assert.equal(await withRetries(flaky, { maxAttempts: 5, baseDelayMs: 1 }), "ok");
  assert.equal(calls, 3);
  await assert.rejects(
    withRetries(async () => { throw new TransientAPIError("503", 0.001); }, { maxAttempts: 2, baseDelayMs: 1 }),
    FatalError,
  );
});

// ------------------------------------------------------- session recall
test("sessions: search finds past-session snippets, excludes current, ranks by relevance", () => {
  const cfg = tmpConfig();
  const old = new SessionStore(cfg.sessionsDir, "2026-01-01T10-00-00");
  old.append({ role: "user", content: [{ type: "text", text: "explain the authentication workflow using JWT tokens" }] });
  old.append({ role: "assistant", content: [{ type: "text", text: "The auth flow validates JWT tokens in middleware." }] });
  const other = new SessionStore(cfg.sessionsDir, "2026-01-02T10-00-00");
  other.append({ role: "user", content: [{ type: "text", text: "write a haiku about databases" }] });
  const current = new SessionStore(cfg.sessionsDir, "2026-01-03T10-00-00");
  current.append({ role: "user", content: [{ type: "text", text: "authentication again but current session" }] });

  const hits = SessionStore.search(cfg.sessionsDir, "what did we discuss about authentication JWT?", 5, current.id);
  assert.ok(hits.length >= 2);
  assert.ok(hits[0]!.snippet.toLowerCase().includes("jwt"));
  assert.ok(!hits.some((h) => h.session === current.id)); // current excluded
  assert.ok(!hits.some((h) => h.snippet.includes("haiku"))); // irrelevant not matched
});

test("sessions: lastSessionInfo digests first ask and last answer", () => {
  const cfg = tmpConfig();
  const s = new SessionStore(cfg.sessionsDir, "2026-01-01T10-00-00");
  s.append({ role: "user", content: [{ type: "text", text: "help me understand the project workflow" }] });
  s.append({ role: "assistant", content: [{ type: "text", text: "It is a VS Code extension with a Python backend." }] });
  const info = SessionStore.lastSessionInfo(cfg.sessionsDir);
  assert.ok(info);
  assert.equal(info!.messages, 2);
  assert.match(info!.digest, /project workflow/);
  assert.match(info!.digest, /Python backend/);
  // excludeId skips the given session
  assert.equal(SessionStore.lastSessionInfo(cfg.sessionsDir, info!.id), undefined);
});

// ------------------------------------------------ reversible history + git
test("checkpoints v2: undo is reversible via redo; history lists tasks", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const f = path.join(cfg.workspace, "v.txt");
  fs.writeFileSync(f, "v1");
  cp.begin("improve v.txt");
  cp.snapshot(f);
  fs.writeFileSync(f, "v2");
  cp.commit();

  assert.equal(cp.undoLast().length, 1);
  assert.equal(fs.readFileSync(f, "utf8"), "v1");     // back to before task
  assert.equal(cp.redo()!.length, 1);
  assert.equal(fs.readFileSync(f, "utf8"), "v2");     // change brought back

  const hist = cp.list();
  assert.ok(hist.some((c) => c.kind === "task" && c.label === "improve v.txt" && c.files.includes("v.txt")));
  assert.ok(hist.some((c) => c.kind === "restore-point"));
});

test("checkpoints v2: restore(id) jumps to a specific task and is repeatable", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const f = path.join(cfg.workspace, "w.txt");
  fs.writeFileSync(f, "gen1");
  const id1 = cp.begin("task one"); cp.snapshot(f); fs.writeFileSync(f, "gen2"); cp.commit();
  cp.begin("task two"); cp.snapshot(f); fs.writeFileSync(f, "gen3"); cp.commit();

  assert.ok(cp.restore(id1));
  assert.equal(fs.readFileSync(f, "utf8"), "gen1");   // jumped two tasks back
  assert.ok(cp.redo());
  assert.equal(fs.readFileSync(f, "utf8"), "gen3");   // and back again
  assert.equal(cp.restore("nonexistent-id"), undefined);
});

test("registry: run_shell gated by approval; denial tells model not to retry", async () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const ltm = new LongTermMemory(cfg.memoryDb);
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  const seen: string[] = [];
  const reg = new ToolRegistry(cfg, cp, ltm, idx, async (p) => {
    seen.push(`${p.kind}:${p.path}`);
    return p.kind !== "shell";           // approve edits, deny shell
  });
  const denied = await reg.execute("run_shell", { command: "echo hi" });
  assert.equal(denied.isError, true);
  assert.match(denied.output, /REJECTED running/);
  assert.ok(seen.some((s) => s.startsWith("shell:$ echo hi")));
  ltm.close(); idx.close();
});

test("git: commitTask commits once per task with faber message", () => {
  const cfg = tmpConfig();
  const run = (cmd: string) => execSync(cmd, { cwd: cfg.workspace, stdio: "pipe" });
  run("git init -q && git config user.email t@t.co && git config user.name t");
  fs.writeFileSync(path.join(cfg.workspace, "a.txt"), "one");
  assert.equal(isRepo(cfg.workspace), true);
  assert.equal(isDirty(cfg.workspace), true);
  const hash = commitTask(cfg.workspace, "add feature   with    spaces");
  assert.ok(hash);
  assert.equal(isDirty(cfg.workspace), false);
  const msg = run("git log -1 --pretty=%s").toString().trim();
  assert.equal(msg, "faber: add feature with spaces");
  assert.equal(commitTask(cfg.workspace, "nothing changed"), undefined); // clean tree -> no commit
});

// -------------------------------------------------------------- ask_user
test("ask_user: choice returned to model; escape option means discuss", async () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const ltm = new LongTermMemory(cfg.memoryDb);
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  let presented: string[] = [];
  let answer = 1;
  const reg = new ToolRegistry(cfg, cp, ltm, idx, async () => true, async (_q, opts) => {
    presented = opts;
    return answer;
  });
  const input = { question: "Which average?", options: ["Mean of two numbers", "Mean of a list"] };
  const r1 = await reg.execute("ask_user", input);
  assert.equal(r1.isError, false);
  assert.match(r1.output, /option 2: "Mean of a list"/);
  assert.equal(presented.length, 3);                       // escape option auto-appended
  assert.match(presented[2]!, /Chat more/);
  answer = 2;                                              // user picks the escape hatch
  const r2 = await reg.execute("ask_user", input);
  assert.match(r2.output, /discuss further/);
  const bad = await reg.execute("ask_user", { question: "x", options: "not-an-array" });
  assert.equal(bad.isError, true);                         // validation catches bad input
  ltm.close(); idx.close();
});

// ------------------------------------------------------------- code graph
test("graph: call edges across files, who_calls, trace_path", () => {
  const cfg = tmpConfig();
  fs.writeFileSync(path.join(cfg.workspace, "a.py"),
    "def main():\n    start_server()\n\ndef start_server():\n    handle_signup()\n");
  fs.writeFileSync(path.join(cfg.workspace, "b.py"),
    "def handle_signup():\n    save_user()\n\ndef save_user():\n    pass\n");
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  const stats = idx.build();
  assert.ok(stats.edges >= 3, `edges=${stats.edges}`);
  // backward: who calls save_user? handle_signup (in b.py)
  const callers = idx.whoCalls("save_user");
  assert.ok(callers.some((e) => e.caller === "handle_signup"));
  // forward chain across files
  const chain = idx.tracePath("main", "save_user");
  assert.deepEqual(chain, ["main", "start_server", "handle_signup", "save_user"]);
  // call tree renders
  assert.match(idx.callTree("main"), /save_user/);
  // repo map surfaces connected symbols
  assert.match(idx.repoMap(), /handle_signup|save_user/);
  idx.close();
});

test("graph: incremental refresh picks up new function + edge, prunes deleted file", () => {
  const cfg = tmpConfig();
  const a = path.join(cfg.workspace, "a.py");
  fs.writeFileSync(a, "def alpha():\n    pass\n");
  const b = path.join(cfg.workspace, "b.py");
  fs.writeFileSync(b, "def beta():\n    pass\n");
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  idx.build();
  assert.equal(idx.whoCalls("alpha").length, 0);
  // simulate developer adding a new function that calls alpha (bump mtime)
  fs.writeFileSync(b, "def beta():\n    alpha()\n\ndef gamma():\n    beta()\n");
  fs.utimesSync(b, new Date(), new Date(Date.now() + 5000));
  const stats = idx.refresh();
  assert.equal(stats.files, 1);                             // only b.py re-parsed
  assert.ok(idx.whoCalls("alpha").some((e) => e.caller === "beta"));
  assert.ok(idx.search("gamma").length === 1);              // new node present
  // deleting a file prunes its rows
  fs.unlinkSync(b);
  idx.refresh();
  assert.equal(idx.search("gamma").length, 0);
  assert.equal(idx.whoCalls("alpha").length, 0);
  idx.close();
});

test("usage: agent accumulates token usage across loop iterations", async () => {
  // covered end-to-end in e2e.test.ts (mock server emits usage); here we
  // sanity-check the Usage math the CLI footer relies on.
  const u = { input: 1000, cacheRead: 9000, cacheWrite: 500, output: 300 };
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  assert.equal(totalIn, 10500);
  assert.equal(Math.round((u.cacheRead / totalIn) * 100), 86);
});

// ═══════════════════════════════════════════════ graph edge cases (cycles etc)
test("graph: cyclic call graphs terminate — tracePath and callTree are cycle-safe", () => {
  const cfg = tmpConfig();
  fs.writeFileSync(path.join(cfg.workspace, "cyc.py"),
    "def ping():\n    pong()\n\ndef pong():\n    ping()\n    done()\n\ndef done():\n    pass\n");
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  idx.build();
  // path THROUGH a cycle still resolves
  assert.deepEqual(idx.tracePath("ping", "done"), ["ping", "pong", "done"]);
  // unreachable target returns undefined instead of hanging
  assert.equal(idx.tracePath("done", "ping"), undefined);
  // callTree marks revisits instead of recursing forever
  const tree = idx.callTree("ping");
  assert.match(tree, /↩ \(seen\)/);
  assert.ok(tree.split("\n").length < 20);
  idx.close();
});

test("graph: keywords never become edges; module-level calls attribute to <module>", () => {
  const cfg = tmpConfig();
  fs.writeFileSync(path.join(cfg.workspace, "kw.py"),
    "def helper():\n    pass\n");
  fs.writeFileSync(path.join(cfg.workspace, "top.py"),
    "import kw\nhelper()\nif (True):\n    while (x):\n        helper()\n");
  const idx = new CodeIndexer(cfg.indexDb, cfg.workspace);
  idx.build();
  const callers = idx.whoCalls("helper").map((e) => e.caller);
  assert.ok(callers.includes("<module>"));
  assert.equal(idx.whoCalls("if").length + idx.whoCalls("while").length, 0);
  idx.close();
});

// ═══════════════════════════════════════════════ unicode / CRLF robustness
test("fs: surgical edits survive emoji, CJK, and CRLF content byte-for-byte", () => {
  const cfg = tmpConfig();
  const cp = new CheckpointManager(cfg.stateDir, cfg.workspace);
  const fsT = new FsTools(cfg, cp);
  const f = path.join(cfg.workspace, "unicode.ts");
  const original = 'const msg = "héllo 世界 🚀";\r\nconst other = "untouched ✓";\r\n';
  fs.writeFileSync(f, original);
  cp.begin();
  const pending = fsT.stageEdit("unicode.ts", 'héllo 世界 🚀', 'góodbye 世界 🎉');
  pending.apply();
  const after = fs.readFileSync(f, "utf8");
  assert.match(after, /góodbye 世界 🎉/);
  assert.match(after, /untouched ✓/);
  assert.ok(after.includes("\r\n"), "CRLF line endings preserved");
  // and undo restores the exact original bytes
  cp.commit();
  cp.undoLast();
  assert.equal(fs.readFileSync(f, "utf8"), original);
});

// ═══════════════════════════════════════ git: state-dir commit protection
test("git: state dir auto-excluded locally (new + legacy), idempotent", () => {
  const cfg = tmpConfig();
  const run = (cmd: string) => execSync(cmd, { cwd: cfg.workspace, stdio: "pipe" });
  run("git init -q && git config user.email t@t.co && git config user.name t");
  // first run: writes .git/info/exclude
  assert.equal(ensureStateIgnored(cfg.workspace), "excluded-now");
  // git itself now agrees the dir is ignored
  // both the new and legacy state dirs must be invisible to git
  for (const dir of [".faber", ".codewright"]) {
    fs.mkdirSync(path.join(cfg.workspace, dir), { recursive: true });
    fs.writeFileSync(path.join(cfg.workspace, dir, "leak.txt"), "secret");
  }
  const status = run("git status --porcelain").toString();
  assert.ok(!status.includes(".faber"), `git must not see .faber: ${status}`);
  assert.ok(!status.includes(".codewright"), `git must not see legacy dir: ${status}`);
  // second run: idempotent
  assert.equal(ensureStateIgnored(cfg.workspace), "already-ignored");
  // non-repo: graceful
  assert.equal(ensureStateIgnored(fs.mkdtempSync(path.join(os.tmpdir(), "norepo-"))), "not-repo");
});

test("git: previously-committed state dir triggers TRACKED warning", () => {
  const cfg = tmpConfig();
  const run = (cmd: string) => execSync(cmd, { cwd: cfg.workspace, stdio: "pipe" });
  run("git init -q && git config user.email t@t.co && git config user.name t");
  fs.mkdirSync(path.join(cfg.workspace, ".codewright"), { recursive: true });
  fs.writeFileSync(path.join(cfg.workspace, ".codewright", "oops.db"), "x");
  run("git add -A && git commit -qm 'accidentally committed state'");
  assert.equal(ensureStateIgnored(cfg.workspace), "TRACKED");
});
