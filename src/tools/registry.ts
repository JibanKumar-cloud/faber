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
import { AmbiguousSymbolError, SymbolNotFoundError, formatEdge, type CodeIndexer, type Symbol } from "../indexer.js";
import { FsTools, type PendingWrite } from "./fs.js";
import { SessionStore } from "../memory/sessions.js";
import { ShellTool } from "./shell.js";
import type { ToolSchema } from "../llm.js";

export type ApprovalFn = (pending: PendingWrite) => Promise<boolean>;
export type AskUserFn = (question: string, options: string[]) => Promise<number>;

interface FieldSpec { type: "string" | "integer" | "boolean" | "string_array"; required?: boolean; }
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
    private indexer: CodeIndexer,
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
        description: "Surgically edit a file by replacing old_str (exact text, including whitespace) with new_str. old_str must match exactly once; to change every occurrence in the file in one call (renaming an identifier, for example) pass replace_all=true. Prefer over write_file for existing files.",
        fields: { path: { type: "string", required: true }, old_str: { type: "string", required: true }, new_str: { type: "string", required: true }, replace_all: { type: "boolean" } },
        handler: (i) => this.applyPending(this.fs.stageEdit(i.path as string, i.old_str as string, i.new_str as string, i.replace_all === true)),
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
          return this.shell.run(command, i.timeout != null ? (i.timeout as number) * 1000 : undefined, signal);
        },
      },
      search_code: {
        description: "Find definitions (functions, methods, classes) by name or part of a name, in any language. Each result has an ID like `src/store.ts#Store.save` that the other graph tools accept. Same-named definitions are listed separately.",
        fields: { query: { type: "string", required: true } },
        handler: async (i) => {
          await this.freshIndex();
          const results = this.indexer.search(i.query as string);
          return results.length
            ? results.map(formatSymbol).join("\n")
            : "No definitions matched. Try `grep` for full-text search.";
        },
      },
      who_calls: {
        description: "Code graph: every call site of a function/method (its blast radius). Pass a name, `Class.method`, or an ID from search_code; a name shared by several definitions is answered per definition. Lines read `file:line  caller  [why it was linked]`; `inferred` and `ambiguous` lines are name matches to verify in source.",
        fields: { name: { type: "string", required: true } },
        handler: async (i) => {
          await this.freshIndex();
          return this.perDefinition(i.name as string, s => {
            const edges = this.indexer.whoCalls(s.id, 40), n = this.indexer.callerCounts(s.id);
            // Always state the totals: a list cut at 40 must not read as "these are all the callers".
            const summary = `${n.total} call site${n.total === 1 ? "" : "s"}: ${n.resolved} resolved, ${n.inferred} inferred, ${n.ambiguous} possible (ambiguous); ${n.outsideTests} outside tests.`;
            const cut = n.total > edges.length ? `\n… ${n.total - edges.length} more not shown (non-test callers are listed first). grep the name within a directory if you need the rest.` : "";
            return edges.length ? `${summary}\n${edges.map(e => formatEdge(e, this.indexer, "callee")).join("\n")}${cut}`
              : "No recorded callers. It may be an entry point, exported for other projects, or called dynamically.";
          });
        },
      },
      calls_from: {
        description: "Code graph: what a function/method calls inside this repository (its dependencies). Lines read `line N  caller → callee ID  [why]`, in the definition's own file. For a class, covers all of its methods. Calls into libraries and built-ins are omitted.",
        fields: { name: { type: "string", required: true } },
        handler: async (i) => {
          await this.freshIndex();
          return this.perDefinition(i.name as string, s => {
            const edges = this.indexer.callsFrom(s.id);
            return edges.length ? edges.map(e => formatEdge(e, this.indexer, "caller")).join("\n")
              : "Calls nothing defined in this repository (a leaf, or it only uses libraries and dynamic calls).";
          });
        },
      },
      trace_path: {
        description: "Code graph: shortest chain of calls from one definition to another, e.g. trace_path(main, saveUser), with the source line of every hop. Both ends must identify one definition (use an ID when a name is shared).",
        fields: { from: { type: "string", required: true }, to: { type: "string", required: true } },
        handler: async (i) => {
          await this.freshIndex();
          const result = this.indexer.trace(i.from as string, i.to as string);
          return result.status === "found"
            ? [result.nodes.map(s => s.qualified).join(" → "), ...result.hops.map(e => formatEdge(e, this.indexer))].join("\n")
            : `No path found: ${result.reason}`;
        },
      },
      graph_context: {
        description: "Code graph: the definitions most relevant to a task description or a list of identifiers/paths, with their direct callers and callees, within a token budget (default 1500). Use it to orient before reading files.",
        fields: { query: { type: "string", required: true }, token_budget: { type: "integer" } },
        handler: async (i) => {
          await this.freshIndex();
          return this.indexer.context(i.query as string, i.token_budget as number | undefined)
            || "Nothing in the graph matches those words. Try search_code with one identifier, or grep.";
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
    return pending.apply();
  }

  /** Graph tools read saved files: bring the graph up to date first (milliseconds when nothing changed). */
  private async freshIndex(): Promise<void> {
    try { await this.indexer.refresh(); }
    catch (error) { throw new ToolError(`Code graph refresh failed: ${String(error)}`); }
  }

  /** Answer for each definition a selector names, so a shared name never needs a second round trip. */
  private perDefinition(selector: string, answer: (symbol: Symbol) => string): string {
    const found = this.indexer.find(selector, 13);
    if (!found.length) return `No definition matches '${selector}'. Use search_code to find it, or grep for text.`;
    if (found.length === 1) return `${formatSymbol(found[0]!)}\n${answer(found[0]!)}`;
    if (found.length > 6) {
      return `'${selector}' names ${found.length > 12 ? "more than 12" : found.length} definitions. Call again with one of these IDs:\n` +
        found.slice(0, 12).map(formatSymbol).join("\n");
    }
    return `'${selector}' names ${found.length} definitions; each is answered separately.\n\n` +
      found.map(s => `${formatSymbol(s)}\n${answer(s)}`).join("\n\n");
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
      if (spec.type === "boolean" && typeof v !== "boolean") {
        return { output: `Argument '${field}' of ${name} must be true or false.`, isError: true };
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

function formatSymbol(s: Symbol): string {
  return `${s.id}  [${s.kind}] line ${s.line}\n    ${s.signature}`;
}
