/**
 * Configuration: env vars > .faber/config.json > defaults.
 * State lives in <workspace>/.faber/ — except in projects created before the
 * rename, where an existing .codewright/ directory is adopted as-is so memory,
 * code graph, sessions and usage history survive the upgrade untouched.
 * FABER_* env vars are canonical; legacy CW_* names still work.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Config {
  workspace: string;
  stateDir: string;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  weakModel: string | undefined;   // cheap model for internal summarization (CW_WEAK_MODEL)
  maxTokens: number;
  maxIterations: number;
  contextTokenBudget: number;
  keepRecentMessages: number;
  shellTimeoutMs: number;
  maxFileReadBytes: number;
  retryMaxAttempts: number;
  approvalMode: "auto" | "ask";   // ask = show diff and confirm before writes
  memoryDb: string;
  indexDb: string;
  sessionsDir: string;
  usageDb: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** Accept both FABER_* (canonical) and CW_* (legacy) env var names. */
export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("CW_")) {
      const canonical = "FABER_" + key.slice(3);
      if (process.env[canonical] === undefined) process.env[canonical] = value;
    } else if (key.startsWith("FABER_")) {
      const legacy = "CW_" + key.slice(6);
      if (process.env[legacy] === undefined) process.env[legacy] = value;
    }
  }
}

export function loadConfig(workspace?: string): Config {
  normalizeEnv();
  const ws = path.resolve(workspace ?? process.cwd());
  const legacyDir = path.join(ws, ".codewright");
  const stateDir = fs.existsSync(legacyDir) ? legacyDir : path.join(ws, ".faber");
  fs.mkdirSync(path.join(stateDir, "checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });

  let fileCfg: Record<string, unknown> = {};
  const cfgPath = path.join(stateDir, "config.json");
  if (fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { /* ignore malformed */ }
  }
  const s = (k: string): string | undefined =>
    typeof fileCfg[k] === "string" ? (fileCfg[k] as string) : undefined;

  const provider = (process.env.CW_PROVIDER ?? s("provider") ?? "anthropic").toLowerCase() as Config["provider"];
  const anthropic = provider === "anthropic";
  return {
    workspace: ws,
    stateDir,
    provider,
    model: process.env.CW_MODEL ?? s("model") ?? (anthropic ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL),
    baseUrl: process.env.CW_BASE_URL ?? s("baseUrl") ?? (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
    apiKey: anthropic ? (process.env.ANTHROPIC_API_KEY ?? s("apiKey")) : (process.env.OPENAI_API_KEY ?? s("apiKey")),
    weakModel: process.env.CW_WEAK_MODEL ?? s("weakModel"),
    maxTokens: 4096,
    maxIterations: Number(process.env.CW_MAX_ITERATIONS ?? fileCfg["maxIterations"] ?? 40),
    contextTokenBudget: Number(process.env.CW_CONTEXT_BUDGET ?? fileCfg["contextTokenBudget"] ?? 60_000),
    keepRecentMessages: 12,
    shellTimeoutMs: Number(process.env.CW_SHELL_TIMEOUT ?? fileCfg["shellTimeoutMs"] ?? 120_000),
    maxFileReadBytes: 200_000,
    retryMaxAttempts: 5,
    approvalMode: (process.env.CW_APPROVAL ?? s("approvalMode") ?? "ask") as Config["approvalMode"],
    memoryDb: path.join(stateDir, "memory.db"),
    indexDb: path.join(stateDir, "index.db"),
    sessionsDir: path.join(stateDir, "sessions"),
    usageDb: path.join(stateDir, "usage.db"),
  };
}
