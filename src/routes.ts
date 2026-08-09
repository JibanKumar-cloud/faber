/**
 * Vendors, routes, and model aliases.
 *
 * Three levels, chosen in order:
 *   vendor  — who makes the model (Anthropic, OpenAI-compatible)
 *   route   — how you reach it and who owns authentication
 *             (direct API key, a cloud provider, a local server, a gateway)
 *   model   — an alias (sonnet/opus/haiku) or a raw model id
 *
 * Aliases exist because the same model has different ids on different routes:
 * the direct API calls it "claude-sonnet-5" while Bedrock wants a long
 * region-prefixed inference-profile id. Aliases stay stable; the mapping moves.
 * For cloud routes the mapping is USER-SUPPLIED — we never guess ids we can't
 * verify, since a wrong one fails at request time with a confusing error.
 */

export type Wire = "anthropic" | "openai";

export interface Route {
  id: string;
  vendor: string;
  label: string;
  hint: string;
  wire: Wire;                  // which request format llm.ts should speak
  baseUrl?: string;            // fixed endpoint, when the route has one
  needsBaseUrl?: boolean;      // user must supply the endpoint
  needsRegion?: boolean;       // endpoint is region-scoped
  baseUrlTemplate?: string;    // {region} is substituted at load time
  keyEnv?: string;             // env var holding the credential
  aliasesArePinned?: boolean;  // true = user must pin real ids per alias
  implemented: boolean;        // false = defined but not wired up yet
}

export const ROUTES: Route[] = [
  {
    id: "anthropic-api",
    vendor: "Anthropic",
    label: "Anthropic API",
    hint: "direct, pay per token with your own key",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyEnv: "ANTHROPIC_API_KEY",
    implemented: true,
  },
  {
    // AWS's bedrock-mantle endpoint speaks the first-party Messages dialect and
    // authenticates with a Bedrock API key, so no SigV4 signing is needed —
    // only the base URL and the credential differ from the direct route.
    id: "bedrock",
    vendor: "Anthropic",
    label: "Amazon Bedrock",
    hint: "your AWS account owns auth and billing",
    wire: "anthropic",
    needsRegion: true,
    baseUrlTemplate: "https://bedrock-mantle.{region}.api.aws/anthropic",
    keyEnv: "BEDROCK_API_KEY",
    aliasesArePinned: true,   // Bedrock model ids differ per region/deployment
    implemented: true,
  },
  {
    id: "vertex",
    vendor: "Anthropic",
    label: "Google Vertex AI",
    hint: "your GCP project owns auth and billing",
    wire: "anthropic",
    aliasesArePinned: true,
    implemented: false,   // needs Google OAuth
  },
  {
    id: "openai-api",
    vendor: "OpenAI",
    label: "OpenAI API",
    hint: "direct, with your own key",
    wire: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    implemented: true,
  },
  {
    id: "ollama",
    vendor: "Local",
    label: "Ollama (local)",
    hint: "runs on your machine, no key, no cost",
    wire: "openai",
    baseUrl: "http://localhost:11434/v1",
    aliasesArePinned: true,
    implemented: true,
  },
  {
    id: "custom",
    vendor: "Other",
    label: "OpenAI-compatible endpoint",
    hint: "OpenRouter, Groq, Together, vLLM, a gateway…",
    wire: "openai",
    needsBaseUrl: true,
    keyEnv: "OPENAI_API_KEY",
    aliasesArePinned: true,
    implemented: true,
  },
];

export function getRoute(id: string): Route | undefined {
  return ROUTES.find((r) => r.id === id);
}

export const DEFAULT_REGION = "us-east-1";

/** Endpoint for a route, substituting the region into region-scoped URLs. */
export function baseUrlFor(route: Route, region?: string): string | undefined {
  if (route.baseUrlTemplate) {
    return route.baseUrlTemplate.replace("{region}", region || DEFAULT_REGION);
  }
  return route.baseUrl;
}

/** Vendors in menu order, each with its routes. */
export function vendors(): { vendor: string; routes: Route[] }[] {
  const out: { vendor: string; routes: Route[] }[] = [];
  for (const r of ROUTES) {
    const found = out.find((v) => v.vendor === r.vendor);
    if (found) found.routes.push(r);
    else out.push({ vendor: r.vendor, routes: [r] });
  }
  return out;
}

export interface ModelChoice {
  alias: string;
  id: string;
  blurb: string;
}

/**
 * Built-in aliases for the direct Anthropic API. Ids on cloud routes differ
 * per deployment and region, so those are pinned by the user instead.
 */
export const ANTHROPIC_MODELS: ModelChoice[] = [
  { alias: "sonnet", id: "claude-sonnet-5", blurb: "balanced — good default for daily work" },
  { alias: "opus", id: "claude-opus-5", blurb: "most capable — complex, multi-step work" },
  { alias: "haiku", id: "claude-haiku-4-5-20251001", blurb: "fastest and cheapest — simple tasks" },
];

export const OPENAI_MODELS: ModelChoice[] = [
  { alias: "gpt", id: "gpt-4o", blurb: "general purpose" },
  { alias: "mini", id: "gpt-4o-mini", blurb: "cheaper and faster" },
];

/** Models offered for a route; empty when ids must be pinned by the user. */
export function modelsForRoute(route: Route): ModelChoice[] {
  if (route.aliasesArePinned) return [];
  return route.wire === "anthropic" ? ANTHROPIC_MODELS : OPENAI_MODELS;
}

/**
 * Turn whatever the user typed into a concrete model id.
 * Order: explicit per-route pin > built-in alias > treat it as a raw id.
 */
export function resolveModel(
  input: string,
  route: Route,
  pins: Record<string, string> = {},
): string {
  const key = input.trim();
  if (pins[key]) return pins[key];
  const hit = modelsForRoute(route).find((m) => m.alias === key);
  return hit ? hit.id : key;
}

/** Reverse lookup: show "sonnet (claude-sonnet-5)" instead of a bare id. */
export function describeModel(id: string, route: Route, pins: Record<string, string> = {}): string {
  const pinned = Object.entries(pins).find(([, v]) => v === id);
  if (pinned) return `${pinned[0]} (${id})`;
  const hit = modelsForRoute(route).find((m) => m.id === id);
  return hit ? `${hit.alias} (${id})` : id;
}
