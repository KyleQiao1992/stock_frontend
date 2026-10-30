import { useEffect, useRef, useState } from 'react';
import { inspectLiveCrossPeriod } from '../lib/chan/liveCrossPeriod.js';

const fieldNames = { open: '开盘价', high: '最高价', low: '最低价', close: '收盘价', volume: '成交量' };

/** On-demand data comparison. It does not classify movements or centers. */
export default function ChanCrossPeriodCheck({ code, symbol, adjust, isIndex, loadJson }) {
  const [state, setState] = useState({ status: 'idle' });
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);

  const inspect = async () => {
    const id = ++run.current;
    setState({ status: 'loading' });
    try {
      const result = await inspectLiveCrossPeriod({ symbol, code, adjust, isIndex, loadJson });
      if (run.current === id) setState({ status: 'ready', result });
    } catch (error) {
      if (run.current === id) setState({ status: 'error', message: error?.message || '行情核对失败' });
    }
  };

  const result = state.result;
  const outside = result?.comparison.windows.filter(window => window.status === 'missing'
    && window.reason === 'outside_observed_5m_coverage').length ?? 0;
  const conflicts = result?.comparison.windows.filter(window => window.status === 'conflict').slice(-5) ?? [];
  return <section aria-label="5分钟与30分钟行情核对" className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-600">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">5分钟与30分钟行情核对</span>
      <button type="button" onClick={inspect} disabled={state.status === 'loading'}
        className="rounded-lg border border-slate-300 px-2 py-1 disabled:opacity-50">
        {state.status === 'loading' ? '核对中…' : '核对5分钟与30分钟'}
      </button>
    </div>
    <p className="mt-2">核对同一标的两种周期的行情是否对应；不是走势中枢，也不判断买卖点。</p>
    {state.status === 'error' && <p role="alert" className="mt-2 text-red-600">{state.message}</p>}
    {result && <div className="mt-2 space-y-1" data-cross-period-result>
      <p>{`${code} · 匹配 ${result.counts.complete} · 缺失 ${result.counts.missing} · 冲突 ${result.counts.conflict} · 未确认 ${result.counts.unconfirmed}`}</p>
      {result.counts.missing > 0 && <p>{`缺失原因：${outside} 个窗口超出已加载的5分钟历史，${result.counts.missing - outside} 个窗口在覆盖范围内缺K。`}</p>}
      {conflicts.length > 0 && <p>{`最近冲突：${conflicts.map(window => `${window.end}（${window.differences.map(item => fieldNames[item.field] ?? item.field).join('、')}）`).join('；')}`}</p>}
      <p>{`对照范围：${result.coverage.overlapStart ?? '无'} 至 ${result.coverage.overlapEnd ?? '无'}；排除尚未结束的K线：5分钟 ${result.omitted.five} 根，30分钟 ${result.omitted.thirty} 根。`}</p>
      <p>行情和复权基底按本次请求核对，不能证明数据源没有遗漏交易日，也不能证明走势完成。</p>
    </div>}
  </section>;
}
