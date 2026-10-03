import test from "node:test";
import assert from "node:assert/strict";
import { createMarketTradingSessionsProvider } from "./marketTradingSessions.js";

const NOW = Date.parse("2026-10-03T14:00:00Z");
const DATE = "2026-09-30";
// 9/25 is a market holiday. These actual sessions cross the holiday and weekend.
const DATES = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-28", "2026-09-29", DATE];
const row = (date) => [date, "3800", "3820", "3850", "3790", "100000"];
const body = (dates = DATES) => ({ code: 0, data: { sh000001: { day: dates.map(row) } } });
function fixture(transform = (value) => value) {
  const calls = [];
  return { calls, request: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return { ok: true, json: async () => transform(body()) };
  } };
}

test("real index sessions anchor the holiday dashboard and previous session", async () => {
  const fake = fixture();
  const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => NOW });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await load({ date: DATE, limit: 4 }), { date: DATE, previousDate: "2026-09-29",
    days: ["20260924", "20260928", "20260929", "20260930"], source: "tencent-index" });
  const { url, options } = fake.calls[0];
  assert.equal(url.origin, "https://web.ifzq.gtimg.cn");
  assert.equal(url.searchParams.get("param"), "sh000001,day,,,80,");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  // Limit changes the displayed history, never the true previous session.
  assert.equal((await load({ date: DATE, limit: 1 })).previousDate, "2026-09-29");
  assert.equal(fake.calls.length, 1);
});

test("an earlier quote date ignores later completed sessions and retains zero-limit-up days", async () => {
  const fake = fixture();
  const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => NOW });
  assert.deepEqual(await load({ date: "2026-09-28", limit: 20 }), { date: "2026-09-28", previousDate: "2026-09-24",
    days: ["20260922", "20260923", "20260924", "20260928"], source: "tencent-index" });
});

test("cache is isolated by quote date and expires or bypasses on force", async () => {
  let at = NOW;
  const fake = fixture();
  const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => at });
  await load({ date: DATE });
  const result = await load({ date: DATE });
  result.days.push("corrupted-client-result");
  assert.equal((await load({ date: DATE })).days.length, DATES.length);
  await load({ date: "2026-09-29" });
  assert.equal(fake.calls.length, 2);
  at += 59999;
  await load({ date: DATE });
  assert.equal(fake.calls.length, 2);
  at += 1;
  await load({ date: DATE });
  assert.equal(fake.calls.length, 3);
  await load({ date: DATE, force: true });
  assert.equal(fake.calls.length, 4);
  at -= 100000;
  await load({ date: DATE });
  assert.equal(fake.calls.length, 5);
});

test("concurrent requests share one lookup while each caller retains its history limit", async () => {
  let release;
  let calls = 0;
  const load = createMarketTradingSessionsProvider({ now: () => NOW, request: async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => body() };
  } });
  const first = load({ date: DATE, limit: 2 });
  const second = load({ date: DATE, limit: 4, force: true });
  assert.equal(calls, 1);
  release();
  const [short, long] = await Promise.all([first, second]);
  assert.equal(short.days.length, 2);
  assert.equal(long.days.length, 4);
  assert.equal(calls, 1);
});

test("invalid input and future dates fail before any network request", async (t) => {
  for (const args of [undefined, {}, { date: "2026-02-30" }, { date: "2026-10-04" },
    { date: DATE, limit: 0 }, { date: DATE, limit: 81 }, { date: DATE, limit: "20" }, { date: DATE, limit: 2.5 }]) {
    await t.test(JSON.stringify(args) || "undefined", async () => {
      const fake = fixture();
      const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => NOW });
      await assert.rejects(load(args), (error) => error.code === "TS_INPUT_INVALID");
      assert.equal(fake.calls.length, 0);
    });
  }
});

test("Shanghai date boundary governs future-date validation", async () => {
  const fake = fixture(() => body(["2026-09-29", DATE]));
  const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => Date.parse("2026-09-29T17:00:00Z") });
  assert.equal((await load({ date: DATE })).date, DATE);
});

test("missing requested session cannot be replaced with a weekday or another date", async (t) => {
  for (const date of ["2026-09-25", "2026-09-26", "2026-06-01", "2026-10-01"]) await t.test(date, async () => {
    const fake = fixture();
    const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => NOW });
    await assert.rejects(load({ date }), (error) => error.code === "TS_SESSION_MISSING");
    await assert.rejects(load({ date }), (error) => error.code === "TS_SESSION_MISSING");
    assert.equal(fake.calls.length, 2);
  });
});

test("invalid index rows, identity and dates are rejected without caching", async (t) => {
  const cases = [
    ["nonzero status", (value) => ({ ...value, code: -1 })],
    ["wrong index", () => ({ code: 0, data: { sz399001: { day: DATES.map(row) } } })],
    ["empty", () => body([])],
    ["duplicate", () => body([...DATES, DATE])],
    ["unordered", () => body([...DATES].reverse())],
    ["invalid calendar date", () => body(["2026-02-30", ...DATES])],
    ["future row", () => body([...DATES, "2026-10-04"])],
    ["short row", (value) => { value.data.sh000001.day[0] = [DATES[0]]; return value; }],
    ["not array", (value) => { value.data.sh000001.day[0] = { 0: DATES[0] }; return value; }],
    ["unknown close", (value) => { value.data.sh000001.day[0][2] = null; return value; }],
    ["zero close", (value) => { value.data.sh000001.day[0][2] = 0; return value; }],
    ["blank close", (value) => { value.data.sh000001.day[0][2] = " "; return value; }],
    ["unknown volume", (value) => { value.data.sh000001.day[0][5] = "-"; return value; }],
    ["negative volume", (value) => { value.data.sh000001.day[0][5] = -1; return value; }],
  ];
  for (const [name, transform] of cases) await t.test(name, async () => {
    const fake = fixture(transform);
    const load = createMarketTradingSessionsProvider({ request: fake.request, now: () => NOW });
    await assert.rejects(load({ date: DATE }), (error) => error.code === "TS_RESPONSE_INVALID");
    await assert.rejects(load({ date: DATE }), (error) => error.code === "TS_RESPONSE_INVALID");
    assert.equal(fake.calls.length, 2);
  });
});

test("HTTP, network and malformed JSON failures are retryable", async (t) => {
  for (const [name, request, code] of [
    ["HTTP", async () => ({ ok: false }), "TS_HTTP_ERROR"],
    ["network", async () => { throw new Error("network"); }, "TS_NETWORK_ERROR"],
    ["JSON", async () => ({ ok: true, json: async () => { throw new Error("parse"); } }), "TS_RESPONSE_INVALID"],
  ]) await t.test(name, async () => {
    let calls = 0;
    const load = createMarketTradingSessionsProvider({ now: () => NOW, request: async (...args) => {
      calls += 1;
      if (calls === 1) return request(...args);
      return { ok: true, json: async () => body() };
    } });
    await assert.rejects(load({ date: DATE }), (error) => error.code === code);
    assert.equal((await load({ date: DATE })).date, DATE);
    assert.equal(calls, 2);
  });
});
