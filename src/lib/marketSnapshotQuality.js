const FALLBACK_SOURCES = new Set(["eastmoney-tencent", "eastmoney-sina"]);
const UNKNOWN_INDUSTRIES = new Set(["未分类", "其他", "-"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const finiteOrNull = (value) => value == null || Number.isFinite(value);
const ratioOrUnknown = (value) => value == null || Number.isFinite(value) && value >= 0 && value <= 1;
const validDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function validAlternatePanels(body) {
  const breadth = body.breadth;
  if (!validDay(body.date) || ![breadth.up, breadth.down, breadth.flat].every(count)
    || breadth.up + breadth.down + breadth.flat !== breadth.total
    || !body.yangYin || ![body.yangYin.yang, body.yangYin.yin].every(count)
    || body.yangYin.yang + body.yangYin.yin > breadth.total
    || !body.hist.every((row) => row && typeof row.label === "string" && count(row.count))
    || !Array.isArray(body.capTiers) || !body.capTiers.every((row) => row && typeof row.key === "string"
      && typeof row.label === "string" && count(row.n) && finiteOrNull(row.avg))
    || !Array.isArray(body.history) || !body.history.every((row, i) => row && validDay(row.date)
      && row.date <= body.date && (!i || body.history[i - 1].date < row.date)
      && [row.ztCount, row.lbCount, row.maxLb].every(count)
      && [row.dtCount, row.zbCount].every((value) => value == null || count(value))
      && [row.zbRate, row.nextDaySuccess].every(ratioOrUnknown))) return false;
  if (body.strong != null && (![body.strong.ztCount, body.strong.dtCount, body.strong.zbCount].every(count)
    || ![body.strong.fbSuccess, body.strong.zbRate].every(ratioOrUnknown))) return false;
  if (body.consecutive != null && ![body.consecutive.lbCount, body.consecutive.nonOneWordLb, body.consecutive.maxLb].every(count)) return false;
  if (body.heat != null && ![body.heat.value, body.heat.breadth, body.heat.ztStrength].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) return false;
  return body.premium == null || count(body.premium.count) && Number.isFinite(body.premium.avg)
    && ratioOrUnknown(body.premium.redRate) && Array.isArray(body.premium.dist)
    && body.premium.dist.every((row) => row && typeof row.key === "string" && typeof row.label === "string" && count(row.count));
}

function tradingDate(body) {
  const dates = [body.dataDate, body.date].filter((value) => value != null);
  const at = typeof body.quoteTime === "string" ? Date.parse(body.quoteTime) : NaN;
  const shanghai = new Date(at + 8 * 3600000);
  const quoteDate = Number.isFinite(shanghai.getTime()) ? shanghai.toISOString().slice(0, 10) : null;
  const date = dates[0] || quoteDate;
  if (dates.some((value) => {
    const ms = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    return !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value || value !== date;
  }) || body.quoteTime != null && quoteDate !== date) return null;
  return date;
}

// Primary Eastmoney snapshots keep their existing schema. Alternate quotations
// are usable only with full original industry ownership and same-session f21 valuations.
export function isCurrentMarketSnapshot(body, kind) {
  if (!body || typeof body !== "object" || body.error || ["sina", "sina-tencent"].includes(body.source)) return false;
  if (body.marketClosed && body.live === false) return !body.partial && body.mode !== "snapshot";
  if (body.live !== true) return false;
  if (kind === "heatmap") {
    if (!count(body.totalStocks) || body.totalStocks === 0 || !Array.isArray(body.industries) || !body.industries.length) return false;
  } else if (kind === "today") {
    if (!body.breadth || !count(body.breadth.total) || body.breadth.total === 0 || !Array.isArray(body.hist)) return false;
    if (body.quoteTime != null && body.date != null && !tradingDate(body)
      || body.poolDate != null && body.poolDate !== body.date
      || body.previousDate != null && (!validDay(body.previousDate) || body.previousDate >= body.date)) return false;
    if (body.date != null && body.history != null && (!Array.isArray(body.history)
      || !body.history.every((row, i) => row && validDay(row.date) && row.date <= body.date
        && (!i || body.history[i - 1].date < row.date)))) return false;
  } else return false;
  const fallback = FALLBACK_SOURCES.has(body.source);
  if (!fallback && !body.partial && body.mode !== "snapshot") return !body.source || body.source === "eastmoney";
  const coverage = body.classificationCoverage;
  if (!fallback || body.partial !== true || body.mode !== "snapshot" || body.snapshotSchemaVersion !== 3 || body.universePolicy !== "listed-ashare-with-cdr"
    || body.classificationSource !== "eastmoney" || body.industryLevel !== 2 || body.classification !== "东方财富行业"
    || !count(coverage?.total) || coverage.total === 0 || coverage.classified !== coverage.total
    || coverage.unclassified !== 0 || coverage.conflicts !== 0) return false;
  const date = tradingDate(body);
  if (!date || body.capitalSource !== "eastmoney" || body.capitalDate !== date
    || body.capitalCoverage?.expected !== coverage.total || body.capitalCoverage.received !== coverage.total) return false;
  if (kind === "heatmap") {
    const quotes = body.quoteCoverage;
    return coverage.total === body.totalStocks && [body.up, body.down, body.flat, body.suspended ?? 0].every(count)
      && body.up + body.down + body.flat + (body.suspended ?? 0) === body.totalStocks
      && quotes?.total === body.totalStocks && count(quotes.quoted) && count(quotes.unavailable)
      && quotes.quoted === body.up + body.down + body.flat && quotes.unavailable === (body.suspended ?? 0)
      && quotes.quoted + quotes.unavailable === quotes.total
      && body.industries.every((row) => typeof row?.name === "string"
      && row.name.trim() && !UNKNOWN_INDUSTRIES.has(row.name.trim()) && count(row.count) && row.count > 0
      && Array.isArray(row.stocks) && row.stocks.length <= row.count
      && [row.cap, row.floatCap, row.amount, row.mainInflow, row.pct, row.pctEqual].every(finiteOrNull)
      && row.stocks.every((stock) => stock && typeof stock.code === "string" && stock.code && typeof stock.name === "string" && stock.name
        && [stock.cap, stock.floatCap, stock.amount, stock.mainInflow, stock.pct].every(finiteOrNull)))
      && body.industries.reduce((sum, row) => sum + row.count, 0) === body.totalStocks;
  }
  const quotes = body.quoteCoverage;
  return quotes?.total === coverage.total && count(quotes.quoted) && count(quotes.unavailable)
    && quotes.quoted + quotes.unavailable === quotes.total && body.breadth.total === quotes.quoted && validAlternatePanels(body);
}

export function marketSnapshotSourceLabel(body) {
  if (body?.source === "eastmoney-tencent") return "腾讯报价 · 东财行业与市值";
  if (body?.source === "eastmoney-sina") return "新浪报价 · 东财行业与市值";
  return "东方财富";
}

export function formatMarketSnapshotTime(value) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }) : "—";
}
