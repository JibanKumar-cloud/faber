/**
 * Filesystem tools. Hardening beyond v0.1:
 *  - Path jail on every operation (symlink-resolved).
 *  - ATOMIC writes: write to temp file then rename — a crash mid-write can
 *    never leave a half-written source file.
 *  - Every mutation produces a unified diff, enabling approval mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import type { CheckpointManager } from "../checkpoints.js";

const SKIP_DIRS = new Set([".git", ".faber", ".codewright", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);

export interface PendingWrite {
  kind?: "edit" | "shell";
  path: string;
  diff: string;
  apply: () => string;
}

export function resolveInWorkspace(workspace: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
  // resolve symlinks on the deepest existing ancestor to prevent escapes
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe) + abs.slice(probe.length);
  const rel = path.relative(fs.realpathSync(workspace), real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(`Path escapes the workspace: ${p}`);
  }
  return abs;
}

function atomicWrite(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.faber-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, content.length >= 0 ? abs : abs); // rename is atomic on POSIX
}

export class FsTools {
  constructor(private config: Config, private checkpoints: CheckpointManager) {}

  readFile(p: string, startLine = 1, endLine?: number): string {
    const abs = resolveInWorkspace(this.config.workspace, p);
    if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${p}`);
    const size = fs.statSync(abs).size;
    if (size > this.config.maxFileReadBytes) {
      throw new ToolError(`File too large (${size} bytes). Read a line range instead (start_line/end_line).`);
    }
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    const chunk = lines.slice(Math.max(0, startLine - 1), endLine ?? lines.length);
    return chunk.map((l, i) => `${i + startLine}\t${l}`).join("\n") || "(empty file)";
  }

  listDir(p = ".", depth = 2): string {
    const root = resolveInWorkspace(this.config.workspace, p);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ToolError(`Not a directory: ${p}`);
    }
    const out: string[] = [];
    const walk = (d: string, level: number): void => {
      if (level > depth || out.length > 500) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        out.push(`${"  ".repeat(level)}${e.name}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory()) walk(path.join(d, e.name), level + 1);
      }
    };
    walk(root, 0);
    return out.join("\n") || "(empty)";
  }

  grep(pattern: string, p = ".", maxResults = 50): string {
    let rx: RegExp;
    try { rx = new RegExp(pattern); } catch (e) { throw new ToolError(`Invalid regex: ${e}`); }
    const root = resolveInWorkspace(this.config.workspace, p);
    const hits: string[] = [];
    const files = fs.statSync(root).isFile() ? [root] : [...walkFiles(root)];
    for (const f of files) {
      let text: string;
      try {
        if (fs.statSync(f).size > 1_000_000) continue;
        text = fs.readFileSync(f, "utf8");
      } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i]!)) {
          hits.push(`${path.relative(this.config.workspace, f)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= maxResults) return hits.join("\n") + "\n(truncated)";
        }
      }
    }
    return hits.join("\n") || "No matches.";
  }

  /** Returns a PendingWrite: diff for preview + apply() that commits it. */
  stageWrite(p: string, content: string): PendingWrite {
    const abs = resolveInWorkspace(this.config.workspace, p);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const diff = createTwoFilesPatch(p, p, before, content, "before", "after");
    return {
      path: p,
      diff,
      apply: () => {
        this.checkpoints.snapshot(abs);
        atomicWrite(abs, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
      },
    };
  }

  /** Exact, unique string replacement — staged for approval like stageWrite. */
  stageEdit(p: string, oldStr: string, newStr: string): PendingWrite {
    const abs = resolveInWorkspace(this.config.workspace, p);
    if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${p}`);
    const text = fs.readFileSync(abs, "utf8");
    const count = text.split(oldStr).length - 1;
    if (count === 0) {
      throw new ToolError(
        "old_str not found in file. Re-read the file — it may have changed, or your string may not match exactly (check whitespace).",
      );
    }
    if (count > 1) {
      throw new ToolError(`old_str appears ${count} times; it must be unique. Include more surrounding context.`);
    }
    const after = text.replace(oldStr, newStr);
    const diff = createTwoFilesPatch(p, p, text, after, "before", "after");
    return {
      path: p,
      diff,
      apply: () => {
        // guard against the file changing between stage and apply
        const current = fs.readFileSync(abs, "utf8");
        if (current !== text) throw new ToolError(`${p} changed since the edit was staged; re-read and retry.`);
        this.checkpoints.snapshot(abs);
        atomicWrite(abs, after);
        return `Edited ${p} (1 replacement).`;
      },
    };
  }
}

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}
