/**
 * Code graph: one SQLite database, one engine for every language.
 *
 *   extract.ts    file  → definitions, call sites, imports   (tree-sitter or the generic scanner)
 *   resolve.ts    call  → the definition it means, or its candidates when the code is ambiguous
 *   indexer.ts    store, incremental refresh, queries        (this file)
 *
 * Symbols have readable, stable IDs: `path#Qualified.name`. Two functions with
 * the same name are two symbols; a call links to one of them only when scope,
 * imports or types say which. See docs/code-graph.md.
 *
 * refresh() compares file mtime/size, re-parses only changed files and
 * re-resolves only the calls those changes can affect. The result always
 * equals a clean build of the same files (asserted in test/graph.test.ts).
 * Static analysis is navigation help, not proof: dynamic dispatch, reflection
 * and generated code are invisible to it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractFile, grammarProblems, CLASS_KINDS, type FileFacts } from "./graph/extract.js";
import { languageFor, type Import, type ModuleIndex } from "./graph/languages.js";
import { EXPORT_HOPS, REACH_HOPS, Resolver, type GraphSource, type Resolution, type Status, type Sym } from "./graph/resolve.js";
export type { Sym as Symbol, Status } from "./graph/resolve.js";

const SCHEMA_VERSION = 23;
const SKIP_DIRS = new Set([
  ".git", ".faber", ".codewright", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".mypy_cache", ".pytest_cache", "target", ".next", "dist-test", "vendor", "Pods", ".gradle", "coverage",
]);
const MAX_FILE_BYTES = 1_000_000;
/** Files parsed per transaction during a large build. */
const BATCH = 400;

export interface IndexStats { files: number; symbols: number; edges: number; }
export interface IndexerOptions {
  /** Upper bound on indexed source files (default 20,000 or FABER_GRAPH_MAX_FILES). */
  maxFiles?: number;
  onProgress?: (done: number, total: number) => void;
}
/** One call site, joined with both of its ends. */
export interface Edge {
  path: string; line: number; name: string; recv: string; status: Status; via: string;
  caller_id: string; callee_id: string | null;
  /** Candidate definitions when status is "ambiguous" (at most 8). */
  candidates: string[]; candidate_count: number;
}
export interface TraceResult { status: "found" | "not_found" | "incomplete"; nodes: Sym[]; hops: Edge[]; reason?: string; }
export class AmbiguousSymbolError extends Error {}
export class SymbolNotFoundError extends Error {}

interface CallRow { id: number; path: string; caller_id: string; name: string; recv: string; is_new: number; line: number;
  status: Status; via: string; target_id: string | null; candidates: number; }

interface OldDef { name: string; kind: string; qualified: string; container: string; top: number; }

const posix = (p: string) => p.split(path.sep).join("/");
/** `a.b.c` → `c`; receivers that name nothing ("", "?", "self") → "". */
const lastSegment = (recv: string) => recv === "?" || recv === "self" ? "" : recv.slice(recv.lastIndexOf(".") + 1);
const dirOf = (file: string) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
const bounded = (value: number | undefined, fallback: number, max: number) =>
  value == null || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(max, Math.floor(value)));
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const EDGE = "status IN ('resolved','inferred')";
/** Paths that are test code: listed after everything else, and ranked lower in task context. */
const TEST_PATH = /(?:^|[/_.-])(?:tests?|fixtures|spec|__tests__)(?:[/_.-]|$)/i;
/** Matches the partial index on calls(caller_id); keep the text identical. */
const LINKED = "status IN ('resolved','inferred','ambiguous')";

/** Split identifiers into searchable words: parseConfig → "parseconfig parse config". */
export function searchTerms(text: string): string[] {
  const split = text.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
  return [...new Set([...(text.match(/[\p{L}\p{N}_$]+/gu) ?? []), ...(split.match(/[\p{L}\p{N}]+/gu) ?? [])].map(s => s.toLowerCase()))];
}
const STOP_WORDS = new Set(("a an and are as at be by can change code could do file files fix for from function functions how i " +
  "implement in into is it me method methods of on or please should that the this to update use want we what with would you").split(" "));

export class CodeIndexer {
  private db: DatabaseSync;
  private workspace: string;
  private running?: Promise<IndexStats>;
  private closed = false;
  private fts = true;
  private skipped = 0;
  /** What the most recent update that found changes had to do: files parsed and call sites re-resolved. */
  lastUpdate = { files: 0, calls: 0, full: false };

  constructor(dbPath: string, workspace: string, private options: IndexerOptions = {}) {
    // Resolve symlinked workspaces (/var vs /private/var on macOS) once, so paths are stable.
    try { this.workspace = fs.realpathSync(workspace); } catch { this.workspace = path.resolve(workspace); }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) this.reset();
  }

  /** The database is a cache: an older layout is dropped and rebuilt, never migrated. */
  private reset(): void {
    const objects = this.db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','trigger')").all() as { type: string; name: string }[];
    for (const o of objects.filter(o => o.type === "trigger")) this.db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
    for (const o of objects.filter(o => o.type === "table")) { try { this.db.exec(`DROP TABLE IF EXISTS "${o.name}"`); } catch { /* fts shadow table already gone */ } }
    this.db.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, lang TEXT, provider TEXT, imports TEXT, hints TEXT, default_export TEXT);
      CREATE TABLE symbols (id TEXT PRIMARY KEY, name TEXT, kind TEXT, path TEXT, line INTEGER, end_line INTEGER, column INTEGER,
        qualified TEXT, container TEXT, top INTEGER, signature TEXT, lang TEXT, family TEXT, provider TEXT);
      CREATE INDEX symbols_name ON symbols(name);
      CREATE INDEX symbols_path ON symbols(path);
      CREATE INDEX symbols_container ON symbols(container) WHERE container != '';
      CREATE TABLE bases (path TEXT, family TEXT, type TEXT, base TEXT);
      CREATE INDEX bases_type ON bases(type);
      CREATE INDEX bases_path ON bases(path);
      CREATE TABLE calls (id INTEGER PRIMARY KEY, path TEXT, caller_id TEXT, name TEXT, recv TEXT, is_new INTEGER, line INTEGER,
        status TEXT, via TEXT, target_id TEXT, candidates INTEGER, recv_last TEXT);
      CREATE INDEX calls_recv ON calls(recv_last) WHERE recv_last != '';
      CREATE TABLE deps (path TEXT, target TEXT, PRIMARY KEY (path, target)) WITHOUT ROWID;
      CREATE INDEX deps_target ON deps(target);
      CREATE TABLE aliases (path TEXT, name TEXT, alias TEXT);
      CREATE INDEX aliases_name ON aliases(name);
      CREATE INDEX aliases_path ON aliases(path);
      CREATE INDEX calls_path ON calls(path);
      CREATE INDEX calls_name ON calls(name);
      CREATE INDEX calls_target ON calls(target_id) WHERE target_id IS NOT NULL;
      CREATE INDEX calls_caller ON calls(caller_id) WHERE ${LINKED};
      CREATE TABLE candidates (call_id INTEGER, target_id TEXT);
      CREATE INDEX candidates_call ON candidates(call_id);
      CREATE INDEX candidates_target ON candidates(target_id);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE symbols_fts USING fts5(name, qualified, path, content='', contentless_delete=1);
        CREATE TRIGGER symbols_fts_delete AFTER DELETE ON symbols BEGIN DELETE FROM symbols_fts WHERE rowid=OLD.rowid; END;`);
    } catch { this.fts = false; /* SQLite without FTS5: context() falls back to LIKE */ }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ------------------------------------------------------------- building
  /** Re-parse everything. */
  build(): Promise<IndexStats> { return this.schedule(true); }
  /** Bring the graph up to date with the files on disk; cheap when nothing changed. */
  refresh(): Promise<IndexStats> { return this.schedule(false); }

  private schedule(rebuild: boolean): Promise<IndexStats> {
    // Concurrent callers share one update; a rebuild waits for it and then runs.
    if (this.running && !rebuild) return this.running;
    const next = (this.running ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.closed) throw new Error("Indexer is closed.");
      return this.update(rebuild);
    });
    this.running = next;
    void next.finally(() => { if (this.running === next) this.running = undefined; }).catch(() => {});
    return next;
  }

  private scan(): { files: Map<string, { mtime: number; size: number }>; goMods: string[] } {
    const files = new Map<string, { mtime: number; size: number }>(), goMods: string[] = [];
    const requested = this.options.maxFiles ?? Number(process.env.FABER_GRAPH_MAX_FILES ?? 20_000);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20_000;
    this.skipped = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        if (entry.name === "go.mod") goMods.push(posix(path.relative(this.workspace, full)));
        if (!languageFor(path.extname(entry.name)) || /\.min\.\w+$/.test(entry.name)) continue;
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        if (files.size >= limit) { this.skipped++; continue; }
        files.set(posix(path.relative(this.workspace, full)), { mtime: stat.mtimeMs, size: stat.size });
      }
    };
    walk(this.workspace);
    return { files, goMods };
  }

  private async update(rebuild: boolean): Promise<IndexStats> {
    const { files: current, goMods } = this.scan();
    const known = new Map((this.db.prepare("SELECT path,mtime,size FROM files").all() as { path: string; mtime: number; size: number }[]).map(r => [r.path, r]));
    const goModules: [string, string][] = [];
    for (const file of goMods) {
      try {
        const name = /^\s*module\s+(\S+)/m.exec(fs.readFileSync(path.join(this.workspace, file), "utf8"))?.[1];
        if (name) goModules.push([name, dirOf(file)]);
      } catch { /* unreadable go.mod: imports from it stay external */ }
    }
    goModules.sort((a, b) => b[0].length - a[0].length);
    const moduleKey = JSON.stringify(goModules);
    const changed = [...current.keys()].filter(p => { const k = known.get(p), c = current.get(p)!; return rebuild || !k || k.mtime !== c.mtime || k.size !== c.size; });
    const removed = [...known.keys()].filter(p => !current.has(p));
    const modulesChanged = moduleKey !== (this.meta("go_modules") ?? "[]");
    if (!changed.length && !removed.length && !modulesChanged && this.isBuilt()) return this.counts(0);

    // Small updates are one atomic transaction. A large build commits parsed files in
    // batches to bound memory, marked dirty until its final resolve pass has run.
    const multi = changed.length > BATCH;
    const added = changed.some(p => !known.has(p));
    // Resolve every call again only when nothing narrower is safe.
    const full = rebuild || modulesChanged || multi || !this.isBuilt() || this.meta("dirty") === "1";
    // What an incremental update must look at again (see resolve()).
    const names = new Set<string>(), typeNames = new Set<string>(), seeds = new Set<string>();
    const rebased = new Map<string, Set<string>>();
    let namespacesChanged = false;
    const setMeta = this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)");
    const transaction = (work: () => void): void => {
      this.db.exec("BEGIN");
      try { work(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    };
    let done = 0;
    const parse = async (batch: string[]): Promise<Map<string, FileFacts>> => {
      const parsed = new Map<string, FileFacts>();
      for (const rel of batch) {
        try {
          const facts = await extractFile(rel, fs.readFileSync(path.join(this.workspace, rel), "utf8"));
          if (facts) parsed.set(rel, facts);
        } catch { /* unreadable file: indexed as empty */ }
        if (++done % 25 === 0) { this.options.onProgress?.(done, changed.length); await new Promise<void>(resolve => setImmediate(resolve)); }
        if (this.closed) throw new Error("Indexer is closed.");
      }
      return parsed;
    };

    const store = (batch: string[], gone: string[], parsed: Map<string, FileFacts>): void => {
      const oldDefs = this.db.prepare("SELECT name,kind,qualified,container,top FROM symbols WHERE path=?");
      const oldFile = this.db.prepare("SELECT imports,default_export FROM files WHERE path=?");
      const oldBases = this.db.prepare("SELECT type,base FROM bases WHERE path=?");
      const drop = [
        this.db.prepare("DELETE FROM candidates WHERE call_id IN (SELECT id FROM calls WHERE path=?)"),
        ...["calls", "symbols", "bases", "files", "aliases"].map(t => this.db.prepare(`DELETE FROM ${t} WHERE path=?`)),
      ];
      // Import targets are compared (and rewritten if different) in resolve(); only a deleted file loses them here.
      const dropDeps = this.db.prepare("DELETE FROM deps WHERE path=?");
      for (const rel of gone) dropDeps.run(rel);
      for (const rel of [...batch, ...gone]) {
        const facts = parsed.get(rel);
        if (!full) this.diff(rel, facts, oldDefs.all(rel) as unknown as OldDef[], oldFile.get(rel) as { imports: string; default_export: string } | undefined,
          oldBases.all(rel) as { type: string; base: string }[], { names, typeNames, seeds, rebased, namespaces: () => { namespacesChanged = true; } });
        for (const statement of drop) statement.run(rel);
      }
      const insertFile = this.db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?)");
      const insertSymbol = this.db.prepare("INSERT INTO symbols VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const insertFts = this.fts ? this.db.prepare("INSERT INTO symbols_fts(rowid,name,qualified,path) VALUES (?,?,?,?)") : undefined;
      const insertBase = this.db.prepare("INSERT INTO bases VALUES (?,?,?,?)");
      const insertAlias = this.db.prepare("INSERT INTO aliases VALUES (?,?,?)");
      const insertCall = this.db.prepare("INSERT INTO calls (path,caller_id,name,recv,is_new,line,status,via,target_id,candidates,recv_last) VALUES (?,?,?,?,?,?,'unresolved','',NULL,0,?)");
      for (const rel of batch) {
        const stat = current.get(rel)!, facts = parsed.get(rel);
        insertFile.run(rel, stat.mtime, stat.size, facts?.lang ?? "", facts?.provider ?? "", JSON.stringify(facts?.imports ?? []), JSON.stringify(facts?.hints ?? {}),
          facts?.defaultExport ?? "");
        if (!facts) continue;
        const ids = facts.defs.map(d => `${rel}#${d.qualified}`), pathTerms = searchTerms(rel).join(" ");
        facts.defs.forEach((d, i) => {
          const row = insertSymbol.run(ids[i]!, d.name, d.kind, rel, d.line, d.endLine, d.column, d.qualified, d.container, d.top ? 1 : 0,
            d.signature, facts.lang, facts.family, facts.provider);
          if (d.kind !== "namespace") insertFts?.run(row.lastInsertRowid, searchTerms(d.name).join(" "), searchTerms(d.qualified).join(" "), pathTerms);
        });
        for (const [type, base] of [...facts.bases].sort()) insertBase.run(rel, facts.family, type, base);
        for (const imp of facts.imports) if (imp.name && imp.name !== "*" && imp.alias && imp.alias !== imp.name) insertAlias.run(rel, imp.name, imp.alias);
        for (const c of facts.calls) insertCall.run(rel, c.caller < 0 ? "" : ids[c.caller]!, c.name, c.recv, c.isNew ? 1 : 0, c.line, lastSegment(c.recv));
      }
    };

    const resolve = (): void => {
      const resolver = new Resolver(this.source(goModules));
      const symbol = this.db.prepare("SELECT * FROM symbols WHERE id=?"), callers = new Map<string, Sym | undefined>();
      const setCall = this.db.prepare("UPDATE calls SET status=?,via=?,target_id=?,candidates=? WHERE id=?");
      const dropCandidates = this.db.prepare("DELETE FROM candidates WHERE call_id=?"), addCandidate = this.db.prepare("INSERT INTO candidates VALUES (?,?)");
      const getCandidates = this.db.prepare("SELECT target_id FROM candidates WHERE call_id=? ORDER BY target_id");
      const seen = new Set<number>();
      let examined = 0;
      const apply = (row: CallRow): void => {
        if (!full) { if (seen.has(row.id)) return; seen.add(row.id); }
        examined++;
        const spec = languageFor(path.extname(row.path));
        if (!spec) return;
        let caller: Sym | undefined;
        if (row.caller_id) {
          if (!callers.has(row.caller_id)) callers.set(row.caller_id, symbol.get(row.caller_id) as unknown as Sym | undefined);
          caller = callers.get(row.caller_id);
        }
        const r: Resolution = resolver.resolve(row.path, spec, { name: row.name, recv: row.recv, isNew: !!row.is_new }, caller);
        const target = r.status === "resolved" || r.status === "inferred" ? r.targets[0]! : null;
        const candidates = r.status === "ambiguous" ? r.targets : [];
        if (row.status === r.status && row.via === r.via && row.target_id === target && row.candidates === r.count &&
          (r.status !== "ambiguous" || (getCandidates.all(row.id) as { target_id: string }[]).map(c => c.target_id).join("\0") === candidates.join("\0"))) return;
        setCall.run(r.status, r.via, target, r.count, row.id);
        if (row.status === "ambiguous") dropCandidates.run(row.id);
        for (const id of candidates) addCandidate.run(row.id, id);
      };

      // Import targets per file. They can shift for any file when the set of files (or namespaces) changes.
      const everyFile = full || added || removed.length > 0 || namespacesChanged;
      const paths = everyFile ? (this.db.prepare("SELECT path FROM files").all() as { path: string }[]).map(r => r.path) : changed;
      if (full) this.db.exec("DELETE FROM deps");
      const before = new Map<string, string[]>();
      const note = (row: { path: string; target: string }) => { const list = before.get(row.path); if (list) list.push(row.target); else before.set(row.path, [row.target]); };
      if (everyFile) for (const row of this.db.prepare("SELECT path,target FROM deps ORDER BY path,target").all() as { path: string; target: string }[]) note(row);
      else { const own = this.db.prepare("SELECT path,target FROM deps WHERE path=? ORDER BY target"); for (const file of changed) for (const row of own.all(file) as { path: string; target: string }[]) note(row); }
      const dropDeps = this.db.prepare("DELETE FROM deps WHERE path=?"), addDep = this.db.prepare("INSERT OR IGNORE INTO deps VALUES (?,?)");
      for (const file of paths) {
        const now = resolver.directDeps(file);
        if ((before.get(file) ?? []).join("\0") === now.join("\0")) continue;
        seeds.add(file);
        dropDeps.run(file);
        for (const target of now) addDep.run(file, target);
      }

      if (full) {
        const page = this.db.prepare("SELECT * FROM calls WHERE id>? ORDER BY id LIMIT 20000");
        for (let after = 0; ;) {
          const rows = page.all(after) as unknown as CallRow[];
          if (!rows.length) break;
          for (const row of rows) apply(row);
          after = rows[rows.length - 1]!.id;
        }
      } else {
        // 1. Files whose view of the repository changed: every file that can reach a file whose imports,
        //    default export or import targets changed (re-exports and reachability), plus the edited files.
        const affected = new Set<string>(seeds);
        const importers = this.db.prepare("SELECT path FROM deps WHERE target=?");
        let frontier = [...seeds];
        for (let hop = 0; hop <= Math.max(REACH_HOPS, EXPORT_HOPS) && frontier.length; hop++) {
          const next: string[] = [];
          for (const file of frontier) for (const { path: importer } of importers.all(file) as { path: string }[]) if (!affected.has(importer)) { affected.add(importer); next.push(importer); }
          frontier = next;
        }
        const byPath = this.db.prepare("SELECT * FROM calls WHERE path=?");
        for (const file of new Set([...changed, ...affected])) for (const row of byPath.all(file) as unknown as CallRow[]) apply(row);

        // 2. Calls anywhere that use a name whose definitions changed — under that name or an import alias of it.
        const alias = this.db.prepare("SELECT DISTINCT alias FROM aliases WHERE name=?");
        const withAliases = (set: Set<string>) => { for (const name of [...set]) for (const row of alias.all(name) as { alias: string }[]) set.add(row.alias); };
        // Methods are found through a type and its supertypes. When a supertype link changed, a type name
        // appeared or vanished, or the file declaring a link sees different files, every method on that
        // line of descent can now mean something else, wherever it is called.
        const declared = this.db.prepare("SELECT DISTINCT type FROM bases WHERE path=?");
        for (const file of affected) for (const row of declared.all(file) as { type: string }[]) if (!rebased.has(row.type)) rebased.set(row.type, new Set());
        for (const type of typeNames) if (!rebased.has(type)) rebased.set(type, new Set());
        if (rebased.size) {
          const parents = this.db.prepare("SELECT DISTINCT base FROM bases WHERE type=?"), methods = this.db.prepare("SELECT DISTINCT name FROM symbols WHERE container=?");
          const lineage = new Set<string>();
          const climb = (type: string): void => {
            if (lineage.has(type)) return;
            lineage.add(type);
            for (const row of parents.all(type) as { base: string }[]) climb(row.base);
          };
          for (const [type, previous] of rebased) { climb(type); for (const parent of previous) climb(parent); }
          for (const type of lineage) for (const row of methods.all(type) as { name: string }[]) names.add(row.name);
        }
        withAliases(names); withAliases(typeNames);
        const byName = this.db.prepare("SELECT * FROM calls WHERE name=?"), byReceiver = this.db.prepare("SELECT * FROM calls WHERE recv_last=? AND recv_last != ''");
        for (const name of names) for (const row of byName.all(name) as unknown as CallRow[]) apply(row);
        // 3. Calls on a receiver named like a type that appeared, disappeared or changed kind.
        for (const name of typeNames) for (const row of byReceiver.all(name) as unknown as CallRow[]) apply(row);
      }
      setMeta.run("go_modules", moduleKey);
      setMeta.run("built_at", String(Date.now()));
      setMeta.run("generation", String(this.generation() + 1));
      setMeta.run("skipped", String(this.skipped));
      setMeta.run("dirty", "0");
      this.lastUpdate = { files: changed.length, calls: examined, full };
    };

    if (!multi) {
      const parsed = await parse(changed);
      transaction(() => { store(changed, removed, parsed); resolve(); });
    } else {
      setMeta.run("dirty", "1");
      for (let offset = 0; offset < changed.length; offset += BATCH) {
        const batch = changed.slice(offset, offset + BATCH), parsed = await parse(batch);
        transaction(() => store(batch, offset ? [] : removed, parsed));
      }
      transaction(resolve);
    }
    this.options.onProgress?.(changed.length, changed.length);
    return this.counts(changed.length + removed.length);
  }

  /**
   * Compare a file's old and new facts and record what other files could notice:
   * names whose definitions changed, type names that appeared or vanished, types
   * whose supertypes changed, and whether its imports or default export moved.
   * Line numbers, bodies and signatures are deliberately not part of this.
   */
  private diff(rel: string, facts: FileFacts | undefined, defs: OldDef[], file: { imports: string; default_export: string } | undefined,
    bases: { type: string; base: string }[], out: { names: Set<string>; typeNames: Set<string>; seeds: Set<string>; rebased: Map<string, Set<string>>; namespaces: () => void }): void {
    const group = <T>(items: T[], key: (item: T) => string, value: (item: T) => string) => {
      const map = new Map<string, string[]>();
      for (const item of items) { const list = map.get(key(item)); if (list) list.push(value(item)); else map.set(key(item), [value(item)]); }
      for (const list of map.values()) list.sort();
      return map;
    };
    const differing = (a: Map<string, string[]>, b: Map<string, string[]>) =>
      [...new Set([...a.keys(), ...b.keys()])].filter(key => (a.get(key) ?? []).join("\n") !== (b.get(key) ?? []).join("\n"));
    const now = facts?.defs ?? [];
    const changedNames = differing(group(defs, d => d.name, d => `${d.kind}\0${d.qualified}\0${d.container}\0${d.top}`),
      group(now, d => d.name, d => `${d.kind}\0${d.qualified}\0${d.container}\0${d.top ? 1 : 0}`));
    for (const name of changedNames) out.names.add(name);
    const isType = (d: { kind: string }) => CLASS_KINDS.has(d.kind);
    for (const name of differing(group(defs.filter(isType), d => d.name, d => d.kind), group(now.filter(isType), d => d.name, d => d.kind))) out.typeNames.add(name);
    const namespaces = (list: { kind: string; qualified: string }[]) => list.filter(d => d.kind === "namespace").map(d => d.qualified).sort().join("\n");
    if (namespaces(defs) !== namespaces(now)) {
      // Joining or leaving a namespace shows or hides everything in the file to that namespace's other files.
      out.namespaces();
      for (const d of [...defs, ...now]) out.names.add(d.name);
    }
    const oldBases = group(bases, b => b.type, b => b.base);
    for (const type of differing(oldBases, group(facts?.bases ?? [], b => b[0], b => b[1]))) {
      const previous = out.rebased.get(type) ?? new Set<string>();
      for (const base of oldBases.get(type) ?? []) previous.add(base);
      out.rebased.set(type, previous);
    }
    // Importers reach other files through this one's imports, and bind its default export under their own names.
    const defaultBefore = file?.default_export ?? "", defaultNow = facts?.defaultExport ?? "";
    if ((file?.imports ?? "[]") !== JSON.stringify(facts?.imports ?? []) || defaultBefore !== defaultNow ||
      changedNames.some(name => name === defaultBefore || name === defaultNow)) out.seeds.add(rel);
  }

  /** Keyed, cached lookups for the resolver, valid for one update. */
  private source(goModules: [string, string][]): GraphSource {
    const files = (this.db.prepare("SELECT path FROM files").all() as { path: string }[]).map(r => r.path);
    const fileSet = new Set(files), byBase = new Map<string, string[]>(), byDir = new Map<string, string[]>(), dirsByLeaf = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, value: string) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
    for (const file of files) {
      push(byBase, file.slice(file.lastIndexOf("/") + 1), file);
      const dir = dirOf(file);
      if (!byDir.has(dir)) push(dirsByLeaf, dir.slice(dir.lastIndexOf("/") + 1), dir);
      push(byDir, dir, file);
    }
    const namespace = this.db.prepare("SELECT DISTINCT path FROM symbols WHERE kind='namespace' AND (qualified=? OR qualified LIKE ? ESCAPE '\\')");
    const modules: ModuleIndex = {
      has: file => fileSet.has(file),
      suffix: tail => (byBase.get(tail.slice(tail.lastIndexOf("/") + 1)) ?? []).filter(f => f === tail || f.endsWith("/" + tail)),
      dirs: tail => (dirsByLeaf.get(tail.slice(tail.lastIndexOf("/") + 1)) ?? []).filter(d => d === tail || d.endsWith("/" + tail)),
      inDir: dir => byDir.get(dir) ?? [],
      goModules,
      namespace: name => (namespace.all(name, `${escapeLike(name)}~%`) as { path: string }[]).map(r => r.path),
    };
    const cached = <T>(load: (key: string) => T) => { const map = new Map<string, T>(); return (key: string): T => { let v = map.get(key); if (v === undefined) { v = load(key); map.set(key, v); } return v; }; };
    const byName = this.db.prepare("SELECT * FROM symbols WHERE family=? AND name=? ORDER BY id");
    const inFile = this.db.prepare("SELECT * FROM symbols WHERE path=? ORDER BY id");
    const bases = this.db.prepare("SELECT DISTINCT base, path FROM bases WHERE family=? AND type=? ORDER BY base, path");
    const file = this.db.prepare("SELECT imports,hints,default_export FROM files WHERE path=?");
    const names = cached(key => { const [family, name] = key.split("\0"); return byName.all(family!, name!) as unknown as Sym[]; });
    const inFiles = cached(key => inFile.all(key) as unknown as Sym[]);
    const supers = cached(key => { const [family, type] = key.split("\0"); return bases.all(family!, type!) as { base: string; path: string }[]; });
    const fileRow = cached(key => {
      const row = file.get(key) as { imports: string; hints: string; default_export: string } | undefined;
      return { imports: JSON.parse(row?.imports ?? "[]") as Import[], hints: JSON.parse(row?.hints ?? "{}") as Record<string, string[]>,
        defaultExport: row?.default_export ?? "" };
    });
    return { modules, byName: (family, name) => names(`${family}\0${name}`), inFile: inFiles,
      basesOf: (family, type) => supers(`${family}\0${type}`), imports: p => fileRow(p).imports, hints: p => fileRow(p).hints,
      defaultExport: p => fileRow(p).defaultExport };
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private counts(files: number): IndexStats {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return { files, symbols: one("SELECT COUNT(*) c FROM symbols"), edges: one(`SELECT COUNT(*) c FROM calls WHERE ${EDGE}`) };
  }
  generation(): number { return Number(this.meta("generation") ?? 0); }
  isBuilt(): boolean { return this.meta("built_at") != null; }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }

  // -------------------------------------------------------------- queries
  /** Definitions whose name or qualified name contains the query; exact names first. */
  search(query: string, limit = 20): Sym[] {
    const like = `%${escapeLike(query)}%`;
    return this.db.prepare(`SELECT * FROM symbols WHERE kind!='namespace' AND (name LIKE ? ESCAPE '\\' OR qualified LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN name=? THEN 0 WHEN name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, path, line LIMIT ?`)
      .all(like, like, query, `${escapeLike(query)}%`, bounded(limit, 20, 100)) as unknown as Sym[];
  }

  /**
   * Every definition a selector can mean. Accepts an exact ID (`src/a.ts#Store.save`),
   * a qualified name (`Store.save`), a bare name (`save`) or an ID suffix (`a.ts#save`).
   */
  find(selector: string, limit = 20): Sym[] {
    const exact = this.db.prepare("SELECT * FROM symbols WHERE id=?").get(selector) as unknown as Sym | undefined;
    if (exact) return [exact];
    // Every match is named by the selector's last segment, so the name index does the work.
    const n = bounded(limit, 20, 100), wanted = selector.slice(selector.indexOf("#") + 1);
    const rows = this.db.prepare("SELECT * FROM symbols WHERE name=? AND kind!='namespace' ORDER BY id LIMIT 5000")
      .all(wanted.slice(wanted.lastIndexOf(".") + 1).replace(/~\d+$/, "")) as unknown as Sym[];
    // `~2` marks a later overload or redefinition of the same qualified name.
    const plain = (text: string) => text.replace(/~\d+$/, "");
    const fits = (qualified: string) => qualified === selector || qualified.endsWith(`.${selector}`);
    return rows.filter(s => selector.includes("#") ? s.id.endsWith(selector) || plain(s.id).endsWith(selector)
      : fits(s.qualified) || fits(plain(s.qualified))).slice(0, n);
  }

  /** Exactly one definition, or an error that lists the choices. */
  one(selector: string): Sym {
    const found = this.find(selector, 21);
    if (!found.length) throw new SymbolNotFoundError(`No symbol matches '${selector}'. Use search_code to find its ID.`);
    if (found.length > 1) throw new AmbiguousSymbolError(`'${selector}' matches ${found.length > 20 ? "more than 20" : found.length} definitions. Pass one of these IDs:\n` +
      found.slice(0, 20).map(s => `  ${s.id}  (${s.kind}, line ${s.line})`).join("\n"));
    return found[0]!;
  }
  symbol(id: string): Sym | undefined { return this.db.prepare("SELECT * FROM symbols WHERE id=?").get(id) as unknown as Sym | undefined; }

  private edges(rows: CallRow[]): Edge[] {
    const candidates = this.db.prepare("SELECT target_id FROM candidates WHERE call_id=? ORDER BY target_id");
    return rows.map(r => ({ path: r.path, line: r.line, name: r.name, recv: r.recv, status: r.status, via: r.via, caller_id: r.caller_id,
      callee_id: r.target_id, candidate_count: r.candidates,
      candidates: r.status === "ambiguous" ? (candidates.all(r.id) as { target_id: string }[]).map(c => c.target_id) : [] }));
  }

  /**
   * Call sites that reach this definition. Non-test code comes first, then tests; within each,
   * resolved, then inferred, then possible (ambiguous) — so a cut-off list never hides the one
   * production caller behind dozens of test calls.
   */
  whoCalls(id: string, limit = 30): Edge[] {
    const sure = this.db.prepare(`SELECT * FROM calls WHERE target_id=? AND ${EDGE} LIMIT 5000`).all(id) as unknown as CallRow[];
    const maybe = this.db.prepare("SELECT c.* FROM candidates k JOIN calls c ON c.id=k.call_id WHERE k.target_id=? LIMIT 5000").all(id) as unknown as CallRow[];
    const rank = (r: CallRow) => (TEST_PATH.test(r.path) ? 3 : 0) + (r.status === "resolved" ? 0 : r.status === "inferred" ? 1 : 2);
    const rows = [...sure, ...maybe].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.id - b.id));
    return this.edges(rows.slice(0, bounded(limit, 30, 500)));
  }

  /** How many call sites whoCalls() has for this definition, by kind. */
  callerCounts(id: string): { total: number; resolved: number; inferred: number; ambiguous: number; outsideTests: number } {
    const rows = [...this.db.prepare(`SELECT path,status FROM calls WHERE target_id=? AND ${EDGE}`).all(id) as { path: string; status: Status }[],
      ...this.db.prepare("SELECT c.path, c.status FROM candidates k JOIN calls c ON c.id=k.call_id WHERE k.target_id=?").all(id) as { path: string; status: Status }[]];
    const count = (status: Status) => rows.filter(r => r.status === status).length;
    return { total: rows.length, resolved: count("resolved"), inferred: count("inferred"), ambiguous: count("ambiguous"), outsideTests: rows.filter(r => !TEST_PATH.test(r.path)).length };
  }

  /** Calls made inside this definition (for a class: inside any of its members). */
  callsFrom(id: string, limit = 40): Edge[] {
    return this.edges(this.db.prepare(`SELECT * FROM calls WHERE (caller_id=? OR caller_id LIKE ? ESCAPE '\\') AND ${LINKED} ORDER BY path, line, id LIMIT ?`)
      .all(id, `${escapeLike(id)}.%`, bounded(limit, 40, 200)) as unknown as CallRow[]);
  }

  /** Every call site recorded in a file, including unresolved and external ones. */
  callsIn(file: string): Edge[] {
    return this.edges(this.db.prepare("SELECT * FROM calls WHERE path=? ORDER BY line, id").all(file) as unknown as CallRow[]);
  }

  /**
   * Shortest chain of calls from one definition to another. Resolved calls are
   * tried first; name-only (inferred) calls are followed only if that finds nothing.
   */
  trace(from: string, to: string, maxDepth = 12): TraceResult {
    const start = this.one(from), goal = this.one(to);
    if (start.id === goal.id) return { status: "found", nodes: [start], hops: [] };
    const strict = this.searchPath(start, goal, maxDepth, "status='resolved'");
    return strict.status === "found" ? strict : this.searchPath(start, goal, maxDepth, EDGE);
  }
  private searchPath(start: Sym, goal: Sym, maxDepth: number, statuses: string): TraceResult {
    // The starting definition includes its members (trace from a class); later hops are exact.
    const next = this.db.prepare(`SELECT * FROM calls WHERE (caller_id=? OR caller_id LIKE ? ESCAPE '\\') AND ${LINKED} AND ${statuses} ORDER BY line, id`);
    const within = (node: string) => node === start.id ? `${escapeLike(node)}.%` : node;
    const previous = new Map<string, { hop: CallRow; from: string }>(), seen = new Set([start.id]);
    let frontier = [start.id], examined = 0;
    const depthLimit = bounded(maxDepth, 12, 64);
    for (let depth = 0; depth < depthLimit && frontier.length; depth++) {
      const upcoming: string[] = [];
      for (const node of frontier) for (const hop of next.all(node, within(node)) as unknown as CallRow[]) {
        if (++examined > 50_000 || seen.size > 10_000) return { status: "incomplete", nodes: [], hops: [], reason: "Search budget reached (10,000 symbols / 50,000 calls)." };
        const id = hop.target_id!;
        if (seen.has(id)) continue;
        seen.add(id); previous.set(id, { hop, from: node });
        if (id === goal.id) {
          const hops: CallRow[] = [];
          for (let cur = id; cur !== start.id; cur = previous.get(cur)!.from) hops.unshift(previous.get(cur)!.hop);
          return { status: "found", nodes: [start, ...hops.map(h => this.symbol(h.target_id!)!)], hops: this.edges(hops) };
        }
        upcoming.push(id);
      }
      frontier = upcoming;
    }
    return { status: frontier.length ? "incomplete" : "not_found", nodes: [], hops: [],
      reason: frontier.length ? `No path within ${depthLimit} calls.` : "No chain of resolved calls connects them. Ambiguous, dynamic and external calls are not followed." };
  }

  /** Indented call tree from one definition; cycle-safe and bounded. */
  callTree(entry: string, maxDepth = 4): string {
    const root = this.one(entry);
    const out: string[] = [], seen = new Set<string>(), depthLimit = bounded(maxDepth, 4, 12);
    const next = this.db.prepare(`SELECT s.*, MIN(c.line) AS first FROM calls c JOIN symbols s ON s.id=c.target_id
      WHERE (c.caller_id=? OR c.caller_id LIKE ? ESCAPE '\\') AND c.${LINKED} AND c.${EDGE} GROUP BY s.id ORDER BY first, s.id LIMIT 16`);
    const visit = (s: Sym, depth: number): void => {
      if (out.length >= 200) return;
      const again = seen.has(s.id);
      out.push(`${"  ".repeat(depth)}${s.qualified} (${s.path}:${s.line})${again ? " ↩" : ""}`);
      if (again || depth >= depthLimit) return;
      seen.add(s.id);
      const children = next.all(s.id, s.id === root.id ? `${escapeLike(s.id)}.%` : s.id) as unknown as Sym[];
      for (const child of children.slice(0, 15)) if (child.id !== s.id) visit(child, depth + 1);
      if (children.length > 15 && out.length < 200) out.push(`${"  ".repeat(depth + 1)}… more calls omitted`);
    };
    visit(root, 0);
    if (out.length >= 200) out.push("… tree truncated at 200 lines");
    return out.join("\n");
  }

  /** The most-called definitions, one line each, counted per definition (not per name), resolved calls only. */
  repoMap(limit = 15): string {
    const rows = this.db.prepare(`SELECT s.*, COUNT(*) AS callers FROM calls c JOIN symbols s ON s.id=c.target_id
      WHERE c.status='resolved' GROUP BY s.id ORDER BY callers DESC, s.id LIMIT ?`).all(bounded(limit, 15, 100)) as unknown as (Sym & { callers: number })[];
    return rows.map(r => `${r.qualified} [${r.kind}] ${r.path}:${r.line} (${r.callers} call${r.callers === 1 ? "" : "s"})`).join("\n");
  }

  /**
   * Task-specific context: definitions whose names, paths or signatures match the
   * task's words, plus their direct callers and callees, within a token budget.
   */
  context(query: string, tokenBudget = 1500): string {
    const budget = bounded(tokenBudget, 1500, 8000) * 3;
    const words = searchTerms(query.slice(0, 4000)).filter(w => w.length > 1 && !STOP_WORDS.has(w)).slice(0, 16);
    if (!words.length || !budget || !this.isBuilt()) return "";
    const literal = new Set((query.match(/[\w$]+(?:[./#:-][\w$]+)*/g) ?? []).map(s => s.toLowerCase()));
    let rows: Sym[];
    if (this.fts) {
      rows = this.db.prepare(`SELECT s.* FROM symbols_fts JOIN symbols s ON s.rowid=symbols_fts.rowid WHERE symbols_fts MATCH ?
        ORDER BY bm25(symbols_fts,10,8,4), s.id LIMIT 200`).all(words.map(w => `"${w.replace(/"/g, '""')}"*`).join(" OR ")) as unknown as Sym[];
    } else {
      const clause = words.map(() => "(name LIKE ? OR path LIKE ?)").join(" OR ");
      rows = this.db.prepare(`SELECT * FROM symbols WHERE kind!='namespace' AND (${clause}) ORDER BY id LIMIT 200`)
        .all(...words.flatMap(w => [`%${w}%`, `%${w}%`])) as unknown as Sym[];
    }
    const score = (s: Sym): number => {
      let value = 0;
      if (literal.has(s.name.toLowerCase())) value += 60;
      if (literal.has(s.qualified.toLowerCase())) value += 40;
      if ([...literal].some(l => l.includes("/") && s.path.toLowerCase().endsWith(l))) value += 80;
      for (const [text, weight] of [[s.name, 12], [s.qualified, 6], [s.path, 4]] as const) {
        const terms = searchTerms(text);
        value += words.filter(w => terms.some(t => t === w || t.startsWith(w))).length * weight;
      }
      return TEST_PATH.test(s.path) && !words.some(w => /^(?:test|spec|fixture)/.test(w)) ? value * 0.7 : value;
    };
    const ranked = new Map(rows.map(s => [s.id, { symbol: s, score: score(s), why: "" }]));
    const seeds = [...ranked.values()].sort((a, b) => b.score - a.score || (a.symbol.id < b.symbol.id ? -1 : 1)).slice(0, 6);
    const out = this.db.prepare(`SELECT DISTINCT target_id AS id FROM calls WHERE caller_id=? AND ${LINKED} AND ${EDGE} LIMIT 12`);
    const into = this.db.prepare(`SELECT DISTINCT caller_id AS id FROM calls WHERE target_id=? AND ${EDGE} AND caller_id!='' LIMIT 12`);
    for (const seed of seeds) for (const [statement, label] of [[out, "called by"], [into, "calls"]] as const) {
      for (const { id } of statement.all(seed.symbol.id) as { id: string }[]) {
        const neighbor = ranked.get(id)?.symbol ?? this.symbol(id);
        if (!neighbor || neighbor.id === seed.symbol.id) continue;
        const value = score(neighbor) + seed.score * 0.3, existing = ranked.get(id);
        if (!existing || value > existing.score) ranked.set(id, { symbol: neighbor, score: value, why: `${label} ${seed.symbol.qualified}` });
      }
    }
    const header = "Relevant definitions from the code graph (static hints; read the source to confirm behavior):\n";
    let text = header; const perFile = new Map<string, number>(); let shown = 0;
    for (const item of [...ranked.values()].sort((a, b) => b.score - a.score || (a.symbol.id < b.symbol.id ? -1 : 1))) {
      const s = item.symbol, count = perFile.get(s.path) ?? 0;
      if (count >= 4 || shown >= 24) continue;
      const line = `${s.id}  [${s.kind}] line ${s.line}${item.why ? `  (${item.why})` : ""}\n    ${s.signature}\n`;
      if (Buffer.byteLength(text + line) > budget) break;
      text += line; perFile.set(s.path, count + 1); shown++;
    }
    return shown ? text : "";
  }

  /** What the graph covers, in a few lines. */
  coverage(): string {
    if (!this.isBuilt()) return "Code graph has not been built.";
    const langs = this.db.prepare("SELECT lang, provider, COUNT(*) AS n FROM files WHERE lang!='' GROUP BY lang, provider ORDER BY n DESC").all() as { lang: string; provider: string; n: number }[];
    const status = new Map((this.db.prepare("SELECT status, COUNT(*) AS n FROM calls GROUP BY status").all() as { status: string; n: number }[]).map(r => [r.status, r.n]));
    const n = (s: string) => status.get(s) ?? 0;
    const lines = [
      `Languages: ${langs.map(l => `${l.lang} ${l.n}${l.provider === "generic" ? " (generic scanner)" : ""}`).join(", ") || "none"}.`,
      `Calls: ${n("resolved")} resolved, ${n("inferred")} inferred by unique name, ${n("ambiguous")} ambiguous, ${n("external")} external, ${n("unresolved")} unresolved.`,
    ];
    const skipped = Number(this.meta("skipped") ?? 0);
    if (skipped) lines.push(`${skipped} files beyond the file limit were not indexed (FABER_GRAPH_MAX_FILES).`);
    for (const [grammar, problem] of grammarProblems) lines.push(`Grammar ${grammar} unavailable, using the generic scanner: ${problem}`);
    return lines.join("\n");
  }
}

/**
 * One line per call site, for tool output. `about` names the definition the reply is already
 * about, so it is not repeated on every line: "callee" for who_calls, "caller" for calls_from.
 */
export function formatEdge(edge: Edge, indexer: CodeIndexer, about?: "callee" | "caller"): string {
  const caller = edge.caller_id ? indexer.symbol(edge.caller_id)?.qualified ?? edge.caller_id : "<module>";
  const from = about === "caller" ? `line ${edge.line}  ${caller}` : `${edge.path}:${edge.line}  ${caller}`;
  if (edge.status === "ambiguous") {
    const more = edge.candidate_count > edge.candidates.length ? ` (+${edge.candidate_count - edge.candidates.length} more)` : "";
    return `${from} → ${edge.name}()  [ambiguous: ${edge.candidates.join(" | ")}${more}]`;
  }
  if (!edge.callee_id) return `${from} → ${edge.recv && edge.recv !== "?" ? edge.recv + "." : ""}${edge.name}()  [${edge.status}]`;
  const why = edge.status === "inferred" ? "inferred: name match only" : edge.via;
  return about === "callee" ? `${from}  [${why}]` : `${from} → ${edge.callee_id}  [${why}]`;
}
export { CLASS_KINDS };
