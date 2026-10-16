import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { analyzeChan, visibleOffset } from './index.js';

const rows = (ranges) => ranges.map(([high, low], i) => ({
  high, low, open: low + (high - low) / 3, close: high - (high - low) / 3,
  volume: 100, date: `bar-${i + 1}`,
}));

for (const [name, ranges, expected, direction] of [
  ['top', [[8, 4], [10, 6], [11, 5], [9, 4]], [[8, 4], [11, 6], [9, 4]], 'up'],
  ['bottom', [[16, 12], [14, 10], [15, 9], [16, 11]], [[16, 12], [14, 9], [16, 11]], 'down'],
]) {
  test(`${name}: clicked marker explains its original OHLC, three merged ranges and actual merge step`, () => {
    const input = rows(ranges);
    const original = structuredClone(input);
    const data = analyzeChan(input);
    const point = data.fx[0];
    const detail = data.fractalDetails.fx[point.time];
    assert.deepEqual(detail.rawCandles.map(({ date, open, close, high, low }) => ({ date, open, close, high, low })),
      input.map(({ date, open, close, high, low }) => ({ date, open, close, high, low })));
    assert.deepEqual(detail.mergedCandles.map(({ high, low }) => [high, low]), expected);
    assert.deepEqual(detail.mergedCandles.map(({ sources }) => sources.map((c) => c.date)),
      [['bar-1'], ['bar-2', 'bar-3'], ['bar-4']]);
    assert.deepEqual(detail.mergedCandles[1].steps, [{ direction, idx: 2,
      before: { high: ranges[1][0], low: ranges[1][1] },
      incoming: { high: ranges[2][0], low: ranges[2][1] },
      after: { high: expected[1][0], low: expected[1][1] } }]);
    assert.equal(detail.time, point.time);
    assert.equal(detail.price, point.price);
    assert.equal(detail.isValid, true);
    assert.equal(detail.conditions.length, 4);
    assert.ok(detail.conditions.every((c) => c.passed));
    assert.equal('open' in detail.mergedCandles[1], false, 'merged ranges must not invent an OHLC body');
    assert.deepEqual(input, original);
  });
}

test('continuous inclusion displays sequential intermediate ranges, not a transitive raw grouping', () => {
  const data = analyzeChan(rows([[8, 4], [10, 6], [9, 7], [11, 5], [10, 4]]));
  const detail = data.fractalDetails.fx[data.fx[0].time];
  assert.deepEqual(detail.mergedCandles[1].steps.map((s) => [s.before, s.after]), [
    [{ high: 10, low: 6 }, { high: 10, low: 7 }],
    [{ high: 10, low: 7 }, { high: 11, low: 7 }],
  ]);
});

test('more than 100 included candles retain every original candle and merge step for inspection', () => {
  const included = Array.from({ length: 125 }, () => [10, 6]);
  const data = analyzeChan(rows([[8, 4], ...included, [9, 4]]));
  const detail = data.fractalDetails.fx[data.fx[0].time];
  assert.equal(detail.rawCandles.length, 127);
  assert.equal(detail.mergedCandles[1].sources.length, 125);
  assert.equal(detail.mergedCandles[1].steps.length, 124);
  assert.deepEqual(detail.mergedCandles[1].sources.map((c) => c.idx), Array.from({ length: 125 }, (_, i) => i + 1));
});

test('first pen endpoint retains details even when the engine omits its fractal circle', () => {
  const data = analyzeChan(rows([[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]]));
  assert.equal(data.fx.some((p) => p.time === 2), false);
  assert.equal(data.fractalDetails.bi[2].mark, 'D');
  assert.deepEqual(data.fractalDetails.bi[2].rawCandles.map((c) => c.date), ['bar-1', 'bar-2', 'bar-3']);
});

test('history limits and cropped viewports preserve the calculation snapshot and original dates', () => {
  const prefix = Array.from({ length: 100 }, (_, i) => [i + 10, i + 9]);
  const input = rows([...prefix, ...Array.from({ length: 51 }, () => [[8, 4], [10, 6], [11, 5], [9, 4]]).flat()]);
  const data = analyzeChan(input);
  assert.equal(visibleOffset(data, input.slice(-20)), input.length - 20);
  for (const point of data.fx) {
    const detail = data.fractalDetails.fx[point.time];
    assert.ok(detail.mergedCandles[1].sources.some((c) => c.date === input[point.time - 1].date));
    assert.equal(detail.isValid, true);
  }
});

test('all reference markers expose their exact valid snapshots, including completed pen endpoints', () => {
  const directory = new URL('./fixtures/reference/', import.meta.url);
  let inspected = 0;
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
    const fixture = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
    const input = fixture.candles.map(({ time, vol, ...bar }) => ({ ...bar, date: String(time), volume: vol }));
    const data = analyzeChan(input, fixture.period);
    for (const kind of ['fx', 'bi']) for (const point of data[kind]) {
      const detail = data.fractalDetails[kind][point.time];
      assert.ok(detail, `${name}/${kind}/${point.time}: missing detail`);
      assert.equal(detail.isValid, true, `${name}/${kind}/${point.time}: invalid range predicate`);
      assert.equal(detail.price, point.price);
      assert.equal(detail.mark, point.mark);
      assert.ok(detail.mergedCandles[1].sources.some((c) => c.time === point.time));
      for (const bar of detail.mergedCandles) {
        assert.equal(bar.sources.length, bar.to - bar.from + 1);
        assert.equal(bar.steps.length, bar.sources.length - 1);
        let previous = { high: bar.sources[0].high, low: bar.sources[0].low };
        bar.steps.forEach((step, i) => {
          const source = bar.sources[i + 1];
          assert.equal(step.idx, source.idx);
          assert.deepEqual(step.before, previous);
          assert.deepEqual(step.incoming, { high: source.high, low: source.low });
          const operation = step.direction === 'up' ? Math.max : Math.min;
          previous = { high: operation(previous.high, source.high), low: operation(previous.low, source.low) };
          assert.deepEqual(step.after, previous);
        });
        assert.deepEqual(previous, { high: bar.high, low: bar.low });
        assert.equal('open' in bar, false);
        assert.equal('close' in bar, false);
        const lastStep = bar.steps.at(-1);
        if (lastStep) assert.deepEqual(lastStep.after, { high: bar.high, low: bar.low });
      }
      inspected++;
    }
  }
  assert.ok(inspected > 1000, `only ${inspected} markers inspected`);
});
