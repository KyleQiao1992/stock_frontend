import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHkCode,
  parseTencentHkPayload,
  parseTencentHkRows,
  loadHkKline,
  parseTencentHkQuote,
  parseTencentHkSearch,
} from "./hkMarket.js";

test("normalizeHkCode accepts common HK code forms", () => {
  assert.equal(normalizeHkCode("700"), "00700");
  assert.equal(normalizeHkCode("hk00700"), "00700");
  assert.equal(normalizeHkCode("0700.HK"), "00700");
  assert.equal(normalizeHkCode("腾讯"), "");
  assert.equal(normalizeHkCode("123456"), "");
});

test('HK rejects invalid OHLC rows instead of silently deleting or coercing them to zero', () => {
  const valid = ["2026-09-17", "426.2", "426", "431", "425", "10"];
  for (const bad of [null, '', ' ', 'bad', '0']) {
    const row = ["2026-09-18", "428", "419", bad, "419", "20"];
    assert.throws(() => parseTencentHkRows([valid, row, valid]), /K 线.*格式异常/);
  }
  assert.throws(() => parseTencentHkRows([valid, ["2026-09-18", "428", "419", "420", "419", "20"]]), /K 线.*格式异常/);
  assert.throws(() => parseTencentHkRows([valid, valid]), /K 线.*格式异常/);
  assert.throws(() => parseTencentHkRows([["2026-02-30", "426", "426", "431", "425", "10"]]), /K 线.*格式异常/);
  assert.throws(() => parseTencentHkRows([["2026-09-18", true, 1, 1, 1, 1]]), /K 线.*格式异常/);
  assert.throws(() => parseTencentHkRows([{ 0: '2026-09-18', 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }]), /K 线.*格式异常/);
});

test('HK rejects unsupported periods instead of silently substituting daily candles', async () => {
  let called = false;
  await assert.rejects(() => loadHkKline({ code: '700', adjust: '0', period: '5' }, async () => {
    called = true; throw new Error('unexpected provider request');
  }), /周期|period/i);
  assert.equal(called, false);
});

test('HK quote metadata treats empty fields as unavailable rather than numeric zero', () => {
  const fields = Array(76).fill('');
  const quote = parseTencentHkQuote(fields, '00700');
  for (const name of ['latestPrice', 'previousClose', 'marketCap', 'floatMarketCap', 'peRatio', 'turnoverRate', 'boardLot', 'totalShares', 'floatShares']) {
    assert.equal(quote[name], null, name);
  }
});

test('HK preserves requested unadjusted and adjusted bases instead of substituting one for another', () => {
  const row = ["2026-09-17", "426.2", "426", "431", "425", "10"];
  const payload = { data: { hk00700: { day: [row] } } };
  assert.equal(parseTencentHkPayload(payload, { code: '700', adjust: '0' }).klines.length, 1);
  assert.throws(() => parseTencentHkPayload(payload, { code: '700', adjust: '1' }), /前复权/);
  assert.throws(() => parseTencentHkPayload(payload, { code: '700', adjust: '2' }), /后复权/);
});

test('HK requests the unadjusted endpoint and rejects unsupported adjustment values', async () => {
  let requested;
  const row = ['2026-09-17', '426.2', '426', '431', '425', '10'];
  const result = await loadHkKline({ code: '700', adjust: '0' }, async url => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ data: { hk00700: { day: [row] } } }) };
  });
  assert.equal(requested.pathname, '/appstock/app/kline/kline');
  assert.equal(requested.searchParams.get('param'), 'hk00700,day,,,600');
  assert.equal(result.klines.length, 1);
  await assert.rejects(() => loadHkKline({ code: '700', adjust: 'bad' }, async () => { throw new Error('must not request'); }), /复权/);
});

test("parseTencentHkQuote uses HK-specific Tencent fields", () => {
  const qt = [];
  qt[1] = "腾讯控股";
  qt[2] = "00700";
  qt[3] = "419.000";
  qt[30] = "2026/09/18 16:08:32";
  qt[39] = "15.31";
  qt[44] = "38108.4103";
  qt[45] = "38108.4103";
  qt[59] = "0.32";
  qt[60] = "100";
  qt[75] = "HKD";
  const quote = parseTencentHkQuote(qt, "00700");
  assert.equal(quote.name, "腾讯控股");
  assert.equal(quote.turnoverRate, 0.32);
  assert.equal(quote.boardLot, 100);
  assert.equal(quote.currency, "HKD");
  assert.equal(quote.marketCap, 3810841030000);
});

test("parseTencentHkPayload returns chart-compatible rows", () => {
  const qt = [];
  qt[1] = "腾讯控股";
  qt[2] = "00700";
  const payload = { data: { hk00700: { qfqday: [
    ["2026-09-17", "426.2", "426", "431", "425", "10"],
    ["2026-09-18", "428", "419", "430.4", "419", "20"],
  ], qt: { hk00700: qt } } } };
  const result = parseTencentHkPayload(payload, { code: "700", period: "101", adjust: "1" });
  assert.equal(result.code, "00700");
  assert.equal(result.klines.length, 2);
  assert.equal(result.klines[1].change, -7);
  assert.ok(Math.abs(result.klines[1].pct + 1.643192488) < 1e-6);
});

test("parseTencentHkSearch keeps HK equities and removes duplicates", () => {
  const encoded = JSON.stringify("hk~00700~腾讯控股~txkg~GP^hk~80700~腾讯控股R~txkgr~GP^hk~13005~权证~qz~QZ^us~TCEHY~腾讯~tx~GP^hk~00700~腾讯控股~txkg~GP");
  assert.deepEqual(parseTencentHkSearch(`v_hint=${encoded}`), [
    { code: "00700", name: "腾讯控股", pinyin: "txkg", market: "港股", type: "GP" },
    { code: "80700", name: "腾讯控股R", pinyin: "txkgr", market: "港股", type: "GP" },
  ]);
});
