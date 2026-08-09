/**
 * Credential storage: ~/.faber/credentials.json, mode 0600.
 *
 * Deliberately OUTSIDE any project directory. A key written next to your code
 * is one `git add -f`, one bad .gitignore, or one shared zip away from being
 * public — and scanning bots find committed keys in minutes. Every tool that
 * handles this well (aws, gcloud, npm, git) keeps secrets in the home
 * directory and lets project config reference them by name.
 *
 * Resolution order for a credential:
 *   1. the environment variable (CI, one-offs, and existing setups keep working)
 *   2. this file, keyed by the same variable name
 * Nothing else. Faber never writes a secret into a workspace.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function credentialsPath(): string {
  return path.join(os.homedir(), ".faber", "credentials.json");
}

type Store = Record<string, string>;   // env var NAME -> secret

function read(file = credentialsPath()): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Look up a stored credential by the env var name it stands in for. */
export function getCredential(envName: string, file = credentialsPath()): string | undefined {
  return read(file)[envName];
}

/** Env var wins, so CI and existing shells are never overridden by a saved key. */
export function resolveCredential(envName: string, file = credentialsPath()): string | undefined {
  return process.env[envName] ?? getCredential(envName, file);
}

/** Where a credential came from — so Faber can say so instead of using it silently. */
export function credentialSource(
  envName: string, file = credentialsPath(),
): { value: string; from: "environment" | "store" } | undefined {
  const env = process.env[envName];
  if (env) return { value: env, from: "environment" };
  const stored = getCredential(envName, file);
  return stored ? { value: stored, from: "store" } : undefined;
}

/**
 * Save a credential with owner-only permissions. Written to a temp file first
 * and renamed, so a crash can't leave a half-written store — and chmod happens
 * before the secret lands, never after.
 */
export function saveCredential(envName: string, value: string, file = credentialsPath()): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = read(file);
  store[envName] = value;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try { fs.rmSync(file, { force: true }); } catch { /* absent is fine */ }
  fs.renameSync(tmp, file);   // rename onto an existing file fails on Windows
  try { fs.chmodSync(file, 0o600); } catch { /* no-op where modes don't apply */ }
}

export function deleteCredential(envName: string, file = credentialsPath()): boolean {
  const store = read(file);
  if (!(envName in store)) return false;
  delete store[envName];
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try { fs.rmSync(file, { force: true }); } catch { /* absent is fine */ }
  fs.renameSync(tmp, file);
  return true;
}

/** Names of stored credentials — never the values. */
export function listCredentialNames(file = credentialsPath()): string[] {
  return Object.keys(read(file)).sort();
}

/**
 * Does this look like a real key for that variable?
 * Deliberately loose — formats change, and refusing a valid key is worse than
 * accepting an odd one. This only catches obvious mistakes: a typo, a pasted
 * filename, an accidental keystroke. Returns a reason when it looks wrong.
 */
export function looksLikeKey(envName: string, value: string): string | undefined {
  const v = value.trim();
  if (v.length < 20) return "that looks too short for an API key";
  if (/\s/.test(v)) return "that contains spaces";
  if (envName === "ANTHROPIC_API_KEY" && !v.startsWith("sk-ant-")) {
    return "Anthropic keys normally start with sk-ant-";
  }
  if (envName === "OPENAI_API_KEY" && !v.startsWith("sk-")) {
    return "OpenAI keys normally start with sk-";
  }
  return undefined;
}

/** Show a key without exposing it: sk-ant-…4f2a */
export function maskCredential(value: string): string {
  if (value.length <= 12) return "…".repeat(Math.max(1, value.length - 2)) + value.slice(-2);
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

/**
 * True when the file is readable by anyone but the owner.
 * Windows has no POSIX mode bits — Node reports a synthetic value there, so
 * checking it would warn every Windows user on every launch. Access control
 * on that platform comes from NTFS ACLs, which this can't inspect.
 */
export function permissionsAreLoose(file = credentialsPath()): boolean {
  if (process.platform === "win32") return false;
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
