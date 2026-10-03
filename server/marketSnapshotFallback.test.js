import test from "node:test";
import assert from "node:assert/strict";
import {createMarketSnapshotFallbacks} from "./marketSnapshotFallback.js";
import {createMarketHeatmapHandler} from "./marketHeatmap.js";
import {createTodayMarketHandler} from "./todayMarket.js";

const NOW = Date.parse("2026-10-03T04:00:00Z");
function snapshot({quoteSource = "tencent"} = {}) {
  return {
    metadata: {source: quoteSource === "tencent" ? "sina-tencent" : "sina", quoteSource, dataDate: "2026-09-30", date: "2026-09-30", quoteTime: "2026-09-30T07:00:00Z", updatedAt: new Date(NOW).toISOString(),
      classification: "新浪行业", classificationCoverage: {classified: 2, total: 3, unclassified: 1, conflicts: 0}},
    stocks: [
      {symbol: "sh600001", code: "600001", market: 1, name: "测试上涨", quoteDate: "2026-09-30", pct: 5, amount: 2e8, cap: 2e11, floatCap: 1e11, open: 9, close: 10, industry: "制造", mainInflow: null},
      {symbol: "sz000001", code: "000001", market: 0, name: "测试旧报价", quoteDate: "2026-09-29", pct: -8, amount: 9e8, cap: 1e11, floatCap: 5e10, open: 11, close: 9, industry: "制造", mainInflow: null},
      {symbol: "bj920001", code: "920001", market: 0, exchange: "bj", name: "测试北交所", quoteDate: "2026-09-30", pct: -1, amount: 1e8, cap: 1e10, floatCap: 1e10, open: 10, close: 9, industry: null, mainInflow: null},
    ],
  };
}

function industryMap() {
  return {classificationSource: "eastmoney", classification: "东方财富行业", level: 2,
    classificationUpdatedAt: new Date(NOW).toISOString(), listedCdrs: [],
    members: snapshot().stocks.map((row) => ({symbol: row.symbol, code: row.code, name: row.name,
      industry: row.exchange === "bj" ? "银行Ⅱ" : "半导体", industryCode: row.exchange === "bj" ? "BK0475" : "BK1036"}))};
}

const loadIndustries = async () => industryMap();
const loadCapitals = async ({date, stocks}) => ({capitalSource: "eastmoney", capitalDate: date,
  capitalUpdatedAt: new Date(NOW).toISOString(), coverage: {expected: stocks.length, received: stocks.length},
  capitals: stocks.map((row) => ({symbol: row.symbol || `${row.exchange || (row.market === 1 ? "sh" : "sz")}${row.code}`,
    cap: row.cap, floatCap: row.floatCap, close: row.close, quoteDate: date}))});
function testFallbacks(options) { return createMarketSnapshotFallbacks({loadCapitals, ...options}); }

test("alternate snapshots share one successful full fetch and retain only current-day measurements", async () => {
  let calls = 0;
  let maps = 0;
  const requests = [];
  const fallbacks = testFallbacks({now: () => NOW,
    loadIndustries: async () => { maps += 1; return industryMap(); },
    loadSnapshot: async (options) => { calls += 1; requests.push(options); return snapshot(); }});
  const [heatmap, today] = await Promise.all([fallbacks.heatmap(), fallbacks.today()]);
  assert.equal(calls, 1);
  assert.equal(maps, 1);
  assert.equal(requests[0].withIndustries, false);
  assert.equal(requests[0].quotePreference, "tencent");
  assert.deepEqual(requests[0].supplements, []);
  assert.equal(heatmap.payload.totalStocks, 3);
  assert.equal(heatmap.payload.up, 1);
  assert.equal(heatmap.payload.down, 1);
  assert.equal(heatmap.payload.suspended, 1);
  assert.equal(heatmap.payload.industries.find((row) => row.name === "半导体").amount, 2);
  assert.equal(heatmap.snapshot.stocks.find((row) => row.code === "000001").pct, null);
  assert.deepEqual(heatmap.payload.industries.map((row) => row.name).sort(), ["半导体", "银行Ⅱ"]);
  assert.equal(heatmap.payload.source, "eastmoney-tencent");
  assert.equal(heatmap.payload.snapshotSchemaVersion, 3);
  assert.equal(heatmap.payload.industryLevel, 2);
  assert.equal(heatmap.payload.classificationSource, "eastmoney");
  assert.equal(heatmap.payload.classification, "东方财富行业");
  assert.deepEqual(heatmap.payload.classificationCoverage, {classified: 3, total: 3, unclassified: 0, conflicts: 0});
  assert.equal(today.universePolicy, "listed-ashare-with-cdr");
  assert.ok(heatmap.payload.industries.every((row) => row.mainInflow === null && row.stocks.every((stock) => stock.mainInflow === null)));
  assert.equal(today.breadth.total, 2);
  assert.equal(today.date, "2026-09-30");
  assert.equal(today.capTiers.find((row) => row.key === "gt1000").avg, 5);
  for (const field of ["heat", "strong", "consecutive", "premium"]) assert.equal(today[field], null);
  assert.deepEqual(today.history, []);
});

test("failed and old alternate snapshots cannot become a successful reusable cache", async () => {
  let calls = 0;
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries, loadSnapshot: async () => {
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

test("an unavailable verified Eastmoney map cannot produce a heatmap or an unverified dashboard universe", async () => {
  const calls = [];
  const fallbacks = testFallbacks({now: () => NOW,
    loadIndustries: async () => { throw new Error("verified industry source unavailable"); },
    loadSnapshot: async ({withIndustries}) => {
    calls.push(withIndustries);
    return snapshot();
  }});
  const [heatmap, today] = await Promise.allSettled([fallbacks.heatmap(), fallbacks.today()]);
  assert.equal(heatmap.status, "rejected");
  assert.equal(today.status, "rejected");
  assert.deepEqual(calls, []);
});

test("freshly fetched closing quotes remain dated correctly across a long market holiday", async () => {
  const later = Date.parse("2026-10-08T04:00:00Z");
  const fallbacks = testFallbacks({now: () => later, loadIndustries, loadSnapshot: async () => {
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
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries, loadSnapshot: async () => snapshot()});
  const options = {now: () => NOW, getRedis: async () => redis, load: async () => {throw new Error("all Eastmoney hosts down");}};
  const heatmap = createMarketHeatmapHandler({...options, historyHandler: () => false, loadFallback: fallbacks.heatmap});
  const today = createTodayMarketHandler({...options, loadFallback: fallbacks.today});
  const heat = await request(heatmap);
  const dashboard = await request(today);
  assert.equal(heat.statusCode, 200);
  assert.equal(dashboard.statusCode, 200);
  assert.equal(heat.body.source, "eastmoney-tencent");
  assert.equal(dashboard.body.partial, true);
  assert.equal(dashboard.body.strong, null);
  assert.equal(values.has("market-heatmap:v1:lastgood"), false);
  assert.equal(values.has("today-market:v1:lastgood"), false);
  assert.equal(values.has("market-heatmap:v2:snapshot"), false);
  assert.equal(values.has("today-market:v2:snapshot"), false);
  assert.equal(values.has("market-heatmap:v3:snapshot"), true);
  assert.equal(values.has("today-market:v3:snapshot"), true);
  assert.equal(values.has("market-heatmap:v2:stocks:lastgood"), false);
  assert.equal(values.has("market-heatmap:v3:stocks:lastgood"), true);
  const detail = await request(heatmap, "?industry=半导体&source=eastmoney-tencent");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.stocks.length, 2);
  assert.equal(detail.body.source, "eastmoney-tencent");
});

test("manual refresh bypasses the quote reuse window while concurrent requests share one forced scan", async () => {
  let calls = 0;
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries,
    loadSnapshot: async () => { calls += 1; return snapshot(); }});
  await fallbacks.heatmap();
  await fallbacks.today();
  assert.equal(calls, 1);
  await fallbacks.heatmap({force: true});
  await fallbacks.today();
  assert.equal(calls, 2);
  await Promise.all([fallbacks.heatmap({force: true}), fallbacks.today({force: true})]);
  assert.equal(calls, 3);
});

test("a missing ownership or duplicate industry identity cannot become reusable quote data", async () => {
  for (const failure of ["missing", "duplicate"]) {
    let calls = 0;
    const fallbacks = testFallbacks({now: () => NOW,
      loadIndustries: async () => {
        calls += 1;
        const result = industryMap();
        if (calls === 1) {
          if (failure === "missing") result.members.pop();
          else result.members.push({...result.members[0]});
        }
        return result;
      }, loadSnapshot: async () => snapshot()});
    await assert.rejects(fallbacks.heatmap(), failure);
    const recovered = await fallbacks.heatmap();
    assert.equal(recovered.payload.totalStocks, 3);
    assert.equal(recovered.payload.classificationCoverage.classified, 3);
    assert.equal(calls, 2);
  }
});

test("confirmed listed CDRs are supplemented and classified under the same original industry taxonomy", async () => {
  const cdr = {symbol: "sh689009", code: "689009", name: "上市CDR样本", listingDate: "2020-10-01"};
  let options;
  const fallbacks = testFallbacks({now: () => NOW,
    loadIndustries: async () => {
      const result = industryMap();
      result.listedCdrs = [cdr];
      result.members.push({...cdr, industry: "半导体", industryCode: "BK1036"});
      return result;
    },
    loadSnapshot: async (request) => {
      options = request;
      const result = snapshot();
      result.stocks.push({...cdr, market: 1, quoteDate: "2026-09-30", pct: 2, amount: 1e8,
        cap: 1e11, floatCap: 8e10, open: 10, close: 10.2, mainInflow: null});
      return result;
    }});
  const result = await fallbacks.heatmap();
  assert.deepEqual(options.supplements, [cdr]);
  assert.equal(options.withIndustries, false);
  assert.equal(result.payload.totalStocks, 4);
  assert.deepEqual(result.payload.classificationCoverage, {classified: 4, total: 4, unclassified: 0, conflicts: 0});
  assert.equal(result.snapshot.stocks.find((row) => row.code === cdr.code).industry, "半导体");
});

test("Sina quote fallback retains the same Eastmoney taxonomy rather than its own industry groups", async () => {
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries,
    loadSnapshot: async () => snapshot({quoteSource: "sina"})});
  const heatmap = await fallbacks.heatmap();
  const today = await fallbacks.today();
  assert.equal(heatmap.payload.source, "eastmoney-sina");
  assert.equal(today.source, "eastmoney-sina");
  assert.deepEqual(heatmap.payload.industries.map((row) => row.name).sort(), ["半导体", "银行Ⅱ"]);
  assert.equal(heatmap.payload.classificationSource, "eastmoney");
});


test("misdated, incomplete or differently priced capital cannot become a reusable heatmap", async (t) => {
  for (const [name, change] of [
    ["different provider", (v) => {v.capitalSource = "tencent";}],
    ["different session", (v) => {v.capitalDate = "2026-09-29";}],
    ["incomplete coverage", (v) => {v.coverage.received -= 1;}],
    ["price differs", (v) => {v.capitals[0].close += 1;}],
    ["duplicate capital identity", (v) => {v.capitals[1].symbol = v.capitals[0].symbol;}],
  ]) await t.test(name, async () => {
    let calls = 0;
    const fallbacks = testFallbacks({now: () => NOW, loadIndustries, loadSnapshot: async () => snapshot(),
      loadCapitals: async (options) => {calls += 1; const result = await loadCapitals(options); if(calls === 1) change(result); return result;}});
    await assert.rejects(fallbacks.heatmap(), (e) => e.code === "FALLBACK_SNAPSHOT_INVALID");
    assert.equal((await fallbacks.heatmap()).payload.capitalSource, "eastmoney");
    assert.equal(calls, 2);
  });
});

test("industry colors use verified Eastern float capital rather than alternate share weights", async () => {
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries,
    loadSnapshot: async () => {const s = snapshot();s.stocks[1].quoteDate = "2026-09-30";return s;},
    loadCapitals: async (options) => {const v = await loadCapitals(options);v.capitals[0].floatCap = 1e8;v.capitals[1].floatCap = 1e8;return v;}});
  const result = await fallbacks.heatmap();
  assert.equal(result.payload.industries.find((g) => g.name === "半导体").pct, -1.5);
  assert.equal(result.payload.capitalSource, "eastmoney");
});


test("one missing quote and one older quote cannot block a verified-capital snapshot or inflate breadth", async () => {
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries,
    loadSnapshot: async () => {const result = snapshot();Object.assign(result.stocks[2], {close: null, open: null, pct: null, quoteDate: null, amount: null});return result;},
    loadCapitals: async (options) => {const result = await loadCapitals(options);result.capitals[1].close = 20;result.capitals[2].close = 30;return result;}});
  const heatmap = await fallbacks.heatmap();
  const today = await fallbacks.today();
  assert.equal(heatmap.payload.totalStocks, 3);
  assert.deepEqual(heatmap.payload.quoteCoverage, {quoted: 1, total: 3, unavailable: 2});
  assert.equal(today.breadth.total, 1);
  assert.equal(today.breadth.up, 1);
  assert.equal(today.breadth.down, 0);
  for (const s of heatmap.snapshot.stocks.filter((s) => s.quoteDate !== "2026-09-30")) {
    assert.equal(s.pct, null);assert.equal(s.amount, null);assert.equal(s.close, null);
    assert.ok(s.cap > 0 && s.floatCap > 0);
  }
});

test("snapshot metadata cannot redirect actual quotations to a different valuation session", async () => {
  let capitalCalls = 0;
  const fallbacks = testFallbacks({now: () => NOW, loadIndustries,
    loadSnapshot: async () => {const result = snapshot();result.metadata.quoteTime = "2026-10-02T07:00:00Z";return result;},
    loadCapitals: async (options) => {capitalCalls += 1;return loadCapitals(options);}});
  await assert.rejects(fallbacks.heatmap(), (e) => e.code === "FALLBACK_SNAPSHOT_INVALID");
  assert.equal(capitalCalls, 0);
});
