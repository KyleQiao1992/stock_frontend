import test from "node:test";
import assert from "node:assert/strict";
import { MARKET_INDICES, createMarketIndicesProvider, createMarketIndicesHandler } from "./marketIndices.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const SYMBOLS = ["sh000001", "sh000688", "sz399001", "sz399006"];

function quote(symbol, mutate = () => {}) {
  const fields = new Array(33).fill("");
  fields[1] = "INDEX";
  fields[2] = symbol.slice(2);
  fields[3] = "3716.28";
  fields[4] = "3707.38";
  fields[30] = "20261016150000";
  fields[31] = "8.90";
  fields[32] = "0.24";
  mutate(fields);
  return `v_${symbol}="${fields.join("~")}";`;
}

const body = () => SYMBOLS.map((symbol) => quote(symbol)).join("\n");
const response = (text = body()) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text) });

test("one batch requests explicit exchange symbols and preserves provider quote time", async () => {
  const calls = [];
  const load = createMarketIndicesProvider({ now: () => NOW, request: async (url, options) => {
    calls.push({ url, options });
    return response();
  } });
  assert.equal(calls.length, 0);
  const result = await load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qt.gtimg.cn/q=sh000001,sh000688,sz399001,sz399006");
  assert.equal(calls[0].options.cache, "no-store");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.Referer, "https://gu.qq.com/");
  assert.equal(result.source, "tencent");
  assert.equal(result.partial, false);
  assert.equal(result.updatedAt, "2026-10-17T12:00:00.000Z");
  assert.deepEqual(result.indices[0], {
    code: "000001", name: "上证指数", tencentSymbol: "sh000001", available: true,
    price: 3716.28, change: 8.9, pct: 0.24, quoteTime: "2026-10-16T15:00:00+08:00",
  });
  assert.deepEqual(result.indices.map((index) => index.tencentSymbol), SYMBOLS);
});

test("partial batches report each missing or invalid index without substituting a stock", async () => {
  const load = createMarketIndicesProvider({ now: () => NOW, request: async () => response([
    quote("sz000001"),
    quote("sh000688"),
    quote("sz399001", (fields) => { fields[2] = "000001"; }),
  ].join("\n")) });
  const result = await load();
  assert.equal(result.partial, true);
  assert.deepEqual(result.indices.map((index) => index.available), [false, true, false, false]);
  for (const index of result.indices.filter((index) => !index.available)) {
    assert.ok(index.error);
    assert.equal(index.price, undefined);
    assert.equal(index.pct, undefined);
    assert.equal(index.quoteTime, undefined);
  }
  assert.match(result.indices[0].error, /未返回/);
  assert.match(result.indices[2].error, /身份/);
});

test("invalid numeric fields, inconsistency and impossible quote times are explicitly rejected", async (t) => {
  const cases = [
    ["blank price", 3, ""], ["zero price", 3, "0"], ["nonfinite price", 3, "Infinity"],
    ["blank previous close", 4, ""], ["zero previous close", 4, "0"],
    ["blank change", 31, " "], ["inconsistent change", 31, "9.90"],
    ["blank pct", 32, ""], ["inconsistent pct", 32, "24"], ["impossible pct", 32, "-100"],
    ["missing time", 30, ""], ["invalid date", 30, "20260230150000"],
    ["invalid hour", 30, "20261016240000"], ["invalid minute", 30, "20261016156000"],
    ["future quote", 30, "20261018150000"],
  ];
  for (const [label, field, value] of cases) await t.test(label, async () => {
    const load = createMarketIndicesProvider({ now: () => NOW, request: async () => response([
      quote("sh000001", (fields) => { fields[field] = value; }), quote("sh000688"),
    ].join("\n")) });
    const result = await load();
    assert.equal(result.indices[0].available, false);
    assert.ok(result.indices[0].error);
    assert.equal(result.indices[1].available, true);
  });
});

test("duplicate quotes are unavailable while flat and negative changes remain valid", async () => {
  const load = createMarketIndicesProvider({ now: () => NOW, request: async () => response([
    quote("sh000001"), quote("sh000001"),
    quote("sh000688", (fields) => { fields[3] = fields[4]; fields[31] = "0"; fields[32] = "0"; }),
    quote("sz399001", (fields) => { fields[3] = "3698.48"; fields[31] = "-8.90"; fields[32] = "-0.24"; }),
  ].join("\n")) });
  const result = await load();
  assert.equal(result.indices[0].available, false);
  assert.match(result.indices[0].error, /重复/);
  assert.equal(result.indices[1].pct, 0);
  assert.equal(result.indices[2].pct, -0.24);
});

test("30 second cache is bounded, isolates caller mutations and refetches after clock rollback", async () => {
  let at = NOW;
  let calls = 0;
  const load = createMarketIndicesProvider({ now: () => at, request: async () => { calls += 1; return response(); } });
  const first = await load();
  first.indices[0].price = 1;
  first.indices.pop();
  at += 29_999;
  assert.equal((await load()).indices[0].price, 3716.28);
  assert.equal((await load()).indices.length, 4);
  assert.equal(calls, 1);
  at += 1;
  await load();
  assert.equal(calls, 2);
  at -= 1;
  await load();
  assert.equal(calls, 3);
});

test("simultaneous callers share the pending batch and receive independent results", async () => {
  let release;
  let calls = 0;
  const load = createMarketIndicesProvider({ now: () => NOW, request: async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return response();
  } });
  const first = load();
  const second = load();
  assert.equal(calls, 1);
  release();
  const [one, two] = await Promise.all([first, second]);
  one.indices[0].price = 1;
  assert.equal(two.indices[0].price, 3716.28);
  assert.equal(calls, 1);
});

test("all invalid results are errors, are not cached, and do not reuse an expired success", async () => {
  let at = NOW;
  let calls = 0;
  const load = createMarketIndicesProvider({ now: () => at, request: async () => {
    calls += 1;
    return response(calls === 1 ? body() : quote("sz000001"));
  } });
  await load();
  at += 30_000;
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(load(), (error) => {
      assert.equal(error.indices.length, 4);
      assert.ok(error.indices.every((index) => index.available === false && index.error));
      return true;
    });
  }
  assert.equal(calls, 3);
});

async function invoke(load) {
  const headers = {};
  const res = { setHeader(name, value) { headers[name] = value; }, end(value) { this.body = JSON.parse(value); } };
  await createMarketIndicesHandler({ load })({}, res);
  return { ...res, headers };
}

test("handler preserves partial success and returns 502 with all four states on upstream failures", async (t) => {
  const partial = createMarketIndicesProvider({ now: () => NOW, request: async () => response(quote("sh000001")) });
  const success = await invoke(partial);
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.ok, true);
  assert.equal(success.body.partial, true);
  assert.equal(success.headers["Cache-Control"], "no-store");
  for (const [label, request] of [
    ["network/timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["http", async () => ({ ok: false, status: 503 })],
    ["body failure", async () => ({ ok: true, arrayBuffer: async () => { throw new Error("closed"); } })],
    ["empty response", async () => response("")],
  ]) await t.test(label, async () => {
    const load = createMarketIndicesProvider({ now: () => NOW, request });
    const failed = await invoke(load);
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.ok, false);
    assert.ok(failed.body.error);
    assert.equal(failed.body.indices.length, MARKET_INDICES.length);
    assert.ok(failed.body.indices.every((index) => index.available === false && index.error && index.price === undefined));
  });
});
