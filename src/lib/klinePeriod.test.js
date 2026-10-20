import test from 'node:test';
import assert from 'node:assert/strict';
import { isMinutePeriod, isFourHourPeriod, periodLabel, parseKlineTime, klineDateKey, klineDateLabel, klineTradingDate } from './klinePeriod.js';

test('periods distinguish minute charts from daily, weekly and monthly charts', () => {
  for (const period of ['5', 5, '30', 30, '5m', '30m', 240, '240', '240m']) assert.equal(isMinutePeriod(period), true);
  for (const period of ['101', '102', '103', 'day', 'week', 'month', '4h']) assert.equal(isMinutePeriod(period), false);
  assert.deepEqual(['5', '30', 240, '240m', '101', '102', '103'].map(periodLabel), ['5分钟', '30分钟', '4小时', '4小时', '日K', '周K', '月K']);
  for (const period of [240, '240', '240m']) assert.equal(isFourHourPeriod(period), true);
  for (const period of [5, 30, 'day', '101', '4h', undefined]) assert.equal(isFourHourPeriod(period), false);
});

test('compact Tencent minutes and normalized minutes identify the same Shanghai instant', () => {
  const expected = Date.parse('2026-10-19T10:00:00+08:00') / 1000;
  for (const value of ['202610191000', 202610191000, '2026-10-19 10:00', '2026-10-19T10:00:00+08:00', '2026-10-19T02:00:00Z']) {
    assert.equal(parseKlineTime(value), expected);
    assert.equal(klineDateKey(value), '2026-10-19 10:00');
    assert.equal(klineTradingDate(value), '2026-10-19');
  }
  assert.equal(klineDateKey('2026-10-18T19:00:00-04:00'), '2026-10-19 07:00');
});

test('calendar validation rejects invalid dates without silently rolling to another session', () => {
  for (const value of ['202602301000', '2026-02-30 10:00', '2026-13-19', '202610192400', '202610191060',
    '202613191000', '2026-10-19 10:00:60', '2026-10-19 10:00+08:60', '2026-10-19 garbage', null, '', undefined]) {
    assert.ok(Number.isNaN(parseKlineTime(value)), String(value));
    assert.equal(klineDateKey(value), '', String(value));
    assert.equal(klineDateLabel(value), '—', String(value));
  }
  assert.equal(klineDateKey('2024-02-29'), '2024-02-29');
  assert.equal(klineDateKey('2023-02-29'), '');
});

test('Unix seconds, milliseconds and ordinal coordinates keep their numeric meaning', () => {
  const expected = Date.parse('2026-10-19T10:00:00+08:00') / 1000;
  for (const value of [expected, String(expected), expected * 1000, String(expected * 1000)]) assert.equal(parseKlineTime(value), expected);
  for (const value of [0, 1, 123, '123', 94668480, '94668480']) assert.equal(parseKlineTime(value), Number(value));
  assert.ok(Number.isNaN(parseKlineTime(Infinity)));
});

test('date labels retain minute and session context while daily labels retain their existing shape', () => {
  assert.equal(klineDateLabel('2026-10-19'), '2026-10-19');
  assert.equal(klineDateLabel('2026-10-19', { compact: true }), '10-19');
  assert.equal(klineDateLabel('2026-10-19 10:00', { compact: true }), '10-19 10:00');
  assert.equal(klineDateLabel('2026-10-19 10:00', { weekday: true }), '2026/10/19 周一 10:00');
  assert.equal(klineDateLabel('2026-10-19', { weekday: true }), '2026/10/19 周一');
});

test('the two four-hour chart windows retain separate Shanghai close timestamps', () => {
  const first = '2026-10-19 13:30';
  const second = '2026-10-19 15:00';
  assert.notEqual(klineDateKey(first), klineDateKey(second));
  assert.equal(klineTradingDate(first), klineTradingDate(second));
  assert.equal(parseKlineTime(second) - parseKlineTime(first), 90 * 60);
  assert.equal(klineDateLabel(first, { compact: true }), '10-19 13:30');
  assert.equal(klineDateLabel(second, { weekday: true }), '2026/10/19 周一 15:00');
});
