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
