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

  constructor(dbPath: string, private projectPath: string) {
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

/**
 * Render the /usage panel. Each row is priced per model using that model's own
 * rates, so a history that spans a switch from Sonnet to Opus stays accurate.
 */
export function renderUsagePanel(
  ledger: UsageLedger,
  override?: { in?: number; out?: number },
): string {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const windows: [string, number | undefined][] = [
    ["this session", undefined],
    ["today", midnight.getTime()],
    ["all time", 0],
  ];

  const lines: string[] = [];
  const W = [13, 7, 12, 9, 7, 9, 9];
  const cells = (c: string[]): string => c.map((s, i) => s.padEnd(W[i]!)).join(" ");
  lines.push(cells(["", "tasks", "in", "cached", "out", "cost", "saved"]));

  let anyPriced = false;
  let legacyRows = 0;
  let estimated = false;
  for (const [label, since] of windows) {
    // session totals come from memory; the rest are priced per model from disk
    // Every window is priced per model — including the session, which would
    // otherwise apply the last-used model's rates to earlier tasks.
    const bands = ledger.totalsByModel(since ?? ledger.startedAt);
    const agg: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, tasks: 0 };
    let cost: number | undefined;
    let saved: number | undefined;
    for (const b of bands) {
      agg.input += b.totals.input; agg.cacheRead += b.totals.cacheRead;
      agg.cacheWrite += b.totals.cacheWrite; agg.output += b.totals.output;
      agg.calls += b.totals.calls; agg.tasks += b.totals.tasks;
      // Historical cost is whatever was charged at the time — never repriced.
      if (b.billed.cost !== null) { cost = (cost ?? 0) + b.billed.cost; anyPriced = true; }
      if (b.billed.saved !== null) saved = (saved ?? 0) + b.billed.saved;
      if (b.billed.unpriced > 0) {
        // Rows recorded before costs were stored have nothing to preserve, so
        // estimate them at today's prices and flag the row as an estimate.
        legacyRows += b.billed.unpriced;
        const p = priceFor(b.model, override);
        const c = UsageLedger.cost(b.totals, p);
        const s = UsageLedger.saved(b.totals, p);
        if (c !== undefined) { cost = (cost ?? 0) + c; anyPriced = true; estimated = true; }
        if (s !== undefined) saved = (saved ?? 0) + s;
      }
    }
    const totalIn = agg.input + agg.cacheRead + agg.cacheWrite;
    const pct = totalIn > 0 ? Math.round((agg.cacheRead / totalIn) * 100) + "%" : "0%";
    lines.push(cells([label, String(agg.tasks), k(totalIn), pct, k(agg.output),
                      money(cost), money(saved)]));
  }

  if (anyPriced) {
    const src = readPriceCache();
    lines.push("");
    lines.push("cost is what each task was charged when it ran — later price changes don't rewrite it");
    const age = priceAgeDays();
    if (src && age !== undefined) {
      const when = new Date(src.fetchedAt).toISOString().slice(0, 10);
      lines.push(age > STALE_AFTER_DAYS
        ? `new tasks priced from rates fetched ${when} (${Math.round(age)} days ago — consider /usage --refresh-prices)`
        : `new tasks priced from rates fetched ${when}`);
    } else {
      lines.push(`new tasks priced from built-in rates, as of ${PRICES_AS_OF} — /usage --refresh-prices for current`);
    }
    if (legacyRows) {
      lines.push(`${legacyRows} older task(s) predate cost tracking${estimated ? " — estimated at today's rates" : ""}`);
    }
  } else {
    lines.push("");
    lines.push("no price known for this model — set FABER_PRICE_IN / FABER_PRICE_OUT");
  }

  const others = UsageLedger.allProjects().filter((p) => p.totals.tasks > 0);
  if (others.length > 1) {
    lines.push("");
    lines.push("across all projects:");
    for (const { project, totals: t } of others) {
      const totalIn = t.input + t.cacheRead + t.cacheWrite;
      lines.push(cells([
        "  " + path.basename(project).slice(0, 11), String(t.tasks), k(totalIn),
        totalIn > 0 ? Math.round((t.cacheRead / totalIn) * 100) + "%" : "0%",
        k(t.output), "", "",
      ]));
    }
  }
  return lines.join("\n");
}
