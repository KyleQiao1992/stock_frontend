/** 缠论第二步：由分型连成笔 */

/**
 * 笔：顶底分型交替相连，两端之间需有足够独立 K 线。
 * minGap 为两分型在合并 K 线序列上的最小间隔（默认 3，即顶底之间至少隔 1 根独立 K 线）。
 * 返回笔端点数组 [{time, price, idx, mark}]，相邻两点构成一笔。
 */
export function buildBi(fractals, { minGap = 3, maxRetrace = ABSORB_MAX_RETRACE } = {}) {
  if (!fractals.length) return []
  const pts = []
  let cur = fractals[0]

  const better = (a, b) => (a.mark === 'G' ? b.price > a.price : b.price < a.price)

  for (let i = 1; i < fractals.length; i++) {
    const f = fractals[i]
    if (f.mark === cur.mark) {
      // 同向分型：保留更极端的那个
      if (better(cur, f)) cur = f
      continue
    }
    const gapOk = f.mi - cur.mi >= minGap
    const priceOk = cur.mark === 'D' ? f.price > cur.price : f.price < cur.price
    if (gapOk && priceOk) {
      pts.push(cur)
      cur = f
    } else if (!priceOk) {
      // 价格关系不成立（如底分型比前一个顶分型还高），以更极端者顶替
      if (pts.length) {
        const last = pts[pts.length - 1]
        if (last.mark === f.mark && better(last, f)) {
          pts[pts.length - 1] = f
          cur = f
        }
      }
    }
  }
  pts.push(cur)

  // 至少两点才成笔
  if (pts.length < 2) return []
  const simplified = simplifyBi(pts, { maxRetrace })
  return simplified.map((p) => ({
    time: p.time,
    price: p.price,
    idx: p.idx,
    mark: p.mark
  }))
}

/** 吸收判定：回调不超过前一腿的该比例时，视为次级波动 */
export const ABSORB_MAX_RETRACE = 0.25

/**
 * 笔的简化：吸收「未创新低/新高且回调有限」的次级转折。
 * 序列 D1→G1→D2→G2 中，若 G2>G1 且 D2>D1（中间回调没破前低、后续又创新高），
 * 且该回调幅度不足前一腿的 ABSORB_MAX_RETRACE，则认为 G1/D2 只是次级波动，
 * 合并为一笔 D1→G2。下跌方向对称处理，反复迭代直到稳定。
 *
 * 注：回撤保护用于避免把幅度可观的真实转折一并吞掉——没有它，
 * 单调条件会把整段单边行情塌缩成一笔。
 */
export function simplifyBi(points, { maxRetrace = ABSORB_MAX_RETRACE } = {}) {
  const pts = points.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i + 2 < pts.length; i++) {
      const p0 = pts[i - 1]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2]
      if (p1.mark === p2.mark) continue
      const up = p1.mark === 'G'
      const mono = up
        ? p3.price > p1.price && p2.price > p0.price
        : p3.price < p1.price && p2.price < p0.price
      if (!mono) continue
      const leg = Math.abs(p1.price - p0.price)
      const back = Math.abs(p2.price - p1.price)
      if (leg > 0 && back / leg >= maxRetrace) continue
      pts.splice(i, 2)
      changed = true
      break
    }
  }
  return pts
}

/** 笔的高低：由两端点决定 */
export function biRange(a, b) {
  return { high: Math.max(a.price, b.price), low: Math.min(a.price, b.price) }
}

/** 笔方向：up = 由底到顶 */
export function biDirection(a, b) {
  return b.price > a.price ? 'up' : 'down'
}
