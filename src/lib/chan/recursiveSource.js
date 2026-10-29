/** Prepare source evidence for the recursive center engine without silently
 * deleting malformed rows or claiming that provider history is complete.
 *
 * The four provenance fields identify the caller's chosen source. They do not
 * independently authenticate the feed, its adjustment, or trading calendar.
 * The first candle date anchors one-based coordinates; it cannot prove that
 * the provider did not omit or revise other candles in the same history.
 */
export function prepareRecursiveSource(rows, provenance) {
  const names = ['provider', 'symbol', 'period', 'adjustment'];
  if (!provenance || names.some(name => typeof provenance[name] !== 'string' || !provenance[name].trim())) {
    throw new TypeError('explicit source provenance is required');
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new RangeError('source rows must not be empty');

  let previous = null;
  let precision = null;
  const bars = rows.map((row, index) => {
    const date = row?.date;
    const match = typeof date === 'string' && date.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) throw new RangeError(`source row ${index + 1} has an invalid date`);
    const [, y, m, d, hour, minute, second] = match;
    const parts = [Number(y), Number(m), Number(d), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0)];
    const instant = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (instant.getUTCFullYear() !== parts[0] || instant.getUTCMonth() !== parts[1] - 1
        || instant.getUTCDate() !== parts[2] || instant.getUTCHours() !== parts[3]
        || instant.getUTCMinutes() !== parts[4] || instant.getUTCSeconds() !== parts[5]) {
      throw new RangeError(`source row ${index + 1} has an invalid date`);
    }
    const rowPrecision = hour == null ? 'day' : second == null ? 'minute' : 'second';
    if (precision != null && rowPrecision !== precision) throw new RangeError('source date time precision must be consistent');
    precision = rowPrecision;
    const timestamp = instant.getTime();
    if (previous != null && timestamp <= previous) throw new RangeError('source dates must be strictly increasing');
    previous = timestamp;

    const { open, high, low, close, complete } = row;
    if (![open, high, low, close].every(Number.isFinite) || high < low
        || open < low || open > high || close < low || close > high) {
      throw new RangeError(`source row ${index + 1} has invalid price data`);
    }
    if (complete != null && typeof complete !== 'boolean') {
      throw new TypeError(`source row ${index + 1} has an invalid completion state`);
    }
    return { ...row, time: index + 1 };
  });
  // A truncated history starts its ordinal clock at a different date. Without
  // this anchor, the same basis and ordinal could refer to different candles.
  // Appending later candles keeps the origin stable.
  const basis = JSON.stringify([...names.map(name => provenance[name]), bars[0].date]);
  return {
    basis, bars,
    provenance: Object.fromEntries(names.map(name => [name, provenance[name]])),
    coverage: { start: bars[0].date, end: bars.at(-1).date,
      continuity: 'not_verified', history_before_start: 'not_verified' },
  };
}
