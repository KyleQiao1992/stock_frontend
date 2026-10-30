import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findUnitKOverlapCandidates } from './unitKOverlap.js';

const basis = { provider: 'test', symbol: 'example', period: '5m', adjustment: 'none' };
const fromRanges = (ranges, complete = true) => ranges.map(([low, high], index) => ({
  date: `2026-10-30 09:${String(30 + index).padStart(2, '0')}`,
  open: low, high, low, close: high, volume: 10,
  ...(complete === undefined ? {} : { complete }),
}));

test('three completed unit K candles produce the exact common price range', () => {
  const rows = fromRanges([[4, 10], [5, 9], [6, 11]]);
  const result = findUnitKOverlapCandidates(rows, basis);
  assert.equal(result.selection, 'caller_selected_irreducible_unit_k');
  assert.match(result.scope, /not_movement_or_recursive_center/);
  assert.equal(result.coverage.continuity, 'not_verified');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.deepEqual([candidate.start, candidate.end, candidate.zd, candidate.zg, candidate.observed_at], [1, 3, 6, 9, 3]);
  assert.deepEqual(candidate.evidence.map(e => [e.time, e.low, e.high, e.observed_at]),
    [[1, 4, 10, 1], [2, 5, 9, 2], [3, 6, 11, 3]]);
  assert.deepEqual(result.pending, []);
});

test('up/down price mirror gives the same candidates with mirrored boundaries', () => {
  const rows = fromRanges([[4, 10], [5, 9], [6, 11], [3, 7], [4, 10]]);
  const mirror = rows.map(r => ({ ...r, open: -r.open, close: -r.close, high: -r.low, low: -r.high }));
  const a = findUnitKOverlapCandidates(rows, basis), b = findUnitKOverlapCandidates(mirror, basis);
  assert.deepEqual(a.candidates.map(c => [c.start, c.end, -c.zg, -c.zd, c.observed_at]),
    b.candidates.map(c => [c.start, c.end, c.zd, c.zg, c.observed_at]));
});

test('each adjacent three-K candidate is separate and zero-width contact is not silently classified as a center', () => {
  const multiple = findUnitKOverlapCandidates(fromRanges([[4, 10], [5, 9], [6, 11], [3, 7]]), basis);
  assert.deepEqual(multiple.candidates.map(c => [c.start, c.end, c.zd, c.zg]), [[1, 3, 6, 9], [2, 4, 6, 7]]);
  const touch = findUnitKOverlapCandidates(fromRanges([[1, 2], [2, 3], [0, 2]]), basis);
  assert.equal(touch.candidates.length, 0);
  assert.deepEqual(touch.boundaryTouches.map(c => [c.zd, c.zg, c.status]), [[2, 2, 'boundary_touch_only']]);
  const none = findUnitKOverlapCandidates(fromRanges([[1, 2], [4, 5], [6, 7]]), basis);
  assert.deepEqual([none.candidates.length, none.boundaryTouches.length, none.pending.length], [0, 0, 0]);
});

test('unconfirmed bars do not leak candidate prices; missing completion requires a subsequent bar', () => {
  const rows = fromRanges([[4, 10], [5, 9], [6, 11], [3, 7]]);
  delete rows[2].complete;
  const first = findUnitKOverlapCandidates(rows.slice(0, 3), basis);
  assert.deepEqual(first.candidates, []);
  assert.deepEqual(first.pending, [{ start: 1, end: 3, reason: 'completion_not_observed' }]);
  const later = findUnitKOverlapCandidates(rows, basis);
  assert.deepEqual([later.candidates[0].zd, later.candidates[0].zg, later.candidates[0].observed_at], [6, 9, 4]);
  rows[2].complete = false;
  const unfinished = findUnitKOverlapCandidates(rows, basis);
  assert.deepEqual(unfinished.candidates, []);
  assert.deepEqual(unfinished.pending.map(p => p.reason), ['explicitly_unfinished_k', 'explicitly_unfinished_k']);
});

test('invalid OHLC, timestamps, volumes and provenance are rejected rather than filtered', () => {
  for (const change of [
    rows => { rows[1].low = null; }, rows => { rows[1].close = rows[1].high + 1; },
    rows => { rows[1].volume = -1; }, rows => { rows[1].volume = null; },
    rows => { rows[1].date = rows[0].date; }, rows => { rows[1].complete = 'true'; },
  ]) {
    const rows = fromRanges([[4, 10], [5, 9], [6, 11]]); change(rows);
    assert.throws(() => findUnitKOverlapCandidates(rows, basis));
  }
  assert.throws(() => findUnitKOverlapCandidates([], basis));
  assert.throws(() => findUnitKOverlapCandidates(fromRanges([[4, 10]]), { ...basis, symbol: '' }), /provenance/);
});

test('real 600851 daily sample agrees with independent per-prefix intersection and observation times', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const metadata = { provider: 'Tencent saved fixture', symbol: '600851', period: 'day', adjustment: 'qfq' };
  const completed = findUnitKOverlapCandidates(rows, metadata);
  const independent = (source) => {
    const result = [];
    for (let i = 0; i + 2 < source.length; i++) {
      const w = source.slice(i, i + 3);
      const seen = w.map((b, offset) => b.complete === true ? i + offset + 1
        : b.complete === false || i + offset + 1 === source.length ? null : i + offset + 2);
      if (seen.includes(null)) continue;
      const zd = Math.max(w[0].low, w[1].low, w[2].low), zg = Math.min(w[0].high, w[1].high, w[2].high);
      if (zd < zg) result.push([i + 1, i + 3, zd, zg, Math.max(...seen)]);
    }
    return result;
  };
  const actual = result => result.candidates.map(c => [c.start, c.end, c.zd, c.zg, c.observed_at]);
  assert.ok(completed.candidates.length > 0);
  assert.deepEqual(actual(completed), independent(rows));
  const byId = new Map(completed.candidates.map(candidate => [candidate.id, candidate]));
  for (let count = 1; count <= rows.length; count++) {
    const prefix = rows.slice(0, count);
    const replay = findUnitKOverlapCandidates(prefix, metadata);
    assert.deepEqual(actual(replay), independent(prefix), `prefix ${count}`);
    for (const candidate of replay.candidates) {
      assert.ok(candidate.observed_at <= count);
      assert.deepEqual(byId.get(candidate.id), candidate);
    }
  }
});
