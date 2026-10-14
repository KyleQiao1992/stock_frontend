import { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { formatTradeQuoteTime, formatTradeRatio, formatTradeVolume, summarizeTradeSideRows, tradeSideColor } from '../lib/tradeSideHistory.js';

function TradeSideTrendChart({ rows }) {
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
  const activeIndex = Math.max(0, hoverDate ? series.findIndex(row => row.date === hoverDate) : series.length - 1);
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
        opacity={row.complete ? hoverDate && row.date !== hoverDate ? 0.5 : 0.95 : 0.4}>
        <title>{`${row.date} · 内盘 ${formatTradeVolume(row.innerVol)} · 外盘 ${formatTradeVolume(row.outerVol)} · 差额占比 ${formatTradeRatio(row.netRatio)} · ${row.complete ? '已收盘' : '未收盘快照'}`}</title>
      </rect>)}
      <line x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1={margin.top} y2={margin.top + plotHeight} stroke="var(--chart-muted)" strokeDasharray="3 3" opacity="0.65" />
      <text x={margin.left} y={height - 6} fontSize="10" fill="var(--chart-muted)">{series[0].date.slice(5)}</text>
      {series.length > 2 && <text x={margin.left + plotWidth / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--chart-muted)">{series[Math.floor(series.length / 2)].date.slice(5)}</text>}
      {series.length > 1 && <text x={width - margin.right} y={height - 6} textAnchor="end" fontSize="10" fill="var(--chart-muted)">{series.at(-1).date.slice(5)}</text>}
    </svg>
    <p className="mt-1 text-[11px] leading-5 text-slate-400">差额占比 =（外盘 − 内盘）÷（外盘 + 内盘）× 100%。按通达信返回的买卖方向汇总，未判定量单列。</p>
  </div>;
}

export default function TradeSideHistoryPanel({ info, loading, error, onRefresh }) {
  const [range, setRange] = useState(30);
  const rows = Array.isArray(info?.rows) ? info.rows.slice(-range) : [];
  const latest = info?.latest;
  const history = info?.history;
  const historyLoading = history?.status === 'loading';
  const summary = summarizeTradeSideRows(info?.rows);
  const latestNote = latest ? `${latest.date} · ${latest.complete ? '已收盘' : '未收盘快照'}` : '';
  return <div className="min-w-0" data-testid="trade-side-history">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="text-base font-semibold text-slate-700">内外盘历史</div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-sky-100 px-2 py-1 text-[11px] text-sky-700">{info?.source?.name || '历史成交数据'} · 手</span>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="刷新内外盘历史" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新
        </button>
      </div>
    </div>
    {error && <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{error}</div>}
    {info?.warning && <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{info.warning}</div>}
    {loading && !info && <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">内外盘历史加载中</div>}
    {info?.source?.key === 'tdx' && <div data-testid="trade-side-direction-status" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-700">
      <div className="font-semibold">交易所方向：未核验</div>
      <div>尚未接入交易所历史逐笔数据。以下为通达信参考统计，成交总量和收盘价一致不能证明内外盘方向准确。</div>
    </div>}
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
    {historyLoading && <div role="status" className="mt-3 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-700">
      正在加载历史分笔 · 已通过分页、成交总量和收盘价检查 {history.done ?? 0} / {history.total || '—'} 日
    </div>}
    {rows.length > 0 ? <>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs">
        <span className="text-slate-500">{summary ? `最近 ${summary.days} 个历史收盘日 · ${summary.firstDate} 至 ${summary.lastDate}` : '尚无完整历史收盘记录'}</span>
        {summary && <span className={`font-medium ${tradeSideColor(summary.netVol)}`}>累计差额 {formatTradeVolume(summary.netVol, true)} · {formatTradeRatio(summary.netRatio, true)}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-500">历史 {info.collection?.days ?? info.rows.length} 日 · 本次显示 {rows.length} 日</span>
        <div className="flex gap-1" aria-label="历史显示范围">
          {[30, 60, 120].map(value => <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)} className={`rounded-lg px-2 py-1 text-xs ${range === value ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500'}`}>{value} 日</button>)}
        </div>
      </div>
      <TradeSideTrendChart rows={rows} />
      <div className="mt-3 max-h-[350px] overflow-auto rounded-xl border border-slate-100">
        <table className="w-full min-w-[740px] text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
            {['日期', '内盘 S', '外盘 B', '未判定量', '外内盘差额', '差额占比', '外盘占比'].map((label, i) => <th key={label} className={`px-3 py-2 font-medium ${i ? 'text-right' : 'text-left'}`}>{label}</th>)}
          </tr></thead>
          <tbody>{[...rows].reverse().map(row => <tr key={row.date} className="border-t border-slate-100">
            <td className="whitespace-nowrap px-3 py-2 text-slate-600" title={`${row.source?.name || info.source?.name || '历史成交数据'} · ${row.tradeCount ?? '—'} 条成交记录`}>
              {row.date}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-green-700">{formatTradeVolume(row.innerVol)}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-red-600">{formatTradeVolume(row.outerVol)}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-slate-500">{Number.isFinite(row.neutralVol) && Number.isFinite(row.unknownVol) ? formatTradeVolume(row.neutralVol + row.unknownVol) : '—'}</td>
            <td className={`whitespace-nowrap px-3 py-2 text-right ${tradeSideColor(row.netVol)}`}>{formatTradeVolume(row.netVol, true)}</td>
            <td className={`px-3 py-2 text-right ${tradeSideColor(row.netRatio)}`}>{formatTradeRatio(row.netRatio, true)}</td>
            <td className="px-3 py-2 text-right text-slate-600">{formatTradeRatio(row.outerRatio)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </> : !loading && !historyLoading ? <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">{history?.error || '尚未取得完整的历史成交数据。'}</div> : null}
    <p className="mt-2 text-[11px] leading-5 text-slate-400">{info?.collection?.notice}</p>
    <p className="mt-1 text-[11px] leading-5 text-slate-400">历史内外盘按通达信分笔的买卖方向统计，1 手 = 100 股。中性及其他方向计入未判定量，不估算归类；历史统计与腾讯当前快照的方向判定可能不同。未取得或未通过完整性核验的日期不补零。</p>
  </div>;
}
