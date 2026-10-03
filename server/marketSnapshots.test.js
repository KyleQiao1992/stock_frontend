import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, createMarketHeatmapHandler, fetchAllStocks } from "./marketHeatmap.js";
import { buildHistory, buildSnapshotPanels, createTodayMarketHandler, fetchAllStocksSnapshot } from "./todayMarket.js";

const START = Date.parse("2026-10-03T02:00:00Z");
const QUOTE_TIME = "2026-09-30T07:00:00Z";
const DAY_MS = 86400000;

function store(clock) {
  const values = new Map();
  const writes = [];
  return {
    writes, values,
    async get(key) {
      const value = values.get(key);
      return value && value.expires > clock.ms ? value.body : null;
    },
    async set(key, body, {EX = 86400} = {}) {
      writes.push({key, body, EX});
      values.set(key, {body, expires: clock.ms + EX * 1000});
    },
  };
}

function stock(index = 1) {
  return {code: String(600000 + index), name: `测试${index}`, industry: "测试行业", market: 1,
    pct: index % 2 ? 1 : -1, cap: 2e8, floatCap: 1e8, amount: 1e6, mainInflow: null, quoteAt: Date.parse(QUOTE_TIME) / 1000};
}

function heatmap(at = START) {
  const stocks = [stock(1), stock(2), stock(3)];
  const industries = aggregate(stocks);
  // Public heatmap lists can be cropped while count remains the actual industry total.
  industries[0].stocks = industries[0].stocks.slice(0, 1);
  return {live: true, scope: "ashare", totalStocks: 3, up: 2, down: 1, flat: 0,
    industries, quoteTime: QUOTE_TIME, updatedAt: new Date(at).toISOString()};
}

function today(at = START) {
  const stocks = [{...stock(1), open: 10, close: 11, mktcap: 2e8}, {...stock(2), open: 11, close: 10, mktcap: 2e8}];
  return {live: true, date: "2026-09-30", quoteTime: QUOTE_TIME, history: [], updatedAt: new Date(at).toISOString(),
    ...buildSnapshotPanels(stocks, {tc: 0, pool: []}, 0, 0, null, new Map(stocks.map((row) => [row.code, row])))};
}

async function request(handler, query = "") {
  const response = {statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = JSON.parse(body); }};
  await handler({url: `/?${query}`, method: "GET"}, response);
  return response;
}

const kinds = [
  {name: "heatmap", key: "market-heatmap:v1", create: createMarketHeatmapHandler, payload: heatmap},
  {name: "today-market", key: "today-market:v1", create: createTodayMarketHandler, payload: today},
];

for (const kind of kinds) {
  test(`${kind.name} restart can immediately serve last-good while the upstream is still pending`, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const original = kind.payload(START - 3600000);
    await redis.set(`${kind.key}:lastgood`, JSON.stringify(original), {EX: 7 * 86400});
    let release;
    let calls = 0;
    let fallbackCalls = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const handler = kind.create({getRedis: async () => redis, now: () => clock.ms,
      load: async () => { calls += 1; await pending; throw new Error("network outage"); },
      loadFallback: async () => { fallbackCalls += 1; return kind.payload(clock.ms); }});
    const response = await request(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.stale, true);
    assert.equal(response.body.staleReason, "cache-expired");
    assert.equal(response.body.updatedAt, original.updatedAt);
    assert.equal(response.body.quoteTime, original.quoteTime);
    assert.equal(calls, 1);
    release();
    const retry = await request(handler, "retry=1");
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.staleReason, "upstream-error");
    assert.equal(retry.body.marketClosed, undefined);
    assert.equal(fallbackCalls, 0);
    assert.equal(redis.writes.length, 1);
  });

  test(`${kind.name} outage without real caches is a friendly failure without raw URLs`, async () => {
    const handler = kind.create({getRedis: async () => { throw new Error("cache unavailable"); }, now: () => START,
      load: async () => { throw new Error("https://upstream.example.invalid: fetch failed"); }});
    const response = await request(handler, "retry=1");
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.marketClosed, undefined);
    assert.equal(JSON.stringify(response.body).includes("upstream.example.invalid"), false);
    assert.equal(response.body.details, undefined);
  });

  test(`${kind.name} closed source replays real cache while preserving original timestamps`, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const original = kind.payload();
    await redis.set(`${kind.key}:lastgood`, JSON.stringify(original));
    const handler = kind.create({getRedis: async () => redis, now: () => clock.ms, load: async () => ({live: false})});
    const response = await request(handler, "retry=1");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.staleReason, "market-closed");
    assert.equal(response.body.marketClosed, true);
    assert.equal(response.body.updatedAt, original.updatedAt);
  });

  test(`${kind.name} rejects malformed, future and over-age cache data`, async () => {
    for (const modify of [
      () => "broken-json",
      (body) => JSON.stringify({...body, updatedAt: new Date(START + 1).toISOString()}),
      (body) => JSON.stringify({...body, updatedAt: new Date(START - 7 * DAY_MS).toISOString()}),
      (body) => JSON.stringify({...body, quoteTime: new Date(START - 14 * DAY_MS).toISOString()}),
      (body) => JSON.stringify({...body, quoteTime: new Date(START + 1).toISOString()}),
      (body) => JSON.stringify({...body, date: "2026-10-04"}),
      (body) => JSON.stringify({...body, dataDate: "2026-09-18"}),
      (body) => JSON.stringify({...body, live: false}),
    ]) {
      const clock = {ms: START};
      const redis = store(clock);
      await redis.set(`${kind.key}:lastgood`, modify(kind.payload()));
      const handler = kind.create({getRedis: async () => redis, now: () => clock.ms, load: async () => { throw new Error("network outage"); }});
      const response = await request(handler, "retry=1");
      assert.equal(response.statusCode, 502);
    }
  });

  test(`${kind.name} cached partial fallback is isolated from the complete legacy caches`, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    const backup = {...kind.payload(), mode: "snapshot", partial: true, source: "sina", classification: "新浪行业", coverage: {classified: 2}};
    if (kind.name === "today-market") Object.assign(backup, {strong: null, heat: null, consecutive: null, premium: null});
    const handler = kind.create({getRedis: async () => redis, now: () => clock.ms,
      load: async () => { throw new Error("network outage"); }, loadFallback: async () => backup});
    const response = await request(handler, "retry=1");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.partial, true);
    assert.equal(response.body.source, "sina");
    assert.equal(response.body.classification, "新浪行业");
    assert.deepEqual(response.body.coverage, backup.coverage);
    assert.equal(await redis.get(kind.key), null);
    assert.equal(await redis.get(`${kind.key}:lastgood`), null);
    assert.ok(await redis.get(`${kind.key.replace(":v1", "")}:v2:snapshot`));
  });

  test(`${kind.name} retry bypasses fresh data and same-query requests reuse pending work`, async () => {
    const clock = {ms: START};
    const redis = store(clock);
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const handler = kind.create({getRedis: async () => redis, now: () => clock.ms, load: async () => {
      calls += 1;
      if (calls > 1) await pending;
      return kind.payload(clock.ms);
    }});
    await request(handler);
    await request(handler);
    assert.equal(calls, 1);
    const first = request(handler, "retry=1");
    const second = request(handler, "retry=1");
    release();
    const responses = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(responses[0].statusCode, 200);
    assert.deepEqual(responses[0].body, responses[1].body);
  });

  test(`${kind.name} failure cooldown prevents repeated source scans, explicit retry still works`, async () => {
    let calls = 0;
    const clock = {ms: START};
    const redis = store(clock);
    const handler = kind.create({getRedis: async () => redis, now: () => clock.ms,
      load: async () => { calls += 1; throw new Error("network outage"); }});
    await request(handler);
    await request(handler);
    assert.equal(calls, 1);
    await request(handler, "retry=1");
    assert.equal(calls, 2);
    clock.ms += 30001;
    await request(handler);
    assert.equal(calls, 3);
  });

  test(`${kind.name} Redis read and write failures preserve validated process memory`, async () => {
    const clock = {ms: START};
    let calls = 0;
    const brokenRedis = {get() {throw new Error("disconnected");}, set() {throw new Error("disconnected");}};
    const handler = kind.create({getRedis: async () => brokenRedis, now: () => clock.ms, load: async () => {
      calls += 1;
      if (calls > 1) throw new Error("network outage");
      return kind.payload(clock.ms);
    }});
    const first = await request(handler);
    assert.equal(first.statusCode, 200);
    const fresh = await request(handler);
    assert.equal(fresh.statusCode, 200);
    assert.equal(calls, 1);
    clock.ms += 3600000;
    const stale = await request(handler, "retry=1");
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body.staleReason, "upstream-error");
    assert.equal(stale.body.updatedAt, first.body.updatedAt);
    assert.equal(stale.body.quoteTime, first.body.quoteTime);
  });
}

test("heatmap industry fallback declares cropped members and never invents a complete count", async () => {
  const clock = {ms: START};
  const redis = store(clock);
  const original = heatmap();
  await redis.set("market-heatmap:v1:lastgood", JSON.stringify(original));
  const handler = createMarketHeatmapHandler({getRedis: async () => redis, now: () => clock.ms,
    load: async () => { throw new Error("network outage"); }});
  const response = await request(handler, "industry=测试行业&source=eastmoney&retry=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.partial, true);
  assert.equal(response.body.returnedCount, 1);
  assert.equal(response.body.totalCount, 3);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.stocks[0].mainInflow, null);
  assert.equal(response.body.quoteTime, original.quoteTime);
});

test("heatmap restart restores full same-source industry members from its private snapshot key", async () => {
  const clock = {ms: START};
  const redis = store(clock);
  const payload = heatmap();
  const first = createMarketHeatmapHandler({getRedis: async () => redis, now: () => clock.ms,
    load: async () => ({payload, snapshot: {stocks: [stock(1), stock(2), stock(3)]}})});
  await request(first);
  const second = createMarketHeatmapHandler({getRedis: async () => redis, now: () => clock.ms,
    load: async () => { throw new Error("network outage"); }});
  const response = await request(second, "industry=测试行业&source=eastmoney");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.partial, false);
  assert.equal(response.body.returnedCount, 3);
  assert.equal(response.body.totalCount, 3);
  assert.equal(response.body.stocks[0].mainInflow, null);
});

test("heatmap rejects same-name industry data from a different displayed provider", async () => {
  const handler = createMarketHeatmapHandler({getRedis: async () => null, now: () => START,
    load: async () => heatmap()});
  const response = await request(handler, "industry=测试行业&source=sina");
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.stocks, undefined);
});

test("heatmap full fallback industry members are complete even when the provider metadata is partial", async () => {
  const payload = {...heatmap(), source: "sina", classification: "新浪行业", partial: true, mode: "snapshot"};
  const handler = createMarketHeatmapHandler({getRedis: async () => null, now: () => START,
    load: async () => { throw new Error("network outage"); },
    loadFallback: async () => ({payload, snapshot: {stocks: [stock(1), stock(2), stock(3)]}})});
  await request(handler);
  const response = await request(handler, "industry=测试行业&source=sina");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.partial, false);
  assert.equal(response.body.providerPartial, true);
  assert.equal(response.body.returnedCount, 3);
  assert.equal(response.body.totalCount, 3);
  assert.equal(response.body.notice?.includes("部分成分股") || false, false);
});

test("today-market malformed partial panel data never reaches the rendering client", async () => {
  for (const modify of [
    (body) => { delete body.yangYin; },
    (body) => { body.hist = [{label: "0", count: "unknown"}]; },
    (body) => { body.capTiers = [{key: "test", label: "test", n: "unknown", avg: null}]; },
  ]) {
    const body = {...today(), partial: true, mode: "snapshot"};
    modify(body);
    const handler = createTodayMarketHandler({getRedis: async () => null, now: () => START,
      load: async () => { throw new Error("network outage"); }, loadFallback: async () => body});
    const response = await request(handler, "retry=1");
    assert.equal(response.statusCode, 502);
  }
});

test("today-market malformed nested complete caches cannot crash the rendering client", async () => {
  for (const modify of [
    (body) => { body.history = [null]; },
    (body) => { body.history = [{date: {}, ztCount: 1, lbCount: 1, maxLb: 1}]; },
    (body) => { body.strong.ztCount = {invalid: true}; },
    (body) => { body.consecutive.lbCount = {invalid: true}; },
    (body) => { body.heat.value = "unknown"; },
    (body) => { body.premium = {count: 1, avg: 1, redRate: 1, dist: [null]}; },
  ]) {
    const body = today();
    modify(body);
    const clock = {ms: START};
    const redis = store(clock);
    await redis.set("today-market:v1:lastgood", JSON.stringify(body));
    const handler = createTodayMarketHandler({getRedis: async () => redis, now: () => clock.ms,
      load: async () => {throw new Error("network outage");}});
    const response = await request(handler, "retry=1");
    assert.equal(response.statusCode, 502);
  }
});

test("long-holiday real quote dates can be older than seven days without extending cached payload lifetime", async () => {
  const clock = {ms: Date.parse("2026-10-08T02:00:00Z")};
  const recent = {...heatmap(clock.ms), quoteTime: QUOTE_TIME, dataDate: "2026-09-30"};
  const handler = createMarketHeatmapHandler({getRedis: async () => null, now: () => clock.ms, load: async () => recent});
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.quoteTime, QUOTE_TIME);
  clock.ms += 7 * DAY_MS;
  const expired = await request(handler, "retry=1");
  assert.equal(expired.statusCode, 502);
});

test("heatmap history handling runs before any new live source or cache work", async () => {
  let calls = 0;
  const handler = createMarketHeatmapHandler({historyHandler: (_req, res) => {res.statusCode = 202; res.end('{"historical":true}'); return true;},
    getRedis: async () => { calls += 1; }, load: async () => { calls += 1; }});
  const response = await request(handler, "start=2026-09-28&end=2026-09-30");
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.historical, true);
  assert.equal(calls, 0);
});

test("heatmap missing amount, capitalization and main inflow remain null in aggregates and members", () => {
  const result = aggregate([{...stock(), cap: null, floatCap: null, amount: null, mainInflow: null}])[0];
  for (const key of ["cap", "floatCap", "amount", "mainInflow"]) {
    assert.equal(result[key], null, key);
    assert.equal(result.stocks[0][key], null, key);
  }
});

for (const fetchSnapshot of [fetchAllStocks, fetchAllStocksSnapshot]) {
  test(`${fetchSnapshot.name} rejects a missing page instead of promoting a partial whole-market snapshot`, async () => {
    let calls = 0;
    const row = {f12: "600001", f13: 1, f14: "测试", f3: 1, f20: 1e8, f100: "测试行业", f124: Date.parse(QUOTE_TIME) / 1000};
    const request = async (url) => {
      calls += 1;
      const page = new URL(url).searchParams.get("pn");
      return {ok: page === "1", json: async () => ({data: {total: 101, diff: [row]}})};
    };
    await assert.rejects(fetchSnapshot({request, now: () => START}));
    assert.ok(calls >= 2);
  });

  test(`${fetchSnapshot.name} non-trading dash data is distinct from a network failure`, async () => {
    const row = {f12: "600001", f14: "测试", f3: "-", f20: 1e8};
    const request = async () => ({ok: true, json: async () => ({data: {total: 1, diff: [row]}})});
    const result = await fetchSnapshot({request, now: () => START});
    assert.equal(result.live, false);
  });
}

test("today-market unavailable historical pools stay unknown rather than zero", async () => {
  const rows = await buildHistory(["20260930"], new Map([["20260930", {tc: 0, pool: []}]]), new Map(), new Map(), START);
  assert.equal(rows[0].dtCount, null);
  assert.equal(rows[0].zbCount, null);
  assert.equal(rows[0].zbRate, null);
});
