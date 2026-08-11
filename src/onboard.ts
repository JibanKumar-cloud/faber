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
  looksLikeKey, deleteCredential,
} from "./credentials.js";

/** First run = no settings file yet. */
/** Where a credential comes from, so setup can point people at the right page. */
const KEY_SOURCE: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  BEDROCK_API_KEY: "the AWS console (Bedrock → API keys)",
  AZURE_OPENAI_API_KEY: "the Azure portal (your OpenAI resource → Keys and Endpoint)",
  AZURE_FOUNDRY_API_KEY: "the Azure portal (your Foundry resource → Keys and Endpoint)",
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
  // Not merely "is it set": an interrupted prompt used to store control
  // characters, which are non-empty and so passed every naive check.
  // eslint-disable-next-line no-control-regex
  if (!cfg.model || !cfg.model.trim() || /[\x00-\x1f]/.test(cfg.model)) {
    return { complete: false, missing: "no model chosen", fix: "/model" };
  }
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

/**
 * Read a plain answer, treating an interrupt as cancellation.
 *
 * A raw readline prompt collects Ctrl-C as the character \x03 rather than
 * aborting, so pressing it during the region or model question stored control
 * characters as the answer — and since they aren't empty, every completeness
 * check passed and the profile was saved as valid.
 */
async function askText(
  rl: readline.Interface, prompt: string,
): Promise<string | undefined> {
  let raw: string;
  try { raw = await rl.question(prompt); } catch { return undefined; }

  // Ctrl-C is the only thing that means "stop". Everything else that isn't
  // printable is terminal noise: a paste arrives wrapped in bracketed-paste
  // markers, so rejecting all control characters made pasting an answer
  // abort setup — which is exactly what someone does with a resource name.
  // eslint-disable-next-line no-control-regex
  if (/[\x03\x04]/.test(raw)) return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.trim();
}

/** Exposed for tests: paste handling here decides whether setup can finish. */
export const __askTextForTest = askText;

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
    // Running setup again usually means something needs changing — often the
    // key itself, because it expired or was wrong. Silently reusing the saved
    // one makes that impossible, so offer the same choice as for an
    // environment key.
    console.log();
    console.log(`${route.keyEnv} is already saved on this computer (${maskCredential(found.value)}).`);
    const choice = await select(rl, "Use it?", [
      `Keep using it                    ${pc.dim("no change")}`,
      `Replace it                       ${pc.dim("paste a new key")}`,
      `Remove it                        ${pc.dim("delete the saved key and stop")}`,
    ]);
    if (choice === 1) {
      const key = await readKey(rl, route.keyEnv, `  ${route.keyEnv} (hidden): `);
      if (key) {
        saveCredential(route.keyEnv, key);
        console.log(pc.dim(`  replaced (${maskCredential(key)})`));
      } else {
        console.log(pc.dim("  nothing entered — keeping the saved key"));
      }
    } else if (choice === 2) {
      deleteCredential(route.keyEnv);
      console.log(pc.dim(`  removed. Run faber again to set one up.`));
      return { switchedTo: "quit" };
    }
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
    // Two ways in, and which one you pick can matter for billing: an IAM role
    // charges through the account that owns it, a Bedrock API key can belong
    // to a different arrangement entirely. So ask rather than assume, even
    // when one option is obvious from the environment.
    const { discoverAwsCredentials } = await import("./sigv4.js");
    const aws = await discoverAwsCredentials();
    console.log();
    const how = await select(rl, "How should Faber authenticate with AWS?", [
      `AWS credentials (IAM role)       ${pc.dim(aws ? `found: ${aws.source}` : "none found here")}`,
      `Bedrock API key                  ${pc.dim("billed through that key instead")}`,
    ]);

    if (how === 0) {
      if (!aws) {
        // Nothing to sign with, so setup did not succeed and saves nothing.
        console.log(pc.yellow("  No AWS credentials on this machine."));
        console.log(pc.dim("  Run where an IAM role is available (SageMaker, EC2, ECS), or `aws configure`."));
        return { switchedTo: "quit" };
      }
      console.log(pc.dim(`  Signing automatically with your AWS role. No key needed.`));
      delete profile.apiKeyEnv;   // this route authenticates by signing
      return {};
    }

    console.log();
    console.log("Faber needs a Bedrock API key.");
    const where = KEY_SOURCE[route.keyEnv];
    if (where) console.log(pc.dim(`  Get one at ${where}`));
    const key = await readKey(rl, route.keyEnv, `  ${route.keyEnv} (hidden): `);
    if (!key) {
      console.log(pc.yellow("  No key entered — setup not completed, nothing saved."));
      return { switchedTo: "quit" };
    }
    saveCredential(route.keyEnv, key);
    profile.apiKeyEnv = route.keyEnv;
    profile.preferStoredKey = true;   // an explicit choice beats a role
    console.log(pc.dim(`  saved (${maskCredential(key)}) — kept on this computer only`));
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

/** Does the provider accept this credential? Never blocks on being offline. */
async function verifyCredential(
  route: Route, profile: Profile,
): Promise<"ok" | "rejected" | "unreachable"> {
  if (!route.keyEnv) return "ok";
  try {
    const { LLMClient } = await import("./llm.js");
    const { resolveCredential } = await import("./credentials.js");
    const key = resolveCredential(route.keyEnv);
    const baseUrl = profile.baseUrl ?? baseUrlFor(route, profile.region);
    if (!key || !baseUrl) return "unreachable";
    process.stdout.write(pc.dim("  checking your key… "));
    const llm = new LLMClient({
      provider: route.wire, baseUrl, apiKey: key, model: "x", route: route.id,
    } as unknown as import("./config.js").Config);
    const verdict = await llm.verifyKey();
    process.stdout.write("\r\x1b[2K");
    return verdict;
  } catch {
    process.stdout.write("\r\x1b[2K");
    return "unreachable";
  }
}

/** Ask the provider which models this key can use. Empty on any failure. */
async function discoverModels(
  route: Route, profile: Profile,
): Promise<{ id: string; name?: string }[]> {
  try {
    const { LLMClient } = await import("./llm.js");
    const { resolveCredential } = await import("./credentials.js");
    const key = route.keyEnv ? resolveCredential(route.keyEnv) : undefined;
    const baseUrl = profile.baseUrl ?? baseUrlFor(route, profile.region);
    if (!baseUrl) return [];
    process.stdout.write(pc.dim("  checking which models your key can use… "));
    const llm = new LLMClient({
      provider: route.wire, baseUrl, apiKey: key, model: "x", route: route.id,
    } as unknown as import("./config.js").Config);
    const models = await llm.listModels();
    process.stdout.write("\r\x1b[2K");
    return models;
  } catch {
    process.stdout.write("\r\x1b[2K");
    return [];
  }
}

async function finish(
  rl: readline.Interface,
  route: Route,
  base: Partial<Profile>,
): Promise<OnboardResult> {
  const profile: Profile = { ...base, route: route.id };
  const activeRoute = route;

  if (route.keyEnv) {
    profile.apiKeyEnv = route.keyEnv;
    const outcome = await ensureCredential(rl, activeRoute, profile);
    if (outcome.switchedTo === "quit") {
      // Nothing is written: an incomplete profile would make the next run
      // look configured when it isn't.
      return { profile, route: activeRoute, aborted: true };
    }
  }

  if (route.id === "foundry") {
    // Same question as Azure OpenAI: the resource name is what people know.
    const res = await askText(rl, "Azure resource name (from your endpoint URL): ");
    if (res === undefined) return { profile, route: activeRoute, aborted: true };
    if (res) {
      profile.baseUrl = /^https?:\/\//.test(res)
        ? res.replace(/\/+$/, "")
        : `https://${res}.services.ai.azure.com/anthropic`;
    }
  } else if (route.id === "azure-openai") {
    // Ask for the resource name rather than a URL: it's the part people know
    // from the portal, and the rest of the endpoint is fixed.
    const res = await askText(rl, "Azure resource name (from your endpoint URL): ");
    if (res === undefined) return { profile, route: activeRoute, aborted: true };
    if (res) {
      profile.baseUrl = /^https?:\/\//.test(res)
        ? res.replace(/\/+$/, "")
        : `https://${res}.openai.azure.com/openai`;
    }
  } else if (route.needsBaseUrl) {
    const ans = await askText(rl, "Base URL of the OpenAI-compatible endpoint: ");
    if (ans === undefined) return { profile, route: activeRoute, aborted: true };
    if (ans) profile.baseUrl = ans;
  }
  if (route.needsRegion) {
    // Only ask when the environment hasn't already answered.
    const { discoverAwsRegion } = await import("./sigv4.js");
    const found = discoverAwsRegion();
    if (found) {
      profile.region = found.region;
      console.log(pc.dim(`  Region ${found.region} (from ${found.source}) · /route to change`));
    } else {
      const ans = await askText(rl, `AWS region [${DEFAULT_REGION}]: `);
      if (ans === undefined) return { profile, route: activeRoute, aborted: true };
      profile.region = ans || DEFAULT_REGION;
    }
  }

  // Model choice, with real ids and real prices.
  //
  // Aliases like "gpt" or "sonnet" hide what you're actually paying for, and
  // the difference is not small: gpt-4o costs about 17x gpt-4o-mini. Since the
  // credential is saved by now, ask the provider what this key can really use
  // and show each model's rate, so nothing about the bill is implicit.
  const { refreshPrices, priceFor, readPriceCache } = await import("./pricing.js");
  if (!readPriceCache()) process.stdout.write(pc.dim("  fetching prices… "));
  await refreshPrices(undefined, { baseUrl: profile.baseUrl ?? activeRoute.baseUrl });
  process.stdout.write("\r\x1b[2K");

  // Verify the credential before going further. A rejected key means setup
  // did not succeed, so nothing is saved and the next run starts over — the
  // same rule as skipping the key entirely.
  const verdict = await verifyCredential(activeRoute, profile);
  if (verdict === "rejected") {
    if (activeRoute.keyEnv) deleteCredential(activeRoute.keyEnv);
    console.log();
    console.log(pc.yellow(`${activeRoute.label} rejected that key.`));
    console.log(pc.dim("  Nothing was saved. Run faber again with a working key."));
    return { profile, route: activeRoute, aborted: true };
  }

  const { isChatModel, sortModels, requiresUnsupportedApi } = await import("./models.js");
  const discovered = sortModels(
    (await discoverModels(activeRoute, profile))
      .filter((m) => isChatModel(m.id) && !requiresUnsupportedApi(m.id)),
    activeRoute.wire,
  );
  const fallback = modelsForRoute(activeRoute).map((m) => ({ id: m.id, name: m.blurb }));
  const options = discovered.length ? discovered : fallback;

  if (options.length) {
    // Say which list this is. A built-in fallback and a live list look
    // identical otherwise, and the user can't tell whether the models shown
    // are the ones their key can actually reach.
    console.log();
    if (discovered.length) {
      console.log(pc.dim(`  ${discovered.length} models available to this key`));
    } else {
      const { lastModelListError } = await import("./llm.js");
      const why = lastModelListError();
      console.log(pc.yellow("  Couldn't list models — showing built-in defaults."));
      console.log(pc.dim(why ? `  ${why}` : "  No response from the provider."));
      console.log(pc.dim("  /model re-checks later."));
    }
    const width = Math.min(34, Math.max(...options.map((m) => m.id.length)) + 2);
    const labels = options.map((m) => {
      const p = priceFor(m.id);
      const cost = p ? `$${p.in}/$${p.out} per Mtok` : "price unknown";
      return `${m.id.padEnd(width)}${pc.dim(cost)}${m.name ? pc.dim("  " + m.name) : ""}`;
    });
    console.log();
    const mi = await select(rl, "Which model? (input/output cost per million tokens)", labels);
    profile.model = options[mi]!.id;      // a concrete id, never an alias
  } else {
    const hint = activeRoute.id === "ollama" ? "qwen2.5-coder" : "";
    const ans = await askText(rl, `Model id${hint ? ` [${hint}]` : ""}: `);
    if (ans === undefined) return { profile, route: activeRoute, aborted: true };
    profile.model = ans || hint || undefined;
  }

  // Nothing is written unless the result is genuinely usable. Every earlier
  // exit already returns aborted, but this is the single place that decides,
  // so a future step can't accidentally save a half-finished profile.
  const check = await setupComplete({
    route: profile.route,
    model: profile.model,
    baseUrl: profile.baseUrl ?? baseUrlFor(activeRoute, profile.region),
    apiKey: activeRoute.keyEnv ? credentialSource(activeRoute.keyEnv)?.value : undefined,
  });
  if (!check.complete) {
    console.log();
    console.log(pc.yellow(`Setup not completed — ${check.missing}.`));
    console.log(pc.dim("  Nothing was saved. Run faber again to start over."));
    return { profile, route: activeRoute, aborted: true };
  }

  const settings = loadSettings();
  settings.profiles[settings.activeProfile] = profile;
  saveSettings(settings);

  // Bedrock signs with an IAM role when one is available, so a missing key is
  // not "one thing left" — saying so contradicts the line printed moments ago.
  let missingKeyEnv = activeRoute.keyEnv && !credentialSource(activeRoute.keyEnv)
    ? activeRoute.keyEnv : undefined;
  if (missingKeyEnv && activeRoute.id === "bedrock") {
    const { discoverAwsCredentials } = await import("./sigv4.js");
    if (await discoverAwsCredentials()) missingKeyEnv = undefined;
  }
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
