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

async function loadUsKline({ symbol, period = "101", limit = 600 }) {
  const normalized = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);

  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(normalized)) {
    throw new Error("Invalid US stock symbol.");
  }

  const boundedLimit = Math.min(Math.max(Number(limit) || 600, 30), 2000);
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

  const rows = aggregateRows(dailyRows, period).slice(-boundedLimit);
  return {
    code: normalized,
    name: normalized,
    sourceInfo: `Nasdaq proxy, rows=${rows.length}`,
    klines: rows,
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

