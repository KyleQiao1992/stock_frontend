import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZs, compareCenterGeometry } from './zs.js';

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

test('downward departure is symmetric; a boundary touch extends and a strict outside return closes', () => {
  // This lowest-layer version keeps a touching interval in extension (lesson
  // 20's Z-interval rule). It does not equate 不升破 with a confirmed trade.
  const [touching] = buildZs(segments([20, 10, 16, 8, 10]));
  assert.equal(touching.status, 'active');
  assert.equal(touching.thirdSignal, null);
  const [zone] = buildZs(segments([20, 10, 16, 8, 9]));
  assert.equal(zone.thirdSignal.kind, 'down_departure_retest');
  assert.equal(zone.thirdSignal.price, 9);
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

test('new centers may reuse the leaving segment, retaining each earliest confirmed triple', () => {
  const zones = buildZs(segments([0, 10, 4, 12, 11, 16, 13, 18, 14]));
  // The old implementation skipped 4→12 and lost the [11,12] core formed by
  // [4,12], [11,12], [11,16]. Reuse is the declared sequential geometry policy.
  assert.equal(zones.length, 3);
  assert.deepEqual(zones.map(z => [z.startIndex, z.zd, z.zg]), [[0, 4, 10], [2, 11, 12], [4, 13, 16]]);
  assert.equal(zones[1].startIndex, zones[0].endIndex);
  assert.ok(zones[1].confirmed_time >= zones[0].closed_time);
  // 核心虽分离，外围在本版几何中重叠；复用离开段使其不能独立证明升级。
  assert.equal(zones[1].relation, 'overlapping_fluctuations');
  assert.equal(zones[1].requires_recursive_level, null);
  assert.equal(zones[1].relation_evidence.departure_reused, true);
});

test('overlap with a reused departure is not independent evidence of level expansion', () => {
  const zones = buildZs(segments([0, 10, 4, 12, 11, 16, 13]));
  const current = zones[1];
  assert.equal(current.relation, 'overlapping_fluctuations');
  assert.equal(current.requires_recursive_level, null);
  assert.deepEqual(current.relation_evidence.shared_z_segment_ids, ['seg-2']);
  assert.equal(current.relation_evidence.departure_reused, true);
  assert.equal(current.relation_evidence.movement_classification, 'not_verified');
  assert.equal(current.relation_evidence.history_coverage, 'not_verified');
  assert.equal(current.relation_evidence.recursive_level, 'not_computed');
});

test('reused departure remains uncertain when it is not one of the previous Z segments', () => {
  const zones = buildZs(segments([10, 20, 14, 18, 5, 8, 2]));
  assert.equal(zones.length, 2);
  assert.equal(zones[1].relation, 'overlapping_fluctuations');
  assert.deepEqual(zones[1].relation_evidence.shared_z_segment_ids, []);
  assert.equal(zones[1].relation_evidence.departure_reused, true);
  assert.equal(zones[1].requires_recursive_level, null);
});

test('nonshared overlap is a reason to investigate higher levels, while separated ranges are geometry only', () => {
  const zone = (id, dd, gg, zids) => ({ id, dd, gg, z_segment_ids: zids });
  const prior = zone('a', 0, 10, ['a1', 'a2']);
  const overlap = compareCenterGeometry(prior, zone('b', 9, 15, ['b1', 'b2']));
  assert.equal(overlap.relation, 'overlapping_fluctuations');
  assert.equal(overlap.requires_recursive_level, true);
  assert.deepEqual(overlap.relation_evidence.shared_z_segment_ids, []);
  assert.equal(overlap.relation_evidence.recursive_level, 'not_computed');
  const up = compareCenterGeometry(prior, zone('c', 11, 15, ['c1', 'c2']));
  assert.equal(up.relation, 'up_separated');
  assert.equal(up.requires_recursive_level, false);
  assert.equal(up.relation_evidence.movement_classification, 'not_verified');
  const down = compareCenterGeometry(zone('x', 15, 20, ['x1']), prior);
  assert.equal(down.relation, 'down_separated');
  assert.equal(down.relation_evidence.recursive_level, 'not_computed');
  const uncertain = compareCenterGeometry(prior, zone('u', null, 15, ['u1']));
  assert.equal(uncertain.relation, 'uncertain');
  assert.equal(uncertain.requires_recursive_level, null);
});

test('zero-width triple intersection is not a center', () => {
  assert.deepEqual(buildZs(segments([0, 10, 10, 12])), []);
});
