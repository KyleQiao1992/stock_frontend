import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';

const source = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));

for (const sign of [1, -1]) {
  const asOf = date => source.filter(row => row.date <= date).map(row => sign === 1 ? row : ({
    ...row, open: -row.open, close: -row.close, high: -row.low, low: -row.high,
  }));

  test(`600851 dynamic pen uses a later K when the endpoint K shares the extreme (sign ${sign})`, () => {
    const rows = asOf('2024-06-27');
    const result = analyzeChan(rows);
    assert.equal(rows[result.pending[0].time - 1].date, '2024-06-26');
    assert.equal(rows[result.pending[1].time - 1].date, '2024-06-27',
      'the same high repeated on the next K proves it happened after the low');
    assert.equal(result.pending[0].price, sign * 4.385);
    assert.equal(result.pending[1].price, sign * 4.575);
    assert.deepEqual(result.pendingUncertainty, []);
  });

  test(`600851 retains unknown endpoint-K order when it affects the tail extreme (sign ${sign})`, () => {
    const rows = asOf('2024-12-27');
    const result = analyzeChan(rows);
    const [start, end] = result.pending;
    assert.equal(rows[start.time - 1].date, '2024-12-25');
    assert.equal(start.price, sign * 5.8);
    assert.equal(rows[end.time - 1].date, '2024-12-27');
    assert.equal(end.price, sign * 6.06);
    assert.equal(result.pendingUncertainty.length, 1);
    const uncertainty = result.pendingUncertainty[0];
    assert.equal(uncertainty.reason, 'endpoint_order');
    assert.equal(rows[uncertainty.endpoint_time - 1].date, '2024-12-25');
    assert.equal(uncertainty.guaranteed_price, sign * 6.06);
    assert.equal(uncertainty.possible_price, sign * 6.18,
      'the endpoint-K high or low might occur before the turning point');
  });
}
