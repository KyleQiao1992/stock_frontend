import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan } from './index.js';
import { analyzeReferenceCandles, MAX_BI_COUNT } from './referenceEngine.js';

const targets = [2, 0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12, 5, 9, 3, 8, 2, 7, 4, 10];
function rowsFromTargets(turns) {
  const prices = turns.flatMap((price, i) => i
    ? Array.from({ length: 8 }, (_, j) => turns[i - 1] + (price - turns[i - 1]) * (j + 1) / 8)
    : [price]);
  return prices.map((price, i) => ({ date: `K${i + 1}`, open: 100 + price, close: 100 + price,
    high: 100.2 + price, low: 99.8 + price, volume: 100, complete: true }));
}
const rows = rowsFromTargets(targets);
const candles = (input) => input.map((row, i) => ({ ...row, time: i + 1 }));
const analyze = (input) => analyzeChan(input, '5m');

test('the active pen sequence distinguishes observed endpoints from the mutable last endpoint', () => {
  const initial = analyze(rows.slice(0, 18));
  assert.deepEqual(initial.bi.map(({ time, confirmed, confirmed_time }) => ({ time, confirmed, confirmed_time })), [
    { time: 9, confirmed: true, confirmed_time: 18 },
    { time: 17, confirmed: false, confirmed_time: null },
  ]);
  const next = analyze(rows.slice(0, 26));
  assert.deepEqual(next.bi.map(({ time, confirmed, confirmed_time }) => ({ time, confirmed, confirmed_time })), [
    { time: 9, confirmed: true, confirmed_time: 18 },
    { time: 17, confirmed: true, confirmed_time: 26 },
    { time: 25, confirmed: false, confirmed_time: null },
  ]);
  assert.equal(next.pending.at(-1).confirmed, false);
  assert.equal(next.pending.at(-1).confirmed_time, null);
});

test('a segment becomes known at its actual confirmation K, after the evidence pivot and dynamic tail', () => {
  const before = analyze(rows.slice(0, 65));
  assert.deepEqual(before.segments, []);
  assert.equal(before.segmentBi.at(-1).time, 57);
  assert.equal(before.segmentBi.at(-1).confirmed, false);
  assert.equal(before.pending.at(-1).time, 65);

  const known = analyze(rows.slice(0, 66));
  assert.equal(known.segments.length, 1);
  const segment = known.segments[0];
  assert.equal(segment.start.time, 9);
  assert.equal(segment.end.time, 33);
  assert.equal(segment.confirmed_endpoint_time, 57);
  assert.equal(segment.confirmed_time, 66);
  assert.equal(known.segmentBi.find((point) => point.time === 57).confirmed_time, 66);
});

test('an explicitly unclosed K cannot confirm a segment, including updates of that same K', () => {
  const input = rows.slice(0, 66).map((row) => ({ ...row }));
  input.at(-1).complete = false;
  const before = analyze(input);
  assert.deepEqual(before.segments, []);
  assert.equal(before.segmentBi.find((point) => point.time === 57).confirmed, false);
  assert.equal(before.segmentBi.find((point) => point.time === 57).confirmed_time, null);

  input.at(-1).high += 1;
  assert.deepEqual(analyze(input).segments, [], 'an intrabar range expansion must not leave a confirmed segment');
  input.at(-1).high -= 1;
  input.at(-1).complete = true;
  assert.deepEqual(analyze(input).segments.map(({ id, confirmed_time }) => ({ id, confirmed_time })),
    [{ id: 'segment-9-33', confirmed_time: 66 }]);
});

test('an unknown final K waits for its successor and records when completion was actually observed', () => {
  const input = rows.slice(0, 66).map((row) => ({ ...row }));
  delete input.at(-1).complete;
  assert.deepEqual(analyze(input).segments, []);
  const next = { ...rows[66] };
  delete next.complete;
  const result = analyze([...input, next]);
  assert.deepEqual(result.segments.map(({ id, confirmed_time }) => ({ id, confirmed_time })),
    [{ id: 'segment-9-33', confirmed_time: 67 }]);
  assert.equal(result.segmentBi.find((point) => point.time === 57).confirmed_time, 67);
});

test('explicitly unclosed evidence is not inferred closed from a later K', () => {
  const input = rows.slice(0, 67).map((row) => ({ ...row }));
  input[65].complete = false;
  assert.deepEqual(analyze(input).segments, []);
  input[65].complete = true;
  assert.equal(analyze(input).segments[0].confirmed_time, 66);
});

test('every confirmed segment in a causal fixture first appears on its reported confirmation K', () => {
  const firstSeen = new Map();
  for (let length = 1; length <= rows.length; length++) {
    const result = analyze(rows.slice(0, length));
    for (const segment of result.segments) {
      if (!firstSeen.has(segment.id)) firstSeen.set(segment.id, length);
      assert.equal(segment.confirmed_time, firstSeen.get(segment.id));
      assert.ok(segment.confirmed_time <= length);
      const evidence = result.segmentBi.slice(0, segment.confirmedIndex + 1);
      assert.ok(evidence.every((point) => point.confirmed === true));
      assert.ok(evidence.every((point) => point.confirmed_time <= segment.confirmed_time));
    }
  }
  assert.equal(firstSeen.size, 3);
});

test('a developing segment waits for three confirmed overlapping strokes and follows the real raw extremum', () => {
  assert.deepEqual(analyze(rows.slice(0, 41)).pendingSegments, []);
  const established = analyze(rows.slice(0, 42));
  assert.deepEqual(established.pendingSegments.map((point) => point.time), [9, 33]);
  assert.ok(established.pendingSegments.every((point) => !point.confirmed && point.confirmed_time === null));

  const developing = analyze(rows.slice(0, 73));
  assert.equal(developing.pendingSegments.at(-1).time, 73);
  assert.equal(developing.pendingSegments.at(-1).price, rows[72].low);
  assert.equal(developing.segmentBi.at(-1).time, 65, 'the new raw low is still outside confirmed pen evidence');
  const afterRebound = analyze(rows.slice(0, 76));
  assert.equal(afterRebound.pendingSegments.at(-1).time, 73, 'a later K must not steal the extremum date');
  assert.deepEqual(afterRebound.segments, developing.segments);
});

test('the 50-stroke display cap never restarts segment construction or changes its pen source', () => {
  const turns = [2, ...Array.from({ length: 6 }, () => [0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12]).flat()];
  const input = rowsFromTargets(turns);
  const result = analyze(input);
  assert.equal(result.bi.length, MAX_BI_COUNT + 1);
  assert.ok(result.segmentBi.length > result.bi.length);
  assert.deepEqual(result.bi, result.segmentBi.slice(-(MAX_BI_COUNT + 1)));
  assert.equal(result.segments[0].start.time, 9);
  assert.equal(result.segments[0].end.time, 33);
  assert.ok(result.segments[0].end.time < result.bi[0].time);
  const early = analyze(input.slice(0, 400));
  assert.deepEqual(result.segments[0], early.segments[0]);
  assert.equal(result.definition.segmentHistoryBars, input.length);
  assert.equal(result.definition.segmentHistoryStart, input[0].date);
  assert.ok(result.definition.historyBars < result.definition.segmentHistoryBars);
});

test('segment history uses the requested period window and retains original chart coordinates', () => {
  const turns = [2, ...Array.from({ length: 12 }, () => [0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12]).flat()];
  const input = rowsFromTargets(turns);
  const result = analyze(input);
  const offset = input.length - 1200;
  assert.equal(result.definition.segmentHistoryBars, 1200);
  assert.equal(result.definition.segmentHistoryStart, input[offset].date);
  for (const point of result.segmentBi) {
    assert.ok(point.idx >= offset);
    assert.equal(point.time, point.idx + 1);
    assert.equal(point.price, input[point.idx][point.mark === 'G' ? 'high' : 'low']);
  }
  assert.ok(result.segments.length > 0);
});

test('a cascading pen rollback retracts earlier confirmed endpoints instead of retaining orphan structure', () => {
  // Positive, valid OHLC with inclusion snapshots: three endpoints are later
  // retracted, so discarding only the latest point cannot guarantee a fixed past.
  const ranges = [[948.07, 961.9], [909.55, 942.56], [916.99, 945.25], [928.01, 973.38],
    [943.86, 985.82], [968, 988.87], [965.51, 975.24], [955.91, 1025.44],
    [958.91, 1004.5], [959.41, 1004.51], [949.2, 987.05], [981.79, 1015.43],
    [981.42, 1012.68], [942.93, 1028.45], [981.13, 1003.1], [978.92, 1006.92]];
  const input = ranges.map(([low, high], i) => ({ date: `K${i + 1}`, low, high,
    open: (high + low) / 2, close: (high + low) / 2, volume: 100, complete: true }));
  const before = analyze(input.slice(0, 12));
  assert.deepEqual(before.segmentBi.map((point) => point.time), [2, 6, 11]);
  assert.ok(before.segmentBi.slice(0, 2).every((point) => point.confirmed));
  const after = analyze(input);
  for (const key of ['bi', 'segmentBi', 'segments', 'pendingSegments']) assert.deepEqual(after[key], []);
  assert.equal(after.definition.historyBars, input.length, 'rollback restores the original available history');
});

test('a segment is withdrawn when its previously valid confirming pen is retracted', () => {
  let state = 1283762;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  let price = 1000;
  const input = Array.from({ length: 200 }, (_, i) => {
    price += (random() - 0.5) * 40;
    const width = 0.2 + random() * 10;
    return { date: `K${i + 1}`, open: price, close: price, low: price - width,
      high: price + width, volume: 100, complete: true };
  });
  const before = analyze(input.slice(0, 199));
  assert.deepEqual(before.segments.map(({ id, confirmed_time }) => ({ id, confirmed_time })), [
    { id: 'segment-13-142', confirmed_time: 199 },
  ]);
  assert.equal(before.segmentBi.find((point) => point.time === 189).confirmed, true);
  const after = analyze(input);
  assert.equal(after.segmentBi.at(-1).time, 189);
  assert.equal(after.segmentBi.at(-1).confirmed, false);
  assert.deepEqual(after.segments, []);
  const engine = analyzeReferenceCandles(candles(input));
  assert.deepEqual(after.segmentBi, engine.segmentBi);
});
