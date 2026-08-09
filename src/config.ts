/**
 * Configuration: env vars > .faber/config.json > defaults.
 * State lives in <workspace>/.faber/ — except in projects created before the
 * rename, where an existing .codewright/ directory is adopted as-is so memory,
 * code graph, sessions and usage history survive the upgrade untouched.
 * FABER_* env vars are canonical; legacy CW_* names still work.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSettings, activeProfile, type Profile } from "./settings.js";
import { getRoute, resolveModel, baseUrlFor, ROUTES } from "./routes.js";
import { resolveCredential, getCredential } from "./credentials.js";

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
  route: string;                      // which route owns this session
  region: string | undefined;
  modelPins: Record<string, string>;  // alias -> real id (cloud/local routes)
  profileName: string;
  priceIn: number | undefined;
  autoRefreshPrices: boolean;
  priceOut: number | undefined;
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

  // Global profile sits below project config and above defaults.
  const settings = loadSettings();
  const prof: Profile = activeProfile(settings);
  const route = getRoute(process.env.FABER_ROUTE ?? s("route") ?? prof.route) ?? ROUTES[0]!;
  const pins = { ...(prof.modelPins ?? {}), ...((fileCfg["modelPins"] as Record<string, string>) ?? {}) };

  // The route decides the wire format unless a provider is set explicitly.
  const provider = (process.env.CW_PROVIDER ?? s("provider") ?? route.wire).toLowerCase() as Config["provider"];
  const anthropic = provider === "anthropic";
  const rawModel = process.env.CW_MODEL ?? s("model") ?? prof.model
    ?? (anthropic ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
  // Env var first, then the 0600 credential store — unless the profile says
  // the stored key was chosen deliberately, in which case honour that.
  const keyFromProfile = prof.apiKeyEnv
    ? (prof.preferStoredKey
        ? (getCredential(prof.apiKeyEnv) ?? resolveCredential(prof.apiKeyEnv))
        : resolveCredential(prof.apiKeyEnv))
    : undefined;
  const region = process.env.FABER_REGION ?? s("region") ?? prof.region;
  const routeUrl = baseUrlFor(route, region);
  // A route-specific credential (e.g. BEDROCK_API_KEY) wins over the generic one.
  const routeKey = route.keyEnv
    ? (prof.preferStoredKey ? (getCredential(route.keyEnv) ?? resolveCredential(route.keyEnv))
                            : resolveCredential(route.keyEnv))
    : undefined;
  return {
    workspace: ws,
    stateDir,
    provider,
    model: resolveModel(rawModel, route, pins),
    baseUrl: process.env.CW_BASE_URL ?? s("baseUrl") ?? prof.baseUrl ?? routeUrl
      ?? (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
    // A route that names its own credential (BEDROCK_API_KEY) must NOT fall
    // back to the generic one: sending an Anthropic key to Bedrock produces a
    // confusing 401 and hides the fact that AWS signing was available.
    apiKey: routeKey ?? keyFromProfile ?? s("apiKey")
      ?? (route.keyEnv
            ? undefined
            : resolveCredential(anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")),
    weakModel: process.env.CW_WEAK_MODEL ?? s("weakModel") ?? prof.weakModel,
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
    route: route.id,
    region,
    modelPins: pins,
    profileName: settings.activeProfile,
    priceIn: Number(process.env.FABER_PRICE_IN) || prof.priceIn,
    // On by default: costs are frozen per task, so silently stale prices would
    // corrupt history permanently. Opt out with FABER_AUTO_PRICES=0.
    autoRefreshPrices: process.env.FABER_AUTO_PRICES === "0" ? false
      : process.env.FABER_AUTO_PRICES === "1" ? true
      : prof.autoRefreshPrices !== false,
    priceOut: Number(process.env.FABER_PRICE_OUT) || prof.priceOut,
  };
}
