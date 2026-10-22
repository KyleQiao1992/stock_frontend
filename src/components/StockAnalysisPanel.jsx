import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import StockNewsPanel from './StockNewsPanel';
import { periodLabel } from '../lib/klinePeriod.js';

const price = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
function ChanSegments({ data }) {
  const segments = data.segments ?? [];
  const pending = data.pendingSegments ?? [];
  const dateAt = (time) => data.dates[time - 1] ?? '—';
  const pointText = (point) => `${dateAt(point.time)} @ ${price(point.price)}`;
  return <section aria-label="线段结构" className="rounded-xl border border-slate-200 p-4">
    <h4 className="font-semibold text-slate-900">线段结构 · {segments.length} 段已确认</h4>
    <p className="mt-2 text-xs text-slate-500">当前图的旧笔经特征序列划段；紫色实线为已确认段，虚线为发展中参考。新行情导致笔回退时，线段同步重算。</p>
    <p className="mt-2 text-xs text-slate-500">确认依据K由本次历史窗口复算，不等于系统当时已观测或发出信号；窗口起点变化也会重划历史。最新K未明确收盘时不用于确认。</p>
    {data.definition.segmentHistoryStart && <p className="mt-1 text-xs text-slate-500">线段历史起点：{data.definition.segmentHistoryStart}</p>}
    {segments.length > 0 ? <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-sky-600">查看各段起终点与确认依据K</summary>
      <ol className="mt-2 space-y-3">
        {segments.map((segment, i) => <li key={segment.id} className="rounded-lg bg-slate-50 p-3">
          <p className="font-medium">{i + 1}. {segment.direction === 'up' ? '向上' : '向下'} · {segment.stroke_count} 笔</p>
          <p>起点：{pointText(segment.start)}</p><p>终点：{pointText(segment.end)}</p>
          <p>确认依据K：{dateAt(segment.confirmed_time)}</p>
        </li>)}
      </ol>
    </details> : <p className="mt-2 text-xs text-slate-500">当前历史尚无满足确认条件的线段。</p>}
    {pending.length === 2 && <p className="mt-2 text-xs text-slate-500">发展中参考：{pointText(pending[0])} → {pointText(pending[1])}；尚未确认。</p>}
  </section>;
}
function ChanOutlook({ data }) {
  const outlook = data.outlook;
  if (!outlook?.ok) return <p className="py-6 text-sm text-slate-500">当前历史中尚无可绘制的笔结构。</p>;
  const { conclusion: c, levels, scenarios = [] } = outlook;
  const signal = c.latest_signal;
  const phase = c.status === 'confirmed' ? `${c.kind} · 已确认` : c.is_hypothesis ? '位置观察' : '等待结构';
  return <div aria-label="缠论结构研判" className="space-y-4 text-sm leading-6 text-slate-700">
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-semibold text-slate-900">结构研判</h3>
      <span className="text-xs text-slate-500">{c.status_label}</span>
    </div>
    <div className="rounded-xl border border-emerald-700/40 bg-slate-50 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h4 className="text-base font-semibold text-slate-900">{c.title}</h4>
        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">{phase}</span>
      </div>
      <section aria-label="结构事实">
        <h5 className="mb-2 font-semibold text-sky-600">结构事实</h5>
        <p>{c.structure_fact || c.summary}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {[
            ['现价', price(levels.close)], ['相对滑动笔重叠区', levels.vs_zs_label || '尚无滑动笔重叠区'],
            ['ZG 上沿', price(levels.zs_zg), levels.zs_zg_bar],
            ['ZD 下沿', price(levels.zs_zd), levels.zs_zd_bar],
            ['末笔高', price(levels.last_bi_high), levels.last_bi_high_bar],
            ['末笔低', price(levels.last_bi_low), levels.last_bi_low_bar],
          ].map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-xl bg-slate-100 p-3">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 break-words font-semibold">{value}</div>
            {detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}
          </div>)}
        </div>
        {levels.zs_range && <div className="mt-3 rounded-xl bg-slate-100 p-3 text-xs">
          <div className="text-slate-500">当前滑动笔重叠区</div><p>{levels.zs_range}</p>
          <p className="text-slate-500">{levels.zs_bi_count} 笔 · {levels.active_zs_id}</p>
        </div>}
      </section>
      {signal && <section aria-label="已确认信号" className="mt-4 border-t border-slate-200 pt-3">
        <h5 className="mb-2 font-semibold text-sky-600">已确认信号</h5>
        <p>{`已确认信号：${signal.title || signal.kind} · ${signal.time_str || signal.time}`}</p>
        {c.status === 'confirmed' && c.basis && <p>{c.basis}</p>}
        {c.confirm_note && <p>{c.confirm_note}</p>}
      </section>}
      <section aria-label="观察条件" className="mt-4 border-t border-slate-200 pt-3">
        <h5 className="mb-2 font-semibold text-sky-600">当前观察</h5>
        <p>{c.status === 'confirmed' ? c.summary : c.observation || c.summary}</p>
      </section>
      <section aria-label="失效与操作参考" className="mt-4 border-t border-slate-200 pt-3">
        <h5 className="mb-2 font-semibold text-sky-600">参考变化</h5>
        <p>{c.invalidation}</p>
      </section>
    </div>
    <ChanSegments data={data} />
    {scenarios.length > 0 && <>
      <div data-chan-watch-intro>
        <h4 className="font-semibold text-slate-900">买卖点观察 · 接下来三种情景</h4>
        {outlook.watch_note && <p className="mt-1 text-xs text-slate-500">{outlook.watch_note}</p>}
      </div>
      {scenarios.map((scenario) => <section aria-label={scenario.name} key={scenario.id} data-chan-scenario={scenario.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <h5 className="font-semibold text-slate-900">{scenario.id} · {scenario.name}</h5>
          <span className="shrink-0 text-xs">{scenario.bias}</span>
        </div>
        <p className="mt-2">{scenario.explain}</p>
        <p className="mt-2"><span className="font-semibold">条件：</span>{scenario.condition}</p>
        <p className="mt-2"><span className="font-semibold">路径：</span>{scenario.path}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{scenario.next_points.map((point) => <div key={point.kind} data-chan-signal-watch={point.kind} className="min-w-0 rounded-lg bg-slate-50 p-3">
          <p><span className="mr-2 rounded border border-slate-200 px-1.5 py-0.5 text-xs">{point.kind}</span><span className="font-semibold">{point.title}</span></p>
          <p className="mt-1">{point.trigger}</p><p className="mt-1 text-xs text-slate-500">{point.action}</p>
        </div>)}</div>
        <p className="mt-3"><span className="font-semibold">失效：</span>{scenario.invalid}</p>
      </section>)}
    </>}
    {outlook.disclaimer && <p className="text-xs text-slate-500">{outlook.disclaimer}</p>}
  </div>;
}
function ChanEndpoints({ data }) {
  const [filter, setFilter] = useState('all');
  const items = data.trades.filter((item) => filter === 'all' || item.side === filter);
  return <div>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {[['all','全部'],['buy','笔低'],['sell','笔高']].map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg px-3 py-1.5 text-xs ${filter === value ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500'}`}>{label}</button>)}
      <span className="text-xs text-slate-500">共 {items.length} 个笔端参考 · 不含动态末端</span>
    </div>
    <div className="max-h-[420px] overflow-y-auto">
      {items.length ? <ol className="divide-y divide-slate-200">{items.map((item) => <li key={`${item.time}-${item.kind}`} className="flex items-start justify-between gap-4 py-3">
        <div><div className="text-sm font-semibold text-slate-900">{item.title}</div><p className="mt-1 text-xs leading-5 text-slate-500">{item.desc}</p></div>
        <div className="shrink-0 text-right"><div className="font-mono text-sm text-slate-900">{item.price_str}</div><time className="text-xs text-slate-500">{item.time_str}</time></div>
      </li>)}</ol> : <p className="py-6 text-sm text-slate-500">当前暂无符合条件的笔端参考。</p>}
    </div>
  </div>;
}
export default function StockAnalysisPanel({ data, enabled, tab, onTabChange, code, name, period, market = 'ashare', showFinancial, financialReportContent, showNews, showTradeSideHistory, tradeSideHistoryContent }) {
  const tabs = [
    ...(showFinancial ? [['financial','财报']] : []),
    ...(enabled ? [['outlook','缠论研判'],['endpoints','笔端参考']] : []),
    ...(showNews ? [['news','资讯']] : []),
    ...(showTradeSideHistory ? [['tradeSideHistory','内外盘历史']] : []),
  ];
  const active = tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];
  return <Card className="min-w-0 rounded-2xl" >
    <CardContent className="p-4">
      <section aria-label="个股分析">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="个股分析分类" className="flex flex-wrap gap-1 rounded-xl bg-slate-50 p-1">
            {tabs.map(([key,label]) => <button key={key} type="button" role="tab" aria-selected={active === key} onClick={() => onTabChange(key)} className={`rounded-lg px-3 py-2 text-sm ${active === key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>)}
          </div>
          <span className="text-xs text-slate-500">{name} {code}</span>
        </div>
        {active === 'financial' ? financialReportContent : active === 'news' ? <div className="flex h-[520px] min-h-0 overflow-hidden"><StockNewsPanel code={code} market={market} /></div> : active === 'tradeSideHistory' ? tradeSideHistoryContent : <>
          <p className="mb-4 text-xs leading-5 text-slate-500">{periodLabel(period)} · 全部已加载 {data.dates.length} 根K线参与计算 · 截至 {data.dates.at(-1) || '—'}；缩放不改变计算起点。</p>
          {active === 'outlook' ? <ChanOutlook data={data} /> : <ChanEndpoints data={data} />}
          <details className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-500">
            <summary className="cursor-pointer font-medium text-slate-700">计算口径与范围</summary>
            <p className="mt-2">逐根处理K线包含和三K分型；按第62、65、77课旧笔口径，顶底分型之间至少有一根不属于任一分型的独立K线。笔被新K线破坏时回退重算。黄色折线连接笔端及当前动态极值，三角标记笔端参考，圆点标记分型。</p>
            <p className="mt-2">线段采用第65、67、71、77、78课特征序列规则及第81课更正；前三笔须有价格重叠，已确认段由后续完成笔的破坏条件确认，端点与确认依据K分别记录。来源未明确最新K已收盘时，须等待后继同周期K才将前K计为已完成；来源明确未收盘的K不能用于确认。笔、分型、线段和滑动笔重叠区均使用全部已加载历史计算，不按固定根数或笔数截断；这不代表已经识别递归中枢或更高走势级别。</p>
            <p className="mt-2">蓝框为滑动笔重叠区：连续前三笔固定ZG/ZD，保持核心区间最多延伸九笔，按滑动窗口绘制；这是本地参考算法，不是原文按次级别走势递归定义的中枢。动态末端不参与笔端参考和重叠区。</p>
            <p className="mt-2">计算使用全部已加载的有效K线，加载范围之前的数据未参与；首笔之前的K线用于初始化，不强行连笔。加载更早历史可能改变起笔及后续结构，缩放只改变可见范围。新行情可能修正近端结构。</p>
            <p className="mt-2">买卖点观察按第17、20、21、101课列出后续条件，不代表已识别或已确认；当前未执行走势级别、递归中枢、背驰及一二三类买卖点的自动识别。二类观察须从真实一类买卖点后的次级别走势出发，不能用任意前低或前高替代。</p>
          </details>

        </>}
      </section>
    </CardContent>
  </Card>;
}
