// Ported from tangle. Keep the 300-bar calculation window independent of viewport.
import { mergeCandles, findFractals } from './fractal.js';
import { buildBi } from './bi.js';
import { buildZs } from './zs.js';
import { buildOutlook, buildTrades } from './outlook.js';

export function analyzeChan(rows, period = 'day') {
  const bars = rows.filter((r) => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)).slice(-300);
  // Internal ordinal time keys preserve trading-bar spacing without timezone conversion.
  const candles = bars.map((r, i) => ({ ...r, time: i + 1, vol: r.volume }));
  const fx = findFractals(candles, mergeCandles(candles));
  const bi = buildBi(fx);
  const zs = buildZs(bi);
  const last = candles.at(-1);
  const end = bi.at(-1);
  const pending = last && end && end.time !== last.time
    ? [end, { time: last.time, price: last.close }] : [];
  const datedPoints = bi.map((p) => ({ ...p, time: bars[p.time - 1].date }));
  const datedZones = zs.map((z) => ({ ...z, sdt: bars[z.sdt - 1].date, edt: bars[z.edt - 1].date }));
  const outlook = buildOutlook({ candles: bars.map((r) => ({ ...r, time: r.date })), biPoints: datedPoints, zsList: datedZones, close: last?.close, period });
  return { dates: bars.map((r) => r.date), fx, bi, zs, pending, outlook, trades: buildTrades(datedPoints) };
}

// Keep offscreen endpoints: SVG clipping must intersect the original line,
// rather than moving its endpoint onto the first visible candle.
export function visibleOffset(data, rows) {
  if (!rows.length) return -1;
  return data.dates.indexOf(rows[0].date);
}
