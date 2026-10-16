import test from "node:test";
import assert from "node:assert/strict";
import { parseTencentTradeSideQuote, fetchTencentTradeSideQuotes, createTradeSideHistoryService,
  createTradeSideSnapshotService, createTradeSideHistoryApiService, tradeSideHistoryService,
  createAshareTradeSideHistoryHandler, toTradeSideSymbol, TRADE_SIDE_TRACKED_KEY,
  UPSERT_TRADE_SIDE_SCRIPT, isTradeSideCollectionWindow } from "./ashareTradeSideHistory.js";

const NOW = Date.parse("2026-10-13T08:20:00Z");
function quote(timestamp = "20261013161456", changes = {}) {
  const fields = Array(90).fill("");
  Object.assign(fields, { 1: "曲美家居", 2: "603818", 6: "314193", 7: "150901", 8: "163292",
    30: timestamp, 40: "0" }, changes);
  return fields;
}
const snapshot = (timestamp, changes, at = NOW) => parseTencentTradeSideQuote("sh603818", quote(timestamp, changes), at);

// Isolated Redis test double. No connection to configured or shared services.
function redisDouble() {
  const hashes = new Map();
  const sets = new Map();
  const calls = [];
  return {
    hashes, sets, calls,
    async sAdd(key, value) { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(value); calls.push(["sAdd", key, value]); },
    async sMembers(key) { return [...(sets.get(key) || [])]; },
    async hVals(key) { return [...(hashes.get(key)?.values() || [])]; },
    async eval(script, options) {
      assert.equal(script, UPSERT_TRADE_SIDE_SCRIPT);
      assert.equal(options.keys.length, 1);
      const [date, timestamp, body] = options.arguments;
      calls.push(["eval", options]);
      const key = options.keys[0];
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key);
      const previous = hash.has(date) ? JSON.parse(hash.get(date)) : null;
      if (previous && previous.quoteTime >= timestamp) return 0;
      hash.set(date, body);
      return 1;
    },
  };
}
const serviceFor = (redis, load) => createTradeSideHistoryService({ getRedis: async () => redis,
  fetchQuotes: async (symbols) => new Map(symbols.map((symbol) => [symbol, load(symbol)])),
  now: () => NOW, log: () => {} });

test("real Tencent side counters remain in hands and differ from cash flows", () => {
  const row = snapshot();
  assert.equal(row.outerVol, 150901);
  assert.equal(row.innerVol, 163292);
  assert.equal(row.totalVol, 314193);
  assert.equal(row.netVol, -12391);
  assert.equal(row.netRatio, -12391 / 314193 * 100);
  assert.equal(row.outerRatio, 150901 / 314193 * 100);
  assert.equal(row.quoteTime, "2026-10-13T16:14:56+08:00");
  assert.equal(row.complete, true);
  const rounded = snapshot(undefined, { 6: "314192" });
  assert.equal(rounded.totalVol, 314192);
  assert.equal(rounded.innerVol + rounded.outerVol, 314193);
  assert.equal(toTradeSideSymbol("920099"), "bj920099");
});

test("STAR Market quote counters preserve exact share remainders when converted to lots", () => {
  const fields = quote(undefined, { 1: "埃科光电", 2: "688610", 6: "1763046", 7: "792210", 8: "970836" });
  const row = parseTencentTradeSideQuote("sh688610", fields, NOW);
  assert.equal(row.totalVol, 17630.46);
  assert.equal(row.innerVol, 9708.36);
  assert.equal(row.outerVol, 7922.1);
  assert.equal(row.netVol, -1786.26);
  assert.equal(row.netRatio, (792210 - 970836) / 1763046 * 100);
  assert.equal(row.volumeUnit, "lot");
  assert.equal(row.sourceVolumeUnit, "share");
  assert.deepEqual(row.sourceVolumes, { innerVol: 970836, outerVol: 792210, totalVol: 1763046 });
});

test("legacy STAR Market snapshots normalize on read even when the same timestamp prevents replacement", async () => {
  const redis = redisDouble();
  const corrected = parseTencentTradeSideQuote("sh688610", quote(undefined,
    { 1: "埃科光电", 2: "688610", 6: "1763046", 7: "792210", 8: "970836" }), NOW);
  const legacy = { ...corrected, innerVol: 970836, outerVol: 792210, totalVol: 1763046 };
  delete legacy.volumeUnit;
  delete legacy.sourceVolumeUnit;
  delete legacy.sourceVolumes;
  const key = "ashare-trade-side:v1:daily:sh688610";
  redis.hashes.set(key, new Map([[legacy.date, JSON.stringify(legacy)]]));
  const service = serviceFor(redis, () => corrected);
  const result = await service.get("688610");
  assert.equal(result.latest.totalVol, 17630.46);
  assert.equal(result.latest.innerVol, 9708.36);
  assert.equal(result.latest.outerVol, 7922.1);
  assert.equal(result.latest.netVol, -1786.26);
  assert.equal(JSON.parse(redis.hashes.get(key).get(legacy.date)).innerVol, 970836);
  const restart = serviceFor(redis, () => corrected);
  assert.equal((await restart.get("688610")).latest.innerVol, 9708.36);
});

test("normalized STAR Market snapshots are not converted a second time after restart", async () => {
  const redis = redisDouble();
  const row = parseTencentTradeSideQuote("sh689009", quote(undefined,
    { 1: "九号公司", 2: "689009", 6: "1763046", 7: "792210", 8: "970836" }), NOW);
  await serviceFor(redis, () => row).get("689009");
  const result = await serviceFor(redis, () => row).get("689009");
  assert.equal(result.latest.innerVol, 9708.36);
  assert.equal(result.latest.totalVol, 17630.46);
});

test("after-close or next-day collection cannot promote a real intraday quote", () => {
  assert.equal(snapshot("20261013145959").complete, false);
  assert.equal(snapshot("20261013150000").complete, true);
  const nextDay = Date.parse("2026-10-14T09:00:00Z");
  assert.equal(snapshot("20261013120000", {}, nextDay).complete, false);
});

test("missing, malformed, mismatched and future quote values are refused", () => {
  for (const changes of [{ 7: "" }, { 8: "-1" }, { 6: "not-a-volume" }, { 2: "600519" },
    { 30: "20260230150000" }, { 30: "20261013250000" }, { 30: "20261014150000" }]) {
    assert.throws(() => snapshot(undefined, changes));
  }
  assert.throws(() => toTradeSideSymbol("603818?x=1"));
});

test("one invalid provider symbol does not discard valid quotes in its batch", async () => {
  const fields = quote().join("~");
  const body = `v_sh603818="${fields}";v_sz000001="";`;
  const rows = await fetchTencentTradeSideQuotes(["sh603818", "sz000001"], {
    request: async (url) => {
      assert.equal(url, "https://qt.gtimg.cn/q=sh603818,sz000001");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    }, now: () => NOW,
  });
  assert.equal(rows.get("sh603818").innerVol, 163292);
  assert.match(rows.get("sz000001").error, /格式无效/);
});

test("live snapshot requests Tencent directly and preserves STAR Market share precision", async () => {
  const requests = [];
  const fields = quote(undefined, { 1: "埃科光电", 2: "688610", 6: "1763046", 7: "792210", 8: "970836" });
  const service = createTradeSideSnapshotService({ now: () => NOW,
    request: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`v_sh688610="${fields.join("~")}";`).buffer };
    } });
  const result = await service.get("688610");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://qt.gtimg.cn/q=sh688610");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(result.latest.innerVol, 9708.36);
  assert.equal(result.latest.outerVol, 7922.1);
  assert.equal(result.latest.netVol, -1786.26);
  assert.equal(result.latest.quoteTime, "2026-10-13T16:14:56+08:00");
  assert.equal(result.source.key, "tencent");
  assert.equal(Object.hasOwn(result, "rows"), false);
  assert.equal(Object.hasOwn(result, "collection"), false);
});

test("default API realtime bypasses the Redis collector and creates no saved snapshot history", async (t) => {
  let redisCollectorCalls = 0;
  let quoteRequests = 0;
  t.mock.method(tradeSideHistoryService, "get", async () => {
    redisCollectorCalls += 1;
    throw new Error("Redis must not be used for a live quote");
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    quoteRequests += 1;
    assert.equal(url, "https://qt.gtimg.cn/q=sh603818");
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`v_sh603818="${quote().join("~")}";`).buffer };
  });
  const historicalRows = [{ code: "603818", date: "2026-10-12", innerVol: 200, outerVol: 300, complete: true }];
  const api = createTradeSideHistoryApiService({ archive: {
    query: async () => ({ code: "603818", rows: historicalRows, history: { status: "complete" } }),
  } });
  const result = await api.get("603818");
  assert.equal(redisCollectorCalls, 0);
  assert.equal(quoteRequests, 1);
  assert.equal(result.latest.innerVol, 163292);
  assert.equal(result.latest.source, "tencent");
  assert.deepEqual(result.rows, historicalRows);
  assert.deepEqual(result.snapshotHistory.rows, []);
  assert.equal(result.snapshotHistory.collection, null);
});

test("live snapshots report missing or invalid upstream quotes without inventing records", async () => {
  for (const quoteRows of [new Map(), new Map([["sh603818", { error: "腾讯报价时间无效。" }]])]) {
    const service = createTradeSideSnapshotService({ fetchQuotes: async () => quoteRows });
    await assert.rejects(service.get("603818"), /报价返回不完整|报价时间无效/);
  }
  const unavailable = createTradeSideSnapshotService({ request: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(unavailable.get("603818"), /HTTP 503/);
});

test("daily archive only contains actual collected dates and survives service restart", async () => {
  const redis = redisDouble();
  const first = serviceFor(redis, () => snapshot("20261013120000"));
  const result = await first.get("603818");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].date, "2026-10-13");
  assert.equal(result.latest.complete, false);
  assert.equal(result.collection.tracking, true);
  assert.deepEqual([...redis.sets.get(TRADE_SIDE_TRACKED_KEY)], ["sh603818"]);
  assert.equal(redis.calls.find(([method]) => method === "eval")[1].arguments[0], "2026-10-13");
  assert.doesNotMatch(UPSERT_TRADE_SIDE_SCRIPT, /EXPIRE|SETEX/i);

  const restarted = serviceFor(redis, () => snapshot("20261013150000"));
  await restarted.collectTracked();
  const restored = await restarted.get("603818");
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.latest.complete, true);
  assert.equal(restored.collection.completedDays, 1);
});

test("a delayed old quote cannot overwrite an archived closing quote", async () => {
  const redis = redisDouble();
  let row = snapshot("20261013150000");
  const service = serviceFor(redis, () => row);
  await service.get("603818");
  row = snapshot("20261013120000", { 7: "1", 8: "2", 6: "3" });
  const result = await service.get("603818");
  assert.equal(result.latest.quoteTime, "2026-10-13T15:00:00+08:00");
  assert.equal(result.latest.complete, true);
  assert.equal(result.latest.outerVol, 150901);
});

test("first collection date does not change when the requested history limit shrinks", async () => {
  const redis = redisDouble();
  let row = snapshot("20261012150000");
  const service = serviceFor(redis, () => row);
  await service.get("603818");
  row = snapshot("20261013150000");
  const result = await service.get("603818", 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].date, "2026-10-13");
  assert.equal(result.collection.firstDate, "2026-10-12");
  assert.equal(result.collection.days, 2);
});

test("upstream failure returns real archived data with an explicit collection error", async () => {
  const redis = redisDouble();
  const service = serviceFor(redis, () => snapshot());
  await service.get("603818");
  const offline = createTradeSideHistoryService({ getRedis: async () => redis,
    fetchQuotes: async () => { throw new Error("腾讯接口暂时不可用。"); } });
  const result = await offline.get("603818");
  assert.equal(result.rows.length, 1);
  assert.match(result.warning, /腾讯接口暂时不可用/);
  assert.match(result.collection.error, /腾讯接口暂时不可用/);
});

test("failed persistence never turns live counters into supposedly saved history", async () => {
  const redis = redisDouble();
  redis.eval = async () => { throw new Error("write refused"); };
  await assert.rejects(serviceFor(redis, () => snapshot()).get("603818"), /保存失败/);
  const offline = createTradeSideHistoryService({ getRedis: async () => { throw new Error("offline"); } });
  await assert.rejects(offline.get("603818"), /本次报价未保存/);
  assert.equal(redis.hashes.size, 0);
});

test("suspension and zero-trade snapshots do not add artificial trading days", async () => {
  for (const changes of [{ 40: "S", 6: "0", 7: "0", 8: "0" }, { 6: "0", 7: "0", 8: "0" }]) {
    const redis = redisDouble();
    await assert.rejects(serviceFor(redis, () => snapshot(undefined, changes)).get("603818"), /停牌|尚无有效/);
    assert.equal(redis.hashes.size, 0);
  }
  const redis = redisDouble();
  let row = snapshot("20261012150000");
  const service = serviceFor(redis, () => row);
  await service.get("603818");
  row = snapshot(undefined, { 40: "S", 6: "0", 7: "0", 8: "0" });
  const result = await service.get("603818");
  assert.equal(result.rows[0].date, "2026-10-12");
  assert.match(result.warning, /停牌/);
});

test("tracked-symbol recovery isolates a bad symbol from other saved records", async () => {
  const redis = redisDouble();
  await redis.sAdd(TRADE_SIDE_TRACKED_KEY, "sh603818");
  await redis.sAdd(TRADE_SIDE_TRACKED_KEY, "sz000001");
  const service = serviceFor(redis, (symbol) => symbol === "sh603818" ? snapshot() : { error: "报价无效" });
  await service.collectTracked();
  assert.equal((await service.get("603818")).rows.length, 1);
  assert.equal(redis.hashes.size, 1);
});

test("background polling uses Shanghai session window and can be disposed", () => {
  assert.equal(isTradeSideCollectionWindow(Date.parse("2026-10-13T01:30:00Z")), true);
  assert.equal(isTradeSideCollectionWindow(Date.parse("2026-10-13T08:30:00Z")), true);
  assert.equal(isTradeSideCollectionWindow(Date.parse("2026-10-13T08:31:00Z")), false);
  assert.equal(isTradeSideCollectionWindow(Date.parse("2026-10-17T01:30:00Z")), false);
  const service = serviceFor(redisDouble(), () => snapshot());
  const dispose = service.start();
  assert.equal(service.start(), dispose);
  dispose();
  service.dispose();
});

test("HTTP validation and collection failure preserve truthful status codes", async () => {
  const handler = createAshareTradeSideHistoryHandler({ service: { get: async () => { throw new Error("历史保存失败。"); } } });
  for (const [url, status, message] of [["/api/ashare-trade-side-history?code=bad", 400, /六位/],
    ["/api/ashare-trade-side-history?code=603818&limit=0", 400, /1 至 120/],
    ["/api/ashare-trade-side-history?code=603818", 502, /保存失败/]]) {
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await handler({ url }, res);
    assert.equal(res.statusCode, status);
    assert.match(res.body.error, message);
  }
});
