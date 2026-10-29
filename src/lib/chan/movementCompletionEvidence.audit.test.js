import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZsDetailed } from './zs.js';
import { formCenterFromMoves } from './recursiveCenter.js';

// Independent, synthetic piecewise-linear price path. Each candle is a single
// price, so the segment ranges and their order do not depend on wick ordering.
// The explicit segment confirmations below are hypotheses for this audit; this
// fixture does NOT independently prove the pen or segment algorithm.
function pricePath(sign = 1) {
  const offsets = [0, 10, 4, 12, 11, 13, 9];
  const prices = offsets.map(value => 100 + sign * value);
  const bars = prices.map((price, i) => ({ time: i + 1, low: price, high: price, complete: true }));
  const segments = prices.slice(0, -1).map((price, i) => {
    const next = prices[i + 1];
    return { id: `s${i}`, kind: 'segment', confirmed: true, direction: next > price ? 'up' : 'down',
      start: { time: i + 1, price }, end: { time: i + 2, price: next }, confirmed_time: i + 3,
      low: Math.min(price, next), high: Math.max(price, next) };
  });
  return { bars, segments };
}

for (const sign of [1, -1]) test(`an ended center is not itself an independently completed movement (${sign})`, () => {
  const { bars, segments } = pricePath(sign);
  // The fourth segment turns at K5, but its stipulated confirmation is K6.
  const before = buildZsDetailed(segments.filter(s => s.confirmed_time <= 5));
  assert.equal(before.zones.length, 1);
  assert.equal(before.zones[0].status, 'active');
  assert.equal(before.zones[0].closed_time, null);
  const after = buildZsDetailed(segments.filter(s => s.confirmed_time <= 6));
  assert.equal(after.zones[0].status, 'closed');
  assert.equal(after.zones[0].closed_time, 6);
  assert.deepEqual([after.zones[0].zd, after.zones[0].zg], sign === 1 ? [104, 110] : [90, 96]);
  // A structurally declared segment cannot be silently promoted into a
  // completed lower-level up/down/consolidation movement for recursion.
  assert.throws(() => formCenterFromMoves(segments.slice(0, 3),
    { targetLevel: 1, asOfTime: 6, source: { basis: 'synthetic', bars } }), /kind must be movement/);
});

for (const sign of [1, -1]) test(`a later distinct core can reuse the departure; its existence follows later evidence (${sign})`, () => {
  const { segments } = pricePath(sign);
  const before = buildZsDetailed(segments.filter(s => s.confirmed_time <= 6));
  assert.equal(before.zones.length, 1);
  const after = buildZsDetailed(segments.filter(s => s.confirmed_time <= 7));
  assert.equal(after.zones.length, 2);
  assert.equal(after.zones[1].confirmed_time, 7);
  assert.deepEqual([after.zones[1].zd, after.zones[1].zg], sign === 1 ? [111, 112] : [88, 89]);
  assert.equal(after.zones[1].segment_ids[0], 's2');
  // This checks geometry of the current implementation only. It proves neither
  // a same-level trend nor a completed movement, nor a higher-level center.
});

test('a weakening unfinished spread lobe does not prove the final comparison', () => {
  // An independently calculated *proxy*, not a complete definition of the
  // author's kisses or trend divergence. Two possible futures have exactly
  // the same closes through K11, but reverse at different later times.
  const prefix = [10, 12, 14, 16, 18, 17, 15, 13, 11, 12, 13];
  const shortFuture = [...prefix, 12, 11, 10];
  const longFuture = [...prefix, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 24, 23, 22];
  const lobes = closes => {
    const result = [];
    let area = 0;
    for (let i = 2; i < closes.length; i++) {
      const fast = (closes[i] + closes[i - 1]) / 2;
      const slow = (closes[i] + closes[i - 1] + closes[i - 2]) / 3;
      const diff = fast - slow;
      if (diff > 0) area += diff;
      else if (area > 0) { result.push({ area, observed_at: i + 1 }); area = 0; }
    }
    return result;
  };
  assert.deepEqual(shortFuture.slice(0, prefix.length), longFuture.slice(0, prefix.length));
  assert.equal(lobes(prefix).length, 1, 'the second lobe has not ended at K11');
  const short = lobes(shortFuture), long = lobes(longFuture);
  assert.ok(short[1].area < short[0].area);
  assert.ok(long[1].area > long[0].area);
  assert.equal(short[1].observed_at, 13);
  assert.ok(long[1].observed_at > prefix.length);
});
