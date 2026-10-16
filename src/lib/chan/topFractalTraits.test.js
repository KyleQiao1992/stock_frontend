import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTopFractal, topFractalTraitDescription } from './topFractalTraits.js';
import { analyzeChan } from './index.js';

const bar = (open, high, low, close) => ({ open, high, low, close });
function detail(rawCandles, mark = 'G') {
  return { mark, rawCandles, mergedCandles: rawCandles.map((bar) => ({ ...bar, sources: [bar] })) };
}

test('third candle breaking the first low and closing at/below halfway marks a relative high', () => {
  const data = detail([bar(11, 15, 10, 14), bar(15, 19, 14, 17), bar(14, 16, 9, 12)]);
  const result = classifyTopFractal(data);
  assert.equal(result.matches.relativeHigh, true);
  assert.equal(result.primary, 'relativeHigh');
  assert.equal(result.evidence.firstMidpoint, 12.5);
});
test('touching first low is not breaking it; recovering above halfway rejects the relative-high rule', () => {
  const first = bar(11, 15, 10, 14), middle = bar(15, 19, 14, 17);
  assert.equal(classifyTopFractal(detail([first, middle, bar(14, 16, 10, 12)])).matches.relativeHigh, false);
  assert.equal(classifyTopFractal(detail([first, middle, bar(14, 16, 9, 12.51)])).matches.relativeHigh, false);
  assert.equal(classifyTopFractal(detail([first, middle, bar(14, 16, 9, 12.5)])).matches.relativeHigh, true);
});
test('a long bearish middle candle with failed halfway recovery is strong', () => {
  const data = detail([bar(11, 15, 10, 14), bar(19, 20, 12, 13), bar(13, 17, 11, 14)]);
  const result = classifyTopFractal(data);
  assert.equal(result.matches.strong, true);
  assert.equal(result.evidence.longBear, true);
  assert.equal(result.primary, 'strong');
});
test('a long upper shadow is strong only if the third close fails to recover halfway', () => {
  const first = bar(11, 15, 10, 14), middle = bar(15, 20, 12, 14);
  assert.equal(classifyTopFractal(detail([first, middle, bar(13, 18, 11, 15)])).matches.strong, true);
  assert.equal(classifyTopFractal(detail([first, middle, bar(16, 18, 11, 17)])).matches.strong, false);
});
test('a bearish or doji third K above halfway still fails a bullish recovery', () => {
  const first = bar(11, 15, 10, 14), middle = bar(19, 20, 12, 13);
  for (const last of [bar(18, 19, 11, 17), bar(17, 19, 11, 17)]) {
    const result = classifyTopFractal(detail([first, middle, last]));
    assert.equal(result.evidence.lastBull, false);
    assert.ok(last.close > result.evidence.middleMidpoint);
    assert.equal(result.matches.strong, true);
  }
  assert.equal(classifyTopFractal(detail([first, middle, bar(13, 19, 11, 17)])).matches.strong, false);
  assert.equal(classifyTopFractal(detail([first, middle, bar(13, 19, 11, 16)])).matches.strong, true);
});
test('first long bull and two small bodies match continuation', () => {
  const result = classifyTopFractal(detail([bar(10.5, 20, 10, 19.5), bar(20, 22, 12, 21), bar(18, 21, 11, 19)]));
  assert.equal(result.matches.continuation, true);
  assert.equal(result.primary, 'continuation');
});
test('the most forceful rule wins when multiple descriptions overlap', () => {
  const result = classifyTopFractal(detail([bar(11, 15, 10, 14), bar(19, 20, 12, 13), bar(13, 17, 9, 12)]));
  assert.equal(result.matches.strong, true);
  assert.equal(result.matches.relativeHigh, true);
  assert.equal(result.primary, 'relativeHigh');
});
test('qualitative thresholds are configurable and do not affect strict low/halfway comparisons', () => {
  const data = detail([bar(11, 15, 10, 14), bar(19, 20, 12, 13), bar(13, 17, 11, 14)]);
  assert.equal(classifyTopFractal(data).matches.strong, true);
  assert.equal(classifyTopFractal(data, { longBodyRatio: 0.9, smallBodyRatio: 0.5, upperShadowRatio: 0.9 }).matches.strong, false);
});
test('these three rules do not fabricate open/close prices for inclusion results or classify bottoms', () => {
  const data = detail([bar(11, 15, 10, 14), bar(15, 19, 14, 17), bar(14, 16, 9, 12)]);
  data.mergedCandles[1].sources.push(data.rawCandles[1]);
  assert.equal(classifyTopFractal(data).reason, 'inclusion');
  assert.equal(classifyTopFractal({ ...data, mark: 'D' }).reason, 'bottom');
});
test('a failed geometric top cannot be assigned a top-fractal strength label', () => {
  const data = detail([bar(11, 15, 10, 14), bar(15, 19, 14, 17), bar(14, 21, 9, 12)]);
  assert.equal(classifyTopFractal(data).reason, 'not-top');
});

test('only the selected three-K snapshot is used, without requiring later price action', () => {
  const input = [bar(11, 15, 10, 14), bar(15, 19, 14, 17), bar(14, 16, 9, 12)]
    .map((candle, i) => ({ ...candle, volume: 100, date: `2026-09-0${i + 1}` }));
  const result = analyzeChan(input);
  const traits = result.fractalDetails.fx[result.fx[0].time].topTraits;
  assert.equal(traits.primary, 'relativeHigh');
  assert.equal(input.length, 3);
  const description = topFractalTraitDescription(traits);
  assert.match(description, /仅依据这三根/);
  assert.match(description, /不使用长短阈值/);
  assert.equal(description.includes('几乎确定'), false);
});

test('qualitative descriptions disclose software thresholds and overlapping matches', () => {
  const strong = classifyTopFractal(detail([bar(11, 15, 10, 14), bar(19, 20, 12, 13), bar(13, 17, 11, 14)]));
  assert.match(topFractalTraitDescription(strong), /不是原文规定/);
  const overlapping = classifyTopFractal(detail([bar(10.5, 20, 10, 19.5), bar(20, 22, 12, 21), bar(11, 21, 9, 12)]));
  assert.equal(overlapping.matches.continuation, true);
  assert.equal(overlapping.primary, 'relativeHigh');
  assert.match(topFractalTraitDescription(overlapping), /同时符合中继倾向/);
});
