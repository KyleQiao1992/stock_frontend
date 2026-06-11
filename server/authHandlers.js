import jwt from "jsonwebtoken";
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

export function createAuthHandler() {
  return async function authHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const action = requestUrl.pathname.replace(/^\/(api\/auth\/)?/, "");
      const method = String(req.method || "").toUpperCase();

      if (action === "register" && method === "POST") {
        const body = await readRequestBody(req);
        const username = normalizeUsername(body.username);
        const password = normalizePassword(body.password);

        const redis = await getRedisClient();
        const exists = await redis.exists(getUserKey(username));
        if (exists) {
          return sendJson(res, 409, { ok: false, error: "用户名已存在。" });
        }

        const id = await redis.incr("user:id_counter");
        await redis.set(getUserKey(username), JSON.stringify({ id, username, password, createdAt: Date.now() }));

        const token = jwt.sign({ id, username }, getJwtSecret());
        return sendJson(res, 200, { ok: true, token, id, username });
      }

      if (action === "login" && method === "POST") {
        const body = await readRequestBody(req);
        const username = normalizeUsername(body.username);
        const password = normalizePassword(body.password);

        const redis = await getRedisClient();
        const raw = await redis.get(getUserKey(username));
        if (!raw) {
          return sendJson(res, 401, { ok: false, error: "用户名或密码错误。" });
        }

        const user = JSON.parse(raw);
        if (user.password !== password) {
          return sendJson(res, 401, { ok: false, error: "用户名或密码错误。" });
        }

        const token = jwt.sign({ id: user.id, username }, getJwtSecret());
        return sendJson(res, 200, { ok: true, token, id: user.id, username });
      }

      return sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message || String(error) });
    }
  };
}
