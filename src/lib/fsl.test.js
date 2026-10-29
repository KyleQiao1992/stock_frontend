import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calcFslSeries, findFslCrosses } from './fsl.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/fsl-hqchart-reference.json', import.meta.url), 'utf8'));
const near = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, actual + ' != ' + expected);
const curve = series => series.map(({ date, swl, sws }) => ({ date, swl, sws }));

for (const fixture of oracle.cases) {
  test('FSL matches independent HQChart source outputs: ' + fixture.name, () => {
    const actual = calcFslSeries(fixture.rows);
    assert.equal(actual.length, fixture.expected.length);
    actual.forEach((row, index) => {
      assert.equal(row.date, fixture.expected[index].date);
      near(row.swl, fixture.expected[index].swl);
      near(row.sws, fixture.expected[index].sws);
    });
  });
}

test('A=1 DMA boundary uses EMA12 itself, including the first four bars', () => {
  const series = calcFslSeries(oracle.cases[0].rows);
  near(series[0].sws, 10);
  near(series[3].sws, 10);
  near(series[5].sws, 10 + 12 / 13);
  assert.ok(Math.abs(series[5].sws - 10.00923076923077) > .9, 'The previous 1% adaptation must not return');
});

test('FSL has no dependency on present-day turnover or estimated historical float', () => {
  const rows = oracle.cases[1].rows;
  const withoutTurnover = rows.map(({ date, close, volume }) => ({ date, close, volume, turnover: null }));
  const highTurnover = rows.map(row => ({ ...row, turnover: 90, capital: 1 }));
  assert.deepEqual(curve(calcFslSeries(withoutTurnover)), curve(calcFslSeries(highTurnover)));
  assert.ok(calcFslSeries(withoutTurnover).every(row => Number.isFinite(row.sws) && !row.estimated));
});

test('Appending future bars never changes prior FSL values', () => {
  const input = oracle.cases[2].rows;
  assert.deepEqual(curve(calcFslSeries(input.slice(0, 20))), curve(calcFslSeries(input).slice(0, 20)));
});

test('Flat prices do not create crosses; invalid closes break the state', () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ date: String(index), close: 10, volume: 100 }));
  assert.deepEqual(findFslCrosses(calcFslSeries(rows)), []);
  rows[5].close = Number.NaN;
  rows[6].close = 20;
  const series = calcFslSeries(rows);
  assert.equal(series[5].swl, null);
  assert.equal(series[5].sws, null);
  near(series[6].swl, 20);
  near(series[6].sws, 20);
});

test('FSL crosses confirm a change of side, including an equal-value touch', () => {
  const series = [9, 10, 11, 12, 10, 9].map((swl, index) => ({ date: String(index), swl, sws: 10 }));
  assert.deepEqual(findFslCrosses(series), [
    { date: '2', type: 'golden', value: 10.5 },
    { date: '5', type: 'death', value: 9.5 },
  ]);
});

test('FSL missing data and unfinished bars cannot create confirmed crosses', () => {
  assert.deepEqual(findFslCrosses([
    { date: '1', swl: 9, sws: 10 },
    { date: '2', swl: 11, sws: null },
    { date: '3', swl: 11, sws: 10 },
    { date: '4', swl: 9, sws: 10, complete: false },
  ]), []);
});

test('A cross at the first displayed bar is retained when projecting full history', () => {
  const series = [9, 11, 12, 9].map((swl, index) => ({ date: String(index), swl, sws: 10 }));
  const visibleDates = new Set(series.slice(1).map(row => row.date));
  assert.deepEqual(findFslCrosses(series).filter(cross => visibleDates.has(cross.date)), [
    { date: '1', type: 'golden', value: 10.5 },
    { date: '3', type: 'death', value: 9.5 },
  ]);
});
