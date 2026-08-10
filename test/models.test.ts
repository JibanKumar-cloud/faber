import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { readCache, writeCache, clearCache, buildPicker } from "../src/models.js";
import { getRoute } from "../src/routes.js";
import { LLMClient } from "../src/llm.js";

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "faber-models-"));
  process.env.HOME = d;
  process.env.USERPROFILE = d;   // os.homedir() uses this on Windows
  return d;
}

const baseCfg = {
  workspace: "/tmp", stateDir: "/tmp", model: "m", apiKey: "k",
  weakModel: undefined, maxTokens: 10, maxIterations: 1, contextTokenBudget: 100,
  keepRecentMessages: 1, shellTimeoutMs: 1000, maxFileReadBytes: 100,
  retryMaxAttempts: 1, approvalMode: "auto" as const, memoryDb: "/tmp/m.db",
  indexDb: "/tmp/i.db", sessionsDir: "/tmp", usageDb: "/tmp/u.db",
  route: "anthropic-api", region: undefined, modelPins: {}, profileName: "p",
  priceIn: undefined, priceOut: undefined, autoRefreshPrices: false,
};

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() })));
}

test("discovery: parses the Anthropic list shape and preserves newest-first order", async () => {
  let seenPath = "", seenKey = "", seenVersion = "";
  const srv = await server((req, res) => {
    seenPath = req.url ?? "";
    seenKey = String(req.headers["x-api-key"] ?? "");
    seenVersion = String(req.headers["anthropic-version"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
        { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
      ],
      has_more: false,
    }));
  });
  const llm = new LLMClient({ ...baseCfg, provider: "anthropic", baseUrl: srv.url });
  const models = await llm.listModels();
  srv.close();
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(models[0]!.name, "Claude Opus 5");
  assert.match(seenPath, /^\/v1\/models/);
  assert.equal(seenKey, "k");
  assert.equal(seenVersion, "2023-06-01", "version header is required by the API");
});

test("discovery: OpenAI-compatible shape (Bedrock mantle, Ollama) uses /models + bearer", async () => {
  let seenPath = "", seenAuth = "";
  const srv = await server((req, res) => {
    seenPath = req.url ?? "";
    seenAuth = String(req.headers["authorization"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen2.5-coder", object: "model" }] }));
  });
  const llm = new LLMClient({ ...baseCfg, provider: "openai", baseUrl: srv.url, route: "ollama" });
  const models = await llm.listModels();
  srv.close();
  assert.deepEqual(models, [{ id: "qwen2.5-coder", name: undefined, created: undefined }]);
  assert.equal(seenPath, "/models");
  assert.equal(seenAuth, "Bearer k");
});

test("discovery: failures degrade to an empty list, never throw", async () => {
  // 403 — a key without models:list permission
  const denied = await server((_req, res) => { res.writeHead(403); res.end("{}"); });
  const a = new LLMClient({ ...baseCfg, provider: "anthropic", baseUrl: denied.url });
  assert.deepEqual(await a.listModels(), []);
  denied.close();

  // malformed body
  const junk = await server((_req, res) => { res.writeHead(200); res.end("not json"); });
  const b = new LLMClient({ ...baseCfg, provider: "anthropic", baseUrl: junk.url });
  assert.deepEqual(await b.listModels(), []);
  junk.close();

  // unreachable host
  const c = new LLMClient({ ...baseCfg, provider: "anthropic", baseUrl: "http://127.0.0.1:1" });
  assert.deepEqual(await c.listModels(), []);
});

test("cache: round-trips, expires after the TTL, and clears on demand", () => {
  tmpHome();
  const models = [{ id: "claude-opus-5", name: "Claude Opus 5" }];
  writeCache("anthropic-api", models);
  assert.deepEqual(readCache("anthropic-api"), models);

  const dayLater = Date.now() + 25 * 60 * 60 * 1000;
  assert.equal(readCache("anthropic-api", dayLater), undefined, "stale cache is ignored");

  clearCache("anthropic-api");
  assert.equal(readCache("anthropic-api"), undefined);
  assert.equal(readCache("never-written"), undefined, "absent cache is not an error");
});

test("picker: aliases first, discovered models appended without duplicating them", () => {
  const route = getRoute("anthropic-api")!;
  const discovered = [
    { id: "claude-fable-5", name: "Claude Fable 5" },   // new, not covered by an alias
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" }, // already the `sonnet` alias
  ];
  const entries = buildPicker(route, discovered, "claude-sonnet-5");

  const values = entries.map((e) => e.value);
  assert.deepEqual(values.slice(0, 3), ["sonnet", "opus", "haiku"], "aliases lead");
  assert.ok(values.includes("claude-fable-5"), "new model surfaces");
  assert.equal(values.filter((v) => v === "claude-sonnet-5").length, 0,
    "a model already covered by an alias is not listed twice");
  assert.equal(entries.find((e) => e.value === "claude-fable-5")!.live, true);
  assert.equal(entries.find((e) => e.value === "sonnet")!.live, false);
});

test("picker: works with no discovery at all, and keeps an unknown current model visible", () => {
  const route = getRoute("anthropic-api")!;
  const offline = buildPicker(route, [], "claude-sonnet-5");
  assert.deepEqual(offline.map((e) => e.value), ["sonnet", "opus", "haiku"]);

  // a pinned/custom id the built-ins don't know about must not vanish from the menu
  const custom = buildPicker(route, [], "my-fine-tune-v3");
  assert.ok(custom.some((e) => e.value === "my-fine-tune-v3"));

  // a route with no built-in aliases shows purely what was discovered
  const bedrock = getRoute("bedrock")!;
  const fromCloud = buildPicker(bedrock, [{ id: "anthropic.claude-sonnet-4-6-v1" }], "x");
  assert.ok(fromCloud.some((e) => e.value === "anthropic.claude-sonnet-4-6-v1" && e.live));
});

// ───────────────────────────────────────────────────────── pricing
test("pricing: cloud model ids normalize onto one table entry", async () => {
  const { normalizeModelId, priceFor } = await import("../src/pricing.js");
  assert.equal(normalizeModelId("us.anthropic.claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(normalizeModelId("global.anthropic.claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModelId("anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5-20251001");
  assert.equal(normalizeModelId("claude-sonnet-5@20260101"), "claude-sonnet-5");
  assert.equal(normalizeModelId("claude-sonnet-5"), "claude-sonnet-5");
  // a Bedrock id therefore prices the same as the direct one
  assert.deepEqual(priceFor("us.anthropic.claude-sonnet-5"), priceFor("claude-sonnet-5"));
});

test("pricing: explicit override beats everything; unknown models return undefined", async () => {
  const { priceFor, BUILTIN_PRICES } = await import("../src/pricing.js");
  assert.deepEqual(priceFor("claude-sonnet-5", { in: 99, out: 100 }), { in: 99, out: 100 });
  assert.deepEqual(priceFor("claude-sonnet-5"), BUILTIN_PRICES["claude-sonnet-5"]);
  assert.equal(priceFor("some-unknown-model"), undefined);
  // a half-specified override is ignored rather than producing a wrong number
  assert.deepEqual(priceFor("claude-sonnet-5", { in: 99 }), BUILTIN_PRICES["claude-sonnet-5"]);
});

test("pricing: refresh parses the dataset shape and converts per-token to per-Mtok", async () => {
  const { refreshPrices, readPriceCache } = await import("../src/pricing.js");
  tmpHome();
  const srv = await server((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      "claude-sonnet-5": {
        input_cost_per_token: 2e-6, output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 2.5e-6,
      },
      "embedding-model": { input_cost_per_token: 1e-7 },      // no output cost -> skipped
    }));
  });
  const n = await refreshPrices(srv.url);
  srv.close();
  assert.equal(n, 1, "entries without both costs are skipped");
  const cached = readPriceCache()!;
  assert.deepEqual(cached.prices["claude-sonnet-5"], { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 });
});

test("pricing: a failed refresh keeps existing prices but records the attempt", async () => {
  const { refreshPrices, readPriceCache, writePriceCache } = await import("../src/pricing.js");
  tmpHome();
  // start with known-good prices
  writePriceCache({ "known-model": { in: 1, out: 2 } }, "seed");

  const bad = await server((_req, res) => { res.writeHead(500); res.end("nope"); });
  assert.equal(await refreshPrices(bad.url), undefined);
  bad.close();
  assert.equal(await refreshPrices("http://127.0.0.1:1"), undefined);

  const after = readPriceCache()!;
  assert.deepEqual(after.prices["known-model"], { in: 1, out: 2 },
    "a failed refresh must never destroy prices already known");
  assert.ok(after.lastAttempt, "but the attempt is recorded, so we back off");
});

test("pricing: OpenRouter publishes live prices and they win for that route", async () => {
  const { fetchOpenRouterPrices, isOpenRouter, refreshPrices, readPriceCache } =
    await import("../src/pricing.js");

  assert.equal(isOpenRouter("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter("https://api.anthropic.com"), false);
  assert.equal(isOpenRouter(undefined), false);

  const srv = await server((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        {
          id: "anthropic/claude-sonnet-5",
          pricing: {
            prompt: "0.000002", completion: "0.00001",
            input_cache_read: "0.0000002", input_cache_write: "0.0000025",
          },
        },
        { id: "free/model", pricing: { prompt: "0", completion: "0" } },
        { id: "broken/model", pricing: { prompt: "n/a" } },   // skipped
      ],
    }));
  });
  const live = (await fetchOpenRouterPrices(srv.url))!;
  srv.close();

  assert.deepEqual(live["anthropic/claude-sonnet-5"],
    { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.deepEqual(live["free/model"], { in: 0, out: 0 }, "free models price at zero, not undefined");
  assert.ok(!("broken/model" in live), "unparseable entries are dropped");
});

test("model picker keeps chat models and drops ones that can't chat", async () => {
  const { isChatModel, buildPicker } = await import("../src/models.js");
  const { getRoute } = await import("../src/routes.js");

  // these accept chat requests
  for (const id of ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "gpt-5.3-codex",
                    "claude-sonnet-5", "claude-opus-4-8", "qwen2.5-coder"]) {
    assert.equal(isChatModel(id), true, `${id} should be offered`);
  }
  // these do not — offering them is offering a guaranteed failure
  for (const id of ["text-embedding-ada-002", "text-embedding-3-large", "whisper-1",
                    "tts-1-hd", "omni-moderation-latest", "dall-e-3", "davinci-002",
                    "babbage-002", "gpt-4o-transcribe"]) {
    assert.equal(isChatModel(id), false, `${id} should be filtered out`);
  }

  // and the picker applies it, so a real catalogue doesn't drown the user
  const entries = buildPicker(getRoute("openai-api")!, [
    { id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "o3-mini" },
  ], "gpt-4o");
  const live = entries.filter((e) => e.live).map((e) => e.value);
  assert.deepEqual(live, ["o3-mini"], "only chat models are appended (gpt-4o is already an alias)");
});

test("a deprecation error explains itself; an endpoint mismatch is retried", async () => {
  const { classifyModelError } = await import("../src/models.js");
  // A retired model is a dead end the user must act on.
  assert.equal(classifyModelError("The model `x` has been deprecated"), "deprecated");
  // An endpoint mismatch is not: the client retries on the endpoint named,
  // so this classification exists to record it, not to stop the request.
  assert.equal(
    classifyModelError("not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead."),
    "wrong-endpoint");
});

test("OpenAI lists codex models first, then the rest, newest within each", async () => {
  const { sortModels } = await import("../src/models.js");
  const d = (s: string): number => Math.floor(Date.parse(s) / 1000);
  const models = [
    { id: "gpt-5.2", created: d("2025-12-11") },
    { id: "gpt-5.5", created: d("2026-04-23") },
    { id: "gpt-5.2-codex", created: d("2025-12-11") },
    { id: "gpt-5.3-codex", created: d("2026-01-20") },
    { id: "gpt-5.4-mini", created: d("2026-03-17") },
  ];
  assert.deepEqual(sortModels(models, "openai").map((m) => m.id), [
    "gpt-5.3-codex", "gpt-5.2-codex",       // coding models lead, newest first
    "gpt-5.5", "gpt-5.4-mini", "gpt-5.2",   // then the rest, newest first
  ]);

  // Anthropic has no coding split, so it's purely newest first
  const claude = [
    { id: "claude-sonnet-4-5", created: d("2025-09-29") },
    { id: "claude-opus-5", created: d("2026-05-01") },
    { id: "claude-fable-5", created: d("2026-06-09") },
  ];
  assert.deepEqual(sortModels(claude, "anthropic").map((m) => m.id), [
    "claude-fable-5", "claude-opus-5", "claude-sonnet-4-5",
  ]);

  // entries with no date fall below dated ones rather than jumping the queue
  const mixed = [{ id: "zzz-undated" }, { id: "gpt-5.5", created: d("2026-04-23") }];
  assert.deepEqual(sortModels(mixed, "openai").map((m) => m.id), ["gpt-5.5", "zzz-undated"]);
});

test("a model that fails is remembered and never offered again", async () => {
  const { classifyModelError, markUnusable, readUnusable, clearUnusable, buildPicker } =
    await import("../src/models.js");
  const { getRoute } = await import("../src/routes.js");
  tmpHome();
  clearUnusable();

  // the two failures seen in real use, classified from the provider's own words
  assert.equal(classifyModelError(
    'The model `gpt-5.1-codex-mini` has been deprecated, learn more here'), "deprecated");
  assert.equal(classifyModelError('"code": "model_not_found"'), "deprecated");
  assert.equal(classifyModelError(
    "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead."),
    "wrong-endpoint");
  // an unrelated error teaches nothing, so nothing is hidden
  assert.equal(classifyModelError("rate limit exceeded"), undefined);
  assert.equal(classifyModelError("overloaded"), undefined);

  markUnusable("gpt-5.2-codex", "deprecated");
  markUnusable("gpt-5.3-codex", "wrong-endpoint");
  assert.deepEqual(readUnusable(), {
    "gpt-5.2-codex": "deprecated", "gpt-5.3-codex": "wrong-endpoint",
  });

  // and the picker stops offering them
  const entries = buildPicker(getRoute("openai-api")!, [
    { id: "gpt-5.2-codex" }, { id: "gpt-5.3-codex" }, { id: "gpt-5.5" },
  ], "gpt-5.5");
  const live = entries.filter((e) => e.live).map((e) => e.value);
  // The retired model is hidden. The endpoint-mismatch one is NOT: Faber now
  // speaks that endpoint and retries there, so removing it would hide a model
  // that works.
  assert.deepEqual(live, ["gpt-5.3-codex", "gpt-5.5"]);
  clearUnusable();
});

test("model capability comes from the dataset, not from guessing at names", async () => {
  const { isChatModel, requiresUnsupportedApi } = await import("../src/models.js");
  const { writePriceCache } = await import("../src/pricing.js");
  tmpHome();

  // The dataset states mode and endpoints for each model. Using that beats
  // reading the id: a name-based rule misclassifies every new naming scheme,
  // and it can't know that gpt-5.3-codex needs a different endpoint entirely.
  writePriceCache({
    "chat-model":    { in: 1, out: 2, mode: "chat" },
    "codex-model":   { in: 1, out: 2, mode: "responses", endpoints: ["/v1/responses"] },
    "embed-model":   { in: 1, out: 2, mode: "embedding" },
    "audio-model":   { in: 1, out: 2, mode: "audio_transcription" },
    // a chat model whose NAME contains a word the old rules would have banned
    "chat-embedded-reasoning": { in: 1, out: 2, mode: "chat" },
  }, "test");

  assert.equal(isChatModel("chat-model"), true);
  assert.equal(isChatModel("embed-model"), false);
  assert.equal(isChatModel("audio-model"), false);
  assert.equal(isChatModel("chat-embedded-reasoning"), true,
    "the dataset overrides a name that merely looks like an embedding model");

  // Responses-only models are supported now, so they are offered like any
  // other — the routing happens automatically from the same dataset fields.
  assert.equal(isChatModel("codex-model"), true, "codex models are usable now");
  assert.equal(requiresUnsupportedApi("codex-model"), undefined);

  // unknown models still fall back to name rules rather than disappearing
  assert.equal(isChatModel("brand-new-model-nobody-has-listed"), true);
});
