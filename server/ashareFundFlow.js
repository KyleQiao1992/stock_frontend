import { getRedisClient } from "./redisClient.js";

const EASTMONEY_UT = "b2884a393a59ad64002292a3e90d46a5";
const PRIMARY_HOSTS = [
  "https://push2his.eastmoney.com",
  "https://79.push2his.eastmoney.com",
  "https://push2delay.eastmoney.com",
];
const DATAPC_HISTORY_URL =
  "https://datapc.eastmoney.com/emdatacenter/CapitalFlow/GetHistory";
const PRIMARY_CACHE_SECONDS = 300;
const STALE_CACHE_SECONDS = 45 * 86400;
const memoryCache = new Map();

const FETCH_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://data.eastmoney.com/zjlx/detail.html",
};

function normalizeCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("Invalid A-share stock code.");
  return code;
}

function eastmoneyMarketId(code) {
  return /^(600|601|603|605|688|689|900)/.test(code) ? 1 : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePercentText(value) {
  return finiteNumber(String(value ?? "").replace("%", "").trim());
}

function parseAmountText(value) {
  const text = String(value ?? "").replaceAll(",", "").trim();
  const number = finiteNumber(text.replace(/[^\d.+-]/g, ""));
  if (!Number.isFinite(number)) return null;
  if (text.includes("亿")) return number * 100_000_000;
  if (text.includes("万")) return number * 10_000;
  return number;
}

function sumFinite(rows, key) {
  return rows.reduce((total, row) => {
    const value = row?.[key];
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function averageFinite(rows, key) {
  const values = rows.map((row) => row?.[key]).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function trendFromAmount(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 1) return "flat";
  return value > 0 ? "inflow" : "outflow";
}

export function parseEastmoneyFundFlowPayload(payload, code, limit = 30) {
  const klines = payload?.data?.klines;
  if (!Array.isArray(klines) || !klines.length) {
    throw new Error("AKShare-compatible fund-flow data is empty.");
  }

  const rows = klines
    .map((line) => {
      const fields = String(line || "").split(",");
      if (fields.length < 13) return null;
      return {
        date: fields[0],
        close: finiteNumber(fields[11]),
        changePct: finiteNumber(fields[12]),
        mainNetAmount: finiteNumber(fields[1]),
        mainNetRatio: finiteNumber(fields[6]),
        superLargeNetAmount: finiteNumber(fields[5]),
        superLargeNetRatio: finiteNumber(fields[10]),
        largeNetAmount: finiteNumber(fields[4]),
        largeNetRatio: finiteNumber(fields[9]),
        mediumNetAmount: finiteNumber(fields[3]),
        mediumNetRatio: finiteNumber(fields[8]),
        smallNetAmount: finiteNumber(fields[2]),
        smallNetRatio: finiteNumber(fields[7]),
        dde: null,
      };
    })
    .filter((row) => row?.date)
    .slice(-limit);

  if (!rows.length) throw new Error("AKShare-compatible fund-flow rows are invalid.");

  return buildFundFlowPayload({
    code,
    rows,
    source: {
      key: "akshare-eastmoney",
      name: "AKShare / 东方财富",
      mode: "primary",
    },
    fallbackUsed: false,
  });
}

export function parseEastmoneyDataPcPayload(payload, code, limit = 30) {
  const history = payload?.history;
  if (!Array.isArray(history) || !history.length) {
    throw new Error("Eastmoney historical fund-flow data is empty.");
  }

  const rows = history
    .map((item) => ({
      date: String(item?.rq || "").trim(),
      close: finiteNumber(item?.spj),
      changePct: parsePercentText(item?.zdf),
      mainNetAmount: parseAmountText(item?.zllr_je),
      mainNetRatio: parsePercentText(item?.zllr_jzb),
      superLargeNetAmount: parseAmountText(item?.cddjlr_je),
      superLargeNetRatio: parsePercentText(item?.cddjlr_jzb),
      largeNetAmount: parseAmountText(item?.ddjlr_je),
      largeNetRatio: parsePercentText(item?.ddjlr_jzb),
      mediumNetAmount: parseAmountText(item?.zdjlr_je),
      mediumNetRatio: parsePercentText(item?.zdjlr_jzb),
      smallNetAmount: parseAmountText(item?.xdjlr_je),
      smallNetRatio: parsePercentText(item?.xdjlr_jzb),
      dde: null,
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);

  if (!rows.length) throw new Error("Eastmoney historical fund-flow rows are invalid.");

  return buildFundFlowPayload({
    code,
    rows,
    source: {
      key: "akshare-eastmoney",
      name: "AKShare / 东方财富",
      mode: "primary",
    },
    fallbackUsed: false,
  });
}

function cleanHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeaderIndex(headers, pattern) {
  return headers.findIndex((header) => pattern.test(String(header || "")));
}

export function parseStockDdxHtml(html, code, limit = 30) {
  const tableRows = [...String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cleanHtml(cell[1])),
  );

  const headerRowIndex = tableRows.findIndex((cells) => {
    const joined = cells.join("|").toLowerCase();
    return joined.includes("ddx") && joined.includes("ddy");
  });
  if (headerRowIndex < 0) throw new Error("DDX backup table was not found.");

  const headers = tableRows[headerRowIndex].map((header) => header.toLowerCase());
  const dateIndex = findHeaderIndex(headers, /日期|时间|date/);
  const ddxIndex = findHeaderIndex(headers, /\bddx\b/);
  const ddyIndex = findHeaderIndex(headers, /\bddy\b/);
  const ddzIndex = findHeaderIndex(headers, /\bddz\b/);
  const bbdIndex = findHeaderIndex(headers, /\bbbd\b/);

  const rows = tableRows
    .slice(headerRowIndex + 1)
    .map((cells) => {
      const dateCell = dateIndex >= 0 ? cells[dateIndex] : cells.find((cell) => /^\d{4}-\d{2}-\d{2}/.test(cell));
      const dateMatch = String(dateCell || "").match(/\d{4}-\d{2}-\d{2}/);
      if (!dateMatch) return null;
      return {
        date: dateMatch[0],
        close: null,
        changePct: null,
        mainNetAmount: null,
        mainNetRatio: null,
        superLargeNetAmount: null,
        superLargeNetRatio: null,
        largeNetAmount: null,
        largeNetRatio: null,
        mediumNetAmount: null,
        mediumNetRatio: null,
        smallNetAmount: null,
        smallNetRatio: null,
        dde: {
          ddx: ddxIndex >= 0 ? finiteNumber(cells[ddxIndex]) : null,
          ddy: ddyIndex >= 0 ? finiteNumber(cells[ddyIndex]) : null,
          ddz: ddzIndex >= 0 ? finiteNumber(cells[ddzIndex]) : null,
          bbd: bbdIndex >= 0 ? finiteNumber(String(cells[bbdIndex] || "").replace(/[^\d.+-]/g, "")) : null,
        },
      };
    })
    .filter(Boolean)
    .slice(-limit);

  if (!rows.length) throw new Error("DDX backup data is empty.");
  return buildFundFlowPayload({
    code,
    rows,
    source: {
      key: "stockddx",
      name: "DDX 查询网",
      mode: "fallback",
    },
    fallbackUsed: true,
  });
}

function buildFundFlowPayload({ code, rows, source, fallbackUsed }) {
  const latest = rows.at(-1) || null;
  const recent5 = rows.slice(-5);
  const recent10 = rows.slice(-10);
  const small5 = sumFinite(recent5, "smallNetAmount");

  return {
    code,
    source,
    fallbackUsed,
    isProxy: true,
    proxyDescription:
      source.key === "stockddx"
        ? "备用源提供 DDX/DDY/DDZ；相关指标仍是基于成交结构的估算，不代表真实账户人数。"
        : "小单资金流用于观察散户资金倾向，不代表真实散户账户数量。",
    updatedAt: new Date().toISOString(),
    latest,
    summary: {
      retailTrend: source.key === "stockddx" ? null : trendFromAmount(small5),
      fiveDay: {
        mainNetAmount: sumFinite(recent5, "mainNetAmount"),
        smallNetAmount: small5,
        mainNetRatioAvg: averageFinite(recent5, "mainNetRatio"),
        smallNetRatioAvg: averageFinite(recent5, "smallNetRatio"),
      },
      tenDay: {
        mainNetAmount: sumFinite(recent10, "mainNetAmount"),
        smallNetAmount: sumFinite(recent10, "smallNetAmount"),
        mainNetRatioAvg: averageFinite(recent10, "mainNetRatio"),
        smallNetRatioAvg: averageFinite(recent10, "smallNetRatio"),
      },
    },
    rows,
  };
}

function mergePrimaryHistory(current, previous, limit) {
  if (
    current?.source?.key !== "akshare-eastmoney" ||
    previous?.source?.key !== "akshare-eastmoney" ||
    !Array.isArray(previous.rows)
  ) {
    return current;
  }

  const byDate = new Map();
  for (const row of [...previous.rows, ...(current.rows || [])]) {
    if (row?.date) byDate.set(row.date, row);
  }
  const rows = [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-limit);
  return buildFundFlowPayload({
    code: current.code,
    rows,
    source: current.source,
    fallbackUsed: false,
  });
}

async function fetchPrimary(code, limit) {
  try {
    const marketSuffix = eastmoneyMarketId(code) === 1 ? "1" : "2";
    const params = new URLSearchParams({ code: `${code}${marketSuffix}` });
    const response = await fetch(`${DATAPC_HISTORY_URL}?${params}`, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Eastmoney historical HTTP ${response.status}`);
    return parseEastmoneyDataPcPayload(await response.json(), code, limit);
  } catch {
    // The newer historical endpoint is preferred; the AKShare-compatible
    // day-kline hosts below remain available as a fallback.
  }

  const params = new URLSearchParams({
    lmt: "0",
    klt: "101",
    secid: `${eastmoneyMarketId(code)}.${code}`,
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
    ut: EASTMONEY_UT,
    _: String(Date.now()),
  });
  let lastError = null;

  for (const host of PRIMARY_HOSTS) {
    try {
      const response = await fetch(`${host}/api/qt/stock/fflow/daykline/get?${params}`, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
      return parseEastmoneyFundFlowPayload(await response.json(), code, limit);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("AKShare-compatible source is unavailable.");
}

async function fetchFallback(code, limit) {
  const template =
    process.env.DDX_BACKUP_URL_TEMPLATE?.trim() || "https://www.stockddx.com/ddx/{code}.html";
  const url = template.replaceAll("{code}", encodeURIComponent(code));
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,*/*",
      "User-Agent": FETCH_HEADERS["User-Agent"],
      Referer: "https://www.stockddx.com/",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`DDX backup HTTP ${response.status}`);
  return parseStockDdxHtml(await response.text(), code, limit);
}

async function readCache(cacheKey) {
  const memory = memoryCache.get(cacheKey);
  if (memory && memory.expiresAt > Date.now()) return { payload: memory.payload, stale: false };

  try {
    const redis = await getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const payload = JSON.parse(cached);
      memoryCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + PRIMARY_CACHE_SECONDS * 1000,
        staleUntil: Date.now() + STALE_CACHE_SECONDS * 1000,
      });
      return { payload, stale: false };
    }
  } catch {
    // Redis is optional; the in-memory cache remains available.
  }
  return null;
}

async function writeCache(cacheKey, payload) {
  memoryCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + PRIMARY_CACHE_SECONDS * 1000,
    staleUntil: Date.now() + STALE_CACHE_SECONDS * 1000,
  });
  try {
    const redis = await getRedisClient();
    const body = JSON.stringify(payload);
    await Promise.all([
      redis.set(cacheKey, body, { EX: PRIMARY_CACHE_SECONDS }),
      redis.set(`${cacheKey}:stale`, body, { EX: STALE_CACHE_SECONDS }),
    ]);
  } catch {
    // Redis is optional.
  }
}

async function readStaleCache(cacheKey) {
  const memory = memoryCache.get(cacheKey);
  if (memory && memory.staleUntil > Date.now()) return memory.payload;
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(`${cacheKey}:stale`);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function loadFundFlow(code, limit) {
  const cacheKey = `ashare-fund-flow:v2:${code}:${limit}`;
  const cached = await readCache(cacheKey);
  if (cached) return cached.payload;

  let primaryError;
  try {
    const current = await fetchPrimary(code, limit);
    const previous = await readStaleCache(cacheKey);
    const payload = mergePrimaryHistory(current, previous, limit);
    await writeCache(cacheKey, payload);
    return payload;
  } catch (error) {
    primaryError = error;
  }

  try {
    const payload = await fetchFallback(code, limit);
    payload.primaryError = primaryError?.message || String(primaryError);
    await writeCache(cacheKey, payload);
    return payload;
  } catch (fallbackError) {
    const stale = await readStaleCache(cacheKey);
    if (stale) {
      return {
        ...stale,
        stale: true,
        warning: "主数据源和备用源暂时不可用，当前展示最近一次成功缓存。",
      };
    }
    throw new Error(
      `Fund-flow sources unavailable: ${primaryError?.message || primaryError}; ` +
        `${fallbackError?.message || fallbackError}`,
      { cause: fallbackError },
    );
  }
}

export function createAshareFundFlowHandler() {
  return async function ashareFundFlowHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const code = normalizeCode(requestUrl.searchParams.get("code"));
      const limit = Math.min(100, Math.max(5, Number(requestUrl.searchParams.get("limit")) || 30));
      const payload = await loadFundFlow(code, limit);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || String(error) }));
    }
  };
}
