/**
 * Checkpoints v2 — reversible, inspectable recovery.
 *
 * Each task begins a checkpoint capturing files BEFORE modification.
 * New in v2:
 *  - restore(id) is NON-DESTRUCTIVE: before restoring, the CURRENT state of
 *    the same files is saved as a new "restore-point" checkpoint — so every
 *    restore can itself be undone (that's redo). Nothing is ever lost.
 *  - list() exposes history: id, kind, label, files touched, timestamp.
 *  - undoLast() = restore(newest); redo = restore the restore-point that the
 *    last restore created (tracked per session).
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Entry { path: string; existed: boolean; }
interface Manifest { kind: "task" | "restore-point"; label: string; entries: Entry[]; }

export interface CheckpointInfo {
  id: string; kind: string; label: string; files: string[]; mtimeMs: number;
}

let seq = 0;
/** Timestamp + monotonic counter: unique even within the same millisecond. */
function newId(suffix = ""): string {
  seq = (seq + 1) % 10_000;
  return new Date().toISOString().replace(/[:.]/g, "-") +
    "-" + String(seq).padStart(4, "0") + suffix;
}

export class CheckpointManager {
  private root: string;
  private current?: string;
  private manifest: Entry[] = [];
  private label = "";
  lastRestorePointId?: string;

  constructor(stateDir: string, private workspace: string) {
    this.root = path.join(stateDir, "checkpoints");
    fs.mkdirSync(this.root, { recursive: true });
  }

  begin(label = ""): string {
    const id = newId();
    this.current = path.join(this.root, id);
    fs.mkdirSync(this.current, { recursive: true });
    this.manifest = [];
    this.label = label.replace(/\s+/g, " ").trim().slice(0, 80);
    return id;
  }

  snapshot(filePath: string): void {
    if (!this.current) this.begin();
    const abs = path.resolve(filePath);
    const rel = path.relative(this.workspace, abs);
    if (this.manifest.some((e) => e.path === rel)) return; // keep earliest state
    const existed = fs.existsSync(abs);
    if (existed) {
      const dest = path.join(this.current!, "files", rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    this.manifest.push({ path: rel, existed });
    this.writeManifest(this.current!, { kind: "task", label: this.label, entries: this.manifest });
  }

  commit(): void {
    if (this.current && this.manifest.length === 0) {
      fs.rmSync(this.current, { recursive: true, force: true });
    }
    this.current = undefined;
    this.manifest = [];
  }

  list(): CheckpointInfo[] {
    if (!fs.existsSync(this.root)) return [];
    const out: CheckpointInfo[] = [];
    for (const d of fs.readdirSync(this.root).sort()) {
      const mPath = path.join(this.root, d, "manifest.json");
      if (!fs.existsSync(mPath)) continue;
      try {
        const m: Manifest = JSON.parse(fs.readFileSync(mPath, "utf8"));
        out.push({
          id: d, kind: m.kind ?? "task", label: m.label ?? "",
          files: m.entries.map((e) => e.path), mtimeMs: fs.statSync(mPath).mtimeMs,
        });
      } catch { /* skip corrupt */ }
    }
    return out;
  }

  /**
   * Restore files to their state in checkpoint `id`.
   * Current state of those files is first saved as a restore-point, so this
   * operation is always reversible. Returns restored paths, or undefined if
   * the checkpoint does not exist.
   */
  restore(id: string): string[] | undefined {
    const cpDir = path.join(this.root, id);
    const mPath = path.join(cpDir, "manifest.json");
    if (!fs.existsSync(mPath)) return undefined;
    const manifest: Manifest = JSON.parse(fs.readFileSync(mPath, "utf8"));

    // 1. save current state of the same files as a restore-point (the redo data)
    const rpId = newId("-rp");
    const rpDir = path.join(this.root, rpId);
    fs.mkdirSync(rpDir, { recursive: true });
    const rpEntries: Entry[] = [];
    for (const entry of manifest.entries) {
      const abs = path.join(this.workspace, entry.path);
      const existsNow = fs.existsSync(abs);
      if (existsNow) {
        const dest = path.join(rpDir, "files", entry.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
      }
      rpEntries.push({ path: entry.path, existed: existsNow });
    }
    this.writeManifest(rpDir, { kind: "restore-point", label: `before restoring ${id}`, entries: rpEntries });
    this.lastRestorePointId = rpId;

    // 2. restore from the target checkpoint (data kept — restore is repeatable)
    const restored: string[] = [];
    for (const entry of manifest.entries) {
      const target = path.join(this.workspace, entry.path);
      if (entry.existed) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(cpDir, "files", entry.path), target);
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
      restored.push(entry.path);
    }
    return restored;
  }

  /** Undo the most recent task (non-destructive; see restore). */
  undoLast(): string[] {
    const all = this.list();
    const last = all.at(-1);
    if (!last) return [];
    return this.restore(last.id) ?? [];
  }

  /** Redo: revert the last restore performed in this session. */
  redo(): string[] | undefined {
    if (!this.lastRestorePointId) return undefined;
    const id = this.lastRestorePointId;
    this.lastRestorePointId = undefined;
    return this.restore(id);
  }

  private writeManifest(dir: string, m: Manifest): void {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  }
}
