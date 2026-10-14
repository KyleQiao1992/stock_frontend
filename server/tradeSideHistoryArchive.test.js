import test from "node:test";
import assert from "node:assert/strict";
import { createTradeSideHistoryArchive, TDX_HISTORY_LIMITS_KEY, tdxHistoryKey,
  eligibleTdxHistoryDate, REGISTER_TDX_HISTORY_LIMIT } from "./tradeSideHistoryArchive.js";
import { createTradeSideHistoryApiService } from "./ashareTradeSideHistory.js";

const NOW = Date.parse("2026-10-13T08:20:00Z");
const day = (date = "2026-10-12", code = "603818", changes = {}) => ({
  code, name: "曲美家居", date, source: { key: "tdx" }, quoteTime: null,
  innerVol: 120, outerVol: 150, totalVol: 300, neutralVol: 20, unknownVol: 10,
  regularVol: 300, afterHoursVol: 0, close: 4.34,
  quality: { validated: true, paginationComplete: true, volumeDifference: 0, expectedTotalVol: 300, closingPrice: 4.34 },
  complete: true, validated: true, collectedAt: new Date(NOW).toISOString(), ...changes,
});
const quality = (done, total = done, missingDates = []) => ({
  done, total, processed: total, missingDates, errors: {},
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function redisDouble() {
  const hashes = new Map();
  const sets = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    hashes, sets,
    async hVals(key) { return [...(hashes.get(key)?.values() || [])]; },
    async hGet(key, field) { return hashes.get(key)?.get(field) ?? null; },
    async hGetAll(key) { return Object.fromEntries(hashes.get(key) || []); },
    async hSet(key, field, value) { hash(key).set(field, value); },
    async eval(script, {keys, arguments:args}) {
      assert.equal(script, REGISTER_TDX_HISTORY_LIMIT);
      const previous = Number(hash(keys[0]).get(args[0])) || 0;
      const requested = Number(args[1]);
      if (requested > previous) hash(keys[0]).set(args[0], args[1]);
      return Math.max(previous, requested);
    },
    async hSetNX(key, field, value) {
      if (hash(key).has(field)) return 0;
      hash(key).set(field, value);
      return 1;
    },
    async sMembers(key) { return [...(sets.get(key) || [])]; },
  };
}
const service = (redis, fetchArchive, options = {}) => createTradeSideHistoryArchive({
  getRedis: async () => redis, fetchArchive, now: () => NOW, log: () => {}, ...options,
});
async function settled(archive, code = "603818", limit = 30) {
  for (let n = 0; n < 40; n += 1) {
    const result = await archive.query(code, limit);
    if (result.history.status !== "loading") return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Mock archive job did not settle");
}

test("first response queues true historical work without putting today's Tencent quote in rows", async () => {
  const pending = deferred();
  const archive = service(redisDouble(), () => pending.promise);
  const api = createTradeSideHistoryApiService({ archive,
    realtime: { get: async () => ({ latest: { ...day("2026-10-13"), source: "tencent" } }) } });
  const result = await api.get("603818", 30);
  assert.equal(result.history.status, "loading");
  assert.deepEqual(result.rows, []);
  assert.equal(result.latest.date, "2026-10-13");
  assert.equal(result.latest.source, "tencent");
  assert.equal(result.source.key, "tdx");
  assert.equal(result.realtimeSource.key, "tencent");
  pending.resolve({ quality: quality(0, 0) });
  archive.dispose();
});

test("only verified daily rows are archived in the independent no-TTL namespace", async () => {
  const redis = redisDouble();
  const archive = service(redis, async ({ onDay, onProgress }) => {
    await onDay(day());
    onProgress(quality(1));
    return { rows: [day()], quality: quality(1) };
  });
  await archive.query("603818", 30);
  const result = await settled(archive);
  assert.equal(result.history.status, "complete");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source, "tdx");
  assert.equal(result.rows[0].quoteTime, null);
  assert.equal(result.rows[0].netVol, 30);
  assert.equal(result.rows[0].netRatio, 30 / 270 * 100);
  assert.equal(result.rows[0].unknownVol, 10);
  assert.equal(result.rows[0].quality.verification.exchangeDirectionVerified, false);
  assert.deepEqual(result.verification.validationScope, ["pagination", "regular-volume", "regular-close"]);
  assert.equal(result.collection.days, 1);
  assert.deepEqual([...redis.hashes.keys()].sort(),
    [TDX_HISTORY_LIMITS_KEY, tdxHistoryKey("sh603818")].sort());
  archive.dispose();
});

test("existing validated dates are skipped and a shared job expands only after the first finishes", async () => {
  const redis = redisDouble();
  await redis.hSet(tdxHistoryKey("sh603818"), "2026-10-12", JSON.stringify({ ...day(), source: "tdx" }));
  const first = deferred();
  const calls = [];
  const archive = service(redis, async (options) => {
    calls.push(options);
    assert.equal(options.existingDates.has("2026-10-12"), true);
    if (calls.length === 1) await first.promise;
    return { quality: quality(1) };
  });
  const initial = await archive.query("603818", 30);
  assert.equal(initial.rows.length, 1);
  await Promise.all([archive.query("603818", 60), archive.query("603818", 30)]);
  assert.equal(calls.length, 1);
  first.resolve();
  await settled(archive, "603818", 60);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.limit), [30, 60]);
  await archive.query("603818", 30);
  assert.equal(calls.length, 2);
  archive.dispose();
});

test("persistence refusal produces an explicit error and never displays an unsaved result row", async () => {
  const redis = redisDouble();
  redis.hSetNX = async () => { throw new Error("write denied"); };
  const archive = service(redis, async ({ onDay }) => {
    await onDay(day());
    return { rows: [day()], quality: quality(1) };
  });
  await archive.query("603818", 30);
  const result = await settled(archive);
  assert.equal(result.history.status, "error");
  assert.match(result.history.error, /保存失败/);
  assert.deepEqual(result.rows, []);
  archive.dispose();
});

test("missing trading dates stay missing while real saved dates remain visible", async () => {
  const archive = service(redisDouble(), async ({ onDay }) => {
    await onDay(day());
    return { quality: { ...quality(1, 2, ["2026-10-09"]), errors: { "2026-10-09": "volume mismatch" } } };
  });
  await archive.query("603818", 30);
  const result = await settled(archive);
  assert.equal(result.history.status, "error");
  assert.equal(result.history.done, 1);
  assert.equal(result.history.total, 2);
  assert.deepEqual(result.history.missingDates, ["2026-10-09"]);
  assert.deepEqual(result.rows.map((row) => row.date), ["2026-10-12"]);
  assert.equal(result.history.errors["2026-10-09"], "volume mismatch");
  archive.dispose();
});

test("an unverified or intraday transaction row cannot become complete after the server clock advances", async () => {
  for (const changes of [{ validated: false }, { complete: false }, { quoteTime: "2026-10-12T15:00:00+08:00" }]) {
    const archive = service(redisDouble(), async ({ onDay }) => {
      await onDay(day("2026-10-12", "603818", changes));
      return { quality: quality(1) };
    });
    await archive.query("603818", 30);
    const result = await settled(archive);
    assert.equal(result.rows.length, 0);
    assert.equal(result.history.status, "error");
    archive.dispose();
  }
  let clock = Date.parse("2026-10-13T06:30:00Z");
  const pending = deferred();
  const archive = service(redisDouble(), async ({ onDay }) => {
    await pending.promise;
    clock = NOW;
    await onDay(day("2026-10-13"));
    return { quality: quality(1) };
  }, { now: () => clock });
  await archive.query("603818", 30);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  // Read with the original cutoff to avoid scheduling the next session job.
  clock = Date.parse("2026-10-13T06:30:00Z");
  const result = await settled(archive);
  assert.equal(result.rows.length, 0);
  assert.equal(result.history.status, "error");
  assert.equal(eligibleTdxHistoryDate(clock), "2026-10-12");
  assert.equal(eligibleTdxHistoryDate(NOW), "2026-10-13");
  archive.dispose();
});

test("stored corrupt or mixed-source rows are refused instead of appearing as history", async () => {
  const redis = redisDouble();
  await redis.hSet(tdxHistoryKey("sh603818"), "2026-10-12", JSON.stringify(day(undefined, undefined, { source: "tencent" })));
  const archive = service(redis, async () => ({ quality: quality(0) }));
  await assert.rejects(archive.query("603818", 30), /存储读取失败/);
  archive.dispose();
});

test("legacy validation and stored claims cannot upgrade vendor directions to exchange verification", async () => {
  const redis = redisDouble();
  const input = day();
  input.quality.verification = { exchangeDirectionVerified: true, directionSource: "exchange", rawRecordsRetained: true };
  await redis.hSet(tdxHistoryKey("sh603818"), input.date, JSON.stringify(input));
  const archive = service(redis, async () => ({ quality: quality(1) }));
  const result = await archive.query("603818", 30);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quality.verification.directionSource, "tdx");
  assert.equal(result.rows[0].quality.verification.exchangeDirectionVerified, false);
  assert.equal(result.rows[0].quality.verification.rawRecordsRetained, false);
  assert.equal(result.verification.exchangeDirectionVerified, false);
  archive.dispose();
});

test("archive reads reject missing or mismatched closing-price evidence despite legacy validated flags", async () => {
  for (const price of [undefined, 4.35]) {
    const redis = redisDouble();
    const input = day();
    input.quality.closingPrice = price;
    await redis.hSet(tdxHistoryKey("sh603818"), input.date, JSON.stringify(input));
    const archive = service(redis, async () => ({ quality: quality(0) }));
    await assert.rejects(archive.query("603818", 30), /存储读取失败/);
    archive.dispose();
  }
});

test("history remains usable when the independent realtime provider fails", async () => {
  const api = createTradeSideHistoryApiService({
    realtime: { get: async () => { throw new Error("当前报价不可用"); } },
    archive: { query: async () => ({ rows: [day()], source: { key: "tdx" }, history: { status: "complete" } }) },
  });
  const result = await api.get("603818", 30);
  assert.equal(result.rows.length, 1);
  assert.equal(result.latest, null);
  assert.match(result.warning, /当前报价不可用/);
});

test("background recovery uses saved requested limits and does not fetch archived dates again", async () => {
  const redis = redisDouble();
  await redis.hSet(TDX_HISTORY_LIMITS_KEY, "sh603818", "60");
  await redis.hSet(tdxHistoryKey("sh603818"), "2026-10-12", JSON.stringify(day()));
  let requested;
  const archive = service(redis, async (options) => {
    requested = options;
    return { quality: quality(1) };
  });
  await archive.collectTracked();
  await settled(archive, "603818", 60);
  assert.equal(requested.limit, 60);
  assert.equal(requested.existingDates.has("2026-10-12"), true);
  await assert.rejects(archive.query("603818", 121), /1 至 120/);
  archive.dispose();
});
