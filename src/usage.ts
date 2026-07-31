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

export interface TaskUsage {
  input: number; cacheRead: number; cacheWrite: number; output: number; calls: number;
}
export interface UsageTotals extends TaskUsage { tasks: number; }

export class UsageLedger {
  private db: DatabaseSync;
  session: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, tasks: 0 };

  constructor(dbPath: string, private projectPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      ts INTEGER, input INTEGER, cache_read INTEGER, cache_write INTEGER,
      output INTEGER, calls INTEGER, model TEXT)`);
    this.registerProject();
  }

  record(u: TaskUsage, model: string): void {
    this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), u.input, u.cacheRead, u.cacheWrite, u.output, u.calls, model);
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

  /** Cost in USD; undefined when CW_PRICE_IN/OUT aren't configured. */
  static cost(u: TaskUsage, priceIn?: number, priceOut?: number): number | undefined {
    if (!priceIn || !priceOut) return undefined;
    return (u.input * priceIn + u.cacheRead * priceIn * 0.1 +
            u.cacheWrite * priceIn * 1.25 + u.output * priceOut) / 1e6;
  }

  /** Net savings from caching vs paying full input price (reads at 0.1x minus write premium). */
  static saved(u: TaskUsage, priceIn?: number): number | undefined {
    if (!priceIn) return undefined;
    return (u.cacheRead * priceIn * 0.9 - u.cacheWrite * priceIn * 0.25) / 1e6;
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

/** Render the /usage stats panel. */
export function renderUsagePanel(
  ledger: UsageLedger, priceIn?: number, priceOut?: number,
): string {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const rows: [string, UsageTotals][] = [
    ["this session", ledger.session],
    ["today", ledger.totals(midnight.getTime())],
    ["all time", ledger.totals()],
  ];
  const lines: string[] = [];
  const W = [13, 7, 12, 9, 7, 9, 9];
  const cells = (c: string[]): string => c.map((s, i) => s.padEnd(W[i]!)).join(" ");
  lines.push(cells(["", "tasks", "in", "cached", "out", "cost", "saved"]));
  for (const [label, t] of rows) {
    const totalIn = t.input + t.cacheRead + t.cacheWrite;
    const pct = totalIn > 0 ? Math.round((t.cacheRead / totalIn) * 100) + "%" : "0%";
    lines.push(cells([
      label, String(t.tasks), k(totalIn), pct, k(t.output),
      money(UsageLedger.cost(t, priceIn, priceOut)),
      money(UsageLedger.saved(t, priceIn)),
    ]));
  }
  if (!priceIn || !priceOut) {
    lines.push("");
    lines.push("set CW_PRICE_IN and CW_PRICE_OUT ($/Mtok) to see cost and savings");
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
        k(t.output), money(UsageLedger.cost(t, priceIn, priceOut)), "",
      ]));
    }
  }
  return lines.join("\n");
}
