import { getRedisClient } from "./redisClient.js";

function normalizeRecommendationFactor(value) {
  const factor = String(value || "").trim().toLowerCase();
  if (!/^factor[1-5]$/.test(factor)) {
    throw new Error("Invalid factor. Expected factor1 to factor5.");
  }
  return factor;
}

function normalizeRecommendationDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new Error("Invalid date. Expected YYYYMMDD.");
  }
  return digits;
}

function normalizeRecommendationMarketSuffix(value) {
  const market = String(value || "").trim().toLowerCase();
  if (market === "ashare") return "cn";
  if (market === "us") return "us";
  throw new Error("Unsupported market. Expected ashare or us.");
}

function assertAllowedRecommendationKey(key) {
  if (/^factor[1-5]_(cn|us)_\d{8}$/.test(key)) return;
  throw new Error("Invalid recommendation key. Expected factor1_cn_YYYYMMDD to factor5_cn_YYYYMMDD.");
}

export async function readRedisValue(client, key) {
  const type = await client.type(key);

  if (type === "none") {
    return { exists: false, type: "none", value: null, ttl: -2 };
  }

  const ttl = await client.ttl(key);

  if (type === "string") {
    return { exists: true, type, ttl, value: await client.get(key) };
  }

  if (type === "hash") {
    return { exists: true, type, ttl, value: await client.hGetAll(key) };
  }

  if (type === "list") {
    return { exists: true, type, ttl, value: await client.lRange(key, 0, -1) };
  }

  if (type === "set") {
    return { exists: true, type, ttl, value: await client.sMembers(key) };
  }

  if (type === "zset") {
    return {
      exists: true,
      type,
      ttl,
      value: await client.zRangeWithScores(key, 0, -1),
    };
  }

  return { exists: true, type, ttl, value: null };
}

function getRecommendationKey(requestUrl) {
  const market = requestUrl.searchParams.get("market")?.trim().toLowerCase() || "ashare";
  const factor = requestUrl.searchParams.get("factor");
  const date = requestUrl.searchParams.get("date");

  return [
    normalizeRecommendationFactor(factor),
    normalizeRecommendationMarketSuffix(market),
    normalizeRecommendationDate(date),
  ].join("_");
}

function normalizeRecommendationCode(value, market) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (market === "us") {
    return raw
      .toUpperCase()
      .replace(/[^A-Z0-9.-]/g, "")
      .slice(0, 12);
  }
  return raw.replace(/\D/g, "").slice(0, 6);
}

function toRecommendationItem(entry, market, index) {
  if (!entry) return null;

  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return toRecommendationItem(JSON.parse(trimmed), market, index);
      } catch {
        const code = normalizeRecommendationCode(trimmed, market);
        return code ? { code, name: code, note: "" } : null;
      }
    }

    const code = normalizeRecommendationCode(trimmed, market);
    return code ? { code, name: code, note: "" } : null;
  }

  if (typeof entry === "object" && !Array.isArray(entry)) {
    const code = normalizeRecommendationCode(
      entry.code || entry.symbol || entry.ticker || entry.stockCode || entry.secid,
      market,
    );
    if (!code) return null;
    return {
      code,
      name: String(entry.name || entry.stockName || entry.title || code).trim() || code,
      note: String(entry.note || entry.remark || entry.reason || "").trim(),
      score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
      rank: Number.isFinite(Number(entry.rank)) ? Number(entry.rank) : index + 1,
    };
  }

  return null;
}

function normalizeRecommendationItems(payload, market) {
  const sourceValue = payload?.value;

  if (Array.isArray(sourceValue)) {
    return sourceValue.map((item, index) => toRecommendationItem(item, market, index)).filter(Boolean);
  }

  if (sourceValue && typeof sourceValue === "object") {
    const nestedList = Array.isArray(sourceValue.items)
      ? sourceValue.items
      : Array.isArray(sourceValue.list)
        ? sourceValue.list
        : Array.isArray(sourceValue.recommendations)
          ? sourceValue.recommendations
          : null;

    if (nestedList) {
      return nestedList.map((item, index) => toRecommendationItem(item, market, index)).filter(Boolean);
    }

    return Object.entries(sourceValue)
      .map(([code, note], index) => toRecommendationItem({ code, note }, market, index))
      .filter(Boolean);
  }

  if (typeof sourceValue === "string") {
    const trimmed = sourceValue.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return normalizeRecommendationItems({ value: JSON.parse(trimmed) }, market);
      } catch {
        return trimmed
          .split(/[\s,，\n]+/)
          .map((item, index) => toRecommendationItem(item, market, index))
          .filter(Boolean);
      }
    }

    return trimmed
      .split(/[\s,，\n]+/)
      .map((item, index) => toRecommendationItem(item, market, index))
      .filter(Boolean);
  }

  return [];
}

export function createRedisRecommendationsHandler() {
  return async function redisRecommendationsHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const market = requestUrl.searchParams.get("market")?.trim().toLowerCase() || "ashare";
      const key = getRecommendationKey(requestUrl);

      assertAllowedRecommendationKey(key);

      const client = await getRedisClient();
      const payload = await readRedisValue(client, key);
      const items = normalizeRecommendationItems(payload, market);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: true,
        market,
        key,
        exists: payload.exists,
        type: payload.type,
        ttl: payload.ttl,
        items,
      }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
    }
  };
}
