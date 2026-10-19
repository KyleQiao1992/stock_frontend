export default function ChanLegend({ data, options }) {
  if (!options?.enabled || !data) return null;
  const segmentCount = data.segments?.length ?? 0;
  const hasPendingSegment = data.pendingSegments?.length === 2;
  return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔</span>}
    {options.bi && <span>三角：笔端参考 · 黄色实线末端：动态极值</span>}
    {options.segment && <>
      <span><span style={{ color: 'var(--chan-segment)' }}>━</span> 已确认线段（{segmentCount} 段）</span>
      <span><span style={{ color: 'var(--chan-segment)' }}>┄</span> 发展中线段参考（未确认）</span>
      <span>悬停紫线或展开研判中的线段清单，查看起终点、笔数与确认依据K</span>
      <span>新行情引起笔回退时，线段同步重算</span>
      {!segmentCount && <span>尚无已确认线段{hasPendingSegment ? '；当前仅有发展中参考' : '；等待完成笔形成并确认线段'}</span>}
    </>}
    <span>点击分型圆点或三角，查看原始与合并K线</span>
    {options.zs && <span>色框：滑动笔重叠区（非递归中枢） · 蓝框：当前参考区</span>}
    <span>{Math.max(0, data.bi.length - 1)} 笔 / {segmentCount} 已确认线段 / {data.zs.length} 重叠区 · 笔历史 {data.definition.historyBars} 根{data.definition.segmentHistoryBars != null && ` / 线段历史 ${data.definition.segmentHistoryBars} 根`}</span>
  </div>;
}
