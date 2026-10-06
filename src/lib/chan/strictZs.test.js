import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZs } from './zs.js';

function segments(prices) {
  const points = prices.map((price, index) => ({ time: index + 1, price, idx: index, mark: index % 2 ? 'G' : 'D' }));
  return points.slice(1).map((end, index) => {
    const start = points[index];
    const highPoint = start.price >= end.price ? start : end;
    const lowPoint = start.price <= end.price ? start : end;
    return {
      id: `seg-${index}`, start, end, confirmed: true,
      direction: end.price > start.price ? 'up' : 'down',
      high: highPoint.price, low: lowPoint.price,
      high_time: highPoint.time, low_time: lowPoint.time,
      high_point: highPoint, low_point: lowPoint, confirmed_time: end.time + 3,
    };
  });
}

test('stroke endpoints and pending segments do not form line-segment centers', () => {
  assert.deepEqual(buildZs([0, 10, 4, 12].map((price, index) => ({ price, time: index + 1 }))), []);
  const items = segments([0, 10, 4, 12]);
  items[2].confirmed = false;
  assert.deepEqual(buildZs(items), []);
});

test('first three completed segments fix the core and exact source times', () => {
  const result = buildZs(segments([0, 10, 4, 12, 5]));
  assert.equal(result.length, 1);
  assert.equal(result[0].zd, 4);
  assert.equal(result[0].zg, 10);
  assert.equal(result[0].zd_time, 3);
  assert.equal(result[0].zg_time, 2);
  assert.equal(result[0].segment_count, 4);
  assert.equal(result[0].level, 'segment');
  assert.equal(result[0].label, '线段中枢（本图最小级别）');
});

test('extension has no nine-stroke or nine-segment truncation and no overlapping sliding candidates', () => {
  const prices = [0, 10, 4, 12];
  for (let index = 0; index < 12; index++) prices.push(index % 2 ? 12 : 5);
  const zones = buildZs(segments(prices));
  assert.equal(zones.length, 1);
  assert.equal(zones[0].segment_count, 15);
  assert.equal(zones[0].zd, 4);
  assert.equal(zones[0].zg, 10);
  assert.equal(zones[0].edt, prices.length);
});

test('lesson 78 center uses actual interior extremes rather than endpoint range', () => {
  const items = segments([0, 10, 4, 12]);
  // 第一段的端点仍是 0 / 10，但内部曾到达 14，不能用端点 10 锁定上沿。
  items[0] = { ...items[0], high: 14, high_time: 1.5, high_point: { time: 1.5, price: 14 } };
  items[1] = { ...items[1], high: 13, high_time: 2.5, high_point: { time: 2.5, price: 13 } };
  const [zone] = buildZs(items);
  assert.equal(zone.zg, 12);
  assert.equal(zone.zg_time, 4);
  assert.equal(zone.range_high, 14);
});

test('a leaving segment by itself does not confirm a departure/retest structure', () => {
  const [zone] = buildZs(segments([0, 10, 4, 12, 5, 15]));
  assert.equal(zone.status, 'active');
  assert.equal(zone.phase, 'leaving');
  assert.equal(zone.thirdSignal, null);
});

test('third formation segment can also be the leaving segment; first completed retest is required', () => {
  const [zone] = buildZs(segments([0, 10, 4, 12, 11]));
  assert.equal(zone.status, 'closed');
  assert.equal(zone.thirdSignal.kind, 'up_departure_retest');
  assert.equal(zone.thirdSignal.time, 5);
  assert.equal(zone.thirdSignal.price, 11);
  assert.equal(zone.thirdSignal.confirmed_time, 8);
  assert.equal(zone.segment_count, 3);
  assert.equal(zone.thirdSignal.scope, 'segment_geometry');
});

test('leaving Z segment that still overlaps remains in the extension, without shrinking the core', () => {
  const [zone] = buildZs(segments([0, 10, 4, 12, 5, 15, 11]));
  assert.equal(zone.status, 'closed');
  assert.equal(zone.segment_count, 5);
  assert.equal(zone.edt, 6);
  assert.equal(zone.zg, 10);
  assert.equal(zone.zd, 4);
  assert.equal(zone.thirdSignal.kind, 'up_departure_retest');
});

test('downward departure and retest are symmetric, with border touch allowed by 不升破', () => {
  const [zone] = buildZs(segments([20, 10, 16, 8, 10]));
  assert.equal(zone.thirdSignal.kind, 'down_departure_retest');
  assert.equal(zone.thirdSignal.price, 10);
  assert.equal(zone.thirdSignal.time, 5);
});

test('a failed first retest extends the same center instead of confirming a later attempt retroactively', () => {
  const [zone] = buildZs(segments([0, 10, 4, 12, 8, 14, 9]));
  assert.equal(zone.status, 'active');
  assert.equal(zone.thirdSignal, null);
  assert.equal(zone.segment_count, 6);
  assert.equal(zone.zd, 4);
  assert.equal(zone.zg, 10);
});

test('new centers start after the old departure/retest and do not reuse its formation segments', () => {
  const zones = buildZs(segments([0, 10, 4, 12, 11, 16, 13, 18, 14]));
  assert.equal(zones.length, 2);
  assert.ok(zones[1].startIndex > zones[0].endIndex);
  assert.equal(zones[1].zd, 13);
  assert.equal(zones[1].zg, 16);
  // 核心虽分离，第二中枢外围波动仍触及前中枢外围，不能直接称上涨趋势（第20课）。
  assert.equal(zones[1].relation, 'overlapping_fluctuations');
  assert.equal(zones[1].requires_recursive_level, true);
});

test('zero-width triple intersection is not a center', () => {
  assert.deepEqual(buildZs(segments([0, 10, 10, 12])), []);
});
