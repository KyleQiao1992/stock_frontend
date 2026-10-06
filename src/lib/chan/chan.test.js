import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan, visibleOffset } from './index.js';
import { buildBi, isStrictBi } from './bi.js';
import { mergeCandles } from './fractal.js';
import { buildSegments } from './segment.js';
import { buildZs } from './zs.js';

const rows = Array.from({ length: 420 }, (_, i) => {
  const close = 100 + 15 * Math.sin(i / 9) + 3 * Math.sin(i / 2);
  return { date: `bar-${i}`, open: close - 0.5, close, high: close + 2, low: close - 2, volume: 1000 };
});
const targets = [2, 0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12, 5, 9, 3, 8, 2, 7, 4, 10];
const fixturePrices = targets.flatMap((price, i) => i
  ? Array.from({ length: 8 }, (_, j) => targets[i - 1] + (price - targets[i - 1]) * (j + 1) / 8)
  : [price]);
const structureRows = fixturePrices.map((price, i) => ({ date: `fixture-${i}`, open: 100 + price,
  close: 100 + price, high: 100.2 + price, low: 99.8 + price, volume: 1000 }));

test('empty and insufficient histories cannot invent confirmed structures', () => {
  for (const input of [[], rows.slice(0, 2)]) {
    const result = analyzeChan(input);
    for (const key of ['bi', 'segments', 'zs', 'trades']) assert.deepEqual(result[key], []);
    assert.equal(result.outlook.ok, false);
  }
});

test('loaded history is not cut at 300 bars and viewport preserves original endpoints', () => {
  const result = analyzeChan(rows);
  assert.equal(result.dates.length, 420);
  assert.equal(result.dates[0], rows[0].date);
  assert.ok(result.bi.length > 2);
  const offset30 = visibleOffset(result, rows.slice(-30));
  const offset240 = visibleOffset(result, rows.slice(-240));
  assert.equal(offset30, 390);
  assert.equal(offset240, 180);
  assert.equal(visibleOffset(result, []), -1);
  const point = result.bi[0];
  assert.ok(point.time - 1 - offset30 < 0);
  assert.equal((point.time - 1 - offset240) - (point.time - 1 - offset30), 210);
});

test('pipeline uses strictly valid strokes and removes the mutable last endpoint from completed structures', () => {
  const result = analyzeChan(rows);
  const candles = rows.map((row, i) => ({ ...row, time: i + 1 }));
  const merged = mergeCandles(candles);
  const candidates = buildBi(result.fx, { merged });
  assert.deepEqual(result.bi, candidates.slice(0, -1));
  assert.equal(candidates.at(-1).confirmed, false);
  for (let i = 1; i < result.bi.length; i++) {
    assert.equal(isStrictBi(result.bi[i - 1], result.bi[i], merged), true);
    assert.equal(result.bi[i].confirmed, true);
  }
  assert.deepEqual(result.segments, buildSegments(result.bi).segments);
  assert.deepEqual(result.zs, buildZs(result.segments));
  assert.deepEqual(buildZs(result.bi), []);
});

test('candidate stroke draws its directional true extreme rather than the final close', () => {
  const result = analyzeChan(rows);
  const [anchor, end] = result.pending;
  const interval = rows.slice(anchor.idx + 1);
  const expected = anchor.mark === 'D' ? Math.max(...interval.map((r) => r.high))
    : Math.min(...interval.map((r) => r.low));
  assert.equal(end.price, expected);
  assert.equal(end.price, end.mark === 'G' ? rows[end.idx].high : rows[end.idx].low);
  assert.notEqual(end.price, rows.at(-1).close);
  assert.equal(end.confirmed, false);
  assert.equal(result.trades.some((item) => item.time_str === rows[end.idx].date), false);
});

test('chart, structural outlook, source dates and endpoint list use identical completed data', () => {
  const result = analyzeChan(structureRows, '102');
  assert.ok(result.segments.length >= 3);
  assert.ok(result.zs.length > 0);
  assert.equal(result.outlook.period, '102');
  assert.equal(result.outlook.asof, structureRows.at(-1).date);
  assert.equal(result.trades.length, result.bi.length);
  for (let i = 0; i < result.bi.length; i++) {
    const point = result.bi[i];
    const trade = result.trades[result.trades.length - 1 - i];
    assert.equal(trade.time_str, result.dates[point.time - 1]);
    assert.equal(trade.price, point.price);
  }
  const lastTwo = result.bi.slice(-2);
  assert.equal(result.outlook.levels.last_bi_high, Math.max(...lastTwo.map((p) => p.price)));
  assert.equal(result.outlook.levels.last_bi_low, Math.min(...lastTwo.map((p) => p.price)));
  const zone = result.zs.at(-1);
  assert.equal(result.outlook.levels.active_zs_id, zone.id);
  assert.equal(result.outlook.levels.zs_zg, zone.zg);
  assert.equal(result.outlook.levels.zs_zd, zone.zd);
  assert.equal(result.outlook.levels.zs_zg_bar.split(' @ ')[0], result.dates[zone.zg_time - 1]);
  assert.equal(result.outlook.levels.zs_zd_bar.split(' @ ')[0], result.dates[zone.zd_time - 1]);
  assert.equal(result.outlook.levels.completed_segment_count, result.segments.length);
  assert.equal(result.outlook.conclusion.confirmed_signal, null);
  assert.deepEqual(result.outlook.scenarios, []);
});
