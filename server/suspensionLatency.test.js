import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeRisk, createSuspensionAlertHandler, createSuspendFeedLoader, fetchDailyKline } from './suspensionAlert.js';
import { parseTencentDailyKline } from './suspensionPrices.js';

const never = new Promise(() => {});
const today = () => '2026-10-21';
const announcement = {
  SECURITY_CODE: '688610', SUSPEND_REASON: '停牌核查',
  SUSPEND_START_DATE: '2026-10-21 00:00:00', PREDICT_RESUME_DATE: '',
};
const feedResponse = rows => ({ ok: true, json: async () => ({ success: true, code: 0, result: { data: rows } }) });

async function invoke(handler) {
  const response = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ url: '/api/suspension-alert?code=688610' }, response);
  return response;
}

test('a stalled optional Redis connection or read cannot hold a completed diagnosis', { timeout: 2000 }, async t => {
  for (const stage of ['connect', 'get']) await t.test(stage, async () => {
    let computations = 0;
    const handler = createSuspensionAlertHandler({
      cacheWaitMs: 10,
      getRedis: stage === 'connect' ? () => never : async () => ({ get: () => never, set: () => never }),
      compute: async () => { computations += 1; return { level: 'normal' }; },
    });
    const response = await invoke(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.level, 'normal');
    assert.equal(computations, 1);
  });
});

test('a stalled result-cache write does not hold the HTTP response', { timeout: 2000 }, async () => {
  let writes = 0;
  const handler = createSuspensionAlertHandler({
    cacheWaitMs: 10,
    getRedis: async () => ({ get: async () => null, set: () => { writes += 1; return never; } }),
    compute: async () => ({ level: 'normal' }),
  });
  assert.equal((await invoke(handler)).statusCode, 200);
  assert.equal(writes, 1);
});

test('overlapping diagnoses for the same key share one cache read and computation', { timeout: 2000 }, async () => {
  let release, started, calculations = 0, reads = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const computeResult = new Promise(resolve => { release = resolve; });
  const handler = createSuspensionAlertHandler({
    getRedis: async () => ({ get: async () => { reads += 1; return null; }, set: async () => {} }),
    compute: () => { calculations += 1; started(); return computeResult; },
  });
  const first = invoke(handler);
  await entered;
  const second = invoke(handler);
  release({ level: 'near_abnormal' });
  const responses = await Promise.all([first, second]);
  assert.equal(calculations, 1);
  assert.equal(reads, 1);
  assert.deepEqual(responses.map(response => response.body), [{ level: 'near_abnormal' }, { level: 'near_abnormal' }]);
});

test('announcement loading also bounds optional cache waits and ignores stalled writes', { timeout: 2000 }, async t => {
  for (const stage of ['connect', 'get', 'set']) await t.test(stage, async () => {
    let requests = 0;
    const loader = createSuspendFeedLoader({
      today, cacheWaitMs: 10,
      getRedis: stage === 'connect' ? () => never : async () => ({
        get: stage === 'get' ? () => never : async () => null,
        set: () => never,
      }),
      request: async () => { requests += 1; return feedResponse([announcement]); },
    });
    const feed = await loader();
    assert.equal(feed['688610'].reason, '停牌核查');
    assert.equal(requests, 1);
  });
});

test('overlapping announcement loads share one upstream request', async () => {
  let release, requests = 0;
  const network = new Promise(resolve => { release = resolve; });
  const loader = createSuspendFeedLoader({
    today,
    getRedis: async () => ({ get: async () => null, set: async () => {} }),
    request: () => { requests += 1; return network; },
  });
  const first = loader(), second = loader();
  assert.equal(first, second);
  release(feedResponse([announcement]));
  assert.equal((await first)['688610'].start, '2026-10-21');
  assert.equal(requests, 1);
});

test('unavailable or malformed announcement sources return 502 and cannot become cached normal risk', { timeout: 2000 }, async t => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/suspension688610-exrights.json', import.meta.url), 'utf8'));
  const stock = parseTencentDailyKline(fixture.stock, 'sh688610');
  const index = parseTencentDailyKline(fixture.index, 'sh000688', { isIndex: true });
  const failures = [
    ['HTTP failure', async () => ({ ok: false, status: 503 })],
    ['transport failure', async () => { throw new Error('connection closed'); }],
    ['upstream error', async () => ({ ok: true, json: async () => ({ success: false, code: 500, result: null }) })],
    ['missing list', async () => ({ ok: true, json: async () => ({ success: true, result: {} }) })],
  ];
  for (const [label, request] of failures) await t.test(label, async () => {
    const writes = [];
    const redis = { get: async () => null, set: async (...args) => { writes.push(args); } };
    const loadFeed = createSuspendFeedLoader({ today, request, getRedis: async () => redis });
    const handler = createSuspensionAlertHandler({
      getRedis: async () => redis,
      compute: (code, name) => computeRisk(code, name, {
        today: today(), loadFeed,
        loadDaily: async (_, { isIndex }) => isIndex ? index : stock,
      }),
    });
    const response = await invoke(handler);
    assert.equal(response.statusCode, 502);
    assert.match(response.body.error, /停复牌公告获取失败/);
    assert.equal(response.body.level, undefined);
    assert.equal(writes.length, 0);
    // Failed in-flight entries must clear so a later request can retry.
    assert.equal((await invoke(handler)).statusCode, 502);
  });
});

test('only an explicitly successful empty announcement array can be cached as no announcements', async () => {
  const reads = [], writes = [];
  const loader = createSuspendFeedLoader({
    today,
    getRedis: async () => ({
      get: async key => { reads.push(key); return null; },
      set: async (...args) => { writes.push(args); },
    }),
    request: async () => feedResponse([]),
  });
  assert.deepEqual(await loader(), {});
  assert.deepEqual(reads, ['suspend-feed:verified-v1:2026-10-21']);
  await new Promise(setImmediate); // Cache persistence runs after the result is available.
  assert.deepEqual(writes, [['suspend-feed:verified-v1:2026-10-21', '{}', { EX: 1800 }]]);
});

test('Tencent transport failure can use independently validated unadjusted Eastmoney prices', async () => {
  const calls = [];
  const result = await fetchDailyKline('688610', {
    request: async url => {
      calls.push(new URL(url));
      if (calls.length === 1) throw new Error('Tencent connection failed');
      return { ok: true, json: async () => ({ data: { name: '测试', klines: [
        '2026-10-20,10,10,10,10,100,1000,0,0,0,1',
        '2026-10-21,11,11,11,11,100,1100,0,10,1,1',
      ] } }) };
    },
  });
  assert.equal(result.rows.at(-1).referenceClose, 10);
  assert.deepEqual(calls.map(url => url.hostname), ['ifzq.gtimg.cn', 'push2his.eastmoney.com']);
  assert.equal(calls[1].searchParams.get('fqt'), '0');
});
