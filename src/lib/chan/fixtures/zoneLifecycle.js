// Synthetic closed OHLC for the active old-pen -> confirmed-segment pipeline.
// No algorithm output is mocked. Each price leg contains eight candles, so the
// turning fractals have independent processed candles between them.
//
// Hand construction:
//   Initial downward leg fixes the first bottom at K9.
//   0 -> 10 -> 4 -> 12 and 12 -> 2 -> 8 -> 0 are alternating three-pen
//   segments. Each next three-pen segment breaks its predecessor's first
//   reverse pen. Segment endpoints occur at K9 + 24*n; their necessary
//   upstream pen-confirmation candle occurs at K42 + 24*n.
//   Thus the first three segments finish at K33/K57/K81, and their evidence
//   arrives at K66/K90/K114. Their common actual range is [199.9, 212.1].
//
// After twelve segments, the tail leaves the core and completes an outside
// retest. The next upward segment shares a new three-segment intersection
// with the departure and retest. Reusing that departure is required to find
// the earliest new core; starting only after the retest would miss it.
export const ZONE_LIFECYCLE_TURNS = Object.freeze([
  20, 0,
  ...Array.from({ length: 6 }, () => [10, 4, 12, 2, 8, 0]).flat(),
  18, 5, 20, 16.5, 19, 16, 18, 17, 21, 17.5, 20, 16.5, 19, 18, 22,
]);

export function zoneLifecycleRows(count = 417, sign = 1) {
  if (sign !== 1 && sign !== -1) throw new RangeError('sign must be 1 or -1');
  return ZONE_LIFECYCLE_TURNS.flatMap((price, index) => index
    ? Array.from({ length: 8 }, (_, offset) => ZONE_LIFECYCLE_TURNS[index - 1]
      + (price - ZONE_LIFECYCLE_TURNS[index - 1]) * (offset + 1) / 8)
    : [price])
    .slice(0, count).map((price, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: 200 + sign * price, close: 200 + sign * price,
      high: 200 + sign * price + .1, low: 200 + sign * price - .1,
      volume: 100, turnover: 1, complete: true,
    }));
}

// Contained high/low wicks are deliberately omitted by the merged-K pen
// endpoints, but are present in the original OHLC used for a segment's full
// price range. This is synthetic data, not a market-data recording.
export function zoneLifecycleRawExtremesRows(count = 114, sign = 1) {
  const rows = zoneLifecycleRows(count, sign);
  for (const index of [19, 34, 67]) {
    if (!rows[index]) continue;
    if (sign === 1) rows[index].high = 230;
    else rows[index].low = 170;
  }
  return rows;
}

// Two turning bars have a very long opposite wick. OHLC does not reveal if it
// happened before or after the shared endpoint, so the first core's lower (or
// mirrored upper) boundary is not uniquely knowable at this granularity.
export function zoneLifecycleAmbiguousEndpointsRows(count = 114, sign = 1) {
  const rows = zoneLifecycleRows(count, sign);
  for (const index of [32, 56]) {
    if (!rows[index]) continue;
    if (sign === 1) rows[index].low = 190;
    else rows[index].high = 210;
  }
  return rows;
}

// After a proven core, the shared departure/retest turning bar straddles the
// core boundary. Its wick could belong before or after the turning point; the
// first retest therefore cannot be classified from OHLC alone.
export function zoneLifecycleAmbiguousRetestRows(count = 378, sign = 1) {
  const rows = zoneLifecycleRows(count, sign);
  if (rows[320]) {
    if (sign === 1) rows[320].low = 210;
    else rows[320].high = 190;
  }
  return rows;
}

// These expectations follow the explicit chain above, not buildZs output.
// Prefix 402 intentionally requires the next core to start with departure
// segment 12, which also contributed to the old core's final extension.
export const ZONE_LIFECYCLE_CHECKPOINTS = Object.freeze([
  { bars: 113, segments: 2, zones: 0 },
  { bars: 114, segments: 3, zones: 1, members: 3, status: 'active', phase: 'extending' },
  { bars: 258, segments: 9, zones: 1, members: 9, status: 'active', phase: 'extending' },
  { bars: 282, segments: 10, zones: 1, members: 10, status: 'active', phase: 'extending' },
  { bars: 330, segments: 12, zones: 1, members: 12, status: 'active', phase: 'extending' },
  { bars: 353, segments: 12, zones: 1, members: 12, status: 'active', phase: 'extending' },
  { bars: 354, segments: 13, zones: 1, members: 13, status: 'active', phase: 'leaving' },
  { bars: 377, segments: 13, zones: 1, members: 13, status: 'active', phase: 'leaving' },
  { bars: 378, segments: 14, zones: 1, members: 13, status: 'closed', phase: 'completed' },
  { bars: 401, segments: 14, zones: 1, members: 13, status: 'closed', phase: 'completed' },
  { bars: 402, segments: 15, zones: 2, members: 13, status: 'closed', phase: 'completed' },
]);

export function zoneLifecycleLevels(sign = 1) {
  if (sign !== 1 && sign !== -1) throw new RangeError('sign must be 1 or -1');
  return sign === 1 ? {
    first: { id: 'zs-9-81', zd: 199.9, zg: 212.1, formedAt: 114 },
    next: { id: 'zs-297-369', zd: 215.9, zg: 220.1, formedAt: 402 },
    departure: { id: 'segment-297-321', confirmedAt: 354, endPrice: 220.1 },
    retest: { id: 'segment-321-345', confirmedAt: 378, extremePrice: 215.9 },
  } : {
    first: { id: 'zs-9-81', zd: 187.9, zg: 200.1, formedAt: 114 },
    next: { id: 'zs-297-369', zd: 179.9, zg: 184.1, formedAt: 402 },
    departure: { id: 'segment-297-321', confirmedAt: 354, endPrice: 179.9 },
    retest: { id: 'segment-321-345', confirmedAt: 378, extremePrice: 184.1 },
  };
}
