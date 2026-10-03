import test from "node:test";
import assert from "node:assert/strict";
import { createBoardFundflowHandler } from "./boardFundflow.js";

const START = Date.parse("2026-10-02T06:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function createRedis(clock) {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    failGet: false,
    failSet: false,
    async get(key) {
      if (this.failGet) throw new Error("cache read unavailable");
      const entry = values.get(key);
      if (!entry || entry.expiresAt <= clock.ms) return null;
      return entry.body;
    },
    async set(key, body, options = {}) {
      if (this.failSet) throw new Error("cache write unavailable");
      writes.push({ key, body, options });
      values.set(key, { body, expiresAt: clock.ms + Number(options.EX || 86400) * 1000 });
    },
  };
}

function curve({ dim = "day", top = 3, date = "", dataDate = "2026-10-02", updatedAt = new Date(START).toISOString() } = {}) {
  const points = dim === "day"
    ? [{ t: `${dataDate} 09:30`, v: 1 }, { t: `${dataDate} 09:31`, v: 2 }]
    : [{ t: "2026-09-29", v: 1 }, { t: "2026-09-30", v: 2 }];
  return {
    dim, top, date: date || null, mode: dim === "day" ? "intraday" : "cumulative",
    source: dim === "day" ? "eastmoney" : "sina",
    asOfDate: points.at(-1).t.slice(0, 10),
    count: 1,
    series: [{ code: "BK1234", name: "测试题材", points, final: 2 }],
    updatedAt,
  };
}

function snapshot({ date = "", dataDate = "2026-09-30", updatedAt = new Date(START).toISOString() } = {}) {
  return {
    dim: "day", top: 3, date: date || null, mode: "daily-snapshot", source: "sina", asOfDate: dataDate,
    count: 1,
    series: [{ code: "gn_test", name: "测试题材", points: [{ t: dataDate, v: 2 }], final: 2 }],
    updatedAt,
  };
}

function createHarness(options = {}) {
  const clock = { ms: START };
  const redis = createRedis(clock);
  const handler = createBoardFundflowHandler({
    now: () => clock.ms,
    getRedis: async () => redis,
    load: async (query) => curve(query),
    loadSnapshot: async () => { throw new Error("snapshot unavailable"); },
    ...options,
  });
  return { clock, redis, handler };
}

async function request(handler, query = "dim=day&top=3") {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  await handler({ url: `/?${query}` }, response);
  return response;
}

test("fundflow fresh memory cache avoids another upstream call", async () => {
  let calls = 0;
  const { handler } = createHarness({ load: async (query) => { calls += 1; return curve(query); } });
  const initial = await request(handler);
  const cached = await request(handler);
  assert.equal(initial.statusCode, 200);
  assert.equal(cached.statusCode, 200);
  assert.deepEqual(cached.body.series, initial.body.series);
  assert.equal(calls, 1);
});

test("fundflow fresh Redis cache is reused by another handler", async () => {
  const clock = { ms: START };
  const redis = createRedis(clock);
  const saved = curve();
  await redis.set("board-fundflow:day:3:latest", JSON.stringify(saved), { EX: 120 });
  let calls = 0;
  const handler = createBoardFundflowHandler({
    now: () => clock.ms, getRedis: async () => redis,
    load: async () => { calls += 1; throw new Error("upstream unavailable"); },
    loadSnapshot: async () => { throw new Error("snapshot unavailable"); },
  });
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.series, saved.series);
  assert.equal(calls, 0);
});

test("fundflow expired fresh data falls back to genuine last-good and preserves its timestamp", async () => {
  let fail = false;
  let snapshotCalls = 0;
  const { handler, clock } = createHarness({
    load: async (query) => { if (fail) throw new Error("all hosts failed"); return curve(query); },
    loadSnapshot: async () => { snapshotCalls += 1; return snapshot(); },
  });
  const initial = await request(handler);
  fail = true;
  clock.ms += 121000;
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.stale, true);
  assert.ok(response.body.notice);
  assert.equal(response.body.updatedAt, initial.body.updatedAt);
  assert.equal(response.body.source, "eastmoney");
  assert.deepEqual(response.body.series, initial.body.series);
  assert.equal(snapshotCalls, 0);
});

test("fundflow empty upstream results cannot overwrite the last successful cache", async () => {
  let empty = false;
  const { handler, redis } = createHarness({
    load: async (query) => empty ? { ...curve(query), count: 0, series: [] } : curve(query),
  });
  const initial = await request(handler);
  const writeCount = redis.writes.length;
  empty = true;
  const response = await request(handler, "dim=day&top=3&retry=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.stale, true);
  assert.deepEqual(response.body.series, initial.body.series);
  assert.equal(redis.writes.length, writeCount);
});

test("fundflow memory last-good remains available after Redis reads and writes fail", async () => {
  let fail = false;
  const { handler, clock, redis } = createHarness({
    load: async (query) => { if (fail) throw new Error("upstream unavailable"); return curve(query); },
  });
  const initial = await request(handler);
  redis.failGet = true;
  redis.failSet = true;
  fail = true;
  clock.ms += 121000;
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.stale, true);
  assert.deepEqual(response.body.series, initial.body.series);
});

test("fundflow network success is not blocked by Redis connection failure", async () => {
  const { handler } = createHarness({ getRedis: async () => { throw new Error("connection unavailable"); } });
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.count, 1);
});

test("fundflow last-good is isolated by dimension, top and requested date", async () => {
  let fail = false;
  const { handler } = createHarness({
    load: async (query) => { if (fail) throw new Error("upstream unavailable"); return curve(query); },
  });
  await request(handler);
  fail = true;
  for (const query of ["dim=week&top=3", "dim=day&top=4", "dim=day&top=3&date=2026-10-01"]) {
    const response = await request(handler, query);
    assert.equal(response.statusCode, 502, query);
    assert.equal(response.body.series, undefined, query);
  }
});

test("fundflow last-good has a bounded seven-day lifetime", async () => {
  let fail = false;
  const { handler, clock } = createHarness({
    load: async (query) => { if (fail) throw new Error("upstream unavailable"); return curve(query); },
  });
  await request(handler);
  fail = true;
  clock.ms += 7 * DAY_MS + 1;
  const response = await request(handler);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.stale, undefined);
});

test("fundflow cold day outage uses the declared real daily snapshot", async () => {
  let snapshotCalls = 0;
  const { handler } = createHarness({
    load: async () => { throw new Error("minute hosts unavailable"); },
    loadSnapshot: async () => { snapshotCalls += 1; return snapshot(); },
  });
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.source, "sina");
  assert.equal(response.body.mode, "daily-snapshot");
  assert.equal(response.body.asOfDate, "2026-09-30");
  assert.equal(response.body.series[0].points[0].t, "2026-09-30");
  assert.equal(response.body.series[0].points.length, 1);
  assert.equal(snapshotCalls, 1);
});

test("fundflow retry refreshes a previous snapshot instead of freezing it until last-good expires", async () => {
  let snapshotCalls = 0;
  const { handler, clock } = createHarness({
    load: async () => { throw new Error("minute hosts unavailable"); },
    loadSnapshot: async () => {
      snapshotCalls += 1;
      return snapshot({ dataDate: snapshotCalls === 1 ? "2026-09-30" : "2026-10-01", updatedAt: new Date(clock.ms).toISOString() });
    },
  });
  const initial = await request(handler);
  clock.ms += 10000;
  const response = await request(handler, "dim=day&top=3&retry=1");
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.body.stale, true);
  assert.equal(response.body.updatedAt, new Date(clock.ms).toISOString());
  assert.notEqual(response.body.updatedAt, initial.body.updatedAt);
  assert.equal(response.body.asOfDate, "2026-10-01");
  assert.equal(snapshotCalls, 2);
});

test("fundflow unsuccessful snapshot refresh preserves the real previous snapshot as stale", async () => {
  let snapshotCalls = 0;
  const { handler } = createHarness({
    load: async () => { throw new Error("minute hosts unavailable"); },
    loadSnapshot: async () => {
      snapshotCalls += 1;
      if (snapshotCalls > 1) throw new Error("snapshot unavailable");
      return snapshot();
    },
  });
  const initial = await request(handler);
  const response = await request(handler, "dim=day&top=3&retry=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.stale, true);
  assert.equal(response.body.updatedAt, initial.body.updatedAt);
  assert.deepEqual(response.body.series, initial.body.series);
  assert.equal(snapshotCalls, 2);
});

test("fundflow empty primary and empty daily snapshot return a diagnostic failure", async () => {
  const { handler, redis } = createHarness({
    load: async (query) => ({ ...curve(query), count: 0, series: [] }),
    loadSnapshot: async () => ({ ...snapshot(), count: 0, series: [] }),
  });
  const response = await request(handler);
  assert.equal(response.statusCode, 502);
  assert.ok(response.body.error);
  assert.ok(response.body.details);
  assert.equal(redis.writes.length, 0);
});

test("fundflow retry bypasses fresh cache and stores a newly successful response", async () => {
  let calls = 0;
  const { handler } = createHarness({
    load: async (query) => {
      calls += 1;
      const result = curve(query);
      result.series[0].final = calls * 2;
      result.series[0].points.at(-1).v = calls * 2;
      return result;
    },
  });
  await request(handler);
  const response = await request(handler, "dim=day&top=3&retry=1");
  const subsequent = await request(handler);
  assert.equal(calls, 2);
  assert.equal(response.body.series[0].final, 4);
  assert.deepEqual(subsequent.body.series, response.body.series);
});

test("fundflow concurrent requests for the same query share one upstream load", async () => {
  let calls = 0;
  let release;
  let announceStarted;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const { handler } = createHarness({
    load: async (query) => { calls += 1; announceStarted(); await waiting; return curve(query); },
  });
  const first = request(handler, "dim=day&top=3&retry=1");
  await started;
  const second = request(handler, "dim=day&top=3&retry=1");
  release();
  const responses = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(responses[0].statusCode, 200);
  assert.deepEqual(responses[0].body.series, responses[1].body.series);
});

test("fundflow explicitly selected Shanghai today uses the short intraday TTL", async () => {
  const nowMs = Date.parse("2026-10-01T20:00:00Z"); // 上海已是 10 月 2 日，UTC 仍是前一天。
  const { handler, redis } = createHarness({
    now: () => nowMs,
    load: async (query) => curve({ ...query, updatedAt: new Date(nowMs).toISOString() }),
  });
  const response = await request(handler, "dim=day&top=3&date=2026-10-02");
  assert.equal(response.statusCode, 200);
  assert.equal(redis.writes.find((write) => write.key === "board-fundflow:v2:day:3:2026-10-02")?.options.EX, 120);
  assert.equal(redis.writes.find((write) => write.key === "board-fundflow:lastgood:v2:day:3:2026-10-02")?.options.EX, 7 * 86400);
});

test("fundflow a past requested date uses a one-day fresh cache TTL", async () => {
  const { handler, redis } = createHarness({
    load: async (query) => curve({ ...query, dataDate: query.date }),
  });
  const response = await request(handler, "dim=day&top=3&date=2026-09-30");
  assert.equal(response.statusCode, 200);
  assert.equal(redis.writes.find((write) => write.key === "board-fundflow:v2:day:3:2026-09-30")?.options.EX, 86400);
});

test("fundflow latest week and month retain a ten-minute fresh cache TTL", async () => {
  const { handler, redis } = createHarness();
  for (const dim of ["week", "month"]) {
    const response = await request(handler, `dim=${dim}&top=3`);
    assert.equal(response.statusCode, 200);
    assert.equal(redis.writes.find((write) => write.key === `board-fundflow:v2:${dim}:3:latest`)?.options.EX, 600);
  }
});

test("fundflow rejects invalid calendar dates and future dates before requesting data", async () => {
  let calls = 0;
  const { handler } = createHarness({
    load: async (query) => { calls += 1; return curve(query); },
    loadSnapshot: async () => { calls += 1; return snapshot(); },
  });
  for (const date of ["not-a-date", "2026-02-31", "2026-02-29", "2026-10-03"]) {
    const response = await request(handler, `dim=day&top=3&date=${date}`);
    assert.equal(response.statusCode, 400, date);
    assert.ok(response.body.error, date);
  }
  assert.equal(calls, 0);
});

test("fundflow refuses minute data from a different explicitly requested date", async () => {
  const { handler, redis } = createHarness({
    load: async (query) => curve({ ...query, dataDate: "2026-10-02" }),
  });
  const response = await request(handler, "dim=day&top=3&date=2026-09-30");
  assert.equal(response.statusCode, 502);
  assert.equal(redis.writes.length, 0);
});

test("fundflow invalid point values are rejected rather than cached", async () => {
  const { handler, redis } = createHarness({
    load: async (query) => {
      const result = curve(query);
      result.series[0].points[1].v = Number.NaN;
      return result;
    },
  });
  const response = await request(handler);
  assert.equal(response.statusCode, 502);
  assert.equal(redis.writes.length, 0);
});

test("fundflow new snapshot format never overwrites the legacy shared cache key", async () => {
  const { handler, redis } = createHarness({
    load: async () => { throw new Error("minute hosts unavailable"); },
    loadSnapshot: async () => snapshot(),
  });
  const legacyKey = "board-fundflow:day:3:latest";
  // An unusable legacy entry ensures cold fallback while detecting any shared-key mutation.
  await redis.set(legacyKey, "{}", { EX: 120 });
  const writeCount = redis.writes.length;
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, "daily-snapshot");
  assert.equal(await redis.get(legacyKey), "{}");
  assert.equal(redis.writes.slice(writeCount).some((write) => write.key === legacyKey), false);
  const versioned = JSON.parse(await redis.get("board-fundflow:v2:day:3:latest"));
  assert.equal(versioned.mode, "daily-snapshot");
  assert.equal(versioned.source, "sina");
});

test("fundflow future update timestamps are rejected rather than cached", async () => {
  const { handler, redis } = createHarness({
    load: async (query) => curve({ ...query, updatedAt: new Date(START + 1000).toISOString() }),
  });
  const response = await request(handler);
  assert.equal(response.statusCode, 502);
  assert.equal(redis.writes.length, 0);
});

test("fundflow latest is refreshed across Shanghai midnight even within the two-minute TTL", async () => {
  let calls = 0;
  const { handler, clock } = createHarness({
    load: async (query) => {
      calls += 1;
      return curve({
        ...query,
        dataDate: calls === 1 ? "2026-10-01" : "2026-10-02",
        updatedAt: new Date(clock.ms).toISOString(),
      });
    },
  });
  clock.ms = Date.parse("2026-10-01T15:59:40Z"); // 上海 23:59:40。
  const initial = await request(handler);
  clock.ms += 30000; // 仅过 30 秒，但上海日期已改变。
  const response = await request(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(initial.body.dataDate, "2026-10-01");
  assert.equal(response.body.dataDate, "2026-10-02");
  assert.notEqual(response.body.updatedAt, initial.body.updatedAt);
});

test("fundflow invalid upstream update timestamps fall back to the previous genuine curve", async () => {
  let timestampMode = "valid";
  let snapshotCalls = 0;
  const { handler } = createHarness({
    load: async (query) => {
      const result = curve(query);
      if (timestampMode === "future") result.updatedAt = new Date(START + 1000).toISOString();
      if (timestampMode === "missing") delete result.updatedAt;
      return result;
    },
    loadSnapshot: async () => { snapshotCalls += 1; return snapshot(); },
  });
  const initial = await request(handler);
  for (const mode of ["future", "missing"]) {
    timestampMode = mode;
    const response = await request(handler, "dim=day&top=3&retry=1");
    assert.equal(response.statusCode, 200, mode);
    assert.equal(response.body.stale, true, mode);
    assert.equal(response.body.updatedAt, initial.body.updatedAt, mode);
    assert.deepEqual(response.body.series, initial.body.series, mode);
  }
  assert.equal(snapshotCalls, 0);
});

test("fundflow invalid fallback update timestamps preserve the previous genuine snapshot", async () => {
  let timestampMode = "valid";
  let snapshotCalls = 0;
  const { handler, redis } = createHarness({
    load: async () => { throw new Error("minute hosts unavailable"); },
    loadSnapshot: async () => {
      snapshotCalls += 1;
      const result = snapshot();
      if (timestampMode === "future") result.updatedAt = new Date(START + 1000).toISOString();
      if (timestampMode === "missing") delete result.updatedAt;
      return result;
    },
  });
  const initial = await request(handler);
  const writeCount = redis.writes.length;
  for (const mode of ["future", "missing"]) {
    timestampMode = mode;
    const response = await request(handler, "dim=day&top=3&retry=1");
    assert.equal(response.statusCode, 200, mode);
    assert.equal(response.body.stale, true, mode);
    assert.equal(response.body.updatedAt, initial.body.updatedAt, mode);
    assert.deepEqual(response.body.series, initial.body.series, mode);
  }
  assert.equal(snapshotCalls, 3);
  assert.equal(redis.writes.length, writeCount);
});
