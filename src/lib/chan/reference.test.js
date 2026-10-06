import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { referenceFractals } from './referenceFractal.js';
import { buildZs } from './referenceZs.js';
import { firstDifference } from './referenceParity.js';

const directory = new URL('./fixtures/reference/', import.meta.url);
const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name, data: JSON.parse(readFileSync(new URL(name, directory), 'utf8')) }));

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
}

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
