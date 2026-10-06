/** 结构事实：完成笔、完成线段与线段中枢；不推测一二三类买卖点。 */

import { positionVsZs } from './zs.js'

const fmtP = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—')

function fmtDay(t) {
  if (typeof t === 'string') return t
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t * 1000 + 8 * 3600 * 1000)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '—'
}

/** 关键价旁标注实际提供该价格的结构端点时间。 */
function barTag(time, price) {
  return `${fmtDay(time)} @ ${fmtP(price)}`
}

function zsRangeText(zs) {
  if (!zs) return '尚未形成三个连续完成线段重叠的中枢'
  const status = zs.status === 'closed' ? '最近已结束的' : '最近确认的'
  return `${status}${zs.label || '线段中枢（本图最小级别）'} ` +
    `${fmtDay(zs.sdt)} ~ ${fmtDay(zs.edt)}（ZG ${fmtP(zs.zg)} / ZD ${fmtP(zs.zd)}）`
}

/** 笔端参考：每个完成笔端点转为一条结构参考。 */
export function buildTrades(biPoints = []) {
  return biPoints
    .map((p) => {
      const isTop = p.mark === 'G'
      return {
        time: p.time,
        price: p.price,
        side: isTop ? 'sell' : 'buy',
        kind: isTop ? 'BI_S' : 'BI_B',
        label: isTop ? '笔高' : '笔低',
        tier: 'bi_reference',
        price_basis: 'fx',
        level: 'bi',
        title: isTop ? '笔高参考' : '笔低参考',
        desc: isTop
          ? '完成笔端的顶分型，仅作结构定位，不是一二三类卖点'
          : '完成笔端的底分型，仅作结构定位，不是一二三类买点',
        side_cn: '结构参考',
        time_str: fmtDay(p.time),
        price_str: fmtP(p.price)
      }
    })
    .reverse()
}

/**
 * biPoints 仅为完成笔端点，segments 仅为已确认线段。
 * zsList 是三个连续完成线段构成的本图最小级别中枢，不能替代递归的同级别走势中枢。
 * 完整走势类型、趋势背驰及跨级别证据尚未计算，因此不确认买卖点。
 * 定义依据：缠中说禅《教你炒股票》第 17、20、21 课。
 */
export function buildOutlook({ candles = [], biPoints = [], zsList = [], segments = [], pendingBi = [], close, period = 'day' }) {
  const n = biPoints.length
  if (n < 2 || !candles.length) {
    return { ok: false, asof: candles.length ? candles[candles.length - 1].time : 0, period }
  }

  const referenceZs = zsList.length ? zsList[zsList.length - 1] : null
  const lastA = biPoints[n - 2]
  const lastB = biPoints[n - 1]
  const lastDir = lastB.price > lastA.price ? 'up' : 'down'
  const lastDirCn = lastDir === 'up' ? '向上' : '向下'
  const highPt = lastA.price >= lastB.price ? lastA : lastB
  const lowPt = lastA.price <= lastB.price ? lastA : lastB
  const completedSegments = segments.filter((segment) => segment.confirmed === true)
  const lastSegment = completedSegments.at(-1)
  const segmentFact = lastSegment
    ? `已确认线段 ${completedSegments.length} 段，最新一段${lastSegment.direction === 'up' ? '向上' : '向下'}（${fmtDay(lastSegment.start.time)} ~ ${fmtDay(lastSegment.end.time)}）`
    : '尚无已确认线段'
  const pendingFact = pendingBi.length >= 2 ? '；当前虚线笔尚未完成，不参与已完成结构' : ''
  const pos = positionVsZs(close, referenceZs)
  const zsText = zsRangeText(referenceZs)
  const vsLabel = referenceZs ? `${pos.label}（${zsText}）` : '无已确认线段中枢'
  const structureFact =
    `最新完成笔方向：${lastDirCn}；${segmentFact}${pendingFact}。` +
    `现价 ${fmtP(close)}，${vsLabel}。`
  const evidenceLimit =
    '一类买卖点需要相应级别趋势背驰及次级别证据；二类买卖点依赖已确认的一类买卖点及其后首次次级别回调或反抽；' +
    '三类买点需要次级别走势类型向上离开中枢后，首次次级别回试完成且低点不跌破 ZG；三类卖点对称地要求向下离开后首次次级别回抽完成且高点不升破 ZD。' +
    '本实现未计算这些走势类型、背驰和跨级别证据，不确认一、二、三类买卖点。'
  const observation = referenceZs
    ? `${zsText}由三个连续完成线段的重叠区间确定，后续延伸保持初始 ZG/ZD。现价位于中枢${pos.vs === 'above' ? '上方' : pos.vs === 'below' ? '下方' : '内部'}只描述位置。`
    : '完成线段不足或三个连续完成线段没有有效重叠，当前不绘制中枢；完成笔端仅作结构定位。'
  const biasNote = '中性结构记录；完成笔方向和现价相对中枢的位置不构成买卖点确认。'

  return {
    ok: true,
    asof: candles[candles.length - 1].time,
    period,
    conclusion: {
      kind_hint: 'STRUCTURE',
      is_hypothesis: false,
      status: 'structure',
      status_label: '结构记录',
      title: '缠论结构',
      side: 'neutral',
      bias: '中性',
      bias_note: biasNote,
      structure_fact: structureFact,
      observation,
      observation_basis: '仅依据完成笔、已确认线段及本图最小级别线段中枢记录结构事实。',
      trigger_condition: evidenceLimit,
      action_hint: evidenceLimit,
      invalidation: '现价穿越 ZG/ZD 只改变相对位置；中枢延伸或结束由后续完成线段判定，未完成笔不用于确认。',
      confirmed_signal: null,
      latest_signal: null,
      summary: `${structureFact} ${evidenceLimit}`
    },
    scenarios: [],
    levels: {
      close,
      last_bi_high: highPt.price,
      last_bi_low: lowPt.price,
      last_bi_high_bar: barTag(highPt.time, highPt.price),
      last_bi_low_bar: barTag(lowPt.time, lowPt.price),
      last_bi_direction: lastDir,
      completed_segment_count: completedSegments.length,
      last_segment_direction: lastSegment?.direction ?? null,
      last_segment_start: lastSegment ? fmtDay(lastSegment.start.time) : null,
      last_segment_end: lastSegment ? fmtDay(lastSegment.end.time) : null,
      zs_zg: referenceZs?.zg ?? null,
      zs_zd: referenceZs?.zd ?? null,
      active_zs_id: referenceZs?.id ?? null,
      zs_algorithm: referenceZs?.algorithm ?? null,
      zs_segment_count: referenceZs?.segment_count ?? null,
      zs_level: referenceZs?.level ?? null,
      zs_status: referenceZs?.status ?? null,
      zs_zg_bar: referenceZs ? barTag(referenceZs.zg_time, referenceZs.zg) : null,
      zs_zd_bar: referenceZs ? barTag(referenceZs.zd_time, referenceZs.zd) : null,
      zs_range: zsText,
      vs_zs: pos.vs,
      vs_zs_label: vsLabel,
      bias: '中性',
      bias_note: biasNote
    },
    disclaimer: '本图仅计算完成笔、已确认线段与本图最小级别的线段中枢，未递归计算各级别走势类型、背驰及一二三类买卖点。'
  }
}
