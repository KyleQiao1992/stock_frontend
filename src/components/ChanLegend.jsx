export default function ChanLegend({ data, options }) {
  if (!options?.enabled || !data) return null;
  return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔</span>}
    <span>三角：笔端参考 · 实线末端：动态极值</span>
    <span>点击分型圆点或三角，查看原始与合并K线</span>
    {options.zs && <span>色框：滑动笔重叠区（非递归中枢） · 蓝框：当前参考区</span>}
    <span>{Math.max(0, data.bi.length - 1)} 笔 / {data.zs.length} 重叠区 · {data.definition.historyBars} 根计算历史</span>
  </div>;
}
