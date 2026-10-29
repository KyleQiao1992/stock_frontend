import ChanUncertaintyNotice from './ChanUncertaintyNotice.jsx';
import ChanPendingNotice from './ChanPendingNotice.jsx';

export default function ChanLegend({ data, options, rows }) {
  if (!options?.enabled || !data) return null;
  const segmentCount = data.segments?.length ?? 0;
  const hasPendingSegment = data.pendingSegments?.length === 2;
  const firstTime = rows?.length ? data.dates.indexOf(rows[0].date) + 1 : 1;
  const lastTime = rows?.length ? data.dates.indexOf(rows.at(-1).date) + 1 : data.dates.length;
  const windowZoneCount = data.zs.filter(zone => zone.edt >= firstTime && zone.sdt <= lastTime).length;
  const uncertainty = data.zsUncertainty ?? [];
  if (data.inputProblem) return <div aria-label="缠论图例" className="px-2 py-2 text-[11px] text-amber-600 dark:text-amber-400">
    {`行情第 ${data.inputProblem.index + 1} 根 K 线${data.inputProblem.date ? `（${data.inputProblem.date}）` : ''}数据无效，缠论计算已停止，避免跨越缺失数据错误划线。`}
  </div>;
  if (data.definition?.engine === 'external') return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    <span>本项目笔和特征序列线段 · 笔构造参考中枢 · 非递归走势中枢</span>
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔；末端为动态极值</span>}
    {options.bi && <ChanPendingNotice data={data} />}
    {options.segment && <span><span style={{ color: 'var(--chan-segment)' }}>━</span> 已确认线段（{segmentCount} 段） · 虚线为发展中参考；确认依据按本次历史复算</span>}
    {options.zs && <><span>色框：笔构造参考中枢 · 当前窗口 {windowZoneCount} 个 / 全部历史 {data.zs.length} 个；确认依据K按本次历史复算 · 虚线框：后续状态不确定</span><ChanUncertaintyNotice data={data} /></>}
    {(options.bi || options.fx) && <span>点击分型圆点或三角查看分型</span>}
    <span>{Math.max(0, data.bi.length - 1)} 笔 · 全部已加载 {data.dates.length} 根K线参与计算；新行情可能引起结构回退重算</span>
  </div>;
  return <div aria-label="缠论图例" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 text-[11px] text-slate-500">
    {options.bi && <span><span style={{ color: 'var(--chan-bi)' }}>━</span> 笔</span>}
    {options.bi && <span>三角：笔端参考 · 黄色实线末端：动态极值</span>}
    {options.bi && <ChanPendingNotice data={data} />}
    {options.segment && <>
      <span><span style={{ color: 'var(--chan-segment)' }}>━</span> 已确认线段（{segmentCount} 段）</span>
      <span><span style={{ color: 'var(--chan-segment)' }}>┄</span> 发展中线段参考（未确认）</span>
      <span>悬停紫线或展开研判中的线段清单，查看起终点、笔数与确认依据K</span>
      <span>新行情引起笔回退时，线段同步重算</span>
      {!segmentCount && <span>尚无已确认线段{hasPendingSegment ? '；当前仅有发展中参考' : '；等待完成笔形成并确认线段'}</span>}
    </>}
    <span>点击分型圆点或三角，查看原始与合并K线</span>
    {options.zs && <>
      <span>色框：线段中枢（本图最小级别） · 粗边框：尚未结束的中枢 · 虚线框：后续状态无法确定</span>
      <span>当前时间窗口 {windowZoneCount} 个中枢 / 全部历史 {data.zs.length} 个中枢</span>
      <ChanUncertaintyNotice data={data} />
      {data.zs.length > 0 && windowZoneCount === 0 && <span>中枢位于当前窗口之外，可缩小图表查看更早历史</span>}
      {!data.zs.length && !uncertainty.length && <span>{segmentCount < 3
        ? `至少需要三个连续已确认线段；当前仅${segmentCount}段`
        : '已确认线段尚未形成有效的三段共同区间'}</span>}
    </>}
    {options.penZs && <span>青色虚线框：笔构造参考中枢（非递归走势中枢，不作为买卖信号） · 全部历史 {data.penZs?.length ?? 0} 个</span>}
    {options.penZs && (data.penZsUncertainty?.length ?? 0) > 0 && <span>部分笔构造参考区因行情或端点顺序无法确定</span>}
    <span>{Math.max(0, data.bi.length - 1)} 笔 / {segmentCount} 已确认线段 · 全部已加载 {data.dates.length} 根K线参与计算</span>
  </div>;
}
