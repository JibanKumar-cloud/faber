/**
 * Model pricing.
 *
 * Where prices come from, best source first:
 *   1. What you configured (env vars or a profile) — always wins.
 *   2. The provider itself, when it publishes prices. OpenRouter's
 *      /api/v1/models returns live per-token rates including cache read/write,
 *      and it needs no key. That is authoritative for that route.
 *   3. A refreshable community dataset covering everyone else.
 *   4. A small built-in table so /usage works with zero configuration.
 *
 * Anthropic's and OpenAI's own /v1/models return ids and capabilities but not
 * dollars, which is why 3 and 4 exist at all.
 *
 * The built-in table is deliberately small and dated. It exists so `/usage`
 * shows real numbers out of the box; it is not the source of truth. Anything
 * you set explicitly always wins, and `/usage --refresh-prices` pulls current
 * figures. Prices here are $ per MILLION tokens.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelPrice {
  in: number;
  out: number;
  cacheRead?: number;    // reading a cached prefix
  cacheWrite?: number;   // storing one (charged once, at a premium)
  /**
   * What kind of model this is: "chat", "embedding", "responses", and so on.
   * The dataset knows this, which is far better than inferring it from the
   * model's name — a guess that gets a new naming scheme wrong every time.
   */
  mode?: string;
  /** Endpoints the model serves, e.g. ["/v1/responses"]. */
  endpoints?: string[];
}

/** Verified 2026-08. Check the vendor's pricing page before quoting these. */
export const PRICES_AS_OF = "2026-08";

export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5":            { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5":             { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5":           { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-4-5":         { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-1":           { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "gpt-4o":                    { in: 2.5, out: 10, cacheRead: 1.25 },
  "gpt-4o-mini":               { in: 0.15, out: 0.6, cacheRead: 0.075 },
};

/**
 * Cloud routes prefix ids with a region scope and suffix a version, e.g.
 * "us.anthropic.claude-sonnet-5" or "anthropic.claude-haiku-4-5-20251001-v1:0".
 * Strip those so one table entry covers every deployment of a model.
 * (Regional Bedrock endpoints do cost a little more than global — treat the
 * result as an estimate, and pin exact prices in your profile if it matters.)
 */
export function normalizeModelId(id: string): string {
  let s = id.trim();
  s = s.replace(/^(global|us|eu|apac|au|jp)\./, "");   // region scope
  s = s.replace(/^anthropic\./, "");                    // provider scope
  s = s.replace(/-v\d+:\d+$/, "");                      // bedrock version suffix
  s = s.replace(/@\d{8}$/, "");                         // vertex date suffix
  return s;
}

function cacheFile(): string {
  return path.join(os.homedir(), ".faber", "cache", "prices.json");
}

/**
 * Bumped whenever the cached shape gains a field Faber relies on. A cache
 * written by an older version is discarded rather than trusted: after adding
 * `mode` and `supported_endpoints`, a stale file looked complete but carried
 * neither, so Responses-only models were routed to the wrong endpoint and
 * failed with a 404 that looked like a Faber bug.
 */
export const PRICE_CACHE_VERSION = 2;

interface PriceCache {
  version?: number;
  fetchedAt: number;      // when the prices were last CONFIRMED current
  source: string;
  prices: Record<string, ModelPrice>;
  lastAttempt?: number;   // last attempt, successful or not
  etag?: string;          // for conditional requests
}

/** Wait this long before retrying after a failed refresh. */
export const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;

/** How old the cached prices are, in days. undefined = never fetched. */
export function priceAgeDays(now = Date.now()): number | undefined {
  const c = readPriceCache();
  return c ? (now - c.fetchedAt) / 86_400_000 : undefined;
}

/** Prices this old are worth re-checking before they get baked into history. */
export const STALE_AFTER_DAYS = 14;

export function pricesAreStale(now = Date.now()): boolean {
  const age = priceAgeDays(now);
  return age === undefined || age > STALE_AFTER_DAYS;
}

export function readPriceCache(): PriceCache | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as PriceCache;
    if (!raw.prices || typeof raw.prices !== "object") return undefined;
    if ((raw.version ?? 1) < PRICE_CACHE_VERSION) return undefined;   // stale shape
    return raw;
  } catch {
    return undefined;
  }
}

export function writePriceCache(
  prices: Record<string, ModelPrice>, source: string, etag?: string,
): void {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(f, JSON.stringify(
      { version: PRICE_CACHE_VERSION, fetchedAt: now, lastAttempt: now, source, etag, prices },
      null, 2));
  } catch { /* best effort */ }
}

/** Prices were re-confirmed unchanged (a 304) — still current, nothing to store. */
export function markPricesConfirmed(now = Date.now()): void {
  try {
    const existing = readPriceCache();
    if (!existing) return;
    const f = cacheFile();
    fs.writeFileSync(f, JSON.stringify({ ...existing, fetchedAt: now, lastAttempt: now }, null, 2));
  } catch { /* best effort */ }
}

/**
 * Remember that we tried, even when the fetch failed. Without this an offline
 * machine would retry on every single launch, which is exactly the behaviour
 * a background refresh must not have.
 */
export function markRefreshAttempt(now = Date.now()): void {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const existing = readPriceCache();
    fs.writeFileSync(f, JSON.stringify({
      version: PRICE_CACHE_VERSION,
      fetchedAt: existing?.fetchedAt ?? 0,
      lastAttempt: now,
      source: existing?.source ?? "none",
      etag: existing?.etag,          // must survive, or conditional GET breaks
      prices: existing?.prices ?? {},
    }, null, 2));
  } catch { /* best effort */ }
}

/**
 * Should a background refresh run now?
 *
 * Yes on every launch — a conditional request is ~0 bytes when nothing has
 * changed, so there's no reason to tolerate a stale price window. The only
 * exception is backing off after a FAILED attempt, so an offline machine
 * isn't making a doomed request every time you start.
 */
export function shouldAutoRefresh(now = Date.now()): boolean {
  const c = readPriceCache();
  if (!c) return true;                                   // never fetched
  const failedRecently = c.lastAttempt !== undefined
    && c.lastAttempt > c.fetchedAt                        // attempt newer than success
    && now - c.lastAttempt < RETRY_AFTER_FAILURE_MS;
  return !failedRecently;
}

const DATASET_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** True when this endpoint is OpenRouter, which publishes live prices. */
export function isOpenRouter(baseUrl?: string): boolean {
  return Boolean(baseUrl && /(^|\/\/)([^/]*\.)?openrouter\.ai/.test(baseUrl));
}

/**
 * Live prices straight from OpenRouter. Values are USD per token as strings;
 * we convert to per-Mtok. No API key needed for the catalogue.
 */
export async function fetchOpenRouterPrices(
  url = OPENROUTER_MODELS_URL,
): Promise<Record<string, ModelPrice> | undefined> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = await res.json() as { data?: { id?: string; pricing?: Record<string, string> }[] };
    const out: Record<string, ModelPrice> = {};
    const perM = (s: string | undefined): number | undefined => {
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
    };
    for (const m of body.data ?? []) {
      if (!m.id || !m.pricing) continue;
      const inC = perM(m.pricing["prompt"]), outC = perM(m.pricing["completion"]);
      if (inC === undefined || outC === undefined) continue;
      const price: ModelPrice = { in: inC, out: outC };
      const cr = perM(m.pricing["input_cache_read"]);
      const cw = perM(m.pricing["input_cache_write"]);
      if (cr !== undefined) price.cacheRead = cr;
      if (cw !== undefined) price.cacheWrite = cw;
      out[m.id] = price;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Refresh prices from the community dataset. Explicit and opt-in — never
 * fetched automatically, so Faber makes no network calls you didn't ask for.
 * Returns how many entries were stored, or undefined on failure.
 */
/**
 * Result of a refresh: how many entries were stored, or "unchanged" when the
 * server confirmed our copy is still current (a 304 — 0 bytes on the wire).
 */
export type RefreshResult = number | "unchanged" | undefined;

export async function refreshPrices(
  url = DATASET_URL,
  opts: { baseUrl?: string; force?: boolean } = {},
): Promise<RefreshResult> {
  markRefreshAttempt();   // recorded first, so a crash mid-fetch still backs off
  // If the active endpoint publishes its own prices, that beats any dataset.
  if (isOpenRouter(opts.baseUrl)) {
    const live = await fetchOpenRouterPrices();
    if (live) {
      const merged = { ...(readPriceCache()?.prices ?? {}), ...live };
      writePriceCache(merged, OPENROUTER_MODELS_URL);
      return Object.keys(live).length;
    }
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    // Conditional request: if the price list hasn't changed the server answers
    // 304 with no body, so checking every launch costs ~0 bytes instead of 1.6MB.
    const known = readPriceCache();
    const headers: Record<string, string> = {};
    if (known?.etag && !opts.force) headers["if-none-match"] = known.etag;
    const res = await fetch(url, { signal: ctl.signal, headers });
    clearTimeout(timer);
    if (res.status === 304) { markPricesConfirmed(); return "unchanged"; }
    if (!res.ok) return undefined;
    const etag = res.headers.get("etag") ?? undefined;
    const raw = await res.json() as Record<string, Record<string, unknown>>;
    const out: Record<string, ModelPrice> = {};
    for (const [id, v] of Object.entries(raw)) {
      const inC = v["input_cost_per_token"], outC = v["output_cost_per_token"];
      if (typeof inC !== "number" || typeof outC !== "number") continue;
      // per-token floats round badly at 1e6 (2e-7 -> 0.19999999999999998),
      // and these values get written to a file people read.
      const perM = (n: number): number => Math.round(n * 1e6 * 1e6) / 1e6;
      const price: ModelPrice = { in: perM(inC), out: perM(outC) };
      if (typeof v["mode"] === "string") price.mode = v["mode"];
      const eps = v["supported_endpoints"];
      if (Array.isArray(eps)) price.endpoints = eps.filter((e): e is string => typeof e === "string");
      const cr = v["cache_read_input_token_cost"], cw = v["cache_creation_input_token_cost"];
      if (typeof cr === "number") price.cacheRead = perM(cr);
      if (typeof cw === "number") price.cacheWrite = perM(cw);
      out[id] = price;
    }
    if (!Object.keys(out).length) return undefined;
    writePriceCache(out, url, etag);
    return Object.keys(out).length;
  } catch {
    return undefined;
  }
}

/**
 * Price for a model. Explicit overrides win, then a refreshed dataset (exact
 * id, then normalized), then the built-in table. Undefined means "unknown",
 * which the ledger renders as — rather than guessing.
 */
export function priceFor(
  modelId: string,
  override?: { in?: number; out?: number },
): ModelPrice | undefined {
  if (override?.in && override?.out) return { in: override.in, out: override.out };
  const norm = normalizeModelId(modelId);
  const cached = readPriceCache()?.prices;
  const hit = cached?.[modelId] ?? cached?.[norm] ?? BUILTIN_PRICES[modelId] ?? BUILTIN_PRICES[norm];
  return hit;
}

/** Multipliers used when a model's exact cache prices aren't known. */
export const CACHE_READ_RATIO = 0.1;
export const CACHE_WRITE_RATIO = 1.25;

export function cacheReadPrice(p: ModelPrice): number {
  return p.cacheRead ?? p.in * CACHE_READ_RATIO;
}
export function cacheWritePrice(p: ModelPrice): number {
  return p.cacheWrite ?? p.in * CACHE_WRITE_RATIO;
}
