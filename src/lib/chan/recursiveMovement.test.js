import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrendCompletion } from './recursiveMovement.js';

// Synthetic structural events, not independently verified market movements.
const center = (id, sdt, edt, zd, zg, dd, gg, confirmed_time) => ({
  id, kind: 'center', basis: 'example', level: 2, status: 'confirmed',
  sdt, edt, zd, zg, dd, gg, confirmed_time,
});
const trend = () => ({
  basis: 'example', level: 2, direction: 'up', decomposition: 'same_level',
  centers: [center('A', 1, 8, 4, 6, 3, 7, 10), center('B', 11, 20, 10, 12, 9, 13, 22)],
});
const divergence = (level = 1) => ({
  id: 'div-1', kind: 'trend_divergence', basis: 'example', level, status: 'confirmed', side: 'top',
  point: { time: 30, price: 15 }, confirmed_time: 32,
});
const successor = () => center('C', 31, 38, 14, 16, 12.5, 17, 40);
const sameLevelExclusion = () => ({ id: 'excl-1', kind: 'same_level_divergence_excluded',
  basis: 'example', level: 2, status: 'confirmed', confirmed_time: 35 });
const thirdPoint = () => ({ id: 'third-1', kind: 'third_class_retest', side: 'buy', basis: 'example', level: 2,
  status: 'confirmed', center_id: 'B', point: { time: 28, price: 12.5 }, confirmed_time: 29 });
const input = (extra = {}) => ({ trend: trend(), divergence: divergence(),
  sameLevelDivergenceExclusion: sameLevelExclusion(), thirdPoint: thirdPoint(), asOfTime: 40, ...extra });

test('same-level proven trend divergence gives a conditional retrospective boundary', () => {
  const result = evaluateTrendCompletion(input({ divergence: divergence(2), asOfTime: 32 }));
  assert.equal(result.status, 'conditional_completed');
  assert.deepEqual(result.boundary, { time: 30, price: 15, observed_at: 32 });
  assert.equal(result.evidence_proof, 'caller_supplied');
  assert.deepEqual(result.evidence, { trend_center_ids: ['A', 'B'], divergence_id: 'div-1', third_point_id: 'third-1' });
});

test('lower-level divergence requires a later center and does not leak future confirmation', () => {
  assert.deepEqual(evaluateTrendCompletion(input({ asOfTime: 31, nextCenter: successor() })),
    { status: 'pending', reason: 'divergence_not_observed' });
  assert.deepEqual(evaluateTrendCompletion(input({ asOfTime: 39, nextCenter: successor() })),
    { status: 'pending', reason: 'next_center_not_observed' });
  assert.deepEqual(evaluateTrendCompletion(input()), { status: 'pending', reason: 'next_center_missing' });
  const result = evaluateTrendCompletion(input({ nextCenter: successor() }));
  assert.equal(result.status, 'conditional_completed');
  assert.equal(result.reason, 'lower_divergence_followed_by_overlapping_center');
  assert.deepEqual(result.boundary, { time: 30, price: 15, observed_at: 40 });
  assert.equal(result.evidence_proof, 'caller_supplied');
  assert.deepEqual(result.evidence, { trend_center_ids: ['A', 'B'], divergence_id: 'div-1',
    third_point_id: 'third-1', exclusion_id: 'excl-1', next_center_id: 'C' });
});

test('peripheral intervals, not just cores, determine the geometric comparison', () => {
  const c = successor(); // Core 14..16 does not intersect B 10..12; outer ranges overlap.
  assert.equal(evaluateTrendCompletion(input({ nextCenter: c })).status, 'conditional_completed');
  assert.equal(evaluateTrendCompletion(input({ nextCenter: { ...c, dd: 14 } })).status, 'conditional_continuation');
  assert.equal(evaluateTrendCompletion(input({ nextCenter: { ...c, dd: 13 } })).status, 'conditional_completed');
  assert.equal(evaluateTrendCompletion(input({ nextCenter: { ...c, dd: 13 } })).boundary_policy,
    'peripheral_touch_counts_as_overlap');
});

test('overlapping cores could be extension, so the distinct-center example cannot resolve them', () => {
  const c = center('C', 31, 38, 11, 14, 10, 15, 40);
  assert.deepEqual(evaluateTrendCompletion(input({ nextCenter: c })),
    { status: 'indeterminate', reason: 'cores_overlap_or_touch_not_covered' });
  assert.deepEqual(evaluateTrendCompletion(input({ nextCenter: { ...c, zd: 12 } })),
    { status: 'indeterminate', reason: 'cores_overlap_or_touch_not_covered' });
});

test('mirror downward example and unsupported opposite-side separation', () => {
  const downward = {
    basis: 'example', level: 2, direction: 'down', decomposition: 'same_level',
    centers: [center('A', 1, 8, 20, 22, 19, 23, 10), center('B', 11, 20, 10, 12, 9, 13, 22)],
  };
  const d = { ...divergence(), side: 'bottom', point: { time: 30, price: 6 } };
  const third = { ...thirdPoint(), side: 'sell', point: { time: 28, price: 9.5 } };
  const c = center('C', 31, 38, 5, 7, 4, 9.5, 40);
  assert.equal(evaluateTrendCompletion(input({ trend: downward, divergence: d, thirdPoint: third, nextCenter: c })).status,
    'conditional_completed');
  assert.equal(evaluateTrendCompletion(input({ trend: downward, divergence: d, thirdPoint: third, nextCenter: { ...c, gg: 8 } })).status,
    'conditional_continuation');
  assert.deepEqual(evaluateTrendCompletion(input({ nextCenter: center('C', 31, 38, 3, 5, 2, 6, 40) })),
    { status: 'indeterminate', reason: 'opposite_side_separation_not_covered' });
});

test('incomplete caller evidence cannot confirm a movement', () => {
  assert.equal(evaluateTrendCompletion(input({ divergence: { ...divergence(2), status: 'pending' } })).status, 'pending');
  assert.equal(evaluateTrendCompletion(input({ nextCenter: { ...successor(), status: 'pending' } })).status, 'pending');
  assert.equal(evaluateTrendCompletion(input({ trend: { ...trend(), centers: [trend().centers[0]] } })).status,
    'indeterminate');
});

test('reject unrelated level, wrong basis, false trend, and causally impossible evidence', () => {
  assert.throws(() => evaluateTrendCompletion(input({ divergence: { ...divergence(), basis: 'other' } })), /basis/);
  assert.throws(() => evaluateTrendCompletion(input({ divergence: { ...divergence(), level: 3 } })), /level/);
  assert.throws(() => evaluateTrendCompletion(input({ divergence: { ...divergence(), side: 'bottom' } })), /side/);
  assert.throws(() => evaluateTrendCompletion(input({ divergence: { ...divergence(), confirmed_time: 29 } })), /time/);
  const overlap = { ...trend(), centers: [trend().centers[0], { ...trend().centers[1], dd: 7 }] };
  assert.equal(evaluateTrendCompletion(input({ trend: overlap, divergence: divergence(2) })).status, 'indeterminate');
  assert.throws(() => evaluateTrendCompletion(input({ nextCenter: { ...successor(), sdt: 29 } })), /time/);
});

test('an unobserved future center cannot trigger an error or expose its content', () => {
  const c = { ...successor(), zd: NaN, gg: NaN, basis: 'future-invalid' };
  assert.deepEqual(evaluateTrendCompletion(input({ asOfTime: 39, nextCenter: c })),
    { status: 'pending', reason: 'next_center_not_observed' });
});

test('trend divergence point must exceed the last center peripheral extreme', () => {
  for (const price of [11, 12.5, 13]) {
    const d = { ...divergence(2), point: { time: 30, price } };
    assert.deepEqual(evaluateTrendCompletion(input({ divergence: d })),
      { status: 'indeterminate', reason: 'divergence_point_not_beyond_last_center_extreme' });
  }
});

test('decomposition view and exclusion of same-level divergence are explicit prerequisites', () => {
  assert.deepEqual(evaluateTrendCompletion(input({ trend: { ...trend(), decomposition: undefined } })),
    { status: 'indeterminate', reason: 'same_level_decomposition_required' });
  assert.deepEqual(evaluateTrendCompletion(input({ trend: { ...trend(), decomposition: 'center_expansion' } })),
    { status: 'indeterminate', reason: 'same_level_decomposition_required' });
  assert.deepEqual(evaluateTrendCompletion(input({ sameLevelDivergenceExclusion: undefined, nextCenter: successor() })),
    { status: 'indeterminate', reason: 'same_level_divergence_not_excluded' });
  assert.deepEqual(evaluateTrendCompletion(input({ sameLevelDivergenceExclusion: { ...sameLevelExclusion(), confirmed_time: 41 },
    nextCenter: successor() })), { status: 'pending', reason: 'same_level_divergence_exclusion_not_observed' });
});

test('a caller-declared third-class retest of the last center is required', () => {
  assert.deepEqual(evaluateTrendCompletion(input({ thirdPoint: undefined, divergence: divergence(2) })),
    { status: 'indeterminate', reason: 'third_class_retest_missing' });
  assert.deepEqual(evaluateTrendCompletion(input({ thirdPoint: { ...thirdPoint(), point: { time: 28, price: 12 } },
    divergence: divergence(2) })), { status: 'indeterminate', reason: 'third_class_retest_not_strictly_outside' });
  assert.throws(() => evaluateTrendCompletion(input({ thirdPoint: { ...thirdPoint(), side: 'sell' } })), /side/);
  assert.throws(() => evaluateTrendCompletion(input({ thirdPoint: { ...thirdPoint(), center_id: 'A' } })), /center/);
  assert.throws(() => evaluateTrendCompletion(input({ thirdPoint: { ...thirdPoint(), point: { time: 31, price: 12.5 },
    confirmed_time: 32 } })), /time/);
});

test('claimed divergence extreme must be beyond the earlier third-class retest in both directions', () => {
  // Lesson 37 requires the trend's final leg to make a new high / low. A later
  // top at 15 is not a new high when the earlier retest was already 15 or 16.
  for (const price of [15, 16]) for (const level of [1, 2]) {
    const third = { ...thirdPoint(), point: { time: 28, price } };
    assert.deepEqual(evaluateTrendCompletion(input({ divergence: divergence(level), thirdPoint: third,
      nextCenter: successor() })), { status: 'indeterminate', reason: 'divergence_point_not_beyond_third_retest' });
  }
  const down = { basis: 'example', level: 2, direction: 'down', decomposition: 'same_level',
    centers: [center('A', 1, 8, 20, 22, 19, 23, 10), center('B', 11, 20, 10, 12, 9, 13, 22)] };
  const low = { ...divergence(), side: 'bottom', point: { time: 30, price: 6 } };
  for (const price of [5, 6]) for (const level of [1, 2]) {
    const third = { ...thirdPoint(), side: 'sell', point: { time: 28, price } };
    assert.deepEqual(evaluateTrendCompletion(input({ trend: down, divergence: { ...low, level }, thirdPoint: third,
      nextCenter: center('C', 31, 38, 5, 7, 4, 9.5, 40) })),
    { status: 'indeterminate', reason: 'divergence_point_not_beyond_third_retest' });
  }
});

test('result exposes only the boundary coordinates, never caller-added future fields', () => {
  const d = { ...divergence(2), point: { time: 30, price: 15, future_value: 'not observed' } };
  assert.deepEqual(evaluateTrendCompletion(input({ divergence: d })).boundary,
    { time: 30, price: 15, observed_at: 32 });
});
