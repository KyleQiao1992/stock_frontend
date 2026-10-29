import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';

// Tencent 600851 qfq daily, 2024-03-05..2026-10-27. These checks are
// conditional on the engine's pen sequence and the loaded history: they do
// not prove that the entire pen sequence or all historical data are correct.
const source = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
const dated = (rows, point) => [rows[point.time - 1].date, point.price];
const priceOf = (rows, points, date) => points.find(point => rows[point.time - 1].date === date)?.price;

for (const sign of [1, -1]) {
  test(`600851 corrected pen history: first segment has a standard feature fractal (sign ${sign})`, () => {
    const rows = source.map(row => sign === 1 ? row : ({ ...row, open: -row.open, close: -row.close,
      high: -row.low, low: -row.high }));
    const result = analyzeChan(rows);
    const p = date => sign * priceOf(rows, result.segmentBi, date);
    // In positive-price orientation the left down-segment feature, its
    // unmerged first reverse stroke, and the next same-direction feature are:
    const left = [p('2024-04-16'), p('2024-05-08')];
    const middle = [p('2024-07-09'), p('2024-08-07')];
    const inner = [p('2024-08-28'), p('2024-09-09')];
    const right = [p('2024-09-18'), p('2024-10-08')];
    assert.deepEqual([left, middle, inner, right], [
      [4.815, 6.225], [4.195, 5.93], [4.6, 5.01], [4.5, 6.65],
    ]);
    // The inner feature is contained by the middle. Downward containment
    // processing gives [4.195,5.01], below both neighbours in both bounds.
    assert.ok(middle[0] < inner[0] && inner[1] < middle[1]);
    const normalized = [Math.min(middle[0], inner[0]), Math.min(middle[1], inner[1])];
    assert.ok(normalized[0] < left[0] && normalized[1] < left[1]);
    assert.ok(normalized[0] < right[0] && normalized[1] < right[1]);
    const first = result.segments[0];
    assert.deepEqual(dated(rows, first.start), ['2024-04-01', sign * 5.785]);
    assert.deepEqual(dated(rows, first.end), ['2024-07-09', sign * 4.195]);
    assert.equal(rows[first.confirmed_time - 1].date, '2024-10-16');
  });

  test(`600851 corrected pen history: contained reversal does not force early segment end (sign ${sign})`, () => {
    const rows = source.map(row => sign === 1 ? row : ({ ...row, open: -row.open, close: -row.close,
      high: -row.low, low: -row.high }));
    const result = analyzeChan(rows);
    const p = date => sign * priceOf(rows, result.segmentBi, date);
    // 2024-12-17 reversal: its first and third downward pens are
    // 8.49→5.11 and 7.47→6.20. The third remains inside the first.
    assert.deepEqual(['2024-12-17', '2025-01-13', '2025-06-09', '2025-06-23'].map(p),
      [8.49, 5.11, 7.47, 6.2]);
    assert.ok(p('2025-01-13') < p('2025-06-23') && p('2025-06-09') < p('2024-12-17'));
    const points = result.segmentBi;
    const from = points.findIndex(point => rows[point.time - 1].date === '2025-06-23');
    const breakthrough = points.findIndex(point => rows[point.time - 1].date === '2026-02-12');
    assert.ok(from >= 0 && breakthrough > from);
    assert.ok(points.slice(from, breakthrough).every(point => sign * point.price > 5.11 && sign * point.price < 8.49));
    assert.ok(sign * points[breakthrough].price > 8.49);

    // In contrast the 2026-03-10 candidate has first and third downward
    // strokes ending 7.08 and 6.88: the third breaks the first's endpoint.
    assert.deepEqual(['2026-03-10', '2026-03-24', '2026-04-02', '2026-06-08'].map(p),
      [9.13, 7.08, 8.95, 6.88]);
    assert.ok(p('2026-06-08') < p('2026-03-24'));
    const beforeRows = rows.filter(row => row.date <= '2026-06-25');
    assert.equal(analyzeChan(beforeRows).segments.length, 1);
    const observedRows = rows.filter(row => row.date <= '2026-06-26');
    const atConfirmation = analyzeChan(observedRows);
    assert.equal(atConfirmation.segments.length, 2);
    const segment = atConfirmation.segments[1];
    assert.deepEqual(dated(observedRows, segment.start), ['2024-07-09', sign * 4.195]);
    assert.deepEqual(dated(observedRows, segment.end), ['2026-03-10', sign * 9.13]);
    assert.equal(observedRows[segment.confirmed_time - 1].date, '2026-06-26');
  });
}
