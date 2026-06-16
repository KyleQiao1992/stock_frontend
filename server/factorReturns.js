import { getMysqlPool } from "./mysqlClient.js";

// 收益口径：信号日收盘价进场，第 N 交易日收盘价出场。
export const PERIOD_OFFSETS = [
  { key: "t1",  days: 1  },
  { key: "t3",  days: 3  },
  { key: "t5",  days: 5  },
  { key: "t10", days: 10 },
  { key: "t20", days: 20 },
  { key: "t40", days: 40 },
  { key: "t60", days: 60 },
];

export function toDateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// 在升序 K 线序列里找到首根 date >= signalDate 的下标（进场点）。
export function binarySearchEntry(klines, signalDate) {
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

export function calcReturns(klines, signalDate) {
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

// 为一批 A 股代码拉取名称 + 前复权日 K 线（信号区间 minDate~maxDate，向后多取 100 天用于出场）。
export async function fetchKlinesAndNames(codes, minDate, maxDate) {
  if (!codes.length) return { klineMap: {}, nameMap: {} };

  const pool = getMysqlPool();
  const codePlaceholders = codes.map(() => "?").join(",");

  const [nameRows] = await pool.query(
    `SELECT stock_code, stock_name FROM stock_basic WHERE stock_code IN (${codePlaceholders})`,
    codes,
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
    [...codes, minDate, maxDate],
  );

  const klineMap = {};
  for (const r of klineRows) {
    const code = r.stock_code;
    if (!klineMap[code]) klineMap[code] = [];
    klineMap[code].push({ date: toDateStr(r.trade_date), close: Number(r.close_price) });
  }

  return { klineMap, nameMap };
}
