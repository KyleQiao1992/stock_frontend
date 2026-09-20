/** 缠论第三步：中枢（滑动窗口口径） */

import { biRange } from './bi.js'

/** 中枢最多延伸的笔数 */
export const ZS_MAX_BI = 9
/** 构成中枢的最少笔数 */
export const ZS_MIN_BI = 3

/**
 * 中枢：连续至少 3 笔的重叠区间。
 * ZG/ZD 由前 3 笔固定（ZG = 三笔高点的最小值，ZD = 三笔低点的最大值，要求 ZG > ZD），
 * 随后只要后一笔与 [ZD, ZG] 仍有重叠就并入，最多 9 笔。
 * 每个起点独立尝试成枢（相邻中枢可重叠），最后丢弃被其他中枢完全包含的。
 *
 * 注意：传入的笔端点不应包含「当前未完成笔」的动态端点。
 */
export function buildZs(biPoints, { minBi = ZS_MIN_BI, maxBi = ZS_MAX_BI } = {}) {
  const segs = []
  for (let i = 0; i + 1 < biPoints.length; i++) {
    const a = biPoints[i]
    const b = biPoints[i + 1]
    segs.push({ ...biRange(a, b), sdt: a.time, edt: b.time })
  }
  if (segs.length < minBi) return []

  const cands = []
  for (let s = 0; s + minBi <= segs.length; s++) {
    const head = segs.slice(s, s + minBi)
    const zg = Math.min(...head.map((x) => x.high))
    const zd = Math.max(...head.map((x) => x.low))
    if (zg <= zd) continue
    // 延伸：后续笔只要与 [zd, zg] 有重叠就并入，区间本身不再收缩
    let end = s + minBi - 1
    while (end + 1 < segs.length && end + 1 - s + 1 <= maxBi) {
      const nx = segs[end + 1]
      if (nx.high < zd || nx.low > zg) break
      end++
    }
    cands.push({ s, end, zg, zd })
  }

  // 丢弃被其他候选完全包含的
  const kept = cands.filter(
    (c) => !cands.some((o) => o !== c && o.s <= c.s && o.end >= c.end && (o.s < c.s || o.end > c.end))
  )

  return kept.map((c) => ({
    id: `zs-${segs[c.s].sdt}-${segs[c.end].edt}`,
    sdt: segs[c.s].sdt,
    edt: segs[c.end].edt,
    zg: c.zg,
    zd: c.zd,
    zz: (c.zg + c.zd) / 2,
    bi_count: c.end - c.s + 1,
    algorithm: 'sliding_window'
  }))
}

/** 现价相对中枢的位置 */
export function positionVsZs(price, zs) {
  if (!zs) return { vs: 'none', label: '无参考中枢' }
  if (price > zs.zg) return { vs: 'above', label: '中枢上方' }
  if (price < zs.zd) return { vs: 'below', label: '中枢下方' }
  return { vs: 'inside', label: '中枢内部' }
}
