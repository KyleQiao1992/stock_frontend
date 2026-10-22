import assert from 'node:assert/strict';
import test from 'node:test';
import { TENCENT_KLINE_HOSTS, createTencentKlineHostSelector, requestTencentKlineHost } from './tencentKlineHosts.js';

const [firstHost, secondHost] = TENCENT_KLINE_HOSTS;

test('a failed primary host uses the same request on the other Tencent origin', async () => {
  const select = createTencentKlineHostSelector();
  const calls = [];
  const payload = { code: 0, data: { sh688610: { qfqday: [['2026-10-21', 81, 79.33, 83.83, 79.13, 1970100]] } } };
  const result = await select(async host => {
    calls.push(host);
    if (host === firstHost) throw new Error('HTTP 501 Tencent WAF');
    return payload;
  });
  assert.deepEqual(calls, [firstHost, secondHost]);
  assert.equal(result, payload);
});

test('the next request prefers the last host with an accepted payload', async () => {
  const select = createTencentKlineHostSelector();
  await select(host => {
    if (host === firstHost) throw new Error('Failed to fetch');
    return 'first accepted payload';
  });
  const calls = [];
  const result = await select(host => { calls.push(host); return 'next payload'; });
  assert.deepEqual(calls, [secondHost]);
  assert.equal(result, 'next payload');
});

test('a formerly failing origin remains available when the successful origin later fails', async () => {
  const select = createTencentKlineHostSelector();
  await select(host => {
    if (host === firstHost) throw new Error('HTTP 501');
    return 'second host works today';
  });
  const recoveryCalls = [];
  await select(host => {
    recoveryCalls.push(host);
    if (host === secondHost) throw new Error('HTTP 501');
    return 'first host works tomorrow';
  });
  assert.deepEqual(recoveryCalls, [secondHost, firstHost]);
  const nextCalls = [];
  await select(host => { nextCalls.push(host); return 'accepted'; });
  assert.deepEqual(nextCalls, [firstHost]);
});

test('all failures preserve every origin, reason and original error', async () => {
  const select = createTencentKlineHostSelector();
  const causes = [new Error('HTTP 501 Tencent WAF'), new SyntaxError('腾讯行情文本格式异常')];
  await assert.rejects(select(host => Promise.reject(causes[host === firstHost ? 0 : 1])), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    for (const [index, host] of TENCENT_KLINE_HOSTS.entries()) {
      assert.ok(error.message.includes(host));
      assert.ok(error.message.includes(causes[index].message));
      assert.equal(error.errors[index].cause, causes[index]);
    }
    return true;
  });
  const calls = [];
  await select(host => { calls.push(host); return 'recovered'; });
  assert.deepEqual(calls, [firstHost]);
});

test('switching origins preserves period, adjustment, count and callback parameters', async () => {
  const select = createTencentKlineHostSelector();
  const original = new URL('https://ifzq.gtimg.cn/appstock/app/fqkline/get?_var=tencent_param_test&param=sh688610%2Cweek%2C%2C%2C1000%2Cqfq');
  const urls = [];
  await select((...args) => {
    assert.equal(args.length, 1);
    const url = new URL(`${original.pathname}${original.search}`, args[0]);
    urls.push(url);
    if (url.origin === firstHost) throw new Error('HTTP 501');
    return { code: 0 };
  });
  assert.deepEqual(urls.map(url => url.origin), TENCENT_KLINE_HOSTS);
  for (const url of urls) {
    assert.equal(url.pathname, original.pathname);
    assert.equal(url.search, original.search);
    assert.equal(url.searchParams.get('param'), 'sh688610,week,,,1000,qfq');
    assert.equal(url.searchParams.get('_var'), 'tencent_param_test');
  }
});

test('selectors have independent preferences and copy the configured candidates', async () => {
  const configured = [...TENCENT_KLINE_HOSTS];
  const first = createTencentKlineHostSelector(configured);
  const second = createTencentKlineHostSelector();
  configured.reverse();
  const firstCalls = [];
  await first(host => {
    firstCalls.push(host);
    if (host === firstHost) throw new Error('HTTP 501');
    return 'accepted';
  });
  assert.deepEqual(firstCalls, [firstHost, secondHost]);
  const secondCalls = [];
  await second(host => { secondCalls.push(host); return 'accepted'; });
  assert.deepEqual(secondCalls, [firstHost]);
  assert.equal(typeof requestTencentKlineHost, 'function');
});

test('a custom proxy base retains its path prefix and unchanged adjusted K-line parameters', async () => {
  const proxyBase = 'https://proxy.finance.qq.com/ifzqgtimg';
  const select = createTencentKlineHostSelector([proxyBase, ...TENCENT_KLINE_HOSTS]);
  const calls = [];
  const payload = { code: 0, data: { sh603818: { qfqday: [['2026-10-21', 4.7, 4.63, 4.72, 4.61, 415500]] } } };
  const callbackName = 'tencent_kline_proxy_test';
  for (const [period, limit, adjustment] of [['day', 600, 'qfq'], ['week', 1000, 'hfq'], ['month', 320, 'qfq']]) {
    const param = `sh603818,${period},,,${limit},${adjustment}`;
    const result = await select(host => {
      const url = new URL(`${host}/appstock/app/fqkline/get?_var=${encodeURIComponent(callbackName)}&param=${encodeURIComponent(param)}`);
      calls.push(url);
      assert.equal(url.origin, 'https://proxy.finance.qq.com');
      assert.equal(url.pathname, '/ifzqgtimg/appstock/app/fqkline/get');
      assert.equal(url.searchParams.get('_var'), callbackName);
      assert.equal(url.searchParams.get('param'), param);
      return payload;
    });
    assert.equal(result, payload);
  }
  assert.equal(calls.length, 3, 'an accepted proxy payload must not also query the default origins');
  assert.deepEqual(TENCENT_KLINE_HOSTS, ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn']);
});

test('a custom proxy failure keeps default-origin rotation and the same adjustment query', async () => {
  const proxyBase = 'https://proxy.finance.qq.com/ifzqgtimg';
  const select = createTencentKlineHostSelector([proxyBase, ...TENCENT_KLINE_HOSTS]);
  const query = '_var=tencent_proxy_rotation&param=sh603818%2Cday%2C%2C%2C600%2Cqfq';
  const calls = [];
  await select(host => {
    const url = new URL(`${host}/appstock/app/fqkline/get?${query}`);
    calls.push(url);
    if (host === proxyBase || host === firstHost) throw new Error('fixture endpoint unavailable');
    return { code: 0 };
  });
  assert.deepEqual(calls.map(url => `${url.origin}${url.pathname}`), [
    `${proxyBase}/appstock/app/fqkline/get`,
    `${firstHost}/appstock/app/fqkline/get`,
    `${secondHost}/appstock/app/fqkline/get`,
  ]);
  assert.ok(calls.every(url => url.search.slice(1) === query));
  const nextCalls = [];
  await select(host => { nextCalls.push(host); return { code: 0 }; });
  assert.deepEqual(nextCalls, [secondHost]);
});
