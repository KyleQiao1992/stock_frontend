import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsKlineHandler } from './usKline.js';

const tencentValid = ['2026-09-17', '100', '101', '102', '99', '1000'];
const nasdaqValid = { date: '09/17/2026', open: '$100', close: '$101', high: '$102', low: '$99', volume: '1,000' };

async function execute({ adjust, tencentRows, tencentKey = 'qfqday', nasdaqRows, rowsBySymbol, quoteFields, symbol = 'AAPL' }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'web.ifzq.gtimg.cn') {
      const symbol = url.searchParams.get('param').split(',')[0];
      return { ok: true, json: async () => ({ data: { [symbol]: { [tencentKey]: rowsBySymbol?.[symbol] ?? tencentRows } } }) };
    }
    if (url.hostname === 'api.nasdaq.com' && url.pathname.endsWith('/historical')) {
      return { ok: true, json: async () => ({ data: { tradesTable: { rows: nasdaqRows } } }) };
    }
    if (url.hostname === 'qt.gtimg.cn' && quoteFields) {
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`v_usAAPL="${quoteFields.join('~')}";`).buffer };
    }
    return { ok: false, status: 503, text: async () => '' };
  };
  let body;
  const providerCalls = [];
  const mockedFetch = globalThis.fetch;
  const providerPaths = [];
  globalThis.fetch = async (...args) => { const url = new URL(String(args[0])); providerCalls.push(url.hostname); providerPaths.push(url.pathname); return mockedFetch(...args); };
  const res = { statusCode: 0, setHeader() {}, end(text) { body = JSON.parse(text); } };
  try {
    await createUsKlineHandler()({ url: `/api/us-kline?symbol=${encodeURIComponent(symbol)}&period=101&adjust=${adjust}` }, res);
    return { status: res.statusCode, body, providerCalls, providerPaths };
  } finally { globalThis.fetch = previousFetch; }
}

test('US rejects invalid Tencent K rows rather than splicing their neighbors', async () => {
  const invalid = ['2026-09-18', '100', '101', 'bad', '99', '1000'];
  const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [tencentValid, invalid, tencentValid], nasdaqRows: [] });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /K.?线|OHLC/i);
});

test('US rejects missing or empty Tencent OHLC instead of coercing it to zero', async () => {
  for (const high of [null, '', ' ', 'bad']) {
    const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [
      tencentValid, ['2026-09-18', '100', '101', high, '99', '1000'],
    ] });
    assert.equal(result.status, 502);
  }
});

test('US does not substitute raw Tencent or unverified Nasdaq data for requested adjusted data', async () => {
  for (const adjust of ['1', '2']) {
    const result = await execute({ adjust, tencentKey: 'day', tencentRows: [tencentValid], nasdaqRows: [nasdaqValid] });
    assert.equal(result.status, 502);
  }
});

test('US does not substitute Nasdaq history with unverified adjustment basis even for raw requests', async () => {
  const result = await execute({ adjust: '0', tencentRows: [], nasdaqRows: [nasdaqValid] });
  assert.equal(result.status, 502);
  assert.equal(result.providerCalls.includes('api.nasdaq.com'), false);
  assert.match(result.body.error, /复权|adjust/i);
});

test('US uses only the exact requested Tencent adjustment field', async () => {
  for (const [adjust, key] of [['0', 'day'], ['1', 'qfqday'], ['2', 'hfqday']]) {
    const result = await execute({ adjust, tencentKey: key, tencentRows: [tencentValid] });
    assert.equal(result.status, 200);
    assert.equal(result.body.klines[0].close, 101);
    assert.match(result.body.sourceInfo, new RegExp(key === 'day' ? 'raw' : key.slice(0, 3)));
    assert.ok(result.providerPaths.includes(adjust === '0' ? '/appstock/app/kline/kline' : '/appstock/app/fqkline/get'));
  }
});

test('US rejects malformed dates, impossible OHLC and duplicate K timestamps', async () => {
  for (const invalid of [
    ['2026-02-30', '100', '101', '102', '99', '1000'],
    ['2026-09-18', '100', '101', '100', '99', '1000'],
    ['2026-09-18', '100', '101', '102', '0', '1000'],
    ['2026-09-17', '100', '101', '102', '99', '1000'],
  ]) {
    const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [tencentValid, invalid] });
    assert.equal(result.status, 502);
  }
});

test('US rejects missing volume rather than returning data that the chart cannot accept', async () => {
  for (const value of [null, '', undefined]) {
    const row = [...tencentValid]; row[5] = value;
    const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [row] });
    assert.equal(result.status, 502);
  }
});

test('US quote metadata treats empty fields as unavailable rather than numeric zero', async () => {
  const fields = Array(65).fill('');
  fields[0] = '200'; fields[30] = '2026/09/17 16:00:00';
  const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [tencentValid], quoteFields: fields });
  assert.equal(result.status, 200);
  assert.equal(result.body.marketCap, null);
  assert.equal(result.body.floatMarketCap, null);
  assert.equal(result.body.peRatio, null);
  assert.equal(result.body.turnoverRate, null);
});

test('US rejects invalid ticker strings instead of silently changing the security requested', async () => {
  for (const symbol of ['AAPL$', 'AA PL', 'AAPL/OTHER', 'ABCDEFGHIJKLM']) {
    const result = await execute({ symbol, adjust: '0', tencentKey: 'day', tencentRows: [tencentValid] });
    assert.equal(result.status, 502);
    assert.deepEqual(result.providerCalls, []);
  }
});

test('US rejects invalid non-empty volume instead of quietly marking it unavailable', async () => {
  for (const value of ['bad', false, -1]) {
    const row = [...tencentValid]; row[5] = value;
    const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [row] });
    assert.equal(result.status, 502);
  }
});

test('a malformed returned series is not replaced by a different exchange suffix stub', async () => {
  const invalid = ['2026-09-18', '100', '101', 'bad', '99', '1000'];
  const result = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [], rowsBySymbol: {
    'usAAPL.OQ': [tencentValid, invalid], 'usAAPL.N': [tencentValid],
  } });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /K.?线|OHLC/i);
  const empty = await execute({ adjust: '0', tencentKey: 'day', tencentRows: [], rowsBySymbol: {
    'usAAPL.N': [tencentValid],
  } });
  assert.equal(empty.status, 200, 'a genuinely empty exchange candidate can still be tried on another suffix');
});
