import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments } from './segment.js';

const endpoints = (prices, startsUp = true) => prices.map((price, index) => ({
  time: index + 1, idx: index, price,
  mark: (index % 2 === 0) === startsUp ? 'D' : 'G', confirmed: true,
}));

test('a stroke turn or three overlapping strokes do not confirm a segment', () => {
  for (const prices of [[], [0, 10], [0, 10, 4, 12], [0, 10, 4, 12, 5, 9]]) {
    assert.deepEqual(buildSegments(endpoints(prices)).segments, []);
  }
});

test('no-gap characteristic fractal confirms the old segment in both directions', () => {
  const prices = [0, 10, 4, 12, 5, 9, 3];
  for (const sign of [1, -1]) {
    const { segments, pending } = buildSegments(endpoints(prices.map((x) => sign * x), sign === 1));
    assert.equal(segments.length, 1);
    assert.equal(segments[0].confirmation, 'feature_no_gap');
    assert.equal(segments[0].endIndex, 3);
    assert.equal(segments[0].confirmedIndex, 6);
    assert.equal(segments[0].stroke_count, 3);
    assert.equal(segments[0].feature_gap, false);
    assert.equal(segments[0].direction, sign === 1 ? 'up' : 'down');
    assert.equal(pending[0].time, segments[0].end.time);
  }
});

test('lesson 71 first-stroke break needs a developed reverse segment, including an equal old top', () => {
  for (const top of [10, 12]) {
    const prices = [0, 10, 4, top, 3, 8, 2];
    assert.equal(buildSegments(endpoints(prices.slice(0, 6))).segments.length, 0);
    const result = buildSegments(endpoints(prices));
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].endIndex, 3);
    assert.equal(result.segments[0].confirmation, 'first_stroke_break');
  }
});

test('lesson 71 first-stroke break includes an equal prior feature low or high', () => {
  // 12→4 is already a pen break of the old up segment. Equality with the
  // preceding feature's low must not suppress it; a later break below 4
  // confirms the reverse segment, immediately or after an inside extension.
  const fixtures = [
    [0, 10, 4, 12, 4, 8, 3],
    [0, 10, 4, 12, 4, 8, 4, 7, 3],
  ];
  for (const fixture of fixtures) {
    for (const sign of [1, -1]) {
      const prices = fixture.map((price) => sign * price);
      const points = endpoints(prices, sign === 1);
      assert.deepEqual(buildSegments(points.slice(0, -1)).segments, []);
      const { segments } = buildSegments(points);
      assert.equal(segments.length, 1);
      assert.equal(segments[0].startIndex, 0);
      assert.equal(segments[0].endIndex, 3);
      assert.equal(segments[0].end.price, sign * 12);
      assert.equal(segments[0].direction, sign === 1 ? 'up' : 'down');
      assert.equal(segments[0].confirmedIndex, prices.length - 1);
      assert.equal(segments[0].confirmation, 'first_stroke_break');
    }
  }
});

test('gap fractal alone remains unconfirmed until the reverse standard sequence has a fractal', () => {
  const prices = [0, 4, 2, 10, 6, 8, 4, 7, 5, 9];
  for (const length of [7, 8, 9]) {
    assert.equal(buildSegments(endpoints(prices.slice(0, length))).segments.length, 0);
  }
  const result = buildSegments(endpoints(prices));
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].confirmation, 'feature_gap_reverse_fractal');
  assert.equal(result.segments[0].feature_gap, true);
  assert.equal(result.segments[1].endIndex, 6);
  assert.equal(result.segments[1].confirmation, 'reverse_feature_fractal');
});

test('lesson 67 reverse feature fractal can confirm without filling the original feature gap', () => {
  // The old sequence has a gap between 4 and 7. The reverse low is 6, so
  // its standard-sequence fractal confirms while the 4→6 gap stays open.
  const fixture = [0, 4, 2, 10, 7, 9, 6, 8, 7, 9];
  assert.ok(Math.min(...fixture.slice(4)) > 4);
  for (const sign of [1, -1]) {
    const points = endpoints(fixture.map((price) => sign * price), sign === 1);
    assert.deepEqual(buildSegments(points.slice(0, -1)).segments, []);
    const { segments } = buildSegments(points);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].confirmation, 'feature_gap_reverse_fractal');
    assert.equal(segments[0].feature_gap, true);
    assert.equal(segments[0].endIndex, 3);
    assert.equal(segments[0].confirmedIndex, 9);
    assert.equal(segments[1].confirmation, 'reverse_feature_fractal');
    assert.equal(segments[1].endIndex, 6);
    assert.equal(segments[1].end.price, sign * 6);
    assert.equal(segments[1].confirmedIndex, 9);
  }
});

test('lesson 81 correction: equal or higher second rebound is absorbed, lower rebound gives three connected segments', () => {
  // 原图的 5 / 7 高点对应两次反弹 8 / rebound；第二特征序列必须包含处理。
  for (const sign of [1, -1]) {
    for (const rebound of [8, 9]) {
      const prices = [0, 4, 2, 10, 6, 8, 4, rebound, 5, 11].map((x) => x * sign);
      const result = buildSegments(endpoints(prices, sign === 1));
      assert.equal(result.segments.length, 0);
      assert.deepEqual(result.pending.map((p) => p.price), [0 * sign, 11 * sign]);
    }
    const prices = [0, 4, 2, 10, 6, 8, 4, 7, 5, 11].map((x) => x * sign);
    const result = buildSegments(endpoints(prices, sign === 1));
    assert.equal(result.segments.length, 2);
    assert.equal(result.pending.length, 2);
    assert.equal(result.segments[0].end.time, result.segments[1].start.time);
    assert.equal(result.segments[1].end.time, result.pending[0].time);
  }
});

test('lesson 81 second character diagram: a lower intervening bottom retains the rebound classification', () => {
  for (const low of [1, -1]) for (const rebound of [7, 8, 9]) for (const sign of [1, -1]) {
    // Structure-equivalent coordinates, not recovered numerical market data.
    const prices = [0, 4, 2, 10, 6, 8, low, rebound, 5, 11].map((price) => price * sign);
    const result = buildSegments(endpoints(prices, sign === 1));
    if (rebound < 8) {
      assert.deepEqual(result.segments.map((segment) => [segment.startIndex, segment.endIndex, segment.confirmedIndex]),
        [[0, 3, 9], [3, 6, 9]]);
      assert.deepEqual(result.pending.map((p) => p.price), [low * sign, 11 * sign]);
    } else {
      assert.deepEqual(result.segments, []);
      assert.deepEqual(result.pending.map((p) => p.price), [0 * sign, 11 * sign]);
    }
  }
});

test('unbroken segment keeps its directional extreme while later strokes remain inside', () => {
  assert.deepEqual(buildSegments(endpoints([0, 10, 2, 8, 3, 7])).pending.map((p) => p.price), [0, 10]);
  assert.deepEqual(buildSegments(endpoints([10, 0, 8, 2, 7, 3], false)).pending.map((p) => p.price), [10, 0]);
});

test('lesson 78 unusual segment can have an interior high beyond its starting endpoint', () => {
  const result = buildSegments(endpoints([0, 10, 4, 12, 3, 8, 2, 20, 10, 16, 1, 10, 3, 11]));
  const segment = result.segments[1];
  assert.equal(segment.direction, 'down');
  assert.equal(segment.start.price, 12);
  assert.equal(segment.end.price, 1);
  assert.equal(segment.high, 20);
  assert.equal(segment.high_time, 8);
  assert.equal(segment.low, 1);
  assert.equal(segment.low_time, 11);
});

test('lesson 78: a reverse downswing that stays above the breaking pen bottom does not extend the old down segment', () => {
  for (const sign of [1, -1]) {
    const prices = [0, 10, 4, 12, 3, 8, 2, 20, 10, 16, 3, 11, 4, 21].map((price) => price * sign);
    const result = buildSegments(endpoints(prices, sign === 1));
    assert.deepEqual(result.segments.map((segment) => [segment.startIndex, segment.endIndex, segment.confirmedIndex]),
      [[0, 3, 6], [3, 6, 13]]);
    assert.deepEqual(result.pending.map((p) => p.price), [2 * sign, 21 * sign]);
  }
});

test('nonoverlapping first three strokes and unconfirmed stroke ends cannot fabricate segments', () => {
  assert.equal(buildSegments(endpoints([5, 10, 0, 3])).segments.length, 0);
  const points = endpoints([0, 10, 4, 12, 5, 9, 3]);
  points[6].confirmed = false;
  assert.equal(buildSegments(points).segments.length, 0);
});

test('missing confirmation cannot be treated as a confirmed pen endpoint', () => {
  const points = endpoints([0, 10, 4, 12, 5, 9, 3]);
  delete points[6].confirmed;
  assert.deepEqual(buildSegments(points).segments, []);
});

test('a developing segment requires three overlapping confirmed pens', () => {
  for (const prices of [[], [0, 10], [0, 10, 4], [5, 10, 0, 3]]) {
    assert.deepEqual(buildSegments(endpoints(prices)).pending, []);
  }
  assert.deepEqual(buildSegments(endpoints([0, 10, 4, 12])).pending.map((p) => p.price), [0, 12]);
});

test('confirmation time is the evidence candle, distinct from the historical pen endpoint', () => {
  const points = endpoints([0, 10, 4, 12, 5, 9, 3]).map((p, i) => ({
    ...p, confirmed_time: p.time + (i === 6 ? 8 : 2),
  }));
  const [segment] = buildSegments(points).segments;
  assert.equal(segment.end.time, 4);
  assert.equal(segment.confirmed_endpoint_time, 7);
  assert.equal(segment.confirmed_time, 15);
});

test('completed segments never change when later confirmed strokes are appended', () => {
  const fixtures = [
    [0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12],
    [0, 4, 2, 10, 6, 8, 4, 7, 5, 11, 8, 12, 6, 10, 5],
    // 起点在后续才确认时，后段较早出现的局部分型不能提前成为可知信号。
    [0, 11, 6, 9, -8, -4, -7, 1, -15, 3, -15, -9, -19, -9, -19,
      -1, -10, -4, -11, -8, -17, -1, -8, 7],
  ];
  for (const prices of fixtures) {
    const final = buildSegments(endpoints(prices)).segments;
    for (let length = 0; length <= prices.length; length++) {
      const prefix = buildSegments(endpoints(prices.slice(0, length))).segments;
      assert.deepEqual(prefix, final.filter((segment) => segment.confirmedIndex < length));
    }
  }
});
