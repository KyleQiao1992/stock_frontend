import { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { TRADE_SIDE_HISTORY_RANGES, selectTradeSideDateRange, formatTradeQuoteTime, formatTradeRatio, formatTradeVolume, summarizeTradeSideRows, tradeSideColor } from '../lib/tradeSideHistory.js';

function TradeSideTrendChart({ rows, sourceName }) {
  const [hoverDate, setHoverDate] = useState(null);
  const svgRef = useRef(null);
  const series = rows.filter(row => Number.isFinite(row.netRatio));
  if (!series.length) return null;
  const width = 760, height = 230;
  const margin = { top: 18, right: 50, bottom: 30, left: 18 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxAbs = Math.max(10, Math.ceil(Math.max(...series.map(row => Math.abs(row.netRatio))) / 10) * 10);
  const band = plotWidth / series.length;
  const barWidth = Math.max(2, Math.min(20, band * 0.65));
  const xAt = index => margin.left + band * (index + 0.5);
  const yAt = value => margin.top + (maxAbs - value) / (maxAbs * 2) * plotHeight;
  const hoveredIndex = hoverDate ? series.findIndex(row => row.date === hoverDate) : -1;
  const activeIndex = hoveredIndex >= 0 ? hoveredIndex : series.length - 1;
  const active = series[activeIndex];
  function move(event) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const index = Math.max(0, Math.min(series.length - 1, Math.floor(((event.clientX - bounds.left) / bounds.width * width - margin.left) / band)));
    setHoverDate(series[index].date);
  }
  return <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="text-sm font-semibold text-slate-700">历史外内盘差额占比</div>
        <div className="mt-0.5 text-[11px] text-slate-400">{active.date} · {active.complete ? '已收盘' : '未收盘快照'}</div>
      </div>
      <div className="text-right">
        <div className={`font-semibold ${tradeSideColor(active.netRatio)}`}>{formatTradeRatio(active.netRatio, true)}</div>
        <div className="mt-1 flex justify-end gap-3 text-[11px] text-slate-500">
          <span className="text-red-600">外盘较多 B</span><span className="text-green-700">内盘较多 S</span>
        </div>
      </div>
    </div>
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="block w-full" role="img"
      aria-label={`已记录${series.length}日外内盘差额占比柱状图`} onPointerMove={move} onPointerLeave={() => setHoverDate(null)}>
      {[maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs].map(value => <g key={value}>
        <line x1={margin.left} x2={width - margin.right} y1={yAt(value)} y2={yAt(value)} stroke={value === 0 ? 'var(--chart-muted)' : 'var(--chart-grid)'} />
        <text x={width - margin.right + 7} y={yAt(value) + 4} fontSize="10" fill="var(--chart-muted)">{value.toFixed(0)}%</text>
      </g>)}
      {series.map((row, index) => <rect key={row.date} x={xAt(index) - barWidth / 2} y={Math.min(yAt(row.netRatio), yAt(0))}
        width={barWidth} height={Math.max(1.5, Math.abs(yAt(row.netRatio) - yAt(0)))} rx="1.5"
        fill={row.netRatio === 0 ? 'var(--chart-muted)' : row.netRatio > 0 ? 'var(--chart-up)' : 'var(--chart-down)'}
        opacity={row.complete ? hoveredIndex >= 0 && row.date !== hoverDate ? 0.5 : 0.95 : 0.4}>
        <title>{`${row.date} · 内盘 ${formatTradeVolume(row.innerVol)} · 外盘 ${formatTradeVolume(row.outerVol)} · 差额占比 ${formatTradeRatio(row.netRatio)} · ${row.complete ? '已收盘' : '未收盘快照'}`}</title>
      </rect>)}
      <line x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1={margin.top} y2={margin.top + plotHeight} stroke="var(--chart-muted)" strokeDasharray="3 3" opacity="0.65" />
      <text x={margin.left} y={height - 6} fontSize="10" fill="var(--chart-muted)">{series[0].date.slice(5)}</text>
      {series.length > 2 && <text x={margin.left + plotWidth / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--chart-muted)">{series[Math.floor(series.length / 2)].date.slice(5)}</text>}
      {series.length > 1 && <text x={width - margin.right} y={height - 6} textAnchor="end" fontSize="10" fill="var(--chart-muted)">{series.at(-1).date.slice(5)}</text>}
    </svg>
    <p className="mt-1 text-[11px] leading-5 text-slate-400">差额占比 =（外盘 − 内盘）÷（外盘 + 内盘）× 100%。来源：{sourceName}。</p>
  </div>;
}

export default function TradeSideHistoryPanel({ info, loading, error, onRefresh }) {
  const [range, setRange] = useState('1w');
  const historicalRows = Array.isArray(info?.rows) ? info.rows : [];
  const selectedRows = historicalRows;
  const dateRange = selectTradeSideDateRange(selectedRows, range);
  const rows = dateRange.rows;
  const sourceName = info?.source?.name || '通达信盘后历史';
  const collection = info?.collection;
  const latest = info?.latest;
  const history = info?.history;
  const historyLoading = history?.status === 'loading';
  const summary = summarizeTradeSideRows(rows);
  const latestNote = latest ? `${latest.date} · ${latest.complete ? '已收盘' : '未收盘快照'}` : '';
  return <div className="min-w-0" data-testid="trade-side-history">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="text-base font-semibold text-slate-700">内外盘历史</div>
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-500">{sourceName}</span>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="刷新内外盘历史" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新
        </button>
      </div>
    </div>
    {error && <p role="alert" className="mb-3 text-xs text-slate-500">{error}</p>}
    {!error && history?.error && <p role="alert" className="mb-3 text-xs text-slate-500"
      title={Object.entries(history.errors || {}).map(([date, message]) => `${date}：${message}`).join('\n')}>{history.error}</p>}
    {loading && !info && <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">内外盘历史加载中</div>}
    {latest && <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['当前内盘 S', formatTradeVolume(latest.innerVol), 'text-green-700'],
          ['当前外盘 B', formatTradeVolume(latest.outerVol), 'text-red-600'],
          ['当前外内盘差额', formatTradeVolume(latest.netVol, true), tradeSideColor(latest.netVol)],
          ['当前差额占比', formatTradeRatio(latest.netRatio, true), tradeSideColor(latest.netRatio)],
        ].map(([label, value, color]) => <div key={label} className="rounded-xl bg-slate-50 p-3">
          <div className="text-xs text-slate-500">{label}</div><div className={`mt-1 font-semibold ${color}`}>{value}</div>
        </div>)}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">当前快照：{info.realtimeSource?.name || '腾讯行情'} · {latestNote} · 报价 {formatTradeQuoteTime(latest.quoteTime)}（北京时间）</p>
    </>}
    {historyLoading && <div role="status" className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
      正在读取官方历史文件 · 已核对成交量和收盘价 {history.done ?? 0} / {history.total || '—'} 日
    </div>}
    {(info || !loading) && <>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs">
        <span className="text-slate-500">{dateRange.label} · {dateRange.startDate} 至 {dateRange.endDate} · 已收盘 {summary?.days ?? 0} 日</span>
        {summary && <span className={`font-medium ${tradeSideColor(summary.netVol)}`}>收盘累计差额 {formatTradeVolume(summary.netVol, true)} · {formatTradeRatio(summary.netRatio, true)}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{sourceName} · 历史 {collection?.days ?? selectedRows.length} 日 · 期间 {rows.length} 日 · 单位：手</span>
        <div className="flex flex-wrap gap-1" aria-label="历史时间范围">
          {TRADE_SIDE_HISTORY_RANGES.map(item => <button type="button" key={item.id} aria-pressed={range === item.id} onClick={() => setRange(item.id)} className={`rounded-lg px-2 py-1 text-xs ${range === item.id ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500'}`}>{item.label}</button>)}
        </div>
      </div>
      <div className="mt-3 max-h-[350px] overflow-auto rounded-xl border border-slate-100">
        <table className="w-full min-w-[740px] text-xs" aria-label="内外盘历史列表">
          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
            {['日期', '内盘 S', '外盘 B', '未计入量', '外内盘差额', '差额占比', '外盘占比'].map((label, i) => <th key={label} className={`px-3 py-2 font-medium ${i ? 'text-right' : 'text-left'}`}>{label}</th>)}
          </tr></thead>
          <tbody>{[...rows].reverse().map(row => <tr key={row.date} className="border-t border-slate-100">
            <td className="whitespace-nowrap px-3 py-2 text-slate-600" title={`${sourceName} · ${row.date} 官方盘后文件`}>
              {row.date}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-green-700">{formatTradeVolume(row.innerVol)}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-red-600">{formatTradeVolume(row.outerVol)}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-slate-500">{Number.isFinite(row.unclassifiedVol) ? formatTradeVolume(row.unclassifiedVol) : '—'}</td>
            <td className={`whitespace-nowrap px-3 py-2 text-right ${tradeSideColor(row.netVol)}`}>{formatTradeVolume(row.netVol, true)}</td>
            <td className={`px-3 py-2 text-right ${tradeSideColor(row.netRatio)}`}>{formatTradeRatio(row.netRatio, true)}</td>
            <td className="px-3 py-2 text-right text-slate-600">{formatTradeRatio(row.outerRatio)}</td>
          </tr>)}{!rows.length && <tr><td colSpan={7} className="px-3 py-5 text-center text-slate-400">{loading || historyLoading ? '历史文件加载中' : '所选期间没有可用历史记录'}</td></tr>}</tbody>
        </table>
      </div>
      {rows.length > 1 && <TradeSideTrendChart rows={rows} sourceName={sourceName} />}
    </>}
    <p className="mt-2 text-[11px] leading-5 text-slate-400">历史直接读取通达信官方盘后文件，内外盘采用其累计口径，未计入量单列；交易所原始方向尚未核验。时间按北京时间自然日期计算，累计只含已收盘记录。1 手 = 100 股。</p>
  </div>;
}
