import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBottomFractal, bottomFractalTraitDescription } from './bottomFractalTraits.js';
import { classifyTopFractal } from './topFractalTraits.js';
import { analyzeChan } from './index.js';

const bar = (open, high, low, close) => ({ open, high, low, close });
const detail = (rawCandles, mark = 'D') => ({ mark, rawCandles,
  mergedCandles: rawCandles.map((candle) => ({ ...candle, sources: [candle] })) });
const first = bar(19, 20, 15, 16);
const bullishMiddle = bar(11, 18, 10, 17);

test('first long bear and two small bodies mark downward continuation tendency', () => {
  const result = classifyBottomFractal(detail([bar(19.5, 20, 10, 10.5), bar(10, 18, 8, 9), bar(12, 19, 9, 11)]));
  assert.equal(result.primary, 'continuation');
  assert.equal(result.evidence.longBear, true);
  assert.match(bottomFractalTraitDescription(result), /延续此前的下跌方向/);
});

test('long bullish middle candle and failed bearish drop mark a strong bottom', () => {
  const result = classifyBottomFractal(detail([first, bullishMiddle, bar(17, 19, 13, 16)]));
  assert.equal(result.primary, 'strong');
  assert.equal(result.evidence.longBull, true);
  assert.equal(result.evidence.middleMidpoint, 14);
});

test('long lower shadow is evaluated at the low side and has a configurable software threshold', () => {
  const input = detail([first, bar(15, 18, 10, 16), bar(17, 19, 12, 15)]);
  const result = classifyBottomFractal(input);
  assert.equal(result.primary, 'strong');
  assert.equal(result.evidence.longLowerShadow, true);
  assert.equal(classifyBottomFractal(input, { longBodyRatio: 0.9, smallBodyRatio: 0.5, lowerShadowRatio: 0.9 }).matches.strong, false);
});

test('a bullish or doji third K below halfway still fails a bearish drop', () => {
  for (const last of [bar(12, 19, 11, 13), bar(13, 19, 11, 13)]) {
    const result = classifyBottomFractal(detail([first, bullishMiddle, last]));
    assert.equal(result.evidence.lastBear, false);
    assert.equal(result.matches.strong, true);
    assert.ok(last.close < result.evidence.middleMidpoint);
  }
  assert.equal(classifyBottomFractal(detail([first, bullishMiddle, bar(17, 19, 11, 13)])).matches.strong, false);
  assert.equal(classifyBottomFractal(detail([first, bullishMiddle, bar(17, 19, 11, 14)])).matches.strong, true);
});

test('breaking the first high and closing at or above its range midpoint marks relative-low features', () => {
  const middle = bar(15, 16, 11, 13);
  const make = (high, close) => classifyBottomFractal(detail([first, middle, bar(16, high, 14, close)]));
  const result = make(21, 18);
  assert.equal(result.primary, 'relativeLow');
  assert.equal(result.evidence.brokeFirstHigh, true);
  assert.equal(result.evidence.firstHigh, 20);
  assert.equal(result.evidence.firstMidpoint, 17.5);
  assert.equal(result.evidence.lastHigh, 21);
  assert.equal(result.evidence.lastClose, 18);
  assert.equal(make(20, 18).matches.relativeLow, false, 'touching is not breaking');
  assert.equal(make(21, 17.49).matches.relativeLow, false);
  assert.equal(make(21, 17.5).matches.relativeLow, true);
});

test('overlapping continuation and relative-low patterns retain both matches', () => {
  const result = classifyBottomFractal(detail([bar(19.5, 20, 10, 10.5), bar(10, 18, 8, 9), bar(19, 21, 9, 18)]));
  assert.equal(result.matches.continuation, true);
  assert.equal(result.primary, 'relativeLow');
  assert.match(bottomFractalTraitDescription(result), /同时符合中继倾向/);
});

test('inclusion, geometric failure and top cases cannot masquerade as direct bottom traits', () => {
  const input = detail([first, bar(15, 16, 11, 13), bar(16, 21, 14, 18)]);
  assert.equal(classifyBottomFractal({ ...input, mark: 'G' }).reason, 'top');
  assert.equal(classifyBottomFractal(detail([first, input.rawCandles[1], bar(16, 21, 9, 18)])).reason, 'not-bottom');
  input.mergedCandles[1].sources.push(input.rawCandles[1]);
  assert.equal(classifyBottomFractal(input).reason, 'inclusion');
});

test('price reflection preserves all three pattern matches without changing source candles', () => {
  const raw = [first, bullishMiddle, bar(17, 19, 13, 16)];
  const snapshot = structuredClone(raw);
  const reflected = raw.map((candle) => bar(-candle.open, -candle.low, -candle.high, -candle.close));
  const top = classifyTopFractal(detail(reflected, 'G'));
  const bottom = classifyBottomFractal(detail(raw));
  assert.deepEqual(bottom.matches, { continuation: top.matches.continuation, strong: top.matches.strong, relativeLow: top.matches.relativeHigh });
  assert.deepEqual(raw, snapshot);
});

test('main analysis exposes bottom traits from exactly three raw K lines, with bottom-specific explanations', () => {
  const input = [first, bar(15, 16, 11, 13), bar(16, 21, 14, 18)]
    .map((candle, i) => ({ ...candle, volume: 100, date: `2026-09-0${i + 1}` }));
  const result = analyzeChan(input);
  const snapshot = result.fractalDetails.fx[result.fx[0].time];
  assert.equal(snapshot.topTraits.applicable, false);
  assert.equal(snapshot.bottomTraits.primary, 'relativeLow');
  const description = bottomFractalTraitDescription(snapshot.bottomTraits);
  assert.match(description, /这三根K线/);
  assert.match(description, /未使用后续行情/);
  assert.match(description, /相对低点/);
  assert.equal(/相对高点|长上影|向下成笔/.test(description), false);
  const strong = classifyBottomFractal(detail([first, bullishMiddle, bar(17, 19, 13, 16)]));
  assert.match(bottomFractalTraitDescription(strong), /不是原文规定/);
});
