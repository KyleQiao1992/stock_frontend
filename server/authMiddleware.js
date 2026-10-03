import jwt from 'jsonwebtoken';
import { loadServerEnv } from './env.js';
import { getRedisClient } from './redisClient.js';
import { readUser, publicUser, tokenVersion } from './userStore.js';

loadServerEnv();
export function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error('JWT_SECRET is not configured.');
  return secret;
}
export function sendAuthError(res, status, code, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, code, error }));
}
export function createAuthMiddleware({ getRedis = getRedisClient, getSecret = getJwtSecret } = {}) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return sendAuthError(res, 401, 'UNAUTHENTICATED', '未登录，请先登录。');
    let secret;
    try { secret = getSecret(); }
    catch { return sendAuthError(res, 503, 'AUTH_UNAVAILABLE', '账号服务配置不可用，请稍后重试。'); }
    let claims;
    try {
      claims = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
      if (!Number.isSafeInteger(claims.id) || claims.id < 1 || typeof claims.username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(claims.username)
        || !Number.isSafeInteger(claims.tokenVersion) || claims.tokenVersion < 0 || !Number.isFinite(claims.exp)) throw new Error('Invalid identity');
    } catch {
      return sendAuthError(res, 401, 'SESSION_EXPIRED', '登录已失效，请重新登录。');
    }
    let user;
    try { user = await readUser(await getRedis(), claims.username); }
    catch { return sendAuthError(res, 503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。'); }
    if (!user || user.id !== claims.id || tokenVersion(user) !== claims.tokenVersion) {
      return sendAuthError(res, 401, 'SESSION_REVOKED', '登录已失效，请重新登录。');
    }
    if ((user.status || 'active') !== 'active') return sendAuthError(res, 401, 'ACCOUNT_DISABLED', '账号已被禁用。');
    req.user = { ...publicUser(user), tokenVersion: tokenVersion(user) };
    next();
  };
}
export const authMiddleware = createAuthMiddleware();
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return sendAuthError(res, 403, 'FORBIDDEN', '没有操作权限，仅管理员可访问。');
  next();
}
