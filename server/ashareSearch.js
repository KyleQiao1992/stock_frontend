import { initAshareCodeIndex, searchLocal } from "./ashareCodeIndex.js";

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

// 东方财富 suggest 接口响应较慢（常见 0.8~2.8s）且偶发抖动，这里加超时 + 重试 +
// 短期缓存，避免前端连续输入时频繁打空、超时。
const UPSTREAM_TIMEOUT_MS = 3500;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map(); // keyword -> { expires, items }

function getCached(keyword) {
  const hit = cache.get(keyword);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(keyword);
    return null;
  }
  // 触发 LRU：命中后移到末尾
  cache.delete(keyword);
  cache.set(keyword, hit);
  return hit.items;
}

function setCached(keyword, items) {
  cache.set(keyword, { expires: Date.now() + CACHE_TTL_MS, items });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function fetchSuggestOnce(input) {
  const params = new URLSearchParams({
    input,
    type: "14",
    count: "10",
    classify: "AStock",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`https://searchapi.eastmoney.com/api/suggest/get?${params}`, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Referer: "https://www.eastmoney.com/",
      },
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

async function searchAshare(keyword) {
  const input = normalizeKeyword(keyword);
  if (!input) return [];

  const cached = getCached(input);
  if (cached) return cached;

  // 本地拼音索引优先：支持完整拼音（taitan）、首字母（ttgf）、中文、代码子串。
  // 东方财富 suggest 只认首字母，完整拼音会返回空，所以本地命中就直接用。
  const local = searchLocal(input);
  if (local.length) {
    setCached(input, local);
    return local;
  }

  let lastError = null;
  // 首次失败（超时/抖动）再重试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const items = await fetchSuggestOnce(input);
      setCached(input, items);
      return items;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Eastmoney search failed");
}

export function createAshareSearchHandler() {
  // 启动时加载静态快照并触发后台刷新（幂等）。
  initAshareCodeIndex();
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
