/**
 * First-run onboarding.
 *
 * Runs when no ~/.faber/settings.json exists, and on demand via /setup.
 * Deliberately NOT a postinstall script: npm disables install scripts by
 * default, they have no TTY to prompt from, and an interactive installer is a
 * supply-chain smell. `npm install` stays silent; the first `faber` sets up.
 *
 * Non-interactive shells (CI, pipes) skip the wizard entirely and fall back to
 * environment variables, so scripted use never blocks on a prompt.
 */
import type * as readline from "node:readline/promises";
import pc from "picocolors";
import { select, readSecret } from "./prompt.js";
import {
  vendors, modelsForRoute, baseUrlFor, getRoute, DEFAULT_REGION, type Route,
} from "./routes.js";
import * as fs from "node:fs";
import { loadSettings, saveSettings, settingsPath, type Profile } from "./settings.js";
import {
  credentialSource, saveCredential, maskCredential, credentialsPath, getCredential,
  looksLikeKey,
} from "./credentials.js";

/** First run = no settings file yet. */
/** Where a credential comes from, so setup can point people at the right page. */
const KEY_SOURCE: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  BEDROCK_API_KEY: "the AWS console (Bedrock → API keys)",
};

export function needsOnboarding(): boolean {
  return !hasAnySettingsFile();
}

export interface Completeness {
  complete: boolean;
  missing?: string;   // what's absent, in words
  fix?: string;       // the shortest way to fix it
}

/**
 * Is this project actually ready to run?
 *
 * "A settings file exists" is the wrong question — a profile can name a route
 * whose credential was never supplied, which then fails as a 401 on the first
 * task instead of at launch. What counts as complete depends on the route:
 *
 *   Anthropic / OpenAI  a key, from the environment or Faber's store
 *   Bedrock             a key OR AWS credentials it can sign with
 *   Ollama / local      nothing — but a model id, since there are no defaults
 *   custom endpoint     a base URL, and a key unless it's localhost
 */
export async function setupComplete(cfg: {
  route: string; model?: string; baseUrl?: string; apiKey?: string;
}): Promise<Completeness> {
  const route = getRoute(cfg.route);
  if (!route) return { complete: false, missing: `unknown route "${cfg.route}"`, fix: "/setup" };
  if (!route.implemented) {
    return { complete: false, missing: `${route.label} isn't wired up yet`, fix: "/route" };
  }
  if (!cfg.model) return { complete: false, missing: "no model chosen", fix: "/model" };
  if (route.needsBaseUrl && !cfg.baseUrl) {
    return { complete: false, missing: "no endpoint URL for this route", fix: "/route" };
  }
  if (cfg.apiKey) return { complete: true };

  if (route.id === "bedrock") {
    const { discoverAwsCredentials } = await import("./sigv4.js");
    if (await discoverAwsCredentials()) return { complete: true };   // IAM role signs
    return {
      complete: false,
      missing: "no AWS credentials and no BEDROCK_API_KEY",
      fix: "/key set BEDROCK_API_KEY",
    };
  }
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(cfg.baseUrl ?? "");
  if (isLocal) return { complete: true };            // local models need no key
  if (!route.keyEnv) return { complete: true };
  return { complete: false, missing: `${route.keyEnv} is not set`, fix: `/key set ${route.keyEnv}` };
}

function hasAnySettingsFile(): boolean {
  try { return fs.existsSync(settingsPath()); } catch { return false; }
}

/** True when we can prompt at all. */
export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Read a key and refuse to silently store something that isn't one. A typo
 * saved here becomes the preferred credential and breaks every later run,
 * which is a much worse outcome than one extra confirmation.
 */
async function readKey(
  rl: readline.Interface, envName: string, promptText: string,
): Promise<string | undefined> {
  const key = await readSecret(rl, promptText);
  if (!key) return undefined;
  const problem = looksLikeKey(envName, key);
  if (problem) {
    console.log(pc.yellow(`  ${problem}.`));
    const ok = await select(rl, "Save it anyway?", ["No, discard it", "Yes, save it"]);
    if (ok === 0) return undefined;
  }
  return key;
}

export interface OnboardResult {
  profile: Profile;
  route: Route;
  missingKeyEnv?: string;
  /** User chose to stop rather than finish — nothing usable was configured. */
  aborted?: boolean;
}

/**
 * Walk vendor -> route -> region/endpoint -> model. Returns the profile it
 * saved so the caller can report what still needs doing (e.g. an unset key).
 */
export async function runOnboarding(
  rl: readline.Interface,
  opts: { first?: boolean } = {},
): Promise<OnboardResult> {
  if (opts.first) {
    console.log();
    console.log(pc.cyan("Welcome to Faber."));
    console.log(pc.dim("Let's pick where your model comes from. You can change this any time with /route or /model."));
    console.log();
  }

  const groups = vendors();
  const vi = await select(rl, "Who provides the model?", groups.map((g) => g.vendor));
  const routes = groups[vi]!.routes;

  const ri = await select(
    rl,
    "How should Faber reach it?",
    routes.map((r) =>
      `${r.label.padEnd(30)} ${pc.dim(r.hint)}${r.implemented ? "" : pc.yellow("  (not yet wired)")}`),
  );
  const route = routes[ri]!;

  if (!route.implemented) {
    console.log(pc.yellow(`${route.label} isn't wired up yet — falling back to the Anthropic API.`));
    const fallback = groups[0]!.routes[0]!;
    return finish(rl, fallback, {});
  }
  return finish(rl, route, {});
}

/**
 * Make sure the route has a usable credential, prompting if not.
 * Exported so startup can run just this step: a configured profile with a
 * missing key should ask at launch, not fail with a 401 on the first task.
 *
 * Returns what the user chose to do when they have no key — the ways forward
 * are offered as choices, because the REPL that prose would point them at
 * never opens when setup is incomplete.
 */
export async function ensureCredential(
  rl: readline.Interface, route: Route, profile: Profile,
): Promise<{ switchedTo?: "quit" }> {
  if (!route.keyEnv) return {};

  const found = credentialSource(route.keyEnv);

  if (found?.from === "store") {
    console.log(pc.dim(`  Using ${route.keyEnv} saved on this computer (${maskCredential(found.value)})`));
    return {};
  }

  if (found?.from === "environment") {
    console.log();
    console.log(`Found ${route.keyEnv} in your environment (${maskCredential(found.value)}).`);
    const choice = await select(rl, "Use it?", [
      `Yes, and remember it here        ${pc.dim("works in any shell, even without the env var")}`,
      `Yes, but don't save it           ${pc.dim("keep reading it from the environment")}`,
      `No, use a different key          ${pc.dim("paste another one")}`,
    ]);
    if (choice === 0) {
      saveCredential(route.keyEnv, found.value);
      console.log(pc.dim(`  kept on this computer only, at ${credentialsPath()}`));
    } else if (choice === 1) {
      console.log(pc.dim("  not saved — Faber will read it from the environment each run"));
    } else {
      const key = await readKey(rl, route.keyEnv, `  ${route.keyEnv} (hidden): `);
      if (key) {
        saveCredential(route.keyEnv, key);
        profile.preferStoredKey = true;   // an explicit choice beats the env var
        console.log(pc.dim(`  saved (${maskCredential(key)}) — Faber will use this one, not the environment`));
      } else {
        console.log(pc.dim("  not saved — keeping the key from your environment"));
      }
    }
    return {};
  }

  if (route.id === "bedrock") {
    // Bedrock can sign with an IAM role, so a key may not be needed at all.
    const { discoverAwsCredentials } = await import("./sigv4.js");
    const aws = await discoverAwsCredentials();
    console.log();
    console.log(aws
      ? pc.dim(`  No key needed — signing with AWS credentials from ${aws.source}.`)
      : pc.yellow(`  No AWS credentials found. Set ${route.keyEnv}, or run where an IAM role is available.`));
    return {};
  }

  // No key anywhere: say where to get one, read it hidden, and if they don't
  // have one, offer real alternatives rather than a dead end.
  console.log();
  console.log(`Faber needs an API key for ${route.label}.`);
  const where = KEY_SOURCE[route.keyEnv];
  if (where) console.log(pc.dim(`  Get one at ${where}`));
  const key = await readKey(rl, route.keyEnv, `  ${route.keyEnv} (hidden): `);
  if (key) {
    saveCredential(route.keyEnv, key);
    console.log(pc.dim(`  saved (${maskCredential(key)}) — kept on this computer only, at ${credentialsPath()}`));
    return {};
  }

  // No key means setup didn't complete. Nothing is written, so the next run
  // starts over from the beginning rather than resuming into a broken state.
  return { switchedTo: "quit" };
}

async function finish(
  rl: readline.Interface,
  route: Route,
  base: Partial<Profile>,
): Promise<OnboardResult> {
  const profile: Profile = { ...base, route: route.id };
  const activeRoute = route;

  if (route.needsRegion) {
    const ans = (await rl.question(`AWS region [${DEFAULT_REGION}]: `)).trim();
    profile.region = ans || DEFAULT_REGION;
  }
  if (route.needsBaseUrl) {
    const ans = (await rl.question("Base URL of the OpenAI-compatible endpoint: ")).trim();
    if (ans) profile.baseUrl = ans;
  }
  if (route.keyEnv) {
    profile.apiKeyEnv = route.keyEnv;
    const outcome = await ensureCredential(rl, activeRoute, profile);
    if (outcome.switchedTo === "quit") {
      // Nothing is written: an incomplete profile would make the next run
      // look configured when it isn't.
      return { profile, route: activeRoute, aborted: true };
    }
  }

  // model: pick from aliases, or ask for an id on routes where ids vary
  const choices = modelsForRoute(activeRoute);
  if (choices.length) {
    const mi = await select(
      rl,
      "Default model",
      choices.map((m) => `${m.alias.padEnd(8)} ${pc.dim(m.blurb)}`),
    );
    profile.model = choices[mi]!.alias;
  } else {
    const hint = activeRoute.id === "ollama" ? "qwen2.5-coder" : "";
    const ans = (await rl.question(
      `Model id${hint ? ` [${hint}]` : ""} ${pc.dim("(ids differ on this route)")}: `,
    )).trim();
    profile.model = ans || hint || undefined;
  }

  // Fetch prices once during setup: costs are frozen per task, so starting
  // with current rates keeps day-one history accurate.
  const { refreshPrices } = await import("./pricing.js");
  process.stdout.write(pc.dim("  fetching current prices… "));
  const n = await refreshPrices(undefined, { baseUrl: profile.baseUrl ?? activeRoute.baseUrl });
  process.stdout.write("\r\x1b[2K");
  if (!n) console.log(pc.dim("  (couldn't fetch prices — using built-in rates)"));

  const settings = loadSettings();
  settings.profiles[settings.activeProfile] = profile;
  saveSettings(settings);

  const missingKeyEnv = activeRoute.keyEnv && !credentialSource(activeRoute.keyEnv)
    ? activeRoute.keyEnv : undefined;
  return { profile, route: activeRoute, missingKeyEnv };
}

/** Summary printed after onboarding, including anything still to be done. */
export function reportSetup(r: OnboardResult): void {
  if (r.aborted) {
    console.log();
    console.log(pc.yellow("Setup not completed — nothing was saved."));
    console.log(pc.dim("  Run faber again when you have a key, or choose a local model."));
    console.log();
    return;
  }
  const url = r.profile.baseUrl ?? baseUrlFor(r.route, r.profile.region);
  console.log();
  console.log(`Route:    ${r.route.label}`);
  if (url) console.log(pc.dim(`Endpoint: ${url}`));
  if (r.profile.model) console.log(pc.dim(`Model:    ${r.profile.model}`));
  if (r.missingKeyEnv) {
    console.log();
    console.log(pc.yellow(`One thing left — ${r.missingKeyEnv} isn't set:`));
    console.log(pc.dim(`  /key set ${r.missingKeyEnv}`));
  }
  console.log();
}
