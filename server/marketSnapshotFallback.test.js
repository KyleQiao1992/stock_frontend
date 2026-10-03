import test from "node:test";
import assert from "node:assert/strict";
import {createMarketSnapshotFallbacks} from "./marketSnapshotFallback.js";
import {createMarketHeatmapHandler} from "./marketHeatmap.js";
import {createTodayMarketHandler} from "./todayMarket.js";

const NOW = Date.parse("2026-10-03T04:00:00Z");
function snapshot() {
  return {
    metadata: {source: "sina", dataDate: "2026-09-30", date: "2026-09-30", quoteTime: "2026-09-30T07:00:00Z", updatedAt: new Date(NOW).toISOString(),
      classification: "新浪行业", classificationCoverage: {classified: 2, total: 3, unclassified: 1, conflicts: 0}},
    stocks: [
      {code: "600001", market: 1, name: "测试上涨", quoteDate: "2026-09-30", pct: 5, amount: 2e8, cap: 2e11, floatCap: 1e11, open: 9, close: 10, industry: "制造", mainInflow: null},
      {code: "000001", market: 0, name: "测试旧报价", quoteDate: "2026-09-29", pct: -8, amount: 9e8, cap: 1e11, floatCap: 5e10, open: 11, close: 9, industry: "制造", mainInflow: null},
      {code: "920001", market: 0, exchange: "bj", name: "测试北交所", quoteDate: "2026-09-30", pct: -1, amount: 1e8, cap: 1e10, floatCap: 1e10, open: 10, close: 9, industry: null, mainInflow: null},
    ],
  };
}

test("alternate snapshots share one successful full fetch and retain only current-day measurements", async () => {
  let calls = 0;
  const fallbacks = createMarketSnapshotFallbacks({now: () => NOW, loadSnapshot: async () => { calls += 1; return snapshot(); }});
  const [heatmap, today] = await Promise.all([fallbacks.heatmap(), fallbacks.today()]);
  assert.equal(calls, 1);
  assert.equal(heatmap.payload.totalStocks, 3);
  assert.equal(heatmap.payload.up, 1);
  assert.equal(heatmap.payload.down, 1);
  assert.equal(heatmap.payload.suspended, 1);
  assert.equal(heatmap.payload.industries.find((row) => row.name === "制造").amount, 2);
  assert.equal(heatmap.snapshot.stocks.find((row) => row.code === "000001").pct, null);
  assert.ok(heatmap.payload.industries.some((row) => row.name === "未分类"));
  assert.ok(heatmap.payload.industries.every((row) => row.mainInflow === null && row.stocks.every((stock) => stock.mainInflow === null)));
  assert.equal(today.breadth.total, 2);
  assert.equal(today.date, "2026-09-30");
  assert.equal(today.capTiers.find((row) => row.key === "gt1000").avg, 5);
  for (const field of ["heat", "strong", "consecutive", "premium"]) assert.equal(today[field], null);
  assert.deepEqual(today.history, []);
});

test("failed and old alternate snapshots cannot become a successful reusable cache", async () => {
  let calls = 0;
  const fallbacks = createMarketSnapshotFallbacks({now: () => NOW, loadSnapshot: async () => {
    calls += 1;
    if (calls === 1) throw new Error("provider unavailable");
    const result = snapshot();
    if (calls === 2) result.metadata.quoteTime = "2026-09-01T07:00:00Z";
    return result;
  }});
  await assert.rejects(fallbacks.heatmap());
  await assert.rejects(fallbacks.today());
  assert.equal((await fallbacks.today()).breadth.total, 2);
  assert.equal(calls, 3);
});

test("dashboard quote statistics survive an alternate industry directory failure", async () => {
  const calls = [];
  const fallbacks = createMarketSnapshotFallbacks({now: () => NOW, loadSnapshot: async ({withIndustries}) => {
    calls.push(withIndustries);
    if (withIndustries) throw new Error("industry source unavailable");
    return snapshot();
  }});
  const [heatmap, today] = await Promise.allSettled([fallbacks.heatmap(), fallbacks.today()]);
  assert.equal(heatmap.status, "rejected");
  assert.equal(today.status, "fulfilled");
  assert.equal(today.value.breadth.total, 2);
  assert.deepEqual(calls, [true, false]);
});

test("freshly fetched closing quotes remain dated correctly across a long market holiday", async () => {
  const later = Date.parse("2026-10-08T04:00:00Z");
  const fallbacks = createMarketSnapshotFallbacks({now: () => later, loadSnapshot: async () => {
    const result = snapshot();
    result.metadata.updatedAt = new Date(later).toISOString();
    return result;
  }});
  const handler = createTodayMarketHandler({now: () => later, getRedis: async () => null,
    load: async () => {throw new Error("primary offline");}, loadFallback: fallbacks.today});
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.date, "2026-09-30");
  assert.equal(response.body.quoteTime, "2026-09-30T07:00:00Z");
  assert.equal(response.body.updatedAt, new Date(later).toISOString());
});

async function request(handler, query = "") {
  const response = {statusCode: 200, setHeader() {}, end(body) {this.body = JSON.parse(body);}};
  await handler({url: `/api/test${query}`}, response);
  return response;
}

test("cold outage handlers expose real alternate data without writing it to full Eastmoney caches", async () => {
  const values = new Map();
  const redis = {get: async (key) => values.get(key), set: async (key, value) => values.set(key, value)};
  const fallbacks = createMarketSnapshotFallbacks({now: () => NOW, loadSnapshot: async () => snapshot()});
  const options = {now: () => NOW, getRedis: async () => redis, load: async () => {throw new Error("all Eastmoney hosts down");}};
  const heatmap = createMarketHeatmapHandler({...options, historyHandler: () => false, loadFallback: fallbacks.heatmap});
  const today = createTodayMarketHandler({...options, loadFallback: fallbacks.today});
  const heat = await request(heatmap);
  const dashboard = await request(today);
  assert.equal(heat.statusCode, 200);
  assert.equal(dashboard.statusCode, 200);
  assert.equal(heat.body.source, "sina");
  assert.equal(dashboard.body.partial, true);
  assert.equal(dashboard.body.strong, null);
  assert.equal(values.has("market-heatmap:v1:lastgood"), false);
  assert.equal(values.has("today-market:v1:lastgood"), false);
  assert.equal(values.has("market-heatmap:v2:snapshot"), true);
  assert.equal(values.has("today-market:v2:snapshot"), true);
  const detail = await request(heatmap, "?industry=制造&source=sina");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.stocks.length, 2);
  assert.equal(detail.body.source, "sina");
});
