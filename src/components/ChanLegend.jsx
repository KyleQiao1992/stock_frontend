export default function ChanLegend({ data, options }) {
  if (!options?.enabled || !data) return null;
  return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔</span>}
    <span>三角：笔端参考 · 实线末端：动态极值</span>
    {options.zs && <span>色框：滑动笔中枢 · 蓝框：当前参考中枢</span>}
    <span>{Math.max(0, data.bi.length - 1)} 笔 / {data.zs.length} 枢 · {data.definition.historyBars} 根计算历史</span>
  </div>;
}
