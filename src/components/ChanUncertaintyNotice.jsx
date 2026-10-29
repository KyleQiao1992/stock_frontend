/** The numerical K coordinates refer to the same history as data.dates. */
export default function ChanUncertaintyNotice({ data }) {
  const item = data?.zsUncertainty?.[0];
  if (!item) return null;
  if (item.reason === 'incomplete_candle') return <span className="text-amber-600 dark:text-amber-400">
    存在未完成的K线，后续笔构造参考中枢须等待K线完成；已识别的参考区保持显示
  </span>;
  const time = item.segments?.[0]?.start?.time;
  const date = data.dates?.[time - 1];
  return <span className="text-amber-600 dark:text-amber-400">
    {date ? `从 ${date} 起，` : ''}K线内高低价的先后顺序无法确定，后续中枢边界或状态需要更细粒度行情核实
  </span>;
}
