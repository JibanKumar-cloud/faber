/**
 * Code graph indexer v2 — nodes AND edges, incrementally maintained.
 *
 * Nodes:  symbols (functions, classes, ...) as before.
 * Edges:  calls   (enclosing function -> called name, resolved against the
 *                  symbol table) and imports (file -> file/module).
 * Incremental: file mtimes are stored; refresh() re-parses only changed
 * files and prunes deleted ones — milliseconds on large repos after the
 * first build. Tasks call refresh() at start so the map is never stale.
 *
 * HONESTY NOTE (also stated in tool descriptions): edges come from
 * line-based static parsing. Dynamic dispatch, callbacks, DI and
 * metaprogramming produce missing or extra edges. Treat the graph as strong
 * hints for navigation, and read the code where precision matters.
 * Tree-sitter is the documented upgrade path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SKIP_DIRS = new Set([
  ".git", ".faber", ".codewright", "node_modules", ".venv", "venv", "__pycache__",
  "dist", "build", ".mypy_cache", ".pytest_cache", "target", ".next", "dist-test",
]);

type Pattern = [kind: string, regex: RegExp];
const LANG: Record<string, Pattern[]> = {
  ".py": [["function", /^\s*(?:async\s+)?def\s+(\w+)/], ["class", /^\s*class\s+(\w+)/]],
  ".js": [["function", /function\s+(\w+)/], ["class", /class\s+(\w+)/],
          ["function", /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/]],
  ".ts": [["function", /function\s+(\w+)/], ["class", /class\s+(\w+)/],
          ["interface", /interface\s+(\w+)/], ["type", /^\s*type\s+(\w+)\s*=/],
          ["function", /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/]],
  ".go": [["function", /func\s+(?:\([^)]*\)\s*)?(\w+)/], ["type", /type\s+(\w+)/]],
  ".rs": [["function", /fn\s+(\w+)/], ["struct", /struct\s+(\w+)/],
          ["enum", /enum\s+(\w+)/], ["trait", /trait\s+(\w+)/]],
  ".java": [["class", /class\s+(\w+)/], ["interface", /interface\s+(\w+)/],
            ["method", /(?:public|private|protected)\s+[\w<>[\]]+\s+(\w+)\s*\(/]],
  ".c": [["function", /^[\w*]+\s+(\w+)\s*\([^;]*\)\s*\{/]],
  ".cpp": [["function", /^[\w*:<>]+\s+(\w+)\s*\([^;]*\)\s*\{/], ["class", /class\s+(\w+)/]],
  ".rb": [["function", /^\s*def\s+(\w+)/], ["class", /^\s*class\s+(\w+)/], ["module", /^\s*module\s+(\w+)/]],
  ".php": [["function", /function\s+(\w+)/], ["class", /class\s+(\w+)/]],
};
LANG[".jsx"] = LANG[".js"]!; LANG[".tsx"] = LANG[".ts"]!;
LANG[".mjs"] = LANG[".js"]!; LANG[".cjs"] = LANG[".js"]!;
LANG[".h"] = LANG[".c"]!; LANG[".hpp"] = LANG[".cpp"]!;

const IMPORT_RX: Record<string, RegExp[]> = {
  ".py": [/^\s*from\s+([\w.]+)\s+import/, /^\s*import\s+([\w.]+)/],
  ".js": [/from\s+["']([^"']+)["']/, /require\(\s*["']([^"']+)["']\s*\)/],
  ".go": [/^\s*"([\w./-]+)"/],
  ".rs": [/^\s*use\s+([\w:]+)/],
  ".java": [/^\s*import\s+([\w.]+)/],
  ".rb": [/^\s*require(?:_relative)?\s+["']([^"']+)["']/],
  ".php": [/^\s*use\s+([\w\\]+)/],
};
IMPORT_RX[".ts"] = IMPORT_RX[".js"]!; IMPORT_RX[".jsx"] = IMPORT_RX[".js"]!;
IMPORT_RX[".tsx"] = IMPORT_RX[".js"]!; IMPORT_RX[".mjs"] = IMPORT_RX[".js"]!;

// identifiers that look like calls but aren't
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof",
  "super", "constructor", "def", "class", "print", "await", "async", "new",
  "assert", "yield", "match", "case", "elif", "except", "raise", "sizeof",
]);
const CALL_RX = /(\w+)\s*\(/g;

export interface Symbol { name: string; kind: string; path: string; line: number; signature: string; }
export interface Edge { caller: string; callee: string; path: string; line: number; }

export class CodeIndexer {
  private db: DatabaseSync;

  constructor(dbPath: string, private workspace: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS symbols (name TEXT, kind TEXT, path TEXT, line INTEGER, signature TEXT)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_name ON symbols(name)");
    this.db.exec("CREATE TABLE IF NOT EXISTS edges (caller TEXT, callee TEXT, path TEXT, line INTEGER)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_callee ON edges(callee)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_caller ON edges(caller)");
    this.db.exec("CREATE TABLE IF NOT EXISTS imports (src TEXT, target TEXT, line INTEGER)");
    this.db.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime_ms REAL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  }

  // ------------------------------------------------------------- building
  /** Full rebuild. */
  build(): { files: number; symbols: number; edges: number } {
    this.db.exec("DELETE FROM symbols; DELETE FROM edges; DELETE FROM imports; DELETE FROM files;");
    return this.refresh();
  }

  /** Incremental: (re)parse only new/changed files, prune deleted ones. */
  refresh(): { files: number; symbols: number; edges: number } {
    const known = new Map<string, number>(
      (this.db.prepare("SELECT path, mtime_ms FROM files").all() as any[])
        .map((r) => [r.path as string, r.mtime_ms as number]),
    );
    const seen = new Set<string>();
    const changed: { rel: string; abs: string; mtime: number }[] = [];
    for (const abs of walk(this.workspace)) {
      if (!LANG[path.extname(abs)]) continue;
      const rel = path.relative(this.workspace, abs);
      seen.add(rel);
      let mtime: number;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { continue; }
      if (known.get(rel) !== mtime) changed.push({ rel, abs, mtime });
    }
    const removed = [...known.keys()].filter((p) => !seen.has(p));

    const delSym = this.db.prepare("DELETE FROM symbols WHERE path = ?");
    const delEdge = this.db.prepare("DELETE FROM edges WHERE path = ?");
    const delImp = this.db.prepare("DELETE FROM imports WHERE src = ?");
    const delFile = this.db.prepare("DELETE FROM files WHERE path = ?");
    for (const p of removed) { delSym.run(p); delEdge.run(p); delImp.run(p); delFile.run(p); }

    const insSym = this.db.prepare("INSERT INTO symbols VALUES (?, ?, ?, ?, ?)");
    const insEdge = this.db.prepare("INSERT INTO edges VALUES (?, ?, ?, ?)");
    const insImp = this.db.prepare("INSERT INTO imports VALUES (?, ?, ?)");
    const upFile = this.db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?)");

    // pass 1: symbols for changed files (so calls in pass 2 can resolve)
    const parsed = new Map<string, { symbols: [string, string, number, string][]; lines: string[] }>();
    for (const f of changed) {
      delSym.run(f.rel); delEdge.run(f.rel); delImp.run(f.rel);
      let text: string;
      try { text = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
      const lines = text.split("\n");
      const syms: [string, string, number, string][] = [];
      const patterns = LANG[path.extname(f.abs)]!;
      for (let i = 0; i < lines.length; i++) {
        for (const [kind, rx] of patterns) {
          const m = rx.exec(lines[i]!);
          if (m?.[1] && !CALL_KEYWORDS.has(m[1])) {
            syms.push([m[1], kind, i + 1, lines[i]!.trim().slice(0, 120)]);
            break;
          }
        }
      }
      for (const [name, kind, line, sig] of syms) insSym.run(name, kind, f.rel, line, sig);
      parsed.set(f.rel, { symbols: syms, lines });
      upFile.run(f.rel, f.mtime);
    }

    // known symbol names across the whole repo (for call resolution)
    const knownNames = new Set<string>(
      (this.db.prepare("SELECT DISTINCT name FROM symbols").all() as any[]).map((r) => r.name as string),
    );

    // pass 2: edges + imports for changed files
    for (const [rel, { symbols, lines }] of parsed) {
      const importRxs = IMPORT_RX[path.extname(rel)] ?? [];
      // caller attribution: nearest preceding symbol definition in the file
      const defLines = symbols.map(([name, , line]) => ({ name, line })).sort((a, b) => a.line - b.line);
      const callerAt = (lineNo: number): string => {
        let cur = "<module>";
        for (const d of defLines) { if (d.line <= lineNo) cur = d.name; else break; }
        return cur;
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const rx of importRxs) {
          const m = rx.exec(line);
          if (m?.[1]) insImp.run(rel, m[1], i + 1);
        }
        const defHere = new Set(defLines.filter((d) => d.line === i + 1).map((d) => d.name));
        CALL_RX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_RX.exec(line))) {
          const name = m[1]!;
          if (CALL_KEYWORDS.has(name) || defHere.has(name) || !knownNames.has(name)) continue;
          const caller = callerAt(i + 1);
          if (caller === name) continue; // skip trivial self-attribution noise
          insEdge.run(caller, name, rel, i + 1);
        }
      }
    }
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)").run(String(Date.now()));
    const nSym = (this.db.prepare("SELECT COUNT(*) c FROM symbols").get() as any).c;
    const nEdge = (this.db.prepare("SELECT COUNT(*) c FROM edges").get() as any).c;
    return { files: changed.length, symbols: nSym, edges: nEdge };
  }

  // -------------------------------------------------------------- queries
  search(query: string, limit = 20): Symbol[] {
    return this.db.prepare(
      `SELECT * FROM symbols WHERE name LIKE ?
       ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, name LIMIT ?`,
    ).all(`%${query}%`, query, limit) as unknown as Symbol[];
  }

  whoCalls(name: string, limit = 30): Edge[] {
    return this.db.prepare(
      "SELECT * FROM edges WHERE callee = ? ORDER BY path, line LIMIT ?",
    ).all(name, limit) as unknown as Edge[];
  }

  callsFrom(name: string, limit = 30): Edge[] {
    return this.db.prepare(
      "SELECT DISTINCT caller, callee, path, line FROM edges WHERE caller = ? ORDER BY line LIMIT ?",
    ).all(name, limit) as unknown as Edge[];
  }

  /** BFS shortest path over call edges: from -> ... -> to. */
  tracePath(from: string, to: string, maxDepth = 12): string[] | undefined {
    const next = this.db.prepare("SELECT DISTINCT callee FROM edges WHERE caller = ?");
    const prev = new Map<string, string>([[from, ""]]);
    let frontier = [from];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const upcoming: string[] = [];
      for (const node of frontier) {
        for (const row of next.all(node) as any[]) {
          const callee = row.callee as string;
          if (prev.has(callee)) continue;
          prev.set(callee, node);
          if (callee === to) {
            const chain = [to];
            let cur = to;
            while (prev.get(cur)) { cur = prev.get(cur)!; chain.unshift(cur); }
            return chain;
          }
          upcoming.push(callee);
        }
      }
      frontier = upcoming;
    }
    return undefined;
  }

  /** Call tree from an entry symbol, cycle-safe, for `faber map`. */
  callTree(entry: string, maxDepth = 4): string {
    const out: string[] = [];
    const seen = new Set<string>();
    const walkTree = (name: string, depth: number): void => {
      const mark = seen.has(name) ? " ↩ (seen)" : "";
      out.push(`${"  ".repeat(depth)}${name}${mark}`);
      if (seen.has(name) || depth >= maxDepth || out.length > 200) return;
      seen.add(name);
      for (const e of this.callsFrom(name, 15)) walkTree(e.callee, depth + 1);
    };
    walkTree(entry, 0);
    return out.join("\n");
  }

  /** Compact repo map (most-connected symbols) for system-prompt orientation. */
  repoMap(limit = 15): string {
    const rows = this.db.prepare(
      `SELECT s.name, s.kind, s.path,
              (SELECT COUNT(*) FROM edges e WHERE e.callee = s.name) +
              (SELECT COUNT(*) FROM edges e WHERE e.caller = s.name) AS degree
       FROM symbols s GROUP BY s.name, s.path
       ORDER BY degree DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.filter((r) => r.degree > 0)
      .map((r) => `${r.name} [${r.kind}] ${r.path} (${r.degree} connections)`)
      .join("\n");
  }

  isBuilt(): boolean {
    return this.db.prepare("SELECT value FROM meta WHERE key='built_at'").get() != null;
  }

  close(): void { this.db.close(); }
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) {
      try { if (fs.statSync(full).size <= 1_000_000) yield full; } catch { /* skip */ }
    }
  }
}
