import { analyzeReferenceCandles, referenceHistoryLimit } from './referenceEngine.js';
import { buildZs } from './referenceZs.js';
import { buildTrades } from './outlook.js';
import { buildReferenceOutlook } from './referenceOutlook.js';
import { buildSegments } from './segment.js';

export function analyzeChan(rows, period = 'day') {
  const bars = rows.filter((r) => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite));
  // Coordinates refer to the original history, even after the reference engine trims its prefix.
  const candles = bars.map((r, i) => ({ ...r, time: i + 1, vol: r.volume }));
  const limit = referenceHistoryLimit(period);
  const requestCandles = candles.slice(-limit);
  const result = analyzeReferenceCandles(requestCandles);
  const point = (p) => ({ ...p, idx: p.time - 1 });
  const bi = result.bi.map(point);
  const segmentBi = result.segmentBi.map(point);
  const { segments, pending: segmentCandidate } = buildSegments(segmentBi);
  // Only an already-established three-stroke candidate may extend dynamically.
  // Its raw extremum belongs to a real K and never enters confirmed evidence.
  let pendingSegments = [];
  if (segmentCandidate.length === 2) {
    const [start, end] = segmentCandidate;
    const up = end.price > start.price;
    let extreme = null;
    for (const candle of requestCandles) {
      if (candle.time <= start.time) continue;
      if (!extreme || (up ? candle.high > extreme.high : candle.low < extreme.low)) extreme = candle;
    }
    if (extreme) pendingSegments = [{ ...start, confirmed: false, confirmed_time: null }, {
      time: extreme.time, idx: extreme.time - 1, price: up ? extreme.high : extreme.low,
      mark: up ? 'G' : 'D', confirmed: false, confirmed_time: null,
    }];
  }
  const pending = result.pending.map(point);
  const fx = result.fx.map(point);
  const zs = buildZs(bi).map((zone) => {
    const start = bi.findIndex((p) => p.time === zone.sdt);
    const head = bi.slice(start, start + 4);
    return { ...zone, zg_time: head.find((p) => p.price === zone.zg)?.time,
      zd_time: head.find((p) => p.price === zone.zd)?.time, label: '滑动笔重叠区' };
  });
  const dateAt = (time) => bars[time - 1]?.date;
  const datedPoint = (p) => ({ ...p, time: dateAt(p.time) });
  const datedZones = zs.map((z) => {
    const inZone = result.candles.filter((c) => c.time >= z.sdt && c.time <= z.edt);
    // The reference labels the first raw K touching a boundary, not its later pen endpoint.
    return { ...z, sdt: dateAt(z.sdt), edt: dateAt(z.edt),
      zg_time: dateAt(inZone.find((c) => c.high === z.zg)?.time ?? z.zg_time),
      zd_time: dateAt(inZone.find((c) => c.low === z.zd)?.time ?? z.zd_time) };
  });
  const datedBi = bi.map(datedPoint);
  const outlook = buildReferenceOutlook({ candles: result.candles.map((c) => ({ ...c, time: c.date })),
    biPoints: datedBi, pendingBi: pending.map(datedPoint), zsList: datedZones,
    close: candles.at(-1)?.close, period });
  const historyOffset = result.candles[0]?.time - 1 || 0;
  return {
    dates: bars.map((r) => r.date), historyOffset, historyDates: result.candles.map((c) => c.date),
    analysisCandles: result.candles, fx, bi, zs, pending, fractalDetails: result.fractalDetails,
    biLine: [...bi, ...pending.slice(1)], segmentBi, segments, pendingSegments,
    outlook, trades: buildTrades(datedBi),
    definition: { id: 'chan-old-bi-sliding-overlap-v2', label: '原文旧笔条件与滑动笔重叠区',
      zoneLevel: '滑动笔重叠区（非递归中枢）', historyBars: result.candles.length, requestedBars: limit,
      segmentSource: '本次请求窗口内的已确认笔端，随上游笔回退重算',
      segmentCompletion: 'complete=true才可由本K确认；缺失状态待后继同周期K出现，确认时刻记后继K；complete=false不确认',
      segmentConfirmationScope: '当前请求窗口复算的必要证据K，不等于跨窗口首次观测或交易信号时刻',
      segmentHistoryBars: requestCandles.length, segmentHistoryStart: requestCandles[0]?.date ?? null,
      skippedInitialBars: historyOffset },
  };
}

// Keep offscreen endpoints intact; clip the original line at the viewport boundary.
export function visibleOffset(data, rows) {
  if (!rows.length) return -1;
  return data.dates.indexOf(rows[0].date);
}
