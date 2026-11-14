/**
 * Tool registry: schemas + dispatch.
 * Hardening beyond v0.1:
 *  - Input VALIDATION before execution (required fields, types) so malformed
 *    model output becomes a corrective error message, never a crash.
 *  - Mutating tools route through an approval hook (diff preview in "ask" mode).
 *  - Repeated-identical-call detection (doom-loop breaker) lives in the agent,
 *    fed by the canonical call signature produced here.
 */
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import type { CheckpointManager } from "../checkpoints.js";
import type { LongTermMemory } from "../memory/longTerm.js";
import { AmbiguousSymbolError, SymbolNotFoundError, type Edge } from "../indexer.js";
import type { GraphIndexer } from "../graph/background.js";
import { pendingContext, type CurrentGraph, type LiveMethod, type LiveValues } from "../graph/live.js";
import { FsTools, type PendingWrite } from "./fs.js";
import { SessionStore } from "../memory/sessions.js";
import { ShellTool } from "./shell.js";
import type { ToolSchema } from "../llm.js";

export type ApprovalFn = (pending: PendingWrite) => Promise<boolean>;
export type AskUserFn = (question: string, options: string[]) => Promise<number>;

interface FieldSpec { type: "string" | "integer" | "string_array"; required?: boolean; }
interface ToolDef {
  description: string;
  fields: Record<string, FieldSpec>;
  handler: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string;
}

export class ToolRegistry {
  private fs: FsTools;
  private shell: ShellTool;
  private defs: Record<string, ToolDef>;

  currentSessionId?: string;

  constructor(
    private config: Config,
    checkpoints: CheckpointManager,
    private ltm: LongTermMemory,
    private indexer: GraphIndexer,
    private approve: ApprovalFn,
    private askUser: AskUserFn = async () => 0,
  ) {
    this.fs = new FsTools(config, checkpoints);
    this.shell = new ShellTool(config);

    this.defs = {
      read_file: {
        description: "Read a file with line numbers. Use start_line/end_line for large files.",
        fields: { path: { type: "string", required: true }, start_line: { type: "integer" }, end_line: { type: "integer" } },
        handler: (i) => this.fs.readFile(i.path as string, (i.start_line as number) ?? 1, i.end_line as number | undefined),
      },
      write_file: {
        description: "Create or overwrite a file. A checkpoint is taken automatically; in ask-mode the user previews a diff first.",
        fields: { path: { type: "string", required: true }, content: { type: "string", required: true } },
        handler: (i) => this.applyPending(this.fs.stageWrite(i.path as string, i.content as string)),
      },
      edit_file: {
        description: "Surgically edit a file by replacing old_str (must match exactly once, including whitespace) with new_str. Prefer over write_file for existing files.",
        fields: { path: { type: "string", required: true }, old_str: { type: "string", required: true }, new_str: { type: "string", required: true } },
        handler: (i) => this.applyPending(this.fs.stageEdit(i.path as string, i.old_str as string, i.new_str as string)),
      },
      list_dir: {
        description: "List directory contents as a tree (default depth 2).",
        fields: { path: { type: "string" }, depth: { type: "integer" } },
        handler: (i) => this.fs.listDir((i.path as string) ?? ".", (i.depth as number) ?? 2),
      },
      grep: {
        description: "Regex search across files. Returns path:line: match.",
        fields: { pattern: { type: "string", required: true }, path: { type: "string" }, max_results: { type: "integer" } },
        handler: (i) => this.fs.grep(i.pattern as string, (i.path as string) ?? ".", (i.max_results as number) ?? 50),
      },
      run_shell: {
        description: "Run a shell command in the workspace (tests, builds, git, installs). Output includes exit code. Destructive commands are blocked; in ask-mode the user approves each command first.",
        fields: { command: { type: "string", required: true }, timeout: { type: "integer" } },
        handler: async (i, signal) => {
          const command = i.command as string;
          const ok = await this.approve({
            kind: "shell",
            path: `$ ${command}`,
            diff: command,
            apply: () => "",
          });
          if (!ok) {
            throw new ToolError(
              `User REJECTED running: ${command}. Do not retry the same command; ask the user or take a different approach.`,
            );
          }
          try { return await this.shell.run(command, i.timeout != null ? (i.timeout as number) * 1000 : undefined, signal); }
          finally { this.indexer.requestCheck?.(); }
        },
      },
      search_code: {
        description: "Search current definitions by name or qualified name. Returns source locations, analysis provider and IDs for selecting same-named symbols; IDs may change after edits. During background indexing, returns current saved-text hints without symbol bindings.",
        fields: { query: { type: "string", required: true } },
        handler: async (i, signal) => {
          const graph = await this.currentGraph("search", [i.query, undefined], signal);
          if (graph.status !== "ready") return pendingContext(graph);
          const results = graph.value;
          return results.length
            ? results.map((r) => `${r.path}:${r.line} [${r.kind}; ${r.provider}] ${r.signature}\n  ${r.qualified} id=${r.id}`).join("\n")
            : "No symbols matched. Try `grep` for full-text search.";
        },
      },
      who_calls: {
        description: "Code graph: bounded recorded callers of a name or exact symbol ID. Ambiguous names require an ID. Static bindings and heuristic hints are labeled; runtime dispatch and exhaustiveness are not guaranteed.",
        fields: { name: { type: "string", required: true } },
        handler: async (i, signal) => {
          const graph = await this.currentGraph("whoCalls", [i.name, undefined], signal);
          if (graph.status !== "ready") return pendingContext(graph);
          const edges = graph.value;
          return edges.length
            ? formatGraphEdges(edges)
            : `No recorded callers of ${i.name}. It may be an entry point, called dynamically, or unindexed.`;
        },
      },
      graph_context: {
        description: "Find task-relevant current definitions by names, paths and signatures, with bounded resolved static call neighbors. Returns source locations, symbol IDs and labeled analysis providers; during indexing, returns current saved-text hints without call bindings. Token budget is a byte-based estimate; no result proves runtime execution.",
        fields: { query: { type: "string", required: true }, token_budget: { type: "integer" } },
        handler: async (i, signal) => {
          const graph = await this.currentGraph("taskContext", [i.query, { tokenBudget: i.token_budget as number | undefined }], signal);
          if (graph.status !== "ready") return pendingContext(graph, { tokenBudget: i.token_budget as number | undefined });
          const result = graph.value;
          return result.text || "No task-relevant symbols fit this query and budget. Try search_code or grep with a specific identifier or path.";
        },
      },
      graph_changes: {
        description: "List saved files added, modified or deleted since graph indexing, without running an analyzer. Records include the saved metadata revision and the graph generation that incorporated them. Read pending files directly for current code. Optional include_indexed=1 includes the last incorporated record per file; limit defaults to 100 (max 1000).",
        fields: { limit: { type: "integer" }, include_indexed: { type: "integer" } },
        handler: async (i, signal) => {
          if (i.include_indexed !== undefined && i.include_indexed !== 0 && i.include_indexed !== 1) throw new ToolError("include_indexed must be 0 or 1.");
          return JSON.stringify(await this.indexer.changes(i.limit as number | undefined,i.include_indexed === 1,signal));
        },
      },
      graph_status: {
        description: "Report current graph job phase, elapsed time, last published graph coverage and stage timings, last metadata check, and last query's freshness timeout. Does not scan files, start analysis or wait for the worker. A completed job does not prove saved files are still unchanged. If the user requests graph navigation or a retry and analysis is scheduled, call graph_context immediately to bypass the idle delay; do not stop after a status check and tell them to wait. search_code searches definition names, not copied filenames; heuristic IDs are fallback hints, not pending semantic analysis. Avoid sleep-and-search polling.",
        fields: {},
        handler: async () => {
          if (!this.indexer.status) return "Graph timing information is unavailable in this session.";
          const status = this.indexer.status();
          return JSON.stringify({...status,readTiming: { latestReadKind: !status.lastRead ? "none" :
            status.lastRead.method === "prompt" ? "startup_context" : "graph_query",
            graphQueryRecorded: !!status.lastGraphRead,
            note: "lastStartupRead measures task startup; lastGraphRead measures an explicit graph request. Scheduled work does not erase lastIndexedUpdate or prove that bindings are unavailable." },
            nextAction:status.state === "scheduled" || status.state === "pending"
            ? {tool:"graph_context",reason:"For a requested graph task, call now to bypass the idle fallback; graph_status does not start analysis."}
            : undefined});
        },
      },
      calls_from: {
        description: "Code graph: bounded call references from a name or exact symbol ID, including unresolved, indirect and contract references. Copy complete IDs from current search_code or graph_context results. For calls inside class methods, query each method's ID; querying the class does not aggregate its methods. Heuristic name matches are not resolved bindings; static bindings do not prove runtime execution or member dispatch.",
        fields: { name: { type: "string", required: true } },
        handler: async (i, signal) => {
          const graph = await this.currentGraph("referencesFrom", [i.name, undefined], signal);
          if (graph.status !== "ready") return pendingContext(graph);
          const edges = graph.value;
          return edges.length
            ? formatGraphEdges(edges)
            : `No recorded call references for ${i.name}. This does not prove it is a leaf function; dynamic or unindexed calls may be missing.`;
        },
      },
      trace_path: {
        description: "Code graph: bounded shortest static-binding path between names or exact IDs, with a source location per hop. Ambiguous names require an ID. Explicitly ambiguous, unresolved and heuristic references are not traversed. Analyzer-reported calls may include potential dynamic targets. This is not proof of runtime execution or dispatch.",
        fields: { from: { type: "string", required: true }, to: { type: "string", required: true } },
        handler: async (i, signal) => {
          const graph = await this.currentGraph("trace", [i.from, i.to, undefined], signal);
          if (graph.status !== "ready") return pendingContext(graph);
          const result = graph.value;
          return result.status === "found"
            ? [`Static binding path (generation ${result.generation}); runtime execution and member dispatch are not proven.`,
                ...result.nodes.map(s => `${s.qualified} (${s.path}:${s.line}) id=${s.id}`),
                ...result.hops.map(formatGraphEdge)].join("\n")
            : `${result.status}: ${result.reason}\nStatic analysis may omit dynamic or unindexed calls; no result proves runtime execution.`;
        },
      },
      remember: {
        description: "Store a durable memory for future sessions: project facts, architecture decisions, user preferences, gotchas. kind is one of fact|decision|preference|gotcha.",
        fields: { kind: { type: "string", required: true }, content: { type: "string", required: true }, tags: { type: "string" } },
        handler: (i) => `Stored memory #${this.ltm.remember(i.kind as string, i.content as string, (i.tags as string) ?? "")} (${i.kind}).`,
      },
      ask_user: {
        description: "Present 2-4 mutually exclusive options to the user and get their pick (arrow-key menu). Use BEFORE implementing when there are meaningfully different approaches, designs, or interpretations of the request. Keep each option short (one line). A 'discuss instead' choice is added automatically — never add your own.",
        fields: { question: { type: "string", required: true }, options: { type: "string_array", required: true } },
        handler: async (i) => {
          const opts = (i.options as string[]).slice(0, 4);
          const withEscape = [...opts, "Chat more about this instead"];
          const pick = await this.askUser(i.question as string, withEscape);
          if (pick < 0 || pick >= opts.length) {
            return "User did not pick an option — they want to discuss further. Ask a clarifying question instead of implementing.";
          }
          return `User chose option ${pick + 1}: "${opts[pick]}". Proceed with this approach.`;
        },
      },
      recall_sessions: {
        description: "Search PAST conversation sessions in this project. Use when the user references a previous conversation ('last time', 'what did I ask before', 'the thing we discussed') or when past context would clearly help. Returns matching snippets with dates.",
        fields: { query: { type: "string", required: true } },
        handler: (i) => {
          const hits = SessionStore.search(this.config.sessionsDir, i.query as string, 5, this.currentSessionId);
          return hits.length
            ? hits.map((h) => `[${h.when}] (${h.role}) ...${h.snippet}...`).join("\n---\n")
            : "No matching past conversations found for that query.";
        },
      },
      note_file: {
        description: "Save/update a one-line summary of what a file does (persisted across sessions).",
        fields: { path: { type: "string", required: true }, summary: { type: "string", required: true } },
        handler: (i) => { this.ltm.noteFile(i.path as string, i.summary as string); return `Noted ${i.path}.`; },
      },
    };
  }

  private async applyPending(pending: PendingWrite): Promise<string> {
    const ok = await this.approve(pending);
    if (!ok) {
      throw new ToolError(
        `User REJECTED the change to ${pending.path}. Do not retry the same change; ask the user what they want instead or take a different approach.`,
      );
    }
    const result = pending.apply();
    this.indexer.invalidate?.(pending.path);
    return result;
  }

  private async currentGraph<M extends Exclude<LiveMethod, "prompt">>(method: M, args: unknown[], signal?: AbortSignal): Promise<CurrentGraph<LiveValues[M]>> {
    if (this.indexer.current) return this.indexer.current(method, args, signal);
    // Embedded direct indexers retain their existing explicit fresh-read API.
    await this.freshIndex(signal);
    const value = await (this.indexer[method] as (...args: any[]) => unknown).apply(this.indexer, [...args, signal]);
    return { status: "ready", generation: 0, value: value as LiveValues[M] };
  }

  private async freshIndex(signal?: AbortSignal): Promise<void> {
    try {
      if (!await this.indexer.isBuilt(signal)) await this.indexer.build(signal);
      else await this.indexer.refresh(signal);
    } catch (error) { throw new ToolError(`Code graph refresh failed: ${String(error)}`); }
  }

  /** Canonical signature used by the agent's doom-loop detector. */
  static signature(name: string, input: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(input, Object.keys(input).sort())}`;
  }

  async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError: boolean }> {
    const def = this.defs[name];
    if (!def) return { output: `Unknown tool: ${name}. Available: ${Object.keys(this.defs).join(", ")}`, isError: true };
    // validate before executing
    for (const [field, spec] of Object.entries(def.fields)) {
      const v = input[field];
      if (v == null) {
        if (spec.required) return { output: `Missing required argument '${field}' for ${name}.`, isError: true };
        continue;
      }
      if (spec.type === "string" && typeof v !== "string") {
        return { output: `Argument '${field}' of ${name} must be a string.`, isError: true };
      }
      if (spec.type === "integer" && (!Number.isFinite(v as number) || !Number.isInteger(v as number))) {
        return { output: `Argument '${field}' of ${name} must be an integer.`, isError: true };
      }
      if (spec.type === "string_array" && (!Array.isArray(v) || !v.every((x) => typeof x === "string") || v.length === 0)) {
        return { output: `Argument '${field}' of ${name} must be a non-empty array of strings.`, isError: true };
      }
    }
    try {
      return { output: String(await def.handler(input, signal)), isError: false };
    } catch (err) {
      if (err instanceof AmbiguousSymbolError || err instanceof SymbolNotFoundError) return { output: err.message, isError: true };
      if (err instanceof ToolError) return { output: `Tool error: ${err.message}`, isError: true };
      throw err; // CancelledError and unexpected errors propagate to the agent
    }
  }

  schemas(): ToolSchema[] {
    return Object.entries(this.defs).map(([name, def]) => ({
      name,
      description: def.description,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(def.fields).map(([f, s]) => [f,
            s.type === "string_array" ? { type: "array", items: { type: "string" } } : { type: s.type },
          ]),
        ),
        required: Object.entries(def.fields).filter(([, s]) => s.required).map(([f]) => f),
      },
    }));
  }
}

function formatGraphEdges(edges: Edge[]): string {
  const rows = edges.map(formatGraphEdge);
  if (edges.some(e => e.status === "heuristic")) rows.unshift(
    "Includes heuristic name matches; these are not resolved call bindings. Verify targets in source.");
  return rows.join("\n");
}

function formatGraphEdge(e: Edge): string {
  return `${e.caller} -> ${e.callee} (${e.path}:${e.line}${e.callee_path ? ` -> ${e.callee_path}:${e.callee_line}` : ""}) [${e.status}; ${e.dispatch}]${e.callee_id ? ` id=${e.callee_id}` : ""}`;
}
