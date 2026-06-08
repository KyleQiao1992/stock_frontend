import { getMysqlPool } from "./mysqlClient.js";

const PERIOD_OFFSETS = [
  { key: "t1",  days: 1  },
  { key: "t3",  days: 3  },
  { key: "t5",  days: 5  },
  { key: "t10", days: 10 },
  { key: "t20", days: 20 },
  { key: "t40", days: 40 },
  { key: "t60", days: 60 },
];

const VALID_FACTORS = new Set(["factor1", "factor2", "factor3", "factor4", "factor5", "factor6"]);
const PAGE_SIZE = 20;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function toDateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function binarySearchEntry(klines, signalDate) {
  let lo = 0;
  let hi = klines.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (klines[mid].date >= signalDate) {
      idx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return idx;
}

function calcReturns(klines, signalDate) {
  const entryIdx = binarySearchEntry(klines, signalDate);
  const returns = {};
  for (const { key, days } of PERIOD_OFFSETS) {
    if (entryIdx === -1) { returns[key] = null; continue; }
    const entryClose = klines[entryIdx]?.close;
    if (!entryClose || entryClose <= 0) { returns[key] = null; continue; }
    const exitIdx = entryIdx + days;
    if (exitIdx >= klines.length) { returns[key] = null; continue; }
    const exitClose = klines[exitIdx]?.close;
    if (!exitClose || exitClose <= 0) { returns[key] = null; continue; }
    const ret = ((exitClose - entryClose) / entryClose) * 100;
    returns[key] = Number.isFinite(ret) ? parseFloat(ret.toFixed(2)) : null;
  }
  return returns;
}

export function createMacdFactorDetailHandler() {
  return async function macdFactorDetailHandler(req, res) {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const factorParam = url.searchParams.get("factor") || "";
      const factors = factorParam.split(",").map((f) => f.trim()).filter(Boolean);
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

      // Support both single date and date range
      const startDate = url.searchParams.get("startDate") || url.searchParams.get("date") || "";
      const endDate = url.searchParams.get("endDate") || startDate;

      if (factors.length === 0 || factors.some((f) => !VALID_FACTORS.has(f))) {
        return sendJson(res, 400, { ok: false, error: "Invalid factor" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return sendJson(res, 400, { ok: false, error: "Invalid date" });
      }
      if (endDate < startDate) {
        return sendJson(res, 400, { ok: false, error: "endDate must be >= startDate" });
      }

      const pool = getMysqlPool();

      // 1. Get all signal rows for the selected factors in the date range
      const factorPlaceholders = factors.map(() => "?").join(",");
      const [signalRows] = await pool.query(
        `SELECT factor_name, trade_date, codes FROM macd_factor_sync_result WHERE factor_name IN (${factorPlaceholders}) AND trade_date >= ? AND trade_date <= ? AND market = 'cn' ORDER BY trade_date, factor_name`,
        [...factors, startDate, endDate],
      );

      if (!signalRows.length) {
        return sendJson(res, 200, { ok: true, total: 0, page, pageSize: PAGE_SIZE, rows: [], stats: {}, startDate, endDate });
      }

      // 2. Expand into flat (signalDate, factorName, code) tuples
      const allTuples = [];
      for (const row of signalRows) {
        const dateStr = toDateStr(row.trade_date);
        const codes = String(row.codes || "").split(",").map((c) => c.trim()).filter(Boolean);
        for (const code of codes) {
          allTuples.push({ signalDate: dateStr, factorName: row.factor_name, code });
        }
      }

      const total = allTuples.length;
      if (!total) {
        return sendJson(res, 200, { ok: true, total: 0, page, pageSize: PAGE_SIZE, rows: [], stats: {}, startDate, endDate });
      }

      // 3. Fetch klines for ALL unique codes across the full date range
      const allCodes = [...new Set(allTuples.map((t) => t.code))];
      const codePlaceholders = allCodes.map(() => "?").join(",");
      const minDate = allTuples.reduce((m, t) => t.signalDate < m ? t.signalDate : m, allTuples[0].signalDate);
      const maxDate = allTuples.reduce((m, t) => t.signalDate > m ? t.signalDate : m, allTuples[0].signalDate);

      const [nameRows] = await pool.query(
        `SELECT stock_code, stock_name FROM stock_basic WHERE stock_code IN (${codePlaceholders})`,
        allCodes,
      );
      const nameMap = {};
      for (const r of nameRows) nameMap[r.stock_code] = r.stock_name;

      const [klineRows] = await pool.query(
        `SELECT stock_code, trade_date, close_price
         FROM stock_daily_kline
         WHERE stock_code IN (${codePlaceholders})
           AND trade_date >= ?
           AND trade_date <= DATE_ADD(?, INTERVAL 100 DAY)
           AND adjust_type = 'qfq'
         ORDER BY stock_code, trade_date`,
        [...allCodes, minDate, maxDate],
      );

      const klineMap = {};
      for (const r of klineRows) {
        const code = r.stock_code;
        if (!klineMap[code]) klineMap[code] = [];
        klineMap[code].push({ date: toDateStr(r.trade_date), close: Number(r.close_price) });
      }

      // 4. Compute returns for every tuple (needed for stats over all data)
      const allComputedRows = allTuples.map(({ signalDate, factorName, code }) => ({
        signalDate,
        factorName,
        stockCode: code,
        stockName: nameMap[code] || code,
        returns: calcReturns(klineMap[code] || [], signalDate),
      }));

      // 5. Compute per-period average returns and win rates across all signals (ignoring nulls)
      const stats = {};
      for (const { key } of PERIOD_OFFSETS) {
        const values = allComputedRows.map((r) => r.returns[key]).filter((v) => v !== null && v !== undefined);
        if (values.length === 0) {
          stats[key] = { avg: null, winRate: null };
        } else {
          const avg = parseFloat((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
          const wins = values.filter((v) => v > 0).length;
          const winRate = parseFloat(((wins / values.length) * 100).toFixed(1));
          stats[key] = { avg, winRate };
        }
      }

      // 6. Return paginated rows
      const rows = allComputedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      return sendJson(res, 200, { ok: true, total, page, pageSize: PAGE_SIZE, rows, stats, startDate, endDate });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
