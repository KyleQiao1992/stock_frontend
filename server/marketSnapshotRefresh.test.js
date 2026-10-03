import test from "node:test";
import assert from "node:assert/strict";
import { createMarketSnapshotCache } from "./marketSnapshotCache.js";

const START = Date.parse("2026-10-03T02:00:00Z");
const QUOTE = "2026-09-30T07:00:00Z";
const EARLIER_QUOTE = "2026-09-29T07:00:00Z";
const LATER_QUOTE = "2026-09-30T08:00:00Z";
const KEY = "test-market-refresh:v1";
const FALLBACK_KEY = "test-market-refresh:v2:snapshot";

function fakeRedis(clock) {
  const values = new Map();
  const writes = [];
  return {
    writes,
    async get(key) {
      const entry = values.get(key);
      return entry && entry.expires > clock.ms ? entry.body : null;
    },
    async set(key, body, {EX = 7 * 86400} = {}) {
      writes.push({key, body, EX});
      values.set(key, {body, expires: clock.ms + EX * 1000});
    },
  };
}

function payload(marker, {at = START, quoteTime = QUOTE, source = "eastmoney", ...extra} = {}) {
  return {live: true, marker, source, quoteTime, updatedAt: new Date(at).toISOString(), ...extra};
}

function alternate(marker = "backup", options = {}) {
  return payload(marker, {source: "sina", mode: "snapshot", partial: true, ...options});
}

function create(clock, overrides = {}) {
  return createMarketSnapshotCache({
    key: KEY, freshMs: 60000, staleMs: 15 * 60000,
    now: () => clock.ms,
    validate: (body) => body?.live === true && typeof body.marker === "string",
    emptyClosed: (at) => ({live: false, marketClosed: true, updatedAt: new Date(at).toISOString()}),
    ...overrides,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return {promise, resolve};
}

async function seedFull(redis, body, {fresh = false} = {}) {
  await redis.set(`${KEY}:lastgood`, JSON.stringify(body));
  if (fresh) {
    await redis.set(KEY, JSON.stringify(body), {EX: 900});
    await redis.set(`${KEY}:ts`, String(Date.parse(body.updatedAt)), {EX: 900});
  }
}

test("cached full snapshot returns immediately while a background failure still tries the alternate", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  const original = payload("original", {at: START - 3600000, quoteTime: EARLIER_QUOTE});
  await seedFull(redis, original);
  const gate = deferred();
  let primaryCalls = 0;
  let backupCalls = 0;
  const cache = create(clock, {
    load: async () => { primaryCalls += 1; await gate.promise; throw new Error("primary unavailable"); },
    loadFallback: async () => { backupCalls += 1; return alternate(); },
  });

  const initial = await cache.get(redis);
  assert.equal(initial.marker, "original");
  assert.equal(initial.stale, true);
  assert.equal(initial.refreshing, true);
  assert.equal(initial.updatedAt, original.updatedAt);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);

  const pendingRefresh = cache.get(redis, {retry: true});
  gate.resolve();
  const refreshed = await pendingRefresh;
  assert.equal(refreshed.marker, "backup");
  assert.equal(refreshed.source, "sina");
  assert.equal(refreshed.partial, true);
  assert.equal(refreshed.stale, undefined);
  assert.equal(backupCalls, 1);
  assert.equal(JSON.parse(await redis.get(`${KEY}:lastgood`)).marker, "original");
  assert.equal(JSON.parse(await redis.get(FALLBACK_KEY)).marker, "backup");

  const subsequent = await cache.get(redis);
  assert.equal(subsequent.marker, "backup");
  assert.equal(subsequent.stale, undefined);
  assert.equal(primaryCalls, 1);
});

test("an alternate accepted at the same quote time stays active over a still-fresh complete cache", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("complete"), {fresh: true});
  let primaryCalls = 0;
  const cache = create(clock, {
    load: async () => { primaryCalls += 1; throw new Error("primary unavailable"); },
    loadFallback: async () => alternate("same-time-backup"),
  });

  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(refreshed.marker, "same-time-backup");
  assert.equal(refreshed.quoteTime, QUOTE);
  assert.equal(refreshed.stale, undefined);
  const subsequent = await cache.get(redis);
  assert.equal(subsequent.marker, "same-time-backup");
  assert.equal(primaryCalls, 1);
  assert.equal(JSON.parse(await redis.get(KEY)).marker, "complete");
});

test("a newer fetch timestamp cannot promote an alternate with older quotes", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  const original = payload("complete", {at: START - 3600000});
  await seedFull(redis, original);
  let backupCalls = 0;
  const cache = create(clock, {
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => { backupCalls += 1; return alternate("older-backup", {quoteTime: EARLIER_QUOTE}); },
  });

  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(backupCalls, 1);
  assert.equal(refreshed.marker, "complete");
  assert.equal(refreshed.quoteTime, QUOTE);
  assert.equal(refreshed.updatedAt, original.updatedAt);
  assert.equal(refreshed.stale, true);
  assert.equal(await redis.get(FALLBACK_KEY), null);
});

test("failed alternates and older new quotes preserve the newest real cached provider", async () => {
  for (const failure of ["unavailable", "older"]) {
    const clock = {ms: START};
    const redis = fakeRedis(clock);
    await seedFull(redis, payload("old-complete", {at: START - 3600000, quoteTime: EARLIER_QUOTE}));
    const previous = alternate("newest-cached-backup", {at: START - 120000});
    await redis.set(FALLBACK_KEY, JSON.stringify(previous));
    const cache = create(clock, {
      load: async () => { throw new Error("primary unavailable"); },
      loadFallback: async () => {
        if (failure === "unavailable") throw new Error("alternate unavailable");
        return alternate("older-fetched-backup", {quoteTime: EARLIER_QUOTE});
      },
    });

    const refreshed = await cache.get(redis, {retry: true});
    assert.equal(refreshed.marker, previous.marker, failure);
    assert.equal(refreshed.quoteTime, previous.quoteTime);
    assert.equal(refreshed.updatedAt, previous.updatedAt);
    assert.equal(refreshed.stale, true);
    assert.equal(JSON.parse(await redis.get(FALLBACK_KEY)).marker, previous.marker);
  }
});

test("date-only quotes compare by Shanghai trading day rather than a fabricated intraday timestamp", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  // In Shanghai this exact quote is already September 30, despite the UTC date.
  await seedFull(redis, payload("utc-previous-day", {at: START - 3600000, quoteTime: "2026-09-29T16:30:00Z"}));
  const cache = create(clock, {
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => alternate("date-only-backup", {quoteTime: null, dataDate: "2026-09-30"}),
  });
  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(refreshed.marker, "date-only-backup");
  assert.equal(refreshed.quoteTime, null);
  assert.equal(refreshed.dataDate, "2026-09-30");
  assert.equal(refreshed.stale, undefined);
});

test("a legacy date-only complete cache cannot shadow a later dated alternate", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("date-only-complete", {at: START - 3600000, quoteTime: null, date: "2026-09-29"}));
  const cache = create(clock, {
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => alternate("later-quote-backup"),
  });
  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(refreshed.marker, "later-quote-backup");
  assert.equal(refreshed.quoteTime, QUOTE);
});

test("missing quote dates do not use updatedAt as proof of newer market data", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("dated-complete", {at: START - 3600000}));
  const cache = create(clock, {
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => alternate("undated-backup", {quoteTime: null}),
  });
  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(refreshed.marker, "dated-complete");
  assert.equal(refreshed.stale, true);
  assert.equal(await redis.get(FALLBACK_KEY), null);
});

test("an undated legacy complete cache does not block a trusted dated alternate", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("undated-complete", {at: START - 3600000, quoteTime: null}));
  const cache = create(clock, {
    load: async () => { throw new Error("primary unavailable"); },
    loadFallback: async () => alternate("dated-backup"),
  });
  const refreshed = await cache.get(redis, {retry: true});
  assert.equal(refreshed.marker, "dated-backup");
  assert.equal(refreshed.quoteTime, QUOTE);
});

test("restart prefers a later cached alternate even when complete data was fetched more recently", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("recent-fetch-older-quotes", {quoteTime: EARLIER_QUOTE}), {fresh: true});
  await redis.set(FALLBACK_KEY, JSON.stringify(alternate("later-cached-backup", {at: START - 1000})));
  let calls = 0;
  const cache = create(clock, {
    load: async () => { calls += 1; throw new Error("primary unavailable"); },
    loadFallback: async () => { calls += 1; throw new Error("alternate unavailable"); },
  });
  const restored = await cache.get(redis);
  assert.equal(restored.marker, "later-cached-backup");
  assert.equal(restored.stale, undefined);
  assert.equal(calls, 0);
});

test("restart with equal quote dates favors a fresh complete cache over a cached alternate", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("fresh-complete"), {fresh: true});
  await redis.set(FALLBACK_KEY, JSON.stringify(alternate("fresh-backup")));
  let calls = 0;
  const cache = create(clock, {
    load: async () => { calls += 1; throw new Error("should not load"); },
  });
  const restored = await cache.get(redis);
  assert.equal(restored.marker, "fresh-complete");
  assert.equal(restored.stale, undefined);
  assert.equal(calls, 0);
});

test("restart with equal quote dates uses a recently fetched alternate over expired complete data", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("expired-complete", {at: START - 3600000}));
  await redis.set(FALLBACK_KEY, JSON.stringify(alternate("recent-backup")));
  let calls = 0;
  const cache = create(clock, {
    load: async () => { calls += 1; throw new Error("should not load"); },
  });
  const restored = await cache.get(redis);
  assert.equal(restored.marker, "recent-backup");
  assert.equal(restored.stale, undefined);
  assert.equal(calls, 0);
});

test("recovering primary at equal or later quote time becomes active again", async () => {
  for (const quoteTime of [QUOTE, LATER_QUOTE]) {
    const clock = {ms: START};
    const redis = fakeRedis(clock);
    let healthy = false;
    const cache = create(clock, {
      load: async () => {
        if (!healthy) throw new Error("primary unavailable");
        return payload("recovered-complete", {at: clock.ms, quoteTime});
      },
      loadFallback: async () => alternate("active-backup"),
    });
    assert.equal((await cache.get(redis, {retry: true})).marker, "active-backup");
    healthy = true;
    clock.ms += 1000;
    const recovered = await cache.get(redis, {retry: true});
    assert.equal(recovered.marker, "recovered-complete", quoteTime);
    assert.equal(recovered.source, "eastmoney");
    assert.equal(recovered.partial, undefined);
    assert.equal(recovered.stale, undefined);
    assert.equal((await cache.get(redis)).marker, "recovered-complete");
    assert.equal(JSON.parse(await redis.get(`${KEY}:lastgood`)).marker, "recovered-complete");
    // Older clients can still request the retained same-source alternate cache.
    assert.equal(JSON.parse(await redis.get(FALLBACK_KEY)).marker, "active-backup");
  }
});

test("recovering primary with earlier quotes cannot roll a newer cached alternate backwards", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  let healthy = false;
  const cache = create(clock, {
    load: async () => {
      if (!healthy) throw new Error("primary unavailable");
      return payload("older-recovered-primary", {at: clock.ms, quoteTime: EARLIER_QUOTE});
    },
    loadFallback: async () => alternate("newer-backup"),
  });
  await cache.get(redis, {retry: true});
  healthy = true;
  clock.ms += 1000;
  const recovered = await cache.get(redis, {retry: true});
  assert.equal(recovered.marker, "newer-backup");
  assert.equal(recovered.quoteTime, QUOTE);
  assert.equal((await cache.get(redis)).marker, "newer-backup");
});

test("failure cooldown chooses the newer cache and starts after a slow alternate attempt finishes", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  await seedFull(redis, payload("older-complete", {at: START - 3600000, quoteTime: EARLIER_QUOTE}));
  await redis.set(FALLBACK_KEY, JSON.stringify(alternate("newer-cached-backup", {at: START - 120000})));
  let primaryCalls = 0;
  let backupCalls = 0;
  const cache = create(clock, {
    freshMs: 1,
    load: async () => { primaryCalls += 1; throw new Error("primary unavailable"); },
    loadFallback: async () => {
      backupCalls += 1;
      clock.ms += 31000;
      throw new Error("alternate unavailable after a slow request");
    },
  });
  assert.equal((await cache.get(redis, {retry: true})).marker, "newer-cached-backup");
  clock.ms += 1;
  const cooling = await cache.get(redis);
  assert.equal(cooling.marker, "newer-cached-backup");
  assert.equal(cooling.stale, true);
  // Join any background work without overriding the cooldown with a retry.
  await cache.get(redis);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 1);

  await cache.get(redis, {retry: true});
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 2);
});

test("explicit retries bypass fresh alternate data and coalesce one concurrent source scan", async () => {
  const clock = {ms: START};
  const redis = fakeRedis(clock);
  let primaryCalls = 0;
  let backupCalls = 0;
  let blocked = false;
  const gate = deferred();
  const cache = create(clock, {
    load: async () => {
      primaryCalls += 1;
      if (blocked) await gate.promise;
      throw new Error("primary unavailable");
    },
    loadFallback: async () => { backupCalls += 1; return alternate(`backup-${backupCalls}`, {at: clock.ms}); },
  });
  assert.equal((await cache.get(redis, {retry: true})).marker, "backup-1");
  assert.equal((await cache.get(redis)).marker, "backup-1");
  assert.equal(primaryCalls, 1);
  blocked = true;
  const first = cache.get(redis, {retry: true});
  const second = cache.get(redis, {retry: true});
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 2);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].marker, "backup-2");
});
