function parseNasdaqNumber(value) {
  const cleaned = String(value || "")
    .replaceAll("$", "")
    .replaceAll(",", "")
    .trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function toIsoDate(value) {
  const [month, day, year] = String(value || "").split("/");
  if (!month || !day || !year) return "";
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function addYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatEasternDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function extractDateFromNasdaqTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return formatEasternDate(parsed);

  const datePart = raw.match(/^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/)?.[0] || "";
  if (!datePart) return "";
  const fallback = new Date(datePart);
  if (Number.isNaN(fallback.getTime())) return "";
  return formatEasternDate(fallback);
}

function parseDayRange(value) {
  const [first, second] = String(value || "").split("/");
  const a = parseNasdaqNumber(first);
  const b = parseNasdaqNumber(second);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { high: null, low: null };
  return { high: Math.max(a, b), low: Math.min(a, b) };
}

function aggregateRows(rows, period) {
  if (period === "101") return rows;

  const buckets = new Map();
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;

    let key;
    if (period === "102") {
      const day = date.getUTCDay() || 7;
      const monday = new Date(date);
      monday.setUTCDate(date.getUTCDate() - day + 1);
      key = formatDate(monday);
    } else {
      key = row.date.slice(0, 7);
    }

    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { ...row });
      continue;
    }

    bucket.close = row.close;
    bucket.high = Math.max(bucket.high, row.high);
    bucket.low = Math.min(bucket.low, row.low);
    bucket.volume += row.volume;
    bucket.amount += row.amount;
    bucket.date = row.date;
  }

  return Array.from(buckets.values());
}

async function loadUsQuoteSnapshot(symbol) {
  const headers = {
    Accept: "application/json,text/plain,*/*",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Referer: "https://www.nasdaq.com/",
  };

  const [infoRes, summaryRes] = await Promise.all([
    fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`, { headers }),
    fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`, { headers }),
  ]);

  if (!infoRes.ok) throw new Error(`Nasdaq info HTTP ${infoRes.status}`);
  if (!summaryRes.ok) throw new Error(`Nasdaq summary HTTP ${summaryRes.status}`);

  const infoPayload = await infoRes.json();
  const summaryPayload = await summaryRes.json();
  const primary = infoPayload?.data?.primaryData || {};
  const summary = summaryPayload?.data?.summaryData || {};
  const quoteDate = extractDateFromNasdaqTimestamp(primary?.lastTradeTimestamp);
  const close = parseNasdaqNumber(primary?.lastSalePrice);
  const volume = parseNasdaqNumber(primary?.volume) || 0;
  const previousClose = parseNasdaqNumber(summary?.PreviousClose?.value);
  const range = parseDayRange(summary?.TodayHighLow?.value || infoPayload?.data?.keyStats?.dayrange?.value);

  if (!quoteDate || !Number.isFinite(close) || !Number.isFinite(previousClose)) {
    return null;
  }

  const open = previousClose;
  const high = Number.isFinite(range.high) ? Math.max(range.high, close, open) : Math.max(close, open);
  const low = Number.isFinite(range.low) ? Math.min(range.low, close, open) : Math.min(close, open);
  const change = close - previousClose;
  const pct = previousClose !== 0 ? (change / previousClose) * 100 : 0;

  return {
    date: quoteDate,
    open,
    close,
    high,
    low,
    volume,
    amount: close * volume,
    amplitude: low !== 0 ? ((high - low) / low) * 100 : 0,
    pct,
    change,
    turnover: 0,
    marketStatus: infoPayload?.data?.marketStatus || "",
    isIntradayEstimate: true,
  };
}

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

function parseTencentUsRows(arr) {
  const rows = arr
    .map((item) => ({
      date: item[0],
      open: Number(item[1]),
      close: Number(item[2]),
      high: Number(item[3]),
      low: Number(item[4]),
      volume: Number(item[5]),
      amount: 0,
      amplitude: 0,
      pct: 0,
      change: 0,
      turnover: 0,
    }))
    .filter((r) => r.date && [r.open, r.close, r.high, r.low].every(Number.isFinite));

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
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`;
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
      const arr = (fq && Array.isArray(node?.[`${fq}${ktype}`])) ? node[`${fq}${ktype}`] : node?.[ktype];
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
      errors.push(`${sym}: ${e?.message || e}`);
    }
  }

  if (best) return best;
  throw new Error(`tencent US source failed: ${errors.slice(-3).join("; ")}`);
}

async function loadUsKlineFromNasdaq({ normalized, period, boundedLimit }) {
  const now = new Date();
  const from = formatDate(addYears(now, -8));
  const to = formatDate(now);
  const apiUrl =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(normalized)}/historical?` +
    `assetclass=stocks&fromdate=${from}&todate=${to}&limit=9999`;

  const upstream = await fetch(apiUrl, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: "https://www.nasdaq.com/",
    },
  });

  if (!upstream.ok) {
    throw new Error(`Nasdaq HTTP ${upstream.status}`);
  }

  const payload = await upstream.json();
  const rawRows = payload?.data?.tradesTable?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error("Nasdaq returned empty historical rows.");
  }

  const dailyRows = rawRows
    .map((item) => {
      const close = parseNasdaqNumber(item.close);
      const open = parseNasdaqNumber(item.open);
      const high = parseNasdaqNumber(item.high);
      const low = parseNasdaqNumber(item.low);
      const volume = parseNasdaqNumber(item.volume) || 0;
      if (![open, close, high, low].every(Number.isFinite)) return null;
      return {
        date: toIsoDate(item.date),
        open,
        close,
        high,
        low,
        volume,
        amount: close * volume,
        amplitude: 0,
        pct: 0,
        change: 0,
        turnover: 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  let prevClose = null;
  for (const row of dailyRows) {
    row.change = Number.isFinite(prevClose) ? row.close - prevClose : 0;
    row.pct = Number.isFinite(prevClose) && prevClose !== 0 ? (row.change / prevClose) * 100 : 0;
    row.amplitude = row.low !== 0 ? ((row.high - row.low) / row.low) * 100 : 0;
    prevClose = row.close;
  }

  let sourceInfo = `Nasdaq proxy, rows=${dailyRows.length}`;
  try {
    const intradayRow = await loadUsQuoteSnapshot(normalized);
    const latestHistorical = dailyRows[dailyRows.length - 1] || null;
    if (intradayRow && (!latestHistorical || intradayRow.date > latestHistorical.date)) {
      dailyRows.push(intradayRow);
      sourceInfo += ", intraday-merged";
    } else if (intradayRow && latestHistorical && intradayRow.date === latestHistorical.date) {
      dailyRows[dailyRows.length - 1] = intradayRow;
      sourceInfo += ", intraday-replaced";
    }
  } catch {
    // Keep the historical series usable even when the quote snapshot is unavailable.
  }

  const rows = aggregateRows(dailyRows, period).slice(-boundedLimit);
  return {
    code: normalized,
    name: normalized,
    sourceInfo: sourceInfo.replace(/rows=\d+/, `rows=${rows.length}`),
    klines: rows,
  };
}

// Tencent's qt.gtimg.cn quote line uses the SAME field layout for US stocks as A-shares:
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

  const turnoverRate = Number(fields[38]);
  const peRatio = Number(fields[39]);
  const floatCapYi = Number(fields[44]);
  const totalCapYi = Number(fields[45]);
  return {
    marketCap: Number.isFinite(totalCapYi) ? totalCapYi * 1e8 : null,
    floatMarketCap: Number.isFinite(floatCapYi) ? floatCapYi * 1e8 : null,
    peRatio: Number.isFinite(peRatio) ? peRatio : null,
    turnoverRate: Number.isFinite(turnoverRate) ? turnoverRate : null,
  };
}

async function loadUsKline({ symbol, period = "101", limit = 600, adjust = "1" }) {
  const normalized = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);

  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(normalized)) {
    throw new Error("Invalid US stock symbol.");
  }

  const boundedLimit = Math.min(Math.max(Number(limit) || 600, 30), 2000);

  // Prefer Tencent (reliable from CN servers); fall back to Nasdaq if it is empty/unreachable.
  const klinePromise = (async () => {
    try {
      return await loadUsKlineFromTencent({ normalized, period, adjust, boundedLimit });
    } catch (tencentError) {
      try {
        return await loadUsKlineFromNasdaq({ normalized, period, boundedLimit });
      } catch (nasdaqError) {
        throw new Error(
          `US kline unavailable. tencent: ${tencentError?.message || tencentError}; ` +
            `nasdaq: ${nasdaqError?.message || nasdaqError}`,
          { cause: nasdaqError },
        );
      }
    }
  })();

  // Market-cap/PE/turnover are best-effort: never let a quote miss break the kline response.
  const [base, meta] = await Promise.all([
    klinePromise,
    loadUsQuoteMeta(normalized).catch(() => null),
  ]);

  return {
    ...base,
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
