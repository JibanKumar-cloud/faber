import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UsageLedger, renderUsagePanel } from "../src/usage.js";

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

test("usage: cost and savings math", () => {
  const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 100_000, output: 100_000, calls: 1 };
  // in=$3: 1M fresh=$3 + 1M cached@0.1=$0.30 + 100k write@1.25=$0.375; out=$15: 100k=$1.50
  assert.ok(Math.abs(UsageLedger.cost(u, 3, 15)! - 5.175) < 1e-9);
  // saved: 1M reads avoid 0.9x($3)=$2.70 minus write premium 100k*0.25*$3/1M=$0.075
  assert.ok(Math.abs(UsageLedger.saved(u, 3)! - 2.625) < 1e-9);
  assert.equal(UsageLedger.cost(u), undefined);      // no prices configured
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
  assert.match(noPrices, /CW_PRICE_IN/);             // hint when unpriced
  const priced = renderUsagePanel(ledger, 3, 15);
  assert.match(priced, /\$0\.1[45]/);                // ~ $0.14-0.15 task
  assert.doesNotMatch(priced, /CW_PRICE_IN/);
  ledger.close();
});
