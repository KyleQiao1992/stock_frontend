import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import StockNewsPanel from './StockNewsPanel';

const price = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
function ChanOutlook({ data }) {
  const outlook = data.outlook;
  if (!outlook?.ok) return <p className="py-6 text-sm text-slate-500">尚无符合严格老笔规则的完成笔。分型之间须满足独立K线及高低点条件，未确认结构以虚线表示。</p>;
  const { conclusion: c, levels } = outlook;
  const hasZone = data.zs.length > 0;
  return <div className="space-y-4 text-sm leading-6 text-slate-700">
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="font-semibold text-slate-900">{c.title} · 结构观察</div>
      <p className="mt-2">{c.structure_fact}</p>
      <p className="mt-2 text-xs text-slate-500">{c.observation_basis}</p>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ['末笔高点', levels.last_bi_high, levels.last_bi_high_bar],
        ['末笔低点', levels.last_bi_low, levels.last_bi_low_bar],
        ['线段中枢上沿 ZG', levels.zs_zg, levels.zs_zg_bar], ['线段中枢下沿 ZD', levels.zs_zd, levels.zs_zd_bar],
      ].map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-xl border border-slate-200 p-3">
        <div className="text-xs text-slate-500">{label}</div><div className="mt-1 font-mono text-base font-semibold">{price(value)}</div>
        {detail && <div className="mt-1 break-words text-xs text-slate-500">{detail.split(' @ ')[0]}</div>}
      </div>)}
    </div>
    <p className="text-xs text-slate-500">已完成 {data.segments.length} 条线段；{hasZone ? levels.zs_range : '尚无三条连续完成线段的有效重叠区。'}</p>
    <div><h4 className="font-semibold text-slate-900">后续结构条件</h4><p>{c.trigger_condition}</p><p className="mt-2">{c.invalidation}</p></div>
    <p className="text-xs text-slate-500">{outlook.disclaimer}</p>
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
          <p className="mb-4 text-xs leading-5 text-slate-500">{({'101':'日K','102':'周K','103':'月K'})[period] || period} · 已加载 {data.dates.length} 根历史计算 · 截至 {data.dates.at(-1) || '—'}；缩放不改变计算起点。</p>
          <details className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-500">
            <summary className="cursor-pointer font-medium text-slate-700">原典严格老笔 · 定义与确认规则</summary>
            <p className="mt-2">先处理K线包含，再识别三根处理后K线的顶底分型。顶底两分型之间至少留一根独立K线；满足条件的笔按顶底交替连接。</p>
            <p className="mt-2">线段至少三笔，前三笔必须重叠；按标准特征序列分型确认结束，有缺口时等待反向特征序列确认。末端未确认笔、线段画虚线，不参与中枢。</p>
            <p className="mt-2">色框由三条连续完成线段重叠构成，标为本图最小级别线段中枢。ZG取三段高点最小值，ZD取三段低点最大值；延伸不改变核心区间。K线周期不直接等于走势级别。</p>
            <p className="mt-2">更高走势级别的递归分解和背驰尚未计算，因此未确认一、二、三类买卖点。历史起点有限、末根行情变化时，近端结构可能修正。</p>
            <p className="mt-2">定义依据：<a href="https://eczsc.com/originals/62" target="_blank" rel="noreferrer" className="underline">第62课</a>、<a href="https://eczsc.com/originals/67" target="_blank" rel="noreferrer" className="underline">第67课</a>、<a href="https://eczsc.com/originals/71" target="_blank" rel="noreferrer" className="underline">第71课</a>及<a href="https://eczsc.com/originals/81" target="_blank" rel="noreferrer" className="underline">第81课更正</a>。</p>
          </details>
          {active === 'outlook' ? <ChanOutlook data={data} /> : <ChanEndpoints data={data} />}
        </>}
      </section>
    </CardContent>
  </Card>;
}
