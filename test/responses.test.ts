import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMClient, usesResponsesApi } from "../src/llm.js";
import { writePriceCache } from "../src/pricing.js";
import type { Config } from "../src/config.js";

function tmpHome(): void {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "faber-resp-"));
  process.env.HOME = d;
  process.env.USERPROFILE = d;
}

/** Serve a Responses API SSE stream, and capture what was sent. */
function server(events: unknown[]): Promise<{ url: string; close: () => void; body: () => any }> {
  let received: any;
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      received = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
    close: () => s.close(),
    body: () => received,
  })));
}

const cfg = (baseUrl: string, model: string): Config => ({
  provider: "openai", baseUrl, apiKey: "sk-test", model, route: "openai-api",
  maxTokens: 4096, retryMaxAttempts: 1,
} as unknown as Config);

test("responses: routing is decided by the dataset, not by the model's name", () => {
  tmpHome();
  writePriceCache({
    "gpt-5.3-codex": { in: 1, out: 2, mode: "responses", endpoints: ["/v1/responses"] },
    "gpt-5.5": { in: 1, out: 2, mode: "chat" },
    "o1-pro": { in: 1, out: 2, endpoints: ["/v1/responses", "/v1/batch"] },
  }, "test");

  assert.equal(usesResponsesApi("gpt-5.3-codex"), true);
  assert.equal(usesResponsesApi("o1-pro"), true, "endpoints alone are enough");
  assert.equal(usesResponsesApi("gpt-5.5"), false);
  assert.equal(usesResponsesApi("some-unlisted-model"), false,
    "an unknown model stays on chat completions rather than guessing");
});

test("responses: streams text and reports usage the ledger can bill", async () => {
  tmpHome();
  writePriceCache({ "gpt-5.3-codex": { in: 1, out: 2, mode: "responses" } }, "test");
  const srv = await server([
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.output_text.delta", delta: " world" },
    { type: "response.completed", response: { usage: {
      input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 200 },
    } } },
  ]);
  const chunks: string[] = [];
  const r = await new LLMClient(cfg(srv.url, "gpt-5.3-codex"))
    .complete("be brief", [{ role: "user", content: [{ type: "text", text: "hi" }] }], [],
      (d) => chunks.push(d));
  const sent = srv.body();
  srv.close();

  assert.equal(r.text, "Hello world");
  assert.deepEqual(chunks, ["Hello", " world"], "text streams incrementally");
  // input_tokens INCLUDES cached ones, so the cached part must be subtracted
  // or the ledger double-counts them at the full rate.
  assert.equal(r.usage.input, 1000);
  assert.equal(r.usage.cacheRead, 200);
  assert.equal(r.usage.output, 40);

  // the request uses the Responses shape, not a chat one
  assert.equal(sent.instructions, "be brief", "system prompt goes in `instructions`");
  assert.ok(Array.isArray(sent.input), "and turns go in `input`");
  assert.equal(sent.messages, undefined, "never a chat `messages` array");
  assert.equal(sent.max_output_tokens, 4096);
});

test("responses: assembles a streamed tool call from its argument deltas", async () => {
  tmpHome();
  writePriceCache({ "gpt-5.3-codex": { in: 1, out: 2, mode: "responses" } }, "test");
  const srv = await server([
    { type: "response.output_item.added",
      item: { type: "function_call", id: "item_1", call_id: "call_abc", name: "read_file" } },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"path"' },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"src/a.ts"}' },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
  const r = await new LLMClient(cfg(srv.url, "gpt-5.3-codex"))
    .complete("s", [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      [{ name: "read_file", description: "d", input_schema: { type: "object" } }]);
  const sent = srv.body();
  srv.close();

  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "read_file");
  assert.equal(r.toolCalls[0]!.id, "call_abc", "the call_id is what results are keyed by");
  assert.deepEqual(r.toolCalls[0]!.input, { path: "src/a.ts" });
  assert.equal(r.stopReason, "tool_use");

  // tool schemas are flatter here: no nested `function` object
  assert.equal(sent.tools[0].type, "function");
  assert.equal(sent.tools[0].name, "read_file");
  assert.equal(sent.tools[0].function, undefined);
});

test("responses: a tool result is sent back as a sibling item, keyed by call_id", async () => {
  tmpHome();
  writePriceCache({ "gpt-5.3-codex": { in: 1, out: 2, mode: "responses" } }, "test");
  const srv = await server([
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);
  await new LLMClient(cfg(srv.url, "gpt-5.3-codex")).complete("s", [
    { role: "user", content: [{ type: "text", text: "read it" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "call_abc", name: "read_file", input: { path: "a.ts" } }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_abc", content: "file contents" }] },
  ], []);
  const sent = srv.body();
  srv.close();

  const kinds = sent.input.map((i: any) => i.type ?? `msg:${i.role}`);
  assert.deepEqual(kinds, ["msg:user", "function_call", "function_call_output"],
    "calls and results are flat siblings, not nested in an assistant turn");
  assert.equal(sent.input[1].call_id, "call_abc");
  assert.equal(sent.input[2].call_id, "call_abc", "result is joined to the call by call_id");
  assert.equal(sent.input[2].output, "file contents");
});

test("responses: a stream error surfaces instead of returning an empty answer", async () => {
  tmpHome();
  writePriceCache({ "gpt-5.3-codex": { in: 1, out: 2, mode: "responses" } }, "test");
  const srv = await server([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "error", message: "context length exceeded" },
  ]);
  await assert.rejects(
    () => new LLMClient(cfg(srv.url, "gpt-5.3-codex"))
      .complete("s", [{ role: "user", content: [{ type: "text", text: "hi" }] }], []),
    /context length exceeded/,
  );
  srv.close();
});

test("a model the dataset doesn't know still works: retry where the API says", async () => {
  tmpHome();
  writePriceCache({}, "test");     // dataset knows nothing about this model

  let hits = 0;
  const s = http.createServer((req, res) => {
    hits++;
    if (req.url?.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: {
        message: "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.",
      } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.completed",
      response: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`);
    res.end();
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));

  const r = await new LLMClient(cfg(url, "brand-new-codex-model"))
    .complete("s", [{ role: "user", content: [{ type: "text", text: "hi" }] }], []);
  s.close();

  assert.equal(r.text, "ok", "the retry succeeded rather than surfacing a 404");
  assert.equal(hits, 2, "one failed chat attempt, then the responses endpoint");
});

test("price cache written by an older Faber is discarded, not trusted", async () => {
  const { readPriceCache, PRICE_CACHE_VERSION } = await import("../src/pricing.js");
  tmpHome();
  const f = path.join(process.env.HOME!, ".faber", "cache", "prices.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // v1 shape: prices present, but no mode/endpoints — looks complete, isn't
  fs.writeFileSync(f, JSON.stringify({
    fetchedAt: Date.now(), source: "old", prices: { "gpt-5.3-codex": { in: 1, out: 2 } },
  }));
  assert.equal(readPriceCache(), undefined,
    "a cache without the routing fields must not be used, or codex models 404");

  writePriceCache({ "gpt-5.3-codex": { in: 1, out: 2, mode: "responses" } }, "new");
  assert.equal(readPriceCache()?.version, PRICE_CACHE_VERSION);
});
