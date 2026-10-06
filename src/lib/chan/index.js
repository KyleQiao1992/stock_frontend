import { analyzeReferenceCandles, referenceHistoryLimit } from './referenceEngine.js';
import { buildZs } from './referenceZs.js';
import { buildOutlook, buildTrades } from './outlook.js';

export function analyzeChan(rows, period = 'day') {
  const bars = rows.filter((r) => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite));
  // Coordinates refer to the original history, even after the reference engine trims its prefix.
  const candles = bars.map((r, i) => ({ ...r, time: i + 1, vol: r.volume }));
  const limit = referenceHistoryLimit(period);
  const result = analyzeReferenceCandles(candles.slice(-limit));
  const point = (p) => ({ ...p, idx: p.time - 1 });
  const bi = result.bi.map(point);
  const pending = result.pending.map(point);
  const fx = result.fx.map(point);
  const zs = buildZs(bi).map((zone) => {
    const start = bi.findIndex((p) => p.time === zone.sdt);
    const head = bi.slice(start, start + 4);
    return { ...zone, zg_time: head.find((p) => p.price === zone.zg)?.time,
      zd_time: head.find((p) => p.price === zone.zd)?.time, label: '参考笔中枢' };
  });
  const dateAt = (time) => bars[time - 1]?.date;
  const datedPoint = (p) => ({ ...p, time: dateAt(p.time) });
  const datedZones = zs.map((z) => ({ ...z, sdt: dateAt(z.sdt), edt: dateAt(z.edt),
    zg_time: dateAt(z.zg_time), zd_time: dateAt(z.zd_time) }));
  const datedBi = bi.map(datedPoint);
  const outlook = buildOutlook({ candles: result.candles.map((c) => ({ ...c, time: c.date })),
    biPoints: datedBi, pendingBi: pending.map(datedPoint), zsList: datedZones,
    close: candles.at(-1)?.close, period, zoneMode: 'sliding_bi' });
  const historyOffset = result.candles[0]?.time - 1 || 0;
  return {
    dates: bars.map((r) => r.date), historyOffset, historyDates: result.candles.map((c) => c.date),
    analysisCandles: result.candles, fx, bi, zs, pending,
    biLine: [...bi, ...pending.slice(1)], segments: [], pendingSegments: [],
    outlook, trades: buildTrades(datedBi),
    definition: { id: 'reference-incremental-bi-sliding-zs-v1', label: '参考站划线口径',
      zoneLevel: '滑动笔中枢', historyBars: result.candles.length, requestedBars: limit,
      skippedInitialBars: historyOffset },
  };
}

// Keep offscreen endpoints intact; clip the original line at the viewport boundary.
export function visibleOffset(data, rows) {
  if (!rows.length) return -1;
  return data.dates.indexOf(rows[0].date);
}
