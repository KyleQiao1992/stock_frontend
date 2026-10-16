import { classifyTopFractal } from './topFractalTraits.js';
import { classifyBottomFractal } from './bottomFractalTraits.js';

/** Explain the exact three-bar snapshot used by the incremental engine.
 * Never re-analyze a cropped viewport: its starting direction may differ.
 */
export function buildFractalDetail(candles, point) {
  const mergedCandles = point.elements.map((bar) => ({
    high: bar.high, low: bar.low, time: bar.time, from: bar.from, to: bar.to,
    // Read the full input range, not the engine's capped working elements list.
    sources: candles.slice(bar.from, bar.to + 1).map((candle, i) => ({ ...candle, idx: bar.from + i })),
    steps: (bar.mergeSteps || []).map((step) => ({ ...step,
      before: { ...step.before }, incoming: { ...step.incoming }, after: { ...step.after },
    })),
  }));
  const [left, middle, right] = mergedCandles;
  const top = point.mark === 'G';
  const operator = top ? '>' : '<';
  const conditions = ['high', 'low'].flatMap((field) => [
    { label: `中间K${field === 'high' ? '高点' : '低点'} ${operator} 左K${field === 'high' ? '高点' : '低点'}`,
      left: middle[field], operator, right: left[field],
      passed: top ? middle[field] > left[field] : middle[field] < left[field] },
    { label: `中间K${field === 'high' ? '高点' : '低点'} ${operator} 右K${field === 'high' ? '高点' : '低点'}`,
      left: middle[field], operator, right: right[field],
      passed: top ? middle[field] > right[field] : middle[field] < right[field] },
  ]);
  const detail = {
    mark: point.mark, time: point.time, price: point.price,
    rawCandles: candles.slice(left.from, right.to + 1).map((candle, i) => ({ ...candle, idx: left.from + i })),
    mergedCandles, conditions, isValid: conditions.every((condition) => condition.passed),
  };
  return { ...detail, topTraits: classifyTopFractal(detail), bottomTraits: classifyBottomFractal(detail) };
}
