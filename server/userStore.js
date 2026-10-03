import { getRedisClient } from './redisClient.js';

export const userKey = (username) => `user:${username}`;
export function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt,
    role: user.role || 'user', status: user.status || 'active', updatedAt: user.updatedAt || null };
}
export const tokenVersion = (user) => user.tokenVersion ?? 0;
export async function readUser(redis, username) {
  const raw = await redis.get(userKey(username));
  return raw ? JSON.parse(raw) : null;
}
export async function listUsers(redis) {
  const users = [];
  for await (const batch of redis.scanIterator({ MATCH: 'user:*', COUNT: 100 })) {
    for (const key of Array.isArray(batch) ? batch : [batch]) {
      if (key === 'user:id_counter') continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (user.username && user.id) users.push(user);
    }
  }
  return users.sort((a, b) => a.id - b.id);
}

// CAS preserves password migrations and concurrent edits. The administrator
// guard runs inside the same Redis operation as the write. Only demotions or
// disabling an active administrator scan accounts (the initial small-account model).
const UPDATE_USER = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
if raw ~= ARGV[1] then return 'conflict' end
local old = cjson.decode(raw)
local new = cjson.decode(ARGV[2])
if old.role == 'admin' and (old.status == nil or old.status == 'active')
  and (new.role ~= 'admin' or new.status ~= 'active') then
  local count = 0
  for _, key in ipairs(redis.call('KEYS', 'user:*')) do
    if key ~= 'user:id_counter' then
      local ok, u = pcall(cjson.decode, redis.call('GET', key))
      if ok and u.role == 'admin' and (u.status == nil or u.status == 'active') then count = count + 1 end
    end
  end
  if count <= 1 then return 'last_admin' end
end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 'ok'
`;
export async function updateUser(redis, username, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await redis.get(userKey(username));
    if (!raw) throw Object.assign(new Error('账号不存在。'), { status: 404 });
    const user = JSON.parse(raw);
    const next = await mutate(user);
    next.updatedAt = Date.now();
    const result = await redis.eval(UPDATE_USER, { keys: [userKey(username)], arguments: [raw, JSON.stringify(next)] });
    if (result === 'ok') return next;
    if (result === 'last_admin') throw Object.assign(new Error('不能禁用或降权最后一个可用管理员。'), { status: 409 });
    if (result === 'missing') throw Object.assign(new Error('账号不存在。'), { status: 404 });
  }
  throw Object.assign(new Error('账号正在被修改，请重试。'), { status: 409 });
}
export async function initializeAdmin(username, getRedis = getRedisClient) {
  if (!/^[a-z0-9_]{3,20}$/.test(username || '')) throw new Error('请指定现有账号的用户名。');
  const redis = await getRedis();
  return updateUser(redis, username, (user) => ({ ...user, role: 'admin', status: 'active', tokenVersion: tokenVersion(user) }));
}
