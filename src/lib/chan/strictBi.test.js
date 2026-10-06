import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasInclusion, mergeCandles, findFractals } from './fractal.js'
import { buildBi, isStrictBi } from './bi.js'

const candles = (ranges) => ranges.map(([high, low], i) => ({ high, low, time: i + 1 }))
const levels = (prices) => candles(prices.map((p) => [p + 0.25, p - 0.25]))
const analyze = (raw) => {
  const merged = mergeCandles(raw)
  const fx = findFractals(raw, merged)
  return { merged, fx, points: buildBi(fx, { merged }) }
}
const fx = (mark, mi, price) => ({
  mark, mi, idx: mi, time: mi + 1, price,
  high: mark === 'G' ? price : price + 0.5,
  low: mark === 'D' ? price : price - 0.5
})

test('leading inclusion is unresolved without an earlier direction', () => {
  const raw = candles([[10, 0], [9, 1], [8, 2], [9, 3], [10, 4]])
  const merged = mergeCandles(raw)
  assert.deepEqual(merged.map((b) => b.from), [2, 3, 4])
  assert.deepEqual(mergeCandles(raw.slice(0, 3)), [])
  assert.equal(findFractals(raw, merged).length, 0)
})

test('sequential inclusion uses the last processed interval and preserves true extremum indices', () => {
  const up = candles([[3, 1], [5, 2], [4, 3], [6, 2.5], [5, 1.5]])
  const merged = mergeCandles(up)
  assert.deepEqual(merged.map((b) => [b.high, b.low]), [[3, 1], [6, 3], [5, 1.5]])
  assert.equal(merged[1].highIdx, 3)
  assert.equal(merged[1].lowIdx, 2)
  assert.deepEqual([merged[1].from, merged[1].to], [1, 3])
  const [top] = findFractals(up, merged)
  assert.deepEqual([top.mark, top.price, top.idx, top.time], ['G', 6, 3, 4])

  const down = candles([[8, 6], [6, 4], [5, 4.5], [5.5, 3], [6.5, 4]])
  const mDown = mergeCandles(down)
  assert.deepEqual(mDown.map((b) => [b.high, b.low]), [[8, 6], [5, 3], [6.5, 4]])
  assert.equal(mDown[1].highIdx, 2)
  assert.equal(mDown[1].lowIdx, 3)
  const [bottom] = findFractals(down, mDown)
  assert.deepEqual([bottom.mark, bottom.price, bottom.idx, bottom.time], ['D', 3, 3, 4])
})

test('equal extrema are inclusion, and the processed sequence has none left', () => {
  const raw = candles([[2, 0], [4, 2], [4, 3], [4, 3], [3, 1]])
  const { merged, fx: fractals } = analyze(raw)
  assert.deepEqual(merged.map((b) => [b.high, b.low]), [[2, 0], [4, 3], [3, 1]])
  assert.equal(fractals[0].idx, 1)
  for (let i = 1; i < merged.length; i++) assert.equal(hasInclusion(merged[i - 1], merged[i]), false)
})

test('strict old stroke requires one independent K between two complete three-K fractals', () => {
  const short = analyze(levels([1, 0, 1, 2, 3, 2]))
  assert.deepEqual(short.fx.map((p) => p.mi), [1, 4])
  assert.equal(short.points.length, 1)
  const valid = analyze(levels([1, 0, 1, 2, 3, 4, 3]))
  assert.deepEqual(valid.fx.map((p) => p.mi), [1, 5])
  assert.equal(valid.points.length, 2)
  assert.deepEqual(valid.points.map((p) => p.confirmed), [true, false])
  assert.equal(valid.points[1].idx, 5)
  assert.equal(valid.points[1].mi, 5)
})

test('extra raw candles swallowed by inclusion do not count as independent K', () => {
  const raw = levels([1, 0, 1, 2, 3, 2])
  raw.splice(4, 0, { high: 2.2, low: 1.8, time: 4.1 }, { high: 2.1, low: 1.9, time: 4.2 })
  const result = analyze(raw)
  assert.equal(result.fx[1].idx - result.fx[0].idx, 5)
  assert.equal(result.fx[1].mi - result.fx[0].mi, 3)
  assert.equal(result.points.length, 1)
})

test('legitimate small reversals are retained without any percent retracement absorption', () => {
  const points = [fx('D', 1, 0), fx('G', 5, 10), fx('D', 9, 9), fx('G', 13, 12)]
  assert.deepEqual(buildBi(points).map((p) => p.price), [0, 10, 9, 12])
})

test('same-type extrema extend the current candidate and equal extrema retain the earliest', () => {
  const input = [fx('D', 1, 0), fx('G', 5, 10), fx('G', 7, 12), fx('G', 9, 12), fx('D', 13, 2)]
  const points = buildBi(input)
  assert.deepEqual(points.map((p) => p.mi), [1, 7, 13])
  assert.deepEqual(points.map((p) => p.confirmed), [true, true, false])
})

test('top and bottom need valid interval ordering as well as opposite prices', () => {
  assert.equal(isStrictBi({ ...fx('D', 1, 4), high: 10 }, fx('G', 5, 9)), false)
  assert.equal(isStrictBi(fx('G', 1, 9), { ...fx('D', 5, 4), high: 10 }), false)
  // 第77课的端点区间条件只明确要求顶中心有部分高于底中心。
  // 不能另外把顶中心 low > 底中心 low 作为未经原文支持的独立规则。
  assert.equal(isStrictBi({ ...fx('D', 1, 2), high: 4 }, { ...fx('G', 5, 10), low: 0 }), true)
})

test('stroke endpoints must bound every merged candle, including unselected turns', () => {
  const endpoints = [fx('D', 1, 0), fx('G', 5, 10)]
  const merged = Array.from({ length: 7 }, () => ({ high: 9, low: 1 }))
  merged[1] = { high: 0.5, low: 0 }
  merged[5] = { high: 10, low: 9.5 }
  assert.equal(isStrictBi(...endpoints, merged), true)
  merged[3].high = 11
  assert.equal(isStrictBi(...endpoints, merged), false)
  merged[3] = { high: 9, low: -1 }
  assert.equal(isStrictBi(...endpoints, merged), false)
})

test('short reverse breakout retracts the invalid tail rather than leaving duplicated or nonextreme endpoints', () => {
  const input = [fx('D', 1, 0), fx('G', 5, 10), fx('D', 9, 4), fx('G', 13, 12), fx('D', 15, -1), fx('G', 19, 14)]
  const points = buildBi(input)
  assert.deepEqual(points.map((p) => p.mi), [15, 19])
  for (let i = 1; i < points.length; i++) assert.equal(isStrictBi(points[i - 1], points[i], undefined, input), true)
  assert.deepEqual(buildBi([fx('D', 1, 0), fx('G', 4, 3), fx('D', 6, -1)]).map((p) => p.mi), [6])
})
