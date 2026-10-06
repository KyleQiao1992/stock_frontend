/** 缠论第62、65课：先顺序处理包含关系，再识别三根K线分型。 */

export function hasInclusion(a, b) {
  return (a.high >= b.high && a.low <= b.low) ||
    (b.high >= a.high && b.low <= a.low)
}

/**
 * 包含方向须由前一对非包含K线确定，向上取 max/max，向下取 min/min。
 * 截取历史开头若是包含链，缺少这个前提，舍弃无法定向的前缀；
 * 从第一对非包含K线开始，不用未来方向反推，也不默认上涨。
 * from/to 记录原始区间，highIdx/lowIdx 分别记录真实极值所在原K线。
 * 同价极值保留最早的原K线，这是绘图定位的确定性约定。
 */
export function mergeCandles(candles) {
  if (!candles.length) return []
  let start = 0
  while (start + 1 < candles.length && hasInclusion(candles[start], candles[start + 1])) start++
  if (start + 1 === candles.length && start > 0) return []

  const merged = []
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]
    const cur = {
      high: c.high, low: c.low, time: c.time, idx: i,
      from: i, to: i, highIdx: i, lowIdx: i
    }
    const prev = merged.at(-1)
    if (!prev || !hasInclusion(prev, cur)) {
      merged.push(cur)
      continue
    }

    // 开头已经确定了非包含对；之后的方向来自最后两个已处理K线。
    const prev2 = merged.at(-2)
    const up = prev.high > prev2.high
    if (up) {
      if (cur.high > prev.high) { prev.high = cur.high; prev.highIdx = i }
      if (cur.low > prev.low) { prev.low = cur.low; prev.lowIdx = i }
    } else {
      if (cur.high < prev.high) { prev.high = cur.high; prev.highIdx = i }
      if (cur.low < prev.low) { prev.low = cur.low; prev.lowIdx = i }
    }
    prev.to = i
    prev.idx = up ? prev.highIdx : prev.lowIdx
    prev.time = candles[prev.idx].time
  }
  return merged
}

/**
 * 中间K线的高、低均严格高于两邻线为顶，均严格低于两邻线为底。
 * 所有标记都是原始三K分型候选；能否成为笔端，另按严格笔条件筛选。
 */
export function findFractals(candles, merged) {
  const out = []
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1]
    const b = merged[i]
    const c = merged[i + 1]
    let mark
    if (b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low) mark = 'G'
    else if (b.low < a.low && b.low < c.low && b.high < a.high && b.high < c.high) mark = 'D'
    if (!mark) continue
    const idx = mark === 'G' ? b.highIdx : b.lowIdx
    out.push({
      mark, mi: i, idx, time: candles[idx].time,
      price: mark === 'G' ? b.high : b.low,
      high: b.high, low: b.low,
      leftMi: i - 1, rightMi: i + 1,
      from: a.from, to: c.to,
      confirmedAt: candles[c.to].time
    })
  }
  return out
}
