const FALLBACK_SOURCES = new Set(["eastmoney-tencent", "eastmoney-sina"]);
const UNKNOWN_INDUSTRIES = new Set(["未分类", "其他", "-"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Primary Eastmoney snapshots keep their existing schema. Alternate quotations
// are usable only when every stock retains the original industry ownership.
export function isCurrentMarketSnapshot(body, kind) {
  if (!body || typeof body !== "object" || body.error || ["sina", "sina-tencent"].includes(body.source)) return false;
  if (body.marketClosed && body.live === false) return !body.partial && body.mode !== "snapshot";
  if (body.live !== true) return false;
  if (kind === "heatmap") {
    if (!count(body.totalStocks) || body.totalStocks === 0 || !Array.isArray(body.industries) || !body.industries.length) return false;
  } else if (kind === "today") {
    if (!body.breadth || !count(body.breadth.total) || body.breadth.total === 0 || !Array.isArray(body.hist)) return false;
  } else return false;
  const fallback = FALLBACK_SOURCES.has(body.source);
  if (!fallback && !body.partial && body.mode !== "snapshot") return !body.source || body.source === "eastmoney";
  const coverage = body.classificationCoverage;
  if (!fallback || body.snapshotSchemaVersion !== 3 || body.universePolicy !== "listed-ashare-with-cdr"
    || body.classificationSource !== "eastmoney" || body.industryLevel !== 2 || body.classification !== "东方财富行业"
    || !count(coverage?.total) || coverage.total === 0 || coverage.classified !== coverage.total
    || coverage.unclassified !== 0 || coverage.conflicts !== 0) return false;
  if (kind === "heatmap") {
    return coverage.total === body.totalStocks && body.industries.every((row) => typeof row?.name === "string"
      && row.name.trim() && !UNKNOWN_INDUSTRIES.has(row.name.trim()) && count(row.count) && row.count > 0)
      && body.industries.reduce((sum, row) => sum + row.count, 0) === body.totalStocks;
  }
  const quotes = body.quoteCoverage;
  return quotes?.total === coverage.total && count(quotes.quoted) && count(quotes.unavailable)
    && quotes.quoted + quotes.unavailable === quotes.total && body.breadth.total === quotes.quoted;
}

export function marketSnapshotSourceLabel(body) {
  if (body?.source === "eastmoney-tencent") return "腾讯报价 · 东方财富行业";
  if (body?.source === "eastmoney-sina") return "新浪报价 · 东方财富行业";
  return "东方财富";
}

export function formatMarketSnapshotTime(value) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }) : "—";
}
