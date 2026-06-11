import { getRedisClient } from "./redisClient.js";
import { getMysqlPool } from "./mysqlClient.js";

async function enrichAShareNames(items) {
  const nameless = items.filter((item) => item.name === item.code);
  if (!nameless.length) return items;
  try {
    const codes = nameless.map((item) => item.code);
    const pool = getMysqlPool();
    const placeholders = codes.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT stock_code, stock_name FROM stock_basic WHERE stock_code IN (${placeholders})`,
      codes,
    );
    const nameMap = {};
    for (const row of rows) nameMap[row.stock_code] = row.stock_name;
    return items.map((item) => ({ ...item, name: nameMap[item.code] || item.name }));
  } catch {
    return items;
  }
}

function normalizeMarket(value) {
  const market = String(value || "").trim().toLowerCase();
  if (market === "ashare" || market === "us") return market;
  throw new Error("Unsupported market. Expected ashare or us.");
}

function normalizeUserId(value) {
  const digits = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(digits)) {
    throw new Error("Invalid authenticated user id.");
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

function getLegacyMigrationKey(userId, market) {
  return `favorites:migrated:${userId}:${market}`;
}

function getLegacyFavoritesOwnerId() {
  return normalizeUserId(process.env.FAVORITES_LEGACY_OWNER_USER_ID || "1");
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

async function migrateLegacyFavorites(client, userId, market) {
  if (userId !== getLegacyFavoritesOwnerId()) return;

  const migrationKey = getLegacyMigrationKey(userId, market);
  if (await client.exists(migrationKey)) return;

  const key = getFavoritesKey(userId, market);
  const legacyKey = getFavoritesKey("0", market);
  const [items, legacyItems] = await Promise.all([
    readFavoriteItems(client, key, market),
    readFavoriteItems(client, legacyKey, market),
  ]);
  const mergedItems = [...items];
  const seen = new Set(items.map((item) => item.code));

  for (const item of legacyItems) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    mergedItems.push(item);
  }

  if (mergedItems.length !== items.length) {
    await writeFavoriteItems(client, key, mergedItems);
  }
  await client.set(migrationKey, String(Date.now()));
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
      const userId = normalizeUserId(req.user?.id);
      const client = await getRedisClient();

      if (method === "GET") {
        const market = normalizeMarket(requestUrl.searchParams.get("market") || "ashare");
        const key = getFavoritesKey(userId, market);
        await migrateLegacyFavorites(client, userId, market);
        const rawItems = await readFavoriteItems(client, key, market);
        const items = market === "ashare" ? await enrichAShareNames(rawItems) : rawItems;
        return sendJson(res, 200, { ok: true, userId, market, items });
      }

      if (method === "POST") {
        const body = await readRequestBody(req);
        const market = normalizeMarket(body.market || "ashare");
        const code = normalizeFavoriteCode(body.code, market);
        const key = getFavoritesKey(userId, market);
        await migrateLegacyFavorites(client, userId, market);
        const items = await readFavoriteItems(client, key, market);

        if (!items.some((item) => item.code === code)) {
          const enriched = market === "ashare"
            ? await enrichAShareNames([{ code, name: normalizeFavoriteName(body.name, code) }])
            : [{ code, name: normalizeFavoriteName(body.name, code) }];
          items.push({ code, name: enriched[0].name, market, createdAt: Date.now() });
          await writeFavoriteItems(client, key, items);
        }

        return sendJson(res, 200, { ok: true, userId, market, items });
      }

      if (method === "DELETE") {
        const market = normalizeMarket(requestUrl.searchParams.get("market") || "ashare");
        const code = normalizeFavoriteCode(requestUrl.searchParams.get("code"), market);
        const key = getFavoritesKey(userId, market);
        await migrateLegacyFavorites(client, userId, market);
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
