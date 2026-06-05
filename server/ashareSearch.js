function normalizeKeyword(value) {
  return String(value || "").trim().slice(0, 30);
}

function toSearchItem(entry) {
  const code = String(entry?.Code || entry?.UnifiedCode || "").trim();
  const name = String(entry?.Name || "").trim();
  const quoteId = String(entry?.QuoteID || "").trim();
  const market = String(entry?.SecurityTypeName || "").trim();
  const pinyin = String(entry?.PinYin || "").trim();
  const classify = String(entry?.Classify || "").trim();

  if (!/^\d{6}$/.test(code)) return null;
  if (classify && classify !== "AStock") return null;

  return {
    code,
    name: name || code,
    quoteId,
    market,
    pinyin,
  };
}

async function searchAshare(keyword) {
  const input = normalizeKeyword(keyword);
  if (!input) return [];

  const params = new URLSearchParams({
    input,
    type: "14",
    count: "10",
    classify: "AStock",
  });
  const upstream = await fetch(`https://searchapi.eastmoney.com/api/suggest/get?${params}`, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Referer: "https://www.eastmoney.com/",
    },
  });

  if (!upstream.ok) {
    throw new Error(`Eastmoney search HTTP ${upstream.status}`);
  }

  const payload = await upstream.json();
  const rows = Array.isArray(payload?.QuotationCodeTable?.Data) ? payload.QuotationCodeTable.Data : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const item = toSearchItem(row);
    if (!item || seen.has(item.code)) continue;
    seen.add(item.code);
    items.push(item);
  }
  return items;
}

export function createAshareSearchHandler() {
  return async function ashareSearchHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const keyword = requestUrl.searchParams.get("q") || "";
      const items = await searchAshare(keyword);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ items }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || String(error), items: [] }));
    }
  };
}
