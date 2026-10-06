/**
 * Incremental Chan analysis, ported from CZSC v0.9.69's analyze.py.
 * Copyright 2025 zengbin93. Apache-2.0; see third_party/czsc/.
 * Modified: JavaScript port, ordinal chart coordinates and drawable FX deduplication.
 * Source: https://github.com/waditu/czsc/blob/v0.9.69/czsc/analyze.py
 * Keep the incremental order: batch fractal linking changes historical endpoints.
 */

export const MIN_BI_LENGTH = 6;
export const MAX_BI_COUNT = 50;

function newBar(candle, idx) {
  return { high: candle.high, low: candle.low, time: candle.time, from: idx, to: idx,
    elements: [{ ...candle, idx }] };
}

function mergeNext(a, b, candle, idx) {
  const raw = newBar(candle, idx);
  if (a.high === b.high) return raw;
  const up = a.high < b.high;
  const contains = (b.high <= candle.high && b.low >= candle.low)
    || (b.high >= candle.high && b.low <= candle.low);
  if (!contains) return raw;
  // Replace the bar rather than mutating it: completed strokes retain snapshots.
  return {
    high: up ? Math.max(b.high, candle.high) : Math.min(b.high, candle.high),
    low: up ? Math.max(b.low, candle.low) : Math.min(b.low, candle.low),
    time: up ? (b.high > candle.high ? b.time : candle.time)
      : (b.low < candle.low ? b.time : candle.time),
    from: b.from, to: idx,
    elements: [...b.elements.slice(0, 100).filter((c) => c.time !== candle.time), { ...candle, idx }],
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
  const included = (start.high > end.high && start.low < end.low)
    || (start.high < end.high && start.low > end.low);
  if (included || leg.length < MIN_BI_LENGTH) return { remaining: bars };
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
    if (unfinished.length < 2) unfinished.push(newBar(candle, idx));
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
              && (start.mark === 'D' ? point.low <= start.low : point.high >= start.high)) start = point;
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
  const fx = [...new Map(allFx.map((p) => [p.time, simple(p)])).values()];
  const bi = strokes.length ? [...strokes.map((s) => s.start), strokes.at(-1).end].map(simple) : [];
  const pending = [];
  if (bi.length) {
    const up = strokes.at(-1).direction === 'down';
    const elements = unfinished.flatMap((b) => b.elements);
    let extreme = elements[0];
    for (const candle of elements.slice(1)) {
      if (up ? candle.high > extreme.high : candle.low < extreme.low) extreme = candle;
    }
    pending.push(bi.at(-1), { time: candles.at(-1).time,
      price: up ? extreme.high : extreme.low, mark: up ? 'G' : 'D',
      idx: candles.length - 1, extremeTime: extreme.time, confirmed: false });
  }
  return { candles: raw, fx, bi, pending, strokeCount: strokes.length };
}

/** Match the reference client's requested history, then let the engine trim it. */
export function referenceHistoryLimit(period) {
  if (['week', '102'].includes(String(period))) return 260;
  if (['5m', '5'].includes(String(period))) return 1200;
  if (['15m', '15'].includes(String(period))) return 800;
  return 300;
}
