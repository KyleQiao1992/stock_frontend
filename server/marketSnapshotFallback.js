import { loadSinaMarketSnapshot } from "./sinaMarketSnapshot.js";
import { loadEastmoneyIndustryMap } from "./eastmoneyIndustryMap.js";
import { loadEastmoneyMarketCapital } from "./eastmoneyMarketCapital.js";
import { aggregateHeatmapStocks } from "./marketHeatmap.js";
import { buildSnapshotPanels, loadTodayMarketSessionData } from "./todayMarket.js";

// Share the successful alternate snapshot between the heatmap and its dashboard
// prefetch. Nothing is fetched at import time and failures are never cached.
export function createMarketSnapshotFallbacks({ loadSnapshot = loadSinaMarketSnapshot, loadIndustries = loadEastmoneyIndustryMap,
  loadCapitals = loadEastmoneyMarketCapital, loadSessionData = loadTodayMarketSessionData, now = Date.now } = {}) {
  let recent = null;
  let inflight = null;
  const usable = (entry) => entry && now() >= entry.at && now() - entry.at < 60000;
  const invalid = (message) => Object.assign(new Error(message), {code: "FALLBACK_SNAPSHOT_INVALID", stage: "snapshot-validation"});
  async function snapshot({ force = false } = {}) {
    if (!force && usable(recent)) return recent.result;
    if (inflight) return inflight;
    const pending = (async () => {
      const ownership = await loadIndustries();
      if (ownership?.classificationSource !== "eastmoney" || ownership.level !== 2 || ownership.classification !== "东方财富行业" || !Array.isArray(ownership.members) || !Array.isArray(ownership.listedCdrs)) {
        throw invalid("备用行情缺少原行业归属或上市证据");
      }
      const membership = new Map();
      for (const member of ownership.members) {
        if (!member.symbol || membership.has(member.symbol) || !member.industry?.trim() || ["未分类", "其他", "-"].includes(member.industry.trim())) {
          throw invalid("备用行情行业归属不完整或存在冲突");
        }
        membership.set(member.symbol, member);
      }
      // The industry directory also includes pending IPOs. Only the listed
      // Sina universe and CDRs with confirmed listing dates define this snapshot.
      const result = await loadSnapshot({ withIndustries: false, supplements: ownership.listedCdrs, quotePreference: "tencent" });
      const data = result.metadata;
      const at = Date.parse(data?.quoteTime);
      // A long market holiday may outlast the seven-day cache retention. A fresh
      // provider fetch can still expose that closing quote with its actual date.
      if (!result.stocks?.length || !Number.isFinite(at) || at > now() || now() - at >= 14 * 86400000) {
        throw invalid("备用行情没有有效的近期数据");
      }
      const quoteDate = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
      if (data.dataDate !== quoteDate || data.date != null && data.date !== quoteDate) {
        throw invalid("备用行情交易日与实际报价时间不一致");
      }
      const seen = new Set();
      let stocks = result.stocks.map((row) => {
        const exchange = row.exchange || (row.market === 1 ? "sh" : /^(?:[48]|920)/.test(row.code) ? "bj" : "sz");
        const symbol = `${exchange}${row.code}`;
        const member = membership.get(symbol);
        if (!member || seen.has(symbol)) throw invalid("备用行情存在未归属或重复股票，无法生成行业热力图");
        seen.add(symbol);
        return {...row, industry: member.industry, industryCode: member.industryCode};
      });
      if (ownership.listedCdrs.some((row) => !seen.has(row.symbol))) throw invalid("备用行情缺少已上市 CDR");
      // Tencent's tradable share count differs from f21 for some stocks. The
      // original heatmap weights require Eastmoney valuations from this session.
      const valuations = await loadCapitals({date: data.dataDate, stocks});
      if (valuations?.capitalSource !== "eastmoney" || valuations.capitalDate !== data.dataDate
        || !Array.isArray(valuations.capitals) || valuations.capitals.length !== stocks.length
        || valuations.coverage?.expected !== stocks.length || valuations.coverage.received !== stocks.length) {
        throw invalid("备用行情缺少同交易日的原市值口径");
      }
      const capitalMap = new Map(valuations.capitals.map((row) => [row.symbol, row]));
      if (capitalMap.size !== stocks.length) throw invalid("备用行情市值身份重复");
      stocks = stocks.map((row) => {
        const exchange = row.exchange || (row.market === 1 ? "sh" : /^(?:[48]|920)/.test(row.code) ? "bj" : "sz");
        const capital = capitalMap.get(`${exchange}${row.code}`);
        if (!capital || capital.quoteDate !== data.dataDate || !Number.isFinite(capital.cap) || capital.cap < 0
          || !Number.isFinite(capital.floatCap) || capital.floatCap < 0 || !Number.isFinite(capital.close)
          || row.quoteDate === data.dataDate && Number.isFinite(row.close) && Math.abs(capital.close - row.close) > 0.000001) {
          throw invalid("备用报价与原市值的日期、价格或身份不一致");
        }
        return {...row, cap: capital.cap, floatCap: capital.floatCap};
      });
      const quoteSource = data.quoteSource || (data.source === "sina-tencent" ? "tencent" : data.source);
      if (!["sina", "tencent"].includes(quoteSource)) throw invalid("备用行情报价来源不明确");
      const classified = {...result, stocks, metadata: {
        ...data, source: `eastmoney-${quoteSource}`, quoteSource, snapshotSchemaVersion: 3,
        universePolicy: "listed-ashare-with-cdr", classification: "东方财富行业", classificationSource: "eastmoney", industryLevel: 2,
        classificationUpdatedAt: ownership.classificationUpdatedAt, classificationStale: Boolean(ownership.classificationStale),
        classificationCoverage: {classified: stocks.length, total: stocks.length, unclassified: 0, conflicts: 0},
        capitalSource: "eastmoney", capitalDate: valuations.capitalDate, capitalUpdatedAt: valuations.capitalUpdatedAt,
        capitalCoverage: valuations.coverage,
      }};
      recent = {result: classified, at: now()};
      return classified;
    })().finally(() => { inflight = null; });
    inflight = pending;
    return pending;
  }

  function currentStocks(result) {
    // Suspended stocks can carry an older quote. Keep their identity/capital,
    // but do not count an old change or turnover as today's measurement.
    return result.stocks.map((row) => ({
      ...row,
      ...(row.quoteDate === result.metadata.dataDate ? {} : {pct: null, amount: null, open: null, close: null}),
    }));
  }

  return {
    async heatmap(options) {
      const result = await snapshot(options);
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
        notice: "行业与市值沿用东方财富；主力资金净额暂不可用，报价时间见上方。",
      };
      return {payload, snapshot: {stocks, at: Date.parse(payload.updatedAt)}};
    },
    async today(options) {
      const result = await snapshot(options);
      const stocks = currentStocks(result).filter((row) => Number.isFinite(row.pct)).map((row) => ({...row, mktcap: row.cap}));
      if (!stocks.length) throw new Error("备用行情无当日盘面数据");
      const panels = buildSnapshotPanels(stocks, null, 0, 0, null, new Map(stocks.map((row) => [row.code, row])));
      let session = null;
      try { session = await loadSessionData({date: result.metadata.dataDate, stocks, force: Boolean(options?.force)}); } catch { /* Quote-only data remains available. */ }
      if (session?.poolDate !== result.metadata.dataDate) session = null;
      const hasPools = session?.poolAvailability?.zt && session.poolAvailability.dt && session.poolAvailability.zb;
      return {
        ...result.metadata, ...panels,
        heat: null, strong: null, consecutive: null, premium: null, history: [],
        ...(session || {}),
        live: true, mode: "snapshot", partial: true,
        quoteCoverage: {quoted: stocks.length, total: result.stocks.length, unavailable: result.stocks.length - stocks.length},
        notice: hasPools ? "盘面按报价交易日统计，涨停、跌停、炸板池使用同日数据；前一交易日按实际交易日序列确定。停牌、旧日期和缺失报价不计入统计。"
          : "盘面按报价交易日统计。未取得的涨停、跌停或炸板池保持未知；停牌、旧日期和缺失报价不计入统计。",
      };
    },
  };
}
