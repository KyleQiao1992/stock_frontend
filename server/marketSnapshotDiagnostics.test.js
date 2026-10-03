import test from "node:test";
import assert from "node:assert/strict";
import { createMarketSnapshotCache } from "./marketSnapshotCache.js";

const NOW = Date.parse("2026-10-03T02:00:00Z");
const KEY = "diagnostic-market:v1";
const SECRET = "synthetic-secret-must-not-be-logged";

function create(overrides = {}) {
  return createMarketSnapshotCache({
    key: KEY, freshMs: 60000, staleMs: 900000, now: () => NOW,
    validate: (body) => body?.live === true && body.marker === "valid",
    emptyClosed: () => ({live: false}),
    ...overrides,
  });
}

function captureWarnings(t) {
  const messages = [];
  t.mock.method(console, "warn", (...args) => messages.push(args.join(" ")));
  return messages;
}

function body(options = {}) {
  return {live: true, marker: "valid", updatedAt: new Date(NOW).toISOString(), quoteTime: "2026-09-30T08:30:00Z", ...options};
}

test("HTTP fallback failures identify the quote stage without logging upstream secrets", async (t) => {
  const messages = captureWarnings(t);
  const httpError = Object.assign(new Error(`HTTP 403 https://example.invalid/?token=${SECRET}`), {
    code: "SINA_HTTP_ERROR", stage: "quotes", status: 403, headers: {Authorization: SECRET},
  });
  const cache = create({
    load: async () => { throw new Error(`primary ${SECRET}`); },
    loadFallback: async () => { throw new Error(`wrapped ${SECRET}`, {cause: httpError}); },
  });
  await assert.rejects(cache.get(null, {retry: true}), /没有可用的历史快照/);
  assert.deepEqual(messages, [
    `[${KEY}] primary failed (type=upstream, code=unknown, stage=unknown, status=unknown)`,
    `[${KEY}] fallback failed (type=upstream, code=SINA_HTTP_ERROR, stage=quotes, status=403)`,
  ]);
  assert.equal(messages.some((message) => message.includes(SECRET) || message.includes("https://")), false);
});

test("wrapped network failures retain their specific cause code and controlled provider stage", async (t) => {
  const messages = captureWarnings(t);
  const cause = Object.assign(new TypeError(`request ${SECRET}`), {code: "ETIMEDOUT"});
  const wrapped = Object.assign(new Error(`wrapped ${SECRET}`, {cause}), {
    code: "SINA_NETWORK_ERROR", stage: "universe-page",
  });
  const cache = create({load: async () => { throw wrapped; }});
  await assert.rejects(cache.get(null, {retry: true}));
  assert.deepEqual(messages, [
    `[${KEY}] primary failed (type=network, code=ETIMEDOUT, stage=universe-page, status=unknown)`,
  ]);
});

test("Tencent quote failure codes retain controlled diagnostics without exposing raw provider data", async (t) => {
  const messages = captureWarnings(t);
  for (const code of ["TENCENT_HTTP_ERROR", "TENCENT_NETWORK_ERROR", "TENCENT_TIMEOUT", "TENCENT_RESPONSE_INVALID", "TENCENT_COVERAGE_INCOMPLETE"]) {
    const error = Object.assign(new Error(`https://example.invalid/?token=${SECRET}`), {
      code, stage: "quotes", ...(code === "TENCENT_HTTP_ERROR" ? {status: 403} : {}),
    });
    const cache = create({load: async () => {throw new Error(SECRET);}, loadFallback: async () => {throw error;}});
    await assert.rejects(cache.get(null, {retry: true}));
    assert.equal(messages.at(-1), `[${KEY}] fallback failed (type=upstream, code=${code}, stage=quotes, status=${code === "TENCENT_HTTP_ERROR" ? 403 : "unknown"})`);
  }
  assert.equal(messages.some((message) => message.includes(SECRET) || message.includes("https://")), false);
});

test("arbitrary codes and stages are suppressed and HTTP status must be an integer in range", async (t) => {
  const messages = captureWarnings(t);
  for (const [status, expected] of [[99, "unknown"], [600, "unknown"], [403.5, "unknown"], ["403", "unknown"], [100, 100], [599, 599]]) {
    const error = Object.assign(new Error(SECRET), {
      code: "ARBITRARY_SECRET", stage: `quotes\n${SECRET}`, status,
    });
    const cache = create({load: async () => { throw error; }});
    await assert.rejects(cache.get(null, {retry: true}));
    assert.equal(messages.at(-1), `[${KEY}] primary failed (type=upstream, code=unknown, stage=unknown, status=${expected})`);
  }
  assert.equal(messages.some((message) => message.includes(SECRET) || message.includes("ARBITRARY_SECRET")), false);
});

test("nested HTTP statusCode is accepted while cause traversal is bounded even for cycles", async (t) => {
  const messages = captureWarnings(t);
  const nested = Object.assign(new Error(SECRET), {code: "SINA_HTTP_ERROR", stage: "industry-directory", statusCode: 503});
  nested.cause = nested;
  const cache = create({load: async () => { throw new Error(SECRET, {cause: nested}); }});
  await assert.rejects(cache.get(null, {retry: true}));
  assert.deepEqual(messages, [
    `[${KEY}] primary failed (type=upstream, code=SINA_HTTP_ERROR, stage=industry-directory, status=503)`,
  ]);
});

test("snapshot validation errors have distinct primary and fallback diagnostics", async (t) => {
  const messages = captureWarnings(t);
  const cache = create({load: async () => ({live: true}), loadFallback: async () => ({live: true})});
  await assert.rejects(cache.get(null, {retry: true}));
  assert.deepEqual(messages, [
    `[${KEY}] primary failed (type=upstream, code=PRIMARY_SNAPSHOT_INVALID, stage=snapshot-validation, status=unknown)`,
    `[${KEY}] fallback failed (type=upstream, code=FALLBACK_SNAPSHOT_INVALID, stage=snapshot-validation, status=unknown)`,
  ]);
});

test("an older alternate has an identifiable rejection while the original cached payload stays intact", async (t) => {
  const messages = captureWarnings(t);
  const original = body({updatedAt: new Date(NOW - 3600000).toISOString()});
  const redis = {async get(key) {return key === `${KEY}:lastgood` ? JSON.stringify(original) : null;}};
  const cache = create({
    load: async () => { throw new Error(SECRET); },
    loadFallback: async () => body({quoteTime: "2026-09-30T07:00:00Z", mode: "snapshot", source: "sina"}),
  });
  const result = await cache.get(redis, {retry: true});
  assert.equal(result.stale, true);
  assert.equal(result.quoteTime, original.quoteTime);
  assert.equal(result.updatedAt, original.updatedAt);
  assert.equal(messages.at(-1), `[${KEY}] fallback failed (type=upstream, code=FALLBACK_QUOTE_OLDER, stage=quote-comparison, status=unknown)`);
});


test("classification and dated-capital failures expose controlled codes without raw provider payloads", async (t) => {
  const messages = captureWarnings(t);
  for (const [code, stage] of [["EASTMONEY_CLASSIFICATION_INVALID", "industry-map"],
    ["EM_CAPITAL_CLOSE_MISMATCH", "market-capital"], ["EM_CAPITAL_COVERAGE_INCOMPLETE", "market-capital"]]) {
    const cache = create({load: async () => {throw new Error(SECRET);},
      loadFallback: async () => {throw Object.assign(new Error(SECRET), {code, stage});}});
    await assert.rejects(cache.get(null, {retry: true}));
    assert.equal(messages.at(-1), `[${KEY}] fallback failed (type=upstream, code=${code}, stage=${stage}, status=unknown)`);
  }
  assert.ok(messages.every((line) => !line.includes(SECRET)));
});
