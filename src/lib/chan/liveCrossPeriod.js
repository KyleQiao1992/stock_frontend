import { buildTencentQfqTransforms, fetchAshareMinuteKline } from '../ashareMinuteKline.js';
import { klineTradingDate, parseKlineTime } from '../klinePeriod.js';
import { marketNumber, validMarketDate } from '../marketKlineIntegrity.js';
import { compareFiveMinuteToThirtyMinute } from './crossPeriodEvidence.js';

const BASE_URL = 'https://ifzq.gtimg.cn/appstock/app';
const FIELDS = ['open', 'high', 'low', 'close'];

function seconds(now) {
  const ms = now();
  if (!Number.isFinite(ms) || !Number.isSafeInteger(Math.floor(ms / 1000)) || ms < 0) {
    throw new RangeError('本机快照时间无效');
  }
  return Math.floor(ms / 1000);
}

function snapshotRows(result, symbol, period, at) {
  if (!Array.isArray(result?.klines) || !result.klines.length || !result.quotePayload?.data?.[symbol]) {
    throw new Error(`腾讯 ${period} 分钟行情标的或数据无法核对`);
  }
  if (typeof result.sourceInfo !== 'string' || !result.sourceInfo.startsWith(`Tencent ${period}m, `)
      || !result.sourceInfo.endsWith('unadjusted')) {
    throw new Error(`腾讯 ${period} 分钟行情不是请求的不复权基底`);
  }
  const rows = result.klines.map(row => ({ ...row }));
  let omitted = null;
  for (let i = 0; i < rows.length; i++) {
    const time = parseKlineTime(rows[i]?.date);
    if (!validMarketDate(rows[i]?.date) || rows[i].date.length !== 16 || !Number.isFinite(time)
        || time % (Number(period) * 60) !== 0) throw new Error(`腾讯 ${period} 分钟行情时间无效`);
    if (time <= at) continue;
    if (i !== rows.length - 1 || rows[i].complete !== false || time - at > Number(period) * 60 || omitted) {
      throw new Error(`腾讯 ${period} 分钟行情含异常未来K线`);
    }
    omitted = rows[i];
  }
  if (omitted) rows.pop();
  return { rows, omitted: omitted ? { date: omitted.date, reason: 'future_labelled_open_bar' } : null };
}

function dailyRows(payload, symbol, key) {
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.[symbol]?.[key])) {
    throw new Error(`腾讯${key === 'day' ? '不复权' : '前复权'}日K标的或数据无法核对`);
  }
  const rows = payload.data[symbol][key];
  const seen = new Set();
  for (const row of rows) {
    const date = row?.[0];
    const prices = Array.isArray(row) ? row.slice(1, 5).map(marketNumber) : [];
    if (!validMarketDate(date) || date.length !== 10 || seen.has(date) || prices.length !== 4
        || !prices.every(Number.isFinite) || (key === 'day' && prices.some(price => price <= 0))
        || prices[2] < Math.max(prices[0], prices[1]) || prices[3] > Math.min(prices[0], prices[1])
        || prices[3] > prices[2]) throw new Error(`腾讯${key === 'day' ? '不复权' : '前复权'}日K格式或日期冲突`);
    seen.add(date);
  }
  return rows;
}

/**
 * Fetch two independently delivered minute histories and compare them on the
 * same declared Tencent basis. Stocks selected qfq use ONE jointly derived
 * corporate-action transform for both histories. The recorded times are local
 * receipt/assembly times, not verified provider snapshots or actual trading
 * times. It does not infer completed movements or recursive centers.
 */
export async function inspectLiveCrossPeriod({ symbol, code, adjust, isIndex = false,
  loadMinute = fetchAshareMinuteKline, loadJson, now = () => Date.now(), limit = 1320 } = {}) {
  const instrument = String(symbol || '').toLowerCase();
  const stockCode = String(code || '');
  if (!/^(?:sh|sz|bj)\d{6}$/.test(instrument) || stockCode !== instrument.slice(2)) {
    throw new Error('跨周期核对需要一致的完整腾讯标的与代码');
  }
  if (!['0', '1'].includes(String(adjust)) || typeof isIndex !== 'boolean') throw new Error('跨周期复权口径无效');
  if (typeof loadMinute !== 'function' || typeof loadJson !== 'function' || typeof now !== 'function') {
    throw new TypeError('跨周期核对缺少行情加载器或时钟');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2400) throw new RangeError('跨周期历史根数无效');
  const startedAt = seconds(now);
  const load = async period => {
    // Both requests use the same conservative local request-start time when
    // assessing bar closure. Do not mark a bar closed merely because a later
    // page or daily-adjustment request happened to finish after its boundary.
    const value = await loadMinute({ symbol: instrument, code: stockCode, period, adjust: '0', isIndex, limit, loadJson,
      now: startedAt * 1000 });
    const at = seconds(now);
    if (at < startedAt) throw new RangeError('本机时钟回退，无法确认行情快照时间');
    return { ...snapshotRows(value, instrument, period, at), at };
  };
  const [five, thirty] = await Promise.all([load('5'), load('30')]);
  let dailyRaw = null, dailyQfq = null;
  const adjustment = !isIndex && String(adjust) === '1' ? 'qfq' : 'unadjusted';
  if (adjustment === 'qfq') {
    const loadDay = async (path, param, key) => {
      const payload = await loadJson(`${BASE_URL}/${path}?param=${encodeURIComponent(param)}`);
      const at = seconds(now);
      if (at < startedAt) throw new RangeError('本机时钟回退，无法确认行情快照时间');
      return { rows: dailyRows(payload, instrument, key), at };
    };
    [dailyRaw, dailyQfq] = await Promise.all([
      loadDay('kline/kline', `${instrument},day,,,1000`, 'day'),
      loadDay('fqkline/get', `${instrument},day,,,640,qfq`, 'qfqday'),
    ]);
    const days = [...new Set([...five.rows, ...thirty.rows].map(row => klineTradingDate(row.date)))];
    const transforms = buildTencentQfqTransforms(dailyRaw.rows, dailyQfq.rows, days);
    for (const rows of [five.rows, thirty.rows]) for (const row of rows) {
      const transform = transforms.get(klineTradingDate(row.date));
      if (!transform || !Number.isFinite(transform.slope) || !Number.isFinite(transform.offset)) {
        throw new Error(`分钟复权缺少共同变换：${row.date}`);
      }
      for (const key of FIELDS) {
        const price = transform.slope * row[key] + transform.offset;
        if (!Number.isFinite(price)) throw new Error(`分钟复权结果无效：${row.date}`);
        row[key] = +price.toFixed(6);
      }
    }
  }
  const asOf = seconds(now);
  const latestDaySnapshot = Math.max(dailyRaw?.at ?? startedAt, dailyQfq?.at ?? startedAt);
  const fiveComparableAt = Math.max(five.at, latestDaySnapshot);
  const thirtyComparableAt = Math.max(thirty.at, latestDaySnapshot);
  if (asOf < Math.max(fiveComparableAt, thirtyComparableAt)) throw new RangeError('本机时钟回退，无法确认行情快照时间');
  const declared = { provider: 'Tencent', symbol: instrument, adjustment };
  const comparison = compareFiveMinuteToThirtyMinute({ fiveRows: five.rows, thirtyRows: thirty.rows,
    fiveProvenance: { ...declared, period: '5m' }, thirtyProvenance: { ...declared, period: '30m' },
    fiveSnapshotAt: fiveComparableAt, thirtySnapshotAt: thirtyComparableAt, asOfTime: asOf,
    // Both minute feeds are transformed and rounded to six decimals. This
    // tolerance only accounts for that chosen rounding; volume stays in lots.
    priceTolerance: adjustment === 'qfq' ? 0.000001 : 0, volumeTolerance: 0 });
  const edge = rows => ({ start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null });
  const f = edge(five.rows), t = edge(thirty.rows);
  const overlapStart = f.start && t.start ? (f.start > t.start ? f.start : t.start) : null;
  const overlapEnd = f.end && t.end ? (f.end < t.end ? f.end : t.end) : null;
  const counts = Object.fromEntries(['complete', 'missing', 'conflict', 'unconfirmed']
    .map(status => [status, comparison.windows.filter(window => window.status === status).length]));
  return { comparison, snapshots: { startedAt, five: five.at, thirty: thirty.at,
    dailyRaw: dailyRaw?.at ?? null, dailyQfq: dailyQfq?.at ?? null, fiveComparableAt, thirtyComparableAt, asOf },
  omitted: { five: Number(Boolean(five.omitted)), thirty: Number(Boolean(thirty.omitted)) },
  omittedDetails: { five: five.omitted, thirty: thirty.omitted },
  coverage: { fiveStart: f.start, fiveEnd: f.end, thirtyStart: t.start, thirtyEnd: t.end,
    overlapStart: overlapStart && overlapEnd && overlapStart <= overlapEnd ? overlapStart : null,
    overlapEnd: overlapStart && overlapEnd && overlapStart <= overlapEnd ? overlapEnd : null },
  counts, basis: { provider: 'Tencent', symbol: instrument, code: stockCode, adjustment,
    adjustmentBasis: adjustment === 'qfq' ? 'shared_daily_transform' : 'unadjusted',
    verifiedProviderIdentity: false, historicalContinuity: 'unverified' }, rows: { five: five.rows, thirty: thirty.rows } };
}
