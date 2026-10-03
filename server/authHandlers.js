import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { getRedisClient } from "./redisClient.js";
import { loadServerEnv } from "./env.js";
import { publicUser, tokenVersion, updateUser } from "./userStore.js";
import { createAuthMiddleware } from "./authMiddleware.js";

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
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    return body;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    throw Object.assign(new Error("用户名只能包含字母、数字、下划线，长度3-20位。"), { status: 400 });
  }
  return username;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 6) throw Object.assign(new Error("密码至少6位。"), { status: 400 });
  return password;
}

const PASSWORD_HASH_ROUNDS = 12;

export function isPasswordHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ""));
}

export async function hashPassword(password) {
  const normalized = normalizePassword(password);
  if (Buffer.byteLength(normalized, 'utf8') > 72) {
    throw Object.assign(new Error('新密码不能超过72个UTF-8字节（英文字符最多72位，中文通常每字3字节）。'), { status: 400 });
  }
  return bcrypt.hash(normalized, PASSWORD_HASH_ROUNDS);
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
  const authenticate = createAuthMiddleware({ getRedis, getSecret });
  return async function authHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const action = requestUrl.pathname.replace(/^\/(api\/auth\/)?/, "");
      const method = String(req.method || "").toUpperCase();

      if (action === "me" && method === "GET" || action === "change-password" && method === "POST") {
        await authenticate(req, res, () => {});
        if (!req.user) return;
        if (action === "me") return sendJson(res, 200, { ok: true, user: publicUser(req.user) });
        const body = await readRequestBody(req);
        const passwordHash = await hashPassword(body.newPassword);
        const redis = await getRedis();
        await updateUser(redis, req.user.username, async (user) => {
          if (tokenVersion(user) !== req.user.tokenVersion || (user.status || 'active') !== 'active') {
            throw Object.assign(new Error('登录已失效，请重新登录。'), { status: 401 });
          }
          if (!(await verifyStoredPassword(user, body.currentPassword))) {
            throw Object.assign(new Error('原密码错误。'), { status: 400 });
          }
          const next = { ...user, passwordHash, tokenVersion: tokenVersion(user) + 1 };
          delete next.password;
          return next;
        });
        return sendJson(res, 200, { ok: true });
      }

      if (action === "register" && method === "POST") {
        const body = await readRequestBody(req);
        const username = normalizeUsername(body.username);
        const password = normalizePassword(body.password);

        const secret = getSecret();
        const redis = await getRedis();
        const exists = await redis.exists(getUserKey(username));
        if (exists) {
          return sendJson(res, 409, { ok: false, error: "用户名已存在。" });
        }

        const passwordHash = await hashPassword(password);
        const id = await redis.incr("user:id_counter");
        const user = { id, username, passwordHash, createdAt: Date.now(), role: 'user', status: 'active', tokenVersion: 1 };
        const created = await redis.set(getUserKey(username), JSON.stringify(user), { NX: true });
        if (!created) return sendJson(res, 409, { ok: false, error: "用户名已存在。" });
        const token = jwt.sign({ id, username, tokenVersion: 1 }, secret, { expiresIn: '7d', algorithm: 'HS256' });
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

        if ((user.status || 'active') !== 'active') {
          return sendJson(res, 401, { ok: false, code: 'ACCOUNT_DISABLED', error: '账号已被禁用。' });
        }
        const token = jwt.sign({ id: user.id, username, tokenVersion: tokenVersion(user) }, getSecret(), { expiresIn: '7d', algorithm: 'HS256' });

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
      return sendJson(res, error.status || 503, { ok: false, error: error.status ? error.message : "账号服务暂时不可用，请稍后重试。" });
    }
  };
}
