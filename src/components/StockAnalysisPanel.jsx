import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import StockNewsPanel from './StockNewsPanel';

const price = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
function ChanOutlook({ data }) {
  const outlook = data.outlook;
  if (!outlook?.ok) return <p className="py-6 text-sm text-slate-500">已完成的笔不足，暂时无法生成结构研判。</p>;
  const { conclusion: c, levels } = outlook;
  const hasZone = data.zs.length > 0;
  return <div className="space-y-4 text-sm leading-6 text-slate-700">
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="font-semibold text-slate-900">{hasZone ? c.title : '暂无参考中枢'} · 结构观察</div>
      <p className="mt-2">{c.structure_fact}</p>
      <p className="mt-2 text-xs text-slate-500">基于笔与中枢的位置推导，未确认一、二、三类买卖点。</p>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ['末笔高点', levels.last_bi_high, levels.last_bi_high_bar],
        ['末笔低点', levels.last_bi_low, levels.last_bi_low_bar],
        ['中枢上沿 ZG', levels.zs_zg, null], ['中枢下沿 ZD', levels.zs_zd, null],
      ].map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-xl border border-slate-200 p-3">
        <div className="text-xs text-slate-500">{label}</div><div className="mt-1 font-mono text-base font-semibold">{price(value)}</div>
        {detail && <div className="mt-1 break-words text-xs text-slate-500">{detail.split(' @ ')[0]}</div>}
      </div>)}
    </div>
    {hasZone ? <>
      <p className="text-xs text-slate-500">{levels.zs_range}</p>
      <div><h4 className="font-semibold text-slate-900">后续观察</h4><p>{c.trigger_condition}</p><p className="mt-2">失效条件：{c.invalidation}</p></div>
      <h4 className="font-semibold text-slate-900">三种情景 · 条件推演</h4>
      <div className="grid gap-3 lg:grid-cols-3">
        {outlook.scenarios.map((scenario) => <article key={scenario.id} className="min-w-0 rounded-xl border border-slate-200 p-3">
          <h5 className="font-semibold text-slate-900">{scenario.name}</h5>
          <p className="mt-1 text-xs text-slate-500">结构匹配分 {scenario.score}/{scenario.score_max}，非发生概率</p>
          <p className="mt-3">{scenario.condition}</p>
          <p className="mt-2 text-xs text-slate-500">{scenario.path}</p>
          <details className="mt-3"><summary className="cursor-pointer text-xs">查看触发与失效条件</summary>
            {scenario.next_points.map((point) => <p key={point.kind} className="mt-2 text-xs"><b>{point.title}（待确认）：</b>{point.trigger}</p>)}
            <p className="mt-2 text-xs">失效：{scenario.invalid}</p>
          </details>
        </article>)}
      </div>
    </> : <p>目前仅能参考末笔高低点；形成有效中枢后再展示中枢位置和三种情景。</p>}
  </div>;
}
function ChanEndpoints({ data }) {
  const [filter, setFilter] = useState('all');
  const items = data.trades.filter((item) => filter === 'all' || item.side === filter);
  return <div>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {[['all','全部'],['buy','笔低'],['sell','笔高']].map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg px-3 py-1.5 text-xs ${filter === value ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500'}`}>{label}</button>)}
      <span className="text-xs text-slate-500">共 {items.length} 个已完成笔端 · 不含当前虚线端点</span>
    </div>
    <div className="max-h-[420px] overflow-y-auto">
      {items.length ? <ol className="divide-y divide-slate-200">{items.map((item) => <li key={`${item.time}-${item.kind}`} className="flex items-start justify-between gap-4 py-3">
        <div><div className="text-sm font-semibold text-slate-900">{item.title}</div><p className="mt-1 text-xs leading-5 text-slate-500">{item.desc}</p></div>
        <div className="shrink-0 text-right"><div className="font-mono text-sm text-slate-900">{item.price_str}</div><time className="text-xs text-slate-500">{item.time_str}</time></div>
      </li>)}</ol> : <p className="py-6 text-sm text-slate-500">当前暂无符合条件的笔端参考。</p>}
    </div>
  </div>;
}
export default function StockAnalysisPanel({ data, enabled, tab, onTabChange, code, name, period, market = 'ashare', showFinancial, financialReportContent, showNews, showFundFlow, fundFlowContent }) {
  const tabs = [
    ...(showFinancial ? [['financial','财报']] : []),
    ...(enabled ? [['outlook','缠论研判'],['endpoints','笔端参考']] : []),
    ...(showNews ? [['news','资讯']] : []),
    ...(showFundFlow ? [['fundFlow','资金动向']] : []),
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
        {active === 'financial' ? financialReportContent : active === 'news' ? <div className="flex h-[520px] min-h-0 overflow-hidden"><StockNewsPanel code={code} market={market} /></div> : active === 'fundFlow' ? fundFlowContent : <>
          <p className="mb-4 text-xs leading-5 text-slate-500">{({'101':'日K','102':'周K','103':'月K'})[period] || period} · 最近 {data.dates.length} 根计算，与图上结构一致 · 截至 {data.dates.at(-1) || '—'}；图表显示根数不改变计算范围。</p>
          {active === 'outlook' ? <ChanOutlook data={data} /> : <ChanEndpoints data={data} />}
        </>}
      </section>
    </CardContent>
  </Card>;
}
