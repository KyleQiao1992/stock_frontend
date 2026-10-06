import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import StockNewsPanel from './StockNewsPanel';

const price = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
function ChanOutlook({ data }) {
  const outlook = data.outlook;
  if (!outlook?.ok) return <p className="py-6 text-sm text-slate-500">当前历史中尚无可绘制的笔结构。</p>;
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
        ['笔中枢上沿 ZG', levels.zs_zg, levels.zs_zg_bar], ['笔中枢下沿 ZD', levels.zs_zd, levels.zs_zd_bar],
      ].map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-xl border border-slate-200 p-3">
        <div className="text-xs text-slate-500">{label}</div><div className="mt-1 font-mono text-base font-semibold">{price(value)}</div>
        {detail && <div className="mt-1 break-words text-xs text-slate-500">{detail.split(' @ ')[0]}</div>}
      </div>)}
    </div>
    <p className="text-xs text-slate-500">{Math.max(0, data.bi.length - 1)} 笔；{hasZone ? levels.zs_range : '尚无三笔的有效重叠区。'}</p>
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
          <p className="mb-4 text-xs leading-5 text-slate-500">{({'101':'日K','102':'周K','103':'月K'})[period] || period} · {data.definition.historyBars} 根历史计算 · 截至 {data.historyDates.at(-1) || '—'}；缩放不改变计算起点。</p>
          <details className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-500">
            <summary className="cursor-pointer font-medium text-slate-700">参考站划线口径</summary>
            <p className="mt-2">逐根处理K线包含和三K分型；笔被新K线破坏时回退重算。黄色折线连接笔端及当前动态极值，三角标记笔端参考，圆点标记分型。</p>
            <p className="mt-2">中枢由连续前三笔固定ZG/ZD，保持核心区间最多延伸九笔，按滑动窗口绘制。蓝框为当前参考中枢。动态末端不参与笔端参考和中枢。</p>
            <p className="mt-2">计算历史窗口与参考站保持相同请求长度，起笔前的历史自动裁去；缩放只改变可见范围。新行情可能修正近端结构。</p>
          </details>
          {active === 'outlook' ? <ChanOutlook data={data} /> : <ChanEndpoints data={data} />}
        </>}
      </section>
    </CardContent>
  </Card>;
}
