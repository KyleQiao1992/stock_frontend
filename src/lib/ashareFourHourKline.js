import { fetchAshareMinuteKline } from './ashareMinuteKline.js';
import { klineDateKey, klineTradingDate, parseKlineTime } from './klinePeriod.js';

// Four hours of wall-clock time from 09:30 includes the midday recess. The
// closing session is truncated at 15:00; these are deliberately not 8-bar days.
const WINDOWS = [
  { start: '09:30', end: '13:30', times: ['10:00', '10:30', '11:00', '11:30', '13:30'] },
  { start: '13:30', end: '15:00', times: ['14:00', '14:30', '15:00'] },
];
const CHILD_STARTS = {
  '10:00': '09:30', '10:30': '10:00', '11:00': '10:30', '11:30': '11:00',
  '13:30': '13:00', '14:00': '13:30', '14:30': '14:00', '15:00': '14:30',
};
const PRICE_KEYS = ['open', 'close', 'high', 'low'];

function missingError(day, times) {
  return new Error(`4小时聚合缺少30分钟K线：${day} 缺少 ${times.join('、')}`);
}

function sameSourceBar(left, right) {
  return [...PRICE_KEYS, 'volume', 'amount', 'amountAvailable', 'complete']
    .every(key => left[key] === right[key]);
}

function normalizeRows(rows, nowSeconds, quoteSeconds) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('4小时聚合没有可用的30分钟K线');
  const unique = new Map();
  for (const source of rows) {
    const date = klineDateKey(source?.date);
    const time = date.slice(11);
    if (date.length !== 16 || !CHILD_STARTS[time]
      || parseKlineTime(source?.date) !== parseKlineTime(date)
      || PRICE_KEYS.some(key => !Number.isFinite(source?.[key]) || source[key] <= 0)
      || source.high < Math.max(source.open, source.close)
      || source.low > Math.min(source.open, source.close) || source.low > source.high
      || !Number.isFinite(source.volume) || source.volume < 0
      || typeof source.complete !== 'boolean'
      || (source.amount != null && (!Number.isFinite(source.amount) || source.amount < 0))) {
      throw new Error('4小时聚合的30分钟K线时间、价格、成交量或完成状态异常');
    }
    const day = date.slice(0, 10);
    const childStart = parseKlineTime(`${day} ${CHILD_STARTS[time]}`);
    // A currently forming child may carry its future END label, but a child
    // whose START has not arrived cannot be real current-session data.
    if (childStart > nowSeconds || (Number.isFinite(quoteSeconds) && childStart > quoteSeconds)) {
      throw new Error(`4小时聚合收到尚未开始的30分钟K线：${date}`);
    }
    const normalized = { ...source, date };
    const previous = unique.get(date);
    if (previous && !sameSourceBar(previous, normalized)) {
      throw new Error(`4小时聚合的30分钟K线存在重复冲突：${date}`);
    }
    unique.set(date, normalized);
  }
  return [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/** Aggregate already normalized/adjusted Tencent 30-minute bars. All times are
 * Shanghai time and identify period ENDS, matching the existing minute model.
 * Only a contiguous, closed suffix at the very beginning may be discarded as a
 * pagination cut. Interior gaps are errors, never silently bridged by a chart.
 */
export function aggregateAshareFourHourKline(rows, { now = Date.now(), quoteTime } = {}) {
  const nowSeconds = (typeof now === 'function' ? Number(now()) : Number(now)) / 1000;
  if (!Number.isFinite(nowSeconds)) throw new Error('4小时聚合本地时间无效');
  const quoteSeconds = parseKlineTime(quoteTime);
  const sourceRows = normalizeRows(rows, nowSeconds, quoteSeconds);
  const groups = new Map();
  const days = new Map();
  for (const row of sourceRows) {
    const day = klineTradingDate(row.date), time = row.date.slice(11);
    const windowIndex = time <= '13:30' ? 0 : 1;
    const key = `${day} ${WINDOWS[windowIndex].end}`;
    if (!groups.has(key)) groups.set(key, { day, windowIndex, rows: [] });
    groups.get(key).rows.push(row);
    if (!days.has(day)) days.set(day, new Set());
    days.get(day).add(windowIndex);
  }
  const nowDay = klineTradingDate(nowSeconds);
  const firstDay = sourceRows[0].date.slice(0, 10);
  for (const [day, present] of days) {
    // No exchange calendar is invented: entirely absent dates may be holidays
    // or suspensions. Once a date is present, its two sessions must be sound.
    // The oldest response can begin at 14:00 after an entire leading window.
    if (!present.has(0) && day !== firstDay) throw missingError(day, WINDOWS[0].times);
    const overdueAfternoon = WINDOWS[1].times.filter(time => nowSeconds >= parseKlineTime(`${day} ${time}`) + 60);
    if (!present.has(1) && overdueAfternoon.length) {
      throw missingError(day, overdueAfternoon);
    }
  }

  const orderedGroups = [...groups.values()];
  let discardedSourceBarCount = 0;
  let previousClose = null;
  const klines = [];
  for (const [index, group] of orderedGroups.entries()) {
    const { day, rows: children, windowIndex } = group;
    const window = WINDOWS[windowIndex];
    const actualTimes = children.map(row => row.date.slice(11));
    const missing = window.times.filter(time => !actualTimes.includes(time));
    const periodStart = `${day} ${window.start}`, periodEnd = `${day} ${window.end}`;
    const startSeconds = parseKlineTime(periodStart), endSeconds = parseKlineTime(periodEnd);
    if (missing.length) {
      const suffix = window.times.slice(-actualTimes.length);
      const isLeadingCut = index === 0 && orderedGroups.length > 1
        && actualTimes.length < window.times.length
        && actualTimes.every((time, offset) => time === suffix[offset]);
      if (isLeadingCut) {
        discardedSourceBarCount += children.length;
        continue;
      }
      const isPrefix = actualTimes.every((time, offset) => time === window.times[offset]);
      const isCurrentWindow = index === orderedGroups.length - 1 && day === nowDay
        && nowSeconds >= startSeconds && nowSeconds < endSeconds + 60;
      if (!isPrefix || !isCurrentWindow) throw missingError(day, missing);
      // A prefix is valid only while its absent children are genuinely current
      // or future. A stale source clock must not conceal earlier closed bars.
      const overdueMissing = missing.filter(time => nowSeconds >= parseKlineTime(`${day} ${time}`) + 60);
      if (overdueMissing.length) throw missingError(day, overdueMissing);
    }
    const first = children[0], last = children.at(-1);
    const open = first.open, close = last.close;
    const high = Math.max(...children.map(row => row.high));
    const low = Math.min(...children.map(row => row.low));
    const change = previousClose === null ? 0 : close - previousClose;
    const pct = previousClose ? change / previousClose * 100 : 0;
    const amplitude = previousClose ? (high - low) / previousClose * 100 : 0;
    const complete = !missing.length && children.every(row => row.complete)
      && Number.isFinite(quoteSeconds) && quoteSeconds >= endSeconds && nowSeconds >= endSeconds + 60;
    const amountAvailable = children.every(row => row.amountAvailable === true && Number.isFinite(row.amount));
    const asOfTime = Number.isFinite(quoteSeconds)
      ? klineDateKey(Math.min(quoteSeconds, nowSeconds, endSeconds)) : null;
    klines.push({ date: periodEnd, open, close, high, low,
      volume: children.reduce((sum, row) => sum + row.volume, 0),
      amount: amountAvailable ? children.reduce((sum, row) => sum + row.amount, 0) : 0,
      amountAvailable, turnover: null, change, pct, amplitude, complete,
      periodStart, periodEnd, lastSourceTime: last.date, asOfTime,
      sourcePeriod: '30', sourceBarCount: children.length, expectedSourceBarCount: window.times.length });
    previousClose = close;
  }
  if (!klines.length) throw new Error('4小时聚合没有完整或有效形成中的时间窗口');
  return { klines, sourceBarCount: sourceRows.length, discardedSourceBarCount };
}

/** Reuse the existing source's pagination, price adjustment and lot units before
 * aggregation, so a 4h candle cannot mix adjusted prices with raw history. */
export async function fetchAshareFourHourKline({ period, limit = 2400, now = Date.now(), ...options }) {
  if (period != null && String(period) !== '240') throw new Error('4小时行情周期必须为240');
  const snapshotNow = typeof now === 'function' ? now() : now;
  const source = await fetchAshareMinuteKline({ ...options, period: '30', limit, now: snapshotNow });
  const symbol = String(options.symbol || '').toLowerCase();
  const quoteText = String(source.quotePayload?.data?.[symbol]?.qt?.[symbol]?.[30] ?? '');
  const quoteTime = /^\d{14}$/.test(quoteText) && Number.isFinite(parseKlineTime(quoteText)) ? quoteText : undefined;
  const { klines, sourceBarCount, discardedSourceBarCount } = aggregateAshareFourHourKline(source.klines,
    { now: snapshotNow, quoteTime });
  return { klines, quotePayload: source.quotePayload,
    sourceInfo: `Tencent 30m → 4h (09:30–13:30 / 13:30–15:00), ${klines.length} bars from ${sourceBarCount} source bars; discarded leading=${discardedSourceBarCount}; ${source.sourceInfo}` };
}
