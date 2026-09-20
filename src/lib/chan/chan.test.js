import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan, visibleOffset } from './index.js';
import { buildZs } from './zs.js';

const rows = Array.from({ length: 420 }, (_, i) => {
  const close = 100 + 15 * Math.sin(i / 9) + 3 * Math.sin(i / 2);
  return { date: `bar-${i}`, open: close - 0.5, close, high: close + 2, low: close - 2, volume: 1000 };
});

test('empty and insufficient histories have no structures', () => {
  for (const input of [[], rows.slice(0, 2)]) {
    const result = analyzeChan(input);
    assert.deepEqual(result.bi, []);
    assert.deepEqual(result.zs, []);
  }
});

test('calculation window is 300 bars; viewport preserves offscreen endpoints', () => {
  const result = analyzeChan(rows);
  assert.deepEqual(result, analyzeChan(rows.slice(-300)));
  assert.equal(result.dates.length, 300);
  assert.ok(result.bi.length > 2);
  const offset30 = visibleOffset(result, rows.slice(-30));
  const offset240 = visibleOffset(result, rows.slice(-240));
  assert.equal(offset30, 270);
  assert.equal(offset240, 60);
  const point = result.bi[0];
  assert.ok(point.time - 1 - offset30 < 0);
  assert.equal((point.time - 1 - offset240) - (point.time - 1 - offset30), 210);
});

test('central range remains fixed by its first three strokes', () => {
  const points = [0, 10, 4, 12, 5].map((price, i) => ({ price, time: i + 1 }));
  const zones = buildZs(points);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].zd, 4);
  assert.equal(zones[0].zg, 10);
  assert.equal(zones[0].bi_count, 4);
});

test('dynamic endpoint is excluded from central ranges', () => {
  const result = analyzeChan(rows);
  assert.deepEqual(result.zs, buildZs(result.bi));
  assert.equal(result.pending.length, 2);
  assert.equal(result.pending[1].time, 300);
  assert.equal(result.pending[1].price, rows.at(-1).close);
});

test('outlook and endpoint dates map to the same chart structures, excluding pending endpoint', () => {
  const result = analyzeChan(rows, '102');
  assert.equal(result.outlook.period, '102');
  assert.equal(result.outlook.asof, rows.at(-1).date);
  assert.equal(result.trades.length, result.bi.length);
  for (let i = 0; i < result.bi.length; i++) {
    const point = result.bi[i];
    const trade = result.trades[result.trades.length - 1 - i];
    assert.equal(trade.time_str, result.dates[point.time - 1]);
    assert.equal(trade.price, point.price);
  }
  const lastTwo = result.bi.slice(-2);
  assert.equal(result.outlook.levels.last_bi_high, Math.max(...lastTwo.map(p=>p.price)));
  assert.equal(result.outlook.levels.last_bi_low, Math.min(...lastTwo.map(p=>p.price)));
  assert.equal(result.outlook.levels.active_zs_id, result.zs.at(-1).id);
  assert.equal(result.outlook.levels.zs_zg, result.zs.at(-1).zg);
  assert.equal(result.outlook.levels.zs_zd, result.zs.at(-1).zd);
});
