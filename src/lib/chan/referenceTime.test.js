import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceTime, buildReferenceOutlook } from './referenceOutlook.js';

test('reference time distinguishes Tencent calendar keys from Unix and ordinal keys', () => {
  const expected = Date.parse('2026-10-19T10:00:00+08:00') / 1000;
  for (const value of ['202610191000', 202610191000, '2026-10-19 10:00', expected, String(expected)]) assert.equal(referenceTime(value), expected);
  for (const value of [0, 1, 500, '500', 94668480, '94668480']) assert.equal(referenceTime(value), Number(value));
  assert.ok(Number.isNaN(referenceTime('202602301000')));
});

test('reference endpoint evidence retains minute resolution for raw Tencent inputs', () => {
  const result = buildReferenceOutlook({
    period: '5', close: 13,
    candles: [{ time: '202610191000', high: 15, low: 10, close: 13 }],
    biPoints: [{ time: '202610190935', price: 9 }, { time: '202610190955', price: 15 }],
    zsList: [{ sdt: '202610190940', edt: '202610190950', zd: 10, zg: 14,
      zd_time: '202610190940', zg_time: '202610190950' }],
  });
  assert.equal(result.asof, referenceTime('2026-10-19 10:00'));
  assert.equal(result.levels.last_bi_high_bar, '2026-10-19 09:55 @ 15.00');
  assert.equal(result.levels.zs_zd_bar, '2026-10-19 09:40 @ 10.00');
  assert.match(result.levels.zs_range, /2026-10-19 09:40 ~ 2026-10-19 09:50/);
});

test('four-hour evidence distinguishes the two bars within one trading day', () => {
  for (const period of [240, '240', '240m']) {
    const result = buildReferenceOutlook({
      period, close: 13,
      candles: [{ time: '2026-10-19 15:00', high: 15, low: 10, close: 13 }],
      biPoints: [{ time: '2026-10-16 15:00', price: 9 }, { time: '2026-10-19 13:30', price: 15 }],
      zsList: [{ sdt: '2026-10-19 13:30', edt: '2026-10-19 15:00', zd: 10, zg: 14,
        zd_time: '2026-10-19 13:30', zg_time: '2026-10-19 15:00' }],
    });
    assert.equal(result.period, '240m');
    assert.equal(result.asof, referenceTime('2026-10-19 15:00'));
    assert.equal(result.levels.last_bi_high_bar, '2026-10-19 13:30 @ 15.00');
    assert.equal(result.levels.zs_zg_bar, '2026-10-19 15:00 @ 14.00');
    assert.match(result.levels.zs_range, /2026-10-19 13:30 ~ 2026-10-19 15:00/);
  }
});
