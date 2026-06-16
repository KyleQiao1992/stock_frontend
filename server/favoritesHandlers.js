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

const DEFAULT_GROUP = "默认";

// 收藏夹名规范化：去空白、截断到 30 字符；空 → 默认夹。
function normalizeGroupName(value) {
  const name = String(value ?? "").trim().slice(0, 30);
  return name || DEFAULT_GROUP;
}

function getFavoritesKey(userId, market) {
  return `favorites:${userId}:${market}`;
}

function getGroupsKey(userId, market) {
  return `favorite-groups:${userId}:${market}`;
}

// 读取自定义收藏夹名（有序、去重、剔除默认夹）。
async function readCustomGroups(client, key) {
  const entries = await client.lRange(key, 0, -1);
  const groups = [];
  const seen = new Set([DEFAULT_GROUP]);
  for (const raw of entries) {
    const name = normalizeGroupName(raw);
    if (seen.has(name)) continue;
    seen.add(name);
    groups.push(name);
  }
  return groups;
}

async function writeCustomGroups(client, key, groups) {
  const multi = client.multi();
  multi.del(key);
  if (groups.length) {
    multi.rPush(key, groups);
  }
  await multi.exec();
}

// 默认夹永远排第一，后面跟自定义夹（同时把 items 里出现过的夹补全进来）。
function buildGroupList(customGroups, items) {
  const ordered = [DEFAULT_GROUP, ...customGroups];
  const seen = new Set(ordered);
  for (const item of items) {
    const name = item.group || DEFAULT_GROUP;
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
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
      group: normalizeGroupName(parsed.group),
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

// Read a user's favorites (with legacy migration + A-share name enrichment).
// Exported so other handlers (e.g. favorites backtest) can reuse the same source.
export async function getFavoriteItems(rawUserId, rawMarket) {
  const userId = normalizeUserId(rawUserId);
  const market = normalizeMarket(rawMarket);
  const client = await getRedisClient();
  const key = getFavoritesKey(userId, market);
  await migrateLegacyFavorites(client, userId, market);
  const rawItems = await readFavoriteItems(client, key, market);
  return market === "ashare" ? await enrichAShareNames(rawItems) : rawItems;
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
        const items = await getFavoriteItems(userId, market);
        const customGroups = await readCustomGroups(client, getGroupsKey(userId, market));
        const groups = buildGroupList(customGroups, items);
        return sendJson(res, 200, { ok: true, userId, market, items, groups });
      }

      if (method === "POST") {
        const body = await readRequestBody(req);
        const market = normalizeMarket(body.market || "ashare");
        const code = normalizeFavoriteCode(body.code, market);
        const group = normalizeGroupName(body.group);
        const key = getFavoritesKey(userId, market);
        await migrateLegacyFavorites(client, userId, market);
        const items = await readFavoriteItems(client, key, market);

        if (!items.some((item) => item.code === code)) {
          const enriched = market === "ashare"
            ? await enrichAShareNames([{ code, name: normalizeFavoriteName(body.name, code) }])
            : [{ code, name: normalizeFavoriteName(body.name, code) }];
          items.push({ code, name: enriched[0].name, market, group, createdAt: Date.now() });
          await writeFavoriteItems(client, key, items);
        }

        // 收藏到一个尚不存在的自定义夹时，顺手登记该夹。
        if (group !== DEFAULT_GROUP) {
          const groupsKey = getGroupsKey(userId, market);
          const customGroups = await readCustomGroups(client, groupsKey);
          if (!customGroups.includes(group)) {
            await writeCustomGroups(client, groupsKey, [...customGroups, group]);
          }
        }

        return sendJson(res, 200, { ok: true, userId, market, items });
      }

      // 把某只票移动到另一个收藏夹（单归属）。
      if (method === "PATCH") {
        const body = await readRequestBody(req);
        const market = normalizeMarket(body.market || "ashare");
        const code = normalizeFavoriteCode(body.code, market);
        const group = normalizeGroupName(body.group);
        const key = getFavoritesKey(userId, market);
        await migrateLegacyFavorites(client, userId, market);
        const items = await readFavoriteItems(client, key, market);
        const target = items.find((item) => item.code === code);

        if (target && target.group !== group) {
          target.group = group;
          await writeFavoriteItems(client, key, items);

          if (group !== DEFAULT_GROUP) {
            const groupsKey = getGroupsKey(userId, market);
            const customGroups = await readCustomGroups(client, groupsKey);
            if (!customGroups.includes(group)) {
              await writeCustomGroups(client, groupsKey, [...customGroups, group]);
            }
          }
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

// 收藏夹（分组）管理：建夹 / 删夹（连票一起删）。默认夹隐式存在、不可建/删。
export function createFavoriteGroupsHandler() {
  return async function favoriteGroupsHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const method = String(req.method || "GET").toUpperCase();
      const userId = normalizeUserId(req.user?.id);
      const client = await getRedisClient();

      if (method === "POST") {
        const body = await readRequestBody(req);
        const market = normalizeMarket(body.market || "ashare");
        const name = normalizeGroupName(body.name);
        if (name === DEFAULT_GROUP) {
          return sendJson(res, 400, { ok: false, error: "该收藏夹名不可用。" });
        }
        const groupsKey = getGroupsKey(userId, market);
        const customGroups = await readCustomGroups(client, groupsKey);
        if (!customGroups.includes(name)) {
          await writeCustomGroups(client, groupsKey, [...customGroups, name]);
        }
        const items = await getFavoriteItems(userId, market);
        const groups = buildGroupList(await readCustomGroups(client, groupsKey), items);
        return sendJson(res, 200, { ok: true, userId, market, groups });
      }

      // 删除收藏夹 + 其下所有票（默认夹不可删）。
      if (method === "DELETE") {
        const market = normalizeMarket(requestUrl.searchParams.get("market") || "ashare");
        const name = normalizeGroupName(requestUrl.searchParams.get("name"));
        if (name === DEFAULT_GROUP) {
          return sendJson(res, 400, { ok: false, error: "默认收藏夹不可删除。" });
        }
        await migrateLegacyFavorites(client, userId, market);
        const favoritesKey = getFavoritesKey(userId, market);
        const items = await readFavoriteItems(client, favoritesKey, market);
        const nextItems = items.filter((item) => (item.group || DEFAULT_GROUP) !== name);
        if (nextItems.length !== items.length) {
          await writeFavoriteItems(client, favoritesKey, nextItems);
        }
        const groupsKey = getGroupsKey(userId, market);
        const customGroups = await readCustomGroups(client, groupsKey);
        await writeCustomGroups(client, groupsKey, customGroups.filter((g) => g !== name));

        const enriched = market === "ashare" ? await enrichAShareNames(nextItems) : nextItems;
        const groups = buildGroupList(customGroups.filter((g) => g !== name), enriched);
        return sendJson(res, 200, { ok: true, userId, market, items: enriched, groups });
      }

      return sendJson(res, 405, { ok: false, error: "Method not allowed." });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error?.message || String(error) });
    }
  };
}
