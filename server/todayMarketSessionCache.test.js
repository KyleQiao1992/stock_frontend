import test from "node:test";
import assert from "node:assert/strict";
import {createMarketSnapshotCache} from "./marketSnapshotCache.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const KEY = "today-session-test:v1";
const FALLBACK_KEY = "today-session-test:v3:snapshot";

function full({date = "2026-09-30", quoteTime = "2026-09-30T07:00:00Z", ...extra} = {}) {
  return {live: true, marker: "complete", source: "eastmoney", date, quoteTime,
    heat: {value: 73}, strong: {ztCount: 25}, history: [{date}],
    updatedAt: new Date(NOW - 3600000).toISOString(), ...extra};
}

function partial(options = {}) {
  return {...full(options), marker: "alternate", source: "eastmoney-tencent", partial: true, mode: "snapshot",
    heat: null, strong: null, history: [], updatedAt: new Date(NOW).toISOString()};
}

function memoryRedis(clock) {
  const values = new Map();
  const writes = [];
  return {
    writes,
    async get(key) {
      const entry = values.get(key);
      return entry && entry.expires > clock.ms ? entry.body : null;
    },
    async set(key, body, {EX = 7 * 86400} = {}) {
      values.set(key, {body, expires: clock.ms + EX * 1000});
      writes.push({key, body});
    },
  };
}

function cache(clock, options = {}) {
  return createMarketSnapshotCache({key: KEY, freshMs: 60000, staleMs: 15 * 60000,
    now: () => clock.ms, fallbackVersion: 3, preferCompletePreviousSession: true,
    validate: (body) => body?.live === true && typeof body.marker === "string",
    emptyClosed: () => ({live: false}),
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => partial({quoteTime: "2026-09-30T08:15:00Z"}),
    ...options});
}

test("manual retry probes both sources but preserves a complete previous-session close over a later vendor timestamp", async () => {
  const clock = {ms: NOW};
  const redis = memoryRedis(clock);
  const original = full();
  await redis.set(`${KEY}:lastgood`, JSON.stringify(original));
  let primaryCalls = 0;
  const fallbackForces = [];
  const snapshots = cache(clock, {
    load: async () => { primaryCalls += 1; throw new Error("primary unavailable"); },
    loadFallback: async ({force}) => { fallbackForces.push(force); return partial({quoteTime: "2026-09-30T08:15:00Z"}); },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await snapshots.get(redis, {retry: true});
    assert.equal(result.marker, "complete");
    assert.equal(result.partial, undefined);
    assert.equal(result.date, "2026-09-30");
    assert.deepEqual(result.heat, {value: 73});
    assert.equal(result.updatedAt, original.updatedAt);
    assert.equal(result.staleReason, "upstream-error");
  }
  assert.equal(primaryCalls, 2);
  assert.deepEqual(fallbackForces, [true, true]);
  assert.equal(JSON.parse(await redis.get(FALLBACK_KEY)).marker, "alternate");
  assert.equal(JSON.parse(await redis.get(`${KEY}:lastgood`)).marker, "complete");
});

test("same-time alternate does not replace a complete previous-session close", async () => {
  const clock = {ms: NOW};
  const redis = memoryRedis(clock);
  await redis.set(`${KEY}:lastgood`, JSON.stringify(full()));
  const result = await cache(clock, {loadFallback: async () => partial()}).get(redis, {retry: true});
  assert.equal(result.marker, "complete");
});

test("updated breadth takes priority over a complete closing cache with different stock scope or suspension counts", async () => {
  for (const updatedBreadth of [
    {up: 3, down: 1, flat: 0, total: 4},
    {up: 1, down: 1, flat: 1, total: 3},
  ]) {
    const clock = {ms: NOW};
    const redis = memoryRedis(clock);
    await redis.set(`${KEY}:lastgood`, JSON.stringify(full({breadth: {up: 2, down: 1, flat: 0, total: 3}})));
    const result = await cache(clock, {
      loadFallback: async () => partial({quoteTime: "2026-09-30T08:15:00Z", breadth: updatedBreadth}),
    }).get(redis, {retry: true});
    assert.equal(result.marker, "alternate");
    assert.deepEqual(result.breadth, updatedBreadth);
  }
});

test("restart selects the complete previous-session close over a freshly cached alternate", async () => {
  const clock = {ms: NOW};
  const redis = memoryRedis(clock);
  await redis.set(`${KEY}:lastgood`, JSON.stringify(full()));
  await redis.set(FALLBACK_KEY, JSON.stringify(partial({quoteTime: "2026-09-30T08:15:00Z"})));
  let release;
  const primary = new Promise((resolve) => { release = resolve; });
  const snapshots = cache(clock, {load: async () => primary});
  const result = await snapshots.get(redis);
  assert.equal(result.marker, "complete");
  assert.equal(result.refreshing, true);
  const refreshing = snapshots.get(redis, {retry: true});
  release({live: false});
  assert.equal((await refreshing).marker, "complete");
});

for (const {name, complete, alternate, current = NOW} of [
  {name: "morning cache", complete: full({quoteTime: "2026-09-30T02:00:00Z"}), alternate: partial({quoteTime: "2026-09-30T07:00:00Z"})},
  {name: "older session cache", complete: full({date: "2026-09-29", quoteTime: "2026-09-29T07:00:00Z"}), alternate: partial()},
  {name: "same calendar day", complete: full(), alternate: partial({quoteTime: "2026-09-30T08:15:00Z"}), current: Date.parse("2026-09-30T12:00:00Z")},
  {name: "date-only cache", complete: full({quoteTime: null}), alternate: partial()},
  {name: "date conflicting with actual quote", complete: full({date: "2026-09-29"}), alternate: partial()},
  {name: "dataDate conflicting with actual quote", complete: full({dataDate: "2026-09-29"}), alternate: partial()},
]) {
  test(`${name} cannot gain complete closing-session priority`, async () => {
    const clock = {ms: current};
    const redis = memoryRedis(clock);
    const original = {...complete, updatedAt: new Date(current - 3600000).toISOString()};
    const backup = {...alternate, updatedAt: new Date(current).toISOString()};
    await redis.set(`${KEY}:lastgood`, JSON.stringify(original));
    const result = await cache(clock, {loadFallback: async () => backup}).get(redis, {retry: true});
    assert.equal(result.marker, "alternate");
    assert.equal(result.quoteTime, backup.quoteTime);
    assert.equal(result.heat, null);
  });
}

test("recovered primary with complete closing data replaces a partial alternate despite the alternate vendor timestamp", async () => {
  const clock = {ms: NOW};
  const redis = memoryRedis(clock);
  await redis.set(`${KEY}:lastgood`, JSON.stringify(full({marker: "old-complete", heat: {value: 1}})));
  await redis.set(FALLBACK_KEY, JSON.stringify(partial({quoteTime: "2026-09-30T08:15:00Z"})));
  const recovered = full({marker: "recovered", heat: {value: 91}, updatedAt: new Date(NOW).toISOString()});
  let onFullCalls = 0;
  const result = await cache(clock, {load: async () => recovered, onFull: async () => { onFullCalls += 1; }}).get(redis, {retry: true});
  assert.equal(result.marker, "recovered");
  assert.equal(result.stale, undefined);
  assert.deepEqual(result.heat, {value: 91});
  assert.equal(onFullCalls, 1);
  assert.equal(JSON.parse(await redis.get(`${KEY}:lastgood`)).marker, "recovered");
});

test("closed-session preference stays disabled by default for existing consumers", async () => {
  const clock = {ms: NOW};
  const redis = memoryRedis(clock);
  await redis.set(`${KEY}:lastgood`, JSON.stringify(full()));
  const result = await cache(clock, {preferCompletePreviousSession: false}).get(redis, {retry: true});
  assert.equal(result.marker, "alternate");
  assert.equal(result.partial, true);
});
