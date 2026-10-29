import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments } from './segment.js';

// 600851 Tencent qfq daily snapshot, 2024-03-05 through 2026-10-27.
// These are the existing engine's pen endpoints and confirmation times, not
// an independently verified pen oracle. Snapshot SHA-256:
// 611babdde928f04a179b6b0db770605f04e2ced38a8263aac6861307109d9e6d.
// Dates are in test-results/chan-600851-long-segment-audit-2026-10-28/input-and-pens.json.
// The test checks the segment rule conditional on those particular pen inputs.
const data = [
  [85, 4.195, 108], [106, 5.93, 123], [121, 4.6, 131], [129, 5.01, 136],
  [134, 4.5, 145], [143, 6.65, 149], [147, 5.36, 168], [166, 6.24, 175],
  [172, 5.61, 195], [193, 8.49, 213], [211, 5.11, 223], [220, 6.61, 234],
  [232, 6.11, 241], [239, 6.59, 258], [255, 5.9, 309], [305, 7.47, 317],
  [315, 6.2, 358], [355, 7.5, 384], [381, 6.35, 415], [413, 7.14, 421],
  [418, 6.46, 428], [425, 7.54, 438], [436, 6.5, 442], [440, 7.19, 448],
  [446, 6.77, 478], [475, 8.91, 485], [483, 7.55, 490], [487, 9.13, 499],
  [497, 7.08, 506], [504, 8.95, 551], [547, 6.88, 560],
];

const points = (sign = 1) => data.map(([time, price, confirmed_time], index) => ({
  time, price: sign * price, confirmed_time, confirmed: true,
  mark: (index % 2 === 0) === (sign === 1) ? 'D' : 'G',
}));
const compact = ({ segments }) => segments.map(s => ({
  start: s.start.time, end: s.end.time, confirmation: s.confirmation,
  confirmed_time: s.confirmed_time,
}));

for (const sign of [1, -1]) {
  test(`historical pen sequence: contained third stroke and later continuation (sign ${sign})`, () => {
    const p = points(sign);
    // Two prior downward features, normalised to the rising example. The
    // second is contained and the documented rising merge is [5.61, 6.65].
    const earlier = [sign * p[5].price, sign * p[6].price].sort((a, b) => a - b);
    const later = [sign * p[7].price, sign * p[8].price].sort((a, b) => a - b);
    assert.deepEqual(earlier, [5.36, 6.65]);
    assert.deepEqual(later, [5.61, 6.24]);
    assert.ok(earlier[0] < later[0] && later[1] < earlier[1]);
    const left = [Math.max(earlier[0], later[0]), Math.max(earlier[1], later[1])];
    assert.deepEqual(left, [5.61, 6.65]);
    assert.ok(sign * p[10].price < left[0] && sign * p[9].price > left[1]);
    // 2024-12-17 to 2025-02-19: the third stroke lies inside the first.
    const first = [p[9].price, p[10].price].sort((a, b) => a - b);
    const third = [p[11].price, p[12].price].sort((a, b) => a - b);
    assert.ok(first[0] < third[0] && third[1] < first[1]);
    // Before 2026-02-12, no subsequent endpoint has crossed either boundary.
    for (const item of p.slice(11, 25)) assert.ok(item.price > first[0] && item.price < first[1]);
    assert.ok(sign * p[25].price > sign * p[9].price);
    for (let count = 13; count <= 26; count++) assert.deepEqual(compact(buildSegments(p.slice(0, count))), []);
    assert.deepEqual(compact(buildSegments(p)), [{
      start: 85, end: 487, confirmation: 'first_stroke_break', confirmed_time: 560,
    }]);
  });

  test(`counterfactual: third stroke breaks the first endpoint instead (sign ${sign})`, () => {
    const p = points(sign).slice(0, 13);
    // Synthetic change: third stroke ends beyond the first's 5.11 low. This is
    // not claimed to have occurred in the market or to be a verified pen.
    p[12].price = sign * 5;
    assert.deepEqual(compact(buildSegments(p)), [{
      start: 85, end: 193, confirmation: 'first_stroke_break', confirmed_time: 241,
    }]);
  });
}
