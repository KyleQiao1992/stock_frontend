export default function ChanLegend({ data, options }) {
  if (!options?.enabled || !data) return null;
  return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔</span>}
    {options.segment && <span><span style={{ color: 'var(--chan-segment)' }}>━</span> 线段</span>}
    <span>虚线：未确认结构</span>
    {options.zs && <span>色框：三条完成线段的重叠区 · 蓝框：当前未结束</span>}
    <span>严格老笔 · {Math.max(0, data.bi.length - 1)} 笔 / {data.segments.length} 段 / {data.zs.length} 枢</span>
  </div>;
}
