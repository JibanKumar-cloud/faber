/**
 * Model discovery: ask the provider what this credential can actually use,
 * cache it, and fall back to the built-in list when that isn't possible.
 *
 * Why bother: hardcoded model lists go stale the moment a provider ships
 * something new, and they can't know which models YOUR account is entitled to.
 * A live list is always current and always accurate for the caller.
 *
 * Discovery is strictly a convenience. Every failure path — offline, a key
 * without models:list permission, an endpoint that doesn't implement it —
 * falls back to the static aliases rather than blocking the picker.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelsForRoute, type ModelChoice, type Route } from "./routes.js";

export interface DiscoveredModel { id: string; name?: string; created?: number; }

/**
 * Order the model list the way someone choosing one would want it.
 *
 * On OpenAI the coding-tuned models matter most to a coding agent, so those
 * come first as a group; everything else follows. Within each group, newest
 * first, since a release date is the only ranking the provider actually gives
 * us. Anthropic has no such split, so it's purely newest first.
 */
export function isCodexModel(id: string): boolean {
  return /codex/i.test(id);
}

export function sortModels(models: DiscoveredModel[], wire: "anthropic" | "openai"): DiscoveredModel[] {
  const byDate = (a: DiscoveredModel, b: DiscoveredModel): number => {
    if (a.created && b.created) return b.created - a.created;
    if (a.created) return -1;      // dated entries above undated ones
    if (b.created) return 1;
    return a.id.localeCompare(b.id);
  };
  if (wire !== "openai") return [...models].sort(byDate);
  const codex = models.filter((m) => isCodexModel(m.id)).sort(byDate);
  const rest = models.filter((m) => !isCodexModel(m.id)).sort(byDate);
  return [...codex, ...rest];
}

const TTL_MS = 24 * 60 * 60 * 1000;   // a day: new models are rare, staleness is cheap

function cacheFile(routeId: string): string {
  return path.join(os.homedir(), ".faber", "cache", `models-${routeId}.json`);
}

export function readCache(routeId: string, now = Date.now()): DiscoveredModel[] | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(routeId), "utf8")) as
      { fetchedAt: number; models: DiscoveredModel[] };
    if (!Array.isArray(raw.models) || now - raw.fetchedAt > TTL_MS) return undefined;
    return raw.models;
  } catch {
    return undefined;
  }
}

export function writeCache(routeId: string, models: DiscoveredModel[], now = Date.now()): void {
  try {
    const f = cacheFile(routeId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ fetchedAt: now, models }, null, 2));
  } catch { /* cache is best-effort */ }
}

export function clearCache(routeId: string): void {
  try { fs.unlinkSync(cacheFile(routeId)); } catch { /* already gone */ }
}

/**
 * Can this model actually run an agent loop?
 *
 * Provider catalogues list everything the key can call: embeddings, speech,
 * transcription, moderation, image generation. None of them accept a chat
 * request, so offering them as a choice is offering a guaranteed failure.
 * Excluding by capability keyword is deliberately conservative — anything
 * unrecognised is kept, since a new chat model must never be filtered out.
 */
const NOT_CHAT = /(^|[-_/])(embedding|embed|tts|whisper|moderation|dall-e|dalle|image|audio|transcribe|realtime|speech|rerank|search-preview|codex-mini-latest)([-_/]|$)/i;

/** Retired completion-only families that predate the chat API. */
const LEGACY = /^(davinci|babbage|curie|ada|text-davinci|code-davinci)/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id) && !LEGACY.test(id);
}

export interface PickerEntry {
  value: string;      // what gets passed to resolveModel()
  label: string;      // left column
  blurb: string;      // right column
  live: boolean;      // discovered vs built-in
}

/**
 * Build the /model menu: built-in aliases first (stable names people type),
 * then anything discovered that an alias doesn't already cover.
 * Provider lists arrive newest-first, and that order is preserved.
 */
export function buildPicker(
  route: Route,
  discovered: DiscoveredModel[],
  currentId: string,
): PickerEntry[] {
  const aliases: ModelChoice[] = modelsForRoute(route);
  const entries: PickerEntry[] = aliases.map((a) => ({
    value: a.alias,
    label: a.alias,
    blurb: a.blurb,
    live: false,
  }));
  const covered = new Set(aliases.map((a) => a.id));
  for (const m of sortModels(discovered, route.wire)) {
    if (covered.has(m.id)) continue;
    if (!isChatModel(m.id)) continue;   // embeddings, speech, moderation…
    entries.push({ value: m.id, label: m.id, blurb: m.name ?? "", live: true });
  }
  // if the model in use is neither an alias nor discovered, keep it visible
  if (!entries.some((e) => e.value === currentId) && !covered.has(currentId)) {
    entries.push({ value: currentId, label: currentId, blurb: "current", live: false });
  }
  return entries;
}
