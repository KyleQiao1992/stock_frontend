import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments } from './segment.js';
import { analyzeChan } from './index.js';
import { SEGMENT_SPEC_CASES, segmentGapRows, retractionRows } from './fixtures/segmentGap.js';

const endpoints = prices => prices.map((price, i) => ({ price, time: i + 1, idx: i,
  mark: (i % 2 === 0) === (prices[1] > prices[0]) ? 'D' : 'G', confirmed: true, confirmed_time: i + 1 }));
const compact = result => result.segments.map(s => [s.startIndex, s.endIndex, s.confirmedIndex, s.confirmation]);

for (const fixture of SEGMENT_SPEC_CASES) for (const sign of [1, -1]) {
  test(`source rule ${fixture.id}, ${sign === 1 ? 'up' : 'down'}`, () => {
    const points = endpoints(fixture.prices.map(price => sign * price));
    assert.deepEqual(compact(buildSegments(points)), fixture.expected);
    for (let count = 0; count <= points.length; count++) {
      assert.deepEqual(compact(buildSegments(points.slice(0, count))), fixture.expected.filter(s => s[2] < count));
    }
  });
}

for (const sign of [1, -1]) test(`closed OHLC gap waits for K122, ${sign === 1 ? 'up' : 'down'}`, () => {
  const rows = segmentGapRows(129, sign);
  for (let count = 1; count <= rows.length; count++) {
    const result = analyzeChan(rows.slice(0, count));
    assert.deepEqual(result.segments.map(s => [s.id, s.confirmed_time, s.confirmation]), count < 122 ? [] : [
      ['segment-9-33', 122, 'feature_gap_reverse_fractal'], ['segment-33-89', 122, 'reverse_feature_fractal'],
    ]);
  }
});

test('old retraction fixture must never confirm its unqualified local turn', () => {
  // Descending feature intervals [718.2625,777.0502], [748.2054,841.5705]
  // do not enclose the candidate bottom. The first-break shortcut cannot
  // replace the missing standard bottom / reverse-sequence confirmation.
  const rows = retractionRows(1283762);
  for (const count of [199, 200]) assert.deepEqual(analyzeChan(rows.slice(0, count)).segments, []);
});

test('confirmation evidence keeps original and standardized intervals and reverse proof', () => {
  const points = endpoints(SEGMENT_SPEC_CASES.find(c => c.id === 'merged-gap-eventually-confirms').prices);
  const [first, second] = buildSegments(points).segments;
  assert.equal(first.ruleVersion, 'chan-segment-standard-gap-v3');
  assert.equal(first.feature_gap, true);
  const intervals = elements => elements.map(e => [e.low, e.high]);
  assert.deepEqual(intervals(first.evidence.initial), [[40, 100], [50, 120]]);
  assert.deepEqual(intervals(first.evidence.standard), [[40, 100], [110, 120], [105, 114]]);
  assert.deepEqual(intervals(first.evidence.reverse), [[50, 113], [40, 112], [45, 114]]);
  assert.equal(second.evidence.parentSegment, first.id);
  assert.deepEqual(second.evidence.standard, first.evidence.reverse);
  for (const element of [...first.evidence.standard, ...first.evidence.reverse]) {
    assert.ok(element.from <= element.to);
    assert.equal(element.high, points[element.highIndex].price);
    assert.equal(element.low, points[element.lowIndex].price);
  }
});

test('documented equality boundaries stay separate from the gap repair', () => {
  for (const sign of [1, -1]) {
    const points = prices => endpoints(prices.map(x => sign * x));
    // Feature intervals sharing a price have no gap; a zero-width first-three
    // overlap does not establish a candidate in this rule version.
    assert.equal(buildSegments(points([0, 10, 4, 12, 10, 11, 9])).segments[0].feature_gap, false);
    assert.deepEqual(buildSegments(points([5, 10, 0, 5])).pending, []);
    // Retouching the old pivot invalidates this shortcut; a lower rebound
    // followed by a strict break confirms it. This is a declared boundary.
    assert.deepEqual(buildSegments(points([0, 10, 4, 12, 3, 12, 2])).segments, []);
    assert.equal(buildSegments(points([0, 10, 4, 12, 3, 11, 2])).segments[0].confirmation, 'first_stroke_break');
  }
});
