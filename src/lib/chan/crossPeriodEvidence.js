import { klineDateKey, parseKlineTime } from '../klinePeriod.js';

const FIELDS = ['open', 'high', 'low', 'close', 'volume'];

function sourceIdentity(info, period) {
  const keys = ['provider', 'symbol', 'adjustment'];
  if (!info || keys.some(key => typeof info[key] !== 'string' || !info[key].trim()) || info.period !== period) {
    throw new TypeError(`explicit ${period} provenance is required`);
  }
  return Object.fromEntries([...keys, 'period'].map(key => [key, info[key]]));
}

function moment(value, name) {
  const seconds = parseKlineTime(value);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(seconds)) throw new TypeError(`${name} must be a valid second timestamp`);
  return seconds;
}

// Each input must be the actual caller-declared snapshot, containing only
// candles ending no later than that snapshot. Future OHLC/completion fields
// are not read. This strict contract prevents a later final data file from
// being presented as a historical observation made before it existed.
function visibleRows(rows, snapshot, period) {
  if (!Array.isArray(rows)) throw new TypeError(`${period} rows must be an array`);
  const bars = [];
  let previous = -Infinity;
  for (const row of rows) {
    const date = row?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)
        || klineDateKey(date) !== date) throw new RangeError(`${period} invalid date`);
    const time = moment(date, `${period} date`);
    if (time > snapshot) throw new RangeError(`${period} snapshot contains a candle ending after its observation time`);
    if (time <= previous) throw new RangeError(`${period} timestamps must be strictly increasing and unique`);
    if (time % (period === '5m' ? 300 : 1800) !== 0) throw new RangeError(`${period} timestamp not aligned to period`);
    previous = time;
    const { open, high, low, close, volume, complete } = row;
    if (![open, high, low, close, volume].every(Number.isFinite) || volume < 0
        || high < low || high < Math.max(open, close) || low > Math.min(open, close)
        || (complete != null && typeof complete !== 'boolean')) {
      throw new RangeError(`${period} invalid candle`);
    }
    bars.push({ date, time, open, high, low, close, volume, complete: complete ?? null });
  }
  return bars;
}

function confirmationAt(bars, index) {
  const bar = bars[index];
  if (bar.complete === true) return bar.time;
  if (bar.complete === false) return null;
  return bars[index + 1]?.time ?? null;
}

/**
 * Compare independently supplied, caller-declared same-basis 5m and 30m
 * price histories. Each observation timestamp is when that *whole supplied
 * snapshot* became available, not the end time of its last candle. Input
 * snapshots after asOf and rows ending after their snapshot are rejected;
 * the caller must pass the actual historical prefix at that snapshot. This
 * deliberately excludes a still-forming future-labelled bar from the input.
 *
 * Prices may be compared with an explicitly selected tolerance (defaults 0);
 * volume uses its own tolerance. A six-bar window is called complete only
 * when all six 5m records and the 30m record have observable completion.
 * Equal intervals / matching OHLC do not prove the market trading calendar,
 * provider identity or adjustment, and never prove completed movements,
 * Chan levels or recursively defined centers.
 */
export function compareFiveMinuteToThirtyMinute({ fiveRows, thirtyRows, fiveProvenance, thirtyProvenance,
  fiveSnapshotAt, thirtySnapshotAt, asOfTime, priceTolerance = 0, volumeTolerance = 0 } = {}) {
  const fiveSource = sourceIdentity(fiveProvenance, '5m');
  const thirtySource = sourceIdentity(thirtyProvenance, '30m');
  if (['provider', 'symbol', 'adjustment'].some(key => fiveSource[key] !== thirtySource[key])) {
    throw new RangeError('5m and 30m provenance basis must match');
  }
  if (![priceTolerance, volumeTolerance].every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('comparison tolerances must be finite and nonnegative');
  }
  const asOf = moment(asOfTime, 'asOfTime');
  const fiveSnapshot = moment(fiveSnapshotAt, 'fiveSnapshotAt');
  const thirtySnapshot = moment(thirtySnapshotAt, 'thirtySnapshotAt');
  if (fiveSnapshot > asOf || thirtySnapshot > asOf) throw new RangeError('snapshot cannot be observed after asOfTime');
  const fives = visibleRows(fiveRows, fiveSnapshot, '5m');
  const thirties = visibleRows(thirtyRows, thirtySnapshot, '30m');
  const byTime = new Map(fives.map((bar, index) => [bar.time, { bar, index }]));
  const windows = thirties.map((target, targetIndex) => {
    const times = Array.from({ length: 6 }, (_, index) => target.time - (5 - index) * 300);
    const parts = times.map(time => byTime.get(time));
    const missing = times.filter((_, index) => !parts[index]);
    const base = { end: target.date, endTime: target.time, constituentTimes: times };
    if (missing.length) {
      const first = fives[0]?.time, last = fives.at(-1)?.time;
      const outsideCoverage = !fives.length || missing.some(time => time < first || time > last);
      return { ...base, status: 'missing', reason: outsideCoverage ? 'outside_observed_5m_coverage' : 'missing_5m_inside_observed_coverage', missingTimes: missing };
    }
    const sourceConfirmedAt = parts.map(part => confirmationAt(fives, part.index));
    const targetConfirmedAt = confirmationAt(thirties, targetIndex);
    if (targetConfirmedAt == null || sourceConfirmedAt.some(time => time == null)) {
      return { ...base, status: 'unconfirmed', targetConfirmedAt, sourceConfirmedAt,
        reason: 'one_or_more_candles_unfinished_or_without_observed_successor' };
    }
    const members = parts.map(part => part.bar);
    const aggregate = { open: members[0].open, high: Math.max(...members.map(bar => bar.high)),
      low: Math.min(...members.map(bar => bar.low)), close: members.at(-1).close,
      volume: members.reduce((sum, bar) => sum + bar.volume, 0) };
    if (!Number.isFinite(aggregate.volume)) throw new RangeError('aggregated volume is not finite');
    const differences = FIELDS.filter(key => Math.abs(aggregate[key] - target[key])
      > (key === 'volume' ? volumeTolerance : priceTolerance)).map(key => ({ field: key,
      from5m: aggregate[key], from30m: target[key] }));
    const confirmationBasisAt = Math.max(targetConfirmedAt, ...sourceConfirmedAt);
    return { ...base, status: differences.length ? 'conflict' : 'complete', aggregate,
      compared: Object.fromEntries(FIELDS.map(key => [key, target[key]])), differences,
      confirmationBasisAt, observedAt: Math.max(confirmationBasisAt, fiveSnapshot, thirtySnapshot) };
  });
  return { fiveProvenance: fiveSource, thirtyProvenance: thirtySource, asOfTime: asOf,
    fiveSnapshotAt: fiveSnapshot, thirtySnapshotAt: thirtySnapshot,
    scope: 'caller_declared_basis_no_calendar_or_recursive_movement_proof',
    priceTolerance, volumeTolerance, windows };
}
