import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import StockNewsPanel from './StockNewsPanel';
import ChanRecursiveStatus from './ChanRecursiveStatus';
import ChanUncertaintyNotice from './ChanUncertaintyNotice';
import ChanUpstreamNotice from './ChanUpstreamNotice';
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
  if (data.definition?.engine === 'upstream') {
    const raw = data.upstreamRaw;
    const last = raw?.pivots?.at(-1);
    return <div aria-label="缠论结构研判" className="space-y-3 text-sm leading-6 text-slate-700">
      <h3 className="font-semibold text-slate-900">开源原版对照</h3>
      <p>使用开源项目自己的笔、简化线段和笔中枢；该结果不是递归走势中枢，也不代表已经验证符合原文。</p>
      <ChanUpstreamNotice data={data} />
      {raw?.ok && <><p>上游计算：{raw.bis.length} 笔，{raw.segments.length} 条线段，{raw.pivots.length} 个笔中枢。</p>
        {last && <p>上游最近笔中枢：{data.dates[last.i0]} 至 {data.dates[last.i1]}，ZD {price(last.zd)} / ZG {price(last.zg)}，DD {price(last.dd)} / GG {price(last.gg)}，{last.count} 笔。{last.upgraded ? '上游九笔升级标记，不代表已证明递归级别。' : ''}</p>}
        <p>上游不按K线完成状态确认，也未提供线段或中枢的确认依据时刻；相邻线段的端点可能不相接。走势、背驰及买卖点未在此模式展示。</p></>}
    </div>;
  }
  if (data.inputProblem) return <p className="py-6 text-sm text-amber-600">{`行情第 ${data.inputProblem.index + 1} 根 K 线${data.inputProblem.date ? `（${data.inputProblem.date}）` : ''}数据无效，缠论计算已停止。`}</p>;
  if (data.definition?.engine === 'external') {
    const latest = data.zs.at(-1);
    return <div aria-label="缠论结构研判" className="space-y-3 text-sm leading-6 text-slate-700">
      <h3 className="font-semibold text-slate-900">修正结构参考</h3>
      <p>使用本项目的笔与特征序列线段，以已完成笔的价格区间构造笔中枢参考；不是递归走势中枢。</p>
      {latest ? <p>最近笔构造参考中枢：{data.dates[latest.sdt - 1]} 至 {data.dates[latest.edt - 1]}，ZD {price(latest.zd)} / ZG {price(latest.zg)}，{latest.stroke_count} 笔。{latest.status === 'uncertain' ? '后续状态无法确定' : latest.status === 'closed' ? '已结束' : latest.phase === 'leaving' ? '离开后等待回试确认' : '延伸中'}；形成确认依据K：{data.dates[latest.confirmed_time - 1]}{latest.closed_time ? `；结束确认依据K：${data.dates[latest.closed_time - 1]}` : ''}。</p>
        : !(data.zsUncertainty?.length) && <p>当前历史没有识别到笔中枢。</p>}
      <ChanUncertaintyNotice data={data} />
      <p>确认依据K按本次历史窗口复算，不等于系统首次观测时刻；历史结构可能随新行情回退重算。</p>
      <ChanSegments data={data} />
      <section aria-label="修正结构研判范围" className="space-y-2 rounded-xl border border-slate-200 p-3">
        <p>尚无与当前修正结构相匹配的第三方走势、背驰及买卖点结果。</p>
        <p>原第三方结果依赖不同的笔和线段，因此不能作为当前图的信号。</p>
      </section>
    </div>;
  }
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
            ['现价', price(levels.close)], ['相对中枢', levels.vs_zs_label || '尚无已确认线段中枢'],
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
          <div className="text-slate-500">{levels.zs_status === 'uncertain' ? '最近已确认的中枢' : levels.zs_status === 'closed' ? '最近已结束的中枢' : '当前中枢'}</div><p>{levels.zs_range}</p>
          <p className="text-slate-500">{levels.zs_segment_count} 段 · 本图最小级别 · {levels.zs_status === 'uncertain' ? '后续状态无法确定' : levels.zs_status === 'closed' ? '已结束' : levels.zs_phase === 'leaving' ? '等待回试确认' : '延伸中'}</p>
          <p className="text-slate-500">形成确认依据K：{levels.zs_confirmed_time}{levels.zs_closed_time ? `；结束确认依据K：${levels.zs_closed_time}` : ''}</p>
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
  if (data.definition?.engine === 'upstream') return <div className="space-y-3 text-sm text-slate-700">
    <ChanUpstreamNotice data={data} />
    <p>逐笔列出开源原版结果，分型详情和确认时刻未提供。</p>
    <ol className="max-h-[420px] divide-y divide-slate-200 overflow-y-auto">{data.upstreamRaw?.bis.map((pen, i) => <li key={i} className="py-2">
      {data.dates[pen.i0]} @ {price(pen.p0)} → {data.dates[pen.i1]} @ {price(pen.p1)}
    </li>)}</ol>
  </div>;
  if (data.inputProblem) return <p className="py-6 text-sm text-amber-600">{`行情第 ${data.inputProblem.index + 1} 根 K 线数据无效，缠论计算已停止。`}</p>;
  if (data.definition?.engine === 'external') return <div className="text-sm text-slate-700">
    <p className="mb-3 text-xs text-slate-500">本项目笔端参考，不含动态末端；新行情可能引起笔回退重算。</p>
    <ol className="max-h-[420px] divide-y divide-slate-200 overflow-y-auto">
      {data.bi.map((point, i) => <li key={`${point.time}-${i}`} className="flex items-center justify-between gap-4 py-3">
        <span>{point.mark === 'D' ? '笔低' : '笔高'}</span><span className="font-mono">{price(point.price)}</span><time>{data.dates[point.time - 1]}</time>
      </li>)}
    </ol>
  </div>;
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
export default function StockAnalysisPanel({ data, enabled, tab, onTabChange, code, name, period, market = 'ashare', showFinancial, financialReportContent, showNews, showTradeSideHistory, tradeSideHistoryContent, crossPeriodCheck }) {
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
          <p className="mb-4 text-xs leading-5 text-slate-500">{data.inputProblem ? '行情不满足当前引擎输入要求，计算已停止。' : `${periodLabel(period)} · 全部已加载 ${data.dates.length} 根K线参与计算 · 截至 ${data.dates.at(-1) || '—'}；缩放不改变计算起点。`}</p>
          {active === 'outlook' ? <ChanOutlook data={data} /> : <ChanEndpoints data={data} />}
          {active === 'outlook' && <ChanRecursiveStatus data={data} />}
          {active === 'outlook' && crossPeriodCheck}
          <details className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-500">
            <summary className="cursor-pointer font-medium text-slate-700">计算口径与范围</summary>
            {data.definition?.engine === 'upstream' ? <>
              <p className="mt-2">开源原版对照使用固定版本上游计算结果，笔、简化线段和笔中枢均来自同一上游笔链；端点不相接也按原样显示。该算法不是完整的特征序列线段或递归走势中枢。</p>
              <p className="mt-2">上游不按K线完成状态确认，不提供确认依据K；本模式也不展示上游走势、背驰或买卖点。上游会过滤非正收盘价；为避免改变行情比较，遇到此类记录时对照停止并提示。</p>
            </> : data.definition?.engine === 'external' ? <>
              <p className="mt-2">笔与线段使用本项目算法，笔有破坏回退与极值检查；线段使用特征序列规则，确认依据K按本次历史复算，后续可能回退。笔构造参考中枢由三笔的实际价格区间形成，延伸时核心保持不变；结束与确认时间另行记录。端点K线内高低先后不明而影响判断时标记不确定。</p>
              <p className="mt-2">本图没有递归构造更高级别走势中枢。尚无与当前修正结构匹配的第三方走势、背驰及买卖点结果；此处展示的笔中枢仅供参考。</p>
            </> : <>
            <p className="mt-2">逐根处理K线包含和三K分型；按第62、65、77课旧笔口径，顶底分型之间至少有一根不属于任一分型的独立K线。笔被新K线破坏时回退重算。黄色折线连接笔端及当前动态极值，三角标记笔端参考，圆点标记分型。</p>
            <p className="mt-2">线段采用第65、67、71、77、78课特征序列规则及第81课更正；前三笔须有价格重叠，已确认段由后续完成笔的破坏条件确认，端点与确认依据K分别记录。来源未明确最新K已收盘时，须等待后继同周期K才将前K计为已完成；来源明确未收盘的K不能用于确认。笔、分型、线段和中枢均使用全部已加载历史计算，不按固定根数或笔数截断。</p>
            <p className="mt-2">色框为本图最小级别的线段中枢：三个连续已确认线段的实际价格区间有正宽重叠才形成，上沿ZG取三段最高价的最小值，下沿ZD取三段最低价的最大值。后续延伸保持核心区间，没有九段上限；发展中线段不参与构枢。K线周期不等于中枢级别，尚未递归构造更高级别。</p>
            <p className="mt-2">本版将触边视为延伸；首次回试严格在核心外、同向Z段不触枢或连续两段不触枢可确认结束。端点K线内高低先后影响判断时，后续状态标为不确定。离开段可参与后续新枢的前三段。形成与结束均单独记录确认依据K，不回填到线段端点冒充当时已知的信号。</p>
            <p className="mt-2">计算使用全部已加载的有效K线，加载范围之前的数据未参与；首笔之前的K线用于初始化，不强行连笔。加载更早历史可能改变起笔及后续结构，缩放只改变可见范围。新行情可能修正近端结构。</p>
            <p className="mt-2">买卖点观察按第17、20、21、101课列出后续条件，不代表已识别或已确认；当前未执行走势级别、递归中枢、背驰及一二三类买卖点的自动识别。二类观察须从真实一类买卖点后的次级别走势出发，不能用任意前低或前高替代。</p>
            </>}
          </details>

        </>}
      </section>
    </CardContent>
  </Card>;
}
