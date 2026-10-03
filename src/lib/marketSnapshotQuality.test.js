import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentMarketSnapshot, marketSnapshotSourceLabel, formatMarketSnapshotTime } from "./marketSnapshotQuality.js";

const metadata = { live: true, source: "eastmoney-tencent", partial: true, mode: "snapshot", snapshotSchemaVersion: 3,
  universePolicy: "listed-ashare-with-cdr", classification: "东方财富行业", classificationSource: "eastmoney", industryLevel: 2,
  classificationCoverage: { classified: 3, total: 3, unclassified: 0, conflicts: 0 } };
const heatmap = { ...metadata, totalStocks: 3, industries: [{ name: "银行Ⅱ", count: 1 }, { name: "半导体", count: 2 }] };
const today = { ...metadata, breadth: { total: 2 }, hist: [], quoteCoverage: { quoted: 2, total: 3, unavailable: 1 } };

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
  assert.equal(marketSnapshotSourceLabel(heatmap), "腾讯报价 · 东方财富行业");
  assert.equal(marketSnapshotSourceLabel({ source: "eastmoney-sina" }), "新浪报价 · 东方财富行业");
  assert.equal(marketSnapshotSourceLabel({}), "东方财富");
  assert.match(formatMarketSnapshotTime("2026-09-30T07:00:00Z"), /09\/30.*15:00:00/);
  assert.match(formatMarketSnapshotTime("2026-10-03T13:00:00Z"), /10\/03.*21:00:00/);
  assert.equal(formatMarketSnapshotTime("invalid"), "—");
  assert.equal(formatMarketSnapshotTime(null), "—");
});
