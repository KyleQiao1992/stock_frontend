import test from 'node:test';
import assert from 'node:assert/strict';
import { authFetch, authJson } from './authClient.js';

function setup(t, status, body, beforeResponse) {
  const original = { localStorage: globalThis.localStorage, window: globalThis.window, fetch: globalThis.fetch };
  const data = new Map([['token', 'fixture_token'], ['userId', '7'], ['username', 'member']]);
  const events = [];
  globalThis.localStorage = { getItem: (k) => data.get(k) ?? null, removeItem: (k) => data.delete(k) };
  globalThis.window = { dispatchEvent: (e) => events.push(e) };
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; beforeResponse?.(data); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { data, events, request: () => request };
}
test('401 clears auth and preserves the server explanation', async (t) => {
  const { data, events } = setup(t, 401, { ok: false, error: '账号已被禁用。' });
  await assert.rejects(authFetch('/api/test'), /账号已被禁用/);
  assert.equal(data.size, 0); assert.equal(events[0].type, 'auth-expired'); assert.equal(events[0].detail, '账号已被禁用。');
});
test('403 preserves login and triggers a role refresh', async (t) => {
  const { data, events } = setup(t, 403, { ok: false, error: '没有操作权限。' });
  await assert.rejects(authFetch('/api/test'), /没有操作权限/);
  assert.equal(data.get('token'), 'fixture_token'); assert.equal(events[0].type, 'auth-forbidden');
});
test('a delayed 401 from an old account cannot clear a new login', async (t) => {
  const { data, events } = setup(t, 401, {}, (data) => data.set('token', 'new_login'));
  await assert.rejects(authFetch('/api/test'));
  assert.equal(data.get('token'), 'new_login'); assert.equal(events.length, 0);
});
test('503 does not log out; auth headers preserve JSON content type', async (t) => {
  const { data, events, request } = setup(t, 503, { ok: false, error: '账号服务暂时不可用。' });
  await assert.rejects(authJson('/api/test', { headers: { 'Content-Type': 'application/json' } }), /账号服务暂时不可用/);
  assert.equal(data.get('token'), 'fixture_token'); assert.equal(events.length, 0);
  assert.equal(request().options.cache, 'no-store');
  assert.equal(request().options.headers.get('Authorization'), 'Bearer fixture_token');
  assert.equal(request().options.headers.get('Content-Type'), 'application/json');
});
