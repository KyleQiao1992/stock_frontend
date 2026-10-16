import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan, visibleOffset } from './index.js';
import { findReferenceFractals } from './referenceEngine.js';

const rows = (ranges) => ranges.map(([high, low], i) => ({
  high, low, open: low, close: high, volume: 100,
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
}));
const points = (items) => items.map(({ mark, time, price }) => [mark, time, price]);

for (const [name, ranges, expected] of [
  ['top', [[8,4],[10,6],[11,5],[9,4]], ['G',3,11]],
  ['bottom', [[16,12],[14,10],[15,9],[16,11]], ['D',3,9]],
]) {
  test(`${name}: main analysis merges inclusion and maps the extreme back to its original candle`, () => {
    const input = rows(ranges);
    const snapshot = structuredClone(input);
    // Directly scanning these ordinary K bars would find nothing.
    assert.deepEqual(findReferenceFractals(input), []);
    const result = analyzeChan(input);
    assert.deepEqual(points(result.fx), [expected]);
    assert.equal(result.fx[0].idx, 2);
    assert.equal(result.dates[result.fx[0].idx], '2026-01-03');
    assert.equal(result.fx[0].price, input[2][name === 'top' ? 'high' : 'low']);
    // ChanOverlay uses time - 1 - visibleOffset on the original chart rows.
    assert.equal(result.fx[0].time - 1 - visibleOffset(result, input.slice(1)), 1);
    assert.deepEqual(input, snapshot);
  });
}

for (const [name, ranges, first, last] of [
  ['up', [[3,2],[2,1],[3,2],[4,3],[5,4],[4,3]], ['D',2,1], ['G',5,5]],
  ['down', [[8,7],[9,8],[8,7],[7,6],[6,5],[7,6]], ['G',2,9], ['D',5,5]],
]) {
  test(`${name}: omitted first circle remains a pen endpoint in the reference output convention`, () => {
    const input = rows(ranges);
    assert.deepEqual(points(analyzeChan(input.slice(0, 3)).fx), [first]);
    const result = analyzeChan(input);
    assert.deepEqual(points(result.fx), [last]);
    assert.deepEqual(points(result.bi), [first, last]);
    assert.deepEqual(points(result.biLine.slice(0, 2)), [first, last]);
    // This verifies the output contract, not the general correctness of pen rules.
  });
}
