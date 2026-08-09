/**
 * Redirect the home directory for a test.
 *
 * os.homedir() reads HOME on Unix but USERPROFILE on Windows, so setting HOME
 * alone silently does nothing there: every test then shares the real home
 * directory and they pollute each other's credential and price caches. That's
 * exactly what broke the Windows CI jobs while Linux and macOS stayed green.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME_VARS = ["HOME", "USERPROFILE"] as const;

/** Point the home directory at a fresh temp dir. Returns its path. */
export function useTempHome(prefix = "faber-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const v of HOME_VARS) process.env[v] = dir;
  return dir;
}

/** Snapshot the current home vars so a test can restore them afterwards. */
export function saveHome(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const v of HOME_VARS) saved[v] = process.env[v];
  return saved;
}

export function restoreHome(saved: Record<string, string | undefined>): void {
  for (const v of HOME_VARS) {
    const value = saved[v];
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
}

/** Run a function with a temporary home directory, restoring it afterwards. */
export async function withTempHome<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const saved = saveHome();
  try {
    return await fn(useTempHome());
  } finally {
    restoreHome(saved);
  }
}
