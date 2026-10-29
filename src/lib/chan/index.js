import { analyzeReferenceCandles } from './referenceEngine.js';
import { buildZsDetailed, ZS_RULE_VERSION } from './zs.js';
import { buildTrades } from './outlook.js';
import { buildSegmentOutlook } from './referenceOutlook.js';
import { buildSegments, SEGMENT_RULE_VERSION } from './segment.js';
import { buildPenCenters } from './penCenters.js';
import { assessRecursiveReadiness } from './recursiveReadiness.js';

// Interior raw bars are fully inside the segment; the other extreme of each
// endpoint bar may occur on either side of its endpoint. Preserve both bounds
// instead of silently assigning an unknown intrabar order to either segment.
function withRawSegmentRanges(segments, candles) {
  const result = [];
  for (const segment of segments) {
    const source = candles.slice(segment.start.time - 1, segment.end.time);
    let knownAt = segment.confirmed_time;
    let highPoint = { ...segment.start, mark: 'G' };
    let lowPoint = { ...segment.start, mark: 'D' };
    let possibleHigh = -Infinity;
    let possibleLow = Infinity;
    let possibleHighTime = null;
    let possibleLowTime = null;
    let unresolved = false;
    for (const candle of source) {
      // Unknown completion is observable only when the next same-period bar
      // arrives, matching referenceEngine's confirmation policy.
      const closedAt = candle.complete === true ? candle.time
        : candle.complete === false ? null : candles[candle.time]?.time;
      if (!Number.isFinite(closedAt)) { unresolved = true; break; }
      knownAt = Math.max(knownAt, closedAt);
      if (candle.high > possibleHigh) { possibleHigh = candle.high; possibleHighTime = candle.time; }
      if (candle.low < possibleLow) { possibleLow = candle.low; possibleLowTime = candle.time; }
      if (candle.time > segment.start.time && candle.time < segment.end.time) {
        if (candle.high > highPoint.price) highPoint = { time: candle.time, idx: candle.time - 1, price: candle.high, mark: 'G' };
        if (candle.low < lowPoint.price) lowPoint = { time: candle.time, idx: candle.time - 1, price: candle.low, mark: 'D' };
      }
    }
    if (unresolved || !source.length) return { segments: result, unresolved: true };
    if (segment.end.price > highPoint.price) highPoint = { ...segment.end, mark: 'G' };
    if (segment.end.price < lowPoint.price) lowPoint = { ...segment.end, mark: 'D' };
    result.push({ ...segment, high: highPoint.price, low: lowPoint.price,
      high_time: highPoint.time, low_time: lowPoint.time, high_point: highPoint, low_point: lowPoint,
      range_bounds: { high_min: highPoint.price, high_max: possibleHigh, high_min_time: highPoint.time,
        high_max_time: possibleHighTime, low_min: possibleLow, low_max: lowPoint.price,
        low_min_time: possibleLowTime, low_max_time: lowPoint.time },
      confirmed_time: knownAt });
  }
  return { segments: result, unresolved: false };
}

function findInvalidCandle(rows) {
  const seenDates = new Set();
  let priorDate = null;
  const comparableDate = date => /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(date);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const date = row?.date;
    if (typeof date !== 'string' || !date.trim() || seenDates.has(date)
        || (priorDate && comparableDate(date) && comparableDate(priorDate) && date <= priorDate)
        || ![row?.open, row?.high, row?.low, row?.close, row?.volume].every(Number.isFinite)
        || row.high < row.low || row.high < Math.max(row.open, row.close)
        || row.low > Math.min(row.open, row.close) || row.volume < 0
        || (row.complete != null && typeof row.complete !== 'boolean')) {
      return { reason: 'invalid_candle', index, date: date ?? null };
    }
    seenDates.add(date);
    priorDate = date;
  }
  return null;
}

export function analyzeChan(rows, period = 'day') {
  const inputProblem = findInvalidCandle(rows);
  if (inputProblem) {
    // Never remove an invalid candle and join the two sides into a false pen.
    // The chart may still show valid prices, but no Chan structure is claimed.
    const dates = rows.filter(r => r && [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite))
      .map(r => r.date);
    const analysis = { dates, historyOffset: 0, historyDates: [], analysisCandles: [], fx: [], bi: [], zs: [], penZs: [], penZsUncertainty: [],
      zsUncertainty: [], pending: [], pendingUncertainty: [], fractalDetails: [], biLine: [], segmentBi: [], segments: [],
      pendingSegments: [], outlook: { ok: false, reason: 'invalid_candle' }, trades: [], inputProblem,
      definition: { segmentHistoryStart: null } };
    return { ...analysis, recursiveReadiness: assessRecursiveReadiness(rows, analysis, { period: String(period) }) };
  }
  const bars = rows.filter((r) => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite));
  // Coordinates refer to the original history, even after the reference engine trims its prefix.
  const candles = bars.map((r, i) => ({ ...r, time: i + 1, vol: r.volume }));
  const result = analyzeReferenceCandles(candles);
  const point = (p) => ({ ...p, idx: p.time - 1 });
  const bi = result.bi.map(point);
  const segmentBi = result.segmentBi.map(point);
  const segmentResult = buildSegments(segmentBi);
  const rangeResult = withRawSegmentRanges(segmentResult.segments, candles);
  const { segments } = rangeResult;
  const segmentCandidate = rangeResult.unresolved ? [] : segmentResult.pending;
  // Only an already-established three-stroke candidate may extend dynamically.
  // Its raw extremum belongs to a real K and never enters confirmed evidence.
  let pendingSegments = [];
  if (segmentCandidate.length === 2) {
    const [start, end] = segmentCandidate;
    const up = end.price > start.price;
    let extreme = null;
    for (const candle of candles) {
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
  const { zones: zs, uncertainties: zsUncertainty } = buildZsDetailed(segments);
  // A separate pen-based visual reference; never feed it into the segment
  // outlook or trades, where it would be mistaken for a recursive center.
  const { zones: penZs, uncertainties: penZsUncertainty } = buildPenCenters(bi, candles);
  const dateAt = (time) => bars[time - 1]?.date;
  const datedPoint = (p) => ({ ...p, time: dateAt(p.time) });
  // Boundary labels use the exact source segment's extremum, not an unrelated
  // earlier candle at the same price. Confirmation stays separate from geometry.
  const datedZones = zs.map((z) => ({ ...z, sdt: dateAt(z.sdt), edt: dateAt(z.edt),
    zg_time: dateAt(z.zg_time), zd_time: dateAt(z.zd_time),
    confirmed_time: dateAt(z.confirmed_time), closed_time: dateAt(z.closed_time) }));
  const datedBi = bi.map(datedPoint);
  const firstUnconfirmed = datedBi.findIndex((p) => p.confirmed !== true);
  const completedBi = firstUnconfirmed < 0 ? datedBi : datedBi.slice(0, firstUnconfirmed);
  const outlook = buildSegmentOutlook({ candles: result.candles.map((c) => ({ ...c, time: c.date })),
    biPoints: completedBi, zsList: datedZones, zsUncertainty,
    close: candles.at(-1)?.close, period });
  const historyOffset = result.candles[0]?.time - 1 || 0;
  const analysis = {
    dates: bars.map((r) => r.date), historyOffset, historyDates: result.candles.map((c) => c.date),
    analysisCandles: result.candles, fx, bi, zs, zsUncertainty, penZs, penZsUncertainty, pending,
    pendingUncertainty: result.pendingUncertainty, fractalDetails: result.fractalDetails,
    biLine: [...bi, ...pending.slice(1)], segmentBi, segments, pendingSegments,
    outlook, trades: buildTrades(datedBi),
    definition: { id: 'chan-old-bi-segment-zs-v3', label: '旧笔、特征序列线段与最低层线段中枢',
      zoneLevel: '本图最小级别线段中枢（未递归构造更高级别）',
      zoneRules: ZS_RULE_VERSION,
      zoneSource: '三个连续已确认线段的价格范围；原始K线内部极值参与计算，端点K线内先后未知时明确记录不确定',
      zoneBoundaryPolicy: '成枢须有正宽重叠；触边仍算延伸；首次回试严格在核心外、同向Z段不触枢或连续两段不触枢均可结束；无法确定时不判定结束',
      historyBars: result.candles.length, requestedBars: candles.length,
      analysisScope: 'all-loaded',
      segmentSource: '全部已加载历史内的已确认笔端，随上游笔回退重算',
      segmentRules: SEGMENT_RULE_VERSION,
      segmentCompletion: 'complete=true才可由本K确认；缺失状态待后继同周期K出现，确认时刻记后继K；complete=false不确认',
      segmentConfirmationScope: '全部已加载历史复算的必要证据K，不等于跨加载范围首次观测或交易信号时刻',
      segmentHistoryBars: candles.length, segmentHistoryStart: candles[0]?.date ?? null,
      skippedInitialBars: historyOffset },
  };
  return { ...analysis, recursiveReadiness: assessRecursiveReadiness(rows, analysis, { period: String(period) }) };
}

// Keep offscreen endpoints intact; clip the original line at the viewport boundary.
export function visibleOffset(data, rows) {
  if (!rows.length) return -1;
  return data.dates.indexOf(rows[0].date);
}
