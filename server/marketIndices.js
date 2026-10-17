// Keep the exchange in every index identity: bare 000001 is also 平安银行.
export const MARKET_INDICES = Object.freeze([
  Object.freeze({ code: "000001", name: "上证指数", tencentSymbol: "sh000001" }),
  Object.freeze({ code: "000688", name: "科创50", tencentSymbol: "sh000688" }),
  Object.freeze({ code: "399001", name: "深证成指", tencentSymbol: "sz399001" }),
  Object.freeze({ code: "399006", name: "创业板指", tencentSymbol: "sz399006" }),
]);

const ENDPOINT = `https://qt.gtimg.cn/q=${MARKET_INDICES.map((index) => index.tencentSymbol).join(",")}`;
const HEADERS = { Referer: "https://gu.qq.com/", "User-Agent": "Mozilla/5.0" };
const CACHE_MS = 30_000;

function numeric(value) {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseQuote(index, fields, at) {
  if (fields.length < 33 || fields[2] !== index.code || !fields[1]?.trim()) {
    throw new Error("指数报价身份或格式无效。");
  }
  const price = numeric(fields[3]);
  const previousClose = numeric(fields[4]);
  const change = numeric(fields[31]);
  const pct = numeric(fields[32]);
  if (price === null || price <= 0 || previousClose === null || previousClose <= 0
    || change === null || pct === null || pct <= -100
    || Math.abs(price - previousClose - change) > 0.03
    || Math.abs((price - previousClose) / previousClose * 100 - pct) > 0.02) {
    throw new Error("指数点位、涨跌额或涨跌幅无效。");
  }
  const timestamp = fields[30];
  if (!/^\d{14}$/.test(timestamp)) throw new Error("指数行情时间无效。");
  const localTime = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`;
  const quoteTime = `${localTime}+08:00`;
  const quoteAt = Date.parse(quoteTime);
  if (!Number.isFinite(quoteAt) || quoteAt > at + 300_000
    || new Date(quoteAt + 8 * 3_600_000).toISOString().slice(0, 19) !== localTime) {
    throw new Error("指数行情日期或时间无效。");
  }
  return { ...index, available: true, price, change, pct, quoteTime };
}

const unavailable = (index, error) => ({ ...index, available: false, error });
const cloneResult = (result) => ({ ...result, indices: result.indices.map((index) => ({ ...index })) });

export function createMarketIndicesProvider({ request = fetch, now = Date.now } = {}) {
  let cached = null;
  let inflight = null;

  async function retrieve() {
    let response;
    try {
      response = await request(ENDPOINT, {
        headers: HEADERS, signal: AbortSignal.timeout(8000), cache: "no-store",
      });
    } catch (cause) {
      throw new Error("常用指数行情连接失败或超时。", { cause });
    }
    if (!response?.ok) throw new Error(`常用指数行情接口 HTTP ${response?.status || "无响应"}。`);
    let body;
    try {
      body = new TextDecoder("gb18030").decode(await response.arrayBuffer());
    } catch (cause) {
      throw new Error("常用指数行情响应读取失败。", { cause });
    }
    const at = now();
    const quotes = new Map();
    for (const match of body.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)"\s*;/g)) {
      const index = MARKET_INDICES.find((item) => item.tencentSymbol === match[1]);
      if (!index) continue;
      if (quotes.has(match[1])) {
        quotes.set(match[1], unavailable(index, "指数行情返回了重复报价。"));
        continue;
      }
      try { quotes.set(match[1], parseQuote(index, match[2].split("~"), at)); }
      catch (error) { quotes.set(match[1], unavailable(index, error.message)); }
    }
    const indices = MARKET_INDICES.map((index) => quotes.get(index.tencentSymbol)
      || unavailable(index, "行情接口未返回该指数。"));
    const received = indices.filter((index) => index.available).length;
    if (!received) {
      throw Object.assign(new Error("常用指数行情均不可用。"), { indices });
    }
    return { source: "tencent", updatedAt: new Date(at).toISOString(), partial: received !== MARKET_INDICES.length, indices };
  }

  return async function loadMarketIndices() {
    const at = now();
    if (cached && at >= cached.at && at - cached.at < CACHE_MS) return cloneResult(cached.result);
    if (!inflight) {
      inflight = retrieve().then((result) => {
        cached = { at: now(), result };
        return result;
      }).finally(() => { inflight = null; });
    }
    return cloneResult(await inflight);
  };
}

export const loadMarketIndices = createMarketIndicesProvider();

export function createMarketIndicesHandler({ load = loadMarketIndices } = {}) {
  return async function marketIndicesHandler(_req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await load();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const message = error?.message || "常用指数行情加载失败。";
      res.statusCode = 502;
      res.end(JSON.stringify({ ok: false, error: message,
        indices: error?.indices || MARKET_INDICES.map((index) => unavailable(index, message)) }));
    }
  };
}
