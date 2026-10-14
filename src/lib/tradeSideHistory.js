import { authFetch } from './authClient.js';

export async function fetchTradeSideHistory(code, options = {}) {
  const response = await authFetch(`/api/ashare-trade-side-history?code=${encodeURIComponent(code)}&limit=120`, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (payload?.code !== code || !Array.isArray(payload.rows)) throw new Error('内外盘历史接口返回的数据无效');
  return payload;
}

// Only genuinely closed snapshots contribute to the multi-day comparison.
// Calculate the ratio from summed volumes, so a quiet day has less weight.
export function summarizeTradeSideRows(rows, limit = 5) {
  const selected = (Array.isArray(rows) ? rows : []).filter(row => row.complete
    && Number.isFinite(row.innerVol) && Number.isFinite(row.outerVol)
    && row.innerVol >= 0 && row.outerVol >= 0 && row.innerVol + row.outerVol > 0).slice(-limit);
  if (!selected.length) return null;
  const innerVol = selected.reduce((sum, row) => sum + row.innerVol, 0);
  const outerVol = selected.reduce((sum, row) => sum + row.outerVol, 0);
  return { days: selected.length, firstDate: selected[0].date, lastDate: selected.at(-1).date,
    innerVol, outerVol, netVol: outerVol - innerVol,
    netRatio: (outerVol - innerVol) / (outerVol + innerVol) * 100 };
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
