/** OHLC does not reveal whether both extremes of an endpoint K occurred before or after the turn. */
export default function ChanPendingNotice({ data }) {
  const item = data?.pendingUncertainty?.[0];
  if (!item) return null;
  const date = data.dates?.[item.endpoint_time - 1] ?? `第 ${item.endpoint_time} 根K`;
  const definite = Number.isFinite(item.guaranteed_price) ? item.guaranteed_price : '暂无';
  return <span data-chan-pending-uncertainty="endpoint-order" className="text-amber-600 dark:text-amber-400">
    {`笔端 ${date} 的K线高低先后不明；后续可确定极值 ${definite}，该K另一极值 ${item.possible_price} 是否属于后续走势尚不确定。`}
  </span>;
}
