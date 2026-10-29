import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZs } from './zs.js';

// Declared lowest-layer fixtures: every edge is already a valid, completed
// segment. Prices are hand-calculated examples, not market data or pen edges.
function completedSegments(prices, sign = 1) {
  return prices.slice(1).map((price, index) => {
    const start = { time: index + 1, idx: index, price: sign * prices[index] };
    const end = { time: index + 2, idx: index + 1, price: sign * price };
    const high = start.price > end.price ? start : end;
    const low = start.price < end.price ? start : end;
    return { id: `segment-${start.time}-${end.time}`, start, end, confirmed: true,
      direction: end.price > start.price ? 'up' : 'down', high: high.price, low: low.price,
      high_time: high.time, low_time: low.time, high_point: high, low_point: low,
      confirmed_time: end.time + 10 };
  });
}

test('three completed segments form the hand-calculated 85–95 core at their confirmation time', () => {
  const input = completedSegments([100, 80, 95, 85]);
  const [zone] = buildZs(input);
  assert.deepEqual([zone.zd, zone.zg], [85, 95]);
  assert.equal(zone.formation_edt, 4);
  assert.equal(zone.confirmed_time, 14);
  assert.equal(zone.closed_time, null);
  assert.equal(zone.ruleVersion, 'chan-segment-zs-v1');
  assert.deepEqual(zone.evidence.formation.segment_ids, input.map(s => s.id));
  assert.equal(zone.evidence.formation.confirmed_time, 14);
});

test('disconnected prices, invalid ranges and missing completion evidence cannot be spliced into a zone', () => {
  for (const change of [
    s => ({ ...s, start: { ...s.start, price: s.start.price + 1 } }),
    s => ({ ...s, end: { ...s.end, time: s.start.time } }),
    s => ({ ...s, high: s.end.price - 1 }),
    s => ({ ...s, confirmed_time: undefined }),
    s => ({ ...s, confirmed_time: s.end.time - 1 }),
    s => ({ ...s, direction: s.direction === 'up' ? 'down' : 'up' }),
  ]) {
    const input = completedSegments([0, 10, 4, 12, 5, 11]);
    input[1] = change(input[1]);
    assert.deepEqual(buildZs(input), []);
  }
});

test('positive-width formation is distinct from touching an established core', () => {
  assert.deepEqual(buildZs(completedSegments([0, 10, -5, 0])), []);
  for (const sign of [1, -1]) {
    const [zone] = buildZs(completedSegments([0, 10, 4, 12, 10], sign));
    assert.equal(zone.status, 'active');
    assert.equal(zone.phase, 'extending');
    assert.equal(zone.closed_time, null);
    assert.equal(zone.thirdSignal, null);
    assert.equal(zone.segment_count, 4);
    assert.equal(zone.boundary_policy.retest, 'strictly_outside_to_close');
  }
});

test('the third formation segment may be leaving but cannot close the core without its completed first retest', () => {
  const input = completedSegments([0, 10, 4, 12, 11]);
  const [waiting] = buildZs(input.slice(0, 3));
  assert.equal(waiting.phase, 'leaving');
  assert.equal(waiting.status, 'active');
  assert.equal(waiting.closed_time, null);
  const [closed] = buildZs(input);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_time, 15);
  assert.equal(closed.retest.confirmed_time, 15);
  assert.deepEqual(closed.evidence.closure.segment_ids, [input[2].id, input[3].id]);
  assert.equal(closed.evidence.closure.kind, 'first_retest_strictly_outside');
  assert.equal(closed.retest.scope, 'segment_geometry');
});

test('new-center search reuses the completed departure segment rather than dropping the earliest triple', () => {
  // Old core [4,10]. Segment 4→12 leaves it and 12→11 retests above it.
  // The first new triple is [4,12], [11,12], [11,16]: its core is [11,12].
  for (const sign of [1, -1]) {
    const input = completedSegments([0, 10, 4, 12, 11, 16], sign);
    const zones = buildZs(input);
    assert.equal(zones.length, 2);
    assert.deepEqual([zones[1].zd, zones[1].zg], sign === 1 ? [11, 12] : [-12, -11]);
    assert.equal(zones[1].startIndex, 2);
    assert.equal(zones[1].confirmed_time, 16);
    assert.deepEqual(zones[1].evidence.formation.segment_ids, input.slice(2).map(s => s.id));
    assert.equal(zones[1].evidence.previous_zone.id, zones[0].id);
  }
});

test('a failed first retest cannot be paired with a later segment as if it were the original first return', () => {
  const input = completedSegments([0, 10, 4, 12, 8, 14, 11]);
  const [zone] = buildZs(input);
  assert.equal(zone.closed_time, 17);
  assert.equal(zone.retest.departure_id, input[4].id);
  assert.equal(zone.retest.retracement_id, input[5].id);
  assert.notEqual(zone.retest.departure_id, input[2].id);
  assert.deepEqual([zone.zd, zone.zg], [4, 10]);
});

test('closure time includes formation and departure evidence, never only the retest endpoint', () => {
  const input = completedSegments([0, 10, 4, 12, 11]);
  input[2].confirmed_time = 22;
  const [zone] = buildZs(input);
  assert.equal(zone.confirmed_time, 22);
  assert.equal(zone.closed_time, 22);
  assert.equal(zone.retest.confirmed_time, 22);
});

test('extension preserves a fixed core, stable identity, and independent Z-segment extrema beyond nine segments', () => {
  const input = completedSegments([0, 10, 4, 12, 5, 15, 6, 13, 7, 16, 4, 14, 5, 12]);
  const [initial] = buildZs(input.slice(0, 3));
  const [zone] = buildZs(input);
  assert.equal(zone.id, initial.id);
  assert.equal(zone.confirmed_time, initial.confirmed_time);
  assert.deepEqual([zone.zd, zone.zg], [4, 10]);
  assert.equal(zone.segment_count, 13);
  assert.equal(zone.z_segment_ids.length, 7);
  assert.deepEqual([zone.dd, zone.gg], [0, 16]);
  assert.deepEqual([zone.d, zone.g], [7, 10]);
  assert.equal(zone.evidence.extension.confirmed_time, 24);
});

test('removing or retracting a required segment removes dependent zone formation or closure', () => {
  const input = completedSegments([0, 10, 4, 12, 11, 16]);
  assert.equal(buildZs(input).length, 2);
  const undone = input.map(s => ({ ...s }));
  undone[3].confirmed = false;
  const [zone] = buildZs(undone);
  assert.equal(buildZs(undone).length, 1);
  assert.equal(zone.closed_time, null);
  assert.equal(zone.status, 'active');
  undone[2].confirmed = false;
  assert.deepEqual(buildZs(undone), []);
});

test('new formation waits for the previous closure evidence even if its endpoint occurred earlier', () => {
  const input = completedSegments([0, 10, 4, 12, 11, 16]);
  input[3].confirmed_time = 25;
  const [oldZone, newZone] = buildZs(input);
  assert.equal(oldZone.closed_time, 25);
  assert.equal(newZone.formation_edt, 6);
  assert.equal(newZone.confirmed_time, 25);
  assert.equal(newZone.evidence.previous_zone.closed_time, 25);
  assert.equal(newZone.evidence.formation.confirmed_time, 25);
});

test('fixed confirmed chains preserve formation and closure events under every prefix and mirror', () => {
  let state = 20261027;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const formation = z => ({ id: z.id, zd: z.zd, zg: z.zg, time: z.confirmed_time,
    formation_edt: z.formation_edt, sources: z.evidence.formation.segment_ids });
  const closure = z => ({ id: z.id, time: z.closed_time, evidence: z.evidence.closure });
  for (let sample = 0; sample < 200; sample++) {
    const prices = [100];
    for (let index = 0; index < 30; index++) prices.push(prices.at(-1) + (index % 2 ? -1 : 1)
      * (1 + Math.floor(random() * 20)));
    for (const sign of [1, -1]) {
      const input = completedSegments(prices, sign);
      const final = buildZs(input);
      for (let count = 0; count <= input.length; count++) {
        const prefix = input.slice(0, count);
        const now = prefix.at(-1)?.confirmed_time ?? 0;
        const current = buildZs(prefix);
        assert.deepEqual(current.map(formation), final.filter(z => z.confirmed_time <= now).map(formation));
        assert.deepEqual(current.filter(z => z.closed_time !== null).map(closure),
          final.filter(z => z.closed_time !== null && z.closed_time <= now).map(closure));
        for (const zone of current) {
          const known = new Set(prefix.map(s => s.id));
          for (const evidence of [zone.evidence.formation, zone.evidence.extension, zone.evidence.closure].filter(Boolean)) {
            assert.ok(evidence.confirmed_time <= now);
            assert.ok(evidence.segment_ids.every(id => known.has(id)));
          }
          assert.ok(zone.closed_time === null || zone.closed_time >= zone.confirmed_time);
        }
      }
    }
  }
});
