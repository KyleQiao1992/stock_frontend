import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';
import { retractionRows } from './fixtures/segmentGap.js';

// A recorded historical confirmation must be observable in the K-line prefix
// ending at that time. It may later be retracted, so this checks only the pens
// surviving the later replay and does not assume their endpoints are locked.
function checkObservationPrefixes(rows) {
  const points = analyzeChan(rows).bi;
  let checked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (!start.confirmed) continue;
    const observed = analyzeChan(rows.slice(0, start.confirmed_time)).bi;
    const position = observed.findIndex(point => point.time === start.time && point.price === start.price
      && point.mark === start.mark && point.confirmed && point.confirmed_time === start.confirmed_time);
    assert.ok(position >= 0, `pen beginning at ${start.time} was absent at confirmation ${start.confirmed_time}`);
    assert.deepEqual(
      [observed[position + 1]?.time, observed[position + 1]?.price, observed[position + 1]?.mark],
      [end.time, end.price, end.mark],
      `pen ending at ${end.time} was not observable at confirmation ${start.confirmed_time}`,
    );
    checked++;
  }
  return checked;
}

const source = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));

for (const sign of [1, -1]) for (const explicit of [false, true]) {
  test(`600851 surviving pen confirmations are visible at their recorded time (sign ${sign}, explicit ${explicit})`, () => {
    const rows = source.map(row => ({ ...row, open: sign * row.open, close: sign * row.close,
      high: sign === 1 ? row.high : -row.low, low: sign === 1 ? row.low : -row.high,
      ...(explicit ? { complete: true } : {}),
    }));
    assert.ok(checkObservationPrefixes(rows) > 0, 'the audit must exercise completed pens');
  });
}

test('retraction stress cases do not backdate surviving pen confirmations', () => {
  let count = 0;
  for (let seed = 1; seed <= 30; seed++) count += checkObservationPrefixes(retractionRows(seed));
  assert.ok(count > 30, 'the stress cases must exercise multiple confirmed pens');
});
