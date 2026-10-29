/** Lowest-layer geometric evidence does not establish completed lower-level movements. */
export default function ChanRecursiveStatus({ data }) {
  const state = data?.recursiveReadiness;
  if (!state || state.status === 'invalid_input') return null;
  const { confirmedSegmentCount, centers, uncertaintyCount } = state.foundation;
  return <section aria-label="递归走势中枢状态" data-chan-recursive-status={state.nextLevel.status}
    className="mb-4 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-500">
    <p>线段基础：{confirmedSegmentCount} 条已确认线段，{centers.length} 个已确定的线段构造中枢{uncertaintyCount ? `，${uncertaintyCount} 处边界或后续状态不确定` : ''}。</p>
    <p>更高级别走势中枢尚未判定：当前尚未独立证明连续的次级别走势类型及其完成时刻。这不表示更高级别中枢不存在。</p>
  </section>;
}
