import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMarketKlines, marketNumber } from './marketKlineIntegrity.js';

const rows = () => [
  { date: '2026-10-21', open: 10, high: 12, low: 9, close: 11, volume: 1 },
  { date: '2026-10-22', open: 11, high: 13, low: 10, close: 12, volume: 0 },
];

test('provider number conversion never treats null or blank as a price or volume', () => {
  for (const value of [null, undefined, '', '  ', 'abc']) assert.equal(Number.isNaN(marketNumber(value)), true);
  assert.equal(marketNumber('0'), 0);
  assert.equal(marketNumber('12.5'), 12.5);
});

test('a malformed middle price, missing volume, duplicate or unsorted date rejects the series', () => {
  for (const mutate of [
    data => { data[1].high = NaN; }, data => { data[1].high = 0; },
    data => { data[1].low = 14; }, data => { data[1].volume = NaN; },
    data => { data[1].date = data[0].date; }, data => { data[1].date = '2026-10-20'; },
    data => { data[1].date = '2026-11-31'; },
    data => { data[1].date = '2026-10-22 09:35'; },
  ]) {
    const data = rows(); mutate(data);
    assert.throws(() => assertMarketKlines(data), /K 线.*格式异常/);
  }
});

test('valid zero volume and actual full input are preserved', () => {
  const data = rows();
  assert.equal(assertMarketKlines(data), data);
});

test('cash-adjusted history can cross zero without losing any candle', () => {
  // Tencent sh600851 qfqmonth, 1994-07-29 (captured 2026-10-28).
  const data = [
    { date: '1994-07-29', open: .322, close: -.074, high: .330, low: -.107, volume: 10993.550 },
    { date: '1994-08-31', open: 0, close: .1, high: .2, low: -.05, volume: 0 },
  ];
  assert.equal(assertMarketKlines(data, { adjusted: true }), data);
  assert.throws(() => assertMarketKlines(data), /第 1 行/);
  for (const row of [data[1], { ...data[1], open: 0, high: 0, low: 0, close: 0 }]) {
    assert.throws(() => assertMarketKlines([row]), /第 1 行/);
    assert.equal(assertMarketKlines([row], { adjusted: true })[0], row);
  }
});

test('adjusted prices still require finite fields, nonnegative volume and valid geometry', () => {
  const valid = { date: '1994-07-29', open: .322, close: -.074, high: .330, low: -.107, volume: 10993.550 };
  for (const invalid of [
    { ...valid, close: NaN }, { ...valid, high: -.1 }, { ...valid, low: 0 },
    { ...valid, volume: -1 }, { ...valid, volume: NaN },
  ]) assert.throws(() => assertMarketKlines([invalid], { adjusted: true }), /第 1 行/);
});
