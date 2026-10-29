import { parseTencentQuoteIndicators } from "./tencentQuoteIndicators.js";

function periodToTencentKtype(period) {
  if (String(period) === "102") return "week";
  if (String(period) === "103") return "month";
  return "day";
}

function adjustToTencentFq(adjust) {
  if (String(adjust) === "1") return "qfq";
  if (String(adjust) === "2") return "hfq";
  return "";
}

function parseOptionalNumber(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalidRow(index) {
  return Object.assign(new Error(`invalid US K线 OHLC/date/volume row ${index + 1}`), { code: "US_KLINE_INVALID" });
}

function parseTencentUsRows(arr) {
  let previousDate = "";
  const rows = arr.map((item, index) => {
    if (!Array.isArray(item)) throw invalidRow(index);
    const [date, rawOpen, rawClose, rawHigh, rawLow, rawVolume] = item;
    const open = parseOptionalNumber(rawOpen), close = parseOptionalNumber(rawClose);
    const high = parseOptionalNumber(rawHigh), low = parseOptionalNumber(rawLow);
    const volume = parseOptionalNumber(rawVolume);
    if (!validDate(date) || (previousDate && date <= previousDate)
        || ![open, close, high, low].every(value => Number.isFinite(value) && value > 0)
        || low > Math.min(open, close) || high < Math.max(open, close)
        || volume === null || volume < 0) {
      throw invalidRow(index);
    }
    previousDate = date;
    return {
      date, open, close, high, low, volume,
      amount: 0,
      amplitude: 0,
      pct: 0,
      change: 0,
      turnover: 0,
    };
  });

  let prevClose = null;
  for (const row of rows) {
    row.change = prevClose !== null ? row.close - prevClose : 0;
    row.pct = prevClose ? (row.change / prevClose) * 100 : 0;
    row.amplitude = row.low !== 0 ? ((row.high - row.low) / row.low) * 100 : 0;
    prevClose = row.close;
  }
  return rows;
}

// Tencent (gtimg) serves US quotes and is reliably reachable from CN-hosted servers,
// where Nasdaq's Akamai CDN times out and eastmoney's anti-bot WAF resets Node requests.
// US symbols need an exchange suffix: .OQ = NASDAQ, .N = NYSE, .A = NYSE American.
async function loadUsKlineFromTencent({ normalized, period, adjust, boundedLimit }) {
  const ktype = periodToTencentKtype(period);
  const fq = adjustToTencentFq(adjust);
  const suffixes = [".OQ", ".N", ".A", ""];
  const errors = [];
  let best = null;

  for (const suffix of suffixes) {
    const sym = `us${normalized}${suffix}`;
    const param = `${sym},${ktype},,,${boundedLimit}${fq ? `,${fq}` : ""}`;
    const endpoint = fq ? "fqkline/get" : "kline/kline";
    const url = `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}?param=${encodeURIComponent(param)}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Referer: "https://gu.qq.com/",
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        errors.push(`${sym}: HTTP ${res.status}`);
        continue;
      }
      const payload = await res.json();
      const node = payload?.data?.[sym];
      // Exact field required: do not silently substitute unadjusted prices.
      const arr = node?.[fq ? `${fq}${ktype}` : ktype];
      if (!Array.isArray(arr) || arr.length === 0) {
        errors.push(`${sym}: empty`);
        continue;
      }
      const rows = parseTencentUsRows(arr).slice(-boundedLimit);
      if (!rows.length) {
        errors.push(`${sym}: parse failed`);
        continue;
      }
      // The wrong exchange suffix returns a stub (1-2 bars); keep the richest series.
      if (!best || rows.length > best.klines.length) {
        const qt = node?.qt?.[sym];
        const name = qt && qt[1] ? qt[1] : normalized;
        best = {
          code: normalized,
          name,
          sourceInfo: `Tencent ${sym} ${ktype} ${fq || "raw"} rows=${rows.length}`,
          klines: rows,
        };
      }
      // A full series is a confident match; stop early.
      if (best.klines.length >= Math.min(boundedLimit, 20)) break;
    } catch (e) {
      // An exchange candidate with a corrupt history cannot safely be replaced
      // with a short, potentially different-exchange stub.
      if (e?.code === "US_KLINE_INVALID") throw e;
      errors.push(`${sym}: ${e?.message || e}`);
    }
  }

  if (best) return best;
  throw new Error(`tencent US source failed: ${errors.slice(-3).join("; ")}`);
}

// Tencent US valuation fields share these positions with A-shares; other fields differ.
// [38]=turnover rate %, [39]=PE (TTM), [44]=float market cap (亿), [45]=total market cap (亿).
// Market-cap fields are in 亿 (1e8) USD; multiply to get absolute dollars.
// NOTE: this endpoint resolves the bare `usSYMBOL` form (no .OQ/.N suffix) and returns GBK text.
async function loadUsQuoteMeta(normalized) {
  const res = await fetch(`https://qt.gtimg.cn/q=us${normalized}`, {
    headers: {
      Accept: "text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: "https://gu.qq.com/",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Tencent quote HTTP ${res.status}`);

  // GBK-encoded; a Chinese name byte can be 0x7E (~), so decode before splitting on ~.
  const text = new TextDecoder("gbk").decode(await res.arrayBuffer());
  const body = text.match(/"([^"]*)"/)?.[1];
  const fields = body ? body.split("~") : [];
  if (fields.length < 46) throw new Error("Tencent quote unavailable"); // e.g. v_pv_none_match

  const turnoverRate = parseOptionalNumber(fields[38]);
  const peRatio = parseOptionalNumber(fields[39]);
  const floatCapYi = parseOptionalNumber(fields[44]);
  const totalCapYi = parseOptionalNumber(fields[45]);
  return {
    ...parseTencentQuoteIndicators(fields, "us"),
    quoteTime: fields[30] || "",
    marketCap: Number.isFinite(totalCapYi) ? totalCapYi * 1e8 : null,
    floatMarketCap: Number.isFinite(floatCapYi) ? floatCapYi * 1e8 : null,
    peRatio: Number.isFinite(peRatio) ? peRatio : null,
    turnoverRate: Number.isFinite(turnoverRate) ? turnoverRate : null,
  };
}

async function loadUsKline({ symbol, period = "101", limit = 600, adjust = "1" }) {
  const normalized = String(symbol || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(normalized)) {
    throw new Error("Invalid US stock symbol.");
  }
  if (!["101", "102", "103"].includes(String(period))) throw new Error("Unsupported US K线 period");
  if (!["0", "1", "2"].includes(String(adjust))) throw new Error("Unsupported US K线 复权 setting");

  const boundedLimit = Math.min(Math.max(Number(limit) || 600, 30), 2000);

  // The Nasdaq historical endpoint's adjustment basis is not verified.  It
  // cannot replace either adjusted or raw Tencent history without changing the
  // requested data semantics, even if its response happens to have valid OHLC.
  const klinePromise = (async () => {
    try {
      return await loadUsKlineFromTencent({ normalized, period, adjust, boundedLimit });
    } catch (tencentError) {
      throw new Error(`US K线不可用: ${tencentError?.message || tencentError}; Nasdaq 历史数据复权口径尚未核实`, { cause: tencentError });
    }
  })();

  // Market-cap/PE/turnover are best-effort: never let a quote miss break the kline response.
  const [base, meta] = await Promise.all([
    klinePromise,
    loadUsQuoteMeta(normalized).catch(() => null),
  ]);

  return {
    ...base,
    volumeRatio: meta?.volumeRatio ?? null,
    volumeRatioSource: meta?.volumeRatioSource || "unavailable",
    sessionVwap: meta?.sessionVwap ?? null,
    sessionVwapPremium: meta?.sessionVwapPremium ?? null,
    sessionVwapSource: meta?.sessionVwapSource || "unavailable",
    innerVol: null,
    outerVol: null,
    tradeSideVolumeSource: "unavailable",
    indicatorsQuoteTime: meta?.indicatorsQuoteTime || "",
    quoteTime: meta?.quoteTime || "",
    marketCap: meta?.marketCap ?? null,
    floatMarketCap: meta?.floatMarketCap ?? null,
    peRatio: meta?.peRatio ?? null,
    turnoverRate: meta?.turnoverRate ?? null,
  };
}

export function createUsKlineHandler() {
  return async function usKlineHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const payload = await loadUsKline({
        symbol: requestUrl.searchParams.get("symbol") || "",
        period: requestUrl.searchParams.get("period") || "101",
        limit: requestUrl.searchParams.get("limit") || "600",
        adjust: requestUrl.searchParams.get("adjust") || "1",
      });
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
