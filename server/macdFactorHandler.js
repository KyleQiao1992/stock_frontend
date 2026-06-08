import { getMysqlPool } from "./mysqlClient.js";

// Number of trading days forward for each period key
const PERIOD_TRADING_DAYS = {
  "1d":  1,
  "3d":  3,
  "1w":  5,
  "2w": 10,
  "1m": 20,
  "3m": 60,
};

const FACTOR_LABELS = {
  factor1: "因子1",
  factor2: "因子2",
  factor3: "因子3",
  factor4: "因子4",
  factor5: "因子5",
  factor6: "因子6",
};

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function toDateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function buildEmptyData() {
  const data = {};
  for (const key of Object.keys(PERIOD_TRADING_DAYS)) {
    data[key] = Object.values(FACTOR_LABELS).map((label) => ({ factor: label, value: 0, sampleSize: 0 }));
  }
  return data;
}

export function createMacdFactorReturnsHandler() {
  return async function macdFactorReturnsHandler(req, res) {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const mode = url.searchParams.get("mode") === "custom" ? "custom" : "trailing";
      const startDate = url.searchParams.get("startDate") || "";

      const pool = getMysqlPool();

      // 1. Fetch signal rows from macd_factor_sync_result
      let signalQuery = "SELECT factor_name, trade_date, codes FROM macd_factor_sync_result WHERE market = 'cn'";
      const signalParams = [];

      if (mode === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        signalQuery += " AND trade_date >= ?";
        signalParams.push(startDate);
      } else {
        // Trailing: look back 180 calendar days so 3m (60 trading days) periods are covered
        signalQuery += " AND trade_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)";
      }

      const [signalRows] = await pool.query(signalQuery, signalParams);
      if (!signalRows.length) {
        return sendJson(res, 200, { ok: true, data: buildEmptyData() });
      }

      // 2. Expand comma-separated codes into (factorName, signalDate, code) tuples
      const signals = [];
      const codeSet = new Set();
      let minDate = null;

      for (const row of signalRows) {
        const dateStr = toDateStr(row.trade_date);
        const codes = String(row.codes || "").split(",").map((c) => c.trim()).filter(Boolean);

        if (!minDate || dateStr < minDate) minDate = dateStr;

        for (const code of codes) {
          signals.push({ factorName: row.factor_name, signalDate: dateStr, code });
          codeSet.add(code);
        }
      }

      if (!signals.length || !codeSet.size) {
        return sendJson(res, 200, { ok: true, data: buildEmptyData() });
      }

      // 3. Fetch klines for all codes from minDate in one query
      const codes = [...codeSet];
      const placeholders = codes.map(() => "?").join(",");
      const [klineRows] = await pool.query(
        `SELECT stock_code, trade_date, close_price
         FROM stock_daily_kline
         WHERE stock_code IN (${placeholders})
           AND trade_date >= ?
           AND adjust_type = 'qfq'
         ORDER BY stock_code, trade_date`,
        [...codes, minDate],
      );

      // 4. Build kline index: {code -> [{date, close}]}
      const klineMap = {};
      for (const row of klineRows) {
        const code = row.stock_code;
        if (!klineMap[code]) klineMap[code] = [];
        klineMap[code].push({ date: toDateStr(row.trade_date), close: Number(row.close_price) });
      }

      // 5. Accumulate returns per (factorName, periodKey)
      // acc[factorName][periodKey] = { sum, count }
      const acc = {};
      for (const factorName of Object.keys(FACTOR_LABELS)) {
        acc[factorName] = {};
        for (const key of Object.keys(PERIOD_TRADING_DAYS)) {
          acc[factorName][key] = { sum: 0, count: 0 };
        }
      }

      for (const { factorName, signalDate, code } of signals) {
        if (!acc[factorName]) continue;
        const klines = klineMap[code];
        if (!klines || klines.length === 0) continue;

        // Binary search for entry index: first kline at or after signalDate
        let lo = 0;
        let hi = klines.length - 1;
        let entryIdx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (klines[mid].date >= signalDate) {
            entryIdx = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        if (entryIdx === -1) continue;

        const entryClose = klines[entryIdx].close;
        if (!entryClose || entryClose <= 0) continue;

        for (const [key, tradingDays] of Object.entries(PERIOD_TRADING_DAYS)) {
          const exitIdx = entryIdx + tradingDays;
          if (exitIdx >= klines.length) continue;

          const exitClose = klines[exitIdx].close;
          if (!exitClose || exitClose <= 0) continue;

          const ret = ((exitClose - entryClose) / entryClose) * 100;
          if (!Number.isFinite(ret)) continue;

          acc[factorName][key].sum += ret;
          acc[factorName][key].count += 1;
        }
      }

      // 6. Build response: {periodKey: [{factor, value, sampleSize}]}
      const data = {};
      for (const key of Object.keys(PERIOD_TRADING_DAYS)) {
        data[key] = Object.entries(FACTOR_LABELS).map(([factorName, label]) => {
          const { sum, count } = acc[factorName][key];
          return {
            factor: label,
            value: count > 0 ? parseFloat((sum / count).toFixed(2)) : 0,
            sampleSize: count,
          };
        });
      }

      return sendJson(res, 200, { ok: true, data });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
