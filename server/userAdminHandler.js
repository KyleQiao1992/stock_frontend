import { getRedisClient } from './redisClient.js';
import { publicUser, tokenVersion, listUsers, updateUser } from './userStore.js';
import { hashPassword } from './authHandlers.js';
import { requireAdmin, sendAuthError } from './authMiddleware.js';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求格式不正确。'), { status: 400 }); }
}
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export function createUserAdminHandler({ getRedis = getRedisClient } = {}) {
  return async (req, res) => {
    let allowed = false;
    requireAdmin(req, res, () => { allowed = true; });
    if (!allowed) return;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      let redis;
      try { redis = await getRedis(); }
      catch { return sendAuthError(res, 503, 'AUTH_UNAVAILABLE', '账号服务暂时不可用，请稍后重试。'); }
      if (req.method === 'GET' && !parts.length) {
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1);
        const pageSize = 20;
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const users = (await listUsers(redis)).filter((u) => u.username.includes(query));
        return send(res, 200, { ok: true, data: users.slice((page - 1) * pageSize, page * pageSize).map(publicUser), total: users.length, page, pageSize });
      }
      const [username, action] = parts;
      if (!/^[a-z0-9_]{3,20}$/.test(username || '') || parts.length > 2) return send(res, 404, { ok: false, error: 'Not found.' });
      if (req.method === 'PATCH' && !action) {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => !['role', 'status'].includes(key)) || !Object.keys(body).length
          || body.role !== undefined && !['user', 'admin'].includes(body.role)
          || body.status !== undefined && !['active', 'disabled'].includes(body.status)) {
          return send(res, 400, { ok: false, error: '角色或状态参数不正确。' });
        }
        if (username === req.user.username && (body.role === 'user' || body.status === 'disabled')) {
          return send(res, 409, { ok: false, error: '不能禁用自己或给自己降权。' });
        }
        const updated = await updateUser(redis, username, (user) => {
          const next = { ...user, ...publicUser(user), ...body };
          // Disabling revokes previous sessions even if the account is re-enabled.
          if (body.status === 'disabled' && (user.status || 'active') === 'active') next.tokenVersion = tokenVersion(user) + 1;
          return next;
        });
        return send(res, 200, { ok: true, user: publicUser(updated) });
      }
      if (req.method === 'POST' && ['reset-password', 'revoke-sessions'].includes(action)) {
        const body = await readBody(req);
        if (action === 'reset-password' && (typeof body?.newPassword !== 'string' || body.newPassword.length < 6)) return send(res, 400, { ok: false, error: '密码至少6位。' });
        const passwordHash = action === 'reset-password' ? await hashPassword(body.newPassword) : null;
        await updateUser(redis, username, (user) => {
          const next = { ...user, tokenVersion: tokenVersion(user) + 1 };
          if (passwordHash) { next.passwordHash = passwordHash; delete next.password; }
          return next;
        });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      return send(res, error.status || 503, { ok: false, error: error.status ? error.message : '账号操作失败，请稍后重试。' });
    }
  };
}
