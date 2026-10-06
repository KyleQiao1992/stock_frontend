/** 第62、77课的严格笔口径：两个三K分型之间另有至少一根独立K线。 */
export const STRICT_BI_MIN_GAP = 4

const moreExtreme = (a, b) => a.mark === 'G' ? b.price > a.price : b.price < a.price

/**
 * 使用合并K线的中心区间检验端点极值，不能用原始K线数量替代合并数量。
 * 未传 merged 时可供分型级调用，但仅能核验分型记录携带的区间。
 */
export function isStrictBi(a, b, merged, fractals = []) {
  if (a.mark === b.mark || b.mi - a.mi < STRICT_BI_MIN_GAP) return false
  const top = a.mark === 'G' ? a : b
  const bottom = a.mark === 'D' ? a : b
  if (!(top.price > bottom.price)) return false
  if (Number.isFinite(top.high) && Number.isFinite(bottom.high) && !(top.high > bottom.high)) return false

  const interval = merged
    ? merged.slice(a.mi, b.mi + 1)
    : fractals.filter((f) => f.mi >= a.mi && f.mi <= b.mi)
  for (const bar of interval) {
    const high = bar.high ?? (bar.mark === 'G' ? bar.price : undefined)
    const low = bar.low ?? (bar.mark === 'D' ? bar.price : undefined)
    if ((Number.isFinite(high) && high > top.price) ||
        (Number.isFinite(low) && low < bottom.price)) return false
  }
  return true
}

/**
 * 返回上下交替的严格笔端点，保留 mi、原始 idx 和分型区间元数据。
 * 同性质候选保留更极端者，相等时保留较早者（第77课）。
 * 不足一笔的反向转折若越过前起点，只能撤回失效的尾部并重选极值；
 * 替换前复核整笔区间，禁止制造一笔端点并非最高/最低的旧笔。
 * 无百分比回撤、缺口放宽或小波动吸收规则。
 * 最后端点尚未被合法反向笔封闭，confirmed=false；新K线可改变尾部。
 */
export function buildBi(fractals, { merged } = {}) {
  if (!fractals.length) return []
  const points = [fractals[0]]
  const valid = (a, b) => isStrictBi(a, b, merged, fractals)

  const extend = (f) => {
    while (points.length) {
      const last = points.at(-1)
      if (!moreExtreme(last, f)) return
      if (points.length === 1 || valid(points.at(-2), f)) {
        points[points.length - 1] = f
        return
      }
      // 无法延伸时撤回相邻两端；剩下的末端仍与 f 同性质。
      points.splice(-2, 2)
    }
    points.push(f)
  }

  for (let i = 1; i < fractals.length; i++) {
    const f = fractals[i]
    const last = points.at(-1)
    if (f.mark === last.mark) {
      extend(f)
    } else if (valid(last, f)) {
      points.push(f)
    } else if (points.length >= 2 && moreExtreme(points.at(-2), f)) {
      // 短反向分型不能成新笔，且已使上一笔起点失去极值资格。
      points.pop()
      extend(f)
    }
  }
  return points.map((p, i) => ({ ...p, confirmed: i < points.length - 1 }))
}

export function biRange(a, b) {
  return { high: Math.max(a.price, b.price), low: Math.min(a.price, b.price) }
}

export function biDirection(a, b) {
  return b.price > a.price ? 'up' : 'down'
}
