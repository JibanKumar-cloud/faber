import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { LLMClient } from "../src/llm.js";
import { getRoute } from "../src/routes.js";
import type { Config as _C } from "../src/config.js";
import type { Config } from "../src/config.js";

const cfg = (baseUrl: string): Config => ({
  provider: "openai", baseUrl, apiKey: "azure-secret", model: "my-codex-deployment",
  route: "azure-openai", maxTokens: 64, retryMaxAttempts: 1,
} as unknown as Config);

test("azure is a route, not a new wire", () => {
  const r = getRoute("azure-openai")!;
  assert.equal(r.wire, "openai", "same request format as OpenAI");
  assert.equal(r.implemented, true);
  assert.equal(r.keyEnv, "AZURE_OPENAI_API_KEY");
  assert.equal(r.needsBaseUrl, true, "the resource is per-subscription");
  assert.equal(r.aliasesArePinned, true, "you address deployments, not model ids");
});

test("azure: the key travels in api-key, and the deployment lives in the path", async () => {
  let seenPath = "", seenApiKey = "", seenAuth = "";
  const s = http.createServer((req, res) => {
    seenPath = req.url ?? "";
    seenApiKey = String(req.headers["api-key"] ?? "");
    seenAuth = String(req.headers["authorization"] ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: "hi" } }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}/openai`)));

  const out = await new LLMClient(cfg(url))
    .complete("s", [{ role: "user", content: [{ type: "text", text: "hi" }] }], []);
  s.close();

  assert.equal(out.text, "hi");
  assert.equal(seenApiKey, "azure-secret", "Azure uses api-key, not a bearer token");
  assert.equal(seenAuth, "", "and must not also send Authorization");
  assert.match(seenPath, /\/deployments\/my-codex-deployment\/chat\/completions/,
    "the deployment name addresses the model");
  assert.match(seenPath, /api-version=/, "Azure pins the API surface by date");
});

test("azure lists the subscription's deployments, naming the model each runs", async () => {
  const s = http.createServer((req, res) => {
    assert.match(req.url ?? "", /\/openai\/deployments\?api-version=/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [
      { id: "my-codex-deployment", model: "gpt-5.3-codex" },
      { id: "cheap-one", model: "gpt-4o-mini" },
    ] }));
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}/openai`)));

  const models = await new LLMClient(cfg(url)).listModels();
  s.close();

  // The id is what you call; the model is what it runs. Both matter to a user
  // choosing between deployments someone else named.
  assert.deepEqual(models, [
    { id: "my-codex-deployment", name: "gpt-5.3-codex" },
    { id: "cheap-one", name: "gpt-4o-mini" },
  ]);
});

// ───────────────────────────────────── Claude on Azure, via Microsoft Foundry
test("foundry is the Anthropic wire with Azure auth, not a new protocol", async () => {
  const r = getRoute("foundry")!;
  assert.equal(r.wire, "anthropic", "Foundry serves the Messages API");
  assert.equal(r.vendor, "Anthropic");
  assert.equal(r.implemented, true);
  assert.equal(r.needsBaseUrl, true, "the resource is per-subscription");
  assert.equal(r.keyEnv, "AZURE_FOUNDRY_API_KEY",
    "a Foundry resource is separate from an Azure OpenAI one, with its own key");
  assert.notEqual(r.keyEnv, getRoute("azure-openai")!.keyEnv,
    "sharing the variable offered a GPT key for Claude, where it cannot work");
});

test("foundry: an api-key header, and an Entra token sent as a bearer", async () => {
  const seen: { key: string; auth: string; path: string }[] = [];
  const s = http.createServer((req, res) => {
    seen.push({
      key: String(req.headers["api-key"] ?? ""),
      auth: String(req.headers["authorization"] ?? ""),
      path: req.url ?? "",
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "content_block_delta",
      delta: { type: "text_delta", text: "ok" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta",
      usage: { output_tokens: 3 } })}\n\n`);
    res.end();
  });
  const url: string = await new Promise((r) =>
    s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}/anthropic`)));

  const base = {
    provider: "anthropic", baseUrl: url, model: "claude-opus-4-8",
    route: "foundry", maxTokens: 64, retryMaxAttempts: 1,
  };
  const msg = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

  // a plain subscription key
  await new LLMClient({ ...base, apiKey: "abc123secret" } as unknown as Config)
    .complete("s", msg, []);
  assert.equal(seen[0]!.key, "abc123secret", "Azure takes api-key, not x-api-key");
  assert.equal(seen[0]!.auth, "");

  // a token minted from Entra ID looks like a JWT and belongs in Authorization
  await new LLMClient({ ...base, apiKey: "eyJhbGciOiJIUzI1NiJ9.payload.sig" } as unknown as Config)
    .complete("s", msg, []);
  assert.match(seen[1]!.auth, /^Bearer eyJ/, "an Entra token is a bearer token");
  assert.equal(seen[1]!.key, "", "and must not also go in api-key");

  assert.match(seen[0]!.path, /\/v1\/messages$/, "still the Messages API");
  s.close();
});

test("pricing: the US Data Zone multiplier is applied, never rounded away", async () => {
  const { scalePrice, US_DATA_ZONE_MULTIPLIER } = await import("../src/pricing.js");
  const base = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const zoned = scalePrice(base, US_DATA_ZONE_MULTIPLIER);
  assert.equal(zoned.in, 5.5);
  assert.equal(zoned.out, 27.5);
  assert.equal(zoned.cacheRead, 0.55);
  assert.equal(zoned.cacheWrite, 6.875);
  // Under-reporting is the one direction a cost tool must not err in.
  assert.ok(zoned.in > base.in && zoned.out > base.out);
});

test("a text prompt after a menu still gets to ask", async () => {
  const { select } = await import("../src/prompt.js");
  const { PassThrough } = await import("node:stream");

  // The Enter that confirms a menu used to stay in readline's buffer and get
  // handed to the next question, which returned empty before the user could
  // type — so the resource-name prompt appeared and aborted in one instant.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as { isTTY?: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;

  const realIn = process.stdin, realOut = process.stdout;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process, "stdout", {
    value: { isTTY: true, write: () => true }, configurable: true,
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    const rl = { pause() {}, resume() {} } as unknown as
      import("node:readline/promises").Interface;
    const p = select(rl, "pick", ["one", "two"]);
    await new Promise((r) => setImmediate(r));
    // Enter to confirm, plus a stray newline the terminal may deliver with it
    (stdin as unknown as import("node:stream").PassThrough).write("\r\n");
    assert.equal(await p, 0);

    // nothing is left waiting for the next prompt to swallow
    assert.equal((stdin as unknown as import("node:stream").PassThrough).read(), null,
      "the buffer is drained, so the next question actually asks");
  } finally {
    console.log = realLog;
    Object.defineProperty(process, "stdin", { value: realIn, configurable: true });
    Object.defineProperty(process, "stdout", { value: realOut, configurable: true });
  }
});
