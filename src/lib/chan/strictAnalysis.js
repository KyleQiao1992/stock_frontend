// Previous strict pipeline, retained for independent tests. Not used by the active chart.
import { mergeCandles, findFractals } from './fractal.js';
import { buildBi } from './bi.js';
import { buildSegments } from './segment.js';
import { buildZs } from './zs.js';
import { buildOutlook, buildTrades } from './outlook.js';

export function analyzeChan(rows, period = 'day') {
  const bars = rows.filter((r) => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite));
  // Internal ordinal time keys preserve trading-bar spacing without timezone conversion.
  const candles = bars.map((r, i) => ({ ...r, time: i + 1, vol: r.volume }));
  const merged = mergeCandles(candles);
  const fx = findFractals(candles, merged);
  const candidates = buildBi(fx, { merged });
  // A valid opposite stroke fixes the previous endpoint. The last endpoint can
  // still be replaced by a more extreme same-kind fractal, so keep it provisional.
  const fixed = candidates.slice(0, -1);
  const bi = fixed.length >= 2 ? fixed : [];
  const { segments, pending: pendingSegments } = buildSegments(bi);
  const zs = buildZs(segments);
  const last = candles.at(-1);
  const anchor = candidates.length >= 2 ? candidates.at(-2) : candidates.at(-1);
  // A developing stroke ends at the directional extreme, never at the close.
  let extreme = null;
  if (anchor) {
    const up = anchor.mark === 'D';
    for (let i = anchor.idx + 1; i < candles.length; i++) {
      const price = up ? candles[i].high : candles[i].low;
      if (!extreme || (up ? price > extreme.price : price < extreme.price)) {
        extreme = { time: candles[i].time, price, idx: i, mark: up ? 'G' : 'D', confirmed: false };
      }
    }
    if (extreme && (up ? extreme.price <= anchor.price : extreme.price >= anchor.price)) extreme = null;
  }
  const pending = extreme ? [anchor, extreme] : [];
  const dateAt = (time) => Number.isInteger(time) ? bars[time - 1]?.date : time;
  const datedPoint = (p) => ({ ...p, time: dateAt(p.time) });
  const datedPoints = bi.map((p) => ({ ...p, time: bars[p.time - 1].date }));
  const datedZones = zs.map((z) => ({ ...z, sdt: dateAt(z.sdt), edt: dateAt(z.edt),
    zg_time: dateAt(z.zg_time), zd_time: dateAt(z.zd_time) }));
  const datedSegments = segments.map((s) => ({ ...s, start: datedPoint(s.start), end: datedPoint(s.end) }));
  const outlook = buildOutlook({ candles: bars.map((r) => ({ ...r, time: r.date })), biPoints: datedPoints,
    segments: datedSegments, pendingBi: pending.map(datedPoint), zsList: datedZones, close: last?.close, period });
  return { dates: bars.map((r) => r.date), fx, bi, segments, zs, pending, pendingSegments, outlook,
    trades: buildTrades(datedPoints), definition: {
      id: 'strict-old-bi-feature-sequence-v1', label: '原典严格老笔 · 特征序列线段',
      zoneLevel: '本图最小级别线段中枢', historyBars: bars.length,
      skippedInitialBars: merged[0]?.from ?? bars.length,
    } };
}

// Keep offscreen endpoints: SVG clipping must intersect the original line,
// rather than moving its endpoint onto the first visible candle.
export function visibleOffset(data, rows) {
  if (!rows.length) return -1;
  return data.dates.indexOf(rows[0].date);
}
