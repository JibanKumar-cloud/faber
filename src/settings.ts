/**
 * Global settings: ~/.faber/settings.json
 *
 * Holds named profiles — a route, a model, and any endpoint or credential
 * REFERENCE that route needs. Credentials themselves are never stored here:
 * a profile names the environment variable to read (`apiKeyEnv`), so this file
 * stays safe to sync between machines or check into a dotfiles repo.
 *
 * Resolution order, highest first:
 *   env vars  >  <project>/.faber/config.json  >  active profile  >  defaults
 * Project settings beat the global profile so a repo can pin its own model,
 * and env vars beat everything so CI and one-off overrides always work.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Profile {
  route: string;                       // id from ROUTES
  model?: string;                      // alias or raw id
  baseUrl?: string;                    // for custom/local routes
  region?: string;                     // for region-scoped routes (Bedrock)
  apiKeyEnv?: string;                  // NAME of the env var, not the value
  /**
   * Prefer the key saved in Faber's store over the environment variable.
   * Set when the user explicitly chose a different key during setup — an
   * explicit choice should beat the generic "environment wins" rule.
   */
  preferStoredKey?: boolean;
  weakModel?: string;
  modelPins?: Record<string, string>;  // alias -> real id, for cloud routes
  priceIn?: number;                    // $/Mtok, for the usage ledger
  priceOut?: number;
  /** Re-fetch stale prices in the background. Default ON; set false to disable. */
  autoRefreshPrices?: boolean;
}

export interface Settings {
  activeProfile: string;
  profiles: Record<string, Profile>;
}

export const DEFAULT_SETTINGS: Settings = {
  activeProfile: "default",
  profiles: {
    default: { route: "anthropic-api", model: "sonnet", apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
};

export function settingsPath(): string {
  return path.join(os.homedir(), ".faber", "settings.json");
}

export function loadSettings(file = settingsPath()): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Settings>;
    const profiles = raw.profiles && typeof raw.profiles === "object"
      ? raw.profiles as Record<string, Profile>
      : DEFAULT_SETTINGS.profiles;
    const active = typeof raw.activeProfile === "string" && profiles[raw.activeProfile]
      ? raw.activeProfile
      : Object.keys(profiles)[0] ?? "default";
    return { activeProfile: active, profiles };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);   // absent or malformed -> defaults
  }
}

export function saveSettings(s: Settings, file = settingsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
}

export function activeProfile(s: Settings): Profile {
  return s.profiles[s.activeProfile] ?? DEFAULT_SETTINGS.profiles.default!;
}

/** Update the active profile in place and persist. */
export function updateActive(patch: Partial<Profile>, file = settingsPath()): Settings {
  const s = loadSettings(file);
  const name = s.activeProfile;
  s.profiles[name] = { ...activeProfile(s), ...patch };
  saveSettings(s, file);
  return s;
}
