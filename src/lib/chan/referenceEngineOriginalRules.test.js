import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReferenceCandles, mergeReferenceBar, MIN_BI_LENGTH } from './referenceEngine.js';

const candles = (ranges) => ranges.map(([high, low], i) => ({
  time: i + 1, date: `K${i + 1}`, high, low, open: low, close: high, volume: 100,
}));
const analyze = (ranges) => analyzeReferenceCandles(candles(ranges));
const reflect = (ranges) => ranges.map(([high, low]) => [30 - low, 30 - high]);
const seven = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];

test('lessons 62/77: endpoint fractals need an independent processed K, not just six endpoint K', () => {
  assert.equal(MIN_BI_LENGTH, 7);
  const six = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [4, 3]];
  for (const ranges of [six, reflect(six)]) assert.deepEqual(analyze(ranges).bi, []);
  assert.deepEqual(analyze(seven).bi.map(({ time, mark }) => [time, mark]), [[2, 'D'], [6, 'G']]);
  assert.deepEqual(analyze(reflect(seven)).bi.map(({ time, mark }) => [time, mark]), [[2, 'G'], [6, 'D']]);
});

test('raw inclusion cannot inflate six processed endpoint K into a valid old-rule pen', () => {
  const ranges = [[3, 2], [2, 1], [3, 2], [3, 2], [4, 3], [5, 4], [4, 3]];
  assert.deepEqual(analyze(ranges).bi, []);
  assert.deepEqual(analyze(reflect(ranges)).bi, []);
});

test('lesson 65: an initial containing pair cannot supply a direction; later non-containing data can', () => {
  const unresolved = [[1, 0], [2, 0], [2, 1], [1, 0]];
  assert.deepEqual(analyze(unresolved).fx, []);
  assert.deepEqual(analyze(reflect(unresolved)).fx, []);
  const resolved = analyze([...unresolved, [2, 1]]);
  assert.deepEqual(resolved.fx.map(({ time, mark }) => [time, mark]), [[4, 'D']]);
  assert.equal(resolved.fractalDetails.fx[4].mergedCandles[0].from, 2,
    'unresolved prefix is skipped, not retrospectively merged using a later direction');
});

test('initialization remains price-reflection symmetric for all four-K histories on a small integer domain', () => {
  const ranges = [];
  for (let high = 1; high <= 4; high++) for (let low = 0; low < high; low++) ranges.push([high, low]);
  for (const a of ranges) for (const b of ranges) for (const c of ranges) for (const d of ranges) {
    const input = [a, b, c, d];
    const actual = analyze(input).fx.map(({ time, mark, price }) => ({ time,
      mark: mark === 'G' ? 'D' : 'G', price: 30 - price }));
    const mirrored = analyze(reflect(input)).fx.map(({ time, mark, price }) => ({ time, mark, price }));
    assert.deepEqual(actual, mirrored, JSON.stringify(input));
  }
});

test('lesson 77: equal same-side candidate fractals retain the earlier initial anchor', () => {
  const equal = [[3, 2], [2, 1], [3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];
  for (const input of [equal, reflect(equal)]) assert.equal(analyze(input).bi[0].time, 2);
});

test('pending endpoint belongs to the real raw extremum date, not the last input date', () => {
  const input = [...seven, [4, 3], [3, 2], [4, 3]];
  const result = analyze(input);
  assert.equal(result.pending.at(-1).time, 9);
  assert.equal(result.pending.at(-1).idx, 8);
  assert.equal(result.pending.at(-1).price, 2);
  assert.equal(result.pending.at(-1).confirmed, false);
  assert.ok(input.at(-1)[1] > result.pending.at(-1).price,
    'the latest candle never traded at the pending low');
});

test('pending source selection excludes the completed endpoint left neighbour', () => {
  const input = [[3, 2], [2, 1], [3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];
  const result = analyze(input);
  assert.ok(result.pending.at(-1).time >= result.bi.at(-1).time);
  assert.equal(result.pending.at(-1).extremeTime, 9);
});

test('a long inclusion run retains intermediate extrema and every original source', () => {
  const input = [[9, 8], [10, 9], [9, 8], [8, 7], [7, 6], [6, 5], [7, 6], [8, 7],
    ...Array.from({ length: 125 }, () => [8, 7]), [9, 6], ...Array.from({ length: 110 }, () => [8, 7])];
  assert.equal(analyze(input).pending.at(-1).time, 134);
  assert.equal(analyze(input).pending.at(-1).price, 9);
  const raw = candles([[3, 1], [5, 3], ...Array.from({ length: 125 }, () => [5, 3])]);
  const first = { ...raw[0], from: 0, to: 0, elements: [{ ...raw[0], idx: 0 }], mergeSteps: [] };
  let merged = { ...raw[1], from: 1, to: 1, elements: [{ ...raw[1], idx: 1 }], mergeSteps: [] };
  for (let i = 2; i < raw.length; i++) merged = mergeReferenceBar(first, merged, raw[i], i);
  assert.equal(merged.elements.length, 126);
  assert.equal(merged.mergeSteps.length, 125);
});
