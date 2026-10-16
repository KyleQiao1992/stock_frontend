import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTopFractal, topFractalTraitDescription } from './topFractalTraits.js';
import { classifyBottomFractal, bottomFractalTraitDescription } from './bottomFractalTraits.js';
import { analyzeChan } from './index.js';

const bar = (open, high, low, close) => ({ open, high, low, close });
const copy = (raw) => raw.map((candle) => ({ ...candle }));
const mirror = (raw) => raw.map(({ open, high, low, close }) => bar(30 - open, 30 - low, 30 - high, 30 - close));
const detail = (rawCandles, mark) => ({ mark, rawCandles,
  mergedCandles: rawCandles.map((candle) => ({ ...candle, sources: [candle] })) });
const continuation = [bar(10.5, 20, 10, 19.5), bar(20, 22, 12, 21), bar(18, 21, 11, 19)];
const strong = [bar(11, 15, 10, 14), bar(19, 20, 12, 13), bar(13, 17, 11, 14)];
const relative = [bar(11, 15, 10, 14), bar(15, 19, 14, 17), bar(14, 16, 9, 12)];
const overlap = [bar(10.5, 20, 10, 19.5), bar(20, 22, 12, 21), bar(11, 21, 9, 12)];

for (const [name, mark, classify, describe, reflect] of [
  ['top', 'G', classifyTopFractal, topFractalTraitDescription, copy],
  ['bottom', 'D', classifyBottomFractal, bottomFractalTraitDescription, mirror],
]) {
  test(`${name} audit: exact dojis are not the nonzero small yin/yang candles of continuation`, () => {
    for (const indices of [[1], [2], [1, 2]]) {
      const raw = copy(continuation);
      for (const index of indices) raw[index].close = raw[index].open;
      const result = classify(detail(reflect(raw), mark));
      assert.equal(result.applicable, true);
      assert.equal(result.matches.continuation, false, `doji positions: ${indices}`);
    }
  });

  test(`${name} audit: missing or nonfinite OHLC must not become a failed colour recovery`, () => {
    for (let index = 0; index < 3; index++) {
      for (const field of ['open', 'high', 'low', 'close']) {
        for (const value of [undefined, null, NaN, Infinity, -Infinity, '14']) {
          const raw = reflect(strong);
          raw[index][field] = value;
          assert.deepEqual(classify(detail(raw, mark)), { applicable: false, reason: 'invalid-ohlc' },
            `candle ${index + 1}, ${field}=${value}`);
        }
      }
    }
    const input = detail(reflect(strong), mark);
    assert.deepEqual(classify({ ...input, rawCandles: undefined }), { applicable: false, reason: 'invalid-ohlc' });
    assert.deepEqual(classify({ ...input, rawCandles: input.rawCandles.slice(0, 2) }),
      { applicable: false, reason: 'invalid-ohlc' });
    assert.deepEqual(classify({ ...input, rawCandles: Array(3) }), { applicable: false, reason: 'invalid-ohlc' });
    assert.deepEqual(classify({ ...input, rawCandles: [null, ...input.rawCandles.slice(1)] }),
      { applicable: false, reason: 'invalid-ohlc' });
  });

  test(`${name} audit: finite open and close must remain inside their actual high/low interval`, () => {
    for (let index = 0; index < 3; index++) {
      for (const field of ['open', 'close']) {
        for (const edge of ['high', 'low']) {
          const raw = reflect(strong);
          raw[index][field] = raw[index][edge] + (edge === 'high' ? 1 : -1);
          const original = structuredClone(raw);
          assert.deepEqual(classify(detail(raw, mark)), { applicable: false, reason: 'invalid-ohlc' });
          assert.deepEqual(raw, original, 'invalid prices must not be clamped or replaced');
        }
      }
    }
    const raw = reflect(strong);
    [raw[1].high, raw[1].low] = [raw[1].low, raw[1].high];
    assert.deepEqual(classify(detail(raw, mark)), { applicable: false, reason: 'invalid-ohlc' });
  });

  test(`${name} audit: overlapping matches retain a software display order without claiming actual strength ranking`, () => {
    const result = classify(detail(reflect(overlap), mark));
    assert.equal(result.matches.continuation, true);
    assert.equal(result.matches[mark === 'G' ? 'relativeHigh' : 'relativeLow'], true);
    const explanation = describe(result);
    assert.match(explanation, /同时符合中继倾向/);
    assert.match(explanation, /按展示规则优先显示/);
    assert.doesNotMatch(explanation, /优先显示较强特征/);
  });

  test(`${name} audit: a high body ratio alone does not establish an absolute long candle`, () => {
    const raw = [bar(200, 200.03, 200, 200.03), bar(200.18, 200.2, 200.04, 200.19),
      bar(200.1, 200.18, 200.02, 200.11)];
    assert.ok(raw.slice(1).every((candle) => candle.high - candle.low > raw[0].close - raw[0].open));
    const result = classify(detail(reflect(raw), mark));
    assert.equal(result.primary, 'continuation', 'retain the disclosed software ratio heuristic');
    const explanation = describe(result);
    assert.match(explanation, /软件占比特征/);
    assert.match(explanation, /不能证实真实绝对长K/);
    assert.match(explanation, /不是原文规定/);
    assert.doesNotMatch(explanation, /第一根长阳|第一根长阴/);
  });
}

test('traits audit: the production snapshot rejects impossible finite OHLC without replacing the source prices', () => {
  for (const [mark, reflect, property] of [['G', copy, 'topTraits'], ['D', mirror, 'bottomTraits']]) {
    const raw = reflect(strong);
    raw[1].open = mark === 'G' ? raw[1].high + 5 : raw[1].low - 5;
    const rows = raw.map((candle, i) => ({ ...candle, volume: 100, date: `2026-09-0${i + 1}` }));
    const result = analyzeChan(rows);
    assert.equal(result.fx.length, 1, 'the existing high/low engine still supplies the geometric snapshot');
    const snapshot = result.fractalDetails.fx[result.fx[0].time];
    assert.equal(snapshot.isValid, true, 'geometric validity alone is not OHLC integrity');
    assert.deepEqual(snapshot[property], { applicable: false, reason: 'invalid-ohlc' });
    assert.equal(snapshot.rawCandles[1].open, raw[1].open);
  }
});

test('traits audit: valid shapes and the adversarial doji cases preserve top/bottom reflection', () => {
  const dojis = copy(continuation);
  dojis[1].close = dojis[1].open;
  dojis[2].close = dojis[2].open;
  for (const raw of [continuation, strong, relative, overlap, dojis]) {
    const top = classifyTopFractal(detail(copy(raw), 'G'));
    const bottom = classifyBottomFractal(detail(mirror(raw), 'D'));
    assert.deepEqual(bottom.matches, { continuation: top.matches.continuation, strong: top.matches.strong,
      relativeLow: top.matches.relativeHigh });
    assert.equal(bottom.primary, top.primary === 'relativeHigh' ? 'relativeLow' : top.primary);
  }
});
