/**
 * Incremental code graph with qualified, source-grounded symbol identities.
 *
 * Nodes:  symbols (functions, classes, ...) as before.
 * Edges:  calls   (enclosing function -> called name, resolved against the
 *                  symbol table) and imports (file -> file/module).
 * Incremental: refresh() checks saved-file metadata and parses only changed
 * files. Cached call references let definition additions/removals update
 * unchanged callers too. The CLI coalesces saved-file updates in its worker;
 * unsaved editor buffers are outside this index. Current reads verify freshness
 * without waiting for an analyzer or exposing stale call bindings.
 *
 * Local language servers provide source-located static call hierarchies through
 * one shared adapter. A project TypeScript compiler remains a fallback. Providers
 * are optional and never installed automatically. Missing analysis retains labeled
 * heuristic hints, which are never composed into paths. Static calls do not prove
 * runtime dispatch. Complete native inventories select dependency components;
 * unavailable or incomplete inventories retain broad provider refresh.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type * as TS from "typescript";
import { discoverProviders, LANGUAGE_SERVERS, type LspProviderConfig } from "./graph/providers.js";
import { LspGraph, type ProviderFacts } from "./graph/lsp.js";
import { AnalyzerCacheStore, factHash, type CacheContext, type DependencyProgress } from "./graph/cache.js";
import { canonicalPath, dependencyInputStamp } from "./graph/dependencies.js";
import { TaskContextIndex, type ContextOptions, type TaskContext } from "./graph/context.js";
import { ChangeJournal, type ChangeList, type FileChange } from "./graph/changes.js";
export type { ChangeList, FileChange } from "./graph/changes.js";
import { GRAPH_SKIP_DIRS, environmentKey, AnalysisTimer, type AnalysisProgress, type CurrentGraph, type LiveMethod, type LiveValues } from "./graph/live.js";
export type { ContextOptions, TaskContext } from "./graph/context.js";

const SKIP_DIRS = GRAPH_SKIP_DIRS;

type Pattern = [kind: string, regex: RegExp];
const JS_ARROW = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^;]*?\)\s*(?::[^=;]+?)?\s*=>/;
// Modifiers distinguish methods from calls; a generator's star needs no space.
const JS_METHOD = /^\s{2,}(?:(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)+(?:\*\s*)?|\*\s*)(\w+)\s*(?:<[^>]*>)?\s*\(/;
const LANG: Record<string, Pattern[]> = {
  ".py": [["function", /^\s*(?:async\s+)?def\s+(\w+)/], ["class", /^\s*class\s+(\w+)/]],
  ".js": [["function", /function\s+(\w+)/], ["class", /class\s+(\w+)/],
          ["function", JS_ARROW], ["method", JS_METHOD]],
  ".ts": [["function", /function\s+(\w+)/], ["class", /class\s+(\w+)/],
          ["interface", /interface\s+(\w+)/], ["type", /^\s*type\s+(\w+)\s*=/],
          ["function", JS_ARROW], ["method", JS_METHOD]],
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
LANG[".mts"] = LANG[".ts"]!; LANG[".cts"] = LANG[".ts"]!;
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
  "extends", "implements",
]);
// Python hard keywords cannot be callees. Keep this language-specific: names
// such as `or`, `and`, and `not` are valid identifiers in other languages.
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);
export function isLanguageKeyword(name: string, ext: string): boolean {
  return (ext === ".py" || ext === ".pyi") && PYTHON_KEYWORDS.has(name);
}
const CALL_RX = /(\w+)\s*\(/g;
// Invalidate cached facts once so old Python keyword references are removed.
const PARSER_VERSION = "7";
const JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

interface FileStamp { mtime_ms: number; ctime_ms: number | null; size: number | null; }
const sameStamp = (a: FileStamp, b: FileStamp) => a.mtime_ms === b.mtime_ms && a.ctime_ms === b.ctime_ms && a.size === b.size;
const stampRevision = (s: FileStamp) => `${s.mtime_ms}:${s.ctime_ms}:${s.size}`;

export interface Symbol {
  name: string; kind: string; path: string; line: number; signature: string;
  id: string; qualified: string; end_line: number; column: number; provider: string;
}
export interface Edge {
  caller: string; callee: string; path: string; line: number;
  caller_id: string; callee_id: string | null; callee_path: string | null;
  callee_line: number | null; status: string; dispatch: string;
}
export interface Reference {
  caller: string; callee: string; path: string; line: number; id: string;
  caller_id: string; target_id: string | null; status: string; dispatch: string; position: number;
}
export interface FileFacts { symbols: Symbol[]; refs: Reference[]; imports: { target: string; line: number }[]; }
export interface IndexerOptions {
  /** Optional local language servers; false disables discovery. No auto-installation. */
  providers?: LspProviderConfig[] | false;
  /** Optional project compiler module path, or false to retain heuristic mode. */
  typescript?: string | false;
  /** Source-file guard, not a heap guarantee. Large compiler programs are expensive. */
  semanticFileLimit?: number;
}
export interface TraceResult {
  status: "found" | "not_found" | "incomplete" | "unavailable";
  nodes: Symbol[]; hops: Edge[]; generation: number; reason?: string;
}
export class AmbiguousSymbolError extends Error {}
export class SymbolNotFoundError extends Error {}
export interface GraphWatchInventory {
  directories: Set<string>; extensions: Set<string>; inputs: Set<string>; inputDirectories: Set<string>;
}

export class CodeIndexer {
  private db: DatabaseSync;
  private compiler?: TypeScriptGraph;
  private compilerKey = "";
  private languages?: LspGraph;
  private languagesKey = "";
  private updating?: Promise<{ files: number; symbols: number; edges: number }>;
  private closed = false;
  private taskIndex: TaskContextIndex;
  private promptMap?: { generation: number; text: string };
  private journal: ChangeJournal;
  private journalExtensions: Set<string>;
  private cacheStore: AnalyzerCacheStore;
  private cacheInventory?: ReturnType<CodeIndexer["inspect"]>;
  private cacheKey?: string;
  private fileStampsCache?: { generation: string | undefined; files: Map<string, FileStamp> };

  constructor(dbPath: string, private workspace: string, private options: IndexerOptions = {},
    private checkCancelled: () => void = () => {}, private observeInventory?: (inventory: GraphWatchInventory) => void,
    private observeProgress?: (progress: AnalysisProgress) => void, private observeDependency?: (progress: DependencyProgress) => void) {
    // Child analyzers may report real paths even when the CLI entered through
    // a directory alias (for example /var versus /private/var on macOS).
    this.workspace = canonicalPath(workspace);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS symbols (name TEXT, kind TEXT, path TEXT, line INTEGER, signature TEXT)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_name ON symbols(name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path)");
    this.db.exec("CREATE TABLE IF NOT EXISTS edges (caller TEXT, callee TEXT, path TEXT, line INTEGER)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_callee ON edges(callee)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_caller ON edges(caller)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_edges_path ON edges(path)");
    this.db.exec("CREATE TABLE IF NOT EXISTS imports (src TEXT, target TEXT, line INTEGER)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_imports_src ON imports(src)");
    // Keep unresolved references as well as resolved edges, including across restarts.
    this.db.exec("CREATE TABLE IF NOT EXISTS call_refs (caller TEXT, callee TEXT, path TEXT, line INTEGER)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_call_refs_path ON call_refs(path)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_call_refs_callee ON call_refs(callee)");
    this.db.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime_ms REAL)");
    // Add cache metadata in place; old caches are reparsed once below.
    const fileColumns = new Set(this.db.prepare("PRAGMA table_info(files)").all().map(r => r.name));
    if (!fileColumns.has("ctime_ms")) this.db.exec("ALTER TABLE files ADD COLUMN ctime_ms REAL");
    if (!fileColumns.has("size")) this.db.exec("ALTER TABLE files ADD COLUMN size INTEGER");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.cacheStore = new AnalyzerCacheStore(this.db);
    // Additive cache migration: retain existing graph tables and lookup indexes.
    for (const [table, columns] of Object.entries({
      symbols: { id: "TEXT", qualified: "TEXT", end_line: "INTEGER", column: "INTEGER", provider: "TEXT" },
      edges: { caller_id: "TEXT", callee_id: "TEXT", callee_path: "TEXT", callee_line: "INTEGER", status: "TEXT", dispatch: "TEXT" },
      call_refs: { id: "TEXT", caller_id: "TEXT", target_id: "TEXT", status: "TEXT", dispatch: "TEXT", position: "INTEGER" },
    })) {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      for (const [column, type] of Object.entries(columns)) {
        if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_symbols_id ON symbols(id);
      CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified);
      CREATE INDEX IF NOT EXISTS idx_edges_caller_id ON edges(caller_id);
      CREATE INDEX IF NOT EXISTS idx_edges_callee_id ON edges(callee_id);
      CREATE INDEX IF NOT EXISTS idx_refs_caller_id ON call_refs(caller_id);
      CREATE TABLE IF NOT EXISTS analysis_files (path TEXT PRIMARY KEY, hash TEXT);
      CREATE TABLE IF NOT EXISTS analysis_inputs (path TEXT PRIMARY KEY, stamp TEXT);
    `);
    this.taskIndex = new TaskContextIndex(this.db, this.checkCancelled);
    this.journal = new ChangeJournal(this.db);
    this.journalExtensions = new Set([...Object.keys(LANG),...LANGUAGE_SERVERS.flatMap(p => Object.keys(p.languages)),
      ...(Array.isArray(options.providers) ? options.providers.flatMap(p => Object.keys(p.languages)) : [])]);
  }

  // ------------------------------------------------------------- building
  /** Full rebuild. */
  build(signal?: AbortSignal): Promise<{ files: number; symbols: number; edges: number }> {
    return this.schedule(true, signal);
  }

  /**
   * Parse changed files and reconcile cached references when names appear/disappear.
   * For a stable workspace, canonical graph rows must equal a clean build after
   * additions, deletions, renames or export edits. Compiler bindings and heuristic references stay explicitly separate.
   */
  refresh(signal?: AbortSignal): Promise<{ files: number; symbols: number; edges: number }> {
    return this.schedule(false, signal);
  }

  private schedule(rebuild: boolean, signal?: AbortSignal): Promise<{ files: number; symbols: number; edges: number }> {
    const next = (this.updating ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.closed) throw new Error("Indexer is closed.");
      signal?.throwIfAborted();
      this.checkCancelled();
      return this.update(rebuild, signal);
    });
    this.updating = next;
    void next.finally(() => { if (this.updating === next) this.updating = undefined; }).catch(() => {});
    return next;
  }

  /** The same saved-source/configuration check gates updates and live reads. */
  private inspect(rebuild = false) {
    const providers = discoverProviders(this.options.providers);
    const providerKey = hashText(JSON.stringify(providers.map(p => ({ ...p, executableStamp: diskStamp(p.command) }))));
    let reparse = rebuild || this.meta("parser_version") !== PARSER_VERSION || providerKey !== this.meta("providers");
    const supported = new Set([...Object.keys(LANG), ...LANGUAGE_SERVERS.flatMap(p => Object.keys(p.languages)), ...providers.flatMap(p => Object.keys(p.languages))]);
    this.journalExtensions = supported;
    const generation = this.meta("generation");
    if (!this.fileStampsCache || this.fileStampsCache.generation !== generation) {
      this.fileStampsCache = { generation,files:new Map<string,FileStamp>(
        (this.db.prepare("SELECT path, mtime_ms, ctime_ms, size FROM files").all() as unknown as (FileStamp & {path:string})[])
          .map(r => [r.path,r])) };
    }
    const known = this.fileStampsCache.files;
    const current = new Map<string, { abs: string; stamp: FileStamp }>();
    const changed = new Set<string>();
    const controls: string[] = [];
    const controlFiles = new Map<string, FileStamp>();
    const directories = new Set<string>();
    for (const abs of walk(this.workspace, this.checkCancelled, dir => directories.add(dir))) {
      if (isAnalysisControl(abs)) {
        controls.push(`${abs}:${diskStamp(abs)}`);
        const s = fs.statSync(abs);
        controlFiles.set(path.relative(this.workspace,abs), { mtime_ms:s.mtimeMs,ctime_ms:s.ctimeMs,size:s.size });
      }
      if (!supported.has(path.extname(abs))) continue;
      const rel = path.relative(this.workspace, abs), stat = fs.statSync(abs);
      if (stat.size > 1_000_000) continue;
      const stamp = { mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, size: stat.size };
      current.set(rel, { abs, stamp });
      const prev = known.get(rel);
      if (reparse || prev?.mtime_ms !== stamp.mtime_ms || prev?.ctime_ms !== stamp.ctime_ms || prev?.size !== stamp.size) changed.add(rel);
    }
    const removed = [...known.keys()].filter(p => !current.has(p));
    let compilerPath = projectTypeScript(this.workspace, this.options.typescript);
    const requestedLimit = this.options.semanticFileLimit ?? Number(process.env.FABER_GRAPH_MAX_FILES ?? 1000);
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 0 ? Math.floor(requestedLimit) : 1000;
    const semanticCount = [...current.keys()].filter(p => JS_EXTENSIONS.has(path.extname(p))).length;
    const guarded = !!compilerPath && semanticCount > limit;
    if (guarded) compilerPath = undefined;
    // Do not key the cache on file count: every addition would invalidate it.
    const compilerKey = compilerPath ? `${compilerPath}:${diskStamp(compilerPath)}:${limit}` : `heuristic:${limit}:${guarded ? "size-guard" : "no-provider"}`;
    if (compilerKey !== this.meta("compiler")) reparse = true;
    if (reparse) for (const rel of current.keys()) changed.add(rel);
    const controlHash = hashText(controls.sort().join("\n"));
    const inputRows = this.db.prepare("SELECT path, stamp FROM analysis_inputs").all();
    const inputStates = inputRows.map(row => {
      const file = row.path as string, previous = row.stamp as string;
      // Source changes use dependency invalidation, not a cold compiler restart.
      return current.has(path.relative(this.workspace, file)) ? previous : inputStamp(file, previous);
    });
    const envKey = environmentKey();
    const inputsChanged = this.meta("inputs_unverified") === generation || envKey !== this.meta("environment") || controlHash !== this.meta("controls") ||
      inputRows.some((row, i) => inputStates[i] !== row.stamp);
    this.observeInventory?.({ directories, extensions: supported,
      inputs: new Set(inputRows.map(row => row.path as string)),
      inputDirectories: new Set(inputRows.filter(row => (row.stamp as string).startsWith("entries:")).map(row => row.path as string)) });
    const revision = hashText(JSON.stringify([providerKey, compilerKey, controlHash, envKey,
      [...current].map(([rel, f]) => [rel, f.stamp]), inputStates, this.meta("inputs_unverified")]));
    return { providers, providerKey, reparse, supported, known, current, changed, removed, compilerPath, compilerKey, directories,
      guarded, limit, semanticCount, controlHash, controlFiles, inputsChanged, revision, envKey, inputRows, inputStates };
  }

  /** Recheck disk facts against one captured inventory, without rereading or
   * rebuilding unchanged SQLite metadata. Profiling identified repeated scans
   * as the foreground cost; every source path and external input is still checked.
   */
  private sameSavedRevision(before: ReturnType<CodeIndexer["inspect"]>, generation: number): boolean {
    const expected = new Map([...before.current.values()].map(f => [f.abs, f.stamp]));
    const controls: string[] = []; let count = 0;
    for (const abs of walk(this.workspace, this.checkCancelled)) {
      if (isAnalysisControl(abs)) controls.push(`${abs}:${diskStamp(abs)}`);
      if (!before.supported.has(path.extname(abs))) continue;
      const stat = fs.statSync(abs);
      if (stat.size > 1_000_000) continue;
      const previous = expected.get(abs); count++;
      if (!previous || stat.mtimeMs !== previous.mtime_ms || stat.ctimeMs !== previous.ctime_ms || stat.size !== previous.size) return false;
    }
    if (count !== expected.size || hashText(controls.sort().join("\n")) !== before.controlHash || environmentKey() !== before.envKey) return false;
    for (let i = 0; i < before.inputRows.length; i++) {
      this.checkCancelled();
      const row = before.inputRows[i]!;
      if (!expected.has(row.path as string) && inputStamp(row.path as string, row.stamp as string) !== before.inputStates[i]) return false;
    }
    const providers = discoverProviders(this.options.providers);
    if (hashText(JSON.stringify(providers.map(p => ({ ...p, executableStamp: diskStamp(p.command) })))) !== before.providerKey) return false;
    let compiler = projectTypeScript(this.workspace, this.options.typescript);
    if (before.guarded) compiler = undefined;
    const compilerKey = compiler ? `${compiler}:${diskStamp(compiler)}:${before.limit}`
      : `heuristic:${before.limit}:${before.guarded ? "size-guard" : "no-provider"}`;
    return compilerKey === before.compilerKey && Number(this.meta("generation") ?? 0) === generation;
  }

  /** Run external analyzers before the transaction; publish one atomic generation. */
  private async update(rebuild: boolean, signal?: AbortSignal): Promise<{ files: number; symbols: number; edges: number }> {
    const timing = new AnalysisTimer(this.observeProgress);
    try {
      const result = await this.updateGraph(rebuild,signal,timing);
      timing.stage("complete",{generation:Number(this.meta("generation") ?? 0),coverage:this.meta("coverage")?.slice(0,4000)});
      return result;
    } catch (error) {
      timing.stage(signal?.aborted || /cancelled/i.test(String(error)) ? "cancelled" : "failed");
      throw error;
    }
  }
  private async updateGraph(rebuild: boolean, signal: AbortSignal | undefined, timing: AnalysisTimer): Promise<{ files: number; symbols: number; edges: number }> {
    const inventory = this.inspect(rebuild);
    this.captureChanges(inventory);
    const pendingChanges = this.journal.pending();
    const { providers, providerKey, reparse, supported, known, current, changed, removed, compilerPath, compilerKey,
      guarded, limit, semanticCount, controlHash, inputsChanged, envKey } = inventory;
    timing.stage("language_servers",{fileCount:current.size,providers:providers.map(p => p.id)});
    if (!reparse && !changed.size && !removed.length && !inputsChanged) {
      this.journal.incorporate(pendingChanges, Number(this.meta("generation") ?? 0));
      return this.counts(0);
    }

    if (providerKey !== this.languagesKey || rebuild || inputsChanged) {
      this.languages?.close(); this.languages = undefined; this.languagesKey = providerKey;
    }
    this.cacheInventory = inventory;
    this.cacheKey = hashText(JSON.stringify([this.workspace, providerKey, controlHash, envKey, PARSER_VERSION]));
    this.languages ??= new LspGraph(this.workspace, providers, {
      load: (id, limit) => this.cacheStore.load(id, limit),
      save: (id, data, inputs, context, limit) => this.saveAnalyzerCache(id, data, inputs, context, limit),
      invalidate: (inputs, context) => this.invalidateAnalyzerInputs(inputs, context),
      progress: value => this.observeDependency?.(value),
    });
    const all = [...current.values()].map(f => f.abs);
    const changedPaths = new Set([...changed].map(p => current.get(p)!.abs));
    let external: ProviderFacts;
    try {
      const context: CacheContext = { key: this.cacheKey, generation: Number(this.meta("generation") ?? 0),
        sources: new Map([...current.values()].map(f => [f.abs, stampRevision(f.stamp)])),
        facts: new Map(this.db.prepare("SELECT path,hash FROM analysis_files").all().map(row => [path.join(this.workspace, row.path as string), row.hash as string])),
        inputs: new Map(inventory.inputRows.map((row, i) => [row.path as string, inventory.inputStates[i]!])),
        directories: new Map([...inventory.directories].map(dir => [dir, dependencyInputStamp(dir)])) };
      external = await this.languages.analyze(all, changedPaths, removed.map(p => path.join(this.workspace, p)), reparse || inputsChanged, signal, context);
      if (this.closed) throw new Error("Indexer is closed.");
      signal?.throwIfAborted();
      this.checkCancelled();
    } catch (error) {
      this.languages?.close(); this.languages = undefined; throw error;
    }
    timing.stage("database_setup",{analyzerFiles:external.files.size});
    this.db.exec("BEGIN");
    try {
      const previousNames = new Set(this.db.prepare("SELECT DISTINCT name FROM symbols").all().map(r => r.name as string));
      if (rebuild || inputsChanged || this.compilerKey !== compilerKey) {
        this.compiler?.close(); this.compiler = undefined;
      }
      this.compilerKey = compilerKey;
      timing.stage("compiler",{compilerEnabled:!!compilerPath});
      if (compilerPath && !this.compiler) this.compiler = new TypeScriptGraph(compilerPath, this.workspace, this.checkCancelled);
      const semantic = this.compiler?.analyze(all.filter(p => !external.files.has(p)), changedPaths,
        removed.length > 0 || [...changed].some(p => !known.has(p))) ?? new Map<string, FileFacts>();
      for (const [file, value] of external.facts) semantic.set(file, value);
      timing.stage("facts",{analyzerFiles:semantic.size});
      const hashes = new Map(this.db.prepare("SELECT path, hash FROM analysis_files").all().map(r => [r.path as string, r.hash as string]));
      const facts = new Map<string, FileFacts>(), newHashes = new Map<string, string>();
      for (const [abs, value] of semantic) {
        this.checkCancelled();
        const rel = path.relative(this.workspace, abs), hash = hashText(JSON.stringify(value));
        if (reparse || hashes.get(rel) !== hash) { facts.set(rel, value); newHashes.set(rel, hash); }
      }
      for (const [rel, f] of current) {
        this.checkCancelled();
        if (!external.files.has(f.abs) && !this.compiler?.files.has(f.abs) && (changed.has(rel) || hashes.has(rel))) {
          facts.set(rel, heuristicFacts(fs.readFileSync(f.abs, "utf8"), rel));
        }
      }
      timing.stage("publication");
      if (rebuild) this.db.exec("DELETE FROM symbols; DELETE FROM edges; DELETE FROM imports; DELETE FROM call_refs; DELETE FROM files; DELETE FROM analysis_files;");
      const delSym = this.db.prepare("DELETE FROM symbols WHERE path=?"), delEdge = this.db.prepare("DELETE FROM edges WHERE path=?");
      const delImp = this.db.prepare("DELETE FROM imports WHERE src=?"), delRef = this.db.prepare("DELETE FROM call_refs WHERE path=?");
      const delHash = this.db.prepare("DELETE FROM analysis_files WHERE path=?"), delFile = this.db.prepare("DELETE FROM files WHERE path=?");
      for (const rel of new Set([...removed, ...facts.keys()])) {
        this.checkCancelled();
        delSym.run(rel); delEdge.run(rel); delImp.run(rel); delRef.run(rel); delHash.run(rel);
      }
      for (const rel of removed) delFile.run(rel);
      const insSym = this.db.prepare("INSERT INTO symbols (name,kind,path,line,signature,id,qualified,end_line,column,provider) VALUES (?,?,?,?,?,?,?,?,?,?)");
      const insImp = this.db.prepare("INSERT INTO imports VALUES (?,?,?)");
      const insHash = this.db.prepare("INSERT OR REPLACE INTO analysis_files VALUES (?,?)");
      // Pass 1 publishes all declarations before resolving any reference.
      for (const [rel, f] of facts) {
        this.checkCancelled();
        for (const s of f.symbols) {
          const row = insSym.run(s.name,s.kind,s.path,s.line,s.signature,s.id,s.qualified,s.end_line,s.column,s.provider);
          this.taskIndex.add(s, row.lastInsertRowid);
        }
        for (const i of f.imports) insImp.run(rel,i.target,i.line);
        if (newHashes.has(rel)) insHash.run(rel,newHashes.get(rel)!);
      }
      const knownNames = new Set(this.db.prepare("SELECT DISTINCT name FROM symbols").all().map(r => r.name as string));
      const delCallee = this.db.prepare("DELETE FROM edges WHERE callee=? AND status='heuristic'");
      const resolveRefs = this.db.prepare(`INSERT INTO edges (caller,callee,path,line,caller_id,status,dispatch)
        SELECT caller,callee,path,line,caller_id,status,dispatch FROM call_refs WHERE callee=? AND status='heuristic'`);
      for (const name of previousNames) if (!knownNames.has(name)) delCallee.run(name);
      // Changed files' references are absent here, avoiding duplicate insertions.
      for (const name of knownNames) if (!previousNames.has(name)) resolveRefs.run(name);
      const insRef = this.db.prepare("INSERT INTO call_refs (caller,callee,path,line,id,caller_id,target_id,status,dispatch,position) VALUES (?,?,?,?,?,?,?,?,?,?)");
      const resolveExact = this.db.prepare(`INSERT INTO edges
        SELECT r.caller,r.callee,r.path,r.line,r.caller_id,s.id,s.path,s.line,r.status,r.dispatch
        FROM call_refs r JOIN symbols s ON s.id=r.target_id WHERE r.path=?`);
      const insHint = this.db.prepare("INSERT INTO edges (caller,callee,path,line,caller_id,status,dispatch) VALUES (?,?,?,?,?,?,?)");
      for (const [rel, f] of facts) {
        this.checkCancelled();
        for (const r of f.refs) insRef.run(r.caller,r.callee,r.path,r.line,r.id,r.caller_id,r.target_id,r.status,r.dispatch,r.position);
        resolveExact.run(rel);
        for (const r of f.refs) if (r.status === "heuristic" && knownNames.has(r.callee)) insHint.run(r.caller,r.callee,r.path,r.line,r.caller_id,r.status,r.dispatch);
      }
      this.db.exec("DELETE FROM edges WHERE callee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id=edges.callee_id)");
      // An edit may move a declaration's line without changing its character offset/ID.
      this.db.exec(`UPDATE edges AS e SET callee_path=s.path,callee_line=s.line FROM symbols s
        WHERE e.callee_id=s.id AND (e.callee_path IS NOT s.path OR e.callee_line IS NOT s.line)`);
      const upFile = this.db.prepare("INSERT OR REPLACE INTO files (path,mtime_ms,ctime_ms,size) VALUES (?,?,?,?)");
      for (const rel of changed) {
        const f = current.get(rel)!; upFile.run(rel,f.stamp.mtime_ms,f.stamp.ctime_ms,f.stamp.size);
      }
      timing.stage("source_validation");
      for (const f of current.values()) {
        this.checkCancelled();
        const s = fs.statSync(f.abs);
        if (s.mtimeMs !== f.stamp.mtime_ms || s.ctimeMs !== f.stamp.ctime_ms || s.size !== f.stamp.size) throw new Error("Source changed during indexing; retry the refresh.");
      }
      const afterFiles = new Set<string>(), afterControls: string[] = [];
      for (const abs of walk(this.workspace, this.checkCancelled)) {
        if (isAnalysisControl(abs)) afterControls.push(`${abs}:${diskStamp(abs)}`);
        if (supported.has(path.extname(abs)) && fs.statSync(abs).size <= 1_000_000) afterFiles.add(path.relative(this.workspace, abs));
      }
      if (afterFiles.size !== current.size || [...afterFiles].some(p => !current.has(p)) || hashText(afterControls.sort().join("\n")) !== controlHash) {
        throw new Error("Workspace files or project configuration changed during indexing; retry the refresh.");
      }
      signal?.throwIfAborted();
      this.checkCancelled();
      this.db.exec("DELETE FROM analysis_inputs");
      const insInput = this.db.prepare("INSERT INTO analysis_inputs VALUES (?,?)");
      const analysisInputs = new Map([...(this.compiler?.inputs ?? []), ...(this.languages?.inputs ?? [])]);
      for (const [file, stamp] of analysisInputs) {
        if (inputStamp(file,stamp) !== stamp) throw new Error(`Analysis input changed during indexing: ${file}; retry the refresh.`);
        insInput.run(file,stamp);
      }
      const meta = this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)");
      meta.run("generation", String(Number(this.meta("generation") ?? 0) + 1));
      meta.run("built_at",String(Date.now())); meta.run("parser_version",PARSER_VERSION);
      meta.run("providers",providerKey);
      meta.run("compiler",compilerKey); meta.run("controls",controlHash);
      meta.run("environment",envKey);
      meta.run("inputs_unverified", "");
      const fallbackCoverage = this.compiler?.description ?? (guarded
        ? `Heuristic only: ${semanticCount} TS/JS files exceeds the compiler file limit (${limit}). Static call paths are unavailable. FABER_GRAPH_MAX_FILES can opt in; this is not a heap limit.`
        : "Heuristic only for files without language-server or TS/JS compiler coverage. Static call paths from heuristic hints are unavailable.");
      meta.run("coverage",[external.description, all.length > external.files.size ? fallbackCoverage : ""].filter(Boolean).join("\n"));
      this.journal.incorporate(pendingChanges, Number(this.meta("generation")));
      this.checkCancelled();
      this.db.exec("COMMIT");
      this.fileStampsCache = { generation:this.meta("generation"),files:new Map([...current].map(([rel,f]) => [rel,f.stamp])) };
    } catch (error) {
      this.db.exec("ROLLBACK"); this.compiler?.close(); this.compiler = undefined; this.languages?.close(); this.languages = undefined; throw error;
    }
    // Auxiliary caches are optional. Their failure must not fail an already
    // committed call graph or delay it while independent discovery is running.
    try { this.languages?.published(Number(this.meta("generation") ?? 0)); } catch { /* cold cache on next edit */ }
    return this.counts(changed.size);
  }

  private saveAnalyzerCache(id: string, data: unknown, inputs: Map<string, string>, context: CacheContext, limit: number): boolean {
    const inventory = this.cacheInventory;
    if (this.closed || !inventory || this.cacheKey !== context.key || Number(this.meta("generation") ?? 0) !== context.generation) return false;
    try {
      if (!this.sameSavedRevision(inventory, context.generation) || [...inputs].some(([file, stamp]) => dependencyInputStamp(file) !== stamp)) return false;
      const rows = new Map(this.db.prepare("SELECT path,hash FROM analysis_files").all().map(row => [path.join(this.workspace, row.path as string), row.hash as string]));
      const files = (data as any)?.files;
      if (!Array.isArray(files) || files.some(([file, value]: [string, any]) => factHash(value.facts) !== rows.get(file))) return false;
      this.db.exec("BEGIN");
      try {
        if (!this.cacheStore.save(id, data, limit)) { this.db.exec("ROLLBACK"); return false; }
        const insert = this.db.prepare("INSERT OR REPLACE INTO analysis_inputs (path,stamp) VALUES (?,?)");
        for (const [file, stamp] of inputs) insert.run(file, stamp);
        if (!this.sameSavedRevision(inventory, context.generation) || [...inputs].some(([file, stamp]) => dependencyInputStamp(file) !== stamp)) {
          this.db.exec("ROLLBACK"); return false;
        }
        this.db.exec("COMMIT"); return true;
      } catch { this.db.exec("ROLLBACK"); return false; }
    } catch { return false; }
  }

  private invalidateAnalyzerInputs(inputs: Map<string, string>, context: CacheContext): void {
    if (this.closed || this.cacheKey !== context.key || Number(this.meta("generation") ?? 0) !== context.generation) return;
    try {
      this.db.exec("BEGIN");
      try {
        const insert = this.db.prepare("INSERT OR REPLACE INTO analysis_inputs (path,stamp) VALUES (?,?)");
        for (const file of inputs.keys()) insert.run(file, dependencyInputStamp(file));
        this.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('inputs_unverified',?)").run(String(context.generation));
        this.db.exec("COMMIT");
      } catch { this.db.exec("ROLLBACK"); }
    } catch { /* optional metadata failure leaves caches unused */ }
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }

  private counts(files: number): { files: number; symbols: number; edges: number } {
    const nSym = (this.db.prepare("SELECT COUNT(*) c FROM symbols").get() as any).c;
    const nEdge = (this.db.prepare("SELECT COUNT(*) c FROM edges").get() as any).c;
    return { files, symbols: nSym, edges: nEdge };
  }

  // -------------------------------------------------------------- queries
  /** Event recording is a stat and indexed lookup, never a repository scan/analyzer. */
  recordChange(file?: string): void {
    if (!file) return;
    const abs = canonicalPath(path.resolve(this.workspace, file)), rel = path.relative(this.workspace, abs);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ||
      rel.split(path.sep).some(part => SKIP_DIRS.has(part))) return;
    if (!this.journalExtensions.has(path.extname(abs)) && !isAnalysisControl(abs)) return;
    let stamp: FileStamp | undefined;
    try { const s = fs.statSync(abs); if (!s.isFile()) return;
      stamp = { mtime_ms: s.mtimeMs, ctime_ms: s.ctimeMs, size: s.size }; }
    catch (error) { if (!/ENOENT|ENOTDIR/.test(String(error))) throw error; }
    const old = this.db.prepare("SELECT mtime_ms,ctime_ms,size FROM files WHERE path=?").get(rel) as unknown as FileStamp | undefined;
    const recorded = this.journal.get(rel);
    if (recorded?.indexedGeneration === null && recorded.revision === (stamp ? stampRevision(stamp) : null)) return;
    if (!stamp && !old && (!recorded || recorded.kind === "added" && recorded.indexedGeneration === null)) {
      this.journal.discard(rel); return;
    }
    if (!stamp && !old && !isAnalysisControl(abs)) { this.journal.discard(rel); return; }
    if (stamp && old && sameStamp(old, stamp)) return;
    this.languages?.cancelInventory();
    const existed = old || recorded && (recorded.indexedGeneration === null ? recorded.kind !== "added" : recorded.revision !== null);
    this.journal.record(rel, stamp ? existed ? "modified" : "added" : "deleted",
      stamp ? stampRevision(stamp) : null, isAnalysisControl(abs));
  }
  private captureChanges(before: ReturnType<CodeIndexer["inspect"]>): void {
    this.journal.batch(() => {
    for (const [rel, file] of before.current) {
      const old = before.known.get(rel);
      if (!old || !sameStamp(old,file.stamp)) this.journal.record(rel, old ? "modified" : "added", stampRevision(file.stamp),isAnalysisControl(rel));
    }
    for (const rel of before.removed) {
      // A saved source can leave the index because it exceeds the size guard.
      // Keep its actual revision; exclusion from the graph is not a deletion.
      let stamp: FileStamp | undefined;
      try { const s = fs.statSync(path.join(this.workspace,rel));
        if (s.isFile()) stamp = {mtime_ms:s.mtimeMs,ctime_ms:s.ctimeMs,size:s.size}; }
      catch (error) { if (!/ENOENT|ENOTDIR/.test(String(error))) throw error; }
      this.journal.record(rel,stamp ? "modified" : "deleted",stamp ? stampRevision(stamp) : null);
    }
    for (const [rel,stamp] of before.controlFiles) {
      if (before.current.has(rel)) continue;
      const old = this.journal.get(rel), revision = stampRevision(stamp);
      if (old?.revision === revision) continue;
      this.journal.record(rel,old && (old.indexedGeneration === null ? old.kind !== "added" : old.revision !== null) ? "modified" : "added",revision,true);
      if (!old && this.isBuilt() && before.controlHash === this.meta("controls")) {
        this.journal.incorporate([this.journal.get(rel)!],Number(this.meta("generation") ?? 0));
      }
    }
    for (const row of this.journal.controls()) if (row.revision !== null && !before.controlFiles.has(row.path)) {
      if (row.kind === "added" && row.indexedGeneration === null) this.journal.discard(row.path);
      else this.journal.record(row.path,"deleted",null,true);
    }
    // A newly added file can be deleted again before indexing; no graph change remains.
    for (const row of this.journal.pending()) if (!before.current.has(row.path) && !before.known.has(row.path) &&
      !isAnalysisControl(row.path)) this.journal.discard(row.path);
    });
  }
  /** Metadata reconciliation recovers saves while Faber was stopped. No analyzer runs. */
  changes(limit = 100, includeIndexed = false): ChangeList {
    this.checkCancelled();
    const before = this.inspect(); this.captureChanges(before);
    return this.journal.list(Number(this.meta("generation") ?? 0), !this.isBuilt() || before.reparse || before.inputsChanged ||
      !!before.changed.size || !!before.removed.length, limit, includeIndexed);
  }
  /** Never publish old bindings as current. This read does not run an analyzer. */
  readCurrent<M extends LiveMethod>(method: M, args: unknown[], callerEnvironment = environmentKey()): CurrentGraph<LiveValues[M]> {
    this.checkCancelled();
    const generation = Number(this.meta("generation") ?? 0);
    if (callerEnvironment !== environmentKey()) return { status: "pending", generation, revision: callerEnvironment,
      reason: "The analyzer environment changed; bindings must be refreshed." };
    const before = this.inspect();
    this.captureChanges(before);
    if (!this.isBuilt()) return { status: "not_built", generation, changed: [...before.current.keys()].slice(0,64),
      reason: "The code graph is not built yet." };
    const pending = () => ({ status: "pending" as const, generation, revision: before.revision,
      changed: [...before.changed, ...before.removed].slice(0, 64),
      reason: "Saved sources or analysis configuration changed; graph analysis is pending." });
    if (before.reparse || before.inputsChanged || before.changed.size || before.removed.length) return pending();
    let value: LiveValues[LiveMethod];
    if (method === "prompt") {
      const context = this.taskContext(args[0] as string, args[1] as ContextOptions | undefined);
      let map: string | undefined;
      if (args[2] !== generation) {
        if (this.promptMap?.generation !== generation) this.promptMap = { generation, text: this.repoMap() };
        map = this.promptMap.text;
      }
      value = { context, map };
    } else if (["search", "whoCalls", "referencesFrom", "trace", "callTree", "taskContext"].includes(method)) {
      value = (this[method as Exclude<LiveMethod, "prompt">] as (...args: any[]) => LiveValues[LiveMethod]).apply(this, args);
    } else throw new Error("Unknown current-graph query.");
    this.checkCancelled();
    // Also reject edits made while retrieving/ranking the snapshot.
    if (!this.sameSavedRevision(before, generation)) {
      const after = this.inspect();
      return { ...pending(), revision: after.revision, changed: [...after.changed, ...after.removed].slice(0, 64) };
    }
    return { status: "ready", generation, value: value as LiveValues[M] };
  }

  search(query: string, limit = 20): Symbol[] {
    return this.db.prepare(`SELECT * FROM symbols WHERE kind NOT IN ('module','initializer') AND (name LIKE ? OR qualified LIKE ?)
      ORDER BY CASE WHEN name=? THEN 0 ELSE 1 END,name,path,line,column LIMIT ?`)
      .all(`%${query}%`,`%${query}%`,query,bounded(limit,100)) as unknown as Symbol[];
  }

  private selectSymbol(selector: string): Symbol | undefined {
    const exact = this.db.prepare("SELECT * FROM symbols WHERE id=?").get(selector) as unknown as Symbol | undefined;
    if (exact) return exact;
    const matches = this.db.prepare("SELECT * FROM symbols WHERE name=? OR qualified=? ORDER BY path,line,column LIMIT 51")
      .all(selector,selector) as unknown as Symbol[];
    if (matches.length > 1) throw new AmbiguousSymbolError(
      `Ambiguous symbol '${selector}'. Select an id from search_code (IDs can change after edits):\n` +
      matches.slice(0,50).map(s => `${s.qualified} (${s.path}:${s.line}) id=${s.id}`).join("\n") +
      (matches.length > 50 ? "\nMore matches exist; narrow the search." : ""));
    if (!matches.length && /^(?:heuristic|ts|lsp):/.test(selector)) throw new SymbolNotFoundError(
      `Symbol ID '${selector}' is not present in the current graph. Copy a complete current id from search_code or graph_context; IDs can change after edits.`);
    return matches[0];
  }

  whoCalls(name: string, limit = 30): Edge[] {
    const symbol = this.selectSymbol(name);
    if (!symbol) return [];
    return this.db.prepare(`SELECT * FROM edges WHERE callee_id=? OR (status='heuristic' AND callee=?)
      ORDER BY path,line LIMIT ?`).all(symbol.id,symbol.name,bounded(limit,100)) as unknown as Edge[];
  }

  callsFrom(name: string, limit = 30): Edge[] {
    const symbol = this.selectSymbol(name);
    if (!symbol) return [];
    return this.db.prepare("SELECT * FROM edges WHERE caller_id=? ORDER BY line,callee LIMIT ?")
      .all(symbol.id,bounded(limit,100)) as unknown as Edge[];
  }

  /** Include unresolved/indirect references, so absence of an edge is not hidden. */
  referencesFrom(name: string, limit = 30): Edge[] {
    const symbol = this.selectSymbol(name);
    if (!symbol) return [];
    return this.db.prepare(`SELECT r.caller,r.callee,r.path,r.line,r.caller_id,s.id AS callee_id,
      s.path AS callee_path,s.line AS callee_line,r.status,r.dispatch FROM call_refs r
      LEFT JOIN symbols s ON s.id=r.target_id WHERE r.caller_id=? ORDER BY r.position LIMIT ?`)
      .all(symbol.id,bounded(limit,100)) as unknown as Edge[];
  }

  coverage(): string { return this.meta("coverage") ?? "Index has not been built."; }

  /** Task-local navigation context; ranks existing facts without running analysis. */
  taskContext(query: string, options: ContextOptions = {}): TaskContext {
    this.checkCancelled();
    return this.taskIndex.retrieve(query, options, Number(this.meta("generation") ?? 0), this.isBuilt());
  }

  /** Compatibility wrapper. Only exact compiler bindings may compose a path. */
  tracePath(from: string, to: string, maxDepth = 12): string[] | undefined {
    const result = this.trace(from,to,maxDepth);
    return result.status === "found" ? result.nodes.map(s => s.name) : undefined;
  }

  /** Bounded static-binding navigation; member bindings do not prove runtime dispatch. */
  trace(from: string, to: string, maxDepth = 12): TraceResult {
    const base = { nodes: [] as Symbol[], hops: [] as Edge[], generation: Number(this.meta("generation") ?? 0) };
    const start = this.selectSymbol(from), goal = this.selectSymbol(to);
    if (!start || !goal) return { ...base,status:"not_found",reason:"An endpoint is not indexed; search for its current ID." };
    if (!hasBindings(start) || !hasBindings(goal)) return { ...base,status:"unavailable",reason:this.coverage() };
    if (start.id === goal.id) return { ...base,status:"found",nodes:[start] };
    const next = this.db.prepare("SELECT * FROM edges WHERE caller_id=? AND status='resolved' AND callee_id IS NOT NULL ORDER BY line,callee_id LIMIT 10001");
    const previous = new Map<string, Edge>(), seen = new Set([start.id]);
    let frontier = [start.id], examined = 0;
    const deadline = performance.now() + 100, depthLimit = bounded(maxDepth,64);
    for (let depth = 0; depth < depthLimit && frontier.length; depth++) {
      const upcoming: string[] = [];
      for (const node of frontier) {
        for (const edge of next.all(node) as unknown as Edge[]) {
          if (++examined > 10000 || seen.size > 2000 || performance.now() > deadline) return { ...base,status:"incomplete",reason:"Traversal budget reached (2,000 nodes / 10,000 edges / 100ms)." };
          const id = edge.callee_id!;
          if (seen.has(id)) continue;
          previous.set(id,edge); seen.add(id);
          if (id === goal.id) {
            const hops: Edge[] = []; let cur = id;
            while (cur !== start.id) { const hop = previous.get(cur)!; hops.unshift(hop); cur = hop.caller_id; }
            const get = this.db.prepare("SELECT * FROM symbols WHERE id=?");
            const nodes = [start,...hops.map(h => get.get(h.callee_id!) as unknown as Symbol)];
            return { ...base,status:"found",nodes,hops,reason:"Static bindings only; runtime execution and member dispatch are not proven." };
          }
          upcoming.push(id);
        }
      }
      frontier = upcoming;
    }
    return { ...base,status:frontier.length ? "incomplete" : "not_found",reason:frontier.length
      ? "Depth limit reached." : "No resolved static-binding path. Dynamic, contract, cross-project and unresolved references are not traversed." };
  }

  /** Call tree from one exact symbol, cycle-safe and bounded for `faber map`. */
  callTree(entry: string, maxDepth = 4): string {
    const root = this.selectSymbol(entry);
    if (!root) return `No symbol matched ${entry}.`;
    if (!hasBindings(root)) return `Call tree unavailable. ${this.coverage()}`;
    const out = ["Static binding tree; runtime execution and member dispatch are not proven."], seen = new Set<string>();
    const next = this.db.prepare(`SELECT s.* FROM edges e JOIN symbols s ON s.id=e.callee_id
      WHERE e.caller_id=? AND e.status='resolved' GROUP BY s.id ORDER BY MIN(e.line),s.id LIMIT 16`);
    const visit = (symbol: Symbol, depth: number): void => {
      if (out.length >= 200) return;
      out.push(`${"  ".repeat(depth)}${symbol.qualified} (${symbol.path}:${symbol.line})${seen.has(symbol.id) ? " ↩ (seen)" : ""}`);
      if (seen.has(symbol.id) || depth >= bounded(maxDepth,12)) return;
      seen.add(symbol.id);
      const children = next.all(symbol.id) as unknown as Symbol[];
      for (const child of children.slice(0,15)) visit(child,depth+1);
      if (children.length > 15 && out.length < 200) out.push(`${"  ".repeat(depth+1)}… more calls omitted`);
    };
    visit(root,0);
    if (out.length >= 200) out.push("… tree truncated at 200 lines");
    return out.join("\n");
  }

  /** One row per display name; degrees are aggregated navigation hints. */
  repoMap(limit = 15): string {
    const rows = this.db.prepare(`SELECT s.name,MIN(s.kind) AS kind,MIN(s.path) AS path,
      COUNT(*) AS definitions,COUNT(DISTINCT s.path) AS file_count,
      (SELECT COUNT(*) FROM edges e WHERE e.callee=s.name) +
      (SELECT COUNT(*) FROM edges e WHERE e.caller=s.name) AS degree
      FROM symbols s WHERE s.kind NOT IN ('module','initializer') GROUP BY s.name
      ORDER BY degree DESC,s.name LIMIT ?`).all(bounded(limit,100)) as any[];
    return rows.filter(r => r.degree > 0).map(r => `${r.name} [${r.kind}] ${r.file_count > 1
      ? `${r.file_count} files (ambiguous)` : `${r.path}${r.definitions > 1 ? " (ambiguous)" : ""}`} (${r.degree} connections)`).join("\n");
  }

  isBuilt(): boolean { return this.meta("built_at") != null; }
  close(): void { if (this.closed) return; this.closed = true; this.languages?.close(); this.compiler?.close(); this.db.close(); }
}

function hasBindings(symbol: Symbol): boolean { return symbol.provider === "typescript" || symbol.provider.startsWith("lsp:"); }

function bounded(value: number, max: number): number { return Number.isFinite(value) ? Math.max(0,Math.min(max,Math.floor(value))) : max; }
function hashText(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function diskStamp(file: string): string {
  try { const s = fs.statSync(file); return s.isDirectory() ? "directory" : `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
  catch (error) { if (["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return "missing"; throw error; }
}
function inputStamp(file: string, previous: string): string {
  const stamp = diskStamp(file);
  return stamp === "directory" && previous.startsWith("entries:") ? `entries:${hashText(fs.readdirSync(file).sort().join("\0"))}` : stamp;
}
function projectTypeScript(workspace: string, selected?: string | false): string | undefined {
  if (selected === false) return undefined;
  try {
    const require = createRequire(path.join(workspace,"package.json"));
    const file = require.resolve(selected ?? "typescript"), ts = require(file) as typeof TS;
    const [major, minor] = ts.version.split(".").map(Number);
    if (major === 5 && minor! >= 6 && typeof ts.createLanguageService === "function") return file;
    if (selected) throw new Error(`Unsupported TypeScript ${ts.version}; expected 5.6 or newer within 5.x.`);
  } catch (error) { if (selected) throw new Error(`Cannot load graph compiler: ${String(error)}`); }
  return undefined;
}

/** Retain cheap, explicitly heuristic navigation where semantic analysis is unavailable. */
function heuristicFacts(text: string, rel: string): FileFacts {
  const ext = path.extname(rel), originals = text.split("\n"), lines = codeForIndexing(text,ext).split("\n");
  const facts: FileFacts = { symbols:[],refs:[],imports:[] }, fileKey = hashText(rel).slice(0,32);
  for (let i=0;i<lines.length;i++) for (const [kind,rx] of LANG[ext] ?? []) {
    const match = rx.exec(lines[i]!);
    if (match?.[1] && !CALL_KEYWORDS.has(match[1]) && !isLanguageKeyword(match[1],ext)) {
      const name = match[1];
      facts.symbols.push({name,kind,path:rel,line:i+1,signature:originals[i]!.trim().slice(0,120),
        id:`heuristic:${fileKey}:${name}@${i+1}`,qualified:name,end_line:i+1,column:1,provider:"heuristic"});
      break;
    }
  }
  const definitions = new Map<number, Set<string>>();
  for (const s of facts.symbols) { if (!definitions.has(s.line)) definitions.set(s.line,new Set()); definitions.get(s.line)!.add(s.name); }
  let cursor = 0, offset = 0;
  let caller = "<module>", callerId = `heuristic:${fileKey}::<module>`;
  for (let i=0;i<lines.length;i++) {
    while (cursor < facts.symbols.length && facts.symbols[cursor]!.line <= i+1) {
      const s = facts.symbols[cursor++]!; caller=s.name; callerId=s.id;
    }
    const line = lines[i]!;
    for (const rx of IMPORT_RX[ext] ?? (JS_EXTENSIONS.has(ext) ? IMPORT_RX[".js"]! : [])) {
      const m = rx.exec(line); if (m?.[1]) facts.imports.push({target:m[1],line:i+1});
    }
    CALL_RX.lastIndex=0; let m: RegExpExecArray | null;
    while ((m=CALL_RX.exec(line))) {
      const callee=m[1]!;
      if (CALL_KEYWORDS.has(callee) || isLanguageKeyword(callee,ext) || definitions.get(i+1)?.has(callee) || caller===callee) continue;
      facts.refs.push({caller,callee,path:rel,line:i+1,id:`${fileKey}@${offset+m.index}`,caller_id:callerId,
        target_id:null,status:"heuristic",dispatch:"unknown",position:offset+m.index});
    }
    offset += line.length+1;
  }
  return facts;
}

/** Optional, project-local compiler. No mandatory runtime dependency or installation. */
class TypeScriptGraph {
  private ts: typeof TS;
  private registry: TS.DocumentRegistry;
  private services = new Map<string, { service: TS.LanguageService; roots: string[]; options: TS.CompilerOptions; version: number; references?: readonly TS.ProjectReference[] }>();
  private snapshots = new Map<string, { stamp: string; snapshot: TS.IScriptSnapshot }>();
  private dependencies = new Map<string, Set<string>>();
  private dependents = new Map<string, Set<string>>();
  private globals = new Set<string>();
  private resolveAll = true;
  private resolutionChanges = new Set<string>();
  readonly files = new Set<string>();
  readonly inputs = new Map<string,string>();
  description = "";

  constructor(modulePath: string, private workspace: string, private checkCancelled: () => void = () => {}) {
    this.ts = createRequire(import.meta.url)(modulePath) as typeof TS;
    this.registry = this.ts.createDocumentRegistry(this.ts.sys.useCaseSensitiveFileNames,workspace);
  }
  close(): void {
    for (const p of this.services.values()) p.service.dispose();
    this.services.clear(); this.snapshots.clear();
  }
  private stamp(file: string): string {
    this.checkCancelled();
    file=path.resolve(file); const stamp=diskStamp(file); this.inputs.set(file,stamp); return stamp;
  }
  private read(file: string): string | undefined { this.stamp(file); return this.ts.sys.readFile(file); }

  analyze(all: string[], changed: Set<string>, structural: boolean): Map<string,FileFacts> {
    const ts = this.ts, candidates = all.filter(f => JS_EXTENSIONS.has(path.extname(f)));
    const configAt = new Map<string,string>(), parsed = new Map<string,TS.ParsedCommandLine>();
    const nearest = (dir: string): string => {
      const cached = configAt.get(dir); if (cached !== undefined) return cached;
      for (const name of ["tsconfig.json","jsconfig.json"]) {
        const file=path.join(dir,name), stamp=this.stamp(file);
        if (stamp !== "missing" && stamp !== "directory") { configAt.set(dir,file); return file; }
      }
      const parent=path.dirname(dir), key=dir===this.workspace || parent===dir ? "" : nearest(parent);
      configAt.set(dir,key); return key;
    };
    const parse = (key: string): TS.ParsedCommandLine => {
      const cached=parsed.get(key); if (cached) return cached;
      const config=ts.readConfigFile(key,f=>this.read(f));
      if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,"\n"));
      const result=ts.parseJsonConfigFileContent(config.config,{
        useCaseSensitiveFileNames:ts.sys.useCaseSensitiveFileNames,
        readDirectory:ts.sys.readDirectory,
        fileExists:f=>{const s=this.stamp(f);return s!=="missing" && s!=="directory";},
        readFile:f=>this.read(f),
      },path.dirname(key),undefined,key);
      const errors=result.errors.filter(e=>e.code!==18003);
      if (errors.length) throw new Error(`Graph configuration ${key}: ${errors.map(e=>ts.flattenDiagnosticMessageText(e.messageText,"\n")).join("; ")}`);
      parsed.set(key,result); return result;
    };
    const projectFor=new Map<string,string>(), groups=new Map<string,string[]>();
    for (const file of candidates) {
      this.checkCancelled();
      const key=nearest(path.dirname(file));
      // Respect project exclusions instead of fabricating compiler options.
      if (key && !parse(key).fileNames.some(f=>path.resolve(f)===file)) continue;
      projectFor.set(file,key);
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key)!.push(file);
    }
    const eligible=new Set(projectFor.keys());
    let full=!this.files.size || structural || [...changed].some(f=>this.globals.has(f) || f.endsWith(".d.ts"));
    if (!full) for (const file of changed) if (eligible.has(file)) {
      const sf=ts.createSourceFile(file,this.read(file)!,ts.ScriptTarget.Latest,true);
      if (!ts.isExternalModule(sf) || sf.statements.some(n=>ts.isModuleDeclaration(n) && !!(n.flags & ts.NodeFlags.GlobalAugmentation))) {full=true;break;}
    }
    const affected=new Set(full ? eligible : changed), pending=[...affected];
    for (let i=0;i<pending.length;i++) for (const importer of this.dependents.get(pending[i]!) ?? []) {
      if (!affected.has(importer)) {affected.add(importer);pending.push(importer);}
    }
    this.resolveAll=full;this.resolutionChanges=changed;
    this.files.clear();for (const file of eligible) this.files.add(file);
    const facts=new Map<string,FileFacts>();
    for (const [key,roots] of groups) {
      this.checkCancelled();
      let state=this.services.get(key);
      if (state && !roots.some(f=>affected.has(f))) continue;
      const options: TS.CompilerOptions={...(key ? parse(key).options : {
        target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,allowJs:true,jsx:ts.JsxEmit.Preserve,
      }),noEmit:true,disableSizeLimit:true};
      if (!state) {
        const current={roots,options,version:0,references:key ? parse(key).projectReferences : undefined,service:undefined as unknown as TS.LanguageService};
        const host: TS.LanguageServiceHost & { hasInvalidatedResolutions(file: string): boolean }={
          getScriptFileNames:()=>current.roots,
          getScriptVersion:file=>this.stamp(file),
          getProjectVersion:()=>String(current.version),
          getCompilationSettings:()=>current.options,
          getProjectReferences:()=>current.references,
          getCurrentDirectory:()=>key ? path.dirname(key) : this.workspace,
          getDefaultLibFileName:o=>ts.getDefaultLibFilePath(o),
          getScriptSnapshot:file=>{
            file=path.resolve(file);const stamp=this.stamp(file);
            if (stamp==="missing" || stamp==="directory") return undefined;
            let cached=this.snapshots.get(file);
            if (!cached || cached.stamp!==stamp) {
              const text=this.read(file);if (text===undefined) return undefined;
              cached={stamp,snapshot:ts.ScriptSnapshot.fromString(text)};this.snapshots.set(file,cached);
            }
            return cached.snapshot;
          },
          fileExists:file=>{const s=this.stamp(file);return s!=="missing" && s!=="directory";},
          readFile:file=>this.read(file),
          directoryExists:dir=>{this.stamp(dir);return ts.sys.directoryExists(dir);},
          getDirectories:dir=>{this.inputs.set(path.resolve(dir),inputStamp(dir,"entries:"));return ts.sys.getDirectories(dir);},
          readDirectory:ts.sys.readDirectory,realpath:ts.sys.realpath,
          useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
          hasInvalidatedResolutions:file=>this.resolveAll || this.resolutionChanges.has(path.resolve(file)),
        };
        current.service=ts.createLanguageService(host,this.registry);state=current;this.services.set(key,state);
      }
      state.roots=roots;state.options=options;state.version++;
      const program=state.service.getProgram();
      if (!program) throw new Error("TypeScript graph program is unavailable.");
      const checker=program.getTypeChecker();
      for (const file of roots) {
        this.checkCancelled();
        if (!affected.has(file)) continue;
        const sf=program.getSourceFile(file);if (!sf) throw new Error(`Compiler omitted graph source: ${file}`);
        const deps=new Set<string>();
        const f=this.extract(sf,checker,eligible,projectFor,key,deps);
        facts.set(file,f);
        for (const dep of this.dependencies.get(file) ?? []) this.dependents.get(dep)?.delete(file);
        this.dependencies.set(file,deps);
        for (const dep of deps) {if (!this.dependents.has(dep)) this.dependents.set(dep,new Set());this.dependents.get(dep)!.add(file);}
        if (!ts.isExternalModule(sf) || sf.statements.some(n=>ts.isModuleDeclaration(n) && !!(n.flags & ts.NodeFlags.GlobalAugmentation))) this.globals.add(file);
        else this.globals.delete(file);
      }
    }
    for (const [key,value] of this.services) if (!groups.has(key)) {value.service.dispose();this.services.delete(key);}
    for (const file of this.dependencies.keys()) if (!eligible.has(file)) {
      for (const dep of this.dependencies.get(file)!) this.dependents.get(dep)?.delete(file);
      this.dependencies.delete(file);this.globals.delete(file);this.snapshots.delete(file);
    }
    this.description=`TypeScript ${ts.version}: ${eligible.size} files in ${groups.size} projects; ${all.length-eligible.size} heuristic files. Static bindings only; runtime/member dispatch is not proven.`;
    return facts;
  }

  private extract(sf: TS.SourceFile, checker: TS.TypeChecker, eligible: Set<string>, projects: Map<string,string>, context: string, deps: Set<string>): FileFacts {
    const ts=this.ts, file=path.resolve(sf.fileName), rel=path.relative(this.workspace,file);
    const result:FileFacts={symbols:[],refs:[],imports:[]};
    const callable=(n:TS.Node): n is TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction | TS.MethodDeclaration | TS.GetAccessorDeclaration | TS.SetAccessorDeclaration | TS.ConstructorDeclaration =>
      ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n)||ts.isGetAccessor(n)||ts.isSetAccessor(n)||ts.isConstructorDeclaration(n);
    const normalize=(n:TS.Node):TS.Node=>{
      if ((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n)||ts.isPropertyAssignment(n)) && n.initializer && callable(n.initializer)) return n.initializer;
      return n;
    };
    const label=(n:TS.Node):string=>{
      if (ts.isConstructorDeclaration(n)) return "constructor";
      if ((ts.isArrowFunction(n)||ts.isFunctionExpression(n)) && (ts.isVariableDeclaration(n.parent)||ts.isPropertyDeclaration(n.parent)||ts.isPropertyAssignment(n.parent))) return n.parent.name.getText();
      const name=(n as TS.NamedDeclaration).name;
      if (name && (ts.isIdentifier(name)||ts.isPrivateIdentifier(name)||ts.isStringLiteral(name)||ts.isNumericLiteral(name))) return name.text;
      return `<${ts.SyntaxKind[n.kind]}@${n.getStart()}>`;
    };
    const cache=new WeakMap<TS.Node,Symbol>();
    const describe=(raw:TS.Node):Symbol|undefined=>{
      const node=normalize(raw), previous=cache.get(node);if (previous) return previous;
      const source=node.getSourceFile(), abs=path.resolve(source.fileName);if (!eligible.has(abs)) return undefined;
      const start=node.getStart(source), location=source.getLineAndCharacterOfPosition(start), parts=[label(node)];
      for (let parent=node.parent;parent && !ts.isSourceFile(parent);parent=parent.parent) {
        if (callable(parent)||ts.isClassDeclaration(parent)||ts.isClassExpression(parent)||ts.isInterfaceDeclaration(parent)||ts.isModuleDeclaration(parent)) parts.unshift(label(parent));
        else if (ts.isBlock(parent) && !(callable(parent.parent) && parent.parent.body===parent)) parts.unshift(`<block@${parent.getStart(source)}>`);
      }
      const qualified=parts.join("."), relative=path.relative(this.workspace,abs), project=projects.get(abs)!;
      const kind=ts.isClassDeclaration(node)||ts.isClassExpression(node)?"class":ts.isInterfaceDeclaration(node)?"interface":ts.isTypeAliasDeclaration(node)?"type":ts.isEnumDeclaration(node)?"enum":
        ts.isMethodDeclaration(node)||ts.isMethodSignature(node)||ts.isGetAccessor(node)||ts.isSetAccessor(node)||ts.isConstructorDeclaration(node)?"method":callable(node)?"function":"initializer";
      const value:Symbol={name:label(node),kind,path:relative,line:location.line+1,signature:source.text.slice(start).split("\n",1)[0]!.trim().slice(0,120),
        id:`ts:${hashText(JSON.stringify([project ? path.relative(this.workspace,project) : "<inferred>",relative,qualified,start])).slice(0,32)}`,
        qualified,end_line:source.getLineAndCharacterOfPosition(node.end).line+1,column:location.character+1,provider:"typescript"};
      cache.set(node,value);return value;
    };
    const project=context ? path.relative(this.workspace,context) : "<inferred>";
    const module:Symbol={name:"<module>",qualified:"<module>",kind:"module",path:rel,line:1,column:1,end_line:sf.getLineAndCharacterOfPosition(sf.end).line+1,
      signature:"<module>",provider:"typescript",id:`ts:${hashText(JSON.stringify([project,rel,"<module>"])).slice(0,32)}`};
    result.symbols.push(module);
    const added=new Set([module.id]);
    const add=(s:Symbol|undefined):void=>{if (s && !added.has(s.id) && s.name!=="extends" && s.name!=="implements") {added.add(s.id);result.symbols.push(s);}};
    const dependency=(n:TS.Node):void=>{const target=path.resolve(n.getSourceFile().fileName);if(target!==file)deps.add(target);};
    const moduleReference=(node:TS.Node,target:string):void=>{
      result.imports.push({target,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1});
      const symbol=checker.getSymbolAtLocation(node);
      for (const d of symbol?.declarations ?? []) dependency(d);
    };
    const broken=(sf as TS.SourceFile & {parseDiagnostics?:readonly TS.Diagnostic[]}).parseDiagnostics?.length;
    const visit=(node:TS.Node,owner:Symbol):void=>{
      this.checkCancelled();
      const outerOwner=owner;
      if ((callable(node) && !!node.body)||ts.isClassDeclaration(node)||ts.isClassExpression(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node)||ts.isMethodSignature(node)||(ts.isFunctionDeclaration(node)&&sf.isDeclarationFile)) {
        const symbol=describe(node);add(symbol);if (callable(node)&&node.body&&symbol) owner=symbol;
      }
      // Initializers execute in a different context from a constructor/method body.
      if (ts.isDecorator(node)||ts.isClassStaticBlockDeclaration(node)||
          (ts.isPropertyDeclaration(node)&&node.initializer&&!callable(node.initializer))) {
        const symbol=describe(node);if (symbol) {symbol.kind="initializer";add(symbol);owner=symbol;}
      }
      if ((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)) moduleReference(node.moduleSpecifier,node.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression&&ts.isStringLiteralLike(node.moduleReference.expression)) moduleReference(node.moduleReference.expression,node.moduleReference.expression.text);
      if (ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteralLike(node.argument.literal)) moduleReference(node.argument.literal,node.argument.literal.text);
      if (ts.isCallExpression(node)||ts.isNewExpression(node)) {
        let expression: TS.Expression=node.expression;
        while (ts.isParenthesizedExpression(expression)||ts.isNonNullExpression(expression)||ts.isAsExpression(expression)||ts.isTypeAssertionExpression(expression)) expression=expression.expression;
        if (ts.isCallExpression(node)&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&
            (expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(expression)&&expression.text==="require"))) moduleReference(node.arguments[0],node.arguments[0].text);
        let binding=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression)?expression.name:expression);
        const seen=new Set<TS.Symbol>();
        while (binding && (binding.flags&ts.SymbolFlags.Alias) && !seen.has(binding)) {seen.add(binding);binding=checker.getAliasedSymbol(binding);}
        let declarations=(binding?.declarations ?? []).map(normalize);
        if (callable(expression)) declarations=[expression];
        for (const declaration of declarations) dependency(declaration);
        if (ts.isNewExpression(node)&&declarations.length===1&&(ts.isClassDeclaration(declarations[0]!)||ts.isClassExpression(declarations[0]!))) {
          const constructors=(declarations[0] as TS.ClassLikeDeclaration).members.filter((m):m is TS.ConstructorDeclaration=>ts.isConstructorDeclaration(m)&&!!m.body);
          if (constructors.length===1) declarations=constructors;
        }
        const bodies=declarations.filter(d=>callable(d)&&d.body);
        if (bodies.length) declarations=bodies;
        declarations=[...new Set(declarations)];
        let status="unresolved",dispatch="unknown",target:Symbol|undefined;
        if (!broken && declarations.length>1) status="ambiguous";
        if (!broken && declarations.length===1) {
          const declaration=declarations[0]!;
          if (ts.isParameter(declaration)) {status="indirect";dispatch="callback";}
          else if (callable(declaration)||ts.isMethodSignature(declaration)) {
            target=describe(declaration);
            status=target ? (callable(declaration)&&declaration.body ? "resolved" : "contract") : "external";
            dispatch=ts.isMethodDeclaration(declaration)||ts.isMethodSignature(declaration)||ts.isGetAccessor(declaration)||ts.isSetAccessor(declaration)?"member":"direct";
            if (ts.isArrowFunction(declaration)||ts.isFunctionExpression(declaration)) {
              const parent=declaration.parent;
              if (ts.isVariableDeclaration(parent)&&!(parent.parent.flags&ts.NodeFlags.Const)) {status="indirect";dispatch="mutable";}
              if (ts.isPropertyDeclaration(parent)||ts.isPropertyAssignment(parent)) dispatch="member";
            }
            if (target && projects.get(path.resolve(declaration.getSourceFile().fileName))!==context) status="cross_project";
          } else status=eligible.has(path.resolve(declaration.getSourceFile().fileName)) ? "indirect" : "external";
        }
        const position=node.getStart(sf);
        const callee=ts.isPropertyAccessExpression(expression)?expression.name.text:ts.isIdentifier(expression)?expression.text:expression.getText(sf).slice(0,120);
        result.refs.push({caller:owner.name,callee,path:rel,line:sf.getLineAndCharacterOfPosition(position).line+1,
          id:`${hashText(rel).slice(0,32)}@${position}`,caller_id:owner.id,target_id:target?.id ?? null,status,dispatch,position});
      }
      ts.forEachChild(node,child=>visit(child,ts.isDecorator(child)||ts.isComputedPropertyName(child) ? outerOwner : owner));
    };
    visit(sf,module);
    return result;
  }
}

/** Mask comments without shifting lines or mistaking quoted URLs for comments.
 * Multiline literals and templates are opaque and masked too, so their prose
 * cannot become definitions. Template interpolation is not parsed; JS regex
 * starts use expression-prefix heuristics. Ordinary quoted imports survive.
 */
export function codeForIndexing(text: string, ext: string): string {
  const hash = ext === ".py" || ext === ".rb" || ext === ".php";
  const slash = ext !== ".py" && ext !== ".rb";
  const js = JS_EXTENSIONS.has(ext);
  const parts: string[] = [];
  let copied = 0;
  const mask = (start: number, end: number): void => {
    parts.push(text.slice(copied, start), text.slice(start, end).replace(/[^\r\n]/g, " "));
    copied = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      const quote = ext === ".py" && text.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
      i += quote.length;
      for (; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text.startsWith(quote, i)) { i += quote.length - 1; break; }
        if (quote !== "`" && quote.length === 1 && text[i] === "\n") { i--; break; }
      }
      if (quote === "`" || quote.length === 3 || text.slice(start, i + 1).includes("\n")) {
        mask(start, Math.min(i + 1, text.length));
      }
      continue;
    }
    const block = slash && c === "/" && text[i + 1] === "*";
    const line = (slash && c === "/" && text[i + 1] === "/") || (hash && c === "#");
    if (block || line) {
      let end = block ? text.indexOf("*/", i + 2) : text.indexOf("\n", i);
      end = end < 0 ? text.length : end + (block ? 2 : 0);
      mask(i, end);
      i = end - 1;
    } else if (js && c === "/") {
      // In a regex, even [/*] or [//] are literal character classes.
      const prefix = text.slice(Math.max(0, i - 32), i).trimEnd();
      if (!prefix || /[=(:,\[!&|?{};]$|\b(?:return|throw|yield|case|void|typeof|delete|in|of)$/.test(prefix)) {
        let inClass = false;
        for (let j = i + 1; j < text.length && text[j] !== "\n"; j++) {
          if (text[j] === "\\") { j++; continue; }
          if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) { i = j; break; }
        }
      }
    }
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

export function isAnalysisControl(file: string): boolean {
  return /^(?:tsconfig.*\.json|jsconfig.*\.json|package\.json|.*lock.*|pyproject\.toml|pyrightconfig\.json|setup\.(?:cfg|py)|requirements.*\.txt|pom\.xml|.*\.gradle(?:\.kts)?|gradle(?:-wrapper)?\.properties|Cargo\.toml|rust-project\.json|go\.(?:mod|sum|work)|CMakeLists\.txt|compile_commands\.json|compile_flags\.txt|.*\.(?:csproj|sln|slnx|props|targets)|Package\.(?:swift|resolved)|composer\.json|Gemfile|pubspec\.(?:yaml|yml)|build\.sbt|\.clangd|\.classpath|\.project)$/.test(path.basename(file));
}

function* walk(dir: string, checkCancelled: () => void = () => {}, observeDirectory?: (dir: string) => void): Generator<string> {
  checkCancelled();
  observeDirectory?.(dir);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    checkCancelled();
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && !isAnalysisControl(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, checkCancelled, observeDirectory);
    else if (e.isFile()) yield full;
  }
}
