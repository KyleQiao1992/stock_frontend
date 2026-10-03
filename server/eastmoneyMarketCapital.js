const ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const COLUMNS = "SECURITY_CODE,SECUCODE,TRADE_DATE,CLOSE_PRICE,TOTAL_MARKET_CAP,NOTLIMITED_MARKETCAP_A";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://data.eastmoney.com/" };
const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

const failure = (code, message, cause) => Object.assign(new Error(message, { cause }), { code, stage: "market-capital" });
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function hasSameDayMarketCapital(payload, expected) {
  const quoteAt = Date.parse(payload?.quoteTime);
  const quoteDate = Number.isFinite(quoteAt) ? new Date(quoteAt + 8 * 3600000).toISOString().slice(0, 10) : null;
  const dates = [payload?.dataDate, payload?.date].filter((value) => value != null);
  const date = dates[0] || quoteDate;
  return Number.isSafeInteger(expected) && expected > 0 && validDate(date)
    && dates.every((value) => validDate(value) && value === date)
    && (payload?.quoteTime == null || quoteDate === date)
    && payload?.capitalSource === "eastmoney" && payload.capitalDate === date
    && payload.capitalCoverage?.expected === expected && payload.capitalCoverage.received === expected;
}

function number(value) {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function identity(row) {
  const code = String(row?.code || "");
  const exchange = row?.exchange || (row?.market === 1 ? "sh" : /^(?:[48]|920)/.test(code) ? "bj" : "sz");
  const symbol = `${exchange}${code}`;
  return /^(?:sh(?:60|68)\d{4}|sz(?:00|30)\d{4}|bj(?:[48]\d{5}|920\d{3}))$/.test(symbol) ? symbol : null;
}

// This report exposes dated closing valuations. It is deliberately not a
// substitute for intraday market capital when its close differs from the quote.
export function createEastmoneyMarketCapitalProvider({ request = fetch, now = Date.now, budgetMs = 15000 } = {}) {
  return async function load({ date, stocks, signal } = {}) {
    const today = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    if (!validDate(date) || date > today || !Array.isArray(stocks) || !stocks.length || stocks.length > MAX_ROWS) {
      throw failure("EM_CAPITAL_INPUT_INVALID", "市值查询日期或股票名单无效");
    }
    const requested = new Map();
    for (const stock of stocks) {
      const symbol = identity(stock);
      if (!symbol || requested.has(symbol)) throw failure("EM_CAPITAL_INPUT_INVALID", "市值查询股票身份无效或重复");
      requested.set(symbol, stock);
    }
    const deadline = now() + budgetMs;
    async function page(pageNumber) {
      if (signal?.aborted) throw signal.reason || failure("EM_CAPITAL_ABORTED", "市值查询已取消");
      const remaining = deadline - now();
      if (remaining <= 0) throw failure("EM_CAPITAL_TIMEOUT", "市值查询超时");
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(8000, Math.floor(remaining))));
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ reportName: "RPT_VALUEANALYSIS_DET", columns: COLUMNS,
        filter: `(TRADE_DATE='${date}')`, pageSize: String(PAGE_SIZE), pageNumber: String(pageNumber),
        sortColumns: "SECURITY_CODE", sortTypes: "1", source: "WEB", client: "WEB" });
      let response;
      try {
        response = await request(url.href, { headers: HEADERS, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (cause) {
        throw failure("EM_CAPITAL_NETWORK_ERROR", "东方财富市值接口连接失败", cause);
      }
      if (!response.ok) throw Object.assign(failure("EM_CAPITAL_HTTP_ERROR", "东方财富市值接口请求失败"), { status: response.status });
      let body;
      try { body = await response.json(); } catch (cause) { throw failure("EM_CAPITAL_RESPONSE_INVALID", "东方财富市值响应格式无效", cause); }
      if (body?.success !== true || !body.result || !Array.isArray(body.result.data)
        || !Number.isSafeInteger(body.result.count) || body.result.count <= 0 || body.result.count > MAX_ROWS) {
        throw failure("EM_CAPITAL_RESPONSE_INVALID", "东方财富未提供同日有效市值");
      }
      return body.result;
    }
    const first = await page(1);
    const total = first.count;
    const pageCount = Math.ceil(total / PAGE_SIZE);
    if (first.pages !== pageCount || first.data.length !== Math.min(PAGE_SIZE, total)) {
      throw failure("EM_CAPITAL_COVERAGE_INCOMPLETE", "东方财富市值分页数量不完整");
    }
    const pages = [first];
    let cursor = 2;
    let failed = null;
    async function worker() {
      while (!failed && cursor <= pageCount) {
        const current = cursor++;
        try {
          const result = await page(current);
          const expected = Math.min(PAGE_SIZE, total - (current - 1) * PAGE_SIZE);
          if (result.count !== total || result.pages !== pageCount || result.data.length !== expected) {
            throw failure("EM_CAPITAL_COVERAGE_INCOMPLETE", "东方财富市值分页总量不一致");
          }
          pages.push(result);
        } catch (error) { failed ||= error; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, pageCount - 1) }, worker));
    if (failed) throw failed;
    const bySymbol = new Map();
    for (const raw of pages.flatMap((result) => result.data)) {
      const security = typeof raw.SECUCODE === "string" && /^(\d{6})\.(SH|SZ|BJ)$/.exec(raw.SECUCODE);
      const symbol = security ? `${security[2].toLowerCase()}${security[1]}` : null;
      const row = { symbol, code: security?.[1], exchange: security?.[2].toLowerCase(),
        cap: number(raw.TOTAL_MARKET_CAP), floatCap: number(raw.NOTLIMITED_MARKETCAP_A),
        close: number(raw.CLOSE_PRICE), quoteDate: typeof raw.TRADE_DATE === "string" ? raw.TRADE_DATE.slice(0, 10) : null };
      if (!symbol || raw.SECURITY_CODE !== row.code || identity(row) !== symbol || row.quoteDate !== date
        || [row.cap, row.floatCap, row.close].some((value) => value === null)) {
        throw failure("EM_CAPITAL_RESPONSE_INVALID", "东方财富市值身份、日期或数值无效");
      }
      if (bySymbol.has(symbol)) throw failure("EM_CAPITAL_COVERAGE_INCOMPLETE", "东方财富市值含重复股票");
      bySymbol.set(symbol, row);
    }
    if (bySymbol.size !== total) throw failure("EM_CAPITAL_COVERAGE_INCOMPLETE", "东方财富市值总量不完整");
    const capitals = [...requested].map(([symbol, stock]) => {
      const capital = bySymbol.get(symbol);
      if (!capital) throw failure("EM_CAPITAL_COVERAGE_INCOMPLETE", "东方财富同日市值未覆盖所有已上市股票");
      // Unavailable/older individual quotes do not invalidate dated capital.
      // Their price/turnover must remain unavailable in the market aggregate.
      const unavailable = (stock.quoteDate != null && stock.quoteDate !== date)
        || (stock.close == null && stock.pct == null);
      const close = number(stock.close);
      if (!unavailable && (close === null || Math.abs(close - capital.close) > Math.max(1, close) * 1e-10)) {
        throw failure("EM_CAPITAL_CLOSE_MISMATCH", "东方财富收盘估值价格与当前报价不同，不能替代盘中市值");
      }
      return capital;
    });
    return { capitalSource: "eastmoney", capitalDate: date, capitalUpdatedAt: new Date(now()).toISOString(),
      coverage: { expected: requested.size, received: capitals.length }, capitals };
  };
}

export const loadEastmoneyMarketCapital = createEastmoneyMarketCapitalProvider();
