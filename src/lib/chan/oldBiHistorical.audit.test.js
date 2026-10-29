import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';
import { mergeCandles, findFractals } from './fractal.js';
import { isStrictBi } from './bi.js';
import { retractionRows } from './fixtures/segmentGap.js';

// Tencent qfq 600851 daily snapshot through 2025-06-25. Price reflection is
// synthetic; it tests symmetry and is not another instrument's market data.
const source = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-old-bi-2025.json', import.meta.url)));
const transform = (sign) => source.map((r, i) => ({ ...r, time: i + 1,
  open: sign * r.open, close: sign * r.close,
  high: sign === 1 ? r.high : -r.low, low: sign === 1 ? r.low : -r.high }));

for (const sign of [1, -1]) {
  test(`600851 old pens cannot contain a processed K beyond an endpoint (sign ${sign})`, () => {
    const rows = transform(sign);
    const merged = mergeCandles(rows);
    const fractals = findFractals(rows, merged);
    const at = date => fractals.find(p => rows[p.time - 1].date === date);
    const start = at('2025-03-24'), firstTop = at('2025-04-03');
    const lower = at('2025-04-09'), laterTop = at('2025-06-09');
    assert.ok(start && firstTop && lower && laterTop, 'four pivots are processed-K fractals');
    assert.equal(isStrictBi(start, firstTop, merged), true);
    assert.equal(isStrictBi(firstTop, lower, merged), false, 'short reversal has no independent processed K');
    assert.equal(isStrictBi(start, laterTop, merged), false, 'the intermediate lower fractal exceeds the starting extreme');
    const actual = analyzeChan(rows, 'day').bi;
    const emitted = actual.some((p, i) => p.time === start.time && actual[i + 1]?.time === laterTop.time);
    assert.equal(emitted, false, 'an invalid 03-24 to 06-09 pen must not survive the complete replay');
  });

  test(`600851 multi-pen rollback is confirmed when the replacement pen becomes observable (sign ${sign})`, () => {
    const asOf = date => transform(sign).filter(row => row.date <= date);
    const finished = asOf('2025-06-12').map(row => ({ ...row, complete: true }));
    const explicit = analyzeChan(finished, 'day').bi;
    const start = explicit.find(p => finished[p.time - 1].date === '2025-01-13');
    const end = explicit.at(-1);
    assert.equal(finished[end.time - 1].date, '2025-06-09');
    assert.equal(start.confirmed, true);
    assert.equal(finished[start.confirmed_time - 1].date, '2025-06-12');
    const unknown = asOf('2025-06-12');
    assert.equal(analyzeChan(unknown, 'day').bi.find(p => unknown[p.time - 1].date === '2025-01-13').confirmed, false);
    const next = asOf('2025-06-13');
    const observed = analyzeChan(next, 'day').bi.find(p => next[p.time - 1].date === '2025-01-13');
    assert.equal(next[observed.confirmed_time - 1].date, '2025-06-13');
  });
}

test('seed 3 preserves an earlier valid pen while rejecting an intervening higher top', () => {
  // Synthetic stress case, not a stock price history. A later multi-pen
  // rollback must neither retain 118 -> 195 over the higher top at K131 nor
  // erase the existing earlier K2 and K39 turns merely to satisfy that rule.
  const rows = retractionRows(3).map((r, i) => ({ ...r, time: i + 1 }));
  const merged = mergeCandles(rows);
  const fractals = findFractals(rows, merged);
  const at = time => fractals.find(p => p.time === time);
  const first = at(2), low = at(39), top = at(118), higher = at(131), end = at(195);
  assert.ok(first && low && top && higher && end);
  assert.equal(isStrictBi(first, low, merged), true);
  assert.ok(higher.price > top.price);
  assert.equal(isStrictBi(top, end, merged), false);
  const actual = analyzeChan(rows, 'day').bi;
  assert.ok(actual.some(p => p.time === first.time) && actual.some(p => p.time === low.time),
    'the earlier 2 and 39 endpoints must remain');
  assert.equal(actual.some((p, i) => p.time === top.time && actual[i + 1]?.time === end.time), false,
    'the invalid 118 -> 195 pen must not survive');
});

test('HK 00700 saved daily capture also rejects pens with a more extreme interior fractal', () => {
  // Reference-site snapshot; adjustment and feed provenance are those of the
  // saved response, not independently authenticated by this regression.
  const capture = JSON.parse(readFileSync(new URL('./fixtures/reference/hk00700-day.json', import.meta.url)));
  const rows = capture.candles.map((bar, index) => ({ date: String(bar.time),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.vol, time: index + 1 }));
  const result = analyzeChan(rows, 'day');
  const merged = mergeCandles(rows);
  const fractals = findFractals(rows, merged);
  const at = time => fractals.find(p => p.time === time);
  assert.equal(at(9).mark, 'D');
  assert.ok(at(9).price < at(6).price);
  assert.equal(at(289).mark, 'G');
  assert.ok(at(289).price > at(272).price);
  assert.equal(result.bi.some((p, i) => p.time === 6 && result.bi[i + 1]?.time === 51), false);
  assert.equal(result.bi.some((p, i) => p.time === 272 && result.bi[i + 1]?.time === 297), false);
});
