import { analyzeChan } from './index.js';
import { referenceFractals } from './referenceFractal.js';
import { buildZs } from './referenceZs.js';

// Compare date + price + order, rather than just structure counts.
export function firstDifference(expected, actual) {
  const canonical = (value) => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (JSON.stringify(canonical(expected[i])) !== JSON.stringify(canonical(actual[i]))) {
      return { index: i, expected: expected[i] ?? null, actual: actual[i] ?? null };
    }
  }
  return null;
}

export function compareReference(fixture, input = fixture.candles) {
  const rows = input.map(({ time, vol, ...bar }) => ({ ...bar, date: String(time), volume: vol }));
  const current = analyzeChan(rows, fixture.period);
  const timeAt = (time) => input[time - 1]?.time;
  const point = (p) => [timeAt(p.time), p.price];
  const expected = {
    candles: fixture.candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.vol]),
    fx: fixture.fx.map((p) => [p.time, p.price, p.mark]),
    bi: fixture.bi.map((p) => [p.time, p.price]),
    zs: fixture.zs.map((z) => [z.sdt, z.edt, z.zg, z.zd, z.zz, z.bi_count, z.algorithm]),
    endpoints: fixture.trades.map((p) => [p.time, p.price, p.side, p.kind]),
    outlook: [fixture.outlook],
  };
  const actual = {
    candles: current.analysisCandles.map((c) => [timeAt(c.time), c.open, c.high, c.low, c.close, c.vol]),
    fx: current.fx.map((p) => [...point(p), p.mark]),
    bi: current.biLine.map(point),
    zs: current.zs.map((z) => [timeAt(z.sdt), timeAt(z.edt), z.zg, z.zd, z.zz, z.bi_count, z.algorithm]),
    endpoints: current.trades.toReversed().map((p) => [Number(p.time), p.price, p.side, p.kind]),
    outlook: [current.outlook],
  };
  const checks = Object.fromEntries(Object.keys(expected).map((key) => [key, {
    expectedCount: expected[key].length, actualCount: actual[key].length,
    difference: firstDifference(expected[key], actual[key]),
  }]));
  const candidateFx = referenceFractals(fixture.candles).fx;
  return {
    symbol: fixture.symbol, market: fixture.market, period: fixture.period,
    bars: fixture.candles.length, source: fixture.source,
    currentDefinition: current.definition.id,
    matches: Object.values(checks).every((c) => c.difference === null), checks,
    referenceFractalMatches: firstDifference(expected.fx, candidateFx.map((p) => [p.time, p.price, p.mark])) === null,
    referenceZonesMatchWithOraclePens: firstDifference(fixture.zs, buildZs(fixture.trades)) === null,
  };
}
