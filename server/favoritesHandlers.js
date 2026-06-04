import { getRedisClient } from "./redisClient.js";

function normalizeMarket(value) {
  const market = String(value || "").trim().toLowerCase();
  if (market === "ashare" || market === "us") return market;
  throw new Error("Unsupported market. Expected ashare or us.");
}

function normalizeUserId(value) {
  const digits = String(value ?? "0").trim();
  if (!/^\d+$/.test(digits)) {
    throw new Error("Invalid userId. Expected a non-negative integer.");
  }
  return digits;
}

function normalizeFavoriteCode(value, market) {
  const raw = String(value || "").trim();
  if (market === "us") {
    const code = raw.toUpperCase().replace(/[^A-Z0-9.-]/g, "").slice(0, 12);
    if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(code)) {
      throw new Error("Invalid US stock code.");
    }
    return code;
  }

  const code = raw.replace(/\D/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(code)) {
    throw new Error("Invalid A-share stock code.");
  }
  return code;
}

function normalizeFavoriteName(value, fallbackCode) {
  const name = String(value || "").trim().slice(0, 80);
  return name || fallbackCode;
}

function getFavoritesKey(userId, market) {
  return `favorites:${userId}:${market}`;
}

function toFavoriteItem(entry, market) {
  if (!entry) return null;

  try {
    const parsed = JSON.parse(entry);
    if (!parsed || typeof parsed !== "object") return null;
    const code = normalizeFavoriteCode(parsed.code, market);
    return {
      code,
      name: normalizeFavoriteName(parsed.name, code),
      market,
      createdAt: Number.isFinite(Number(parsed.createdAt)) ? Number(parsed.createdAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

async function readFavoriteItems(client, key, market) {
  const entries = await client.lRange(key, 0, -1);
  const items = [];
  const seen = new Set();

  for (const entry of entries) {
    const item = toFavoriteItem(entry, market);
    if (!item || seen.has(item.code)) continue;
    seen.add(item.code);
    items.push(item);
  }

  return items;
}

async function writeFavoriteItems(client, key, items) {
  const multi = client.multi();
  multi.del(key);
  if (items.length) {
    multi.rPush(
      key,
      items.map((item) => JSON.stringify(item)),
    );
  }
  await multi.exec();
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function createFavoritesHandler() {
  return async function favoritesHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const method = String(req.method || "GET").toUpperCase();

      if (method === "GET") {
        const userId = normalizeUserId(requestUrl.searchParams.get("userId") || "0");
        const market = normalizeMarket(requestUrl.searchParams.get("market") || "ashare");
        const key = getFavoritesKey(userId, market);
        const client = await getRedisClient();
        const items = await readFavoriteItems(client, key, market);
        return sendJson(res, 200, { ok: true, userId, market, items });
      }

      if (method === "POST") {
        const body = await readRequestBody(req);
        const userId = normalizeUserId(body.userId ?? "0");
        const market = normalizeMarket(body.market || "ashare");
        const code = normalizeFavoriteCode(body.code, market);
        const key = getFavoritesKey(userId, market);
        const client = await getRedisClient();
        const items = await readFavoriteItems(client, key, market);

        if (!items.some((item) => item.code === code)) {
          items.push({
            code,
            name: normalizeFavoriteName(body.name, code),
            market,
            createdAt: Date.now(),
          });
          await writeFavoriteItems(client, key, items);
        }

        return sendJson(res, 200, { ok: true, userId, market, items });
      }

      if (method === "DELETE") {
        const userId = normalizeUserId(requestUrl.searchParams.get("userId") || "0");
        const market = normalizeMarket(requestUrl.searchParams.get("market") || "ashare");
        const code = normalizeFavoriteCode(requestUrl.searchParams.get("code"), market);
        const key = getFavoritesKey(userId, market);
        const client = await getRedisClient();
        const items = await readFavoriteItems(client, key, market);
        const nextItems = items.filter((item) => item.code !== code);

        if (nextItems.length !== items.length) {
          await writeFavoriteItems(client, key, nextItems);
        }

        return sendJson(res, 200, { ok: true, userId, market, items: nextItems });
      }

      return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
