import { klineDateKey, klineTradingDate, parseKlineTime } from './klinePeriod.js';
import { tencentAshareVolumeToLots } from './tencentAshareVolume.js';

const BASE_URL = 'https://ifzq.gtimg.cn/appstock/app';
const PAGE_SIZE = 800; // Tencent silently returns only 320 when count exceeds 800.
const MAX_BARS = 2400;
const QFQ_PRECISION = 0.00051; // qfqday is published to three decimal places.

function responseNode(payload, symbol) {
  if (payload?.code !== 0) throw new Error(`腾讯分钟行情失败：${payload?.msg || '响应异常'}`);
  const node = payload?.data?.[symbol];
  if (!node) throw new Error(`腾讯行情缺少 ${symbol} 数据`);
  return node;
}

function ohlc(row) {
  const values = row.slice(1, 5).map(sourceNumber);
  if (values.length !== 4 || !values.every(Number.isFinite)) throw new Error('腾讯行情 OHLC 格式异常');
  return values;
}

function sourceNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())) return NaN;
  return Number(value);
}

function parseRows(payload, { symbol, code, period, isIndex }) {
  const node = responseNode(payload, symbol);
  const rows = node[`m${period}`];
  // A daily response must never masquerade as minute data.
  if (!Array.isArray(rows)) throw new Error(`腾讯没有返回 ${period} 分钟 K 线`);
  return rows.map(row => {
    const compactTime = String(row[0] || '');
    const date = klineDateKey(compactTime);
    const [open, close, high, low] = ohlc(row);
    const volume = isIndex ? sourceNumber(row[5]) : tencentAshareVolumeToLots(row[5], code);
    if (!/^\d{12}$/.test(compactTime) || !date || date.length !== 16
      || !Number.isFinite(volume) || volume < 0 || [open, close, high, low].some(value => value <= 0)
      || high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
      throw new Error('腾讯分钟 K 线时间、价格或成交量格式异常');
    }
    return { date, open, close, high, low, volume, amount: 0, amplitude: 0,
      pct: 0, change: 0, turnover: null, complete: false };
  });
}

/** Only explicit cash/bonus/conversion events are supported; ambiguous rights
 * offerings must not silently produce an incorrectly adjusted minute chart. */
export function parseTencentCorporateAction(event) {
  const date = String(event?.cqr || '');
  const content = String(event?.FHcontent || '').replace(/\s+/g, '');
  const match = /^(\d+(?:\.\d+)?)(.*)$/.exec(content);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || klineDateKey(date) !== date || !match || !(+match[1] > 0)) {
    throw new Error(`腾讯除权事件格式无法确认：${date} ${content}`);
  }
  let remaining = match[2], cash = 0, bonus = 0, tokens = 0;
  while (remaining) {
    const token = /^(派|送|转增|转)(\d+(?:\.\d+)?)(元|股)/.exec(remaining);
    if (!token || (token[1] === '派') !== (token[3] === '元')) {
      throw new Error(`暂不支持该除权事件，不能生成可靠的分钟前复权：${date} ${content}`);
    }
    if (token[1] === '派') cash += +token[2] / +match[1];
    else bonus += +token[2] / +match[1];
    remaining = remaining.slice(token[0].length);
    tokens += 1;
  }
  if (!tokens) throw new Error(`腾讯除权事件缺少分配信息：${date} ${content}`);
  return { date, cash, bonus, content };
}

/** Recover a single affine transform for each corporate-action interval.
 * Share changes determine the slope. All raw/qfq daily O/H/L/C values constrain
 * the SAME offset throughout that interval, with the source's rounding bounds.
 * This is not a per-day close ratio: cash dividends require an additive offset,
 * and Tencent's effective cash adjustment can differ from the nominal payout.
 */
export function buildTencentQfqTransforms(rawRows, qfqRows, tradingDays) {
  if (!rawRows?.length || !qfqRows?.length || !tradingDays?.length) throw new Error('分钟前复权缺少同源日 K 线');
  const firstDay = [...tradingDays].sort()[0];
  const rawByDay = new Map(rawRows.map(row => [String(row[0]), row]));
  const qfqByDay = new Map(qfqRows.map(row => [String(row[0]), row]));
  const eventByDate = new Map();
  for (const row of [...rawRows, ...qfqRows]) {
    for (const event of row.slice(6)) {
      if (!event || typeof event !== 'object' || (!event.cqr && !event.FHcontent)) continue;
      if (event.cqr && String(event.cqr) <= firstDay) continue;
      const parsed = parseTencentCorporateAction(event);
      const previous = eventByDate.get(parsed.date);
      if (previous && previous.content !== parsed.content) throw new Error(`腾讯除权事件存在冲突：${parsed.date}`);
      eventByDate.set(parsed.date, parsed);
    }
  }
  const events = [...eventByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const groups = new Map(), transforms = new Map();
  const liveDay = [...qfqByDay.keys()].sort().at(-1);
  for (const day of new Set(tradingDays)) {
    const raw = rawByDay.get(day), qfq = qfqByDay.get(day);
    if (!raw || !qfq) throw new Error(`分钟前复权日 K 线覆盖不足：${day}`);
    const future = events.filter(event => event.date > day);
    const groupKey = future[0]?.date || 'latest';
    const slope = future.reduce((value, event) => value / (1 + event.bonus), 1);
    const group = groups.get(groupKey) || { slope, lower: -Infinity, upper: Infinity, days: [] };
    const rawPrices = ohlc(raw), adjustedPrices = ohlc(qfq);
    if (!future.length) {
      // The current daily snapshots can race while the session is open. The
      // latest action interval is identity; historical days must still agree.
      if (day !== liveDay && rawPrices.some((price, index) => Math.abs(price - adjustedPrices[index]) > QFQ_PRECISION)) {
        throw new Error(`腾讯分钟前复权缺少可验证的除权事件：${day}`);
      }
      group.lower = 0;
      group.upper = 0;
    } else {
      for (let index = 0; index < 4; index += 1) {
        const offset = adjustedPrices[index] - slope * rawPrices[index];
        group.lower = Math.max(group.lower, offset - QFQ_PRECISION);
        group.upper = Math.min(group.upper, offset + QFQ_PRECISION);
      }
    }
    group.days.push(day);
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    if (group.lower > group.upper + 1e-10) throw new Error('腾讯原始日 K 与前复权日 K 不满足一致的除权变换，已停止分钟复权');
    const offset = (group.lower + group.upper) / 2;
    for (const day of group.days) transforms.set(day, { slope: group.slope, offset });
  }
  return transforms;
}

/** Fetch genuine Tencent A-share/index minute bars, with explicit pagination.
 * loadJson is injected so the caller can use its existing CORS/script loader.
 * Volume always remains actual traded lots; price adjustment never rescales it.
 */
export async function fetchAshareMinuteKline({ symbol, code, period, adjust = '1', isIndex = false,
  limit = 1320, loadJson, now = Date.now() }) {
  const targetPeriod = String(period);
  const targetSymbol = String(symbol || '').toLowerCase();
  const targetCode = String(code || targetSymbol.slice(2));
  if (!['5', '30'].includes(targetPeriod)) throw new Error('分钟行情仅支持 5 分钟与 30 分钟');
  if (!/^(?:sh|sz|bj)\d{6}$/.test(targetSymbol) || targetSymbol.slice(2) !== targetCode) throw new Error('分钟行情需要明确且一致的 A 股/指数 symbol');
  if (!['0', '1'].includes(String(adjust))) throw new Error('分钟行情仅支持不复权或前复权');
  if (typeof loadJson !== 'function') throw new Error('分钟行情缺少数据加载器');
  const requested = Number(limit);
  if (!Number.isFinite(requested) || requested < 1) throw new Error('分钟行情请求根数无效');
  const wanted = Math.min(MAX_BARS, Math.floor(requested));
  const bars = new Map();
  let end = '', quotePayload, quoteTimestamp = NaN, pages = 0;
  while (bars.size < wanted) {
    const count = Math.min(PAGE_SIZE, wanted - bars.size);
    const param = `${targetSymbol},m${targetPeriod},${end},${count}`;
    const payload = await loadJson(`${BASE_URL}/kline/mkline?param=${encodeURIComponent(param)}`);
    const rows = parseRows(payload, { symbol: targetSymbol, code: targetCode, period: targetPeriod, isIndex });
    pages += 1;
    // History pages may be cached separately and contain older (or no) quotes.
    // Keep the newest valid source clock, allowing a later page to supply it
    // when the initial page has no usable timestamp.
    const quote = responseNode(payload, targetSymbol)?.qt?.[targetSymbol];
    const timestampText = String(quote?.[30] ?? '');
    const candidateTimestamp = /^\d{14}$/.test(timestampText) ? parseKlineTime(timestampText) : NaN;
    if (!quotePayload || (Number.isFinite(candidateTimestamp)
      && (!Number.isFinite(quoteTimestamp) || candidateTimestamp >= quoteTimestamp))) {
      quotePayload = payload;
      quoteTimestamp = candidateTimestamp;
    }
    if (!rows.length) break;
    const beforeSize = bars.size;
    for (const row of rows) {
      if (end && row.date.replace(/[- :]/g, '') >= end) continue;
      bars.set(row.date, row);
    }
    const oldest = rows.map(row => row.date.replace(/[- :]/g, '')).sort()[0];
    if (bars.size === beforeSize || (end && oldest >= end)) break;
    end = oldest;
    if (rows.length < count) break;
  }
  let klines = [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-wanted);
  if (!klines.length) throw new Error(`腾讯没有可用的 ${targetPeriod} 分钟 K 线`);
  const qfq = !isIndex && String(adjust) === '1';
  if (qfq) {
    const rawParam = `${targetSymbol},day,,,1000`;
    const qfqParam = `${targetSymbol},day,,,640,qfq`;
    const [rawPayload, qfqPayload] = await Promise.all([
      loadJson(`${BASE_URL}/kline/kline?param=${encodeURIComponent(rawParam)}`),
      loadJson(`${BASE_URL}/fqkline/get?param=${encodeURIComponent(qfqParam)}`),
    ]);
    const rawRows = responseNode(rawPayload, targetSymbol).day;
    const qfqRows = responseNode(qfqPayload, targetSymbol).qfqday;
    const transforms = buildTencentQfqTransforms(rawRows, qfqRows, klines.map(row => klineTradingDate(row.date)));
    klines = klines.map(row => {
      const { slope, offset } = transforms.get(klineTradingDate(row.date));
      const adjusted = { ...row };
      for (const key of ['open', 'close', 'high', 'low']) adjusted[key] = +(slope * row[key] + offset).toFixed(6);
      return adjusted;
    });
  }
  const quoteTime = quoteTimestamp;
  const nowSeconds = (typeof now === 'function' ? now() : Number(now)) / 1000;
  // The source must reach the bar's closing time and the local clock must allow
  // a minute for finalization. A closing snapshot can remain at 15:00:00 after
  // the market closes, so it must not be required to advance to 15:01:00.
  // With no source clock, leave the latest bar explicitly unfinished.
  let previousClose = null;
  klines = klines.map((row, index) => {
    const change = previousClose === null ? 0 : row.close - previousClose;
    const pct = previousClose ? change / previousClose * 100 : 0;
    const amplitude = previousClose ? (row.high - row.low) / previousClose * 100 : 0;
    previousClose = row.close;
    const barEnd = parseKlineTime(row.date);
    const complete = Number.isFinite(quoteTime)
      ? quoteTime >= barEnd && nowSeconds >= barEnd + 60
      : index < klines.length - 1 && nowSeconds >= barEnd + 60;
    return { ...row, change, pct, amplitude, complete };
  });
  return { klines, quotePayload,
    sourceInfo: `Tencent ${targetPeriod}m, ${klines.length} bars, ${pages} page(s), ${qfq ? 'qfq: corporate actions + verified daily OHLC' : 'unadjusted'}` };
}
