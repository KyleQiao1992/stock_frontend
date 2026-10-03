import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { getRedisClient } from "./redisClient.js";
import { loadServerEnv } from "./env.js";

loadServerEnv();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("JWT_SECRET is not configured.");
  return secret;
}

function getUserKey(username) {
  return `user:${username}`;
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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    throw new Error("用户名只能包含字母、数字、下划线，长度3-20位。");
  }
  return username;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 6) throw new Error("密码至少6位。");
  return password;
}

const PASSWORD_HASH_ROUNDS = 12;

export function isPasswordHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ""));
}

export async function hashPassword(password) {
  return bcrypt.hash(normalizePassword(password), PASSWORD_HASH_ROUNDS);
}

export async function verifyStoredPassword(user, password) {
  const candidate = normalizePassword(password);
  if (isPasswordHash(user?.passwordHash)) {
    return bcrypt.compare(candidate, user.passwordHash);
  }
  // 兼容旧账户；仅在所有共享存储的服务升级后显式启用迁移。
  return typeof user?.password === "string" && user.password === candidate;
}

// 共享 Redis 的所有服务都支持 passwordHash 后，才允许移除旧密码字段。
// 默认关闭，避免本地登录破坏仍运行旧版登录代码的线上账户。
export function createAuthHandler({
  getRedis = getRedisClient,
  getSecret = getJwtSecret,
  migratePasswords = process.env.AUTH_PASSWORD_MIGRATION === "1",
} = {}) {
  return async function authHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const action = requestUrl.pathname.replace(/^\/(api\/auth\/)?/, "");
      const method = String(req.method || "").toUpperCase();

      if (action === "register" && method === "POST") {
        const body = await readRequestBody(req);
        const username = normalizeUsername(body.username);
        const password = normalizePassword(body.password);

        const redis = await getRedis();
        const exists = await redis.exists(getUserKey(username));
        if (exists) {
          return sendJson(res, 409, { ok: false, error: "用户名已存在。" });
        }

        const id = await redis.incr("user:id_counter");
        const passwordHash = await hashPassword(password);
        await redis.set(getUserKey(username), JSON.stringify({ id, username, passwordHash, createdAt: Date.now() }));

        const token = jwt.sign({ id, username }, getSecret());
        return sendJson(res, 200, { ok: true, token, id, username });
      }

      if (action === "login" && method === "POST") {
        const body = await readRequestBody(req);
        const username = normalizeUsername(body.username);
        const password = normalizePassword(body.password);

        const redis = await getRedis();
        const raw = await redis.get(getUserKey(username));
        if (!raw) {
          return sendJson(res, 401, { ok: false, error: "用户名或密码错误。" });
        }

        const user = JSON.parse(raw);
        if (!(await verifyStoredPassword(user, password))) {
          return sendJson(res, 401, { ok: false, error: "用户名或密码错误。" });
        }

        const token = jwt.sign({ id: user.id, username }, getSecret());

        if (migratePasswords && !isPasswordHash(user.passwordHash)) {
          try {
            const migrated = { ...user, passwordHash: await hashPassword(password) };
            delete migrated.password;
            // 仅替换仍与读取时一致的记录，保留 TTL，避免覆盖并发账户更新。
            await redis.eval(
              'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL") end return nil',
              { keys: [getUserKey(username)], arguments: [raw, JSON.stringify(migrated)] },
            );
          } catch {
            // 密码已验证，迁移失败不应阻断现有账户登录；下次登录会再次尝试。
          }
        }

        return sendJson(res, 200, { ok: true, token, id: user.id, username });
      }

      return sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  };
}
