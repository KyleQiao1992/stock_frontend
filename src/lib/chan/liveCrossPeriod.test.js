import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { parseKlineTime } from '../klinePeriod.js';
import { buildTencentQfqTransforms } from '../ashareMinuteKline.js';
import { inspectLiveCrossPeriod } from './liveCrossPeriod.js';

const symbol = 'sh603818', code = '603818';
const at = text => parseKlineTime(text) * 1000;
const times = ['09:35', '09:40', '09:45', '09:50', '09:55', '10:00'];
const fives = () => times.map((time, i) => ({ date: `2026-09-29 ${time}`,
  open: 10 + i, close: 10.5 + i, high: 11 + i, low: 9 + i, volume: 10 + i, complete: true }));
const thirties = () => [{ date: '2026-09-29 10:00', open: 10, high: 16, low: 9, close: 15.5,
  volume: 75, complete: true }];
const result = (period, rows, identity = symbol, suffix = 'unadjusted') => ({ klines: rows,
  quotePayload: { code: 0, data: { [identity]: {} } }, sourceInfo: `Tencent ${period}m, ${rows.length} bars, 1 page(s), ${suffix}` });
const daily = (key, rows, identity = symbol) => ({ code: 0, data: { [identity]: { [key]: rows } } });
const rawDays = [
  ['2026-09-29', 10, 11, 12, 9, 100],
  ['2026-09-30', 10, 11, 12, 9, 100, { cqr: '2026-09-30', FHcontent: '10派10元' }],
];
const qfqDays = [['2026-09-29', 9, 10, 11, 8, 100], ['2026-09-30', 10, 11, 12, 9, 100]];
function harness({ minuteRows = { '5': fives(), '30': thirties() }, values, dailyLoader } = {}) {
  const minuteCalls = [], dailyCalls = [];
  const defaultTimes = ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02',
    '2026-09-30 10:05', '2026-09-30 10:07', '2026-09-30 10:08'];
  const ticks = (values || defaultTimes).map(value => typeof value === 'string' ? at(value) : value);
  const now = () => { if (!ticks.length) throw new Error('unexpected clock read'); return ticks.shift(); };
  const loadMinute = async options => { minuteCalls.push(options); return result(options.period, minuteRows[options.period]); };
  const loadJson = async url => {
    dailyCalls.push(url);
    if (dailyLoader) return dailyLoader(url);
    return url.includes('/fqkline/') ? daily('qfqday', qfqDays) : daily('day', rawDays);
  };
  return { now, loadMinute, loadJson, minuteCalls, dailyCalls };
}

test('qfq uses one daily transform for both periods, and records later daily receipt as the comparison observation', async () => {
  const h = harness();
  const data = await inspectLiveCrossPeriod({ symbol, code, adjust: '1', ...h });
  assert.deepEqual(h.minuteCalls.map(({ symbol: s, code: c, period, adjust }) => [s, c, period, adjust]),
    [[symbol, code, '5', '0'], [symbol, code, '30', '0']]);
  assert.equal(h.dailyCalls.length, 2);
  assert.match(h.dailyCalls[0], /kline\/kline/);
  assert.match(h.dailyCalls[1], /fqkline\/get/);
  assert.equal(data.basis.adjustment, 'qfq');
  assert.equal(data.basis.adjustmentBasis, 'shared_daily_transform');
  assert.equal(data.rows.five[0].open, 9);
  assert.equal(data.rows.thirty[0].open, 9);
  assert.equal(data.comparison.windows[0].status, 'complete');
  assert.equal(data.snapshots.five, at('2026-09-30 10:01') / 1000);
  assert.equal(data.snapshots.thirty, at('2026-09-30 10:02') / 1000);
  assert.equal(data.snapshots.dailyQfq, at('2026-09-30 10:07') / 1000);
  assert.equal(data.snapshots.fiveComparableAt, data.snapshots.dailyQfq);
  assert.equal(data.snapshots.thirtyComparableAt, data.snapshots.dailyQfq);
  assert.equal(data.comparison.windows[0].observedAt, data.snapshots.dailyQfq);
  assert.deepEqual(data.counts, { complete: 1, missing: 0, conflict: 0, unconfirmed: 0 });
  assert.equal(data.basis.verifiedProviderIdentity, false);
});

test('different history coverage uses one common qfq offset instead of independent interval estimates', async () => {
  const raw = [['2026-09-28', 10, 11, 12, 9, 100], ...rawDays];
  const qfq = [['2026-09-28', 9, 10, 11, 8, 100],
    ['2026-09-29', 9.0004, 10.0004, 11.0004, 8.0004, 100], qfqDays[1]];
  const firstOnly = buildTencentQfqTransforms(raw, qfq, ['2026-09-28']).get('2026-09-28').offset;
  const secondOnly = buildTencentQfqTransforms(raw, qfq, ['2026-09-29']).get('2026-09-29').offset;
  assert.notEqual(firstOnly, secondOnly, 'separate coverage really yields different estimates');
  const preceding = { ...fives()[0], date: '2026-09-28 15:00' };
  const h = harness({ minuteRows: { '5': [preceding, ...fives()], '30': thirties() },
    dailyLoader: url => url.includes('/fqkline/') ? daily('qfqday', qfq) : daily('day', raw) });
  const data = await inspectLiveCrossPeriod({ symbol, code, adjust: '1', ...h });
  assert.equal(data.comparison.windows[0].status, 'complete');
  assert.equal(data.rows.five[1].open, data.rows.thirty[0].open);
  assert.equal(data.rows.five[1].open, 9.0002);
  assert.equal(data.basis.adjustmentBasis, 'shared_daily_transform');
});

test('unadjusted and indices do not silently request or claim qfq daily transforms', async () => {
  for (const isIndex of [false, true]) {
    const h = harness({ values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
    const data = await inspectLiveCrossPeriod({ symbol, code, adjust: isIndex ? '1' : '0', isIndex, ...h });
    assert.equal(h.dailyCalls.length, 0);
    assert.equal(data.basis.adjustment, 'unadjusted');
    assert.equal(data.rows.five[0].open, 10);
    assert.equal(data.comparison.windows[0].status, 'complete');
  }
});

test('each source may omit only its last explicitly unfinished future-labelled bar within that period', async () => {
  const five = [...fives(), { date: '2026-09-30 10:05', open: 1, close: 1, high: 1, low: 1, volume: 1, complete: false }];
  const thirty = [...thirties(), { date: '2026-09-30 10:30', open: 1, close: 1, high: 1, low: 1, volume: 1, complete: false }];
  const h = harness({ minuteRows: { '5': five, '30': thirty },
    values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
  const data = await inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...h });
  assert.deepEqual(data.omitted, { five: 1, thirty: 1 });
  assert.equal(data.omittedDetails.five.date, '2026-09-30 10:05');
  assert.equal(data.omittedDetails.thirty.date, '2026-09-30 10:30');
  assert.equal(data.comparison.windows[0].status, 'complete');
  assert.equal(data.coverage.fiveEnd, '2026-09-29 10:00');
});

test('unexpected future, non-terminal or completed future candles stop comparison', async () => {
  for (const tail of [
    [{ date: '2026-09-30 10:10', complete: false }],
    [{ date: '2026-09-30 10:05', complete: true }],
    [{ date: '2026-09-30 10:05', complete: false }, { date: '2026-09-30 10:10', complete: false }],
  ]) {
    const h = harness({ minuteRows: { '5': [...fives(), ...tail], '30': thirties() },
      values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
    await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...h }), /异常未来K线/);
  }
});

test('even an omitted future candle must be a valid aligned market timestamp', async () => {
  const tail = { date: '2026-09-30 10:03', complete: false };
  const h = harness({ minuteRows: { '5': [...fives(), tail], '30': thirties() },
    values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...h }), /时间无效/);
});

test('different identity, unsupported adjustment, wrong minute basis and invalid daily basis fail explicitly', async () => {
  const h = harness();
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code: '000001', adjust: '1', ...h }), /标的与代码/);
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '2', ...h }), /复权口径/);
  const wrong = harness({ values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
  wrong.loadMinute = async ({ period }) => result(period, fives(), 'sh000001');
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...wrong }), /标的或数据/);
  const wrongBasis = harness({ values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
  wrongBasis.loadMinute = async ({ period }) => result(period, period === '5' ? fives() : thirties(), symbol, 'qfq: corporate actions');
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...wrongBasis }), /不复权基底/);
  const badDaily = harness({ dailyLoader: () => daily('qfqday', qfqDays, 'sh000001') });
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '1', ...badDaily }), /日K标的或数据/);
  const duplicateDaily = harness({ dailyLoader: url => url.includes('/fqkline/')
    ? daily('qfqday', [...qfqDays, qfqDays[0]]) : daily('day', rawDays) });
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '1', ...duplicateDaily }), /日期冲突/);
  const incompleteDaily = harness({ dailyLoader: url => url.includes('/fqkline/')
    ? daily('qfqday', qfqDays.slice(1)) : daily('day', rawDays) });
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '1', ...incompleteDaily }), /覆盖不足/);
});

test('missing, conflicting and unfinished intervals remain distinct and expose only real overlap coverage', async () => {
  const source = fives(); source.splice(2, 1);
  const h = harness({ minuteRows: { '5': source, '30': thirties() },
    values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] });
  const missing = await inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...h });
  assert.equal(missing.counts.missing, 1);
  assert.equal(missing.comparison.windows[0].reason, 'missing_5m_inside_observed_coverage');
  const conflict30 = thirties(); conflict30[0].volume++;
  const conflict = await inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...harness({ minuteRows: { '5': fives(), '30': conflict30 },
    values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] }) });
  assert.equal(conflict.counts.conflict, 1);
  assert.deepEqual(conflict.comparison.windows[0].differences.map(item => item.field), ['volume']);
  const unfinished = thirties(); unfinished[0].complete = false;
  const pending = await inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...harness({ minuteRows: { '5': fives(), '30': unfinished },
    values: ['2026-09-30 10:00', '2026-09-30 10:01', '2026-09-30 10:02', '2026-09-30 10:03'] }) });
  assert.equal(pending.counts.unconfirmed, 1);
});

test('a regressing local clock fails instead of inventing observation times', async () => {
  const h = harness({ values: ['2026-09-30 10:00', '2026-09-30 09:59', '2026-09-30 10:01'] });
  await assert.rejects(inspectLiveCrossPeriod({ symbol, code, adjust: '0', ...h }), /时钟回退/);
});

test('minute responses may finish in either order without swapping their actual local receipt times', async () => {
  let current = at('2026-09-30 10:00');
  let resolveFive, resolveThirty;
  const loadMinute = ({ period, now }) => {
    assert.equal(now, at('2026-09-30 10:00'));
    return new Promise(resolve => { if (period === '5') resolveFive = resolve; else resolveThirty = resolve; });
  };
  const pending = inspectLiveCrossPeriod({ symbol, code, adjust: '0', loadMinute,
    loadJson: async () => { throw new Error('unadjusted must not load daily'); }, now: () => current });
  current = at('2026-09-30 10:01');
  resolveThirty(result('30', thirties()));
  await new Promise(resolve => setImmediate(resolve));
  current = at('2026-09-30 10:05');
  resolveFive(result('5', fives()));
  const data = await pending;
  assert.equal(data.snapshots.thirty, at('2026-09-30 10:01') / 1000);
  assert.equal(data.snapshots.five, at('2026-09-30 10:05') / 1000);
  assert.equal(data.comparison.windows[0].observedAt, data.snapshots.five);
});

test('the actual minute loader and shared daily transform cooperate on the same input', async () => {
  const quote = []; quote[30] = '20260929100100';
  const calls = [];
  const loadJson = async url => {
    calls.push(url);
    if (url.includes('/fqkline/')) return daily('qfqday', qfqDays);
    if (url.includes('/kline/kline')) return daily('day', rawDays);
    const period = new URL(url).searchParams.get('param').split(',')[1];
    const rows = period === 'm5' ? fives() : thirties();
    const bars = rows.map(row => [row.date.replace(/[- :]/g, ''), row.open, row.close, row.high, row.low, row.volume]);
    return { code: 0, data: { [symbol]: { [period]: bars, qt: { [symbol]: quote } } } };
  };
  const h = harness();
  const data = await inspectLiveCrossPeriod({ symbol, code, adjust: '1', loadJson, now: h.now });
  assert.equal(data.comparison.windows[0].status, 'complete');
  assert.equal(data.rows.five[0].open, 9);
  assert.equal(data.rows.thirty[0].open, 9);
  assert.equal(calls.filter(url => url.includes('/kline/mkline')).length, 2);
  assert.equal(calls.filter(url => url.includes('/kline/kline')).length, 1);
  assert.equal(calls.filter(url => url.includes('/fqkline/get')).length, 1);
});
