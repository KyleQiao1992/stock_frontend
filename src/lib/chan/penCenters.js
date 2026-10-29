import { buildZsDetailed } from './zs.js';

// The shared geometry machine uses segment terminology; this caller supplies
// pens, so translate its evidence rather than mislabeling a pen as a segment.
function penEvidence(evidence) {
  const convert = item => item && ({
    kind: ({ three_completed_segments: 'three_completed_pens',
      z_segment_outside: 'z_pen_outside', two_consecutive_segments_outside: 'two_consecutive_pens_outside' })[item.kind] ?? item.kind,
    pen_ids: item.segment_ids,
    pens: item.segments,
    confirmed_time: item.confirmed_time,
  });
  return {
    formation: convert(evidence.formation), extension: convert(evidence.extension), closure: convert(evidence.closure),
    previous_zone: evidence.previous_zone ? { ...evidence.previous_zone, id: `pen-${evidence.previous_zone.id}` } : null,
  };
}

/**
 * Lowest-layer pen-constructed centers. A pen is a completed pair of adjacent
 * endpoints; it is not a recursively classified lower-level movement. Keep
 * this output separate from segment centers and all trading signals.
 */
export function buildPenCenters(points, candles) {
  const pens = [];
  let incomplete = false;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1];
    if (start.confirmed !== true || !Number.isSafeInteger(start.confirmed_time)
        || start.confirmed_time > candles.length) break;
    const slice = candles.slice(start.time - 1, end.time);
    if (!slice.length || slice[0].time !== start.time || slice.at(-1).time !== end.time) {
      throw new RangeError('pen endpoint is outside the candle history');
    }
    let highPoint = { ...start, mark: 'G' }, lowPoint = { ...start, mark: 'D' };
    let possibleHigh = -Infinity, possibleLow = Infinity;
    let knownAt = start.confirmed_time;
    for (const candle of slice) {
      const closedAt = candle.complete === true ? candle.time
        : candle.complete === false ? null : candles[candle.time]?.time;
      if (!Number.isFinite(closedAt)) { incomplete = true; break; }
      knownAt = Math.max(knownAt, closedAt);
      possibleHigh = Math.max(possibleHigh, candle.high);
      possibleLow = Math.min(possibleLow, candle.low);
      if (candle.time > start.time && candle.time < end.time) {
        if (candle.high > highPoint.price) highPoint = { time: candle.time, idx: candle.time - 1, price: candle.high, mark: 'G' };
        if (candle.low < lowPoint.price) lowPoint = { time: candle.time, idx: candle.time - 1, price: candle.low, mark: 'D' };
      }
    }
    if (incomplete) break;
    if (end.price > highPoint.price) highPoint = { ...end, mark: 'G' };
    if (end.price < lowPoint.price) lowPoint = { ...end, mark: 'D' };
    pens.push({ id: `pen-${start.time}-${end.time}`, start, end,
      direction: end.price > start.price ? 'up' : 'down', confirmed: true, confirmed_time: knownAt,
      high: highPoint.price, low: lowPoint.price, high_time: highPoint.time, low_time: lowPoint.time,
      high_point: highPoint, low_point: lowPoint,
      range_bounds: { high_min: highPoint.price, high_max: possibleHigh, low_min: possibleLow, low_max: lowPoint.price } });
  }
  const result = buildZsDetailed(pens);
  return { zones: result.zones.map(zone => ({
    id: `pen-${zone.id}`, sdt: zone.sdt, edt: zone.edt,
    zg: zone.zg, zd: zone.zd, confirmed_time: zone.confirmed_time,
    closed_time: zone.closed_time, status: zone.status, phase: zone.phase, pen_count: zone.segment_count,
    // Preserve the underlying geometric evidence, while deliberately not
    // exporting the state machine's trade-shaped alias or segment-level label.
    evidence: penEvidence(zone.evidence),
  })), uncertainties: [...result.uncertainties, ...(incomplete ? [{ reason: 'incomplete_candle' }] : [])] };
}
