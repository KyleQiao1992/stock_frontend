import test from "node:test";
import assert from "node:assert/strict";
import { fetchConceptBoardList } from "./boardTrend.js";

const PRIMARY = "https://push2delay.eastmoney.com";
const SECONDARY = "https://push2.eastmoney.com";

function rawBoard(code, name, inflow = 100) {
  return { f12: code, f14: name, f2: "12.34", f3: "1.25", f62: inflow };
}

function page(diff, total = 1) {
  return { ok: true, json: async () => ({ data: { diff, total } }) };
}

function stubFetch(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url);
    const call = { host: parsed.origin, page: Number(parsed.searchParams.get("pn")), options };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

test("default directory loading merges pages, normalizes board codes, and keeps the first duplicate", async (t) => {
  const calls = stubFetch(t, ({ page: pn }) => {
    if (pn === 1) return page([rawBoard("1001", " First ", "100"), rawBoard("bad", "Invalid")], 201);
    if (pn === 2) return page({ 0: rawBoard("BK1002", "Second", "-200"), 1: rawBoard("1001", "Duplicate") }, 201);
    return page([rawBoard("bk1003", "Third", 300)], 201);
  });

  const result = await fetchConceptBoardList();
  assert.deepEqual(result, [
    { code: "BK1001", name: "First", price: 12.34, pct: 1.25, mainInflow: 100 },
    { code: "BK1002", name: "Second", price: 12.34, pct: 1.25, mainInflow: -200 },
    { code: "BK1003", name: "Third", price: 12.34, pct: 1.25, mainInflow: 300 },
  ]);
  assert.deepEqual(calls.map(({ host, page: pn }) => [host, pn]), [[PRIMARY, 1], [PRIMARY, 2], [PRIMARY, 3]]);
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal && !options.signal.aborted));
});

test("default loading still falls back to the next host after a network failure", async (t) => {
  const calls = stubFetch(t, ({ host }) => {
    if (host === PRIMARY) throw new Error("upstream unavailable");
    return page([rawBoard("1002", "Fallback")]);
  });

  const result = await fetchConceptBoardList();
  assert.equal(result[0].name, "Fallback");
  assert.deepEqual(calls.map(({ host }) => host), [PRIMARY, SECONDARY]);
});

test("an already aborted signal never starts an upstream request", async (t) => {
  const calls = stubFetch(t, () => { throw new Error("must not be called"); });
  const controller = new AbortController();
  controller.abort(new Error("cancelled before request"));

  await assert.rejects(fetchConceptBoardList({ signal: controller.signal }), /概念板块列表不可用/);
  assert.equal(calls.length, 0);
});

test("aborting an active request propagates to fetch and prevents further host attempts", { timeout: 1000 }, async (t) => {
  const controller = new AbortController();
  const calls = stubFetch(t, ({ options }) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    setImmediate(() => controller.abort(new Error("cancelled in flight")));
  }));

  await assert.rejects(fetchConceptBoardList({ signal: controller.signal }), /cancelled in flight/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
});

test("signal-aware loading rejects a missing page and retries the complete directory on the next host", async (t) => {
  const calls = stubFetch(t, ({ host, page: pn }) => {
    if (host === PRIMARY && pn === 2) return { ok: false, status: 503 };
    if (host === PRIMARY) return page([rawBoard("1001", "Incomplete")], 101);
    return page([rawBoard("1002", "Complete")]);
  });

  const result = await fetchConceptBoardList({ signal: new AbortController().signal });
  assert.deepEqual(result.map(({ name }) => name), ["Complete"]);
  assert.deepEqual(calls.map(({ host, page: pn }) => [host, pn]), [[PRIMARY, 1], [PRIMARY, 2], [SECONDARY, 1]]);
});

test("signal-aware loading never returns an incomplete ranking when every host is missing pages", async (t) => {
  const calls = stubFetch(t, ({ page: pn }) => pn === 1
    ? page([rawBoard("1001", "Incomplete")], 101)
    : page([], 101));

  await assert.rejects(
    fetchConceptBoardList({ signal: new AbortController().signal }),
    /目录分页未完成，无法确定资金流排名/,
  );
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls.map(({ host }) => host)).size, 4);
});

test("default loading preserves the existing partial-page behavior for board trend callers", async (t) => {
  const calls = stubFetch(t, ({ page: pn }) => {
    if (pn === 1) return page([rawBoard("1001", "First")], 201);
    if (pn === 2) throw new Error("page request failed");
    return page([rawBoard("1003", "Third")], 201);
  });

  const result = await fetchConceptBoardList();
  assert.deepEqual(result.map(({ code }) => code), ["BK1001", "BK1003"]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ host }) => host === PRIMARY));
});
