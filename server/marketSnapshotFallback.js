import { loadSinaMarketSnapshot } from "./sinaMarketSnapshot.js";
import { aggregateHeatmapStocks } from "./marketHeatmap.js";
import { buildSnapshotPanels } from "./todayMarket.js";

// Share the successful alternate snapshot between the heatmap and its dashboard
// prefetch. Nothing is fetched at import time and failures are never cached.
export function createMarketSnapshotFallbacks({ loadSnapshot = loadSinaMarketSnapshot, now = Date.now } = {}) {
  const recent = new Map();
  const inflight = new Map();
  const usable = (entry) => entry && now() >= entry.at && now() - entry.at < 60000;
  async function snapshot(withIndustries) {
    if (!withIndustries && usable(recent.get(true))) return recent.get(true).result;
    if (usable(recent.get(withIndustries))) return recent.get(withIndustries).result;
    if (!withIndustries && inflight.has(true)) {
      try { return await inflight.get(true); } catch { /* Industry failure must not prevent quote-only statistics. */ }
    }
    if (inflight.has(withIndustries)) return inflight.get(withIndustries);
    const pending = (async () => {
      const result = await loadSnapshot({ withIndustries });
      const data = result.metadata;
      const at = Date.parse(data?.quoteTime);
      // A long market holiday may outlast the seven-day cache retention. A fresh
      // provider fetch can still expose that closing quote with its actual date.
      if (!result.stocks?.length || !Number.isFinite(at) || at > now() || now() - at >= 14 * 86400000) {
        throw new Error("备用行情没有有效的近期数据");
      }
      recent.set(withIndustries, {result, at: now()});
      return result;
    })().finally(() => { inflight.delete(withIndustries); });
    inflight.set(withIndustries, pending);
    return pending;
  }

  function currentStocks(result) {
    // Suspended stocks can carry an older quote. Keep their identity/capital,
    // but do not count an old change or turnover as today's measurement.
    return result.stocks.map((row) => ({
      ...row, industry: row.industry || "未分类",
      ...(row.quoteDate === result.metadata.dataDate ? {} : {pct: null, amount: null, open: null, close: null}),
    }));
  }

  return {
    async heatmap() {
      const result = await snapshot(true);
      const stocks = currentStocks(result);
      const quoted = stocks.filter((row) => Number.isFinite(row.pct));
      if (!quoted.length) throw new Error("备用行情无当日涨跌幅");
      const industries = aggregateHeatmapStocks(stocks).map((group) => {
        const members = stocks.filter((row) => row.industry === group.name);
        return {...group, mainInflow: null,
          amount: members.some((row) => Number.isFinite(row.amount)) ? group.amount : null};
      });
      const payload = {
        ...result.metadata, live: true, scope: "ashare", mode: "snapshot", partial: true,
        totalStocks: stocks.length, up: quoted.filter((row) => row.pct > 0).length,
        down: quoted.filter((row) => row.pct < 0).length, flat: quoted.filter((row) => row.pct === 0).length,
        suspended: stocks.length - quoted.length, industries,
        quoteCoverage: {quoted: quoted.length, total: stocks.length, unavailable: stocks.length - quoted.length},
        notice: "东方财富行情暂不可用，显示新浪备用行情；行业分类不同，未能分类的股票归入未分类。旧日期或缺失报价不计入当日涨跌和成交额。",
      };
      return {payload, snapshot: {stocks, at: Date.parse(payload.updatedAt)}};
    },
    async today() {
      const result = await snapshot(false);
      const stocks = currentStocks(result).filter((row) => Number.isFinite(row.pct)).map((row) => ({...row, mktcap: row.cap}));
      if (!stocks.length) throw new Error("备用行情无当日盘面数据");
      const panels = buildSnapshotPanels(stocks, null, 0, 0, null, new Map(stocks.map((row) => [row.code, row])));
      return {
        ...result.metadata, ...panels, live: true, mode: "snapshot", partial: true,
        heat: null, strong: null, consecutive: null, premium: null, history: [],
        quoteCoverage: {quoted: stocks.length, total: result.stocks.length, unavailable: result.stocks.length - stocks.length},
        notice: "东方财富盘面数据暂不可用，显示新浪最新交易日的涨跌统计和市值分档。涨停、跌停、炸板及连板等依赖池数据的指标暂不可用；旧日期和缺失报价不计入当日统计。",
      };
    },
  };
}
