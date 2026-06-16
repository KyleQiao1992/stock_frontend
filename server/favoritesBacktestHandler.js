import { getFavoriteItems } from "./favoritesHandlers.js";
import { PERIOD_OFFSETS, binarySearchEntry, calcReturns, fetchKlinesAndNames } from "./factorReturns.js";

const PAGE_SIZE = 20;
const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 收藏时间戳按北京时间折算到自然日

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

// 收藏时间戳(ms) → 北京时区下的 YYYY-MM-DD，作为该票的信号(收藏)日。
function favoriteDateStr(createdAt) {
  const ts = Number(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts + CN_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// 收藏夹回测：以每只票自己的收藏日为信号日，沿用因子详情的收益口径。
export function createFavoritesBacktestHandler() {
  return async function favoritesBacktestHandler(req, res) {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const market = String(url.searchParams.get("market") || "ashare").trim().toLowerCase();
      if (market !== "ashare") {
        return sendJson(res, 400, { ok: false, error: "Only ashare favorites are supported." });
      }
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      // groups: 逗号分隔的收藏夹名；缺省 → 不过滤（全部收藏夹）。
      const groupsParam = url.searchParams.get("groups");
      const groupFilter = groupsParam == null || groupsParam === ""
        ? null
        : new Set(groupsParam.split(",").map((g) => g.trim()).filter(Boolean));

      const items = await getFavoriteItems(req.user?.id, market);
      const tuples = items
        .filter((it) => !groupFilter || groupFilter.has(it.group || "默认"))
        .map((it) => ({ signalDate: favoriteDateStr(it.createdAt), code: it.code, name: it.name }))
        .filter((t) => t.signalDate);

      if (!tuples.length) {
        return sendJson(res, 200, { ok: true, total: 0, page, pageSize: PAGE_SIZE, rows: [], stats: {}, startDate: null, endDate: null });
      }

      const allCodes = [...new Set(tuples.map((t) => t.code))];
      const minDate = tuples.reduce((m, t) => (t.signalDate < m ? t.signalDate : m), tuples[0].signalDate);
      const maxDate = tuples.reduce((m, t) => (t.signalDate > m ? t.signalDate : m), tuples[0].signalDate);

      const { klineMap, nameMap } = await fetchKlinesAndNames(allCodes, minDate, maxDate);

      const allRows = tuples
        .map(({ signalDate, code, name }) => {
          const klines = klineMap[code] || [];
          return {
            signalDate,
            stockCode: code,
            stockName: nameMap[code] || name || code,
            returns: calcReturns(klines, signalDate),
            hasEntry: binarySearchEntry(klines, signalDate) >= 0,
          };
        })
        // 最近收藏的排在前面
        .sort((a, b) => (a.signalDate < b.signalDate ? 1 : a.signalDate > b.signalDate ? -1 : 0));

      // 收藏夹每只票天然只有一条信号，直接按票统计 avg/胜率/n。
      const stats = {};
      for (const { key } of PERIOD_OFFSETS) {
        const values = allRows
          .map((r) => r.returns[key])
          .filter((v) => v !== null && v !== undefined);
        if (!values.length) {
          stats[key] = { avg: null, winRate: null, n: 0 };
        } else {
          const avg = parseFloat((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
          const wins = values.filter((v) => v > 0).length;
          const winRate = parseFloat(((wins / values.length) * 100).toFixed(1));
          stats[key] = { avg, winRate, n: values.length };
        }
      }

      const total = allRows.length;
      const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      return sendJson(res, 200, { ok: true, total, page, pageSize: PAGE_SIZE, rows, stats, startDate: minDate, endDate: maxDate });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
