import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayStrictPens } from './strictPenReplayPrototype.js';
import { isStrictBi } from './bi.js';
import { retractionRows } from './fixtures/segmentGap.js';
import { buildSegments } from './segment.js';

const seven = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];
const bars = (ranges, complete) => ranges.map(([high, low], i) => ({
  date: `K${i + 1}`, high, low, open: low, close: high, ...(complete === undefined ? {} : { complete }),
}));

test('confirmation records the evidence for the current pen, not its displaced predecessor', () => {
  const input = bars([...seven, [4, 3], [5, 4], [7, 6], [6, 5]], true);
  const first = replayStrictPens(input.slice(0, 7)).bi;
  assert.deepEqual(first.map(p => [p.time, p.confirmed_time]), [[2, 7], [6, null]]);
  const later = replayStrictPens(input).bi;
  assert.deepEqual(later.map(p => [p.time, p.confirmed_time]), [[2, 11], [10, null]]);
});

test('explicit and unknown K completion control observation time; incomplete evidence never confirms', () => {
  assert.equal(replayStrictPens(bars(seven, true)).bi[0].confirmed_time, 7);
  const unknown = bars([...seven, [4, 3]]);
  assert.equal(replayStrictPens(unknown.slice(0, 7)).bi[0].confirmed, false);
  assert.equal(replayStrictPens(unknown).bi[0].confirmed_time, 8);
  const incomplete = bars([...seven, [4, 3]], true);
  incomplete[6].complete = false;
  assert.equal(replayStrictPens(incomplete).bi[0].confirmed, false);
});

test('600851 replay retracts the invalid pen without removing unrelated earlier history', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-old-bi-2025.json', import.meta.url)));
  const until = date => input.filter(row => row.date <= date);
  const dates = (rows, result) => result.bi.map(p => rows[p.idx].date);
  const before = until('2025-04-08');
  assert.deepEqual(dates(before, replayStrictPens(before)).slice(-2), ['2025-03-24', '2025-04-03']);
  const later = until('2025-06-25');
  const result = replayStrictPens(later);
  assert.ok(dates(later, result).includes('2024-12-17'));
  assert.deepEqual(dates(later, result).slice(-3), ['2025-01-13', '2025-06-09', '2025-06-23']);
  const byTime = new Map(result.fractals.map(f => [f.time, f]));
  for (let i = 1; i < result.bi.length; i++) {
    assert.equal(isStrictBi(byTime.get(result.bi[i - 1].time), byTime.get(result.bi[i].time), result.merged), true);
  }
});

test('mirrored real history produces mirrored pens and identical observation times', () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-old-bi-2025.json', import.meta.url)));
  const reflected = input.map(row => ({ ...row, open: -row.open, close: -row.close,
    high: -row.low, low: -row.high }));
  const result = replayStrictPens(input).bi;
  const mirror = replayStrictPens(reflected).bi;
  assert.deepEqual(mirror, result.map(point => ({ ...point, price: -point.price,
    mark: point.mark === 'G' ? 'D' : 'G' })));
});

test('active-inclusion replay preserves the current equal-low date while strict inclusion chooses the earlier one', () => {
  const all = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-old-bi-2025.json', import.meta.url)));
  const input = all.filter(row => row.date <= '2025-03-15');
  const dateOfLow = inclusion => {
    const point = replayStrictPens(input, { inclusion }).bi.find(p => p.price === 6.11 && p.mark === 'D');
    assert.ok(point);
    return input[point.idx].date;
  };
  assert.equal(dateOfLow('strict'), '2025-02-18');
  assert.equal(dateOfLow('active'), '2025-02-19');
  assert.throws(() => replayStrictPens(input, { inclusion: 'unknown' }), /policy/);
});

test('different historical prefixes do not lose unrelated earlier pens or contain nonextreme endpoints', () => {
  const input = retractionRows(3);
  const result = replayStrictPens(input);
  assert.ok(result.bi.some(point => point.time === 2));
  assert.ok(result.bi.some(point => point.time === 39));
  const byTime = new Map(result.fractals.map(f => [f.time, f]));
  for (let i = 1; i < result.bi.length; i++) {
    assert.equal(isStrictBi(byTime.get(result.bi[i - 1].time), byTime.get(result.bi[i].time), result.merged), true);
  }
  for (const point of result.bi) {
    if (point.confirmed) assert.ok(point.confirmed_time >= point.time && point.confirmed_time <= input.length);
  }
});

test('real-history pen correction does not by itself imply a third confirmed segment', () => {
  // Captured Tencent qfq daily history through 2026-10-27. Active mode now
  // replays the production pen engine; this does not independently prove the
  // final segment or recursive centers.
  const input = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const replay = replayStrictPens(input, { inclusion: 'active' });
  const segments = buildSegments(replay.bi).segments;
  assert.equal(segments.length, 2);
  assert.equal(input[segments[1].start.time - 1].date, '2024-07-09');
  assert.equal(input[segments[1].end.time - 1].date, '2026-03-10');
  assert.equal(segments[1].stroke_count, 23);
});

test('seed 27 retains the existing valid pen path after a short reversal', () => {
  // At K119 a short reversal cannot form a pen; at K129 the same prior top
  // has a valid opposite endpoint. All four original pens satisfy the strict
  // range and independent-K checks. The prior greedy research replay lost
  // 108→113; active mode now replays the production engine. This is a regression
  // requirement, not proof that the original theory uniquely mandates it.
  const input = retractionRows(27).slice(0, 199);
  const result = replayStrictPens(input, { inclusion: 'active' });
  const byTime = new Map(result.fractals.map(f => [f.time, f]));
  const valid = (a, b) => isStrictBi(byTime.get(a), byTime.get(b), result.merged);
  assert.equal(valid(99, 108), true);
  assert.equal(valid(108, 113), true);
  assert.equal(valid(113, 119), false);
  assert.equal(valid(113, 129), true);
  assert.equal(valid(99, 129), true, 'pairwise validity alone cannot choose between these two decompositions');
  assert.ok(result.bi.some(p => p.time === 108), 'the reference path retains this bottom');
  assert.ok(result.bi.some(p => p.time === 113), 'the reference path retains this top');
});
