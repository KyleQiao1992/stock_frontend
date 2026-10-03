import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, createMarketHeatmapHandler } from "./marketHeatmap.js";
import { buildSnapshotPanels, createTodayMarketHandler } from "./todayMarket.js";

const START = Date.parse("2026-10-03T02:00:00Z");
const QUOTE = "2026-09-30T07:00:00Z";
const GOOD_SOURCE = "eastmoney-tencent";

function store(clock) {
  const values = new Map();
  const reads = [];
  const writes = [];
  return {
    reads, writes,
    async get(key) {
      reads.push(key);
      const value = values.get(key);
      return value && value.expires > clock.ms ? value.body : null;
    },
    async set(key, body, {EX = 7 * 86400} = {}) {
      writes.push({key, body, EX});
      values.set(key, {body, expires: clock.ms + EX * 1000});
    },
  };
}

function stocks() {
  return [1, 2, 3].map((index) => ({code: String(600000 + index), name: `测试${index}`, market: 1,
    industry: index === 3 ? "银行Ⅱ" : "半导体", pct: index === 2 ? -1 : 1, open: 10,
    close: index === 2 ? 9.9 : 10.1, cap: 2e8, floatCap: 1e8, amount: 1e6, mainInflow: null}));
}

function heatmap(at = START) {
  const industries = aggregate(stocks());
  industries[0].stocks = industries[0].stocks.slice(0, 1);
  return {live: true, scope: "ashare", totalStocks: 3, up: 2, down: 1, flat: 0,
    industries, quoteTime: QUOTE, updatedAt: new Date(at).toISOString()};
}

function today(at = START) {
  const rows = stocks().map((row) => ({...row, mktcap: row.cap}));
  return {live: true, date: "2026-09-30", quoteTime: QUOTE, history: [], updatedAt: new Date(at).toISOString(),
    ...buildSnapshotPanels(rows, {tc: 0, pool: []}, 0, 0, null, new Map(rows.map((row) => [row.code, row])))};
}

function alternate(body) {
  return {...body, source: GOOD_SOURCE, mode: "snapshot", partial: true,
    snapshotSchemaVersion: 3, universePolicy: "listed-ashare-with-cdr",
    classificationSource: "eastmoney", industryLevel: 2, classification: "东方财富行业",
    classificationCoverage: {classified: 3, total: 3, unclassified: 0, conflicts: 0}};
}

async function request(handler, query = "") {
  const response = {statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); }};
  await handler({url: `/?${query}`, method: "GET"}, response);
  return response;
}

const outage = async () => { throw new Error("test upstream unavailable"); };
const kinds = [
  {name: "heatmap", key: "market-heatmap", create: createMarketHeatmapHandler, payload: heatmap},
  {name: "today", key: "today-market", create: createTodayMarketHandler, payload: today},
];

for (const kind of kinds) {
  test(`${kind.name} ignores newer v2 fallback data and populates only qualified v3`, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const old = {...alternate(kind.payload()), source: "sina-tencent", snapshotSchemaVersion: 2,
      quoteTime: "2026-10-02T08:00:00Z"};
    await redis.set(`${kind.key}:v2:snapshot`, JSON.stringify(old));
    const expected = alternate(kind.payload());
    let calls = 0;
    const handler = kind.create({now: () => clock.ms, getRedis: async () => redis, load: outage,
      loadFallback: async () => { calls += 1; return expected; }});
    const cold = await request(handler);
    assert.equal(cold.statusCode, 200);
    assert.equal(cold.body.source, GOOD_SOURCE);
    assert.equal(cold.body.quoteTime, QUOTE);
    assert.equal(cold.body.stale, undefined);
    assert.equal(calls, 1);
    assert.equal(redis.reads.includes(`${kind.key}:v2:snapshot`), false);
    assert.deepEqual(JSON.parse(await redis.get(`${kind.key}:v2:snapshot`)), old);
    assert.deepEqual(JSON.parse(await redis.get(`${kind.key}:v3:snapshot`)), expected);
    assert.equal(await redis.get(`${kind.key}:v1:lastgood`), null);

    const restarted = kind.create({now: () => clock.ms, getRedis: async () => redis,
      load: async () => { throw new Error("fresh v3 should avoid primary request"); },
      loadFallback: async () => { throw new Error("fresh v3 should avoid alternate request"); }});
    const warm = await request(restarted);
    assert.equal(warm.statusCode, 200);
    assert.deepEqual(warm.body, expected);
  });

  test(`${kind.name} rejects legacy sources even if placed into v3 with schema markers`, async () => {
    for (const source of ["sina", "sina-tencent"]) {
      const clock = {ms: START};
      const redis = store(clock);
      const invalid = {...alternate(kind.payload()), source};
      await redis.set(`${kind.key}:v3:snapshot`, JSON.stringify(invalid));
      const handler = kind.create({now: () => clock.ms, getRedis: async () => redis,
        load: outage, loadFallback: async () => invalid});
      const response = await request(handler);
      assert.equal(response.statusCode, 502, source);
      assert.equal(redis.writes.length, 1);
    }
  });
}

test("heatmap rejects unknown industry, incomplete coverage and different classification semantics in v3", async (t) => {
  const changes = [
    ["schema", (body) => { body.snapshotSchemaVersion = 2; }],
    ["classification source", (body) => { body.classificationSource = "sina"; }],
    ["industry level", (body) => { body.industryLevel = 1; }],
    ["classification name", (body) => { body.classification = "新浪行业"; }],
    ["coverage missing", (body) => { delete body.classificationCoverage; }],
    ["coverage total", (body) => { body.classificationCoverage.total = 2; }],
    ["classified count", (body) => { body.classificationCoverage.classified = 2; }],
    ["unclassified count", (body) => { body.classificationCoverage.unclassified = 1; }],
    ["conflicts", (body) => { body.classificationCoverage.conflicts = 1; }],
    ...["未分类", "其他", "-", "   "].map((name) => [name, (body) => { body.industries[0].name = name; }]),
    ["group count mismatch", (body) => { body.industries[0].count -= 1; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const invalid = alternate(heatmap());
    change(invalid);
    await redis.set("market-heatmap:v3:snapshot", JSON.stringify(invalid));
    const handler = createMarketHeatmapHandler({now: () => clock.ms, getRedis: async () => redis,
      load: outage, loadFallback: async () => invalid});
    const response = await request(handler);
    assert.equal(response.statusCode, 502);
    assert.equal(redis.writes.length, 1);
  });
});

test("today snapshot requires schema 3 and the agreed listed-A-share universe", async (t) => {
  for (const [name, change] of [
    ["schema", (body) => { body.snapshotSchemaVersion = 2; }],
    ["policy missing", (body) => { delete body.universePolicy; }],
    ["policy different", (body) => { body.universePolicy = "sina-hs-a"; }],
  ]) await t.test(name, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const invalid = alternate(today());
    change(invalid);
    await redis.set("today-market:v3:snapshot", JSON.stringify(invalid));
    const handler = createTodayMarketHandler({now: () => clock.ms, getRedis: async () => redis,
      load: outage, loadFallback: async () => invalid});
    assert.equal((await request(handler)).statusCode, 502);
    assert.equal(redis.writes.length, 1);
  });
});

test("qualified v3 heatmap cannot overwrite primary raw members and each source reads its own key", async () => {
  const clock = {ms: START};
  const redis = store(clock);
  const primary = heatmap();
  let recovered = true;
  const handler = createMarketHeatmapHandler({now: () => clock.ms, getRedis: async () => redis,
    load: async () => {
      if (!recovered) throw new Error("test primary down");
      return {payload: primary, snapshot: {stocks: stocks(), at: clock.ms}};
    },
    loadFallback: async () => ({payload: alternate(heatmap(clock.ms)), snapshot: {stocks: stocks(), at: clock.ms}})});
  assert.equal((await request(handler, "retry=1")).statusCode, 200);
  const primaryRaw = await redis.get("market-heatmap:v2:stocks:lastgood");
  assert.equal(JSON.parse(primaryRaw).source, "eastmoney");
  clock.ms += 60001;
  recovered = false;
  const fallback = await request(handler, "retry=1");
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.body.source, GOOD_SOURCE);
  assert.equal(await redis.get("market-heatmap:v2:stocks:lastgood"), primaryRaw);
  assert.equal(JSON.parse(await redis.get("market-heatmap:v3:stocks:lastgood")).source, GOOD_SOURCE);

  const restarted = createMarketHeatmapHandler({now: () => clock.ms, getRedis: async () => redis, load: outage});
  redis.reads.length = 0;
  const backupDetail = await request(restarted, `industry=${encodeURIComponent("半导体")}&source=${GOOD_SOURCE}`);
  assert.equal(backupDetail.statusCode, 200);
  assert.equal(backupDetail.body.partial, false);
  assert.equal(backupDetail.body.source, GOOD_SOURCE);
  assert.equal(backupDetail.body.count, 2);
  assert.equal(redis.reads.includes("market-heatmap:v3:stocks:lastgood"), true);
  assert.equal(redis.reads.includes("market-heatmap:v2:stocks:lastgood"), false);

  redis.reads.length = 0;
  const primaryDetail = await request(restarted, `industry=${encodeURIComponent("半导体")}&source=eastmoney`);
  assert.equal(primaryDetail.statusCode, 200);
  assert.equal(primaryDetail.body.partial, false);
  assert.equal(primaryDetail.body.source, "eastmoney");
  assert.equal(primaryDetail.body.count, 2);
  assert.equal(redis.reads.includes("market-heatmap:v2:stocks:lastgood"), true);
  assert.equal(redis.reads.includes("market-heatmap:v3:stocks:lastgood"), false);
});

test("invalid newer v3 cannot displace a valid complete primary cache", async () => {
  const clock = {ms: START};
  const redis = store(clock);
  const primary = heatmap(START - 3600000);
  await redis.set("market-heatmap:v1:lastgood", JSON.stringify(primary));
  const invalid = {...alternate(heatmap()), quoteTime: "2026-10-02T08:00:00Z"};
  invalid.industries[0].name = "未分类";
  await redis.set("market-heatmap:v3:snapshot", JSON.stringify(invalid));
  const handler = createMarketHeatmapHandler({now: () => clock.ms, getRedis: async () => redis,
    load: outage, loadFallback: async () => invalid});
  const response = await request(handler, "retry=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.source, undefined);
  assert.equal(response.body.quoteTime, primary.quoteTime);
  assert.equal(response.body.updatedAt, primary.updatedAt);
  assert.equal(response.body.stale, true);
  assert.equal(response.body.industries[0].name, "半导体");
});

test("snapshot refresh forwards manual retry intent to the alternate provider", async () => {
  for (const kind of kinds) {
    const clock = {ms: START};
    const redis = store(clock);
    const requests = [];
    const handler = kind.create({now: () => clock.ms, getRedis: async () => redis,
      load: outage, loadFallback: async (options) => {
        requests.push(options);
        return alternate(kind.payload(clock.ms));
      }});
    assert.equal((await request(handler)).statusCode, 200);
    assert.equal((await request(handler, "retry=1")).statusCode, 200);
    assert.deepEqual(requests, [{force: false}, {force: true}], kind.name);
  }
});
