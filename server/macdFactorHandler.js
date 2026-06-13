import { getMysqlPool } from "./mysqlClient.js";
import { getRedisClient } from "./redisClient.js";
import { fetchFactorDim, factorLabel } from "./factorDim.js";

// Number of trading days forward for each period key
const PERIOD_TRADING_DAYS = {
  "1d":  1,
  "3d":  3,
  "1w":  5,
  "2w": 10,
  "1m": 20,
  "3m": 60,
};

const CHINA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function getSecondsUntilChinaDayEnd(now = new Date()) {
  const chinaNow = new Date(now.getTime() + CHINA_UTC_OFFSET_MS);
  let expiresAt = Date.UTC(
    chinaNow.getUTCFullYear(),
    chinaNow.getUTCMonth(),
    chinaNow.getUTCDate(),
    15,
    59,
    59,
  );

  if (expiresAt <= now.getTime()) {
    expiresAt = Date.UTC(
      chinaNow.getUTCFullYear(),
      chinaNow.getUTCMonth(),
      chinaNow.getUTCDate() + 1,
      15,
      59,
      59,
    );
  }

  return Math.max(1, Math.ceil((expiresAt - now.getTime()) / 1000));
}

const FACTOR_RETURNS_CACHE_PREFIX = "macd:factor:returns:";

// Drop every cached factor-returns payload (all statuses / modes / start dates).
// Called whenever a factor's status or enabled flag changes, so the performance
// cards reflect the new factor universe immediately instead of after market close.
export async function clearFactorReturnsCache() {
  try {
    const redis = await getRedisClient();
    const keys = [];
    // scanIterator yields batches (arrays of keys) in this redis client
    // version, so flatten each chunk before deleting.
    for await (const chunk of redis.scanIterator({ MATCH: `${FACTOR_RETURNS_CACHE_PREFIX}*` })) {
      for (const key of Array.isArray(chunk) ? chunk : [chunk]) keys.push(key);
    }
    if (keys.length) await redis.del(keys);
  } catch {
    // Redis is optional; if it's unavailable the cache simply expires on its own.
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function toDateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function buildEmptyData(factorNames) {
  const data = {};
  for (const key of Object.keys(PERIOD_TRADING_DAYS)) {
    data[key] = factorNames.map((name) => ({ factor: factorLabel(name), value: 0, sampleSize: 0 }));
  }
  return data;
}

export function createMacdFactorReturnsHandler() {
  return async function macdFactorReturnsHandler(req, res) {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const mode = url.searchParams.get("mode") === "custom" ? "custom" : "trailing";
      const startDate = url.searchParams.get("startDate") || "";
      const statusParam = url.searchParams.get("status");
      const status = statusParam === "preliminary" ? "preliminary" : "production";
      const forceRefresh = url.searchParams.get("force") === "1";

      if (forceRefresh) {
        // Historical signals or klines may have been backfilled. Clear every
        // factor-return cache so all ranges are recomputed on their next read.
        await clearFactorReturnsCache();
      }

      const cacheKey = `${FACTOR_RETURNS_CACHE_PREFIX}${status}:${mode}:${mode === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : "trailing"}`;
      if (!forceRefresh) {
        try {
          const redis = await getRedisClient();
          const cached = await redis.get(cacheKey);
          if (cached) {
            await redis.expire(cacheKey, getSecondsUntilChinaDayEnd());
            return sendJson(res, 200, JSON.parse(cached));
          }
        } catch {
          // Redis cache is optional; fall back to MySQL.
        }
      }

      const pool = getMysqlPool();

      // 0. Resolve the factor universe for this status from factor_dim
      const factorNames = (await fetchFactorDim(status)).map((f) => f.name);
      if (!factorNames.length) {
        return sendJson(res, 200, { ok: true, data: buildEmptyData([]) });
      }

      // 1. Fetch signal rows from macd_factor_sync_result, scoped to these factors
      const factorPlaceholders = factorNames.map(() => "?").join(",");
      let signalQuery = `SELECT factor_name, trade_date, codes FROM macd_factor_sync_result WHERE market = 'cn' AND factor_name IN (${factorPlaceholders})`;
      const signalParams = [...factorNames];

      if (mode === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        signalQuery += " AND trade_date >= ?";
        signalParams.push(startDate);
      } else {
        // Trailing: look back 180 calendar days so 3m (60 trading days) periods are covered
        signalQuery += " AND trade_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)";
      }

      const [signalRows] = await pool.query(signalQuery, signalParams);
      if (!signalRows.length) {
        return sendJson(res, 200, { ok: true, data: buildEmptyData(factorNames) });
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
        return sendJson(res, 200, { ok: true, data: buildEmptyData(factorNames) });
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
      for (const factorName of factorNames) {
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
        data[key] = factorNames.map((factorName) => {
          const { sum, count } = acc[factorName][key];
          return {
            factor: factorLabel(factorName),
            value: count > 0 ? parseFloat((sum / count).toFixed(2)) : 0,
            sampleSize: count,
          };
        });
      }

      const result = { ok: true, data };
      try {
        const redis = await getRedisClient();
        await redis.setEx(cacheKey, getSecondsUntilChinaDayEnd(), JSON.stringify(result));
      } catch {
        // Redis cache is optional; return the computed result.
      }
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
