import test from 'node:test';
import express from 'express';
import { registerApiPermissions } from './apiPermissions.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getRedisClient } from './redisClient.js';
import { createAuthMiddleware, requireAdmin } from './authMiddleware.js';
import { createAuthHandler, verifyStoredPassword } from './authHandlers.js';
import { createUserAdminHandler } from './userAdminHandler.js';
import { updateUser, publicUser } from './userStore.js';

const SECRET = 'permission-tests-only';
const baseUser = { id: 7, username: 'member', password: 'fixture_password', createdAt: 123 };
function memoryStore(users = [baseUser]) {
  const values = new Map(users.map((u) => [`user:${u.username}`, JSON.stringify(u)]));
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async exists(key) { return values.has(key) ? 1 : 0; },
    async incr(key) { const value = Number(values.get(key) || 100) + 1; values.set(key, String(value)); return value; },
    async set(key, value, options = {}) { if (options.NX && values.has(key)) return null; values.set(key, value); return 'OK'; },
    async *scanIterator() { yield [...values.keys()].filter((k) => k.startsWith('user:')); },
    async eval(script, { keys, arguments: args }) {
      const raw = values.get(keys[0]);
      if (!raw) return 'missing';
      if (raw !== args[0]) return script.includes('last_admin') ? 'conflict' : null;
      const old = JSON.parse(raw), next = JSON.parse(args[1]);
      if (script.includes('last_admin') && old.role === 'admin' && (old.status || 'active') === 'active'
        && (next.role !== 'admin' || next.status !== 'active')) {
        const active = [...values].filter(([k]) => k !== 'user:id_counter').map(([, v]) => JSON.parse(v)).filter((u) => u.role === 'admin' && (u.status || 'active') === 'active');
        if (active.length <= 1) return 'last_admin';
      }
      values.set(keys[0], args[1]); return script.includes('last_admin') ? 'ok' : 'OK';
    },
  };
}
function response() { return { statusCode: 200, setHeader() {}, end(value) { this.body = JSON.parse(value); } }; }
function signed(user = baseUser, extra = {}) {
  return jwt.sign({ id: user.id, username: user.username, tokenVersion: user.tokenVersion ?? 0, ...extra }, SECRET, { expiresIn: '7d' });
}
async function authenticate(store, token = signed()) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = response(); let passed = false;
  await createAuthMiddleware({ getRedis: async () => store, getSecret: () => SECRET })(req, res, () => { passed = true; });
  return { req, res, passed };
}
async function authRequest(store, path, method, body = {}, token) {
  const req = Readable.from([JSON.stringify(body)]);
  Object.assign(req, { url: `/${path}`, method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const res = response();
  await createAuthHandler({ getRedis: async () => store, getSecret: () => SECRET })(req, res);
  return res;
}
async function adminRequest(store, path, method, body = {}, actor = { ...baseUser, role: 'admin' }) {
  const req = Readable.from([JSON.stringify(body)]);
  Object.assign(req, { url: path, method, user: actor });
  const res = response();
  await createUserAdminHandler({ getRedis: async () => store })(req, res);
  return res;
}

test('legacy account defaults to ordinary user; latest Redis role controls access', async () => {
  const store = memoryStore();
  let result = await authenticate(store);
  assert.equal(result.passed, true); assert.equal(result.req.user.role, 'user');
  requireAdmin(result.req, result.res, () => assert.fail('ordinary user must not pass'));
  assert.equal(result.res.statusCode, 403);
  store.values.set('user:member', JSON.stringify({ ...baseUser, role: 'admin' }));
  result = await authenticate(store); assert.equal(result.req.user.role, 'admin');
  let adminPassed = false; requireAdmin(result.req, result.res, () => { adminPassed = true; }); assert.equal(adminPassed, true);
  store.values.set('user:member', JSON.stringify(baseUser));
  assert.equal((await authenticate(store)).req.user.role, 'user');
});
test('missing, old, expired, tampered and mismatched identities are rejected', async () => {
  const store = memoryStore();
  for (const token of [null, jwt.sign({ id: 7, username: 'member' }, SECRET), signed(baseUser, { id: 8 }), signed(baseUser, { tokenVersion: 9 }), signed().slice(0, -5) + 'xxxxx']) {
    assert.equal((await authenticate(store, token)).res.statusCode, 401);
  }
  const expired = jwt.sign({ id: 7, username: 'member', tokenVersion: 0, exp: 1 }, SECRET);
  assert.equal((await authenticate(store, expired)).res.statusCode, 401);
});
test('disabled and deleted accounts reject valid tokens; storage outage returns 503', async () => {
  const store = memoryStore([{ ...baseUser, status: 'disabled' }]);
  assert.equal((await authenticate(store)).res.body.code, 'ACCOUNT_DISABLED');
  store.values.clear(); assert.equal((await authenticate(store)).res.statusCode, 401);
  assert.equal((await authenticate({ get() { throw new Error('private connection details'); } })).res.statusCode, 503);
});
test('registration cannot choose role; concurrent same-name requests cannot overwrite', async () => {
  const store = memoryStore([]);
  const results = await Promise.all([1, 2].map(() => authRequest(store, 'register', 'POST', { username: 'new_user', password: 'fixture_password', role: 'admin' })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const user = JSON.parse(store.values.get('user:new_user'));
  assert.equal(user.role, 'user'); assert.equal(user.status, 'active');
  const token = results.find((r) => r.statusCode === 200).body.token;
  const claims = jwt.verify(token, SECRET);
  assert.equal(claims.exp - claims.iat, 7 * 86400);
  assert.equal((await authenticate(store, token)).passed, true);
});
test('me exposes public fields only and disabled accounts cannot login', async () => {
  const store = memoryStore();
  const me = await authRequest(store, 'me', 'GET', {}, signed());
  assert.deepEqual(me.body.user, publicUser(baseUser));
  assert.equal(me.body.user.password, undefined); assert.equal(me.body.user.passwordHash, undefined);
  store.values.set('user:member', JSON.stringify({ ...baseUser, status: 'disabled' }));
  assert.equal((await authRequest(store, 'login', 'POST', { username: 'member', password: 'fixture_password' })).statusCode, 401);
});
test('changing password verifies original password and revokes existing sessions', async () => {
  const store = memoryStore();
  assert.equal((await authRequest(store, 'change-password', 'POST', { currentPassword: 'wrong_password', newPassword: 'replacement_password' }, signed())).statusCode, 400);
  assert.equal((await authenticate(store)).passed, true);
  assert.equal((await authRequest(store, 'change-password', 'POST', { currentPassword: 'fixture_password', newPassword: 'replacement_password' }, signed())).statusCode, 200);
  assert.equal((await authenticate(store)).res.statusCode, 401);
  const user = JSON.parse(store.values.get('user:member'));
  assert.equal(user.password, undefined); assert.equal(await verifyStoredPassword(user, 'replacement_password'), true);
});
test('admin user endpoints reject ordinary users and never expose passwords', async () => {
  const store = memoryStore();
  assert.equal((await adminRequest(store, '/', 'GET', {}, baseUser)).statusCode, 403);
  const listing = await adminRequest(store, '/?q=mem', 'GET');
  assert.equal(listing.body.total, 1); assert.deepEqual(listing.body.data, [publicUser(baseUser)]);
  assert.equal((await adminRequest(store, '/member', 'PATCH', { passwordHash: 'bad' })).statusCode, 400);
  assert.equal((await adminRequest(store, '/member', 'PATCH', { role: 'owner' })).statusCode, 400);
});
test('self-demotion/self-disable and last-admin removal are blocked', async () => {
  const admin = { ...baseUser, role: 'admin' };
  const store = memoryStore([admin]);
  for (const body of [{ role: 'user' }, { status: 'disabled' }]) {
    assert.equal((await adminRequest(store, '/member', 'PATCH', body, admin)).statusCode, 409);
    await assert.rejects(updateUser(store, 'member', (u) => ({ ...u, status: 'active', ...body })), /最后一个/);
  }
});
test('disabling then enabling never resurrects old sessions', async () => {
  const store = memoryStore(); const actor = { id: 8, username: 'administrator', role: 'admin' };
  assert.equal((await adminRequest(store, '/member', 'PATCH', { status: 'disabled' }, actor)).statusCode, 200);
  assert.equal((await adminRequest(store, '/member', 'PATCH', { status: 'active' }, actor)).statusCode, 200);
  assert.equal((await authenticate(store)).res.statusCode, 401);
});
test('admin reset and explicit revoke invalidate existing sessions', async () => {
  const store = memoryStore();
  assert.equal((await adminRequest(store, '/member/reset-password', 'POST', { newPassword: 'replacement_password' })).statusCode, 200);
  assert.equal((await authenticate(store)).res.statusCode, 401);
  const user = JSON.parse(store.values.get('user:member'));
  const token = signed(user); assert.equal((await authenticate(store, token)).passed, true);
  assert.equal((await adminRequest(store, '/member/revoke-sessions', 'POST')).statusCode, 200);
  assert.equal((await authenticate(store, token)).res.statusCode, 401);
});

// Opt-in verification uses real Redis Lua in a unique namespace. It never reads
// or updates production account keys and cleans up only its own keys.
test('real Redis: concurrent last-admin changes and registration remain atomic', { skip: process.env.AUTH_REDIS_INTEGRATION !== '1' }, async () => {
  const redis = await getRedisClient();
  const prefix = `auth-test:${randomUUID()}:`;
  const keys = new Set();
  const store = {
    get: (key) => redis.get(prefix + key),
    exists: (key) => redis.exists(prefix + key),
    incr: (key) => { keys.add(prefix + key); return redis.incr(prefix + key); },
    set: (key, value, opts) => { keys.add(prefix + key); return redis.set(prefix + key, value, opts); },
    eval: (script, options) => redis.eval(script.replaceAll("'user:*'", `'${prefix}user:*'`).replaceAll("'user:id_counter'", `'${prefix}user:id_counter'`), { ...options, keys: options.keys.map((key) => prefix + key) }),
  };
  try {
    for (const [i, name] of ['admin_one', 'admin_two'].entries()) await store.set(`user:${name}`, JSON.stringify({ id: i + 1, username: name, role: 'admin', status: 'active' }));
    const results = await Promise.allSettled(['admin_one', 'admin_two'].map((name) => updateUser(store, name, (u) => ({ ...u, role: 'user' }))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /最后一个/);
    const registrations = await Promise.all([1, 2].map(() => authRequest(store, 'register', 'POST', { username: 'new_user', password: 'fixture_password' })));
    assert.deepEqual(registrations.map((r) => r.statusCode).sort(), [200, 409]);
  } finally {
    if (keys.size) await redis.del([...keys]);
    await redis.close();
  }
});

test('HTTP guards block research/admin endpoints but preserve ordinary recommendations and favorites', async () => {
  const store = memoryStore();
  const app = express();
  app.use('/api', createAuthMiddleware({ getRedis: async () => store, getSecret: () => SECRET }));
  registerApiPermissions(app);
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { authorization: `Bearer ${signed()}` };
    for (const path of ['/api/factor-returns', '/api/factor-detail', '/api/admin/factors', '/api/admin/users']) {
      assert.equal((await fetch(url + path, { headers })).status, 403);
    }
    for (const path of ['/api/factors', '/api/recommendations', '/api/favorites', '/api/favorites-backtest']) {
      assert.equal((await fetch(url + path, { headers })).status, 200);
    }
    store.values.set('user:member', JSON.stringify({ ...baseUser, role: 'admin' }));
    assert.equal((await fetch(url + '/api/factor-returns', { headers })).status, 200);
    assert.equal((await fetch(url + '/api/admin/users', { headers })).status, 200);
    store.values.set('user:member', JSON.stringify(baseUser));
    assert.equal((await fetch(url + '/api/factor-returns', { headers })).status, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('new password length errors leave the account and sessions unchanged', async () => {
  const store = memoryStore();
  const original = store.values.get('user:member');
  assert.equal((await authRequest(store, 'register', 'POST', { username: 'oversized', password: 'a'.repeat(73) })).statusCode, 400);
  assert.equal(store.values.has('user:oversized'), false);
  assert.equal((await authRequest(store, 'change-password', 'POST', { currentPassword: 'fixture_password', newPassword: '中'.repeat(25) }, signed())).statusCode, 400);
  assert.equal((await adminRequest(store, '/member/reset-password', 'POST', { newPassword: 'a'.repeat(73) })).statusCode, 400);
  assert.equal(store.values.get('user:member'), original);
  assert.equal((await authenticate(store)).passed, true);
});

test('server signing configuration failure returns 503 instead of logging the user out', async () => {
  const req = { headers: { authorization: `Bearer ${signed()}` } }, res = response();
  await createAuthMiddleware({ getRedis: async () => memoryStore(), getSecret: () => { throw new Error('configuration missing'); } })(req, res, () => assert.fail('must fail closed'));
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'AUTH_UNAVAILABLE');
});
