import { authFetch } from './authClient.js';

export const TRADE_SIDE_HISTORY_RANGES = Object.freeze([
  { id: '1w', label: '近一周', days: 7 },
  { id: '2w', label: '近2周', days: 14 },
  { id: '3w', label: '近3周', days: 21 },
  { id: '1m', label: '近一月', months: 1 },
  { id: '2m', label: '近2月', months: 2 },
].map(Object.freeze));

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function offsetDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousCalendarMonthBoundary(value, months) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  // Start on the first to prevent March 31 overflowing into March again.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const monthEnd = new Date(date);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  date.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function selectTradeSideDateRange(rows, rangeId = '1w', now = Date.now()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError('内外盘历史时间范围的当前时间无效');
  const parts = Object.fromEntries(shanghaiDateFormatter.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const endDate = `${parts.year}-${parts.month}-${parts.day}`;
  const range = TRADE_SIDE_HISTORY_RANGES.find(item => item.id === rangeId) || TRADE_SIDE_HISTORY_RANGES[0];
  const startDate = range.days ? offsetDate(endDate, 1 - range.days)
    : offsetDate(previousCalendarMonthBoundary(endDate, range.months), 1);
  const selected = (Array.isArray(rows) ? rows : []).filter(row => isValidDate(row?.date)
    && row.date >= startDate && row.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  return { rows: selected, startDate, endDate, label: range.label };
}

export async function fetchTradeSideHistory(code, options = {}) {
  // Sixty trading days cover the longest visible range (two calendar months).
  const response = await authFetch(`/api/ashare-trade-side-history?code=${encodeURIComponent(code)}&limit=60`, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (payload?.code !== code || !Array.isArray(payload.rows)) throw new Error('内外盘历史接口返回的数据无效');
  return payload;
}

// Only genuinely closed snapshots contribute to the multi-day comparison.
// Calculate the ratio from summed volumes, so a quiet day has less weight.
export function summarizeTradeSideRows(rows, limit = Infinity) {
  let selected = (Array.isArray(rows) ? rows : []).filter(row => row?.complete === true && isValidDate(row.date)
    && Number.isFinite(row.innerVol) && Number.isFinite(row.outerVol)
    && row.innerVol >= 0 && row.outerVol >= 0 && row.innerVol + row.outerVol > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (Number.isFinite(limit)) selected = limit >= 1 ? selected.slice(-Math.floor(limit)) : [];
  if (!selected.length) return null;
  const hasRawShares = selected.every(row => Number.isSafeInteger(row.sourceVolumes?.innerShares)
    && Number.isSafeInteger(row.sourceVolumes?.outerShares)
    && row.sourceVolumes.innerShares / 100 === row.innerVol
    && row.sourceVolumes.outerShares / 100 === row.outerVol);
  // Daily files retain whole shares. Sum those integers before converting to
  // lots so fractional lots do not accumulate binary floating point error.
  const scale = hasRawShares ? 100 : 1;
  const innerTotal = selected.reduce((sum, row) => sum + (hasRawShares ? row.sourceVolumes.innerShares : row.innerVol), 0);
  const outerTotal = selected.reduce((sum, row) => sum + (hasRawShares ? row.sourceVolumes.outerShares : row.outerVol), 0);
  const innerVol = innerTotal / scale;
  const outerVol = outerTotal / scale;
  return { days: selected.length, firstDate: selected[0].date, lastDate: selected.at(-1).date,
    innerVol, outerVol, netVol: (outerTotal - innerTotal) / scale,
    netRatio: (outerTotal - innerTotal) / (outerTotal + innerTotal) * 100 };
}

export function formatTradeVolume(value, signed = false) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const text = magnitude >= 100000000 ? `${(magnitude / 100000000).toFixed(2)}亿`
    : magnitude >= 10000 ? `${(magnitude / 10000).toFixed(2)}万`
      : magnitude.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}${text}手`;
}

export function formatTradeRatio(value, signed = false) {
  return Number.isFinite(value) ? `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
}

export function tradeSideColor(value) {
  return !Number.isFinite(value) || value === 0 ? 'text-slate-700' : value > 0 ? 'text-red-600' : 'text-green-700';
}

export function formatTradeQuoteTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms) : '时间未提供';
}
