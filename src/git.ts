/**
 * Git awareness (opt-in, never surprising):
 *  - Detect repo + dirty tree so the CLI can warn before the agent edits.
 *  - CW_GIT=commit -> one commit per completed task (never per edit).
 * All failures degrade silently to "not a repo" — git is optional.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function git(ws: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: ws, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch { return undefined; }
}

export function isRepo(ws: string): boolean {
  return git(ws, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export function isDirty(ws: string): boolean {
  const out = git(ws, ["status", "--porcelain"]);
  return out !== undefined && out.length > 0;
}

/**
 * Make sure the state directory can never be committed.
 * Strategy: write to .git/info/exclude — a LOCAL ignore file (never committed,
 * never shows as a diff), so protection is automatic without modifying the
 * user's tracked .gitignore. Returns what happened so the CLI can inform.
 */
export function ensureStateIgnored(ws: string):
  "not-repo" | "already-ignored" | "excluded-now" | "TRACKED" {
  if (!isRepo(ws)) return "not-repo";
  // worst case: state was committed in the past — ignoring won't untrack it
  const tracked = git(ws, ["ls-files", ".faber", ".codewright"]);
  if (tracked) return "TRACKED";
  // git check-ignore exits 0 (returns output) when the path IS ignored
  if (git(ws, ["check-ignore", ".faber"]) !== undefined) return "already-ignored";
  // check-ignore only matches a directory-only pattern (".faber/") when the
  // directory exists, so also look for our own line — otherwise a first run
  // before the state dir is created would append a duplicate every time.
  const gitDirEarly = git(ws, ["rev-parse", "--git-dir"]);
  if (gitDirEarly) {
    try {
      const excl = fs.readFileSync(path.resolve(ws, gitDirEarly, "info", "exclude"), "utf8");
      if (excl.includes(".faber/")) return "already-ignored";
    } catch { /* no exclude file yet */ }
  }
  try {
    const gitDir = git(ws, ["rev-parse", "--git-dir"]);
    if (!gitDir) return "not-repo";
    const infoDir = path.resolve(ws, gitDir, "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.appendFileSync(path.join(infoDir, "exclude"), "\n# added by faber (local-only ignore)\n.faber/\n.codewright/\n");
    return "excluded-now";
  } catch { return "not-repo"; }
}

/** Commit everything with a task message. Returns short hash, or undefined if nothing to commit / no repo. */
export function commitTask(ws: string, task: string): string | undefined {
  if (!isRepo(ws) || !isDirty(ws)) return undefined;
  const msg = `faber: ${task.replace(/\s+/g, " ").trim().slice(0, 72)}`;
  if (git(ws, ["add", "-A"]) === undefined) return undefined;
  if (git(ws, ["commit", "-m", msg, "--no-verify"]) === undefined) return undefined;
  return git(ws, ["rev-parse", "--short", "HEAD"]);
}
