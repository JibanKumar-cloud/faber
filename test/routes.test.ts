import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ROUTES, getRoute, vendors, modelsForRoute, resolveModel, describeModel,
  baseUrlFor, DEFAULT_REGION,
} from "../src/routes.js";
import {
  loadSettings, saveSettings, activeProfile, updateActive, DEFAULT_SETTINGS,
  type Settings,
} from "../src/settings.js";

const tmpFile = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "faber-set-")), "settings.json");

test("routes: vendors group correctly and every route declares a wire format", () => {
  const groups = vendors();
  assert.deepEqual(groups.map((g) => g.vendor), ["Anthropic", "OpenAI", "Local", "Other"]);
  for (const r of ROUTES) {
    assert.ok(r.wire === "anthropic" || r.wire === "openai", `${r.id} wire`);
    assert.ok(r.label && r.hint, `${r.id} needs label + hint`);
  }
  // routes that aren't wired up yet must say so rather than fail at request time
  assert.equal(getRoute("vertex")!.implemented, false);
  assert.equal(getRoute("anthropic-api")!.implemented, true);
});

test("routes: aliases resolve; pins win; unknown input passes through as a raw id", () => {
  const direct = getRoute("anthropic-api")!;
  assert.equal(resolveModel("sonnet", direct), "claude-sonnet-5");
  assert.equal(resolveModel("haiku", direct), "claude-haiku-4-5-20251001");
  // a raw id is left alone
  assert.equal(resolveModel("claude-opus-5", direct), "claude-opus-5");
  assert.equal(resolveModel("some-future-model", direct), "some-future-model");
  // a user pin beats the built-in alias (this is how cloud routes work)
  const pins = { sonnet: "us.anthropic.claude-sonnet-5-v1:0" };
  assert.equal(resolveModel("sonnet", direct, pins), "us.anthropic.claude-sonnet-5-v1:0");
});

test("routes: cloud/local routes offer no built-in aliases (ids must be pinned)", () => {
  assert.equal(modelsForRoute(getRoute("bedrock")!).length, 0);
  assert.equal(modelsForRoute(getRoute("ollama")!).length, 0);
  assert.ok(modelsForRoute(getRoute("anthropic-api")!).length >= 3);
  assert.ok(modelsForRoute(getRoute("openai-api")!).length >= 2);
});

test("routes: describeModel shows the alias when there is one", () => {
  const direct = getRoute("anthropic-api")!;
  assert.equal(describeModel("claude-sonnet-5", direct), "sonnet (claude-sonnet-5)");
  assert.equal(describeModel("mystery-model", direct), "mystery-model");
  assert.equal(
    describeModel("us.x.y", getRoute("bedrock")!, { opus: "us.x.y" }),
    "opus (us.x.y)",
  );
});

test("settings: absent or malformed file falls back to defaults, never throws", () => {
  assert.deepEqual(loadSettings("/nonexistent/nope.json"), DEFAULT_SETTINGS);
  const f = tmpFile();
  fs.writeFileSync(f, "{ this is not json");
  assert.deepEqual(loadSettings(f), DEFAULT_SETTINGS);
  // a file with profiles but a bogus active name recovers to a real profile
  fs.writeFileSync(f, JSON.stringify({ activeProfile: "ghost", profiles: { work: { route: "ollama" } } }));
  assert.equal(loadSettings(f).activeProfile, "work");
});

test("settings: round-trip, switch profile, update active in place", () => {
  const f = tmpFile();
  const s: Settings = {
    activeProfile: "work",
    profiles: {
      work: { route: "anthropic-api", model: "sonnet", apiKeyEnv: "ANTHROPIC_API_KEY_WORK" },
      local: { route: "ollama", model: "qwen2.5-coder", baseUrl: "http://localhost:11434/v1" },
    },
  };
  saveSettings(s, f);
  const back = loadSettings(f);
  assert.equal(back.activeProfile, "work");
  assert.equal(activeProfile(back).apiKeyEnv, "ANTHROPIC_API_KEY_WORK");
  assert.equal(back.profiles.local!.baseUrl, "http://localhost:11434/v1");

  updateActive({ model: "opus" }, f);
  const after = loadSettings(f);
  assert.equal(after.profiles.work!.model, "opus");
  assert.equal(after.profiles.work!.route, "anthropic-api", "other fields preserved");
  assert.equal(after.profiles.local!.model, "qwen2.5-coder", "other profiles untouched");
});

test("settings: profiles store credential NAMES, never secrets", () => {
  const f = tmpFile();
  saveSettings({
    activeProfile: "default",
    profiles: { default: { route: "anthropic-api", apiKeyEnv: "ANTHROPIC_API_KEY" } },
  }, f);
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(raw.includes("ANTHROPIC_API_KEY"), "env var name is recorded");
  assert.ok(!/sk-[a-zA-Z0-9-]{10}/.test(raw), "no key-shaped string is ever written");
});

test("local routes need no API key; remote routes still demand one", async () => {
  const { LLMClient } = await import("../src/llm.js");
  const { FatalError } = await import("../src/errors.js");
  const base = {
    workspace: "/tmp", stateDir: "/tmp", provider: "openai" as const, model: "m",
    apiKey: undefined, weakModel: undefined, maxTokens: 10, maxIterations: 1,
    contextTokenBudget: 100, keepRecentMessages: 1, shellTimeoutMs: 1000,
    maxFileReadBytes: 100, retryMaxAttempts: 1, approvalMode: "auto" as const,
    memoryDb: "/tmp/m.db", indexDb: "/tmp/i.db", sessionsDir: "/tmp", usageDb: "/tmp/u.db",
    route: "ollama", region: undefined, modelPins: {}, profileName: "p", priceIn: undefined, priceOut: undefined, autoRefreshPrices: false,
  };
  // localhost: constructs fine with no key
  assert.doesNotThrow(() => new LLMClient({ ...base, baseUrl: "http://localhost:11434/v1" }));
  assert.doesNotThrow(() => new LLMClient({ ...base, baseUrl: "http://127.0.0.1:8000/v1" }));
  // a remote endpoint without a key is still a fatal, actionable error
  assert.throws(() => new LLMClient({ ...base, baseUrl: "https://api.openai.com/v1" }), FatalError);
});

test("bedrock: mantle endpoint is region-substituted and speaks the Anthropic wire", () => {
  const bedrock = getRoute("bedrock")!;
  assert.equal(bedrock.implemented, true, "no SigV4 needed — mantle takes an API key");
  assert.equal(bedrock.wire, "anthropic");
  assert.equal(
    baseUrlFor(bedrock, "eu-west-1"),
    "https://bedrock-mantle.eu-west-1.api.aws/anthropic",
  );
  // the client appends /v1/messages, giving the documented Bedrock path
  assert.equal(
    baseUrlFor(bedrock, "us-east-1") + "/v1/messages",
    "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
  );
  // missing region falls back rather than producing a broken "{region}" URL
  assert.ok(!baseUrlFor(bedrock)!.includes("{region}"));
  assert.equal(baseUrlFor(bedrock), `https://bedrock-mantle.${DEFAULT_REGION}.api.aws/anthropic`);
  // non-templated routes are unaffected
  assert.equal(baseUrlFor(getRoute("anthropic-api")!), "https://api.anthropic.com");
});

test("select: stdin closing mid-prompt returns the default instead of throwing", async () => {
  const { select } = await import("../src/prompt.js");
  const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;   // force the piped path
  try {
    const closed = {
      question: () => Promise.reject(new Error("readline was closed")),
    } as unknown as import("node:readline/promises").Interface;
    assert.equal(await select(closed, "pick", ["a", "b", "c"], 1), 1);
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = inTty;
    (process.stdout as { isTTY?: boolean }).isTTY = outTty;
  }
});

test("a route's own credential is never substituted with the generic one", async () => {
  const { loadConfig } = await import("../src/config.js");
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const pathx = await import("node:path");
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-keymix-"));
  const ws = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-kw-"));
  const prevHome = process.env.HOME, prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  process.env.ANTHROPIC_API_KEY = "sk-ant-personal-key";
  try {
    fsx.mkdirSync(pathx.join(home, ".faber"), { recursive: true });
    fsx.writeFileSync(pathx.join(home, ".faber", "settings.json"), JSON.stringify({
      activeProfile: "default",
      profiles: { default: { route: "bedrock", region: "us-east-1", apiKeyEnv: "BEDROCK_API_KEY" } },
    }));
    const cfg = loadConfig(ws);
    assert.equal(cfg.route, "bedrock");
    assert.equal(cfg.apiKey, undefined,
      "an Anthropic key must not be sent to Bedrock — that 401s and hides SigV4");
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevHome;
    process.env.USERPROFILE = prevHome;   // os.homedir() uses this on Windows
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("switching route mid-session takes effect immediately, no restart", async () => {
  const { Agent } = await import("../src/agent.js");
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const pathx = await import("node:path");
  const ws = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-switch-"));
  const state = pathx.join(ws, ".faber");
  fsx.mkdirSync(state, { recursive: true });

  const base = {
    workspace: ws, stateDir: state, maxTokens: 10, maxIterations: 1,
    contextTokenBudget: 100, keepRecentMessages: 1, shellTimeoutMs: 1000,
    maxFileReadBytes: 100, retryMaxAttempts: 1, approvalMode: "auto" as const,
    memoryDb: pathx.join(state, "m.db"), indexDb: pathx.join(state, "i.db"),
    sessionsDir: pathx.join(state, "s"), usageDb: pathx.join(state, "u.db"),
    weakModel: undefined, region: undefined, modelPins: {}, profileName: "p",
    priceIn: undefined, priceOut: undefined, autoRefreshPrices: false,
  };
  const anthropic = {
    ...base, provider: "anthropic" as const, route: "anthropic-api",
    model: "claude-sonnet-5", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-x",
  };
  const agent = new Agent(anthropic, async () => true, {});
  assert.equal(agent.model, "claude-sonnet-5");
  assert.equal(agent.config.route, "anthropic-api");

  // what /setup does when the user picks OpenAI
  agent.reconfigure({
    ...base, provider: "openai" as const, route: "openai-api",
    model: "gpt-4o", baseUrl: "https://api.openai.com/v1", apiKey: "sk-openai-x",
  });
  assert.equal(agent.model, "gpt-4o", "the session follows the new route");
  assert.equal(agent.config.route, "openai-api");
  assert.equal(agent.config.baseUrl, "https://api.openai.com/v1",
    "and talks to the new endpoint, not the one it started with");
  agent.close();
});

test("long menus filter as you type; short ones keep number shortcuts", async () => {
  const { select } = await import("../src/prompt.js");
  const { PassThrough } = await import("node:stream");

  const drive = async (options: string[], keys: string): Promise<number> => {
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
      const p = select(rl, "pick", options);
      await new Promise((r) => setImmediate(r));
      (stdin as unknown as import("node:stream").PassThrough).write(keys);
      return await p;
    } finally {
      console.log = realLog;
      Object.defineProperty(process, "stdin", { value: realIn, configurable: true });
      Object.defineProperty(process, "stdout", { value: realOut, configurable: true });
    }
  };

  // A dozen models: typing narrows to the one you want instead of 11 arrow presses
  const many = ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "gpt-4-turbo", "gpt-4",
                "gpt-3.5-turbo", "o1-pro", "gpt-5-codex", "gpt-4.1", "o4-mini", "gpt-4.5"];
  assert.equal(many[await drive(many, "codex\r")], "gpt-5-codex",
    "typing jumps straight to the match");
  assert.equal(many[await drive(many, "o3\r")], "o3-mini");
  // backspace edits the filter rather than cancelling
  assert.equal(many[await drive(many, "codexx\x7f\r")], "gpt-5-codex");

  // Short menus keep the 1-9 shortcuts, since there's nothing to search
  const few = ["Anthropic", "OpenAI", "Local"];
  assert.equal(few[await drive(few, "2")], "OpenAI");
});

test("a sentence about a command is a task, not the command", async () => {
  const { looksLikeCommand } = await import("../src/commands.js");

  // The exact input that reverted files while the user was asking a question.
  assert.equal(looksLikeCommand(
    "/undo and /redo how does it work? are we commiting every task?"), false);
  assert.equal(looksLikeCommand("/clear the cache and tell me what changed"), false);
  assert.equal(looksLikeCommand("/compact this function please"), false);

  // Real invocations still work, including the ones that take arguments.
  assert.equal(looksLikeCommand("/undo"), true);
  assert.equal(looksLikeCommand("/usage --refresh-prices"), true);
  assert.equal(looksLikeCommand("/model gpt-5.3-codex"), true);
  assert.equal(looksLikeCommand("/key set ANTHROPIC_API_KEY"), true);
  assert.equal(looksLikeCommand("/map main"), true);
  assert.equal(looksLikeCommand("  /undo  "), true, "surrounding space is fine");

  // Too many arguments for what the command takes: prose.
  assert.equal(looksLikeCommand("/map main and then explain the flow to me"), false);
  assert.equal(looksLikeCommand("/key set A B C D"), false);

  // Not a command at all — let the agent see it.
  assert.equal(looksLikeCommand("/notacommand"), false);
  assert.equal(looksLikeCommand("fix the parser"), false);
});
