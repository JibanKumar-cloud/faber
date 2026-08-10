/**
 * Persistent usage ledger — every task's token/cost record, per project.
 * Stored in <project>/.faber/usage.db (per-project, like all state). Powers the
 * /usage panel (session / today / all-time) and cross-project totals via a
 * small registry of project paths in ~/.faber/projects.json — the first
 * resident of the global home directory from the roadmap.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { priceFor, cacheReadPrice, cacheWritePrice, PRICES_AS_OF, readPriceCache, priceAgeDays, STALE_AFTER_DAYS, type ModelPrice } from "./pricing.js";

export interface TaskUsage {
  input: number; cacheRead: number; cacheWrite: number; output: number; calls: number;
}
export interface UsageTotals extends TaskUsage { tasks: number; }

/** What was actually charged, as recorded at the time each task ran. */
export interface BilledTotals {
  cost: number | null;      // sum of stored per-task costs
  saved: number | null;
  unpriced: number;         // tasks recorded before prices were known
}

export class UsageLedger {
  private db: DatabaseSync;
  session: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, tasks: 0 };
  /** Model used by the most recent task. */
  currentModel = "";
  /** When this process started, so the session row can be priced per model. */
  private readonly sessionStart = Date.now();

  constructor(dbPath: string, readonly projectPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      ts INTEGER, input INTEGER, cache_read INTEGER, cache_write INTEGER,
      output INTEGER, calls INTEGER, model TEXT)`);
    // Cost is recorded when the task runs, at the prices in effect then.
    // Prices change; money already spent does not. Ledgers created before this
    // column existed keep NULL and are priced at display time as a fallback.
    for (const col of ["cost REAL", "saved REAL"]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); }
      catch { /* already migrated */ }
    }
    // Seven time windows each filter on ts, so make that lookup cheap.
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_ts ON tasks(ts)"); } catch { /* fine */ }
    this.registerProject();
  }

  /**
   * Record a completed task. Cost is computed and stored NOW, using the prices
   * in effect at this moment — later price changes never rewrite it.
   */
  record(u: TaskUsage, model: string, override?: { in?: number; out?: number }): void {
    this.currentModel = model;
    const p = priceFor(model, override);
    const cost = UsageLedger.cost(u, p) ?? null;
    const saved = UsageLedger.saved(u, p) ?? null;
    this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), u.input, u.cacheRead, u.cacheWrite, u.output, u.calls, model, cost, saved);
    this.session.input += u.input; this.session.cacheRead += u.cacheRead;
    this.session.cacheWrite += u.cacheWrite; this.session.output += u.output;
    this.session.calls += u.calls; this.session.tasks += 1;
  }

  totals(sinceMs?: number): UsageTotals {
    return this.db.prepare(
      `SELECT COUNT(*) tasks, COALESCE(SUM(input),0) input, COALESCE(SUM(cache_read),0) cacheRead,
              COALESCE(SUM(cache_write),0) cacheWrite, COALESCE(SUM(output),0) output,
              COALESCE(SUM(calls),0) calls
       FROM tasks WHERE ts >= ?`,
    ).get(sinceMs ?? 0) as unknown as UsageTotals;
  }

  /** Cost in USD for one usage record at a given model's prices. */
  static cost(u: TaskUsage, p?: ModelPrice): number | undefined {
    if (!p) return undefined;
    return (u.input * p.in + u.cacheRead * cacheReadPrice(p) +
            u.cacheWrite * cacheWritePrice(p) + u.output * p.out) / 1e6;
  }

  /** What caching saved vs paying full input price, net of the write premium. */
  static saved(u: TaskUsage, p?: ModelPrice): number | undefined {
    if (!p) return undefined;
    const readSaving = u.cacheRead * (p.in - cacheReadPrice(p));
    const writePremium = u.cacheWrite * (cacheWritePrice(p) - p.in);
    return (readSaving - writePremium) / 1e6;
  }

  /**
   * Totals split by model, so a history spanning several models is priced with
   * each model's own rates rather than whatever is loaded right now.
   */
  get startedAt(): number { return this.sessionStart; }

  totalsByModel(sinceMs?: number): { model: string; totals: UsageTotals; billed: BilledTotals }[] {
    const rows = this.db.prepare(
      `SELECT model, COUNT(*) tasks, COALESCE(SUM(input),0) input,
              COALESCE(SUM(cache_read),0) cacheRead, COALESCE(SUM(cache_write),0) cacheWrite,
              COALESCE(SUM(output),0) output, COALESCE(SUM(calls),0) calls,
              SUM(cost) billedCost, SUM(saved) billedSaved,
              SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced
       FROM tasks WHERE ts >= ? GROUP BY model`,
    ).all(sinceMs ?? 0) as unknown as
      (UsageTotals & { model: string; billedCost: number | null; billedSaved: number | null; unpriced: number })[];
    return rows.map((r) => ({
      model: r.model,
      totals: r,
      billed: { cost: r.billedCost, saved: r.billedSaved, unpriced: r.unpriced },
    }));
  }

  // ---- global registry so usage can be summed across every project ----
  private registerProject(): void {
    try {
      const dir = path.join(os.homedir(), ".faber");
      fs.mkdirSync(dir, { recursive: true });
      const reg = path.join(dir, "projects.json");
      let list: string[] = [];
      try { list = JSON.parse(fs.readFileSync(reg, "utf8")); } catch { /* fresh */ }
      if (!list.includes(this.projectPath)) {
        list.push(this.projectPath);
        fs.writeFileSync(reg, JSON.stringify(list, null, 2));
      }
    } catch { /* registry is best-effort */ }
  }

  static allProjects(): { project: string; totals: UsageTotals }[] {
    const home = os.homedir();
    let list: string[] = [];
    for (const reg of [path.join(home, ".faber", "projects.json"),
                       path.join(home, ".codewright", "projects.json")]) {
      try {
        for (const p of JSON.parse(fs.readFileSync(reg, "utf8")) as string[]) {
          if (!list.includes(p)) list.push(p);
        }
      } catch { /* absent registry is fine */ }
    }
    if (!list.length) return [];
    const out: { project: string; totals: UsageTotals }[] = [];
    for (const p of list) {
      const dbPath = [path.join(p, ".faber", "usage.db"), path.join(p, ".codewright", "usage.db")]
        .find((d) => fs.existsSync(d));
      if (!dbPath) continue;
      try {
        const led = new UsageLedger(dbPath, p);
        out.push({ project: p, totals: led.totals() });
        led.close();
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  close(): void { this.db.close(); }
}

const k = (n: number): string => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M"
  : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const money = (v: number | undefined): string => v === undefined ? "—" : `$${v.toFixed(2)}`;

/** Cents below a dollar — 3.4¢ reads better than $0.034. */
const cents = (usd: number): string =>
  usd < 1 ? `${(usd * 100).toFixed(1)}¢` : `$${usd.toFixed(2)}`;

/** "gpt-5.3-codex", not a 40-character regional deployment id. */
function shortModel(id: string): string {
  return id
    .replace(/^(global|us|eu|apac|au|jp)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+:\d+$/, "")
    // "claude-haiku-4-5-20251001" -> "haiku-4-5": the vendor is already known
    // from the route, and a mid-word truncation reads as a different model.
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .slice(0, 15);
}

const DAY = 86_400_000;

/**
 * Rolling windows, not calendar ones.
 *
 * "This month" means one day on the 1st and thirty on the 31st, and it resets
 * overnight — two figures side by side aren't comparable. Rolling windows
 * always cover the span they name.
 */
function windows(now: number): [string, number][] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  return [
    ["today", midnight.getTime()],
    ["last 7 days", now - 7 * DAY],
    ["last 14 days", now - 14 * DAY],
    ["last 30 days", now - 30 * DAY],
    ["last 3 months", now - 91 * DAY],
    ["last 6 months", now - 182 * DAY],
    ["all time", 0],
  ];
}

interface Band { model: string; totals: UsageTotals; billed: BilledTotals; }

/** Sum a set of per-model bands into one row, pricing anything unrecorded. */
function rollUp(bands: Band[], override?: { in?: number; out?: number }): {
  totals: UsageTotals; cost?: number; saved?: number; unpriced: number; estimated: boolean;
} {
  const totals: UsageTotals =
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, tasks: 0 };
  let cost: number | undefined;
  let saved: number | undefined;
  let unpriced = 0;
  let estimated = false;
  for (const b of bands) {
    totals.input += b.totals.input; totals.cacheRead += b.totals.cacheRead;
    totals.cacheWrite += b.totals.cacheWrite; totals.output += b.totals.output;
    totals.calls += b.totals.calls; totals.tasks += b.totals.tasks;
    if (b.billed.cost !== null) cost = (cost ?? 0) + b.billed.cost;
    if (b.billed.saved !== null) saved = (saved ?? 0) + b.billed.saved;
    if (b.billed.unpriced > 0) {
      // Tasks recorded before costs were stored have nothing to preserve, so
      // estimate them at today's rates rather than showing a gap.
      unpriced += b.billed.unpriced;
      const p = priceFor(b.model, override);
      const c = UsageLedger.cost(b.totals, p);
      const s = UsageLedger.saved(b.totals, p);
      if (c !== undefined) { cost = (cost ?? 0) + c; estimated = true; }
      if (s !== undefined) saved = (saved ?? 0) + s;
    }
  }
  return { totals, cost, saved, unpriced, estimated };
}

/**
 * The /usage panel for this project.
 *
 * Seven fixed windows, never collapsed even when identical: a missing row
 * would read as "no data" when it actually means "nothing new since", and
 * that distinction is exactly what someone returning after a break wants.
 *
 * The two columns nobody can interpret unaided — cached and saved — are
 * defined underneath. A metric a reader has to guess at gets ignored.
 */
export function renderUsagePanel(
  ledger: UsageLedger,
  override?: { in?: number; out?: number },
  now = Date.now(),
): string {
  const W = [15, 7, 9, 8, 7, 8, 9];
  const cell = (c: string[]): string =>
    c.map((s, i) => (i === c.length - 1 ? s : s.padEnd(W[i]!))).join(" ").trimEnd();
  const pad = " ".repeat(W[0]!);
  const lines: string[] = [path.basename(ledger.projectPath), ""];

  lines.push(cell(["", "tasks", "in", "cached", "out", "cost", "saved"]));

  let allTime = rollUp([], override);
  for (const [label, since] of windows(now)) {
    const r = rollUp(ledger.totalsByModel(since) as Band[], override);
    const totalIn = r.totals.input + r.totals.cacheRead + r.totals.cacheWrite;
    lines.push(cell([
      label, String(r.totals.tasks), k(totalIn),
      totalIn > 0 ? `${Math.round((r.totals.cacheRead / totalIn) * 100)}%` : "0%",
      k(r.totals.output), money(r.cost), money(r.saved),
    ]));
    if (label === "all time") allTime = r;
  }

  lines.push("");
  if (allTime.cost !== undefined && allTime.totals.tasks > 0) {
    lines.push(pad + `${cents(allTime.cost / allTime.totals.tasks)} per task`);
  }
  lines.push(pad + "cached = input reused from cache, billed at ~10%");
  if (allTime.cost !== undefined && allTime.saved !== undefined && allTime.saved > 0) {
    lines.push(pad +
      `saved  = caching cost you ${money(allTime.cost)} instead of ${money(allTime.cost + allTime.saved)}`);
  }
  const src = readPriceCache();
  lines.push(pad + (src
    ? `rates ${new Date(src.fetchedAt).toISOString().slice(0, 10)} · /usage --refresh-prices`
    : `built-in rates, as of ${PRICES_AS_OF} · /usage --refresh-prices`));
  if (allTime.unpriced > 0) {
    lines.push(pad +
      `${allTime.unpriced} older task(s) predate cost tracking${allTime.estimated ? ", estimated" : ""}`);
  }

  // Where the money goes. Only models actually used appear, because this is
  // built from recorded tasks rather than a catalogue.
  const byModel = (ledger.totalsByModel(0) as Band[])
    .filter((b) => b.totals.tasks > 0)
    .map((b) => {
      const r = rollUp([b], override);
      return { model: b.model, totals: r.totals, cost: r.cost };
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  if (byModel.length > 1) {
    lines.push("");
    lines.push(cell(["by model", "tasks", "in", "cached", "out", "cost", "per task"]));
    for (const b of byModel) {
      const totalIn = b.totals.input + b.totals.cacheRead + b.totals.cacheWrite;
      lines.push(cell([
        shortModel(b.model), String(b.totals.tasks), k(totalIn),
        totalIn > 0 ? `${Math.round((b.totals.cacheRead / totalIn) * 100)}%` : "0%",
        k(b.totals.output), money(b.cost),
        b.cost !== undefined ? cents(b.cost / b.totals.tasks) : "—",
      ]));
    }
  }
  return lines.join("\n");
}
