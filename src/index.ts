#!/usr/bin/env node
/**
 * Faber CLI.
 *
 *   faber                    interactive REPL (current directory)
 *   faber "fix the bug"      one-shot task
 *   faber --resume           continue the latest session
 *   faber --ask              approval mode: preview every diff before applying
 *   faber -w /path/to/repo   choose workspace
 *
 * REPL commands:
 *   /index /memory [archived] /forget <id> /archive <id> /unarchive <id>
 *   /prune <days> /compact /undo /sessions /resume /clear /ask /auto /help /exit
 *
 * During a task: press Esc or Ctrl-C once to cancel cleanly (checkpoints kept).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import pc from "picocolors";

// Suppress ONLY the node:sqlite ExperimentalWarning (stable in newer Node);
// every other warning still surfaces. Remove when engines bumps to >=23.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning" || !String(w.message).includes("SQLite")) {
    console.warn(`${w.name}: ${w.message}`);
  }
});

import { loadConfig, type Config } from "./config.js";
import { Agent } from "./agent.js";
import { FatalError, CancelledError } from "./errors.js";
import { SessionStore } from "./memory/sessions.js";
import { isRepo, isDirty, ensureStateIgnored } from "./git.js";
import { select, setSelectGuard, readSecret } from "./prompt.js";
import { createComposedInput, restore, describeComposed } from "./input.js";
import { Composer } from "./editor.js";
import { StatusLine } from "./status.js";
import { renderMarkdown, StreamRenderer } from "./markdown.js";
import { renderUsagePanel, UsageLedger } from "./usage.js";
import { ROUTES, getRoute, modelsForRoute, describeModel, resolveModel, vendors, baseUrlFor, DEFAULT_REGION } from "./routes.js";
import { loadSettings, saveSettings, updateActive, activeProfile, settingsPath } from "./settings.js";
import { needsOnboarding, interactive, runOnboarding, reportSetup, setupComplete, ensureCredential } from "./onboard.js";
import {
  saveCredential, deleteCredential, listCredentialNames, getCredential,
  maskCredential, credentialsPath, permissionsAreLoose, resolveCredential, looksLikeKey,
} from "./credentials.js";
import { readCache, writeCache, clearCache, buildPicker } from "./models.js";
import { refreshPrices, priceFor, pricesAreStale, shouldAutoRefresh, priceAgeDays, readPriceCache, STALE_AFTER_DAYS } from "./pricing.js";
import type { PendingWrite } from "./tools/fs.js";

/** Version comes from package.json — one source of truth for banner and --version. */
const VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version as string;
  } catch { return "0.0.0"; }
})();

function renderDiff(diff: string): string {
  return diff.split("\n").map((l) =>
    l.startsWith("+") && !l.startsWith("+++") ? pc.green(l)
    : l.startsWith("-") && !l.startsWith("---") ? pc.red(l)
    : l.startsWith("@@") ? pc.cyan(l)
    : pc.dim(l),
  ).join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  if (flags.has("--help") || flags.has("-h")) {
    console.log("faber [task] [--workspace|-w <dir>] [--resume] [--ask|--auto] [--version]\n" + HELP);
    return;
  }
  if (flags.has("--version") || flags.has("-v")) { console.log(`faber ${VERSION}`); return; }
  const wsIdx = argv.findIndex((a) => a === "--workspace" || a === "-w");
  const workspace = wsIdx >= 0 ? argv[wsIdx + 1] : undefined;
  const task = argv.filter((a, i) => !a.startsWith("-") && (wsIdx === -1 || i !== wsIdx + 1)).join(" ");

  let config: Config;
  try { config = loadConfig(workspace); }
  catch (e) { console.error(pc.red(`Error: ${e instanceof Error ? e.message : e}`)); process.exit(1); }
  if (flags.has("--ask")) config.approvalMode = "ask";
  if (flags.has("--auto")) config.approvalMode = "auto";

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  const composer = isTTY ? new Composer(process.stdin, process.stdout) : null;
  const composed = isTTY ? null : createComposedInput(process.stdin);
  setSelectGuard(composer
    ? (on) => (on ? composer.pause() : composer.resume())
    : composed!.setGuard);
  const rl = readline.createInterface({
    input: composed ? composed.stream : process.stdin,
    output: process.stdout,
    terminal: false,
  });
  if (composer) { composer.start(); process.on("exit", () => composer.stop()); }
  let approvalMode = config.approvalMode;

  const approve = async (pending: PendingWrite): Promise<boolean> => {
    if (approvalMode === "auto") return true;
    if (pending.kind === "shell") {
      console.log(pc.bold(`\nAgent wants to run:`) + ` ${pc.yellow(pending.path)}`);
    } else {
      console.log(pc.bold(`\nProposed change to ${pending.path}:`));
      console.log(renderDiff(pending.diff));
    }
    const choice = await select(rl, "Apply?", ["Yes", "No", "Always this session"], 0);
    if (choice === 2) { approvalMode = "auto"; return true; }
    return choice === 0;
  };

  const askUser = async (question: string, options: string[]): Promise<number> => {
    console.log("");
    return select(rl, question, options, 0);
  };

  let streaming = false;
  let status: StatusLine | null = null;
  let streamR: StreamRenderer | null = null;
  const events = {
    onTextDelta: (d: string) => {
      if (!streaming) { status?.suspend(); streamR = new StreamRenderer(); }
      streaming = true;
      const rendered = streamR!.feed(d);
      if (rendered) process.stdout.write(pc.dim(rendered));
    },
    onTextDone: () => {
      if (streaming) {
        const tail = streamR?.flush();
        if (tail) process.stdout.write(pc.dim(tail));
        streaming = false;
        status?.resume();
      }
    },
    onTool: (name: string, brief: string) => { status?.clear(); console.log(pc.cyan(`  ⚙ ${name} ${brief}`)); },
    onToolResult: (summary: string) => { status?.clear(); console.log(pc.dim(`  ⎿ ${summary}`)); },
    onToolError: (msg: string) => { status?.clear(); console.log(pc.red(`  ✗ ${msg.split("\n")[0]?.slice(0, 160)}`)); },
    onInfo: (msg: string) => { status?.clear(); console.log(pc.yellow(`  ℹ ${msg}`)); },
    onUsage: (u: { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number }) => {
      status?.clear();
      const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
      const totalIn = u.input + u.cacheRead + u.cacheWrite;
      const cachePct = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;
      let line = `tokens: ${k(totalIn)} in (${cachePct}% cached) / ${k(u.output)} out · ${u.calls} call${u.calls === 1 ? "" : "s"}`;
      const usd = UsageLedger.cost(u, priceFor(agent.model, { in: config.priceIn, out: config.priceOut }));
      if (usd !== undefined) line += ` · ~$${usd.toFixed(3)}`;
      console.log(pc.dim(line));
    },
  };

  // Setup must be verified BEFORE the agent is built: the LLM client throws
  // on a missing key, which would pre-empt the guided fix with a raw error.
  // Every launch checks that setup is COMPLETE, not merely that a settings
  // file exists. What counts depends on the route, so a Bedrock profile with
  // an IAM role passes while an Anthropic profile with no key does not —
  // and the gap is fixed here rather than surfacing as a 401 mid-task.
  if (needsOnboarding() && interactive()) {
    console.log(pc.cyan(`Faber v${VERSION}`));
    const setup = await runOnboarding(rl, { first: true });
    reportSetup(setup);
    // Aborted setup saved nothing, so there is no model to reach — exit here
    // rather than letting the LLM client throw a less useful error.
    if (setup.aborted) { rl.close(); process.exitCode = 1; return; }
    config = loadConfig(config.workspace);
  } else {
    const state = await setupComplete(config);
    if (!state.complete) {
      if (!interactive()) {
        console.error(pc.red(`Setup isn't finished — ${state.missing}.`));
        console.error(pc.dim(`  Run faber interactively to complete setup, or: ${state.fix}`));
        rl.close(); process.exitCode = 1; return;
      }
      // Start over from the top rather than resuming at the missing step:
      // someone without a key for this route usually wants a DIFFERENT route,
      // and resuming would trap them on the one that just failed.
      console.log(pc.cyan(`Faber v${VERSION}`));
      console.log(pc.yellow(`Setup isn't finished — ${state.missing}. Starting over.`));
      const setup = await runOnboarding(rl, { first: true });
      reportSetup(setup);
      if (setup.aborted) { rl.close(); process.exitCode = 1; return; }
      config = loadConfig(config.workspace);
      const after = await setupComplete(config);
      if (!after.complete) {
        console.log(pc.yellow(`Setup still incomplete — ${after.missing}.`));
        console.log(pc.dim(`  ${after.fix}, then run faber again.`));
        rl.close(); process.exitCode = 1; return;
      }
    }
  }

  const resumeId = flags.has("--resume") ? SessionStore.latestId(config.sessionsDir) : undefined;
  let agent: Agent;
  try { agent = new Agent(config, approve, events, resumeId, askUser); }
  catch (e) {
    console.error(pc.red(`Error: ${e instanceof Error ? e.message : e}`));
    rl.close();
    process.exit(1);
  }

  const runTask = async (text: string): Promise<void> => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    // STEERING: anything typed while the agent works is queued and injected
    // at the next loop boundary (not available inside an approval prompt).
    const onLine = (line: string): void => {
      if (!line.trim()) return;
      agent.steer(restore(line).trim());
      console.log(pc.magenta(`  ↳ queued for the agent: ${describeComposed(line)}`));
    };
    status = new StatusLine(process.stdout, !!composer);
    status.start();
    if (composer) {
      composer.onInterrupt(cancel);
      composer.enterSteerMode((text) => {
        agent.steer(text.trim());
        console.log(pc.magenta(`  ↳ queued for the agent: ${Composer.describe(text)}`));
      });
    } else {
      rl.on("line", onLine);
    }
    try {
      const answer = await agent.runTask(text, controller.signal);
      console.log(pc.green("\n─ result ────────────────────────────"));
      console.log(renderMarkdown(answer));
      console.log(pc.green("─────────────────────────────────────"));
    } catch (e) {
      if (e instanceof CancelledError) {
        console.log(pc.yellow("\nInterrupted. Partial changes kept — /undo to revert."));
      } else if (e instanceof FatalError) {
        console.log(pc.red(`\nFatal: ${e.message}`));
      } else {
        console.log(pc.red(`\nUnexpected error: ${e instanceof Error ? e.stack ?? e.message : e}`));
      }
    } finally {
      status.stop();
      status = null;
      if (composer) composer.exitSteerMode();
      else rl.removeListener("line", onLine);
      process.removeListener("SIGINT", cancel);
    }
  };

  const command = async (line: string): Promise<boolean> => {
    const [name = "", ...args] = line.trim().split(/\s+/);
    const id = Number(args[0]);
    switch (name.toLowerCase()) {
      case "/exit": case "/quit": return false;
      case "/help": console.log(HELP); break;
      case "/index": {
        const s = agent.indexer.build();
        console.log(`Indexed ${s.files} files, ${s.symbols} symbols, ${s.edges} call edges.`); break;
      }
      case "/map": {
        if (!args[0]) { console.log("Usage: /map <function-or-symbol>   e.g. /map main"); break; }
        if (!agent.indexer.isBuilt()) agent.indexer.build(); else agent.indexer.refresh();
        console.log(agent.indexer.callTree(args[0]));
        break;
      }
      case "/memory": {
        const archived = args[0]?.toLowerCase() === "archived";
        const rows = archived ? agent.longTerm.archivedMemories() : agent.longTerm.allMemories();
        if (!rows.length) console.log(`No ${archived ? "archived" : "active"} memories.`);
        for (const m of rows) {
          const when = new Date(m.created * 1000).toISOString().slice(0, 10);
          console.log(`  #${m.id} [${m.kind}] (${when}) ${m.content}`);
        }
        if (!archived) for (const n of agent.longTerm.fileNotes()) console.log(`  file: ${n.path} — ${n.summary}`);
        break;
      }
      case "/forget":
        console.log(Number.isInteger(id) && agent.longTerm.forget(id) ? `Deleted memory #${id}.` : "Usage: /forget <id>"); break;
      case "/archive":
        console.log(Number.isInteger(id) && agent.longTerm.archive(id, true) ? `Archived memory #${id}.` : "Usage: /archive <id>"); break;
      case "/unarchive":
        console.log(Number.isInteger(id) && agent.longTerm.archive(id, false) ? `Restored memory #${id}.` : "Usage: /unarchive <id>"); break;
      case "/prune": {
        const days = Number(args[0]);
        if (!Number.isFinite(days)) { console.log("Usage: /prune <days>"); break; }
        console.log(`Archived ${agent.longTerm.archiveOlderThan(days)} memories older than ${days} days. See /memory archived.`);
        break;
      }
      case "/compact": {
        const before = agent.shortTerm.tokens();
        const did = await agent.shortTerm.maybeCompact(agent.llm, true);
        console.log(did ? `Compacted: ~${before} → ~${agent.shortTerm.tokens()} tokens.` : "Nothing to compact.");
        break;
      }
      case "/sessions":
        for (const s of SessionStore.list(config.sessionsDir)) {
          console.log(`  ${s.id}  (${s.messages} messages, ${(s.bytes / 1024).toFixed(1)} KB)`);
        }
        break;
      case "/undo": {
        const restored = agent.checkpoints.undoLast();
        console.log(restored.length
          ? `Reverted ${restored.length} file(s): ${restored.join(", ")}  (/redo to bring the change back)`
          : "Nothing to undo.");
        break;
      }
      case "/redo": {
        const redone = agent.checkpoints.redo();
        console.log(redone ? `Re-applied ${redone.length} file(s): ${redone.join(", ")}` : "Nothing to redo (redo follows an /undo or /restore in this session).");
        break;
      }
      case "/history": {
        const cps = agent.checkpoints.list();
        if (!cps.length) { console.log("No checkpoints yet."); break; }
        for (const c of cps.slice(-15)) {
          const label = c.kind === "restore-point" ? pc.dim(c.label || "restore point") : (c.label || "(unlabeled task)");
          console.log(`  ${c.id}  ${label}  [${c.files.length} file(s): ${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ", …" : ""}]`);
        }
        console.log(pc.dim("  /restore <id> to jump to the state before that task."));
        break;
      }
      case "/restore": {
        if (!args[0]) { console.log("Usage: /restore <checkpoint-id>   (ids from /history)"); break; }
        const restored = agent.checkpoints.restore(args[0]);
        console.log(restored ? `Restored ${restored.length} file(s) to before ${args[0]}. (/redo reverses this.)` : `No checkpoint ${args[0]}.`);
        break;
      }
      case "/clear": agent.shortTerm.clear(); console.log("Short-term memory cleared."); break;
      case "/model": {
        const route = getRoute(config.route) ?? ROUTES[0]!;
        if (args[0] === "--save") {
          updateActive({ model: agent.model });
          console.log(`Saved ${agent.model} as the default for profile "${config.profileName}".`);
          break;
        }
        if (args[0] && args[0] !== "--refresh") {          // direct: /model haiku
          const id = resolveModel(args[0], route, config.modelPins);
          agent.setModel(id);
          console.log(`Model for this session: ${describeModel(id, route, config.modelPins)}`);
          console.log(pc.dim("  /model --save   make it the profile default"));
          break;
        }
        // With no price data at all — first run, or the cache was discarded
        // because an older Faber wrote it — wait for the fetch rather than
        // rendering a menu that says "price unknown" for everything. The
        // background refresh is fine when we already have rates to show.
        if (!readPriceCache()) {
          process.stdout.write(pc.dim("  fetching prices… "));
          await refreshPrices(undefined, { baseUrl: config.baseUrl });
          process.stdout.write("\r\x1b[2K");
        }
        // Ask the provider what this key can actually use; cached for a day.
        if (args[0] === "--refresh") clearCache(route.id);
        let discovered = readCache(route.id);
        if (!discovered) {
          process.stdout.write(pc.dim("  fetching available models… "));
          discovered = await agent.llm.listModels();
          process.stdout.write("\r\x1b[2K");
          if (discovered.length) writeCache(route.id, discovered);
        }
        const entries = buildPicker(route, discovered ?? [], agent.model);
        if (!entries.length) {
          console.log(`No model list available for ${route.label}. Set one with: /model <id>`);
          break;
        }
        // Show the rate here too. /model is where people switch models to save
        // money, so hiding the price is exactly backwards.
        const width = Math.min(34, Math.max(...entries.map((e) => e.label.length)) + 2);
        const labels = entries.map((e) => {
          const id = resolveModel(e.value, route, config.modelPins);
          const p = priceFor(id, { in: config.priceIn, out: config.priceOut });
          const cost = p ? `$${p.in}/$${p.out} per Mtok` : "price unknown";
          return `${e.label.padEnd(width)}${pc.dim(cost.padEnd(22))}${pc.dim(e.blurb)}`;
        });
        const curIdx = entries.findIndex(
          (e) => e.value === agent.model || resolveModel(e.value, route, config.modelPins) === agent.model);
        const pick = await select(rl, "Select model (this session)", labels, curIdx < 0 ? 0 : curIdx);
        const chosen = entries[pick]!;
        const id = resolveModel(chosen.value, route, config.modelPins);
        agent.setModel(id);
        console.log(`Model for this session: ${describeModel(id, route, config.modelPins)}`);
        console.log(pc.dim("  /model --save   keep it · /model --refresh   re-check the provider"));
        break;
      }
      case "/key": {
        const route = getRoute(config.route) ?? ROUTES[0]!;
        const name = args[1] ?? route.keyEnv ?? "ANTHROPIC_API_KEY";
        if (args[0] === "set") {
          const val = await readSecret(rl, `  ${name} (hidden): `);
          if (!val) { console.log("Nothing entered."); break; }
          const problem = looksLikeKey(name, val);
          if (problem) {
            console.log(pc.yellow(`  ${problem}.`));
            const ok = await select(rl, "Save it anyway?", ["No, discard it", "Yes, save it"]);
            if (ok === 0) { console.log("Discarded."); break; }
          }
          saveCredential(name, val);
          console.log(`Saved ${name} (${maskCredential(val)}) — kept on this computer only.`);
          console.log(pc.dim(`  ${credentialsPath()}, readable only by you — restart faber to use it`));
        } else if (args[0] === "rm") {
          console.log(deleteCredential(name) ? `Removed ${name}.` : `No stored ${name}.`);
        } else {
          const names = listCredentialNames();
          if (!names.length) console.log(`No stored credentials. Add one with: /key set [${name}]`);
          for (const n of names) {
            const stored = getCredential(n)!;
            const shadowed = process.env[n] ? pc.dim("  (env var takes precedence)") : "";
            console.log(`  ${n.padEnd(24)} ${maskCredential(stored)}${shadowed}`);
          }
          console.log(pc.dim(`  ${credentialsPath()}`));
        }
        break;
      }
      case "/setup": {
        const setup = await runOnboarding(rl);
        reportSetup(setup);
        if (!setup.aborted) {
          // Apply in this session. Telling the user to restart left the
          // running agent on the old route, so /model would then list models
          // for the provider they had just switched away from.
          config = loadConfig(config.workspace);
          agent.reconfigure(config);
          console.log(pc.dim(`  now using ${describeModel(config.model, getRoute(config.route) ?? ROUTES[0]!, config.modelPins)} on ${getRoute(config.route)?.label}`));
        }
        break;
      }
      case "/route": {
        const groups = vendors();
        const vi = await select(rl, "Select vendor", groups.map((g) => g.vendor));
        const rs = groups[vi]!.routes;
        const ri = await select(rl, "Select route",
          rs.map((r) => `${r.label.padEnd(28)} ${pc.dim(r.hint)}${r.implemented ? "" : pc.yellow("  (not yet wired)")}`));
        const chosen = rs[ri]!;
        if (!chosen.implemented) {
          console.log(pc.yellow(`${chosen.label} isn't wired up yet — see the roadmap in the README.`));
          break;
        }
        let region: string | undefined;
        if (chosen.needsRegion) {
          const ans = (await rl.question(`AWS region [${DEFAULT_REGION}]: `)).trim();
          region = ans || DEFAULT_REGION;
        }
        let baseUrl = chosen.baseUrl;
        if (chosen.needsBaseUrl) {
          baseUrl = (await rl.question("Base URL (OpenAI-compatible): ")).trim() || undefined;
        }
        updateActive({ route: chosen.id, baseUrl, region, apiKeyEnv: chosen.keyEnv });
        console.log(`Route set to ${chosen.label}.`);
        const url = baseUrl ?? baseUrlFor(chosen, region);
        if (url) console.log(pc.dim(`  endpoint: ${url}`));
        if (chosen.keyEnv && !resolveCredential(chosen.keyEnv)) {
          if (chosen.id === "bedrock") {
            const { discoverAwsCredentials } = await import("./sigv4.js");
            const aws = await discoverAwsCredentials();
            console.log(aws
              ? pc.dim(`  no ${chosen.keyEnv} needed — signing with AWS credentials from ${aws.source}`)
              : pc.yellow(`  set ${chosen.keyEnv}, or run where an IAM role is available (SageMaker, ECS, EC2)`));
          } else {
            console.log(pc.yellow(`  ${chosen.keyEnv} is not set.`));
          }
        }
        if (chosen.aliasesArePinned) {
          console.log(pc.dim("  model ids differ on this route — set one with: /model <id>"));
        }
        config = loadConfig(config.workspace);
        agent.reconfigure(config);
        console.log(pc.dim(`  now on ${getRoute(config.route)?.label}`));
        break;
      }
      case "/profile": {
        const st = loadSettings();
        if (!args[0]) {
          for (const [name, p] of Object.entries(st.profiles)) {
            const mark = name === st.activeProfile ? pc.cyan("❯") : " ";
            const r = getRoute(p.route);
            console.log(`${mark} ${name.padEnd(12)} ${(r?.label ?? p.route).padEnd(26)} ${pc.dim(p.model ?? "")}`);
          }
          console.log(pc.dim(`  ${settingsPath()}`));
          console.log(pc.dim("  switch with: /profile <name>"));
          break;
        }
        if (!st.profiles[args[0]]) { console.log(`No profile "${args[0]}".`); break; }
        st.activeProfile = args[0];
        saveSettings(st);
        config = loadConfig(config.workspace);
        agent.reconfigure(config);
        console.log(`Active profile: ${args[0]} — ${getRoute(config.route)?.label}, ${config.model}.`);
        break;
      }
      case "/usage": {
        if (args[0] === "--refresh-prices") {
          process.stdout.write(pc.dim("  fetching current prices… "));
          const n = await refreshPrices(undefined, { baseUrl: config.baseUrl, force: true });
          process.stdout.write("\r\x1b[2K");
          console.log(
            n === "unchanged" ? "Prices confirmed current."
            : typeof n === "number" ? `Prices updated (${n} models).`
            : pc.yellow("Couldn't fetch prices — keeping the rates already known."));
        }
        console.log(renderUsagePanel(agent.usage, { in: config.priceIn, out: config.priceOut }));
        break;
      }
      case "/verbose": agent.verbose = true; console.log("Verbose mode ON: full-depth explanations (higher token cost)."); break;
      case "/concise": agent.verbose = false; console.log("Concise mode ON (default): short answers, code never truncated."); break;
      case "/ask": approvalMode = "ask"; console.log("Approval mode ON: diffs previewed before applying."); break;
      case "/auto": approvalMode = "auto"; console.log("Approval mode OFF: changes apply automatically."); break;
      default: console.log(`Unknown command: ${name} (try /help)`);
    }
    return true;
  };

  try {
    if (task) { await runTask(task); return; }
    console.log(pc.cyan(`Faber v${VERSION} — agentic coding assistant`));
    console.log(pc.dim(
      `workspace: ${config.workspace}\n` +
      `model: ${describeModel(config.model, getRoute(config.route) ?? ROUTES[0]!, config.modelPins)}` +
      `  route: ${getRoute(config.route)?.label ?? config.route}` +
      (config.profileName !== "default" ? `  profile: ${config.profileName}` : "") +
      `  approval: ${approvalMode}`));
    if (isRepo(config.workspace) && isDirty(config.workspace)) {
      console.log(pc.yellow("Git: you have uncommitted changes — consider committing before letting me edit."));
    }
    switch (ensureStateIgnored(config.workspace)) {
      case "excluded-now":
        console.log(pc.dim(`Protected ${path.basename(config.stateDir)}/ from commits via .git/info/exclude (local). Add it to .gitignore too if teammates will use Faber.`));
        break;
      case "TRACKED":
        console.log(pc.red("WARNING: the state directory is TRACKED by git — sessions and checkpoints may contain file contents/secrets. Run: git rm -r --cached .faber .codewright && add '.faber/' to .gitignore, then commit."));
        break;
    }
    if (!resumeId) {
      const last = SessionStore.lastSessionInfo(config.sessionsDir, agent.session.id);
      if (last) {
        const { humanAge } = await import("./agent.js");
        console.log(pc.yellow(
          `Previous session found (${last.messages} messages, ${humanAge(last.ageMs)} ago) — ` +
          `run \`faber --resume\` to continue it, or just ask: I can search past sessions.`,
        ));
      }
    }
    console.log(pc.dim(`Type a task, or /help for commands. While the agent works, keep typing to steer it.\n`));
    while (true) {
      let line: string;
      if (composer) {
        const got = await composer.readLine(pc.cyan("faber> "));
        if (got === null) break;
        line = got.trim();
      } else {
        try { line = restore(await rl.question(pc.cyan("faber> "))).trim(); }
        catch { break; }
      }
      if (!line) continue;
      if (line.startsWith("/")) {
        if (!(await command(line))) break;
        continue;
      }
      await runTask(line);
    }
  } finally {
    rl.close();
    agent.close();
    console.log(pc.dim("bye."));
  }
}

const HELP = `
  /index              rebuild the code graph (symbols + call edges)
  /map <symbol>       print the call tree from any entry point (e.g. /map main)
  /memory             show active long-term memories (+ file notes)
  /memory archived    show archived memories
  /forget <id>        permanently delete a memory
  /archive <id>       hide a memory from recall (kept on disk)
  /unarchive <id>     restore an archived memory
  /prune <days>       archive all memories older than <days>
  /compact            force-summarize the conversation now
  /sessions           list saved sessions (resume latest with: faber --resume)
  /undo               revert files changed by the last task (reversible)
  /redo               reverse the last /undo or /restore
  /history            list task checkpoints with files touched
  /restore <id>       jump files back to before a specific task
  /clear              clear short-term conversation memory
  /ask | /auto        approval mode: preview diffs and commands (default) / apply freely
                      env: FABER_APPROVAL=auto to change default; FABER_GIT=commit for one git commit per task
  /exit               quit
`;

main().catch((e) => { console.error(pc.red(String(e?.stack ?? e))); process.exit(1); });
