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
import type { CodeIndexer } from "../indexer.js";
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
          return this.shell.run(command, i.timeout != null ? (i.timeout as number) * 1000 : undefined, signal);
        },
      },
      search_code: {
        description: "Search the symbol index for function/class definitions by name.",
        fields: { query: { type: "string", required: true } },
        handler: (i) => {
          this.freshIndex();
          const results = this.indexer.search(i.query as string);
          return results.length
            ? results.map((r) => `${r.path}:${r.line} [${r.kind}] ${r.signature}`).join("\n")
            : "No symbols matched. Try `grep` for full-text search.";
        },
      },
      who_calls: {
        description: "Code graph: list every place a function/symbol is called FROM (its blast radius). Edges are static-analysis hints — verify by reading where precision matters.",
        fields: { name: { type: "string", required: true } },
        handler: (i) => {
          this.freshIndex();
          const edges = this.indexer.whoCalls(i.name as string);
          return edges.length
            ? edges.map((e) => `${e.caller} -> ${i.name}  (${e.path}:${e.line})`).join("\n")
            : `No recorded callers of ${i.name}. It may be an entry point, called dynamically, or unindexed.`;
        },
      },
      calls_from: {
        description: "Code graph: list everything a function calls (its dependencies). Static hints — verify by reading where precision matters.",
        fields: { name: { type: "string", required: true } },
        handler: (i) => {
          this.freshIndex();
          const edges = this.indexer.callsFrom(i.name as string);
          return edges.length
            ? edges.map((e) => `${i.name} -> ${e.callee}  (${e.path}:${e.line})`).join("\n")
            : `${i.name} calls no indexed symbols (leaf function, or calls only external/dynamic code).`;
        },
      },
      trace_path: {
        description: "Code graph: shortest call chain connecting two symbols, e.g. trace_path(main, saveUser) -> main -> startServer -> handleSignup -> saveUser. Use to understand workflow before editing.",
        fields: { from: { type: "string", required: true }, to: { type: "string", required: true } },
        handler: (i) => {
          this.freshIndex();
          const chain = this.indexer.tracePath(i.from as string, i.to as string);
          return chain
            ? chain.join(" -> ")
            : `No static call path found from ${i.from} to ${i.to} (may be connected dynamically, via events, or not at all).`;
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

  private freshIndex(): void {
    if (!this.indexer.isBuilt()) this.indexer.build();
    else this.indexer.refresh(); // incremental: only changed files re-parsed
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
