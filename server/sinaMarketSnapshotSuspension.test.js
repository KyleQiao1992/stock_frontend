import test from "node:test";
import assert from "node:assert/strict";
import { createSinaMarketSnapshotProvider } from "./sinaMarketSnapshot.js";
import { createMarketSnapshotFallbacks } from "./marketSnapshotFallback.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const rows = [
  { symbol: "sh600293", code: "600293", name: "Suspended fixture", mktcap: 500000, nmc: 500000 },
  { symbol: "sz000001", code: "000001", name: "Flat fixture", mktcap: 700000, nmc: 700000 },
  { symbol: "sh688001", code: "688001", name: "Rising fixture", mktcap: 600000, nmc: 600000 },
];

function source({ provider = "tencent", paused = () => true } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("getHQNodeStockCount")) return { ok: true, json: async () => String(rows.length) };
    if (parsed.pathname.endsWith("getHQNodeData")) return { ok: true, json: async () => rows };
    if (provider === "tencent" && parsed.hostname === "hq.sinajs.cn") return { ok: false, status: 403 };
    if (parsed.hostname === "hq.sinajs.cn" || parsed.hostname === "qt.gtimg.cn") {
      const tencent = parsed.hostname === "qt.gtimg.cn";
      const symbols = parsed.pathname.slice(tencent ? "/q=".length : "/list=".length).split(",");
      const text = symbols.map((symbol) => {
        const suspended = symbol === "sh600293" && paused();
        const flat = symbol === "sz000001";
        const values = new Array(tencent ? 41 : 33).fill("");
        values[2] = tencent ? symbol.slice(2) : "10";
        values[3] = suspended || flat ? "10" : "11";
        values[tencent ? 4 : 2] = "10";
        values[tencent ? 5 : 1] = suspended ? "0" : "10";
        values[tencent ? 37 : 9] = suspended || flat ? "0" : tencent ? "100" : "1000000";
        if (tencent) {
          values[6] = suspended || flat ? "0" : "1000";
          values[30] = "20260930161458";
          values[35] = `${values[3]}/${values[6]}/${suspended || flat ? "0" : "1000000"}`;
          values[40] = suspended ? "S" : "";
        } else {
          values[30] = "2026-09-30";
          values[31] = "16:14:58";
          values[32] = "S"; // Its meaning is deliberately not assumed for Sina HQ.
        }
        return tencent ? `v_${symbol}="${values.join("~")}";` : `var hq_str_${symbol}="${values.join(",")}";`;
      }).join("\n");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    }
    throw new Error("unexpected fixture request");
  };
}

test("a current Tencent timestamp does not turn an explicitly suspended stock into a flat trade", async () => {
  const result = await createSinaMarketSnapshotProvider({ request: source(), now: () => NOW })();
  const suspended = result.stocks.find((row) => row.code === "600293");
  assert.equal(result.source, "sina-tencent");
  assert.equal(suspended.quoteDate, "2026-09-30");
  assert.equal(suspended.close, 10);
  assert.equal(suspended.suspended, true);
  assert.equal(suspended.pct, null);
  assert.equal(suspended.amount, 0);
  assert.equal(suspended.cap, 5e9);
});

test("zero turnover alone does not fabricate a suspension when Tencent has no S status", async () => {
  const result = await createSinaMarketSnapshotProvider({ request: source(), now: () => NOW })();
  const flat = result.stocks.find((row) => row.code === "000001");
  assert.equal(flat.amount, 0);
  assert.equal(flat.open, 10);
  assert.equal(flat.suspended, false);
  assert.equal(flat.pct, 0);
});

test("fallback dashboard excludes the current suspended quote from flat and breadth counts", async () => {
  const load = createSinaMarketSnapshotProvider({ request: source(), now: () => NOW });
  const fallbacks = createMarketSnapshotFallbacks({ loadSnapshot: load, now: () => NOW,
    loadCapitals: async ({ date, stocks }) => ({ capitalSource: "eastmoney", capitalDate: date,
      capitalUpdatedAt: new Date(NOW).toISOString(), coverage: { expected: stocks.length, received: stocks.length },
      capitals: stocks.map((row) => ({ symbol: `${row.exchange}${row.code}`, quoteDate: date, cap: row.cap, floatCap: row.floatCap, close: row.close })),
    }), loadIndustries: async () => ({
    classificationSource: "eastmoney", level: 2, classification: "东方财富行业", listedCdrs: [],
    members: rows.map((row) => ({ symbol: row.symbol, industry: "Synthetic industry", industryCode: "BK0001" })),
  }) });
  const result = await fallbacks.today();
  assert.equal(result.breadth.total, 2);
  assert.equal(result.breadth.up, 1);
  assert.equal(result.breadth.down, 0);
  assert.equal(result.breadth.flat, 1);
  assert.deepEqual(result.quoteCoverage, { quoted: 2, total: 3, unavailable: 1 });
});

test("suspension status refreshes from each Tencent row and is not carried into resumed trading", async () => {
  let paused = true;
  const load = createSinaMarketSnapshotProvider({ request: source({ paused: () => paused }), now: () => NOW });
  assert.equal((await load()).stocks[0].suspended, true);
  paused = false;
  const resumed = (await load()).stocks[0];
  assert.equal(resumed.suspended, false);
  assert.ok(resumed.pct > 0);
  assert.equal(resumed.amount, 1e6);
});

test("Sina HQ retains an unknown suspension status without interpreting an unconfirmed field", async () => {
  const result = await createSinaMarketSnapshotProvider({ request: source({ provider: "sina" }), now: () => NOW })();
  const row = result.stocks[0];
  assert.equal(result.source, "sina");
  assert.equal(row.suspended, null);
  assert.equal(row.pct, 0);
  assert.equal(row.amount, 0);
});
