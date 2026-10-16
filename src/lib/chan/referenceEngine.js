/**
 * Incremental Chan analysis, ported from CZSC v0.9.69's analyze.py.
 * Copyright 2025 zengbin93. Apache-2.0; see third_party/czsc/.
 * Modified: JavaScript port, ordinal chart coordinates and drawable FX deduplication.
 * Source: https://github.com/waditu/czsc/blob/v0.9.69/czsc/analyze.py
 * Keep the incremental order: batch fractal linking changes historical endpoints.
 */

import { buildFractalDetail } from './fractalDetail.js';

// Lessons 62/77: three K per endpoint plus at least one independent K.
export const MIN_BI_LENGTH = 7;
export const MAX_BI_COUNT = 50;

function newBar(candle, idx) {
  return { high: candle.high, low: candle.low, time: candle.time, from: idx, to: idx,
    elements: [{ ...candle, idx }], mergeSteps: [] };
}

function containsRange(a, b) {
  return (a.high <= b.high && a.low >= b.low)
    || (a.high >= b.high && a.low <= b.low);
}

function mergeNext(a, b, candle, idx) {
  const raw = newBar(candle, idx);
  if (a.high === b.high) return raw;
  const up = a.high < b.high;
  const contains = containsRange(b, candle);
  if (!contains) return raw;
  const high = up ? Math.max(b.high, candle.high) : Math.min(b.high, candle.high);
  const low = up ? Math.max(b.low, candle.low) : Math.min(b.low, candle.low);
  // Replace the bar rather than mutating it: completed strokes retain snapshots.
  return {
    high, low,
    time: up ? (b.high > candle.high ? b.time : candle.time)
      : (b.low < candle.low ? b.time : candle.time),
    from: b.from, to: idx,
    elements: [...b.elements.filter((c) => c.time !== candle.time), { ...candle, idx }],
    mergeSteps: [...(b.mergeSteps || []), { direction: up ? 'up' : 'down', idx,
      before: { high: b.high, low: b.low }, incoming: { high: candle.high, low: candle.low },
      after: { high, low } }],
  };
}

function findFractals(bars) {
  const result = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const [a, b, c] = bars.slice(i - 1, i + 2);
    let mark;
    if (a.high < b.high && b.high > c.high && a.low < b.low && b.low > c.low) mark = 'G';
    if (a.low > b.low && b.low < c.low && a.high > b.high && b.high < c.high) mark = 'D';
    if (!mark || (result.length >= 2 && result.at(-1).mark === mark)) continue;
    result.push({ time: b.time, mark, price: mark === 'G' ? b.high : b.low,
      high: b.high, low: b.low, elements: [a, b, c] });
  }
  return result;
}

// Audit the exact primitives used above; these exports do not change chart behavior.
export { mergeNext as mergeReferenceBar, findFractals as findReferenceFractals };

function checkBi(bars) {
  const fx = findFractals(bars);
  if (fx.length < 2) return { remaining: bars };
  const start = fx[0];
  let end;
  for (const point of fx) {
    if (point.mark === start.mark || point.time <= start.time
      || (start.mark === 'D' ? point.price <= start.price : point.price >= start.price)) continue;
    if (!end || (start.mark === 'D' ? point.high > end.high : point.low < end.low)) end = point;
  }
  if (!end) return { remaining: bars };
  const leg = bars.filter((b) => b.time >= start.elements[0].time && b.time <= end.elements[2].time);
  const startRight = bars.indexOf(start.elements[2]);
  const endLeft = bars.indexOf(end.elements[0]);
  const hasIndependentBar = endLeft - startRight >= 2;
  const included = (start.high > end.high && start.low < end.low)
    || (start.high < end.high && start.low > end.low);
  if (included || !hasIndependentBar || leg.length < MIN_BI_LENGTH) return { remaining: bars };
  return {
    remaining: bars.filter((b) => b.time >= end.elements[0].time),
    stroke: {
      start, end, bars: leg, direction: start.mark === 'D' ? 'up' : 'down',
      high: Math.max(start.high, end.high), low: Math.min(start.low, end.low),
      fx: fx.filter((p) => p.time >= start.elements[0].time && p.time <= end.elements[2].time),
    },
  };
}

/** Analyze ascending candles without reading reference fixtures or symbol names. */
export function analyzeReferenceCandles(candles) {
  let raw = [];
  let unfinished = [];
  let strokes = [];
  for (let idx = 0; idx < candles.length; idx++) {
    const candle = candles[idx];
    raw.push(candle);
    if (unfinished.length < 2) {
      // The left window boundary has no earlier non-containing pair from which
      // lesson 65 can determine direction. Skip that unresolved prefix rather
      // than inventing an up/down merge from future candles.
      if (unfinished.length === 1 && containsRange(unfinished[0], candle)) unfinished[0] = newBar(candle, idx);
      else unfinished.push(newBar(candle, idx));
    }
    else {
      const next = mergeNext(unfinished.at(-2), unfinished.at(-1), candle, idx);
      if (next.from === idx) unfinished.push(next);
      else unfinished[unfinished.length - 1] = next;
    }

    if (unfinished.length >= 3) {
      if (!strokes.length) {
        const fx = findFractals(unfinished);
        if (fx.length) {
          let start = fx[0];
          for (const point of fx) {
            if (point.mark === start.mark
              && (start.mark === 'D' ? point.low < start.low : point.high > start.high)) start = point;
          }
          const result = checkBi(unfinished.filter((b) => b.time >= start.elements[0].time));
          if (result.stroke) strokes.push(result.stroke);
          unfinished = result.remaining;
        }
      } else {
        const result = checkBi(unfinished);
        unfinished = result.remaining;
        if (result.stroke) strokes.push(result.stroke);
        const last = strokes.at(-1);
        const broken = last.direction === 'up' ? unfinished.at(-1).high > last.high
          : unfinished.at(-1).low < last.low;
        if (broken) {
          // Preserve the two-bar overlap. Re-merge and re-evaluate on the next update.
          unfinished = [...last.bars.slice(0, -2),
            ...unfinished.filter((b) => b.time >= last.bars.at(-2).time)];
          strokes.pop();
        }
      }
    }
    strokes = strokes.slice(-MAX_BI_COUNT);
    if (strokes.length) raw = raw.filter((c) => c.time >= strokes[0].start.elements[0].time);
  }

  const allFx = strokes.flatMap((s) => s.fx.slice(1));
  for (const point of findFractals(unfinished)) {
    if (!allFx.length || point.time > allFx.at(-1).time) allFx.push(point);
  }
  const simple = ({ time, price, mark }) => ({ time, price, mark, idx: candles.findIndex((c) => c.time === time) });
  const drawableFx = [...new Map(allFx.map((p) => [p.time, p])).values()];
  const biPoints = strokes.length ? [...strokes.map((s) => s.start), strokes.at(-1).end] : [];
  const fx = drawableFx.map(simple);
  const bi = biPoints.map(simple);
  const fractalDetails = Object.fromEntries([['fx', drawableFx], ['bi', biPoints]].map(([kind, points]) => [
    kind, Object.fromEntries(points.map((point) => [point.time, buildFractalDetail(candles, point)])),
  ]));
  const pending = [];
  if (bi.length) {
    const up = strokes.at(-1).direction === 'down';
    // The next leg begins at the actual final endpoint, not its left fractal
    // neighbour. Read all raw candles so no capped/merged source can hide an
    // intermediate extremum or move it to a date where the price never traded.
    const elements = candles.filter((c) => c.time >= bi.at(-1).time);
    let extreme = elements[0];
    for (const candle of elements.slice(1)) {
      if (up ? candle.high > extreme.high : candle.low < extreme.low) extreme = candle;
    }
    pending.push(bi.at(-1), { time: extreme.time,
      price: up ? extreme.high : extreme.low, mark: up ? 'G' : 'D',
      idx: candles.findIndex((c) => c.time === extreme.time), extremeTime: extreme.time, confirmed: false });
  }
  return { candles: raw, fx, bi, pending, strokeCount: strokes.length, fractalDetails };
}

/** Match the reference client's requested history, then let the engine trim it. */
export function referenceHistoryLimit(period) {
  if (['week', '102'].includes(String(period))) return 260;
  if (['5m', '5'].includes(String(period))) return 1200;
  if (['15m', '15'].includes(String(period))) return 800;
  return 300;
}
