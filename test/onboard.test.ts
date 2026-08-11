import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Onboarding must never block a non-interactive run (CI, pipes, scripts) and
 * must only trigger on a genuinely fresh machine. Both are enforced here
 * because a hang in CI is far worse than a missing prompt.
 */

function withHome<T>(dir: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;   // os.homedir() uses this on Windows
  try { return fn(); } finally { process.env.HOME = prev; }
}

test("onboarding: triggers only when no settings file exists", async () => {
  const { needsOnboarding } = await import("../src/onboard.js");
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "faber-fresh-"));
  assert.equal(withHome(fresh, needsOnboarding), true, "fresh machine -> onboard");

  const configured = fs.mkdtempSync(path.join(os.tmpdir(), "faber-cfg-"));
  fs.mkdirSync(path.join(configured, ".faber"), { recursive: true });
  fs.writeFileSync(
    path.join(configured, ".faber", "settings.json"),
    JSON.stringify({ activeProfile: "default", profiles: { default: { route: "ollama" } } }),
  );
  assert.equal(withHome(configured, needsOnboarding), false, "already set up -> skip");
});

test("onboarding: never runs without a TTY, so piped/CI runs can't hang", async () => {
  const { interactive } = await import("../src/onboard.js");
  const inTty = process.stdin.isTTY, outTty = process.stdout.isTTY;
  try {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    assert.equal(interactive(), false, "no stdin tty -> not interactive");
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    assert.equal(interactive(), false, "no stdout tty -> not interactive");
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    assert.equal(interactive(), true);
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = inTty;
    (process.stdout as { isTTY?: boolean }).isTTY = outTty;
  }
});

test("onboarding: a saved profile survives a reload and drives config", async () => {
  const { saveSettings, loadSettings } = await import("../src/settings.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-flow-"));
  const file = path.join(home, ".faber", "settings.json");
  // what the wizard would write after picking Bedrock + a pinned model
  saveSettings({
    activeProfile: "default",
    profiles: {
      default: {
        route: "bedrock", region: "eu-west-1", model: "sonnet",
        apiKeyEnv: "BEDROCK_API_KEY",
        modelPins: { sonnet: "anthropic.claude-sonnet-4-6-v1" },
      },
    },
  }, file);
  const back = loadSettings(file);
  assert.equal(back.profiles.default!.route, "bedrock");
  assert.equal(back.profiles.default!.region, "eu-west-1");
  assert.equal(back.profiles.default!.modelPins!.sonnet, "anthropic.claude-sonnet-4-6-v1");
});

test("setup completeness is route-aware, not just 'a settings file exists'", async () => {
  const { setupComplete } = await import("../src/onboard.js");

  // Anthropic without a key is INCOMPLETE — this is the case that used to
  // start fine and then 401 on the first task.
  const noKey = await setupComplete({ route: "anthropic-api", model: "claude-sonnet-5" });
  assert.equal(noKey.complete, false);
  assert.match(noKey.missing!, /ANTHROPIC_API_KEY/);
  assert.match(noKey.fix!, /\/key set/);

  // with a key, complete
  assert.equal((await setupComplete({
    route: "anthropic-api", model: "claude-sonnet-5", apiKey: "sk-ant-x",
  })).complete, true);

  // a local model needs no credential at all
  assert.equal((await setupComplete({
    route: "ollama", model: "qwen2.5-coder", baseUrl: "http://localhost:11434/v1",
  })).complete, true);

  // but it does need a model id, since local routes have no default
  const noModel = await setupComplete({ route: "ollama", baseUrl: "http://localhost:11434/v1" });
  assert.equal(noModel.complete, false);
  assert.match(noModel.missing!, /model/);

  // a custom endpoint without a URL can't work
  const noUrl = await setupComplete({ route: "custom", model: "m" });
  assert.equal(noUrl.complete, false);
  assert.match(noUrl.missing!, /endpoint/);

  // an unimplemented route is reported as such rather than failing later
  const vertex = await setupComplete({ route: "vertex", model: "m" });
  assert.equal(vertex.complete, false);
  assert.match(vertex.missing!, /wired/);
});

test("bedrock counts as complete when AWS credentials can sign, with no key", async () => {
  const { setupComplete } = await import("../src/onboard.js");
  const prev = {
    id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY,
    home: process.env.HOME,
  };
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const pathx = await import("node:path");
  process.env.HOME = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-bd-"));
  process.env.USERPROFILE = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-bd-"));   // os.homedir() uses this on Windows
  try {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const without = await setupComplete({ route: "bedrock", model: "anthropic.claude-x" });
    assert.equal(without.complete, false, "no key and no role -> incomplete");
    assert.match(without.missing!, /AWS credentials/);

    process.env.AWS_ACCESS_KEY_ID = "ASIA_ROLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const withRole = await setupComplete({ route: "bedrock", model: "anthropic.claude-x" });
    assert.equal(withRole.complete, true, "an IAM role IS a complete setup — no key needed");
  } finally {
    process.env.HOME = prev.home;
    process.env.USERPROFILE = prev.home;
    process.env.USERPROFILE = prev.home;   // os.homedir() uses this on Windows
    if (prev.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prev.id;
    if (prev.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prev.secret;
  }
});

test("setup offers concrete model ids with prices, never bare aliases", async () => {
  const { modelsForRoute, getRoute } = await import("../src/routes.js");
  const { priceFor } = await import("../src/pricing.js");

  // Whatever setup falls back to when discovery fails must still be a real,
  // billable model id — an alias like "gpt" tells the user nothing about cost,
  // and gpt-4o is ~17x the price of gpt-4o-mini.
  for (const routeId of ["anthropic-api", "openai-api"]) {
    const route = getRoute(routeId)!;
    for (const m of modelsForRoute(route)) {
      assert.match(m.id, /-/, `${m.id} should be a full model id, not an alias`);
      const p = priceFor(m.id);
      assert.ok(p, `no price known for ${m.id}, so setup couldn't show its cost`);
      assert.ok(p!.in > 0 && p!.out > 0);
    }
  }

  // and the price gap is exactly why the id matters
  const big = priceFor("gpt-4o")!, small = priceFor("gpt-4o-mini")!;
  assert.ok(big.in / small.in > 10, "these are not interchangeable choices");
});

test("a key the provider rejects fails setup; being offline does not", async () => {
  const { LLMClient } = await import("../src/llm.js");
  const http = await import("node:http");

  // Servers are tracked and closed: an open listener keeps the test runner
  // alive and the whole suite appears to hang.
  const open: import("node:http").Server[] = [];
  const serve = async (status: number): Promise<string> => {
    const s = http.createServer((_q, r) => { r.writeHead(status); r.end("{}"); });
    open.push(s);
    return new Promise((res) =>
      s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
  };
  const cfg = (baseUrl: string) => ({
    provider: "anthropic" as const, baseUrl, apiKey: "k", model: "x", route: "anthropic-api",
  } as unknown as import("../src/config.js").Config);

  // 401 and 403 are the provider saying the key is wrong: setup must not pass
  assert.equal(await new LLMClient(cfg(await serve(401))).verifyKey(), "rejected");
  assert.equal(await new LLMClient(cfg(await serve(403))).verifyKey(), "rejected");

  // a working endpoint accepts it
  assert.equal(await new LLMClient(cfg(await serve(200))).verifyKey(), "ok");

  // anything else says nothing about the key, so setup carries on
  assert.equal(await new LLMClient(cfg(await serve(500))).verifyKey(), "unreachable");
  assert.equal(await new LLMClient(cfg("http://127.0.0.1:1")).verifyKey(), "unreachable",
    "being offline must not block someone from finishing setup");

  for (const s of open) s.close();
});

test("a profile is saved only when it is genuinely usable", async () => {
  const { setupComplete } = await import("../src/onboard.js");

  // The exact junk that got written after Ctrl-C at a text prompt: not empty,
  // so every naive "is it set" check passed and the profile looked valid.
  const ctrlC = await setupComplete({
    route: "bedrock", model: "\x03\x03", baseUrl: "https://x", apiKey: "k",
  });
  assert.equal(ctrlC.complete, false, "control characters are not a model id");

  const blank = await setupComplete({
    route: "anthropic-api", model: "   ", apiKey: "k",
  });
  assert.equal(blank.complete, false, "whitespace is not a model id");

  // and a real one still passes
  const good = await setupComplete({
    route: "anthropic-api", model: "claude-sonnet-5", apiKey: "sk-ant-x",
  });
  assert.equal(good.complete, true);
});

test("a pasted answer is accepted; only Ctrl-C cancels", async () => {
  const { __askTextForTest } = await import("../src/onboard.js");
  const ask = (reply: string): Promise<string | undefined> =>
    __askTextForTest({ question: async () => reply } as unknown as
      import("node:readline/promises").Interface, "name: ");

  // A paste arrives wrapped in bracketed-paste markers. Rejecting every
  // control character made pasting an answer abort setup entirely.
  assert.equal(await ask("\x1b[200~ai-engineering-dev\x1b[201~"), "ai-engineering-dev");
  assert.equal(await ask("  ai-engineering-dev  "), "ai-engineering-dev");
  assert.equal(await ask("plain-typed"), "plain-typed");

  // Ctrl-C and Ctrl-D still mean stop
  assert.equal(await ask("\x03"), undefined);
  assert.equal(await ask("\x04"), undefined);
});

test("a question about a command is not a command", async () => {
  const { looksLikeCommand } = await import("../src/commands.js");

  // The exact line that reverted two files while the user was asking how
  // /undo works. A destructive command must be the whole line.
  assert.equal(looksLikeCommand(
    "/undo and /redo how does it work? are we commiting every task?"), false);
  assert.equal(looksLikeCommand("/undo please explain what this does"), false);
  assert.equal(looksLikeCommand("/clear the whole conversation history for me"), false);

  // real invocations still work
  assert.equal(looksLikeCommand("/undo"), true);
  assert.equal(looksLikeCommand("/redo"), true);
  assert.equal(looksLikeCommand("  /history  "), true);
  assert.equal(looksLikeCommand("/memory archived"), true);
  assert.equal(looksLikeCommand("/map main"), true);
  assert.equal(looksLikeCommand("/key set BEDROCK_API_KEY"), true);
  assert.equal(looksLikeCommand("/model gpt-5.3-codex"), true);
  assert.equal(looksLikeCommand("/usage --refresh-prices"), true);
  assert.equal(looksLikeCommand("/restore 3"), true);

  // and a question about an argument-taking command is still a question
  assert.equal(looksLikeCommand("/model what does this even do?"), false);
});
