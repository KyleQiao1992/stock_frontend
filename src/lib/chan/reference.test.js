import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { referenceFractals } from './referenceFractal.js';
import { buildZs } from './referenceZs.js';
import { compareReference, firstDifference } from './referenceParity.js';
import { analyzeChan, visibleOffset } from './index.js';
import { analyzeReferenceCandles } from './referenceEngine.js';

const directory = new URL('./fixtures/reference/', import.meta.url);
const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name, data: JSON.parse(readFileSync(new URL(name, directory), 'utf8')) }));
const epochRows = (candles) => candles.map(({ time, vol, ...bar }) => ({ ...bar, date: String(time), volume: vol }));
const calendarDate = (time, period) => new Date((time + 8 * 3600) * 1000).toISOString()
  .slice(0, period.endsWith('m') ? 16 : 10).replace('T', ' ');

function assertProductionInvariants(result, rows) {
  for (const kind of ['fx', 'bi']) for (const point of result[kind]) {
    assert.equal(point.idx, point.time - 1);
    assert.equal(point.price, rows[point.idx][point.mark === 'G' ? 'high' : 'low']);
    assert.equal(result.fractalDetails[kind][point.time].isValid, true);
  }
  for (let i = 1; i < result.bi.length; i++) {
    const previous = result.bi[i - 1], current = result.bi[i];
    assert.ok(current.time > previous.time);
    assert.notEqual(current.mark, previous.mark);
    const left = result.fractalDetails.bi[previous.time].mergedCandles[2];
    const right = result.fractalDetails.bi[current.time].mergedCandles[0];
    assert.ok(left.to + 1 < right.from, 'endpoint fractals must leave an independent K');
    const top = previous.mark === 'G' ? previous : current;
    const bottom = previous.mark === 'D' ? previous : current;
    assert.ok(top.price > bottom.price);
  }
  if (result.pending.length) {
    const endpoint = result.pending.at(-1);
    assert.equal(endpoint.confirmed, false);
    assert.ok(endpoint.time >= result.bi.at(-1).time);
    assert.equal(endpoint.idx, endpoint.time - 1);
    assert.equal(endpoint.price, rows[endpoint.idx][endpoint.mark === 'G' ? 'high' : 'low']);
    const after = rows.slice(result.bi.at(-1).idx);
    assert.equal(endpoint.price, endpoint.mark === 'G'
      ? Math.max(...after.map((bar) => bar.high)) : Math.min(...after.map((bar) => bar.low)));
  }
  const zoneShape = ({ sdt, edt, zg, zd, zz, bi_count }) => [sdt, edt, zg, zd, zz, bi_count];
  assert.deepEqual(result.zs.map(zoneShape), buildZs(result.bi).map(zoneShape));
  assert.deepEqual(result.historyDates, result.analysisCandles.map((bar) => rows[bar.time - 1].date));
}

for (const { name, data } of fixtures) {
  test(`reference capture ${name}: candles, pen references and zone boundaries are consistent`, () => {
    const source = new URL(data.source);
    assert.equal(source.searchParams.get('symbol'), data.symbol);
    assert.equal(source.searchParams.get('market'), data.market);
    assert.equal(source.searchParams.get('period'), data.period);
    const times = new Set(data.candles.map((c) => c.time));
    assert.equal(times.size, data.candles.length);
    assert.equal(data.stats.bars, data.candles.length);
    // Preserve the site's actual response, including its observed metadata bug.
    // Tencent HK day returned stats.fx=106 but only 105 drawable fractals.
    if (name === 'hk00700-day.json') {
      assert.equal(data.stats.fx, 106);
      assert.equal(data.fx.length, 105);
    } else assert.equal(data.stats.fx, data.fx.length);
    assert.equal(data.stats.bi_trades, data.trades.length);
    for (let i = 1; i < data.candles.length; i++) assert.ok(data.candles[i].time > data.candles[i - 1].time);
    for (const p of [...data.fx, ...data.bi, ...data.trades]) {
      assert.ok(times.has(p.time));
      assert.ok(Number.isFinite(p.price));
    }
    for (const z of data.zs) {
      assert.ok(times.has(z.sdt) && times.has(z.edt));
      assert.ok(z.sdt < z.edt && z.zd < z.zg);
      assert.equal(z.algorithm, 'sliding_window');
    }
    assert.deepEqual(data.bi.slice(0, data.trades.length), data.trades.map(({ time, price }) => ({ time, price })));
  });

  test(`website fractal candidate ${name}: every time, price and direction matches the captured API`, () => {
    assert.deepEqual(referenceFractals(data.candles).fx, data.fx);
  });

  test(`website zone candidate ${name}: oracle pens reproduce every zone boundary and member count`, () => {
    assert.deepEqual(buildZs(data.trades), data.zs);
  });

  test(`production rules ${name}: valid endpoints, independent K, real dynamic date; historical parity is diagnostic`, (t) => {
    const rows = epochRows(data.candles);
    const result = analyzeChan(rows, data.period);
    assertProductionInvariants(result, rows);
    const report = compareReference(data);
    assert.equal(report.currentDefinition, result.definition.id);
    const differences = Object.entries(report.checks).filter(([, check]) => check.difference !== null);
    t.diagnostic(`Saved API differences: ${differences.map(([key, check]) => `${key}(${check.expectedCount}→${check.actualCount})`).join(', ') || 'none'}`);
    const first = report.checks.bi.difference;
    if (first) t.diagnostic(`First historical pen difference: ${JSON.stringify(first)}`);
    // The saved response is an unchanged historical oracle, not an authority
    // overriding the independent-K or real-extremum-location requirements.
  });

  test(`calendar input ${name}: epoch and +08 date representations produce equivalent structures and outlook`, () => {
    const rows = data.candles.map(({ time, vol, ...bar }) => ({ ...bar,
      date: calendarDate(time, data.period), volume: vol }));
    const result = analyzeChan(rows, { day: '101', week: '102' }[data.period] || data.period);
    const epoch = analyzeChan(epochRows(data.candles), data.period);
    for (const kind of ['fx', 'bi', 'pending', 'biLine', 'zs']) assert.deepEqual(result[kind], epoch[kind]);
    assert.deepEqual(result.outlook, epoch.outlook);
    assertProductionInvariants(result, rows);
  });
}

test('outlook parity fails when the actual classification, boundary timestamp, condition or scenario score differs', () => {
  const source = fixtures.find(({ name }) => name === 'sh603818-day.json').data;
  // This local fixture only isolates comparator behavior. Do not edit the saved
  // historical capture, or require its old pen policy to match production.
  const currentOutlook = analyzeChan(epochRows(source.candles), source.period).outlook;
  const comparatorFixture = { ...source, outlook: currentOutlook };
  const baseline = compareReference(comparatorFixture);
  assert.equal(baseline.checks.outlook.difference, null);
  for (const change of [
    (outlook) => { outlook.conclusion.kind_hint = 'B3'; },
    (outlook) => { outlook.levels.zs_zg_bar = '2026-04-01 @ 3.68'; },
    (outlook) => { outlook.conclusion.trigger_condition = '替换条件'; },
    (outlook) => { outlook.scenarios[0].score = 8; },
  ]) {
    const fixture = structuredClone(comparatorFixture);
    change(fixture.outlook);
    const report = compareReference(fixture);
    assert.equal(report.matches, false);
    assert.notEqual(report.checks.outlook.difference, null);
    assert.deepEqual(report.checks.bi, baseline.checks.bi);
  }
});

test('parity compares point locations and prices, including trailing points', () => {
  assert.equal(firstDifference([[1, 2]], [[1, 2]]), null);
  assert.deepEqual(firstDifference([[1, 2]], [[2, 2]]), { index: 0, expected: [1, 2], actual: [2, 2] });
  assert.deepEqual(firstDifference([[1, 2]], [[1, 2], [3, 4]]), { index: 1, expected: null, actual: [3, 4] });
});

test('603818 day oracle preserves 23 strokes, ten sliding zones and the actual dynamic endpoint', () => {
  const fixture = fixtures.find(({ name }) => name === 'sh603818-day.json').data;
  assert.equal(fixture.stats.bi, 23);
  assert.equal(fixture.zs.length, 10);
  assert.equal(fixture.zs.at(-1).zg, 3.68);
  assert.equal(fixture.zs.at(-1).zd, 3.25);
  assert.equal(fixture.bi.at(-1).time, fixture.candles.at(-1).time);
  assert.equal(fixture.bi.at(-1).price, 3.75);
  assert.equal(fixture.candles.at(-1).close, 4.05);
});

test('300 original Tencent bars preserve raw coordinates after rule-driven trimming, without inventing current-date extremes', (t) => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/input/sh603818-day-300.json', import.meta.url), 'utf8'));
  const fixture = fixtures.find(({ name }) => name === 'sh603818-day.json').data;
  const report = compareReference(fixture, input.candles);
  t.diagnostic(`Unchanged saved API comparison: ${JSON.stringify(Object.fromEntries(Object.entries(report.checks)
    .map(([key, check]) => [key, { expected: check.expectedCount, actual: check.actualCount, differs: check.difference !== null }])) )}`);
  const rows = input.candles.map(({ time, vol, ...c }) => ({ ...c, date: String(time), volume: vol }));
  const result = analyzeChan(rows, '101');
  assertProductionInvariants(result, rows);
  assert.equal(result.historyOffset + result.definition.historyBars, rows.length);
  assert.equal(result.definition.requestedBars, 300);
  assert.deepEqual(result.analysisCandles.map(({ high, low, open, close, date }) => ({ high, low, open, close, date })),
    rows.slice(result.historyOffset).map(({ high, low, open, close, date }) => ({ high, low, open, close, date })));
  assert.equal(visibleOffset(result, rows.slice(-80)), 220);
});

test('every period analyzes all valid loaded candles and reports that actual input scope', () => {
  const source = JSON.parse(readFileSync(new URL('./fixtures/input/sh603818-day-300.json', import.meta.url), 'utf8'));
  const input = epochRows(source.candles);
  const invalid = { ...input[0], volume: NaN };
  for (const period of ['day', '101', 'week', '102', '60m', '30m', '15m', '15', '5m', '5']) {
    const result = analyzeChan([invalid, ...input, invalid], period);
    assert.equal(result.definition.requestedBars, input.length);
    assert.equal(result.definition.analysisScope, 'all-loaded');
    assert.equal(result.definition.segmentHistoryBars, input.length);
    assert.equal(result.definition.segmentHistoryStart, input[0].date);
    assert.deepEqual(result.dates, input.map((row) => row.date));
    assertProductionInvariants(result, input);
  }
});

test('incremental engine does not mutate input candles, and empty history cannot invent endpoints', () => {
  const fixture = fixtures.find(({ name }) => name === 'sh603818-day.json').data;
  const input = fixture.candles.map((c) => Object.freeze({ ...c }));
  assert.doesNotThrow(() => analyzeReferenceCandles(Object.freeze(input)));
  const empty = analyzeChan([]);
  assert.deepEqual(empty.biLine, []);
  assert.deepEqual(empty.zs, []);
  assert.equal(empty.outlook.ok, false);
  assert.equal(empty.definition.requestedBars, 0);
  assert.equal(empty.definition.segmentHistoryBars, 0);
  assert.equal(empty.definition.segmentHistoryStart, null);
});
