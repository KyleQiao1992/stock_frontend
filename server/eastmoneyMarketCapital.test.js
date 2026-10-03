import test from "node:test";
import assert from "node:assert/strict";
import {createEastmoneyMarketCapitalProvider, hasSameDayMarketCapital} from "./eastmoneyMarketCapital.js";

const NOW = Date.parse("2026-10-03T14:00:00Z");
const DAY = "2026-09-30";
const stock = (code = "002432", exchange = "sz", close = 60.39) => ({code, exchange, market: exchange === "sh" ? 1 : 0, close});
const row = (s = stock(), overrides = {}) => ({SECURITY_CODE: s.code, SECUCODE: `${s.code}.${s.exchange.toUpperCase()}`,
  TRADE_DATE: `${DAY} 00:00:00`, CLOSE_PRICE: s.close, TOTAL_MARKET_CAP: 28152855987.3,
  NOTLIMITED_MARKETCAP_A: 26415671449.86, ...overrides});
function fixture(rows, change = (body) => body) {
  const calls = [];
  return {calls, request: async (url, options) => {
    const parsed = new URL(url);calls.push({url: parsed, options});
    const page = Number(parsed.searchParams.get("pageNumber"));
    const body = {success: true, result: {count: rows.length, pages: Math.ceil(rows.length / 1000), data: rows.slice((page - 1) * 1000, page * 1000)}};
    return {ok: true, json: async () => change(body, page)};
  }};
}
const load = (fake) => createEastmoneyMarketCapitalProvider({request: fake.request, now: () => NOW});

test("dated Eastmoney floating capital restores the original f21 rather than Tencent tradable shares", async () => {
  const s = stock();const fake = fixture([row(s)]);
  const result = await load(fake)({date: DAY, stocks: [s]});
  assert.equal(result.capitals[0].floatCap, 26415671449.86);
  assert.equal(result.capitals[0].cap, 28152855987.3);
  assert.equal(result.capitals[0].quoteDate, DAY);
  assert.equal(result.capitalSource, "eastmoney");
  assert.equal(result.capitalDate, DAY);
  assert.deepEqual(result.coverage, {expected: 1, received: 1});
  assert.equal(fake.calls[0].url.searchParams.get("filter"), `(TRADE_DATE='${DAY}')`);
  assert.equal(fake.calls[0].url.searchParams.get("reportName"), "RPT_VALUEANALYSIS_DET");
});

test("Shanghai CDR and Beijing stocks retain their exchange identity and zero remains a real supplied value", async () => {
  const stocks = [stock("689009", "sh", 37.1), stock("920002", "bj", 12)];
  const fake = fixture(stocks.map((s) => row(s, {TOTAL_MARKET_CAP: 0, NOTLIMITED_MARKETCAP_A: 0})));
  const result = await load(fake)({date: DAY, stocks});
  assert.deepEqual(result.capitals.map((s) => s.symbol), ["sh689009", "bj920002"]);
  assert.equal(result.capitals[0].cap, 0);
});

test("all pages are retrieved and extra report identities do not invent additional listed stocks", async () => {
  const stocks = Array.from({length: 1001}, (_, i) => stock(String(600000 + i), "sh", 10));
  const fake = fixture(stocks.map((s) => row(s)));
  const result = await load(fake)({date: DAY, stocks: [stocks[1000], stocks[0]]});
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(result.capitals.map((s) => s.code), ["601000", "600000"]);
  assert.deepEqual(result.coverage, {expected: 2, received: 2});
});

test("missing, duplicate and truncated report membership cannot become a complete capital snapshot", async (t) => {
  for (const [name, rows, stocks, transform] of [
    ["missing symbol", [row()], [stock(), stock("000001")]],
    ["duplicate", [row(), row()], [stock()]],
    ["bad pages", [row()], [stock()], (body) => ({...body, result: {...body.result, pages: 2}})],
    ["short first page", [row()], [stock()], (body) => ({...body, result: {...body.result, data: []}})],
  ]) await t.test(name, async () => {
    await assert.rejects(load(fixture(rows, transform))({date: DAY, stocks}), (e) => e.code === "EM_CAPITAL_COVERAGE_INCOMPLETE");
  });
});

test("wrong-date, wrong-exchange, unknown, negative and infinite values are rejected rather than made zero", async (t) => {
  for (const [name, changes] of [
    ["date", {TRADE_DATE: "2026-09-29 00:00:00"}], ["identity", {SECURITY_CODE: "002433"}],
    ["exchange", {SECUCODE: "002432.BJ"}], ["unknown float", {NOTLIMITED_MARKETCAP_A: null}],
    ["blank total", {TOTAL_MARKET_CAP: ""}], ["negative", {NOTLIMITED_MARKETCAP_A: -1}],
    ["infinite", {TOTAL_MARKET_CAP: "Infinity"}],
  ]) await t.test(name, async () => {
    await assert.rejects(load(fixture([row(stock(), changes)]))({date: DAY, stocks: [stock()]}), (e) => e.code === "EM_CAPITAL_RESPONSE_INVALID");
  });
});

test("dated closing valuations cannot silently substitute for a different intraday quote price", async () => {
  await assert.rejects(load(fixture([row()]))({date: DAY, stocks: [stock("002432", "sz", 61)]}),
    (e) => e.code === "EM_CAPITAL_CLOSE_MISMATCH");
});

test("invalid or future input dates and duplicate stocks fail before requesting any data", async (t) => {
  for (const [date, stocks] of [["2026-02-30", [stock()]], ["2026-10-04", [stock()]], [DAY, [stock(), stock()]]]) {
    await t.test(date, async () => {
      const fake = fixture([row()]);
      await assert.rejects(load(fake)({date, stocks}), (e) => e.code === "EM_CAPITAL_INPUT_INVALID");
      assert.equal(fake.calls.length, 0);
    });
  }
});

test("cache capital provenance must cover the complete universe and actual Shanghai quote day", () => {
  const body = {quoteTime: "2026-09-30T08:15:00Z", capitalSource: "eastmoney", capitalDate: DAY, capitalCoverage: {expected: 2, received: 2}};
  assert.equal(hasSameDayMarketCapital(body, 2), true);
  for (const change of [{capitalSource: "tencent"}, {capitalDate: "2026-09-29"}, {capitalCoverage: {expected: 2, received: 1}}]) {
    assert.equal(hasSameDayMarketCapital({...body, ...change}, 2), false);
  }
});


test("contradictory explicit dates and quote timestamp cannot validate old capital as a current session", () => {
  const body = {dataDate: DAY, date: DAY, quoteTime: "2026-10-02T07:00:00Z", capitalDate: DAY,
    capitalSource: "eastmoney", capitalCoverage: {expected: 1, received: 1}};
  assert.equal(hasSameDayMarketCapital(body, 1), false);
  assert.equal(hasSameDayMarketCapital({...body, quoteTime: "2026-09-30T07:00:00Z", date: "2026-09-29"}, 1), false);
});

test("missing or older individual quotes preserve verified session capital without inventing current prices", async () => {
  const stocks = [stock(), {...stock("000001"), close: null, pct: null, quoteDate: null},
    {...stock("000002"), close: 1, pct: 5, quoteDate: "2026-09-29"}];
  const fake = fixture(stocks.map((s) => row({...s, close: 60.39})));
  const result = await load(fake)({date: DAY, stocks});
  assert.deepEqual(result.coverage, {expected: 3, received: 3});
  assert.equal(result.capitals[1].close, 60.39);
  // An available current-session quote must still match, even in this mixed batch.
  const current = stocks.map((s) => ({...s, quoteDate: DAY}));
  await assert.rejects(load(fake)({date: DAY, stocks: current}), (e) => e.code === "EM_CAPITAL_CLOSE_MISMATCH");
});
