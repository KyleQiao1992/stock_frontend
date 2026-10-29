import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRecursiveSource } from './recursiveSource.js';
import { formCenterFromMoves } from './recursiveCenter.js';

const metadata = { provider: 'tencent', symbol: 'sh600851', period: '5m', adjustment: 'qfq' };
const rows = () => [
  { date: '2026-10-27 09:35', open: 8, high: 9, low: 7, close: 8.5, volume: 10 },
  { date: '2026-10-27 09:40', open: 8.5, high: 10, low: 8, close: 9, volume: 20, complete: true },
  { date: '2026-10-27 09:45', open: 9, high: 9.5, low: 8.5, close: 9, volume: 30, complete: false },
];

test('the source preserves date and completion with one-based coordinates and explicit provenance', () => {
  const result = prepareRecursiveSource(rows(), metadata);
  assert.equal(result.bars.length, 3);
  assert.deepEqual(result.bars.map(({ time, date, complete }) => ({ time, date, complete })), [
    { time: 1, date: '2026-10-27 09:35', complete: undefined },
    { time: 2, date: '2026-10-27 09:40', complete: true },
    { time: 3, date: '2026-10-27 09:45', complete: false },
  ]);
  assert.equal(result.basis, JSON.stringify(['tencent', 'sh600851', '5m', 'qfq', '2026-10-27 09:35']));
  assert.deepEqual(result.coverage, { start: '2026-10-27 09:35', end: '2026-10-27 09:45',
    continuity: 'not_verified', history_before_start: 'not_verified' });
  assert.notEqual(result.basis, prepareRecursiveSource(rows(), { ...metadata, adjustment: 'none' }).basis);
});

test('bad or missing provenance cannot silently share a data basis', () => {
  for (const key of Object.keys(metadata)) {
    assert.throws(() => prepareRecursiveSource(rows(), { ...metadata, [key]: '' }), /provenance/);
  }
  assert.throws(() => prepareRecursiveSource(rows()), /provenance/);
});

test('different history origins do not reuse ordinal coordinates under the same source basis', () => {
  const full = prepareRecursiveSource(rows(), metadata);
  const truncated = prepareRecursiveSource(rows().slice(1), metadata);
  // Both histories call their first bar time=1, but those bars are on
  // different dates. Treating the bases as equal can associate an existing
  // movement or center with a different candle after history is truncated.
  assert.notEqual(full.basis, truncated.basis);
  const later = prepareRecursiveSource([...rows(),
    { date: '2026-10-27 09:50', open: 9, high: 10, low: 8, close: 9 },
  ], metadata);
  assert.equal(full.basis, later.basis, 'appending bars preserves the existing coordinate origin');
});

test('a movement triple cannot be reused against another history origin', () => {
  const prices = [0, 10, 4, 8];
  const makeRows = startDay => prices.map((price, index) => ({
    date: `2026-10-${String(startDay + index).padStart(2, '0')}`,
    open: price, high: price, low: price, close: price, complete: true,
  }));
  const original = prepareRecursiveSource(makeRows(1), { ...metadata, period: 'day' });
  const other = prepareRecursiveSource(makeRows(11), { ...metadata, period: 'day' });
  const moves = prices.slice(0, -1).map((price, index) => ({
    kind: 'movement', id: `m${index}`, basis: original.basis, level: 1,
    type: index === 1 ? 'down' : 'up', status: 'confirmed', confirmed_time: 4,
    start: { time: index + 1, price }, end: { time: index + 2, price: prices[index + 1] },
    low: Math.min(price, prices[index + 1]), high: Math.max(price, prices[index + 1]),
  }));
  assert.equal(formCenterFromMoves(moves, { targetLevel: 2, asOfTime: 4, source: original }).status, 'conditional');
  assert.throws(() => formCenterFromMoves(moves, { targetLevel: 2, asOfTime: 4, source: other }), /basis/);
});

test('duplicate, out-of-order, invalid or mixed timestamp granularity is rejected', () => {
  for (const dates of [
    ['2026-10-27 09:35', '2026-10-27 09:35', '2026-10-27 09:45'],
    ['2026-10-27 09:35', '2026-10-27 09:45', '2026-10-27 09:40'],
    ['2026-02-30 09:35', '2026-10-27 09:40', '2026-10-27 09:45'],
    ['2026-10-27', '2026-10-27 09:40', '2026-10-27 09:45'],
  ]) {
    const input = rows().map((bar, index) => ({ ...bar, date: dates[index] }));
    assert.throws(() => prepareRecursiveSource(input, metadata), /date|time/i);
  }
});

test('invalid raw OHLC or completion state is rejected rather than filtered into a false continuous sequence', () => {
  for (const change of [
    b => { b.high = NaN; }, b => { b.low = 11; }, b => { b.open = 11; },
    b => { b.close = 1; }, b => { b.complete = 'false'; },
  ]) {
    const input = rows(); change(input[1]);
    assert.throws(() => prepareRecursiveSource(input, metadata), /price|completion/i);
  }
  assert.throws(() => prepareRecursiveSource([], metadata), /empty/i);
});

test('daily source dates are accepted without treating missing exchange sessions as verified history', () => {
  const daily = rows().map((bar, index) => ({ ...bar, date: ['2026-10-22', '2026-10-23', '2026-10-27'][index] }));
  const result = prepareRecursiveSource(daily, { ...metadata, period: 'day' });
  assert.equal(result.bars[2].date, '2026-10-27');
  assert.equal(result.coverage.continuity, 'not_verified');
});
