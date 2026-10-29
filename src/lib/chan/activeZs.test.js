import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan } from './index.js';
import { zoneLifecycleRows, zoneLifecycleRawExtremesRows, zoneLifecycleAmbiguousRetestRows,
  zoneLifecycleLevels, ZONE_LIFECYCLE_CHECKPOINTS } from './fixtures/zoneLifecycle.js';

for (const sign of [1, -1]) test(`active center lifecycle ${sign}: confirmed segments, fixed core, departure and next core`, () => {
  const levels = zoneLifecycleLevels(sign);
  for (const expected of ZONE_LIFECYCLE_CHECKPOINTS) {
    const rows = zoneLifecycleRows(expected.bars, sign);
    const result = analyzeChan(rows);
    assert.equal(result.segments.length, expected.segments, `K${expected.bars}: segments`);
    assert.equal(result.zs.length, expected.zones, `K${expected.bars}: centers`);
    if (!expected.zones) {
      assert.match(result.outlook.conclusion.observation, /三个连续已确认线段/);
      assert.match(result.outlook.conclusion.invalidation, /未完成线段.*不能确认中枢/);
      continue;
    }
    const zone = result.zs[0];
    assert.equal(zone.id, levels.first.id);
    assert.equal(zone.zg, levels.first.zg);
    assert.equal(zone.zd, levels.first.zd);
    assert.equal(zone.segment_count, expected.members);
    assert.equal(zone.confirmed_time, levels.first.formedAt);
    assert.equal(zone.phase, expected.phase);
    assert.equal(zone.status, expected.status);
    assert.equal(zone.algorithm, 'confirmed_segment_sequence');
    assert.ok(zone.segment_ids.every(id => result.segments.some(s => s.id === id && s.confirmed)));
    assert.equal(result.outlook.levels.zs_status, result.zs.at(-1).status);
    assert.equal(result.outlook.levels.active_zs_id, result.zs.at(-1).id);
    assert.equal(result.outlook.conclusion.confirmed_signal, null);
    assert.doesNotMatch(JSON.stringify(result.outlook), /滑动笔重叠区/);
    if (expected.status === 'closed') {
      assert.equal(zone.closed_time, 378);
      assert.equal(zone.retest.price, levels.retest.extremePrice);
    }
    if (expected.zones === 2) {
      const next = result.zs[1];
      assert.equal(next.id, levels.next.id);
      assert.equal(next.zd, levels.next.zd);
      assert.equal(next.zg, levels.next.zg);
      assert.equal(next.confirmed_time, levels.next.formedAt);
      assert.equal(next.segment_ids[0], levels.departure.id);
      assert.equal(next.relation, 'overlapping_fluctuations');
      assert.equal(next.relation_evidence.departure_reused, true);
      assert.deepEqual(next.relation_evidence.shared_z_segment_ids, [levels.departure.id]);
      assert.equal(next.requires_recursive_level, null, 'reused evidence does not prove a higher structural level');
      assert.equal(next.relation_evidence.recursive_level, 'not_computed');
    }
  }
});

test('unclosed evidence K cannot create a center or backdate its confirmation', () => {
  const rows = zoneLifecycleRows(114);
  rows.at(-1).complete = false;
  assert.equal(analyzeChan(rows).zs.length, 0);
  delete rows.at(-1).complete;
  assert.equal(analyzeChan(rows).zs.length, 0);
  const next = [...rows, zoneLifecycleRows(115).at(-1)];
  assert.equal(analyzeChan(next).zs[0].confirmed_time, 115);
});

for (const sign of [1, -1]) test(`segment ranges include raw K extremes omitted by merged pen points (${sign})`, () => {
  const rows = zoneLifecycleRawExtremesRows(114, sign);
  assert.equal(analyzeChan(rows.slice(0, 113)).zs.length, 0);
  const result = analyzeChan(rows);
  assert.deepEqual(result.segments.map(s => [s.start.time, s.end.time]), [[9, 33], [33, 57], [57, 81]]);
  assert.deepEqual(result.segments.map(s => sign === 1 ? s.high : s.low), [sign === 1 ? 230 : 170, sign === 1 ? 230 : 170, sign === 1 ? 230 : 170]);
  assert.deepEqual(result.segments.map(s => sign === 1 ? s.high_time : s.low_time), [20, 35, 68]);
  const [zone] = result.zs;
  assert.deepEqual([zone.zd, zone.zg], sign === 1 ? [199.9, 230] : [170, 200.1]);
  assert.equal(sign === 1 ? zone.zg_time : zone.zd_time, 20);
  assert.equal(zone.confirmed_time, 114);
  assert.equal(zone.evidence.formation.confirmed_time, 114);
  assert.equal(zone.evidence.formation.segments[0][sign === 1 ? 'high_time' : 'low_time'], 20);
  assert.equal((sign === 1 ? result.outlook.levels.zs_zg_bar : result.outlook.levels.zs_zd_bar).split(' @ ')[0], rows[19].date);
});

test('an explicitly unclosed raw K in a segment prevents that segment and its center from being confirmed', () => {
  const rows = zoneLifecycleRows(114);
  rows[19].high = 230;
  rows[19].complete = false;
  const result = analyzeChan(rows);
  assert.equal(result.segments.length, 0);
  assert.equal(result.zs.length, 0);
  assert.equal(result.pendingSegments.length, 0);
});

for (const sign of [1, -1]) test(`a shared endpoint wick makes the first retest ambiguous (${sign})`, () => {
  const reference = analyzeChan(zoneLifecycleRows(378, sign));
  assert.equal(reference.zs[0].status, 'closed');
  const rows = zoneLifecycleAmbiguousRetestRows(378, sign);
  const result = analyzeChan(rows);
  assert.equal(result.segments.length, 14);
  assert.equal(result.zs.length, 1);
  assert.equal(result.zs[0].status, 'uncertain');
  assert.equal(result.zs[0].phase, 'uncertain');
  assert.equal(result.zs[0].closed_time, null);
  assert.equal(result.zs[0].confirmed_time, 114);
  assert.deepEqual([result.zs[0].zd, result.zs[0].zg], sign === 1 ? [199.9, 212.1] : [187.9, 200.1]);
  assert.equal(result.zsUncertainty.length, 1);
  assert.equal(result.zsUncertainty[0].kind, 'lifecycle');
  assert.equal(result.zsUncertainty[0].confirmed_time, 378);
  assert.deepEqual(result.zsUncertainty[0].segments.map(s => s.id), ['segment-297-321', 'segment-321-345']);
  const retest = result.zsUncertainty[0].segments[1].range_bounds;
  assert.deepEqual(sign === 1 ? [retest.low_min, retest.low_max] : [retest.high_min, retest.high_max],
    sign === 1 ? [210, 215.9] : [184.1, 190]);
});

test('center facts distinguish active, leaving and ended; all conditional watches remain hypotheses', () => {
  for (const count of [114, 354, 378, 402]) {
    const result = analyzeChan(zoneLifecycleRows(count));
    const zone = result.zs.at(-1);
    assert.equal(result.outlook.levels.zs_status, zone.status);
    assert.equal(result.outlook.levels.zs_phase, zone.phase);
    assert.match(result.outlook.levels.zs_range, zone.status === 'closed' ? /已结束/ : /当前/);
    const watches = result.outlook.scenarios.flatMap(s => s.next_points);
    assert.equal(watches.length, 6);
    assert.ok(watches.every(p => p.hypothetical));
    assert.equal(result.outlook.conclusion.latest_signal, null);
  }
});

test('an unresolved pen inside history cannot be filtered out and replaced by a fictional completed pen', () => {
  const rows = zoneLifecycleRows(409);
  rows[383].complete = false;
  const result = analyzeChan(rows);
  const stop = result.bi.findIndex(p => p.confirmed !== true);
  assert.ok(stop >= 2 && stop < result.bi.length);
  const lastPair = result.bi.slice(stop - 2, stop);
  assert.equal(result.outlook.levels.last_bi_high, Math.max(...lastPair.map(p => p.price)));
  assert.equal(result.outlook.levels.last_bi_low, Math.min(...lastPair.map(p => p.price)));
  assert.equal(result.zs.length, 1, 'the new center depending on the unresolved history is withdrawn');
});
