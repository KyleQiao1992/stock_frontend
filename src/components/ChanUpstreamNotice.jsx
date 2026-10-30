export default function ChanUpstreamNotice({ data }) {
  const problem = data.inputProblem;
  if (problem) {
    if (problem.reason === 'unsupported_period') return <p className="text-amber-600 dark:text-amber-400">开源原版对照不支持当前周期，计算已停止。</p>;
    const location = `第 ${problem.index + 1} 根 K 线${problem.date ? `（${problem.date}）` : ''}`;
    const reason = problem.reason === 'upstream_non_positive_close' ? '收盘价不是正数，上游算法会丢弃该记录'
      : problem.reason === 'invalid_timestamp' ? '时间不能按上游格式解析'
        : problem.reason === 'non_increasing_timestamp' ? '时间不是严格递增'
          : '行情数据无效';
    return <p className="text-amber-600 dark:text-amber-400">{`开源原版对照已停止：${location}${reason}，不能静默改变行情后比较。`}</p>;
  }
  if (data.upstreamRaw && !data.upstreamRaw.ok) return <p className="text-amber-600 dark:text-amber-400">开源原版对照：{data.upstreamRaw.reason}</p>;
  if (data.lastBarCompletion === false) return <p className="text-amber-600 dark:text-amber-400">最新K线明确未收盘，上游仍会计算，结果可能随行情变化。</p>;
  if (data.lastBarCompletion == null && data.dates?.length) return <p className="text-amber-600 dark:text-amber-400">最新K线未提供收盘状态，上游仍会计算，结果可能随行情变化。</p>;
  return null;
}
