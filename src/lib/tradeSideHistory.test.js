import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADE_SIDE_HISTORY_RANGES, selectTradeSideDateRange,
  summarizeTradeSideRows, formatTradeVolume, formatTradeRatio } from './tradeSideHistory.js';

const currentTime = Date.parse('2026-10-14T08:30:00Z');
const closeRow = (date, innerVol = 5, outerVol = 15) => ({ date, complete: true, innerVol, outerVol });

test('date options use the requested week and calendar-month windows', () => {
  assert.deepEqual(TRADE_SIDE_HISTORY_RANGES.map(({ id, label }) => ({ id, label })), [
    { id: '1w', label: '近一周' }, { id: '2w', label: '近2周' },
    { id: '3w', label: '近3周' }, { id: '1m', label: '近一月' }, { id: '2m', label: '近2月' },
  ]);
  const allDates = Array.from({ length: 76 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 1 + i));
    return closeRow(date.toISOString().slice(0, 10));
  });
  const input = allDates.toReversed();
  const expected = [
    ['1w', '2026-10-08', 7], ['2w', '2026-10-01', 14], ['3w', '2026-09-24', 21],
    ['1m', '2026-09-15', 30], ['2m', '2026-08-15', 61],
  ];
  for (const [id, startDate, days] of expected) {
    const result = selectTradeSideDateRange(input, id, currentTime);
    assert.equal(result.startDate, startDate);
    assert.equal(result.endDate, '2026-10-14');
    assert.equal(result.rows.length, days);
    assert.equal(result.rows[0].date, startDate);
    assert.equal(result.rows.at(-1).date, '2026-10-14');
    assert.equal(result.label, TRADE_SIDE_HISTORY_RANGES.find(range => range.id === id).label);
  }
  assert.deepEqual(input, allDates.toReversed(), 'range selection must not reorder the input');
});

test('calendar months clamp their boundary to valid month ends including leap years', () => {
  const examples = [
    ['2024-03-31', '1m', '2024-03-01'],
    ['2025-03-31', '1m', '2025-03-01'],
    ['2024-03-31', '2m', '2024-02-01'],
    ['2024-02-29', '1m', '2024-01-30'],
    ['2026-01-31', '1m', '2026-01-01'],
    ['2026-01-31', '2m', '2025-12-01'],
  ];
  for (const [endDate, id, startDate] of examples) {
    const result = selectTradeSideDateRange([], id, `${endDate}T04:00:00Z`);
    assert.equal(result.startDate, startDate);
    assert.equal(result.endDate, endDate);
  }
});

test('the current Beijing date defines the end date at the midnight boundary', () => {
  const rows = [closeRow('2026-10-07'), closeRow('2026-10-08'), closeRow('2026-10-14')];
  const before = selectTradeSideDateRange(rows, '1w', Date.parse('2026-10-13T15:59:59.999Z'));
  const after = selectTradeSideDateRange(rows, '1w', Date.parse('2026-10-13T16:00:00Z'));
  assert.equal(before.endDate, '2026-10-13');
  assert.equal(before.startDate, '2026-10-07');
  assert.deepEqual(before.rows.map(row => row.date), ['2026-10-07', '2026-10-08']);
  assert.equal(after.endDate, '2026-10-14');
  assert.equal(after.startDate, '2026-10-08');
  assert.deepEqual(after.rows.map(row => row.date), ['2026-10-08', '2026-10-14']);
});

test('stale data does not shift the range into the past or create missing trading days', () => {
  const stale = selectTradeSideDateRange([closeRow('2026-07-01')], '2m', currentTime);
  assert.equal(stale.endDate, '2026-10-14');
  assert.deepEqual(stale.rows, []);
  const sparse = selectTradeSideDateRange([
    closeRow('2026-09-30'), closeRow('2026-10-09'), closeRow('2026-10-14'),
  ], '2w', currentTime);
  assert.equal(sparse.startDate, '2026-10-01');
  assert.deepEqual(sparse.rows.map(row => row.date), ['2026-10-09', '2026-10-14']);
  assert.equal(summarizeTradeSideRows(sparse.rows).days, 2);
});

test('selection rejects invalid dates and future rows while retaining real leap dates', () => {
  const rows = [
    closeRow('2024-02-29'), closeRow('2024-03-14'), closeRow('2024-03-15'),
    closeRow('2024-02-30'), closeRow('2024-03-00'), closeRow('2024-13-01'),
    closeRow('2024-3-01'), closeRow('2024-03-01T00:00:00Z'), closeRow(null), null,
  ];
  const result = selectTradeSideDateRange(rows, '1m', '2024-03-14T00:00:00Z');
  assert.deepEqual(result.rows.map(row => row.date), ['2024-02-29', '2024-03-14']);
  assert.deepEqual(selectTradeSideDateRange(undefined, '1w', currentTime).rows, []);
  assert.equal(selectTradeSideDateRange([], 'unknown', currentTime).label, '近一周');
  assert.throws(() => selectTradeSideDateRange([], '1w', NaN), RangeError);
});

test('closed-day summary weights actual volumes and excludes unfinished snapshots', () => {
  const result = summarizeTradeSideRows([
    {date:'2026-10-09', complete:true, innerVol:10, outerVol:90},
    {date:'2026-10-12', complete:true, innerVol:900, outerVol:100},
    {date:'2026-10-13', complete:false, innerVol:0, outerVol:5000},
  ]);
  assert.equal(result.days, 2);
  assert.equal(result.netVol, -720);
  assert.equal(result.netRatio, -720 / 1100 * 100);
  assert.equal(result.lastDate, '2026-10-12');
});

test('missing and zero-volume records never imply a balanced multi-day trend', () => {
  assert.equal(summarizeTradeSideRows([{complete:true, innerVol:0, outerVol:0}]), null);
  assert.equal(summarizeTradeSideRows([{complete:false, innerVol:10, outerVol:10}]), null);
  assert.equal(summarizeTradeSideRows(undefined), null);
});

test('statistics accumulate every supplied closed record and retain their sorted date range', () => {
  const rows = Array.from({length:8}, (_, i) => ({date:`2026-10-${String(i + 1).padStart(2,'0')}`, complete:true, innerVol:5, outerVol:15}));
  const result = summarizeTradeSideRows(rows.toReversed());
  assert.equal(result.days, 8);
  assert.equal(result.firstDate, '2026-10-01');
  assert.equal(result.lastDate, '2026-10-08');
  assert.equal(result.innerVol, 40);
  assert.equal(result.outerVol, 120);
  assert.equal(result.netVol, 80);
  assert.equal(result.netRatio, 50);
  assert.equal(summarizeTradeSideRows(rows.toReversed(), 3).firstDate, '2026-10-06');
  assert.equal(summarizeTradeSideRows(rows, 0), null);
});

test('summary follows the selected date range and excludes intraday and malformed quantities', () => {
  const result = selectTradeSideDateRange([
    closeRow('2026-10-07', 10000, 0), closeRow('2026-10-08', 10, 90),
    closeRow('2026-10-12', 900, 100),
    { ...closeRow('2026-10-14', 0, 5000), complete: false },
    closeRow('2026-10-13', -1, 100), closeRow('2026-10-13', NaN, 100),
    closeRow('2026-10-13', 10, Infinity), closeRow('2026-10-00', 10, 100), null,
  ], '1w', currentTime);
  const summary = summarizeTradeSideRows(result.rows);
  assert.equal(summary.days, 2);
  assert.equal(summary.firstDate, '2026-10-08');
  assert.equal(summary.lastDate, '2026-10-12');
  assert.equal(summary.netVol, -720);
  assert.equal(summary.netRatio, -720 / 1100 * 100);
  assert.equal(summarizeTradeSideRows([closeRow('2026-02-29')]), null);
});

test('volume formatting keeps lots distinct from money and missing values', () => {
  assert.equal(formatTradeVolume(150901), '15.09万手');
  assert.equal(formatTradeVolume(-12391, true), '−1.24万手');
  assert.equal(formatTradeVolume(null), '—');
  assert.equal(formatTradeRatio(null), '—');
  assert.equal(formatTradeRatio(0, true), '0.00%');
});

test('official history accumulates whole shares before converting fractional lots', () => {
  const rows = [1, 2, 3].map(day => ({ date: `2026-10-0${day}`, complete: true,
    innerVol: 0.01, outerVol: 0.02,
    sourceVolumes: { innerShares: 1, outerShares: 2 } }));
  const result = summarizeTradeSideRows(rows);
  assert.equal(result.innerVol, 0.03);
  assert.equal(result.outerVol, 0.06);
  assert.equal(result.netVol, 0.03);
  assert.equal(result.netRatio, 3 / 9 * 100);
});
