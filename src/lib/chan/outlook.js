/** 结构研判：由笔与中枢推导结论、三情景与关键位 */

import { positionVsZs } from './zs.js'

const fmtP = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—')

function fmtDay(t) {
  if (typeof t === 'string') return t
  const d = new Date(t * 1000 + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

/** "2026-08-14 @ 3903.70" —— 关键价旁标注对应 K 线时间 */
function barTag(time, price) {
  return `${fmtDay(time)} @ ${fmtP(price)}`
}

function zsRangeText(zs) {
  if (!zs) return '无参考中枢'
  return `当前参考中枢 ${fmtDay(zs.sdt)} ~ ${fmtDay(zs.edt)}（ZG ${fmtP(zs.zg)} / ZD ${fmtP(zs.zd)}）`
}

/** 笔端参考：每个笔端点转为一条结构参考（明确不是买卖点） */
export function buildTrades(biPoints) {
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
 * 生成研判。
 * biPoints 为已确认笔端点（不含当前动态点），zsList 为中枢，close 为现价。
 */
export function buildOutlook({ candles, biPoints, zsList, close, period = 'day' }) {
  const n = biPoints.length
  if (n < 2 || !candles.length) {
    return { ok: false, asof: candles.length ? candles[candles.length - 1].time : 0, period }
  }

  const activeZs = zsList.length ? zsList[zsList.length - 1] : null
  const lastA = biPoints[n - 2]
  const lastB = biPoints[n - 1]
  const lastDir = lastB.price > lastA.price ? 'up' : 'down'
  const lastDirCn = lastDir === 'up' ? '向上' : '向下'

  // 末笔高低：取最后一笔两端
  const lastHigh = Math.max(lastA.price, lastB.price)
  const lastLow = Math.min(lastA.price, lastB.price)
  const highPt = lastA.price >= lastB.price ? lastA : lastB
  const lowPt = lastA.price <= lastB.price ? lastA : lastB

  const pos = positionVsZs(close, activeZs)
  const zsText = zsRangeText(activeZs)
  const vsLabel = activeZs ? `${pos.label}（${zsText}）` : '无参考中枢'

  // 结论：末笔方向 + 相对中枢位置 → 观察倾向
  let kindHint
  let title
  let side
  let bias
  if (lastDir === 'down') {
    if (pos.vs === 'below') {
      kindHint = 'B1'
      title = '一类买点观察'
      side = 'buy'
      bias = '偏空'
    } else {
      kindHint = 'B2'
      title = '二类买点观察'
      side = 'buy'
      bias = '偏多'
    }
  } else if (pos.vs === 'above') {
    kindHint = 'B3'
    title = '三类买点观察'
    side = 'buy'
    bias = '偏多'
  } else {
    kindHint = 'S2'
    title = '二类卖点观察'
    side = 'sell'
    bias = '偏空'
  }

  const biasNote =
    `结构偏向${title.replace('观察', '')}，现价 ${fmtP(close)} 位于${vsLabel}；` +
    `当前不是确认买点，倾向观望并等待触发条件。`

  const structureFact =
    `最新完成笔方向：${lastDirCn}；现价 ${fmtP(close)}，${vsLabel}。`

  let observation = '近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 '
  if (lastDir === 'down') {
    observation +=
      `末笔向下后进入中枢震荡，偏二买观察：回调不破前低则可酝酿二买。 ` +
      `前低参考K：${barTag(lowPt.time, lowPt.price)}。`
  } else {
    observation +=
      `末笔向上后关注能否站稳关键位：站稳则延续，受阻则回落。 ` +
      `前高参考K：${barTag(highPt.time, highPt.price)}。`
  }
  if (activeZs) observation += `参考${zsText}。`

  const invalidation = activeZs
    ? `若收盘${side === 'buy' ? '跌破' : '升破'}末笔${side === 'buy' ? '低点' : '高点'} ` +
      `${fmtP(side === 'buy' ? lastLow : lastHigh)} 或当前参考中枢${side === 'buy' ? '下沿' : '上沿'} ` +
      `${fmtP(side === 'buy' ? activeZs.zd : activeZs.zg)}，当前${bias}观察失效。`
    : `若收盘跌破末笔低点 ${fmtP(lastLow)}，当前${bias}观察失效。`

  const levels = {
    close,
    last_bi_high: lastHigh,
    last_bi_low: lastLow,
    last_bi_high_bar: barTag(highPt.time, highPt.price),
    last_bi_low_bar: barTag(lowPt.time, lowPt.price),
    zs_zg: activeZs ? activeZs.zg : null,
    zs_zd: activeZs ? activeZs.zd : null,
    active_zs_id: activeZs ? activeZs.id : null,
    zs_algorithm: activeZs ? activeZs.algorithm : null,
    zs_bi_count: activeZs ? activeZs.bi_count : null,
    zs_zg_bar: activeZs ? barTag(activeZs.sdt, activeZs.zg) : null,
    zs_zd_bar: activeZs ? barTag(activeZs.edt, activeZs.zd) : null,
    zs_range: zsText,
    vs_zs: pos.vs,
    vs_zs_label: vsLabel,
    bias,
    bias_note: biasNote
  }

  return {
    ok: true,
    asof: candles[candles.length - 1].time,
    period,
    conclusion: {
      kind_hint: kindHint,
      is_hypothesis: true,
      status: 'forming',
      status_label: '结构形成中',
      title,
      side,
      bias,
      bias_note: biasNote,
      structure_fact: structureFact,
      observation,
      observation_basis:
        '依据最新完成笔方向、未完成段方向与现价相对当前参考中枢的位置推断；不是已确认信号。',
      trigger_condition:
        side === 'buy'
          ? '等待回调结束且不破前低，并由转强 K 触发二买信号。'
          : '等待反弹结束且不破前高，并由转弱 K 触发二卖信号。',
      action_hint: biasNote,
      invalidation,
      confirmed_signal: null,
      latest_signal: null,
      summary: observation
    },
    scenarios: buildScenarios({ close, activeZs, pos, highPt, lowPt, lastHigh, lastLow, zsText }),
    levels,
    disclaimer:
      '评分满分 10 分，依当前结构吻合度赋分；关键价旁标注对应 K 线时间。分支情景而非预言，不构成投资建议。'
  }
}

/** 三情景：强势上行 / 中枢震荡 / 转弱破位，按现价相对中枢的位置赋分 */
function buildScenarios({ close, activeZs, pos, highPt, lowPt, lastHigh, lastLow, zsText }) {
  const zg = activeZs ? activeZs.zg : null
  const zd = activeZs ? activeZs.zd : null
  const zgBar = activeZs ? fmtDay(activeZs.sdt) : '—'
  const zdBar = activeZs ? fmtDay(activeZs.edt) : '—'
  const hiBar = barTag(highPt.time, highPt.price)
  const loBar = barTag(lowPt.time, lowPt.price)

  // 中枢内部→震荡分最高；上方→强势分最高；下方→破位分最高
  const score =
    pos.vs === 'above'
      ? { A: 8, B: 6, C: 3 }
      : pos.vs === 'below'
        ? { A: 3, B: 5, C: 8 }
        : { A: 6, B: 8, C: 4 }

  return [
    {
      id: 'A',
      name: '强势上行',
      score: score.A,
      score_max: 10,
      bias: '偏多',
      explain:
        '末笔转强、站稳关键位则多头延续；对应二买/三买跟随，偏向做多。 ' +
        `关键位锚定：${zsText}。`,
      condition: `向上笔延续，收盘站稳前高附近（关注中枢上沿 ${fmtP(zg)}，中枢起始：${zgBar}）`,
      path: '底分确认 → 向上笔离开震荡区 → 回踩不破关键位',
      next_points: [
        {
          kind: 'B2',
          title: '二类买点',
          trigger: `回调低点不低于前低（${fmtP(lastLow)}，前低K：${loBar}）`,
          action: '回踩结束转强时可做多/加仓观察',
          hypothetical: true
        },
        {
          kind: 'B3',
          title: '三类买点',
          trigger: `突破中枢后回踩不跌破上沿（${fmtP(zg)}，中枢起始：${zgBar}）；中枢区间见 ${zsText}`,
          action: '三买确认后趋势跟随，跌破则退出',
          hypothetical: true
        }
      ],
      invalid: `收盘跌破前低（${fmtP(lastLow)}，前低K：${loBar}），强势情景失效`
    },
    {
      id: 'B',
      name: '中枢震荡',
      score: score.B,
      score_max: 10,
      bias: '中性',
      explain:
        '价格在中枢内来回，上沿偏空减仓、下沿偏多轻仓，不宜单边追涨杀跌。 ' +
        `震荡箱体：${zsText}。`,
      condition: `价格围绕中枢上下沿来回（下沿 ${fmtP(zd)}，中枢结束：${zdBar} ~ 上沿 ${fmtP(zg)}，中枢起始：${zgBar}）`,
      path: '不形成明确离开段 → 中枢扩展/新生 → 等待方向选择',
      next_points: [
        {
          kind: 'B2',
          title: '二类买点（中枢下沿）',
          trigger: `回落至中枢下沿附近止跌，且不破前低（下沿 ${fmtP(zd)}，中枢结束：${zdBar}；前低 ${fmtP(lastLow)}，前低K：${loBar}）`,
          action: '仅中枢下沿短线博弈，仓位宜轻',
          hypothetical: true
        },
        {
          kind: 'S2',
          title: '二类卖点（中枢上沿）',
          trigger: `反弹至中枢上沿受压，且不破前高（上沿 ${fmtP(zg)}，中枢起始：${zgBar}；前高 ${fmtP(lastHigh)}，前高K：${hiBar}）`,
          action: '中枢上沿减仓/观望，避免中枢内追涨',
          hypothetical: true
        }
      ],
      invalid: '放量单边离开中枢并收盘站稳外侧，震荡情景让位于趋势情景'
    },
    {
      id: 'C',
      name: '转弱破位',
      score: score.C,
      score_max: 10,
      bias: '偏空',
      explain: '买点失效、跌破关键低/中枢下沿，结构转向防守；先止损观望，勿摊平。',
      condition: `跌破关键低点（${fmtP(lastLow)}，前低K：${loBar}） 或中枢下沿（${fmtP(zd)}，中枢结束：${zdBar}）`,
      path: '买点失效 → 向下笔加速 → 寻找更低级别/新的一买',
      next_points: [
        {
          kind: 'S1',
          title: '一类卖点（防守）',
          trigger: `向上反抽无力且再破前低，视为结构转弱（前低 ${fmtP(lastLow)}，前低K：${loBar}）`,
          action: '多单止损/空仓等待，不在下跌中继抄底',
          hypothetical: true
        },
        {
          kind: 'B1',
          title: '新的一类买点',
          trigger: '更低位置出现底背驰/向下笔结束（需新的确认K，非当前信号K）',
          action: '原买点作废，重置为一买观察，勿摊平',
          hypothetical: true
        }
      ],
      invalid: `快速收回并站回 ${fmtP(close)}上方，破位情景解除`
    }
  ]
}
