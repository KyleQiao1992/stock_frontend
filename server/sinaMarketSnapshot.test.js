import test from "node:test";
import assert from "node:assert/strict";
import { createSinaMarketSnapshotProvider } from "./sinaMarketSnapshot.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const fixture = [
  { symbol: "sh600519", code: "600519", name: "Maotai", trade: "1258.620", settlement: "1235.580", changepercent: 1.865, open: "1239.530", amount: 4797246636, mktcap: 157337770.46506, nmc: 157337770.46506 },
  { symbol: "bj920000", code: "920000", name: "Phoenix", trade: "14.330", settlement: "14.250", changepercent: 0.561, open: "14.210", amount: 11981095, mktcap: 131377.44, nmc: 82532.094525 },
];

function source({ rows = fixture, dates = {}, industries = [], fail, count = rows.length, hqRows = {} } = {}) {
  const calls = [];
  const request = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, signal: options.signal });
    if (fail?.(parsed)) throw new Error("fixture unavailable");
    if (parsed.pathname.endsWith("getHQNodeStockCount")) return { ok: true, json: async () => String(count) };
    if (parsed.pathname.endsWith("getHQNodeData")) {
      const node = parsed.searchParams.get("node");
      const page = Number(parsed.searchParams.get("page"));
      const data = node === "hs_a" ? rows : industries.find((item) => item.code === node)?.members || [];
      return { ok: true, json: async () => data.slice((page - 1) * 100, page * 100) };
    }
    if (parsed.pathname.endsWith("newSinaHy.php")) {
      const directory = Object.fromEntries(industries.map((item) => [item.code, `${item.code},${item.name},${item.declaredCount ?? item.members.length},1`]));
      const bytes = new TextEncoder().encode(`var directory = ${JSON.stringify(directory)};`);
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    }
    if (parsed.hostname === "hq.sinajs.cn" || parsed.hostname === "qt.gtimg.cn") {
      const tencent = parsed.hostname === "qt.gtimg.cn";
      const symbols = parsed.pathname.slice(tencent ? "/q=".length : "/list=".length).split(",");
      const text = symbols.map((symbol) => {
        const values = new Array(tencent ? 38 : 32).fill("");
        const row = { ...rows.find((item) => item.symbol === symbol), ...hqRows[symbol] };
        if (tencent) values[2] = symbol.slice(2);
        values[tencent ? 5 : 1] = row?.open ?? "";
        values[tencent ? 4 : 2] = row?.settlement ?? "";
        values[3] = row?.trade ?? "";
        values[tencent ? 37 : 9] = row?.amount == null || row.amount === "" ? "" : tencent ? row.amount / 10000 : row.amount;
        const date = dates[symbol] === undefined ? ["2026-09-30", "15:30:00"] : dates[symbol];
        if (date) {
          if (tencent) values[30] = date.join("").replaceAll(/[-:]/g, "");
          else [values[30], values[31]] = date;
        }
        return tencent ? `v_${symbol}="${values.join("~")}";` : `var hq_str_${symbol}="${values.join(",")}";`;
      }).join("\n");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    }
    throw new Error(`unexpected fixture URL ${url}`);
  };
  return { request, calls };
}

test("normalizes real amount/capital units and keeps Shanghai/Beijing quotes with provider timestamps", async () => {
  const fake = source();
  const load = createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW });
  const data = await load();
  assert.equal(data.stocks.length, 2);
  const [sh, bj] = data.stocks;
  assert.equal(sh.amount, 4797246636); // 元，不能再乘万元。
  assert.ok(Math.abs(sh.cap - 1573377704650.6) < 1);
  assert.ok(Math.abs(sh.floatCap - 1573377704650.6) < 1);
  assert.ok(Math.abs(bj.cap - 1313774400) < 0.01);
  assert.ok(Math.abs(bj.floatCap - 825320945.25) < 0.01);
  assert.equal(bj.exchange, "bj");
  assert.equal(sh.market, 1);
  assert.equal(bj.market, 0);
  assert.equal(sh.close, 1258.62);
  assert.ok(Math.abs(sh.pct - 1.8647113096683339) < 1e-8);
  assert.equal(sh.quoteAt, Date.parse("2026-09-30T15:30:00+08:00") / 1000);
  assert.notEqual(sh.quoteAt, NOW / 1000);
  assert.equal(data.source, "sina");
  assert.equal(data.classification, null);
  assert.equal(data.date, "2026-09-30");
  assert.deepEqual(data.coverage, { expected: 2, received: 2, dated: 2 });
  assert.ok(data.stocks.every((row) => row.mainInflow === null && row.industry === null));
});

test("preserves older suspended quotes and exposes mixed dates instead of silently deleting stocks", async () => {
  const fake = source({ dates: { sh600519: ["2026-09-29", "15:00:00"], bj920000: ["2026-09-30", "15:30:00"] } });
  const data = await createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW })();
  assert.equal(data.stocks.length, 2);
  assert.equal(data.date, "2026-09-30");
  assert.deepEqual(data.quoteDateRange, { from: "2026-09-29", to: "2026-09-30" });
  assert.deepEqual(data.quoteDateCounts, { "2026-09-29": 1, "2026-09-30": 1 });
});

test("missing fields and missing individual dates remain null rather than being filled with zero or fetch time", async () => {
  const rows = [{ ...fixture[0], amount: "", mktcap: null, nmc: "-", open: null, settlement: null }, fixture[1]];
  const fake = source({ rows, dates: { sh600519: null } });
  const data = await createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW })();
  const missing = data.stocks[0];
  for (const field of ["amount", "cap", "floatCap", "open", "pct", "mainInflow", "quoteAt"]) assert.equal(missing[field], null);
  assert.equal(data.coverage.dated, 1);
  const undated = source({ dates: { sh600519: ["2026-02-30", "15:00:00"], bj920000: null } });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: undated.request, now: () => NOW })(), /没有真实行情日期/);
});

test("full snapshot rejects an unavailable page, duplicate identities, and a partial count", async () => {
  const failed = source({ fail: (url) => url.pathname.endsWith("getHQNodeData") });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: failed.request })(), /fixture unavailable/);
  const duplicated = source({ rows: [fixture[0], fixture[0]] });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: duplicated.request })(), /去重后覆盖不完整/);
  const partial = source({ count: 3 });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: partial.request })(), /页不完整/);
});

test("Sina industry labels are explicit and conflicts/unmapped Beijing stock do not disappear", async () => {
  const rows = [...fixture, { ...fixture[0], symbol: "sz000001", code: "000001", name: "Bank" }];
  const fake = source({ rows, industries: [
    { code: "new_alpha", name: "Alpha", members: [fixture[0], rows[2]] },
    { code: "new_beta", name: "Beta", members: [rows[2]] },
    { code: "new_stock", name: "New stock", members: rows },
  ] });
  const data = await createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW })({ withIndustries: true });
  assert.equal(data.classification, "新浪行业");
  assert.equal(data.stocks[0].industry, "Alpha");
  assert.equal(data.stocks[1].industry, null);
  assert.equal(data.stocks[2].industry, null);
  assert.deepEqual(data.classificationCoverage, { classified: 1, total: 3, unclassified: 2, conflicts: 1 });
  assert.ok(!fake.calls.some((call) => call.url.searchParams.get("node") === "new_stock"));
});

test("only a successful nonempty industry map is cached and quotes continue refreshing", async () => {
  const fake = source({ industries: [{ code: "new_alpha", name: "Alpha", members: [fixture[0]] }] });
  const load = createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW });
  await load({ withIndustries: true });
  await load({ withIndustries: true });
  assert.equal(fake.calls.filter((call) => call.url.pathname.endsWith("newSinaHy.php")).length, 1);
  assert.equal(fake.calls.filter((call) => call.url.hostname === "hq.sinajs.cn").length, 2);
  const empty = source();
  const retry = createSinaMarketSnapshotProvider({ request: empty.request, now: () => NOW });
  await assert.rejects(retry({ withIndustries: true }), /行业目录无效/);
  await assert.rejects(retry({ withIndustries: true }), /行业目录无效/);
  assert.equal(empty.calls.filter((call) => call.url.pathname.endsWith("newSinaHy.php")).length, 2);
});

test("aborted requests and exceeded budgets never return a synthetic snapshot", async () => {
  const fake = source();
  const controller = new AbortController();
  controller.abort(new Error("stop now"));
  await assert.rejects(createSinaMarketSnapshotProvider({ request: fake.request })({ signal: controller.signal }), /stop now/);
  assert.equal(fake.calls.length, 0);
  let time = NOW;
  const request = async (...args) => {
    const response = await fake.request(...args);
    time += 25001;
    return response;
  };
  await assert.rejects(createSinaMarketSnapshotProvider({ request, now: () => time })(), /查询超时/);
});

test("a fresher HQ quote supplies its own prices and amount instead of inheriting the node values", async () => {
  const fake = source({ hqRows: { sh600519: { trade: "1300", open: "1260", amount: "5000000000" } } });
  const data = await createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW })();
  assert.equal(data.stocks[0].close, 1300);
  assert.equal(data.stocks[0].open, 1260);
  assert.equal(data.stocks[0].amount, 5000000000);
  assert.notEqual(data.stocks[0].pct, fixture[0].changepercent);
  assert.equal(data.stocks[0].quoteDate, "2026-09-30");
  assert.equal(data.metadata.dataDate, "2026-09-30");
});

test("a wholly obsolete or future market cannot be refreshed by stamping the current fetch time", async () => {
  const stale = source({ dates: { sh600519: ["2026-09-01", "15:00:00"], bj920000: ["2026-09-01", "15:00:00"] } });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: stale.request, now: () => NOW })(), /行情日期过旧/);
  const future = source({ dates: { sh600519: ["2026-10-04", "15:00:00"], bj920000: ["2026-10-04", "15:00:00"] } });
  await assert.rejects(createSinaMarketSnapshotProvider({ request: future.request, now: () => NOW })(), /没有真实行情日期/);
});

test("all pages remain bounded to six requests, and failure settles in-flight workers before returning", async () => {
  const rows = Array.from({ length: 701 }, (_, index) => ({ ...fixture[0], symbol: `sh${600000 + index}`, code: String(600000 + index) }));
  const fake = source({ rows });
  let active = 0;
  let peak = 0;
  const request = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await fake.request(...args);
    active -= 1;
    return result;
  };
  const data = await createSinaMarketSnapshotProvider({ request, now: () => NOW })();
  assert.equal(data.stocks.length, 701);
  assert.equal(peak, 6);
  assert.equal(active, 0);
  let pageCalls = 0;
  const failed = async (url, options) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("getHQNodeData")) return fake.request(url, options);
    pageCalls += 1;
    if (parsed.searchParams.get("page") === "1") throw new Error("page failed");
    active += 1;
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return fake.request(url, options);
  };
  await assert.rejects(createSinaMarketSnapshotProvider({ request: failed, now: () => NOW })(), /page failed/);
  assert.ok(pageCalls <= 6);
  assert.equal(active, 0);
});

test("an invalid huge industry directory never allocates unbounded member tasks", async () => {
  const fake = source();
  const request = async (url, options) => {
    if (url.includes("newSinaHy")) return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('var list={"new_alpha":"new_alpha,Alpha,999999999999999,1"};').buffer,
    };
    return fake.request(url, options);
  };
  await assert.rejects(createSinaMarketSnapshotProvider({ request, now: () => NOW })({ withIndustries: true }), /行业成员数量无效/);
  assert.ok(!fake.calls.some((call) => call.url.searchParams.get("node") === "new_alpha"));
});

test("an outdated industry count cannot truncate actual members, and an empty result cannot poison its cache", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...fixture[0], symbol: `sh${600000 + index}`, code: String(600000 + index) }));
  const fake = source({ rows, industries: [{ code: "new_alpha", name: "Alpha", members: rows, declaredCount: 1 }] });
  const data = await createSinaMarketSnapshotProvider({ request: fake.request, now: () => NOW })({ withIndustries: true });
  assert.equal(data.classificationCoverage.classified, 101);
  assert.ok(fake.calls.some((call) => call.url.searchParams.get("node") === "new_alpha" && call.url.searchParams.get("page") === "2"));
  const industry = { code: "new_alpha", name: "Alpha", members: [], declaredCount: 1 };
  const recovering = source({ industries: [industry] });
  const load = createSinaMarketSnapshotProvider({ request: recovering.request, now: () => NOW });
  await assert.rejects(load({ withIndustries: true }), /成员为空/);
  industry.members = [fixture[0]];
  assert.equal((await load({ withIndustries: true })).classificationCoverage.classified, 1);
  assert.equal(recovering.calls.filter((call) => call.url.pathname.endsWith("newSinaHy.php")).length, 2);
});
