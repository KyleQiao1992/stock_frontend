import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan } from './index.js';
import { buildZs, buildZsDetailed } from './zs.js';
import { zoneLifecycleRows, zoneLifecycleAmbiguousEndpointsRows } from './fixtures/zoneLifecycle.js';

function segments(prices) {
  return prices.slice(1).map((price, index) => {
    const start = { time: index + 1, price: prices[index] };
    const end = { time: index + 2, price };
    const high = Math.max(start.price, end.price), low = Math.min(start.price, end.price);
    return { id: `seg-${index}`, start, end, confirmed: true,
      direction: end.price > start.price ? 'up' : 'down', high, low,
      high_time: start.price === high ? start.time : end.time,
      low_time: start.price === low ? start.time : end.time,
      confirmed_time: end.time + 3 };
  });
}

test('endpoint bar can make a zero-width contact look like a positive-width center', () => {
  const input = segments([0, 10, -5, 0]);
  // At the third segment's start, the same K has high 6 and low -5.
  // Its high can have occurred before or after the -5 endpoint.
  input[2] = { ...input[2],
    range_bounds: { high_min: 0, high_max: 6, low_min: -5, low_max: -5 } };
  const result = buildZsDetailed(input);
  assert.deepEqual(result.zones, []);
  assert.equal(result.uncertainties[0].kind, 'formation');
  assert.deepEqual(result.uncertainties[0].zg_bounds, [0, 6]);
});

test('an uncertain endpoint wick cannot establish a precise center boundary', () => {
  const rows = zoneLifecycleAmbiguousEndpointsRows(114);
  const result = analyzeChan(rows);
  assert.equal(result.zs.length, 0);
  assert.ok(result.zsUncertainty.length > 0);
  assert.equal(result.zsUncertainty[0].kind, 'formation');
  assert.ok(result.zsUncertainty[0].segments.some(s => s.range_bounds.low_min === 190));
});

test('an uncertain wick that cannot change either core boundary does not hide a center', () => {
  const rows = zoneLifecycleRows(114);
  rows[32].low = 190;
  const result = analyzeChan(rows);
  assert.deepEqual(result.zs.map(z => [z.zd, z.zg]), [[199.9, 212.1]]);
});

test('a fixed boundary cites an exact contributor instead of an uncertain tied high', () => {
  const input = segments([0, 8, 4, 12]);
  input[0] = { ...input[0], high: 10, high_time: 1.5, high_point: { time: 1.5, price: 10 },
    range_bounds: { high_min: 10, high_max: 12, low_min: 0, low_max: 0 } };
  input[1] = { ...input[1], high: 10, high_time: 2.5, high_point: { time: 2.5, price: 10 } };
  const [zone] = buildZs(input);
  assert.equal(zone.zg, 10);
  assert.equal(zone.zg_time, 2.5);
});

test('an ambiguous first retest cannot confirm that the existing center has ended', () => {
  const input = segments([0, 10, 4, 12, 11]);
  input[3] = { ...input[3], range_bounds: { high_min: 12, high_max: 12, low_min: 9, low_max: 11 } };
  const [zone] = buildZs(input);
  assert.equal(zone.status, 'uncertain');
  assert.equal(zone.closed_time, null);
  assert.equal(zone.thirdSignal, null);
});

test('retest uncertainty is mirrored and retains later unprocessed evidence', () => {
  for (const sign of [1, -1]) {
    const input = segments([0, 10, 4, 12, 11, 16].map(x => x * sign));
    input[3] = { ...input[3], range_bounds: sign === 1
      ? { high_min: 12, high_max: 12, low_min: 9, low_max: 11 }
      : { high_min: -11, high_max: -9, low_min: -12, low_max: -12 } };
    const result = buildZsDetailed(input);
    assert.equal(result.zones[0].status, 'uncertain');
    assert.equal(result.zones[0].closed_time, null);
    assert.equal(result.uncertainties[0].kind, 'lifecycle');
    assert.ok(result.uncertainties[0].unprocessed_segment_ids.includes(input[4].id));
  }
});

test('a definitely outside retest may close while its exact extreme is still unknown', () => {
  const input = segments([0, 10, 4, 12, 11]);
  input[3] = { ...input[3], range_bounds: { high_min: 12, high_max: 12, low_min: 10.5, low_max: 11 } };
  const [zone] = buildZs(input);
  assert.equal(zone.status, 'closed');
  assert.equal(zone.retest.price, null);
  assert.equal(zone.retest.time, null);
  assert.deepEqual(zone.retest.price_bounds, [10.5, 11]);
});
