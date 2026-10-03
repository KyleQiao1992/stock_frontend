const ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,80,";
const HEADERS = { Referer: "https://gu.qq.com/", "User-Agent": "Mozilla/5.0" };
const CACHE_MS = 60000;
const MAX_SESSIONS = 80;

const failure = (code, message, cause) => Object.assign(new Error(message, { cause }), { code, stage: "trading-sessions" });
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const number = (value) => {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// Index candles establish real sessions, including sessions with zero limit-ups.
// No request is made at import time, and failures never become calendar data.
export function createMarketTradingSessionsProvider({ request = fetch, now = Date.now } = {}) {
  const recent = new Map();
  const inflight = new Map();

  async function retrieve(date) {
    let response;
    try {
      response = await request(ENDPOINT, { headers: HEADERS, signal: AbortSignal.timeout(6000), cache: "no-store" });
    } catch (cause) {
      throw failure("TS_NETWORK_ERROR", "交易日指数接口连接失败", cause);
    }
    if (!response?.ok) throw failure("TS_HTTP_ERROR", "交易日指数接口请求失败");
    let body;
    try { body = await response.json(); } catch (cause) { throw failure("TS_RESPONSE_INVALID", "交易日指数响应格式无效", cause); }
    const rows = body?.data?.sh000001?.day;
    if (body?.code !== 0 || !Array.isArray(rows) || !rows.length || rows.length > MAX_SESSIONS) {
      throw failure("TS_RESPONSE_INVALID", "交易日指数未提供有效会话");
    }
    const today = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    const sessions = [];
    for (const row of rows) {
      const session = row?.[0];
      const values = Array.isArray(row) ? row.slice(1, 6).map(number) : [];
      if (!Array.isArray(row) || row.length < 6 || !validDate(session) || session > today
        || sessions.length && session <= sessions[sessions.length - 1]
        || values.length !== 5 || !values.slice(0, 4).every((value) => value !== null && value > 0)
        || values[4] === null || values[4] < 0) {
        throw failure("TS_RESPONSE_INVALID", "交易日指数日期、顺序或行情字段无效");
      }
      sessions.push(session);
    }
    if (!sessions.includes(date)) throw failure("TS_SESSION_MISSING", "指定行情日期不在实际交易日序列中");
    return sessions.filter((session) => session <= date);
  }

  return async function load({ date, limit = 20, force = false } = {}) {
    const at = now();
    const today = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
    if (!validDate(date) || date > today || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSIONS) {
      throw failure("TS_INPUT_INVALID", "交易日查询日期或数量无效");
    }
    const cached = recent.get(date);
    let sessions;
    if (!force && cached && at >= cached.at && at - cached.at < CACHE_MS) {
      sessions = cached.sessions;
    } else {
      let pending = inflight.get(date);
      if (!pending) {
        pending = retrieve(date).then((value) => {
          recent.set(date, { sessions: value, at: now() });
          // Keep at most the provider's bounded history window in memory.
          if (recent.size > MAX_SESSIONS) recent.delete(recent.keys().next().value);
          return value;
        }).finally(() => { inflight.delete(date); });
        inflight.set(date, pending);
      }
      sessions = await pending;
    }
    return { date, previousDate: sessions[sessions.length - 2] || null,
      days: sessions.slice(-limit).map((session) => session.replaceAll("-", "")), source: "tencent-index" };
  };
}

export const loadMarketTradingSessions = createMarketTradingSessionsProvider();
