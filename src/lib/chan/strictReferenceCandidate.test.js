import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analyzeStrictReferenceCandidate } from './strictReferenceCandidate.js';

test('experimental adapter retains the basic old-pen and unfinished-candle contracts', () => {
  const ranges = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];
  const input = ranges.map(([high, low], i) => ({ time: i + 1, high, low, open: low, close: high, vol: 10 }));
  const initial = analyzeStrictReferenceCandidate(input);
  assert.deepEqual(initial.bi.map(p => [p.time, p.mark, p.confirmed]), [[2, 'D', false], [6, 'G', false]]);
  const next = analyzeStrictReferenceCandidate([...input, { time: 8, high: 4, low: 3, open: 3, close: 4, vol: 10 }]);
  assert.equal(next.bi[0].confirmed_time, 8);
  assert.equal(next.pending.at(-1).time, 8);
  assert.throws(() => analyzeStrictReferenceCandidate([{ ...input[0], time: 2 }]), /one-based/);
});

const directory = new URL('./fixtures/reference/', import.meta.url);
for (const name of readdirSync(directory).filter(file => file.endsWith('.json'))) {
  test(`experimental strict engine preserves source price and detail: ${name}`, () => {
    const capture = JSON.parse(readFileSync(new URL(name, directory)));
    const candles = capture.candles.map((c, i) => ({ ...c, time: i + 1 }));
    const result = analyzeStrictReferenceCandidate(candles);
    for (const kind of ['fx', 'bi']) for (const p of result[kind]) {
      assert.equal(p.idx, p.time - 1);
      assert.equal(p.price, candles[p.idx][p.mark === 'G' ? 'high' : 'low']);
      assert.equal(result.fractalDetails[kind][p.time].isValid, true);
    }
    for (let i = 1; i < result.bi.length; i++) {
      const a = result.fractalDetails.bi[result.bi[i - 1].time].mergedCandles[2];
      const b = result.fractalDetails.bi[result.bi[i].time].mergedCandles[0];
      assert.ok(a.to + 1 < b.from, 'endpoint fractals leave an independent K');
    }
    if (result.pending.length) {
      const pending = result.pending.at(-1);
      assert.equal(pending.price, candles[pending.idx][pending.mark === 'G' ? 'high' : 'low']);
    }
  });
}
