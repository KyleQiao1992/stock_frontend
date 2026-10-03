import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentMarketSnapshot, marketSnapshotSourceLabel, formatMarketSnapshotTime } from "./marketSnapshotQuality.js";

const metadata = { live: true, source: "eastmoney-tencent", partial: true, mode: "snapshot", snapshotSchemaVersion: 3,
  universePolicy: "listed-ashare-with-cdr", classification: "东方财富行业", classificationSource: "eastmoney", industryLevel: 2,
  dataDate: "2026-09-30", capitalDate: "2026-09-30", capitalSource: "eastmoney", capitalCoverage: { expected: 3, received: 3 },
  classificationCoverage: { classified: 3, total: 3, unclassified: 0, conflicts: 0 } };
const heatmap = { ...metadata, totalStocks: 3, up: 2, down: 0, flat: 0, suspended: 1,
  quoteCoverage: { quoted: 2, total: 3, unavailable: 1 },
  industries: [{ name: "银行Ⅱ", count: 1, stocks: [] }, { name: "半导体", count: 2, stocks: [] }] };
const today = { ...metadata, date: "2026-09-30", breadth: { total: 2, up: 1, down: 1, flat: 0 },
  yangYin: {yang: 1, yin: 1}, hist: [], capTiers: [], history: [], quoteCoverage: { quoted: 2, total: 3, unavailable: 1 } };

test("old alternate sources are refused in both browser cache paths", () => {
  for (const source of ["sina", "sina-tencent"]) {
    assert.equal(isCurrentMarketSnapshot({ ...heatmap, source }, "heatmap"), false);
    assert.equal(isCurrentMarketSnapshot({ ...today, source }, "today"), false);
  }
});

test("complete migrated alternate snapshots are accepted with either quotation provider", () => {
  for (const source of ["eastmoney-tencent", "eastmoney-sina"]) {
    assert.equal(isCurrentMarketSnapshot({ ...heatmap, source }, "heatmap"), true);
    assert.equal(isCurrentMarketSnapshot({ ...today, source }, "today"), true);
  }
  // A flagged quote/classification cache can still be rendered with a truthful warning.
  assert.equal(isCurrentMarketSnapshot({ ...heatmap, stale: true, classificationStale: true }, "heatmap"), true);
});

test("schema, universe and classification corruption cannot survive a session cache migration", () => {
  for (const bad of [{ snapshotSchemaVersion: 2 }, { universePolicy: "all-static-industry-members" },
    { classificationSource: "sina" }, { classification: "新浪行业" }, { industryLevel: 3 },
    { classificationCoverage: { classified: 2, total: 3, unclassified: 1, conflicts: 0 } },
    { classificationCoverage: { classified: 3, total: 3, unclassified: 0, conflicts: 1 } }]) {
    assert.equal(isCurrentMarketSnapshot({ ...heatmap, ...bad }, "heatmap"), false);
    assert.equal(isCurrentMarketSnapshot({ ...today, ...bad }, "today"), false);
  }
  assert.equal(isCurrentMarketSnapshot({ ...heatmap, industries: [{ name: "未分类", count: 3 }] }, "heatmap"), false);
  assert.equal(isCurrentMarketSnapshot({ ...heatmap, industries: [{ name: "银行Ⅱ", count: 2 }] }, "heatmap"), false);
  assert.equal(isCurrentMarketSnapshot({ ...today, quoteCoverage: { quoted: 2, total: 2, unavailable: 0 } }, "today"), false);
});

test("primary Eastmoney snapshots and its empty market-closed response retain their existing contract", () => {
  assert.equal(isCurrentMarketSnapshot({ live: true, totalStocks: 3, industries: [{ name: "银行Ⅱ", count: 3 }] }, "heatmap"), true);
  assert.equal(isCurrentMarketSnapshot({ live: true, breadth: { total: 3 }, hist: [] }, "today"), true);
  assert.equal(isCurrentMarketSnapshot({ live: false, marketClosed: true, history: [] }, "today"), true);
  assert.equal(isCurrentMarketSnapshot({ live: true, totalStocks: 3, industries: [], source: "unknown" }, "heatmap"), false);
});

test("source labels identify unchanged industry ownership and timestamps do not substitute quote/fetch times", () => {
  assert.equal(marketSnapshotSourceLabel(heatmap), "腾讯报价 · 东财行业与市值");
  assert.equal(marketSnapshotSourceLabel({ source: "eastmoney-sina" }), "新浪报价 · 东财行业与市值");
  assert.equal(marketSnapshotSourceLabel({}), "东方财富");
  assert.match(formatMarketSnapshotTime("2026-09-30T07:00:00Z"), /09\/30.*15:00:00/);
  assert.match(formatMarketSnapshotTime("2026-10-03T13:00:00Z"), /10\/03.*21:00:00/);
  assert.equal(formatMarketSnapshotTime("invalid"), "—");
  assert.equal(formatMarketSnapshotTime(null), "—");
});

test("alternate source weights require complete original Eastmoney capital coverage from the quote session", () => {
  for (const bad of [
    { capitalSource: "tencent" }, { capitalSource: undefined }, { capitalDate: "2026-09-29" },
    { capitalCoverage: undefined }, { capitalCoverage: { expected: 2, received: 2 } },
    { capitalCoverage: { expected: 3, received: 2 } }, { dataDate: "2026-02-30", capitalDate: "2026-02-30" },
  ]) {
    assert.equal(isCurrentMarketSnapshot({ ...heatmap, ...bad }, "heatmap"), false);
    assert.equal(isCurrentMarketSnapshot({ ...today, ...bad }, "today"), false);
  }
});

test("capital session comparison can use dataDate, date or actual quoteTime with Shanghai day rollover", () => {
  for (const payload of [
    heatmap,
    { ...heatmap, dataDate: undefined, date: "2026-09-30" },
    { ...heatmap, dataDate: undefined, quoteTime: "2026-09-29T17:00:00Z" },
  ]) assert.equal(isCurrentMarketSnapshot(payload, "heatmap"), true);
  assert.equal(isCurrentMarketSnapshot({ ...heatmap, dataDate: undefined, quoteTime: "2026-09-29T07:00:00Z" }, "heatmap"), false);
  assert.equal(isCurrentMarketSnapshot({ ...heatmap, dataDate: undefined, quoteTime: "invalid" }, "heatmap"), false);
});


test("inconsistent quote dates and missing alternate markers cannot bypass browser cache checks", () => {
  for (const bad of [{quoteTime: "2026-10-02T07:00:00Z"}, {date: "2026-09-29"}, {mode: undefined}, {partial: undefined}]) {
    assert.equal(isCurrentMarketSnapshot({...heatmap, ...bad}, "heatmap"), false);
    assert.equal(isCurrentMarketSnapshot({...today, ...bad}, "today"), false);
  }
});

test("inconsistent breadth and malformed alternate browser panels cannot reach rendering", () => {
  for (const bad of [{quoteCoverage: undefined}, {quoteCoverage: {total: 2, quoted: 2, unavailable: 0}},
    {quoteCoverage: {total: 3, quoted: 1, unavailable: 2}}, {up: 0},
    {industries: [null]}, {industries: [{name: "半导体", count: 3, stocks: [null]}]},
    {industries: [{name: "半导体", count: 3, stocks: [{code: "600001", name: "测试", pct: "invalid"}]}]}]) {
    assert.equal(isCurrentMarketSnapshot({...heatmap, ...bad}, "heatmap"), false);
  }
  for (const bad of [{yangYin: undefined}, {hist: [null]}, {history: [null]}, {capTiers: [null]},
    {breadth: {total: 2, up: 0, down: 0, flat: 0}}, {premium: {count: 1, avg: 1, dist: [null]}}]) {
    assert.equal(isCurrentMarketSnapshot({...today, ...bad}, "today"), false);
  }
});
