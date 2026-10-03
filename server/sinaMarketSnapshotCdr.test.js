import test from "node:test";
import assert from "node:assert/strict";
import { createSinaMarketSnapshotProvider } from "./sinaMarketSnapshot.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const ordinary = { symbol: "sh600001", code: "600001", name: "Ordinary fixture", mktcap: "20000", nmc: "10000" };
const cdr = { symbol: "sh689009", code: "689009", name: "Listed CDR fixture", listingDate: "2020-10-29" };

function fixture({ rows = [ordinary], quoteChanges = {}, sinaAvailable = false, missing = [] } = {}) {
  const calls = [];
  const request = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith("getHQNodeStockCount")) return { ok: true, json: async () => String(rows.length) };
    if (parsed.pathname.endsWith("getHQNodeData")) return { ok: true, json: async () => rows };
    if (parsed.hostname === "hq.sinajs.cn" && !sinaAvailable) return { ok: false, status: 403 };
    if (parsed.hostname === "hq.sinajs.cn" || parsed.hostname === "qt.gtimg.cn") {
      const tencent = parsed.hostname === "qt.gtimg.cn";
      const symbols = parsed.pathname.slice(tencent ? "/q=".length : "/list=".length).split(",");
      const quotes = symbols.filter((symbol) => !missing.includes(symbol)).map((symbol) => {
        const values = Array(tencent ? 50 : 32).fill("");
        if (tencent) Object.assign(values, {
          1: symbol === cdr.symbol ? cdr.name : ordinary.name, 2: symbol.slice(2),
          3: "37.10", 4: "36.04", 5: "36.08", 6: "6406961", 30: "20260930161450",
          35: "37.10/6406961/235191637", 37: "23519", 44: "208.59", 45: "273.00",
        }, quoteChanges[symbol]);
        else Object.assign(values, { 1: "36.08", 2: "36.04", 3: "37.10", 9: "235191637", 30: "2026-09-30", 31: "16:14:50" });
        return tencent ? `v_${symbol}="${values.join("~")}";` : `var hq_str_${symbol}="${values.join(",")}";`;
      }).join("\n");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(quotes).buffer };
    }
    throw new Error("unexpected synthetic request");
  };
  return { calls, load: createSinaMarketSnapshotProvider({ request, now: () => NOW }) };
}

test("a verified listed CDR missing from hs_a is included exactly once with Tencent yuan capital", async () => {
  const fake = fixture();
  const result = await fake.load({ supplements: [cdr, cdr], quotePreference: "tencent" });
  assert.equal(fake.calls.filter((url) => url.hostname === "hq.sinajs.cn").length, 0);
  assert.equal(result.stocks.length, 2);
  assert.deepEqual(result.coverage, { expected: 2, received: 2, dated: 2 });
  assert.deepEqual(result.universeCoverage, { sinaListed: 1, cdrSupplemented: 1 });
  assert.equal(result.capitalSource, "tencent");
  const stock = result.stocks.find((row) => row.code === "689009");
  assert.equal(stock.market, 1);
  assert.equal(stock.exchange, "sh");
  assert.equal(stock.name, cdr.name);
  assert.equal(stock.cap, 273e8);
  assert.equal(stock.floatCap, 208.59e8);
  assert.equal(stock.amount, 235191637);
  assert.ok(Math.abs(stock.pct - 2.941176470588236) < 1e-9);
  assert.equal(stock.quoteDate, "2026-09-30");
});

test("a listed CDR already present in the primary list is not duplicated or relabelled", async () => {
  const listed = { ...cdr, name: "Existing CDR fixture", mktcap: "2730000", nmc: "2085900" };
  const fake = fixture({ rows: [ordinary, listed] });
  const result = await fake.load({ supplements: [cdr], quotePreference: "tencent" });
  assert.equal(result.stocks.length, 2);
  assert.deepEqual(result.universeCoverage, { sinaListed: 2, cdrSupplemented: 0 });
  assert.equal(result.stocks.find((row) => row.code === "689009").name, listed.name);
});

test("future, impossible, missing, or wrong-market listing identities are rejected before any quote request", async (t) => {
  const invalid = [
    ["future listing", { ...cdr, listingDate: "2026-10-04" }],
    ["invalid calendar", { ...cdr, listingDate: "2026-02-30" }],
    ["missing date", { ...cdr, listingDate: undefined }],
    ["wrong market", { ...cdr, symbol: "sz689009" }],
    ["non CDR", { ...cdr, symbol: "sh688001", code: "688001" }],
    ["identity mismatch", { ...cdr, code: "689000" }],
  ];
  for (const [name, item] of invalid) await t.test(name, async () => {
    const fake = fixture();
    await assert.rejects(fake.load({ supplements: [item], quotePreference: "tencent" }),
      (error) => error.code === "SINA_RESPONSE_INVALID" && error.stage === "universe-page");
    assert.equal(fake.calls.filter((url) => ["qt.gtimg.cn", "hq.sinajs.cn"].includes(url.hostname)).length, 0);
  });
});

test("a CDR listing date must not be newer than its actual quote even when the whole market is recent", async () => {
  const fake = fixture({ sinaAvailable: true });
  await assert.rejects(fake.load({ supplements: [{ ...cdr, listingDate: "2026-10-01" }], quotePreference: "tencent" }),
    (error) => error.stage === "quotes" && error.code === "SINA_RESPONSE_INVALID");
});

test("a supplemented CDR missing from the quote batch cannot be reported as complete coverage", async () => {
  const fake = fixture({ missing: [cdr.symbol], sinaAvailable: true });
  await assert.rejects(fake.load({ supplements: [cdr], quotePreference: "tencent" }),
    (error) => error.stage === "quotes" && error.code === "SINA_COVERAGE_INCOMPLETE");
});

test("unknown, zero, negative and overflow CDR capital cannot create a misleading heatmap area", async (t) => {
  for (const [name, change] of [
    ["missing total", { 45: "" }], ["missing float", { 44: "-" }],
    ["zero total", { 45: "0" }], ["negative float", { 44: "-1" }],
    ["overflow", { 45: "1e308" }],
  ]) await t.test(name, async () => {
    const fake = fixture({ sinaAvailable: true, quoteChanges: { [cdr.symbol]: change } });
    await assert.rejects(fake.load({ supplements: [cdr], quotePreference: "tencent" }),
      (error) => error.stage === "quotes" && error.code === "SINA_RESPONSE_INVALID");
  });
});

test("unavailable ordinary Tencent capital uses the correctly scaled node fields and reports mixed provenance", async () => {
  const fake = fixture({ quoteChanges: { [ordinary.symbol]: { 45: "-2", 44: "0" } } });
  const result = await fake.load({ quotePreference: "tencent" });
  assert.equal(result.capitalSource, "sina-tencent");
  assert.equal(result.stocks[0].cap, 20000 * 10000);
  assert.equal(result.stocks[0].floatCap, 10000 * 10000);
  assert.equal(result.stocks[0].amount, 235191637);
  assert.equal(result.stocks[0].quoteSource, "tencent");
});
