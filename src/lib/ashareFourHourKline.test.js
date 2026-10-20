import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateAshareFourHourKline, fetchAshareFourHourKline } from './ashareFourHourKline.js';
import { parseKlineTime } from './klinePeriod.js';

const END_TIMES = ['10:00', '10:30', '11:00', '11:30', '13:30', '14:00', '14:30', '15:00'];
const CLOSED_NOW = Date.parse('2026-10-20T16:00:00+08:00');
const CLOSED_QUOTE = '20261020150000';

function dayRows(day, { start = 100, volumes = [1, 2, 3, 4, 5, 6, 7, 8] } = {}) {
  return END_TIMES.map((time, index) => ({ date: `${day} ${time}`, open: start + index,
    close: start + index + 0.5, high: start + index + 1, low: start + index - 1,
    volume: volumes[index], amount: 0, complete: true }));
}

function aggregate(rows, options = {}) {
  return aggregateAshareFourHourKline(rows, { now: CLOSED_NOW, quoteTime: CLOSED_QUOTE, ...options });
}

test('09:30 wall-clock windows use 5 + 3 children, preserve OHLC/lot volume, and recalculate target returns', () => {
  const rows = [...dayRows('2026-10-19'), ...dayRows('2026-10-20', { start: 110 })];
  const { klines, sourceBarCount, discardedSourceBarCount } = aggregate(rows);
  assert.equal(klines.length, 4);
  assert.equal(sourceBarCount, 16);
  assert.equal(discardedSourceBarCount, 0);
  const [morning, afternoon, nextMorning] = klines;
  assert.deepEqual([morning.date, morning.periodStart, morning.periodEnd],
    ['2026-10-19 13:30', '2026-10-19 09:30', '2026-10-19 13:30']);
  assert.deepEqual([morning.open, morning.close, morning.high, morning.low, morning.volume], [100, 104.5, 105, 99, 15]);
  assert.deepEqual([afternoon.open, afternoon.close, afternoon.high, afternoon.low, afternoon.volume], [105, 107.5, 108, 104, 21]);
  assert.deepEqual([morning.sourceBarCount, afternoon.sourceBarCount], [5, 3]);
  assert.equal(morning.lastSourceTime, '2026-10-19 13:30');
  assert.equal(afternoon.periodStart, morning.periodEnd); // 13:30 child belongs only to the first window.
  assert.equal(morning.change, 0);
  assert.equal(afternoon.change, 3);
  assert.equal(afternoon.pct, 3 / 104.5 * 100);
  assert.equal(nextMorning.change, 7);
  assert.equal(nextMorning.amplitude, 6 / 107.5 * 100);
  assert.ok(klines.every(row => row.complete && row.turnover === null));
  assert.ok(klines.every(row => row.amount === 0 && row.amountAvailable === false));
});

test('turnover amount is summed only when each child explicitly reports a real available amount', () => {
  const rows = dayRows('2026-10-20').map((row, index) => ({ ...row, amount: 100 * (index + 1), amountAvailable: true }));
  const { klines } = aggregate(rows);
  assert.equal(klines[0].amount, 1500);
  assert.equal(klines[0].amountAvailable, true);
  assert.equal(klines[1].amount, 2100);
  rows[1].amountAvailable = false;
  assert.equal(aggregate(rows).klines[0].amountAvailable, false);
  assert.equal(aggregate(rows).klines[0].amount, 0);
});

test('an initial pagination suffix may be dropped; interior missing children and whole sessions are errors', () => {
  const full = [...dayRows('2026-10-19'), ...dayRows('2026-10-20')];
  const result = aggregate(full.slice(2)); // Oldest 11:00/11:30/13:30 are the cut first window.
  assert.equal(result.discardedSourceBarCount, 3);
  assert.equal(result.klines.length, 3);
  assert.equal(result.klines[0].date, '2026-10-19 15:00');
  assert.equal(result.klines[0].change, 0);
  // Starting at a whole afternoon is also a valid leading retention boundary.
  assert.equal(aggregate(full.slice(5)).klines.length, 3);
  for (const index of [1, 6, 9, 15]) {
    assert.throws(() => aggregate(full.filter((_, offset) => offset !== index)), /缺少30分钟K线/);
  }
  assert.throws(() => aggregate(full.filter(row => !row.date.startsWith('2026-10-20 1') || row.date.slice(11) >= '14:00')),
    /2026-10-20 缺少 10:00/);
  assert.throws(() => aggregate(full.filter(row => !row.date.startsWith('2026-10-19') || row.date.slice(11) <= '13:30')),
    /2026-10-19 缺少 14:00/);
  assert.throws(() => aggregate(dayRows('2026-10-20').slice(2, 5)), /没有完整|缺少/);
});

test('entirely absent dates are not fabricated as trading days', () => {
  const result = aggregate([...dayRows('2026-10-16'), ...dayRows('2026-10-20')]);
  assert.deepEqual(result.klines.map(row => row.date.slice(0, 10)), ['2026-10-16', '2026-10-16', '2026-10-20', '2026-10-20']);
});

test('a legitimate current prefix forms one window through lunch with the real quote as-of time', () => {
  const rows = [...dayRows('2026-10-19'), ...dayRows('2026-10-20').slice(0, 4)];
  const result = aggregate(rows, { now: Date.parse('2026-10-20T13:00:00+08:00'), quoteTime: '20261020125900' });
  const latest = result.klines.at(-1);
  assert.equal(result.klines.length, 3);
  assert.equal(latest.date, '2026-10-20 13:30');
  assert.equal(latest.lastSourceTime, '2026-10-20 11:30');
  assert.equal(latest.asOfTime, '2026-10-20 12:59');
  assert.equal(latest.sourceBarCount, 4);
  assert.equal(latest.expectedSourceBarCount, 5);
  assert.equal(latest.complete, false); // Every present child is closed, the 4h window is not.
  assert.throws(() => aggregate(rows, { now: Date.parse('2026-10-20T13:31:00+08:00'), quoteTime: '20261020125900' }), /缺少 13:30/);
  assert.throws(() => aggregate(rows.filter(row => row.date !== '2026-10-20 10:30'),
    { now: Date.parse('2026-10-20T13:00:00+08:00'), quoteTime: '20261020125900' }), /缺少 10:30/);
});

test('active children may have future end labels; children with a future start are rejected', () => {
  const historical = dayRows('2026-10-19');
  const forming = dayRows('2026-10-20').slice(0, 2).map((row, index) => ({ ...row, complete: index === 0 }));
  const options = { now: Date.parse('2026-10-20T10:03:00+08:00'), quoteTime: '20261020100200' };
  const latest = aggregate([...historical, ...forming], options).klines.at(-1);
  assert.equal(latest.lastSourceTime, '2026-10-20 10:30');
  assert.equal(latest.asOfTime, '2026-10-20 10:02');
  assert.equal(latest.complete, false);
  assert.throws(() => aggregate([...historical, ...dayRows('2026-10-20').slice(0, 3)], options), /尚未开始.*11:00/);
  assert.throws(() => aggregate([...historical, ...forming], { ...options, quoteTime: '20261020095900' }), /尚未开始.*10:30/);
  const afternoon = dayRows('2026-10-20').slice(0, 5).map((row, index) => ({ ...row, complete: index < 4 }));
  assert.equal(aggregate([...historical, ...afternoon], { now: Date.parse('2026-10-20T13:10:00+08:00'),
    quoteTime: '20261020131000' }).klines.at(-1).asOfTime, '2026-10-20 13:10');
  assert.throws(() => aggregate([...historical, ...afternoon], { now: Date.parse('2026-10-20T12:59:00+08:00'),
    quoteTime: '20261020125900' }), /尚未开始.*13:30/);
});

test('stale current prefixes cannot conceal closed children or an entire started afternoon window', () => {
  const historical = dayRows('2026-10-19');
  const current = dayRows('2026-10-20');
  for (const quoteTime of ['20261020131000', '20261020094500']) {
    assert.throws(() => aggregate([...historical, ...current.slice(0, 1)],
      { now: Date.parse('2026-10-20T13:10:00+08:00'), quoteTime }), /缺少 10:30/);
  }
  // The active 10:30 child is optional up to its end plus finalization grace.
  const oneChild = [...historical, current[0]];
  assert.equal(aggregate(oneChild, { now: Date.parse('2026-10-20T10:30:59+08:00'),
    quoteTime: '20261020103059' }).klines.at(-1).sourceBarCount, 1);
  assert.throws(() => aggregate(oneChild, { now: Date.parse('2026-10-20T10:31:00+08:00'),
    quoteTime: '20261020103100' }), /缺少 10:30/);
  const morningOnly = [...historical, ...current.slice(0, 5)];
  assert.equal(aggregate(morningOnly, { now: Date.parse('2026-10-20T14:00:59+08:00'),
    quoteTime: '20261020140059' }).klines.length, 3);
  assert.throws(() => aggregate(morningOnly, { now: Date.parse('2026-10-20T14:10:00+08:00'),
    quoteTime: '20261020141000' }), /2026-10-20 缺少 14:00/);
  assert.throws(() => aggregate(morningOnly, { now: Date.parse('2026-10-20T14:01:00+08:00'),
    quoteTime: '20261020135900' }), /2026-10-20 缺少 14:00/);
});

test('full child coverage is complete only after source reaches close plus local finalization and child completion', () => {
  const rows = dayRows('2026-10-20');
  assert.equal(aggregate(rows, { now: Date.parse('2026-10-20T15:00:59+08:00'), quoteTime: '20261020150000' }).klines[1].complete, false);
  assert.equal(aggregate(rows, { now: Date.parse('2026-10-20T15:01:00+08:00'), quoteTime: '20261020150000' }).klines[1].complete, true);
  assert.equal(aggregate(rows, { quoteTime: '20261020145959' }).klines[1].complete, false);
  assert.equal(aggregate(rows, { quoteTime: undefined }).klines[1].complete, false);
  assert.equal(aggregate(rows.map((row, index) => ({ ...row, complete: index !== 7 }))).klines[1].complete, false);
  const prefix = rows.slice(0, 7);
  assert.equal(aggregate(prefix, { now: Date.parse('2026-10-20T15:00:59+08:00') }).klines[1].complete, false);
  assert.throws(() => aggregate(prefix, { now: Date.parse('2026-10-20T15:01:00+08:00') }), /缺少 15:00/);
});

test('malformed times, OHLC, conflicting duplicates and invalid clocks fail explicitly', () => {
  const rows = dayRows('2026-10-20');
  assert.throws(() => aggregate([]), /没有可用/);
  assert.throws(() => aggregate(rows, { now: NaN }), /本地时间无效/);
  for (const patch of [{ date: '2026-02-30 10:00' }, { date: '2026-10-20 10:15' },
    { date: '2026-10-20 10:00:01' }, { open: NaN }, { high: 99 }, { volume: -1 },
    { amount: -1 }, { complete: undefined }]) {
    assert.throws(() => aggregate([{ ...rows[0], ...patch }, ...rows.slice(1)]), /异常/);
  }
  assert.equal(aggregate([...rows, { ...rows[0] }]).sourceBarCount, 8);
  assert.throws(() => aggregate([...rows, { ...rows[0], volume: 999 }]), /重复冲突/);
  assert.deepEqual(aggregate([...rows].reverse()).klines, aggregate(rows).klines);
});

function sourcePayload(symbol, key, rows, quoteTime = CLOSED_QUOTE) {
  const quote = [];
  quote[30] = quoteTime;
  return { code: 0, data: { [symbol]: { [key]: rows, qt: { [symbol]: quote } } } };
}

function minuteLoader({ symbol, minutes, raw = [], qfq = [], quoteTime = CLOSED_QUOTE }) {
  const calls = [];
  return { calls, loadJson: async url => {
    const parsed = new URL(url);
    const param = parsed.searchParams.get('param').split(',');
    calls.push({ path: parsed.pathname, param });
    assert.equal(param[0], symbol);
    if (parsed.pathname.endsWith('/mkline')) {
      assert.equal(param[1], 'm30');
      assert.ok(+param[3] <= 800);
      return sourcePayload(symbol, 'm30', minutes.filter(row => !param[2] || row[0] < param[2]).slice(-Number(param[3])), quoteTime);
    }
    return parsed.pathname.endsWith('/fqkline/get') ? sourcePayload(symbol, 'qfqday', qfq, quoteTime)
      : sourcePayload(symbol, 'day', raw, quoteTime);
  } };
}

function sourceRows(rows) {
  return rows.map(row => [row.date.replace(/[- :]/g, ''), row.open, row.close, row.high, row.low, row.volume]);
}

test('wrapper paginates real 30m retention up to 2400 without pretending the target has 2400 candles', async () => {
  const minutes = [];
  for (let offset = 0; offset < 250; offset += 1) {
    const date = new Date(Date.UTC(2025, 11, 1 + offset)).toISOString().slice(0, 10);
    minutes.push(...sourceRows(dayRows(date)));
  }
  const retained = minutes.slice(-1940);
  const { calls, loadJson } = minuteLoader({ symbol: 'sh000688', minutes: retained });
  const result = await fetchAshareFourHourKline({ symbol: 'sh000688', isIndex: true, loadJson, now: CLOSED_NOW });
  assert.deepEqual(calls.map(call => +call.param[3]), [800, 800, 800]);
  assert.equal(result.klines.length, 485); // 1 retained leading child discarded; 242 full days + afternoon.
  assert.equal(result.klines[0].date.slice(11), '15:00');
  assert.equal(result.klines[0].volume, 21);
  assert.ok(result.sourceInfo.includes('1940 source bars; discarded leading=1'));
  assert.ok(result.sourceInfo.includes('30m → 4h'));
  assert.equal(result.quotePayload.data.sh000688.qt.sh000688[30], CLOSED_QUOTE);
  assert.ok(result.klines.every(row => row.complete));
});

test('wrapper applies existing verified qfq before aggregation and never rescales STAR volume twice', async () => {
  const action = { cqr: '2026-10-19', FHcontent: '10派2元转4股' };
  const raw = [
    ['2026-10-16', 121.91, 113, 121.91, 111.51, 1977912],
    ['2026-10-19', 81.5, 79.21, 81.5, 73.46, 2627883, action],
  ];
  const qfq = [
    ['2026-10-16', 86.936, 80.572, 86.936, 79.507, 1977912],
    ['2026-10-19', 81.5, 79.21, 81.5, 73.46, 2627883, action],
  ];
  const before = dayRows('2026-10-16').map(row => ({ ...row, open: 113, close: 113, high: 114, low: 112, volume: 100 }));
  Object.assign(before[0], { open: 121.91, close: 120, high: 121.91, low: 119 });
  Object.assign(before[7], { low: 111.51 });
  const after = dayRows('2026-10-19').map(row => ({ ...row, open: 79.21, close: 79.21, high: 80, low: 79, volume: 200 }));
  Object.assign(after[0], { open: 81.5, close: 80, high: 81.5 });
  Object.assign(after[7], { low: 73.46 });
  const source = minuteLoader({ symbol: 'sh688610', minutes: sourceRows([...before, ...after]), raw, qfq });
  const result = await fetchAshareFourHourKline({ symbol: 'sh688610', code: '688610', loadJson: source.loadJson, now: CLOSED_NOW });
  assert.equal(result.klines.length, 4);
  assert.ok(Math.abs(result.klines[0].open - 86.936) < 0.001);
  assert.ok(Math.abs(result.klines[1].close - 80.572) < 0.001);
  assert.equal(result.klines[0].volume, 5); // 5 × 100 shares ÷ 100, with no additional 4h scaling.
  assert.equal(result.klines[1].volume, 3);
  assert.equal(result.klines[2].volume, 10);
  assert.ok(Math.abs(result.klines[2].pct - (79.21 / 80.572 - 1) * 100) < 0.002); // No raw -30% ex-rights gap.
  assert.equal(source.calls.filter(call => call.path.endsWith('/fqkline/get')).length, 1);
  assert.equal(source.calls.filter(call => call.path.endsWith('/kline/kline')).length, 1);
});

test('wrapper preserves minute-source and adjustment errors rather than substituting daily data', async () => {
  await assert.rejects(fetchAshareFourHourKline({ symbol: 'sh603268', period: 60 }), /周期必须为240/);
  const broken = async () => ({ code: 0, data: { sh603268: { day: [] } } });
  await assert.rejects(fetchAshareFourHourKline({ symbol: 'sh603268', adjust: '0', loadJson: broken, now: CLOSED_NOW }), /没有返回 30 分钟/);
  const source = minuteLoader({ symbol: 'sh603268', minutes: sourceRows(dayRows('2026-10-20')) });
  await assert.rejects(fetchAshareFourHourKline({ symbol: 'sh603268', loadJson: source.loadJson, now: CLOSED_NOW }), /前复权缺少同源日/);
  assert.equal(parseKlineTime('2026-10-20 13:30') - parseKlineTime('2026-10-20 09:30'), 4 * 3600);
});

test('an invalid Tencent snapshot clock does not become a numeric 1970 timestamp or complete target bars', async () => {
  const source = minuteLoader({ symbol: 'sh000688', minutes: sourceRows(dayRows('2026-10-20')), quoteTime: '20261020' });
  const result = await fetchAshareFourHourKline({ symbol: 'sh000688', isIndex: true, loadJson: source.loadJson, now: CLOSED_NOW });
  assert.equal(result.klines.length, 2);
  assert.ok(result.klines.every(row => row.complete === false && row.asOfTime === null));
});
