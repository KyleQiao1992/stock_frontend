import { parseTencentQuoteIndicators } from "./tencentQuoteIndicators.js";

const TENCENT_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://gu.qq.com/",
};

export function normalizeHkCode(value) {
  let raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  raw = raw.replace(/^HK/, "").replace(/\.HK$/, "");
  if (!/^\d{1,5}$/.test(raw)) return "";
  return raw.padStart(5, "0");
}

function periodToTencentKtype(period) {
  if (String(period) === "101") return "day";
  if (String(period) === "102") return "week";
  if (String(period) === "103") return "month";
  throw new Error("港股 K 线周期无效");
}

function adjustToTencentFq(adjust) {
  const value = String(adjust);
  if (value === "0") return "";
  if (value === "1") return "qfq";
  if (value === "2") return "hfq";
  throw new Error("港股复权类型无效");
}

function finite(value) {
  if ((typeof value !== "number" && typeof value !== "string")
      || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseTencentHkRows(rows) {
  let previousClose = null;
  let previousDate = '';
  const numeric = value => (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim()) ? NaN : Number(value);
  return (Array.isArray(rows) ? rows : [])
    .map((item, index) => {
      if (!Array.isArray(item)) throw new Error(`腾讯港股 K 线第 ${index + 1} 行格式异常`);
      const open = numeric(item?.[1]);
      const close = numeric(item?.[2]);
      const high = numeric(item?.[3]);
      const low = numeric(item?.[4]);
      const volume = numeric(item?.[5]);
      const date = String(item?.[0] ?? '');
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date
        || (previousDate && date <= previousDate)
        || [open, close, high, low].some(value => !Number.isFinite(value) || value <= 0)
        || !Number.isFinite(volume) || volume < 0 || high < Math.max(open, close)
        || low > Math.min(open, close) || low > high) throw new Error(`腾讯港股 K 线第 ${index + 1} 行格式异常`);
      const change = previousClose === null ? 0 : close - previousClose;
      const pct = previousClose ? (change / previousClose) * 100 : 0;
      previousClose = close;
      previousDate = date;
      return {
        date,
        open,
        close,
        high,
        low,
        volume,
        amount: 0,
        amplitude: low ? ((high - low) / low) * 100 : 0,
        pct,
        change,
        turnover: 0,
      };
    });
}

export function parseTencentHkQuote(qt, fallbackCode = "") {
  if (!Array.isArray(qt) || !qt.length) return {};
  const totalMarketCapYi = finite(qt[45]);
  const floatMarketCapYi = finite(qt[44]);
  return {
    ...parseTencentQuoteIndicators(qt, "hk"),
    code: normalizeHkCode(qt[2]) || fallbackCode,
    name: String(qt[1] || fallbackCode),
    latestPrice: finite(qt[3]),
    previousClose: finite(qt[4]),
    quoteTime: String(qt[30] || ""),
    change: finite(qt[31]),
    pct: finite(qt[32]),
    peRatio: finite(qt[39]),
    turnoverRate: finite(qt[59]),
    marketCap: totalMarketCapYi === null ? null : Math.round(totalMarketCapYi * 100000000),
    floatMarketCap: floatMarketCapYi === null ? null : Math.round(floatMarketCapYi * 100000000),
    boardLot: finite(qt[60]),
    currency: String(qt[75] || "HKD"),
    totalShares: finite(qt[69]),
    floatShares: finite(qt[70]),
  };
}

export function parseTencentHkPayload(payload, { code, period = "101", adjust = "1", limit = 1000 } = {}) {
  const normalized = normalizeHkCode(code);
  if (!normalized) throw new Error("请输入有效的港股代码，例如 00700、09988。");
  const symbol = `hk${normalized}`;
  const node = payload?.data?.[symbol];
  if (!node) throw new Error("腾讯港股行情未返回该标的。");
  const ktype = periodToTencentKtype(period);
  const fq = adjustToTencentFq(adjust);
  const rawRows = node[`${fq}${ktype}`];
  if (!Array.isArray(rawRows)) throw new Error(`腾讯港股缺少${fq === 'qfq' ? '前复权' : fq === 'hfq' ? '后复权' : '不复权'} K 线`);
  const klines = parseTencentHkRows(rawRows).slice(-Math.max(1, Number(limit) || 1000));
  if (!klines.length) throw new Error("腾讯港股 K 线为空。");
  const quote = parseTencentHkQuote(node?.qt?.[symbol], normalized);
  return {
    ...quote,
    code: quote.code || normalized,
    name: quote.name || normalized,
    klines,
    sourceInfo: `Tencent ${symbol} ${ktype} ${fq} rows=${klines.length}`,
  };
}

export function parseTencentHkSearch(text) {
  const match = String(text || "").trim().match(/^v_hint=("[\s\S]*")$/);
  if (!match) return [];
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const seen = new Set();
  return String(value || "").split("^").flatMap((entry) => {
    const [market, rawCode, name, pinyin, type] = entry.split("~");
    const code = normalizeHkCode(rawCode);
    if (market !== "hk" || type !== "GP" || !code || seen.has(code)) return [];
    seen.add(code);
    return [{ code, name: String(name || code), pinyin: String(pinyin || ""), market: "港股", type }];
  });
}

export async function loadHkKline(params, request = fetch) {
  const code = normalizeHkCode(params?.code);
  if (!code) throw new Error("请输入有效的港股代码，例如 00700、09988。");
  const period = String(params?.period || "101");
  const adjust = String(params?.adjust || "1");
  const limit = Math.min(1000, Math.max(1, Number(params?.limit) || 600));
  const ktype = periodToTencentKtype(period);
  const fq = adjustToTencentFq(adjust);
  const symbol = `hk${code}`;
  const param = `${symbol},${ktype},,,${limit}${fq ? `,${fq}` : ""}`;
  const endpoint = fq ? "fqkline/get" : "kline/kline";
  const response = await request(
    `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}?param=${encodeURIComponent(param)}`,
    { headers: TENCENT_HEADERS, signal: AbortSignal.timeout(12000), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`腾讯港股行情 HTTP ${response.status}`);
  return parseTencentHkPayload(await response.json(), { code, period, adjust, limit });
}

export async function searchHkStocks(query, request = fetch) {
  const keyword = String(query || "").trim().slice(0, 40);
  if (!keyword) return [];
  const response = await request(
    `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(keyword)}&t=all`,
    { headers: TENCENT_HEADERS, signal: AbortSignal.timeout(8000), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`腾讯港股搜索 HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const text = new TextDecoder("gbk").decode(bytes);
  return parseTencentHkSearch(text).slice(0, 12);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export function createHkKlineHandler() {
  return async function hkKlineHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const result = await loadHkKline({
        code: requestUrl.searchParams.get("code"),
        period: requestUrl.searchParams.get("period"),
        adjust: requestUrl.searchParams.get("adjust"),
        limit: requestUrl.searchParams.get("limit"),
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}

export function createHkSearchHandler() {
  return async function hkSearchHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const items = await searchHkStocks(requestUrl.searchParams.get("q"));
      return sendJson(res, 200, { ok: true, items });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
