/**
 * Long-term memory (persistent, per-project) at .faber/memory.db.
 *  - memories: fact|decision|preference|gotcha, FTS5 recall (LIKE fallback),
 *    archive/unarchive/prune lifecycle so growth never poisons recall.
 *  - file_notes: one evolving summary per file.
 * Built on node:sqlite -> zero native dependencies.
 */
import { DatabaseSync } from "node:sqlite";

export type MemoryKind = "fact" | "decision" | "preference" | "gotcha";
const VALID_KINDS = new Set<MemoryKind>(["fact", "decision", "preference", "gotcha"]);

export interface MemoryRow {
  id: number; kind: string; content: string; tags: string; created: number; archived: number;
}
export interface FileNote { path: string; summary: string; updated: number; }

export class LongTermMemory {
  private db: DatabaseSync;
  private fts = true;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT DEFAULT '', created REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`);
    try { this.db.exec("ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"); }
    catch { /* column exists */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_notes (
      path TEXT PRIMARY KEY, summary TEXT NOT NULL, updated REAL NOT NULL)`);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(content, tags, content='memories', content_rowid='id')`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags); END`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags); END`);
    } catch { this.fts = false; }
  }

  remember(kind: string, content: string, tags = ""): number {
    const k = VALID_KINDS.has(kind as MemoryKind) ? kind : "fact";
    const res = this.db.prepare(
      "INSERT INTO memories (kind, content, tags, created) VALUES (?, ?, ?, ?)",
    ).run(k, content.trim(), tags.trim(), Date.now() / 1000);
    return Number(res.lastInsertRowid);
  }

  forget(id: number): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  archive(id: number, archived = true): boolean {
    return this.db.prepare("UPDATE memories SET archived = ? WHERE id = ?")
      .run(archived ? 1 : 0, id).changes > 0;
  }

  archiveOlderThan(days: number): number {
    const cutoff = Date.now() / 1000 - days * 86_400;
    return Number(this.db.prepare(
      "UPDATE memories SET archived = 1 WHERE archived = 0 AND created < ?",
    ).run(cutoff).changes);
  }

  recall(query: string, limit = 8): MemoryRow[] {
    const terms = (query.match(/[A-Za-z0-9_]{3,}/g) ?? []).slice(0, 12);
    let rows: MemoryRow[] = [];
    if (terms.length && this.fts) {
      try {
        rows = this.db.prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND m.archived = 0 ORDER BY rank LIMIT ?`,
        ).all(terms.join(" OR "), limit) as unknown as MemoryRow[];
      } catch { rows = []; }
    }
    if (!rows.length && terms.length) {
      const like = terms.map(() => "content LIKE ?").join(" OR ");
      rows = this.db.prepare(
        `SELECT * FROM memories WHERE archived = 0 AND (${like}) ORDER BY created DESC LIMIT ?`,
      ).all(...terms.map((t) => `%${t}%`), limit) as unknown as MemoryRow[];
    }
    if (!rows.length) {
      rows = this.db.prepare(
        "SELECT * FROM memories WHERE archived = 0 ORDER BY created DESC LIMIT ?",
      ).all(limit) as unknown as MemoryRow[];
    }
    return rows;
  }

  allMemories(includeArchived = false): MemoryRow[] {
    const where = includeArchived ? "" : "WHERE archived = 0";
    return this.db.prepare(`SELECT * FROM memories ${where} ORDER BY id`).all() as unknown as MemoryRow[];
  }

  archivedMemories(): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE archived = 1 ORDER BY id").all() as unknown as MemoryRow[];
  }

  noteFile(path: string, summary: string): void {
    this.db.prepare(
      `INSERT INTO file_notes (path, summary, updated) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET summary=excluded.summary, updated=excluded.updated`,
    ).run(path, summary.trim(), Date.now() / 1000);
  }

  fileNotes(limit = 20): FileNote[] {
    return this.db.prepare(
      "SELECT * FROM file_notes ORDER BY updated DESC LIMIT ?",
    ).all(limit) as unknown as FileNote[];
  }

  renderForPrompt(task: string): string {
    const parts: string[] = [];
    const memories = this.recall(task);
    if (memories.length) {
      parts.push("Relevant long-term memory from previous sessions:");
      for (const m of memories) parts.push(`- [${m.kind}#${m.id}] ${m.content}`);
    }
    const notes = this.fileNotes(10);
    if (notes.length) {
      parts.push("", "Known files:");
      for (const n of notes) parts.push(`- ${n.path}: ${n.summary}`);
    }
    return parts.join("\n");
  }

  close(): void { this.db.close(); }
}
