/**
 * End-to-end integration test: a mock Anthropic SSE server drives the REAL
 * agent loop — streaming parse, tool dispatch, file edit, session log, and
 * the doom-loop breaker — entirely offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Agent } from "../src/agent.js";
import { FatalError } from "../src/errors.js";
import type { Config } from "../src/config.js";

type Turn = { text?: string; tool?: { name: string; input: object } };

/** Minimal Anthropic /v1/messages SSE mock: serves scripted turns in order. */
function mockServer(turns: Turn[]): Promise<{ url: string; close: () => void; calls: () => number; bodies: () => any[] }> {
  let call = 0;
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { bodies.push(JSON.parse(body)); } catch { bodies.push(null); }
      const turn = turns[Math.min(call, turns.length - 1)]!;
      call++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } });
      if (turn.text) {
        send({ type: "content_block_start", index: 0, content_block: { type: "text" } });
        // split text into chunks to exercise streaming assembly
        for (const piece of turn.text.match(/.{1,7}/gs) ?? []) {
          send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
        }
        send({ type: "content_block_stop", index: 0 });
      }
      if (turn.tool) {
        send({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `t${call}`, name: turn.tool.name } });
        const json = JSON.stringify(turn.tool.input);
        for (const piece of json.match(/.{1,9}/gs) ?? []) {
          send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: piece } });
        }
        send({ type: "content_block_stop", index: 1 });
        send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } });
      } else {
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close(), calls: () => call, bodies: () => bodies });
    });
  });
}

function tmpConfig(baseUrl: string): Config {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "faber-e2e-"));
  const stateDir = path.join(ws, ".codewright");
  fs.mkdirSync(path.join(stateDir, "checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
  return {
    workspace: ws, stateDir, provider: "anthropic", model: "mock", baseUrl,
    apiKey: "test-key", maxTokens: 100, maxIterations: 10, contextTokenBudget: 60_000,
    keepRecentMessages: 12, shellTimeoutMs: 10_000, maxFileReadBytes: 200_000,
    retryMaxAttempts: 2, approvalMode: "auto", weakModel: undefined,
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

test("e2e: streamed multi-turn task edits a file, verifies, persists session", async () => {
  const srv = await mockServer([
    { tool: { name: "write_file", input: { path: "hello.txt", content: "hello world\n" } } },
    { tool: { name: "read_file", input: { path: "hello.txt" } } },
    { text: "Done: created hello.txt and verified its contents." },
  ]);
  const cfg = tmpConfig(srv.url);
  const streamed: string[] = [];
  const toolResults: string[] = [];
  let usage: any = null;
  const agent = new Agent(cfg, async () => true, {
    onTextDelta: (d) => streamed.push(d),
    onToolResult: (s) => toolResults.push(s),
    onUsage: (u) => (usage = u),
  });
  const answer = await agent.runTask("create hello.txt");
  srv.close();

  assert.match(answer, /Done: created hello.txt/);
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "hello.txt"), "utf8"), "hello world\n");
  assert.equal(srv.calls(), 3);
  // streaming actually chunked (server split into 7-char pieces)
  assert.ok(streamed.length > 3);
  assert.equal(streamed.join(""), "Done: created hello.txt and verified its contents.");
  // session persisted: user task + 3 assistant turns + 2 tool-result messages
  const sessions = fs.readdirSync(cfg.sessionsDir);
  assert.equal(sessions.length, 1);
  const lines = fs.readFileSync(path.join(cfg.sessionsDir, sessions[0]!), "utf8")
    .split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 6);
  // ⎿ result summaries emitted for successful tool calls
  assert.ok(toolResults.length >= 2, "tool result lines fired");
  assert.ok(toolResults.some((s) => s.includes("Wrote")), JSON.stringify(toolResults));
  // usage accumulated across the 3 API calls (100+40+10 in, 25 out each)
  assert.equal(usage.calls, 3);
  assert.equal(usage.input, 300);
  assert.equal(usage.cacheRead, 120);
  assert.equal(usage.output, 75);
  // undo reverts the created file
  assert.deepEqual(agent.checkpoints.undoLast(), ["hello.txt"]);
  assert.equal(fs.existsSync(path.join(cfg.workspace, "hello.txt")), false);
  agent.close();
});

test("e2e: doom-loop breaker aborts after 3 identical failing calls", async () => {
  // model stubbornly repeats the same bad call forever
  const srv = await mockServer([
    { tool: { name: "read_file", input: { path: "does-not-exist.txt" } } },
  ]);
  const cfg = tmpConfig(srv.url);
  const agent = new Agent(cfg, async () => true);
  await assert.rejects(agent.runTask("read the file"), (e: Error) => {
    assert.ok(e instanceof FatalError);
    assert.match(e.message, /failed 3 times/);
    return true;
  });
  srv.close();
  assert.equal(srv.calls(), 3); // stopped at 3, not maxIterations(10)
  agent.close();
});

test("e2e: rejected approval surfaces REJECTED to the model, file untouched", async () => {
  const srv = await mockServer([
    { tool: { name: "write_file", input: { path: "danger.txt", content: "x" } } },
    { text: "Understood, I will not make that change." },
  ]);
  const cfg = tmpConfig(srv.url);
  cfg.approvalMode = "ask";
  const agent = new Agent(cfg, async () => false); // user rejects everything
  const answer = await agent.runTask("write danger.txt");
  srv.close();
  assert.match(answer, /will not make that change/);
  assert.equal(fs.existsSync(path.join(cfg.workspace, "danger.txt")), false);
  agent.close();
});

test("e2e: CLI one-shot keeps the FIRST word of the task (regression: wsIdx=-1 bug)", async () => {
  // The mock model echoes proof it received the full task via a text turn.
  const srv = await mockServer([
    { text: "ONE-SHOT-OK" },
  ]);
  const cfg = tmpConfig(srv.url);
  const { spawn } = await import("node:child_process");
  // fileURLToPath, NOT .pathname: on Windows a file URL's pathname is
  // "/D:/a/faber/..." — the leading slash makes Node treat it as relative and
  // resolve it to "C:\D:\a\faber\...", which then doesn't exist.
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
  // async spawn (NOT execFileSync): the mock server runs in this process, so
  // a synchronous wait would block the event loop and deadlock the server.
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("node", [cli, "hello", "world"], {
      cwd: cfg.workspace,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
        CW_BASE_URL: srv.url,
        CW_APPROVAL: "auto",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.stderr.on("data", (c) => (buf += c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out:\n" + buf)); }, 30_000);
    child.on("close", () => { clearTimeout(timer); resolve(buf); });
  });
  srv.close();
  assert.match(out, /ONE-SHOT-OK/);                       // one-shot path ran
  assert.doesNotMatch(out, /Type a task, or \/help/);     // REPL did NOT open
  assert.equal(srv.calls(), 1);                           // task reached the model
});

// ═══════════════════════════════════════════════════ steering (mid-task input)
test("e2e steering: typed guidance lands in the NEXT request, roles stay valid", async () => {
  const srv = await mockServer([
    { tool: { name: "list_dir", input: {} } },      // iteration 1: agent looks around
    { tool: { name: "list_dir", input: { depth: 1 } } },
    { text: "Done, following your steering." },
  ]);
  const cfg = tmpConfig(srv.url);
  const agent = new Agent(cfg, async () => true, {
    // simulate the user typing while the FIRST tool is executing
    onTool: () => { if (srv.calls() === 1) agent.steer("use TypeScript, not JavaScript"); },
  });
  const answer = await agent.runTask("scaffold the project");
  srv.close();
  assert.match(answer, /following your steering/);

  const bodies = srv.bodies();
  // request 1 predates the typed guidance: no steering CONTENT, and no
  // steering block among its messages (the nonce contract line legitimately
  // lives in every system prompt, so don't match on the marker phrase).
  assert.doesNotMatch(JSON.stringify(bodies[0].messages), /use TypeScript, not JavaScript/);
  assert.doesNotMatch(JSON.stringify(bodies[0].messages), /USER STEERING/);
  const req2 = JSON.stringify(bodies[1]);
  assert.match(req2, /USER STEERING [a-z0-9]{6} /);      // nonce present in marker
  assert.match(req2, /use TypeScript, not JavaScript/);
  // the SAME nonce is announced in the system prompt (authentication contract)
  const nonce = /USER STEERING ([a-z0-9]{6}) /.exec(req2)?.[1] ?? "";
  assert.ok(JSON.stringify(bodies[1].system).includes(nonce));
  // steering must ride INSIDE the tool_results user message (alternation-safe):
  const lastMsg = bodies[1].messages.at(-1);
  assert.equal(lastMsg.role, "user");
  assert.equal(lastMsg.content[0].type, "tool_result");
  assert.equal(lastMsg.content.at(-1).type, "text");
  // every request's messages must strictly alternate user/assistant
  for (const b of bodies) {
    const roles = b.messages.map((m: any) => m.role);
    assert.equal(roles[0], "user");
    for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1],
      `roles must alternate, got ${roles.join(",")}`);
  }
  agent.close();
});

test("e2e steering: if the model finishes while guidance is queued, the task continues", async () => {
  const srv = await mockServer([
    { text: "All done!" },                          // model tries to finish...
    { text: "Handled the extra request too." },     // ...but steering forces one more turn
  ]);
  const cfg = tmpConfig(srv.url);
  const agent = new Agent(cfg, async () => true);
  agent.steer("also add a license header");         // queued before the model 'finishes'
  const answer = await agent.runTask("do the thing");
  srv.close();
  assert.equal(srv.calls(), 2);                     // did NOT stop at turn 1
  assert.match(answer, /Handled the extra request/);
  const req2 = JSON.stringify(srv.bodies()[1]);
  assert.match(req2, /also add a license header/);
  agent.close();
});

// ═══════════════════════════════════════════════════ cancellation mid-stream
test("e2e cancel: abort mid-stream raises CancelledError; checkpoints survive for /undo", async () => {
  // a mock that streams one delta then stalls forever — until aborted
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n');
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"thinking"}}\n\n');
    // ...never ends; the client must abort
  });
  const url = await new Promise<string>((r) =>
    server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`)));
  const cfg = tmpConfig(url);
  const controller = new AbortController();
  const agent = new Agent(cfg, async () => true, {
    onTextDelta: () => controller.abort(),          // cancel the moment text arrives
  });
  const { CancelledError } = await import("../src/errors.js");
  await assert.rejects(agent.runTask("long task", controller.signal), CancelledError);
  server.close();
  agent.close();
});

// ═══════════════════════════════════ token economy: brevity + weak model
test("e2e: brevity block in system prompt by default; removed in /verbose; code-quality exception present", async () => {
  const srv = await mockServer([{ text: "ok" }, { text: "ok" }]);
  const cfg = tmpConfig(srv.url);
  const agent = new Agent(cfg, async () => true);
  await agent.runTask("first");
  agent.verbose = true;
  await agent.runTask("second");
  srv.close();
  const sys1 = JSON.stringify(srv.bodies()[0].system);
  const sys2 = JSON.stringify(srv.bodies()[1].system);
  assert.match(sys1, /Output discipline/);
  assert.match(sys1, /under 10 words/);                       // CoD-style inter-tool notes
  assert.match(sys1, /brevity applies to PROSE ONLY/);        // the #5535 vaccine
  assert.match(sys1, /NEVER line-by-line restatement/);        // detail = insight, not padding
  assert.match(sys1, /REUSE what is in context instead of re-reading/); // token-awareness nudge
  assert.match(sys1, /NO emojis unless the user uses them first/);
  assert.match(sys1, /Never truncate, elide, or simplify CODE/);
  assert.doesNotMatch(sys2, /Output discipline/);             // verbose removes it
  agent.close();
});

test("e2e: internal summarization routes to CW_WEAK_MODEL", async () => {
  const srv = await mockServer([{ text: "tiny summary" }]);
  const cfg = tmpConfig(srv.url);
  cfg.weakModel = "cheap-model-x";
  const agent = new Agent(cfg, async () => true);
  await agent.llm.summarize("long transcript here", "summarize");
  srv.close();
  assert.equal(srv.bodies()[0].model, "cheap-model-x");       // not the main model
  agent.close();
});
