import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { UsageLedger, renderUsagePanel } from "../src/usage.js";
const require = createRequire(import.meta.url);

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-usage-"));
  return { ledger: new UsageLedger(path.join(dir, "usage.db"), dir), dir };
}

test("usage: records persist across ledger instances (survives restart)", () => {
  const { ledger, dir } = tmpLedger();
  ledger.record({ input: 1000, cacheRead: 4000, cacheWrite: 200, output: 300, calls: 3 }, "m");
  ledger.record({ input: 500, cacheRead: 2000, cacheWrite: 0, output: 100, calls: 1 }, "m");
  assert.equal(ledger.session.tasks, 2);
  assert.equal(ledger.session.output, 400);
  ledger.close();
  // fresh instance = new session, but all-time totals persist from disk
  const reopened = new UsageLedger(path.join(dir, "usage.db"), dir);
  assert.equal(reopened.session.tasks, 0);
  const t = reopened.totals();
  assert.equal(t.tasks, 2);
  assert.equal(t.input, 1500);
  assert.equal(t.cacheRead, 6000);
  assert.equal(t.calls, 4);
  reopened.close();
});

test("usage: cost and savings use a model's exact cache rates", () => {
  const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 100_000, output: 100_000, calls: 1 };
  // sonnet-5: $2 in, $10 out, $0.20 cache read, $2.50 cache write (per Mtok)
  // 1M fresh=$2.00 + 1M cached=$0.20 + 100k write=$0.25 + 100k out=$1.00
  const p = { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 };
  assert.ok(Math.abs(UsageLedger.cost(u, p)! - 3.45) < 1e-9);
  // saved: reads avoid ($2.00-$0.20)/M = $1.80, minus write premium 100k*($2.50-$2.00)=$0.05
  assert.ok(Math.abs(UsageLedger.saved(u, p)! - 1.75) < 1e-9);
  assert.equal(UsageLedger.cost(u, undefined), undefined);   // unknown model -> no guess

  // when a model has no cache rates, fall back to the standard multipliers
  const bare = { in: 2, out: 10 };
  assert.ok(Math.abs(UsageLedger.cost(u, bare)! - (2 + 0.2 + 0.25 + 1)) < 1e-9);
});

test("usage: panel renders session/today/all-time rows and price hint", () => {
  const { ledger } = tmpLedger();
  ledger.record({ input: 27_000, cacheRead: 46_000, cacheWrite: 500, output: 3600, calls: 3 }, "m");
  const noPrices = renderUsagePanel(ledger);
  assert.match(noPrices, /this session/);
  assert.match(noPrices, /today/);
  assert.match(noPrices, /all time/);
  assert.match(noPrices, /73\.5k/);                  // total in
  assert.match(noPrices, /63%/);                     // cache share of input
  // an unknown model gives no price and says so instead of guessing
  assert.match(noPrices, /no price known|prices built in/);
  // an override prices rows that have no recorded cost (and says they're estimates)
  const priced = renderUsagePanel(ledger, { in: 3, out: 15 });
  assert.match(priced, /\$0\.\d\d/);
  assert.match(priced, /charged when it ran/, "the panel states the accounting rule");
  ledger.close();
});

test("usage: a recorded cost is immutable — later price changes never rewrite history", async () => {
  const { priceFor } = await import("../src/pricing.js");
  const { writePriceCache } = await import("../src/pricing.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-hist-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    // day 1: the model costs $2/$10
    writePriceCache({ "test-model": { in: 2, out: 10 } }, "test");
    const { ledger, dir } = tmpLedger();
    const usage = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 100_000, calls: 1 };
    ledger.record(usage, "test-model");
    const dayOne = ledger.totalsByModel(0)[0]!.billed.cost!;
    assert.ok(Math.abs(dayOne - 3.0) < 1e-9, `expected $3.00, got ${dayOne}`);
    ledger.close();

    // day 10: the vendor doubles the price
    writePriceCache({ "test-model": { in: 4, out: 20 } }, "test");
    assert.equal(priceFor("test-model")!.in, 4, "new tasks would price at the new rate");

    // the old task still reads $3.00 — money already spent doesn't change
    const reopened = new UsageLedger(path.join(dir, "usage.db"), dir);
    assert.ok(Math.abs(reopened.totalsByModel(0)[0]!.billed.cost! - 3.0) < 1e-9,
      "historical cost must not be repriced");

    // and a new task at the new price adds on top, priced its own way
    reopened.record(usage, "test-model");
    const total = reopened.totalsByModel(0)[0]!.billed.cost!;
    assert.ok(Math.abs(total - (3.0 + 6.0)) < 1e-9, `expected $9.00 total, got ${total}`);
    reopened.close();
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
    process.env.USERPROFILE = prev;   // os.homedir() uses this on Windows
  }
});

test("usage: ledgers written before cost tracking still load and are counted", () => {
  const { ledger, dir } = tmpLedger();
  ledger.close();
  // simulate an old-format row: no cost/saved values
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "usage.db"));
  db.prepare("INSERT INTO tasks (ts, input, cache_read, cache_write, output, calls, model) VALUES (?,?,?,?,?,?,?)")
    .run(Date.now(), 1000, 0, 0, 100, 1, "old-model");
  db.close();

  const reopened = new UsageLedger(path.join(dir, "usage.db"), dir);
  const band = reopened.totalsByModel(0)[0]!;
  assert.equal(band.totals.tasks, 1, "old rows still counted in token totals");
  assert.equal(band.billed.cost, null, "no invented cost for an untracked task");
  assert.equal(band.billed.unpriced, 1, "and it's reported as unpriced");
  reopened.close();
});

test("pricing: staleness is tracked so stale rates can't silently enter history", async () => {
  const { pricesAreStale, priceAgeDays, writePriceCache, STALE_AFTER_DAYS } =
    await import("../src/pricing.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-stale-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    assert.equal(priceAgeDays(), undefined, "never fetched");
    assert.equal(pricesAreStale(), true, "built-in defaults count as stale");

    writePriceCache({ m: { in: 1, out: 2 } }, "test");
    assert.ok(priceAgeDays()! < 1);
    assert.equal(pricesAreStale(), false, "just fetched");

    const later = Date.now() + (STALE_AFTER_DAYS + 1) * 86_400_000;
    assert.ok(priceAgeDays(later)! > STALE_AFTER_DAYS);
    assert.equal(pricesAreStale(later), true, "goes stale after the window");
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
    process.env.USERPROFILE = prev;   // os.homedir() uses this on Windows
  }
});

test("config: price auto-refresh is on by default and opt-out-able", async () => {
  const { loadConfig } = await import("../src/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-auto-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "faber-ws-"));
  const prevHome = process.env.HOME, prevEnv = process.env.FABER_AUTO_PRICES;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    delete process.env.FABER_AUTO_PRICES;
    assert.equal(loadConfig(ws).autoRefreshPrices, true, "on by default");

    process.env.FABER_AUTO_PRICES = "0";
    assert.equal(loadConfig(ws).autoRefreshPrices, false, "env opt-out respected");

    delete process.env.FABER_AUTO_PRICES;
    fs.mkdirSync(path.join(home, ".faber"), { recursive: true });
    fs.writeFileSync(path.join(home, ".faber", "settings.json"), JSON.stringify({
      activeProfile: "default",
      profiles: { default: { route: "anthropic-api", autoRefreshPrices: false } },
    }));
    assert.equal(loadConfig(ws).autoRefreshPrices, false, "profile opt-out respected");
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevHome;
    process.env.USERPROFILE = prevHome;   // os.homedir() uses this on Windows
    if (prevEnv === undefined) delete process.env.FABER_AUTO_PRICES;
    else process.env.FABER_AUTO_PRICES = prevEnv;
  }
});

test("pricing: a failed refresh backs off instead of retrying every launch", async () => {
  const { shouldAutoRefresh, refreshPrices, readPriceCache, RETRY_AFTER_FAILURE_MS } =
    await import("../src/pricing.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-backoff-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    assert.equal(shouldAutoRefresh(), true, "first ever launch: try");

    // simulate an offline machine — the fetch fails
    assert.equal(await refreshPrices("http://127.0.0.1:1"), undefined);
    const after = readPriceCache()!;
    assert.ok(after.lastAttempt, "the attempt is remembered even though it failed");
    assert.equal(after.fetchedAt, 0, "but no prices were recorded");

    assert.equal(shouldAutoRefresh(), false,
      "the very next launch must NOT retry — this is the every-launch bug");

    const tomorrow = Date.now() + RETRY_AFTER_FAILURE_MS + 1000;
    assert.equal(shouldAutoRefresh(tomorrow), true, "retries once a day, not every run");
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
    process.env.USERPROFILE = prev;   // os.homedir() uses this on Windows
  }
});

test("pricing: every launch re-checks (a 304 is free); only failures back off", async () => {
  const { shouldAutoRefresh, writePriceCache } = await import("../src/pricing.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-fresh2-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    assert.equal(shouldAutoRefresh(), true, "never fetched");
    writePriceCache({ m: { in: 1, out: 2 } }, "test");
    assert.equal(shouldAutoRefresh(), true,
      "checks again next launch — conditional requests cost ~0 bytes when unchanged");
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
    process.env.USERPROFILE = prev;   // os.homedir() uses this on Windows
  }
});

test("pricing: a 304 confirms prices without re-downloading them", async () => {
  const { refreshPrices, readPriceCache, writePriceCache } = await import("../src/pricing.js");
  const http = await import("node:http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "faber-304-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() uses this on Windows
  try {
    let sentIfNoneMatch: string | undefined;
    let bodyServed = 0;
    const srv = http.createServer((req, res) => {
      sentIfNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (sentIfNoneMatch === '"v1"') { res.writeHead(304); return res.end(); }
      bodyServed++;
      res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
      res.end(JSON.stringify({ m: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }));
    });
    const url = await new Promise<string>((r) =>
      srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));

    // first call downloads and stores the etag
    assert.equal(await refreshPrices(url), 1);
    assert.equal(bodyServed, 1);
    assert.equal(readPriceCache()!.etag, '"v1"');
    const firstFetch = readPriceCache()!.fetchedAt;

    // second call sends the etag and gets 304 — no body transferred
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await refreshPrices(url), "unchanged");
    assert.equal(sentIfNoneMatch, '"v1"', "the conditional header was sent");
    assert.equal(bodyServed, 1, "the server never re-sent the payload");

    const after = readPriceCache()!;
    assert.deepEqual(after.prices["m"], { in: 1, out: 2 }, "prices intact");
    assert.ok(after.fetchedAt > firstFetch, "and re-confirmed as current");
    srv.close();
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
    process.env.USERPROFILE = prev;   // os.homedir() uses this on Windows
  }
});

test("tests redirect the home directory on every platform, not just Unix", async () => {
  const osx = await import("node:os");
  const saved = { home: process.env.HOME, up: process.env.USERPROFILE };
  const fsx = await import("node:fs");
  const pathx = await import("node:path");
  try {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "faber-homecheck-"));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // os.homedir() reads HOME on Unix and USERPROFILE on Windows. Setting only
    // one leaves the other platform writing into the real home directory,
    // where tests then clobber each other's caches — the cause of the Windows
    // CI failures that Linux and macOS never showed.
    assert.equal(osx.homedir(), dir,
      "redirection must hold on this platform, or tests share real state");
  } finally {
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.up === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.up;
  }
});
