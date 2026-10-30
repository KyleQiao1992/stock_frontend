import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChan } from './index.js';
import { zoneLifecycleRows } from './fixtures/zoneLifecycle.js';

test('a malformed K line cannot be deleted to fabricate strokes, segments, or centers across its position', () => {
  const rows = zoneLifecycleRows(114);
  rows[19].high = null;
  const result = analyzeChan(rows, 'day');
  assert.deepEqual(result.inputProblem, { reason: 'invalid_candle', index: 19, date: rows[19].date });
  assert.equal(result.segments.length, 0);
  assert.equal(result.zs.length, 0);
  assert.equal(result.bi.length, 0);
  assert.equal(result.outlook.ok, false);
  assert.equal(result.outlook.reason, 'invalid_candle');
});

test('missing fields, impossible price ranges and duplicate timestamps are not normalized into continuous evidence', () => {
  for (const change of [
    rows => { rows[19].date = ''; },
    rows => { rows[19].date = rows[18].date; },
    rows => { rows[19].close = rows[19].high + 1; },
    rows => { rows[19].volume = NaN; },
  ]) {
    const rows = zoneLifecycleRows(114); change(rows);
    const result = analyzeChan(rows, 'day');
    assert.ok(result.inputProblem, 'invalid row is disclosed');
    assert.equal(result.segments.length, 0);
    assert.equal(result.zs.length, 0);
  }
});

test('complete valid inputs retain normal analysis and an open last K is not malformed', () => {
  const rows = zoneLifecycleRows(114);
  const regular = analyzeChan(rows, 'day');
  assert.equal(regular.inputProblem, undefined);
  assert.equal(regular.zs.length, 1);
  rows.at(-1).complete = false;
  assert.equal(analyzeChan(rows, 'day').inputProblem, undefined);
});

test('out-of-order daily and intraday bars cannot establish continuous Chan structures', () => {
  for (const minute of [false, true]) {
    const rows = zoneLifecycleRows(114);
    if (minute) rows.forEach(row => { row.date += ' 09:30'; });
    [rows[18], rows[19]] = [rows[19], rows[18]];
    const result = analyzeChan(rows, minute ? '5m' : 'day');
    assert.deepEqual(result.inputProblem, { reason: 'invalid_candle', index: 19, date: rows[19].date });
    assert.equal(result.bi.length, 0);
    assert.equal(result.zs.length, 0);
  }
});

test('calendar histories reject invalid dates and mixed time formats instead of joining structures', () => {
  for (const date of ['2024-02-30', 'not-a-date', '2024-02-10 09:30']) {
    const rows = zoneLifecycleRows(114);
    rows[40].date = date;
    const result = analyzeChan(rows, 'day');
    assert.deepEqual(result.inputProblem, { reason: 'invalid_candle', index: 40, date });
    assert.equal(result.bi.length, 0);
    assert.equal(result.zs.length, 0);
  }
  const badFirst = zoneLifecycleRows(114);
  badFirst[0].date = 'not-a-date';
  const result = analyzeChan(badFirst, 'day');
  assert.deepEqual(result.inputProblem, { reason: 'invalid_candle', index: 0, date: 'not-a-date' });
  assert.equal(result.zs.length, 0);
});
