import test from "node:test";
import assert from "node:assert/strict";
import { createSinaMarketSnapshotProvider } from "./sinaMarketSnapshot.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const rows = [
  { symbol: "sh600001", code: "600001", name: "Alpha", trade: "10", settlement: "8", open: "9", amount: 500, mktcap: 20, nmc: 10 },
  { symbol: "bj920001", code: "920001", name: "Beta", trade: "30", settlement: "25", open: "29", amount: 900, mktcap: 50, nmc: 30 },
];

const responseText = (text) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const denied = () => ({ ok: false, status: 403 });

function tencentQuote(row, changes = {}) {
  const values = Array(50).fill("");
  Object.assign(values, {
    1: row.name, 2: row.code, 3: "120", 4: "100", 5: "110", 6: "234", 30: "20260930161500",
    35: "120/234/234567.89", 37: "23.46",
  }, changes);
  return `v_${row.symbol}="${values.join("~")}";`;
}

function sinaQuote(row) {
  const values = Array(32).fill("");
  Object.assign(values, { 1: "45", 2: "40", 3: "50", 9: "123456", 30: "2026-09-30", 31: "16:30:00" });
  return `var hq_str_${row.symbol}="${values.join(",")}";`;
}

function fixture({ stocks = rows, sina = () => denied(), tencent = (batch) => responseText(batch.map((row) => tencentQuote(row)).join("\n")) } = {}) {
  const calls = [];
  const bySymbol = new Map(stocks.map((row) => [row.symbol, row]));
  const request = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, signal: options.signal });
    if (parsed.pathname.endsWith("getHQNodeStockCount")) return { ok: true, json: async () => String(stocks.length) };
    if (parsed.pathname.endsWith("getHQNodeData")) {
      const page = Number(parsed.searchParams.get("page"));
      const members = parsed.searchParams.get("node") === "hs_a" ? stocks : [stocks[0]];
      return { ok: true, json: async () => members.slice((page - 1) * 100, page * 100) };
    }
    if (parsed.pathname.endsWith("newSinaHy.php")) return responseText('var directory={"new_alpha":"new_alpha,AlphaIndustry,1,1"};');
    if (parsed.hostname === "hq.sinajs.cn" || parsed.hostname === "qt.gtimg.cn") {
      const batch = parsed.pathname.slice(parsed.hostname === "hq.sinajs.cn" ? "/list=".length : "/q=".length)
        .split(",").map((symbol) => bySymbol.get(symbol));
      return parsed.hostname === "hq.sinajs.cn" ? sina(batch, parsed, options) : tencent(batch, parsed, options);
    }
    throw new Error("Unexpected synthetic fixture request");
  };
  return { calls, request };
}

const callsTo = (fake, hostname) => fake.calls.filter((call) => call.url.hostname === hostname);
const syntheticStocks = (count) => Array.from({ length: count }, (_, index) => ({
  ...rows[0], symbol: `sh${600000 + index}`, code: String(600000 + index), name: `Synthetic${index}`,
}));
const loadFixture = (fake) => createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW });

test("production-shaped Sina HQ 403 switches complete quotes to Tencent with truthful source and yuan precision", async () => {
  const fake = fixture({ tencent: (batch) => responseText(batch.map((row) => tencentQuote(row,
    row.symbol === rows[1].symbol ? { 35: "", 37: "12.345" } : {})).join("\n")) });
  const result = await loadFixture(fake)({ withIndustries: true });
  assert.equal(result.source, "sina-tencent");
  assert.equal(result.quoteSource, "tencent");
  assert.equal(result.universeSource, "sina");
  assert.equal(result.capitalSource, "sina");
  assert.equal(result.classification, "新浪行业");
  assert.equal(result.stocks[0].industry, "AlphaIndustry");
  assert.equal(result.stocks[1].industry, null);
  assert.equal(result.dataDate, "2026-09-30");
  assert.equal(result.quoteTime, "2026-09-30T08:15:00.000Z");
  assert.equal(result.updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(result.coverage, { expected: 2, received: 2, dated: 2 });
  for (const stock of result.stocks) {
    assert.equal(stock.close, 120);
    assert.equal(stock.open, 110);
    assert.ok(Math.abs(stock.pct - 20) < 1e-10);
    assert.equal(stock.quoteSource, "tencent");
    assert.equal(stock.quoteDate, "2026-09-30");
    assert.equal(stock.mainInflow, null);
  }
  assert.equal(result.stocks[0].amount, 234567.89); // 35 keeps yuan precision; 37 is rounded in ten-thousands of yuan.
  assert.equal(result.stocks[1].amount, 123450); // Missing 35 can use the same quote's 37, with its explicit unit.
  assert.equal(result.stocks[0].cap, 200000);
  assert.equal(result.stocks[0].floatCap, 100000);
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 1);
  assert.equal(callsTo(fake, "qt.gtimg.cn").length, 1);
});

test("a successful quote source is remembered, and an unavailable Tencent source can recover to Sina", async () => {
  let sinaUnavailable = true;
  let tencentUnavailable = false;
  const fake = fixture({
    sina: (batch) => sinaUnavailable ? denied() : responseText(batch.map(sinaQuote).join("\n")),
    tencent: (batch) => tencentUnavailable ? { ok: false, status: 503 } : responseText(batch.map((row) => tencentQuote(row)).join("\n")),
  });
  const load = loadFixture(fake);
  assert.equal((await load()).quoteSource, "tencent");
  assert.equal((await load()).quoteSource, "tencent");
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 1);
  assert.equal(callsTo(fake, "qt.gtimg.cn").length, 2);
  sinaUnavailable = false;
  tencentUnavailable = true;
  const recovered = await load();
  assert.equal(recovered.source, "sina");
  assert.equal(recovered.quoteSource, "sina");
  assert.equal(recovered.stocks[0].close, 50);
  assert.equal(recovered.stocks[0].amount, 123456);
  assert.equal((await load()).quoteSource, "sina");
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 3);
  assert.equal(callsTo(fake, "qt.gtimg.cn").length, 3);
});

test("a successful first Sina batch is discarded when a later batch fails so prices never mix providers", async () => {
  const stocks = syntheticStocks(101);
  const fake = fixture({ stocks, sina: (batch) => batch[0].symbol === stocks[0].symbol
    ? responseText(batch.map(sinaQuote).join("\n")) : denied() });
  const result = await loadFixture(fake)();
  assert.equal(result.stocks.length, 101);
  assert.deepEqual(result.coverage, { expected: 101, received: 101, dated: 101 });
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 2);
  assert.equal(callsTo(fake, "qt.gtimg.cn").length, 2);
  assert.ok(result.stocks.every((row) => row.quoteSource === "tencent" && row.close === 120 && row.amount === 234567.89));
});

test("missing Tencent members, identity mismatches, malformed rows, and complete network failure reject the snapshot", async (t) => {
  const cases = [
    ["missing member", (batch) => responseText(tencentQuote(batch[0])), "TENCENT_COVERAGE_INCOMPLETE"],
    ["wrong identity", (batch) => responseText(batch.map((row) => tencentQuote(row, { 2: "999999" })).join("\n")), "TENCENT_RESPONSE_INVALID"],
    ["too few fields", (batch) => responseText(batch.map((row) => `v_${row.symbol}="1~Synthetic~${row.code}";`).join("\n")), "TENCENT_RESPONSE_INVALID"],
    ["duplicate cannot replace missing member", (batch) => responseText(`${tencentQuote(batch[0])}\n${tencentQuote(batch[0])}`), "TENCENT_COVERAGE_INCOMPLETE"],
    ["all requests fail", () => { throw new TypeError("Synthetic connection refused"); }, "TENCENT_NETWORK_ERROR"],
  ];
  for (const [name, tencent, code] of cases) await t.test(name, async () => {
    const fake = fixture({ tencent });
    await assert.rejects(loadFixture(fake)(), (error) => error.code === code && error.stage === "quotes");
  });
});

test("Tencent invalid or missing fields and dates remain null while suspended quotes keep their actual old date", async () => {
  const stocks = syntheticStocks(5);
  const overrides = [
    {},
    { 3: "", 4: "", 5: "", 35: "", 37: "", 30: "" },
    { 30: "20261004150000" },
    { 30: "20260230150000" },
    { 30: "20260929150000" },
  ];
  const fake = fixture({ stocks, tencent: (batch) => responseText(batch.map((row) => tencentQuote(row, overrides[stocks.indexOf(row)])).join("\n")) });
  const result = await loadFixture(fake)();
  assert.equal(result.stocks.length, 5);
  assert.equal(result.coverage.dated, 2);
  assert.deepEqual(result.quoteDateCounts, { "2026-09-30": 1, "2026-09-29": 1 });
  const missing = result.stocks[1];
  for (const field of ["close", "open", "pct", "amount", "quoteDate", "quoteAt"]) assert.equal(missing[field], null);
  for (const index of [2, 3]) {
    assert.equal(result.stocks[index].quoteDate, null);
    assert.equal(result.stocks[index].quoteAt, null);
  }
  assert.equal(result.stocks[4].quoteDate, "2026-09-29");
  assert.equal(result.stocks[4].quoteAt, Date.parse("2026-09-29T15:00:00+08:00") / 1000);
  assert.equal(result.quoteTime, "2026-09-30T08:15:00.000Z");
});

test("a wholly future or obsolete Tencent market cannot be relabelled with the fetch date", async (t) => {
  for (const [name, stamp] of [
    ["future", "20261004150000"],
    ["obsolete", "20260901150000"],
    ["empty", ""],
  ]) await t.test(name, async () => {
    const fake = fixture({ tencent: (batch) => responseText(batch.map((row) => tencentQuote(row, { 30: stamp })).join("\n")) });
    await assert.rejects(loadFixture(fake)(), (error) => error.code === "TENCENT_RESPONSE_INVALID" && error.stage === "quotes");
  });
});

test("complete identities with invalid Sina dates can still recover through valid Tencent quote dates", async () => {
  const fake = fixture({ sina: (batch) => responseText(batch.map((row) => sinaQuote(row).replace("2026-09-30", "2026-10-04")).join("\n")) });
  const result = await loadFixture(fake)();
  assert.equal(result.quoteSource, "tencent");
  assert.equal(result.dataDate, "2026-09-30");
  assert.ok(result.stocks.every((row) => row.quoteSource === "tencent" && row.close === 120));
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 1);
  assert.equal(callsTo(fake, "qt.gtimg.cn").length, 1);
});

test("a remembered Tencent source with invalid dates can recover to Sina instead of blocking refresh", async () => {
  let initial = true;
  const fake = fixture({
    sina: (batch) => initial ? denied() : responseText(batch.map(sinaQuote).join("\n")),
    tencent: (batch) => responseText(batch.map((row) => tencentQuote(row, initial ? {} : { 30: "20261004150000" })).join("\n")),
  });
  const load = loadFixture(fake);
  assert.equal((await load()).quoteSource, "tencent");
  initial = false;
  const recovered = await load();
  assert.equal(recovered.quoteSource, "sina");
  assert.equal(recovered.quoteTime, "2026-09-30T08:30:00.000Z");
  assert.ok(recovered.stocks.every((row) => row.close === 50 && row.quoteSource === "sina"));
});

test("Tencent amount precision is accepted only when embedded price and volume agree with the same quote", async () => {
  const fake = fixture({ tencent: (batch) => responseText(batch.map((row) => tencentQuote(row, {
    35: row.symbol === rows[0].symbol ? "119/234/777777" : "120/233/888888", 37: "12.345",
  })).join("\n")) });
  const result = await loadFixture(fake)();
  assert.ok(result.stocks.every((row) => row.amount === 123450));
});

test("Tencent quote batches stay bounded and all in-flight work settles before failure returns", async () => {
  const stocks = syntheticStocks(801);
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fake = fixture({ stocks, tencent: async (batch) => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return batch[0].symbol === stocks[100].symbol ? { ok: false, status: 503 }
        : responseText(batch.map((row) => tencentQuote(row)).join("\n"));
    } finally { active -= 1; }
  } });
  await assert.rejects(loadFixture(fake)(), (error) => error.code === "TENCENT_HTTP_ERROR" && error.status === 503);
  assert.equal(peak, 6);
  assert.equal(active, 0);
  assert.equal(calls, 7); // One initial probe plus six workers; failed workers never launch the remaining two batches.
  assert.equal(callsTo(fake, "hq.sinajs.cn").length, 1);
});
