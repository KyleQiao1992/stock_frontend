import test from "node:test";
import assert from "node:assert/strict";
import { parseTencentTradeSideQuote, fetchTencentTradeSideQuotes, createTradeSideHistoryService,
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
