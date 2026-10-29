import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';
import { buildPenCenters } from './penCenters.js';

function sample(prices) {
  const candles = prices.map((price, i) => ({ time: i + 1, high: price, low: price, complete: true }));
  const points = prices.map((price, i) => ({ time: i + 1, idx: i, price,
    mark: i % 2 ? 'G' : 'D', confirmed: i < prices.length - 1,
    confirmed_time: i < prices.length - 1 ? i + 2 : null }));
  return { candles, points };
}

test('three completed connected pens form a fixed core, later overlap extends it', () => {
  const { candles, points } = sample([0, 10, 4, 12, 8, 13]);
  assert.equal(buildPenCenters(points.slice(0, 3), candles).zones.length, 0);
  const formed = buildPenCenters(points.slice(0, 4), candles).zones[0];
  const extended = buildPenCenters(points, candles).zones[0];
  assert.deepEqual([formed.zd, formed.zg, formed.confirmed_time], [4, 10, 4]);
  assert.deepEqual([extended.zd, extended.zg], [4, 10]);
  assert.ok(extended.pen_count > formed.pen_count);
  assert.equal('thirdSignal' in extended, false, 'reference pen centers never supply trading signals');
});

test('endpoint K ordering that changes the boundary is not presented as an exact center', () => {
  const { candles, points } = sample([0, 10, 4, 12]);
  candles[1].high = 12;
  const result = buildPenCenters(points, candles);
  assert.equal(result.zones.length, 0);
  assert.equal(result.uncertainties[0].reason, 'endpoint_order');
});

test('an unconfirmed final pen cannot create a center', () => {
  const { candles, points } = sample([0, 10, 4, 12]);
  points[2].confirmed = false;
  points[2].confirmed_time = null;
  assert.deepEqual(buildPenCenters(points, candles).zones, []);
  points[2].confirmed = true;
  points[2].confirmed_time = candles.length + 1;
  assert.deepEqual(buildPenCenters(points, candles).zones, [], 'future evidence is not yet observable');
});

test('saved 600851 daily history produces a separately labelled pen-level reference', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const result = analyzeChan(rows, 'day');
  const candles = rows.map((row, i) => ({ ...row, time: i + 1 }));
  const references = buildPenCenters(result.bi, candles).zones;
  assert.deepEqual(result.penZs, references, 'the production entrypoint exposes the same independent reference');
  const latest = references.at(-1);
  assert.equal(rows[latest.sdt - 1].date, '2025-12-31');
  assert.equal(rows[latest.edt - 1].date, '2026-09-21');
  assert.deepEqual([latest.zd, latest.zg], [7.55, 8.91]);
  assert.equal(latest.pen_count, 11);
  assert.equal(result.zs.length, 0, 'the reference is distinct from confirmed segment centers');
});
