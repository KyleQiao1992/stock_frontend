import test from 'node:test';
import assert from 'node:assert/strict';
import { createStockDetailsLoader } from './stockDetailsLoader.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('risk publishes immediately while company profile is still pending', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const risk = deferred(), profile = deferred(), riskPublished = deferred();
  const published = new Map();
  let groupFinished = false;
  const done = loader.load({
    tasks: {
      finance: async () => ({ report: 'fixture' }),
      tradeSide: async () => ({ rows: [] }),
      profile: () => profile.promise,
      suspension: () => risk.promise,
    },
    onSettled(key, outcome) {
      published.set(key, outcome);
      if (key === 'suspension') riskPublished.resolve();
    },
  }).then((results) => { groupFinished = true; return results; });
  risk.resolve({ level: 'normal' });
  await riskPublished.promise;
  assert.deepEqual(published.get('suspension'), { status: 'fulfilled', value: { level: 'normal' } });
  assert.equal(published.has('profile'), false);
  assert.equal(groupFinished, false);
  profile.resolve({ company: 'fixture' });
  const results = await done;
  assert.equal(published.get('profile').status, 'fulfilled');
  assert.equal(Object.keys(results).length, 4);
});

test('one failed request does not delay another result and preserves its error', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const risk = deferred(), failurePublished = deferred();
  const published = new Map();
  const expected = new Error('公司资料源连接失败');
  const done = loader.load({
    tasks: { profile: () => { throw expected; }, suspension: () => risk.promise },
    onSettled(key, outcome) { published.set(key, outcome); failurePublished.resolve(); },
  });
  await failurePublished.promise;
  assert.deepEqual(published.get('profile'), { status: 'rejected', reason: expected });
  assert.equal(published.has('suspension'), false);
  risk.resolve({ level: 'abnormal' });
  await done;
  assert.deepEqual(published.get('suspension'), { status: 'fulfilled', value: { level: 'abnormal' } });
});

test('loading stock B aborts stock A and a late A result cannot overwrite B', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const oldRequest = deferred(), oldStarted = deferred();
  const published = [];
  let oldSignal;
  const oldDone = loader.load({
    tasks: { suspension: (signal) => { oldSignal = signal; oldStarted.resolve(); return oldRequest.promise; } },
    onSettled: (...args) => published.push(['A', ...args]),
  });
  await oldStarted.promise;
  const newDone = loader.load({
    tasks: { suspension: async () => ({ code: 'B', level: 'normal' }) },
    onSettled: (...args) => published.push(['B', ...args]),
  });
  const oldResults = await oldDone;
  assert.equal(oldSignal.aborted, true);
  assert.equal(oldResults.suspension.reason.name, 'AbortError');
  await newDone;
  oldRequest.resolve({ code: 'A', level: 'abnormal' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(published.length, 1);
  assert.equal(published[0][0], 'B');
  assert.equal(published[0][2].value.code, 'B');
});

test('cancel settles ignored-signal requests and suppresses callbacks and late rejection', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const request = deferred(), started = deferred();
  const published = [];
  let signal;
  const done = loader.load({
    tasks: { suspension: (taskSignal) => { signal = taskSignal; started.resolve(); return request.promise; } },
    onSettled: (...args) => published.push(args),
  });
  await started.promise;
  loader.cancel();
  loader.cancel();
  const results = await done;
  assert.equal(signal.aborted, true);
  assert.equal(results.suspension.status, 'rejected');
  assert.equal(results.suspension.reason.name, 'AbortError');
  request.reject(new Error('upstream rejected after cancellation'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(published, []);
});

test('scope becoming stale suppresses both successful and failed callbacks', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const risk = deferred(), profile = deferred();
  const published = [];
  let current = true;
  const done = loader.load({
    tasks: { suspension: () => risk.promise, profile: () => profile.promise },
    isCurrent: () => current,
    onSettled: (...args) => published.push(args),
  });
  await Promise.resolve();
  current = false;
  risk.resolve({ level: 'normal' });
  profile.reject(new Error('旧股票资料失败'));
  const results = await done;
  assert.equal(results.suspension.status, 'fulfilled');
  assert.equal(results.profile.status, 'rejected');
  assert.deepEqual(published, []);
});

test('each stalled request times out, aborts and publishes an explicit error', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  const request = deferred();
  const signals = new Map(), published = new Map();
  const done = loader.load({
    tasks: {
      finance: async () => ({ report: 'ready' }),
      profile: (signal) => { signals.set('profile', signal); return request.promise; },
      suspension: (signal) => { signals.set('suspension', signal); return new Promise(() => {}); },
    },
    timeoutMs: 10,
    onSettled: (key, outcome) => published.set(key, outcome),
  });
  const results = await done;
  assert.equal(results.finance.status, 'fulfilled');
  for (const key of ['profile', 'suspension']) {
    assert.equal(signals.get(key).aborted, true);
    assert.equal(published.get(key).status, 'rejected');
    assert.equal(published.get(key).reason.name, 'TimeoutError');
    assert.equal(published.get(key).reason.code, 'STOCK_DETAILS_TIMEOUT');
    assert.match(published.get(key).reason.message, /加载超时/);
    assert.equal(published.get(key).value, undefined);
  }
  request.reject(new Error('upstream rejected after deadline'));
  await Promise.resolve();
  await Promise.resolve();
});

test('cancel before tasks start prevents upstream work from starting', { timeout: 1000 }, async () => {
  const loader = createStockDetailsLoader();
  let started = false;
  const done = loader.load({ tasks: { suspension: () => { started = true; return {}; } } });
  loader.cancel();
  await done;
  assert.equal(started, false);
});
