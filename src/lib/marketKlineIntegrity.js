/** Empty provider fields are missing data, not a numeric zero. */
export function marketNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return NaN;
  return Number(value);
}

export function validMarketDate(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
    && (match[2] == null || (+match[2] <= 23 && +match[3] <= 59 && +(match[4] ?? 0) <= 59));
}

/** Reject corrupt series without splicing neighbours. Cash-adjusted historical
 * prices may be zero/negative; raw traded prices must still be positive. */
export function assertMarketKlines(rows, { adjusted = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('行情 K 线数据格式异常：没有数据');
  let previous = '';
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!validMarketDate(row?.date) || (previous && (row.date <= previous || row.date.length !== previous.length))
        || ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
        || (adjusted !== true && Math.min(row.open, row.high, row.low, row.close) <= 0) || row.volume < 0
        || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)
        || row.high < row.low || (row.complete != null && typeof row.complete !== 'boolean')) {
      throw new Error(`行情 K 线第 ${index + 1} 行数据格式异常`);
    }
    previous = row.date;
  }
  return rows;
}
