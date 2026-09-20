/** 缠论第一步：K 线包含关系处理 + 分型识别 */

/**
 * 包含关系处理：相邻两根 K 线互相包含时合并为一根。
 * 向上处理取 max(high)/max(low)，向下处理取 min(high)/min(low)。
 * 返回合并后的 K 线，每根带 from/to 指向原始 K 线下标区间。
 */
export function mergeCandles(candles) {
  const merged = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const cur = {
      high: c.high,
      low: c.low,
      time: c.time,
      idx: i,
      from: i,
      to: i,
      // 极值所在的原始下标，笔端定位要用真实 K 线
      highIdx: i,
      lowIdx: i
    }
    if (merged.length < 2) {
      merged.push(cur)
      continue
    }
    const prev = merged[merged.length - 1]
    const contains =
      (prev.high >= cur.high && prev.low <= cur.low) ||
      (cur.high >= prev.high && cur.low <= prev.low)
    if (!contains) {
      merged.push(cur)
      continue
    }
    // 方向由前两根决定
    const prev2 = merged[merged.length - 2]
    const up = prev.high > prev2.high || prev.low > prev2.low
    if (up) {
      if (cur.high > prev.high) {
        prev.high = cur.high
        prev.highIdx = cur.highIdx
      }
      if (cur.low > prev.low) {
        prev.low = cur.low
        prev.lowIdx = cur.lowIdx
      }
    } else {
      if (cur.high < prev.high) {
        prev.high = cur.high
        prev.highIdx = cur.highIdx
      }
      if (cur.low < prev.low) {
        prev.low = cur.low
        prev.lowIdx = cur.lowIdx
      }
    }
    prev.to = i
    prev.time = candles[up ? prev.highIdx : prev.lowIdx].time
  }
  return merged
}

/**
 * 分型：连续三根合并 K 线，中间最高 → 顶分型(G)，中间最低 → 底分型(D)。
 * price/idx 取原始 K 线上的真实极值点，便于绘图与定位。
 */
export function findFractals(candles, merged) {
  const out = []
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1]
    const b = merged[i]
    const c = merged[i + 1]
    if (b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low) {
      const oi = b.highIdx
      out.push({
        mark: 'G',
        mi: i,
        idx: oi,
        time: candles[oi].time,
        price: candles[oi].high
      })
    } else if (b.low < a.low && b.low < c.low && b.high < a.high && b.high < c.high) {
      const oi = b.lowIdx
      out.push({
        mark: 'D',
        mi: i,
        idx: oi,
        time: candles[oi].time,
        price: candles[oi].low
      })
    }
  }
  return out
}
