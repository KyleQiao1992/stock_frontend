import jwt from "jsonwebtoken";
import { loadServerEnv } from "./env.js";

loadServerEnv();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("JWT_SECRET is not configured.");
  return secret;
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "未登录，请先登录。" }));
    return;
  }

  try {
    req.user = jwt.verify(token, getJwtSecret());
    next();
  } catch {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "登录已过期，请重新登录。" }));
  }
}
