import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveCredential, getCredential, resolveCredential, deleteCredential,
  listCredentialNames, maskCredential, permissionsAreLoose,
} from "../src/credentials.js";

const tmpFile = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "faber-cred-")), "credentials.json");

test("credentials: saved with owner-only permissions", () => {
  const f = tmpFile();
  saveCredential("ANTHROPIC_API_KEY", "sk-ant-secret-value-here", f);
  assert.equal(getCredential("ANTHROPIC_API_KEY", f), "sk-ant-secret-value-here");

  assert.equal(permissionsAreLoose(f), false);
  if (process.platform !== "win32") {
    // POSIX mode bits only — Windows uses ACLs and reports a synthetic mode
    const mode = fs.statSync(f).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    fs.chmodSync(f, 0o644);
    assert.equal(permissionsAreLoose(f), true, "group/other readable is detected");
  }
});

test("credentials: the environment always wins over a stored key", () => {
  const f = tmpFile();
  saveCredential("TEST_KEY_X", "from-file", f);
  const prev = process.env.TEST_KEY_X;
  try {
    delete process.env.TEST_KEY_X;
    assert.equal(resolveCredential("TEST_KEY_X", f), "from-file");
    process.env.TEST_KEY_X = "from-env";
    assert.equal(resolveCredential("TEST_KEY_X", f), "from-env",
      "CI and one-off exports must never be overridden by a saved key");
  } finally {
    if (prev === undefined) delete process.env.TEST_KEY_X;
    else process.env.TEST_KEY_X = prev;
  }
});

test("credentials: multiple keys, listing names only, and removal", () => {
  const f = tmpFile();
  saveCredential("ANTHROPIC_API_KEY", "sk-ant-aaaa1111", f);
  saveCredential("BEDROCK_API_KEY", "bed-bbbb2222", f);
  assert.deepEqual(listCredentialNames(f), ["ANTHROPIC_API_KEY", "BEDROCK_API_KEY"]);

  assert.equal(deleteCredential("BEDROCK_API_KEY", f), true);
  assert.equal(getCredential("BEDROCK_API_KEY", f), undefined);
  assert.equal(deleteCredential("NOT_THERE", f), false);
  assert.equal(getCredential("ANTHROPIC_API_KEY", f), "sk-ant-aaaa1111", "others survive");
});

test("credentials: masking never reveals the middle of a key", () => {
  assert.equal(maskCredential("sk-ant-api03-abcdefgh1234"), "sk-ant-…1234");
  assert.ok(!maskCredential("sk-ant-api03-abcdefgh1234").includes("api03"));
  assert.ok(!maskCredential("short").includes("hor"));
});

test("credentials: a missing or corrupt store degrades quietly", () => {
  assert.equal(getCredential("ANY", "/nonexistent/none.json"), undefined);
  assert.deepEqual(listCredentialNames("/nonexistent/none.json"), []);
  const f = tmpFile();
  fs.writeFileSync(f, "{ not json");
  assert.equal(getCredential("ANY", f), undefined);
  // and a corrupt file can still be written over
  saveCredential("NEW_KEY", "v", f);
  assert.equal(getCredential("NEW_KEY", f), "v");
});

test("credentials: an explicitly chosen key beats the environment variable", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { saveCredential } = await import("../src/credentials.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-prefer-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "faber-ws2-"));
  const prevHome = process.env.HOME, prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.HOME = home;
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-environment";
  try {
    saveCredential("ANTHROPIC_API_KEY", "sk-ant-explicitly-chosen");
    const write = (preferStored: boolean): void => {
      fs.mkdirSync(path.join(home, ".faber"), { recursive: true });
      fs.writeFileSync(path.join(home, ".faber", "settings.json"), JSON.stringify({
        activeProfile: "default",
        profiles: { default: {
          route: "anthropic-api", apiKeyEnv: "ANTHROPIC_API_KEY",
          ...(preferStored ? { preferStoredKey: true } : {}),
        } },
      }));
    };

    // default: the environment wins, so CI and one-off exports keep working
    write(false);
    assert.equal(loadConfig(ws).apiKey, "sk-ant-from-environment");

    // but a key the user deliberately pasted during setup takes precedence
    write(true);
    assert.equal(loadConfig(ws).apiKey, "sk-ant-explicitly-chosen",
      "an explicit choice must not be silently ignored");
  } finally {
    process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("secret input: never echoes the key, and works headlessly", async () => {
  const { readSecret } = await import("../src/prompt.js");
  const { PassThrough } = await import("node:stream");

  // non-TTY (CI piping a key in) falls back to a plain read
  const piped = { question: async () => "  sk-ant-piped-key  " } as unknown as
    import("node:readline/promises").Interface;
  const noTty = new PassThrough() as unknown as NodeJS.ReadStream;
  (noTty as { isTTY?: boolean }).isTTY = false;
  assert.equal(await readSecret(piped, "key: ", { stdin: noTty }), "sk-ant-piped-key");

  // TTY path uses a FAKE stream — never the real process.stdin, which under
  // the test runner has no terminal and would hang forever waiting for data.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as { isTTY?: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
  const written: string[] = [];
  const stdout = {
    isTTY: true,
    write: (s: string) => { written.push(s); return true; },
  } as unknown as NodeJS.WriteStream;
  const rl = { pause() {}, resume() {} } as unknown as
    import("node:readline/promises").Interface;

  const p = readSecret(rl, "key: ", { stdin, stdout });
  await new Promise((r) => setImmediate(r));          // let the listener attach
  (stdin as unknown as import("node:stream").PassThrough).write("sk-ant-secret\r");
  const got = await p;

  assert.equal(got, "sk-ant-secret");
  const screen = written.join("");
  assert.ok(!screen.includes("sk-ant-secret"), "the key must never reach the terminal");
  assert.ok(screen.includes("•"), "masked instead");
});

test("credentials: obvious non-keys are flagged, real keys pass", async () => {
  const { looksLikeKey } = await import("../src/credentials.js");
  // the exact failure seen in use: random keystrokes saved as a key
  assert.match(looksLikeKey("ANTHROPIC_API_KEY", "ghjhbjhjkjkaber")!, /too short|sk-ant-/);
  assert.match(looksLikeKey("ANTHROPIC_API_KEY", "my api key is 12345678901234567890")!, /spaces/);
  assert.match(looksLikeKey("ANTHROPIC_API_KEY", "sk-proj-abcdefghij1234567890")!, /sk-ant-/);
  assert.match(looksLikeKey("OPENAI_API_KEY", "not-a-key-at-all-but-long-enough")!, /sk-/);

  // real-shaped keys are accepted without complaint
  assert.equal(looksLikeKey("ANTHROPIC_API_KEY", "sk-ant-api03-" + "x".repeat(40)), undefined);
  assert.equal(looksLikeKey("OPENAI_API_KEY", "sk-proj-" + "y".repeat(40)), undefined);
  // unknown providers aren't second-guessed beyond the basics
  assert.equal(looksLikeKey("BEDROCK_API_KEY", "ABSKQmVkcm9ja0FQSUtleS1" + "z".repeat(20)), undefined);
});
