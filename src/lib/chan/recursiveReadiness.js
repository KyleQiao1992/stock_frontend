import { validMarketDate } from '../marketKlineIntegrity.js';

/**
 * Inspect the real lowest-layer segment/center output before recursion.
 *
 * This reports observed segment geometry and missing evidence, not completed
 * trends, consolidations, higher-level centers or trading signals. In
 * particular a closed segment-based center is not a completed movement.
 *
 * `analysis` must be the `analyzeChan` result for exactly `rows`, in the same
 * order and the same observation window. Its source/adjustment and absence
 * of missing market sessions remain caller-supplied, not verified here.
 */
export function recursiveHistoryBasis(rows, period) {
  // Keep exact input values, including the complete flag and prefix which the
  // pen engine can trim after using it to choose the initial stroke. Comparing
  // only retained analysisCandles would accept stale evidence for a revision.
  // JSON normally serializes NaN, Infinity and null identically. Invalid
  // histories need a distinct basis too, so retain each value's type.
  const encode = value => {
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN'
      : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    return [typeof value];
  };
  return JSON.stringify([period, rows.map(row => row == null ? encode(row)
    : [encode(row.date), encode(row.open), encode(row.high), encode(row.low),
      encode(row.close), encode(row.volume), encode(row.complete)])]);
}

export function assessRecursiveReadiness(rows, analysis, { period = 'day', asOfTime = rows?.length } = {}) {
  if (!Array.isArray(rows) || !analysis || typeof analysis !== 'object') throw new TypeError('rows and analysis are required');
  if (typeof period !== 'string' || !period.trim()) throw new TypeError('period is required');
  // A full-history analysis cannot be inspected as if it was known in an
  // earlier prefix. Call analyzeChan on that prefix before calling this API.
  if (!Number.isSafeInteger(asOfTime) || asOfTime !== rows.length) throw new RangeError('analysis must use the exact observation prefix');
  const source = { period, start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null,
    bars: rows.length, basis: 'caller_supplied', historyBeforeStart: 'unverified', marketContinuity: 'unverified' };
  const nextLevel = { relativeLevel: 1, status: 'undetermined', completedMovements: null, centers: null,
    missingEvidence: ['completed_lower_level_movements', 'movement_completion_proof', 'consistent_decomposition'] };
  if (analysis.recursiveHistoryBasis !== recursiveHistoryBasis(rows, period)) {
    throw new RangeError('analysis and observation history basis must match');
  }
  if (analysis.inputProblem) return { status: 'invalid_input', source,
    inputProblem: { ...analysis.inputProblem }, foundation: { confirmedSegmentCount: 0, centers: [], uncertaintyCount: 0 }, nextLevel };
  if (!Array.isArray(analysis.dates) || analysis.dates.length !== rows.length
      || rows.some((row, i) => !row || row.date !== analysis.dates[i])) {
    throw new RangeError('analysis and observation history basis must match');
  }
  const dates = new Set();
  let previousDate = null;
  const comparableDate = date => /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(date);
  const calendarKey = rows.find(row => typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.date))?.date;
  const calendarSeries = calendarKey != null;
  const dateLength = calendarKey?.length;
  for (const row of rows) {
    if (typeof row.date !== 'string' || !row.date.trim() || dates.has(row.date)
        || (calendarSeries && (!validMarketDate(row.date) || row.date.length !== dateLength))
        || (previousDate && comparableDate(previousDate) && comparableDate(row.date) && row.date <= previousDate)
        || ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
        || row.high < row.low || row.high < Math.max(row.open, row.close)
        || row.low > Math.min(row.open, row.close) || row.volume < 0
        || (row.complete != null && typeof row.complete !== 'boolean')) {
      throw new RangeError('invalid source history for segment evidence');
    }
    dates.add(row.date); previousDate = row.date;
  }
  if (!Array.isArray(analysis.analysisCandles) || !Array.isArray(analysis.segmentBi)
      || !Array.isArray(analysis.segments) || !Array.isArray(analysis.zs)
      || !Array.isArray(analysis.zsUncertainty)) throw new TypeError('segment analysis evidence is required');

  // Verify the candles retained by the local engine against the supplied
  // history. Its skipped prefix and provider completeness remain unverified.
  for (const candle of analysis.analysisCandles) {
    const raw = rows[candle.time - 1];
    if (!Number.isSafeInteger(candle.time) || !raw || candle.date !== raw.date
        || ['open', 'high', 'low', 'close', 'volume'].some(key => candle[key] !== raw[key])
        || (candle.complete ?? null) !== (raw.complete ?? null)) {
      throw new RangeError('analysis candle history basis does not match');
    }
  }

  const segments = analysis.segments;
  const seen = new Set();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const start = s?.start, end = s?.end;
    const validPoint = p => p && Number.isSafeInteger(p.time) && p.time > 0 && p.time <= rows.length
      && Number.isFinite(p.price) && p.price >= rows[p.time - 1].low && p.price <= rows[p.time - 1].high;
    if (!s || typeof s.id !== 'string' || !s.id || seen.has(s.id) || s.confirmed !== true
        || !validPoint(start) || !validPoint(end) || start.time >= end.time
        || !Number.isSafeInteger(s.confirmed_time) || s.confirmed_time < end.time || s.confirmed_time > asOfTime
        || !Number.isSafeInteger(s.startIndex) || !Number.isSafeInteger(s.endIndex)
        || !Number.isSafeInteger(s.confirmedIndex) || s.confirmedIndex < s.endIndex
        || s.confirmedIndex >= analysis.segmentBi.length
        || s.endIndex - s.startIndex !== s.stroke_count || s.stroke_count < 3 || s.stroke_count % 2 !== 1
        || !Number.isFinite(s.high) || !Number.isFinite(s.low) || s.low >= s.high
        || (s.direction === 'up' ? start.price >= end.price : s.direction === 'down' ? start.price <= end.price : true)) {
      throw new RangeError('invalid confirmed segment evidence');
    }
    const startBi = analysis.segmentBi[s.startIndex], endBi = analysis.segmentBi[s.endIndex];
    if (!startBi || !endBi || startBi.time !== start.time || startBi.price !== start.price
        || endBi.time !== end.time || endBi.price !== end.price) throw new RangeError('segment endpoints do not match confirmed pen evidence');
    const proofPoints = analysis.segmentBi.slice(s.startIndex, s.confirmedIndex + 1);
    if (proofPoints.some((point, index) => point.confirmed !== true
        || !Number.isSafeInteger(point.confirmed_time) || point.confirmed_time > s.confirmed_time
        || (index > 0 && (point.time <= proofPoints[index - 1].time || point.mark === proofPoints[index - 1].mark)))) {
      throw new RangeError('segment confirmation does not match completed pen evidence');
    }
    for (let time = start.time + 1; time < end.time; time++) {
      const bar = rows[time - 1];
      if (bar.high > s.high || bar.low < s.low) throw new RangeError('segment range omits an interior candle');
    }
    const previous = segments[i - 1];
    if (previous && (previous.end.time !== start.time || previous.end.price !== start.price
        || previous.direction === s.direction || previous.confirmed_time > s.confirmed_time)) {
      throw new RangeError('confirmed segments are not connected in evidence order');
    }
    seen.add(s.id);
  }

  const centers = analysis.zs.map(z => {
    if (!z || !Number.isSafeInteger(z.startIndex) || !Number.isSafeInteger(z.endIndex)
        || z.startIndex < 0 || z.endIndex < z.startIndex + 2 || z.endIndex >= segments.length
        || z.segment_count !== z.endIndex - z.startIndex + 1
        || !Number.isFinite(z.zd) || !Number.isFinite(z.zg) || z.zd >= z.zg
        || !Number.isSafeInteger(z.confirmed_time) || z.confirmed_time > asOfTime) {
      throw new RangeError('invalid lowest-layer center evidence');
    }
    const members = segments.slice(z.startIndex, z.endIndex + 1);
    const first = members.slice(0, 3);
    if (z.sdt !== first[0].start.time || z.edt !== members.at(-1).end.time
        || z.zd !== Math.max(...first.map(s => s.low)) || z.zg !== Math.min(...first.map(s => s.high))
        || z.confirmed_time < Math.max(...first.map(s => s.confirmed_time))
        || !Array.isArray(z.segment_ids) || z.segment_ids.length !== members.length
        || members.some((s, i) => s.id !== z.segment_ids[i])) throw new RangeError('center does not match its segment evidence');
    if (z.closed_time != null && (!Number.isSafeInteger(z.closed_time)
        || z.closed_time < z.confirmed_time || z.closed_time > asOfTime)) throw new RangeError('invalid center closure time');
    return { id: z.id, start: z.sdt, end: z.edt, zd: z.zd, zg: z.zg,
      observedAt: z.confirmed_time, closedAt: z.closed_time ?? null,
      phase: z.phase, status: z.status, segmentIds: [...z.segment_ids], evidenceType: 'confirmed_segment_geometry' };
  });
  const uncertainties = analysis.zsUncertainty.length;
  const status = segments.length < 3 ? 'insufficient_confirmed_segments'
    : centers.length ? 'movement_completion_unproven'
      : uncertainties ? 'center_formation_uncertain' : 'no_confirmed_minimum_center';
  return { status, source, foundation: { confirmedSegmentCount: segments.length, centers, uncertaintyCount: uncertainties }, nextLevel };
}
