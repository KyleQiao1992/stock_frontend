import { useEffect, useState } from 'react';
import { NEWS_CATEGORIES, loadStockNews } from '../lib/stockNews.js';

export default function StockNewsPanel({ code }) {
  const [category, setCategory] = useState('news');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const key = `${code}:${category}:${attempt}`;
  useEffect(() => {
    let cancelled = false;
    if (!code) return;
    loadStockNews(code, category, attempt > 0)
      .then((items) => { if (!cancelled) setResult({ key, items }); })
      .catch((error) => { if (!cancelled) setResult({ key, error: error.name === 'TimeoutError' ? '资讯请求超时，请重试' : error.message || '资讯加载失败，请重试' }); });
    return () => { cancelled = true; };
  }, [code, category, attempt, key]);
  const current = result?.key === key ? result : null;
  const label = NEWS_CATEGORIES.find((c) => c.key === category).label;
  return <section aria-label="个股资讯" className="flex h-full min-h-0 w-full flex-col overflow-hidden">
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex gap-1" role="tablist" aria-label="资讯分类">
        {NEWS_CATEGORIES.map((c) => <button key={c.key} type="button" role="tab" aria-selected={category === c.key} onClick={() => { setCategory(c.key); setAttempt(0); }} className={`rounded-lg px-3 py-1.5 text-xs ${category === c.key ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>{c.label}</button>)}
      </div>
      <button type="button" disabled={!!code && !current} onClick={() => setAttempt((v) => v + 1)} className="shrink-0 text-xs text-slate-500 disabled:opacity-40" aria-label="刷新资讯">刷新</button>
    </div>
    <div role="tabpanel" aria-label={label} aria-live="polite" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
      {!code ? <p className="py-8 text-center text-sm text-slate-500">选择股票后查看资讯</p> : !current ? <p className="py-8 text-center text-sm text-slate-500">{label}加载中…</p> : current.error ? <div className="py-8 text-center text-sm text-rose-500">{current.error}<button type="button" onClick={() => setAttempt((v) => v + 1)} className="mx-auto mt-3 block underline">重试</button></div> : !current.items.length ? <p className="py-8 text-center text-sm text-slate-500">该股票暂无{label}</p> : <>
        <p className="mb-2 text-xs text-slate-500">最近 {current.items.length} 条{label}</p>
        <ol className="divide-y divide-slate-200">
          {current.items.map((item) => <li key={item.key} className="py-3">
            {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="block break-words text-sm leading-6 text-slate-800 hover:underline">{item.title}</a> : <span className="block break-words text-sm leading-6 text-slate-800">{item.title}</span>}
            <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] leading-5 text-slate-500"><span>{item.source || '来源未标注'}</span><time>{item.time}</time></div>
          </li>)}
        </ol>
      </>}
    </div>
    <p className="mt-3 text-[11px] text-slate-400">腾讯财经资讯 · 点击标题查看原文</p>
  </section>;
}
