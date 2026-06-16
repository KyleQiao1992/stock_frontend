import { getMysqlPool } from "./mysqlClient.js";
import { fetchFactorDim } from "./factorDim.js";
import { PERIOD_OFFSETS, toDateStr, binarySearchEntry, calcReturns, fetchKlinesAndNames } from "./factorReturns.js";

const PAGE_SIZE = 20;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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

      const validFactors = new Set((await fetchFactorDim()).map((f) => f.name));
      if (factors.length === 0 || factors.some((f) => !validFactors.has(f))) {
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
      const minDate = allTuples.reduce((m, t) => t.signalDate < m ? t.signalDate : m, allTuples[0].signalDate);
      const maxDate = allTuples.reduce((m, t) => t.signalDate > m ? t.signalDate : m, allTuples[0].signalDate);

      const { klineMap, nameMap } = await fetchKlinesAndNames(allCodes, minDate, maxDate);

      // 4. Compute returns for every tuple (needed for stats over all data).
      //    entryIdx = 该股 K 线序列中信号的进场下标，用于按持有期做非重叠去重。
      const allComputedRows = allTuples.map(({ signalDate, factorName, code }) => {
        const klines = klineMap[code] || [];
        return {
          signalDate,
          factorName,
          stockCode: code,
          stockName: nameMap[code] || code,
          entryIdx: binarySearchEntry(klines, signalDate),
          returns: calcReturns(klines, signalDate),
        };
      });

      // 5. 按持有期做「非重叠」统计：像 amihud_20 这类慢变量因子，同一只票几乎天天入选，
      //    若把每天的信号都当独立样本平均，会因持有窗口重叠严重高估胜率/收益。
      //    对每个口径(days 交易日)，同一 (factor, code) 只在一个持有窗口内保留一次信号
      //    （贪心取最早，进场下标间隔 >= days 才允许下一次），得到非重叠样本。
      const statsGroups = new Map(); // `${factor}|${code}` -> rows[]（按信号日升序）
      for (const r of allComputedRows) {
        const gk = `${r.factorName}|${r.stockCode}`;
        if (!statsGroups.has(gk)) statsGroups.set(gk, []);
        statsGroups.get(gk).push(r);
      }
      for (const rows of statsGroups.values()) {
        rows.sort((a, b) => (a.signalDate < b.signalDate ? -1 : a.signalDate > b.signalDate ? 1 : 0));
      }

      const stats = {};
      for (const { key, days } of PERIOD_OFFSETS) {
        const values = [];
        for (const rows of statsGroups.values()) {
          let lastKeptIdx = -Infinity;
          for (const r of rows) {
            const v = r.returns[key];
            if (v === null || v === undefined) continue; // 没有足够未来 K 线，跳过
            if (r.entryIdx < 0) continue;
            if (r.entryIdx - lastKeptIdx < days) continue; // 仍处于上一次持有窗口内 → 重叠，丢弃
            values.push(v);
            lastKeptIdx = r.entryIdx;
          }
        }
        if (values.length === 0) {
          stats[key] = { avg: null, winRate: null, n: 0 };
        } else {
          const avg = parseFloat((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
          const wins = values.filter((v) => v > 0).length;
          const winRate = parseFloat(((wins / values.length) * 100).toFixed(1));
          stats[key] = { avg, winRate, n: values.length };
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
