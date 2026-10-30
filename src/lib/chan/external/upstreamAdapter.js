import { parseKlineTime } from '../../klinePeriod.js';
import { analyze } from './upstream.js';

// The upstream algorithm is retained verbatim, including its approximations.
// This adapter must never repair its segments or substitute local structures.
const PERIODS = { '5': '5m', '30': '30m', '240': '4h', '240m': '4h',
  '101': 'day', '102': 'week', '103': 'month', '1m': '1m', '5m': '5m',
  '15m': '15m', '30m': '30m', '60m': '60m', '4h': '4h', day: 'day', week: 'week', month: 'month' };

/** Independent, historical upstream replay, not a recursive movement center. */
export function analyzeUpstreamReference(rows, period = 'day') {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const dates = rows.map(row => row?.date ?? null);
  const definition = {
    engine: 'upstream', label: '开源原版对照',
    source: 'https://github.com/JustinGongjj/chan-structure-workstation',
    revision: '274f7a2d730bf961aa93d1d33b4359a455c542cd',
    zoneLevel: '原版三笔重叠，非递归走势中枢',
    segmentSource: '开源原版近似线段',
    confirmationScope: '原版历史复算，不提供独立确认依据K',
  };
  const result = { dates, definition, upstreamRaw: null, lastBarCompletion: rows.at(-1)?.complete ?? null, bi: [], biLine: [], fx: [],
    segments: [], pendingSegments: [], zs: [], penZs: [], zsUncertainty: [],
    penZsUncertainty: [], pendingUncertainty: [], fractalDetails: {}, trades: [] };
  const upstreamPeriod = PERIODS[String(period)];
  if (!upstreamPeriod) return { ...result, inputProblem: { reason: 'unsupported_period', index: -1, date: null } };

  const bars = [];
  let previousTimestamp = -Infinity;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const date = row?.date ?? null;
    if (!row || typeof date !== 'string' || !date.trim()
        || ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
        || row.high < row.low || row.high < Math.max(row.open, row.close)
        || row.low > Math.min(row.open, row.close) || row.volume < 0
        || (row.complete != null && typeof row.complete !== 'boolean')) {
      return { ...result, inputProblem: { reason: 'invalid_candle', index, date } };
    }
    // The original `analyze` filters c <= 0 before indexing its output. Reject
    // it instead of silently joining the two sides into a different history.
    if (row.close <= 0) return { ...result, inputProblem: { reason: 'upstream_non_positive_close', index, date } };
    const timestamp = parseKlineTime(date) * 1000;
    if (!Number.isFinite(timestamp)) return { ...result, inputProblem: { reason: 'invalid_timestamp', index, date } };
    if (timestamp <= previousTimestamp) return { ...result, inputProblem: { reason: 'non_increasing_timestamp', index, date } };
    previousTimestamp = timestamp;
    bars.push({ t: timestamp, o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume });
  }

  // Pass the full checked history explicitly: upstream's implicit limit is 800.
  // An empty history needs a positive limit because upstream uses `|| 800`.
  const upstreamRaw = analyze(bars, { period: upstreamPeriod, limit: Math.max(1, bars.length) });
  const segments = upstreamRaw.segments.map((segment, index) => ({
    id: `upstream-segment-${index}`, start: { time: segment.i0 + 1, price: segment.p0 },
    end: { time: segment.i1 + 1, price: segment.p1 },
    direction: segment.dir === 1 ? 'up' : 'down', stroke_count: segment.endBi - segment.startBi + 1,
    done: segment.done,
  }));
  const zs = upstreamRaw.pivots.map(pivot => ({
    id: `upstream-pivot-${pivot.idx}`, sdt: pivot.i0 + 1, edt: pivot.i1 + 1,
    zg: pivot.zg, zd: pivot.zd, pen_count: pivot.count, segment_count: pivot.count,
    status: 'reference', isLast: pivot.active,
  }));
  return { ...result, upstreamRaw, segments, zs };
}
