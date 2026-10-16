import { classifyTopFractal, TOP_FRACTAL_THRESHOLDS } from './topFractalTraits.js';

export const BOTTOM_FRACTAL_THRESHOLDS = Object.freeze({
  longBodyRatio: TOP_FRACTAL_THRESHOLDS.longBodyRatio,
  smallBodyRatio: TOP_FRACTAL_THRESHOLDS.smallBodyRatio,
  lowerShadowRatio: TOP_FRACTAL_THRESHOLDS.upperShadowRatio,
});

export const BOTTOM_FRACTAL_LABELS = Object.freeze({
  continuation: '中继倾向',
  strong: '力度较大底分型',
  relativeLow: '相对低点特征',
});

/** Price reflection makes the bottom rules exactly symmetric to the top rules. */
export function classifyBottomFractal(detail, thresholds = BOTTOM_FRACTAL_THRESHOLDS) {
  if (detail.mark !== 'D') return { applicable: false, reason: 'top' };
  if (!Array.isArray(detail.rawCandles) || detail.rawCandles.length < 3 || Array.from(detail.rawCandles).some((bar) => !bar
    || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close))) {
    return { applicable: false, reason: 'invalid-ohlc' };
  }
  const reflected = classifyTopFractal({ ...detail, mark: 'G', rawCandles: detail.rawCandles.map((candle) => ({
    ...candle, open: -candle.open, high: -candle.low, low: -candle.high, close: -candle.close,
  })) }, { longBodyRatio: thresholds.longBodyRatio, smallBodyRatio: thresholds.smallBodyRatio,
    upperShadowRatio: thresholds.lowerShadowRatio });
  if (!reflected.applicable) return { ...reflected,
    reason: reflected.reason === 'not-top' ? 'not-bottom' : reflected.reason };
  const evidence = reflected.evidence;
  return {
    applicable: true,
    matches: { continuation: reflected.matches.continuation, strong: reflected.matches.strong,
      relativeLow: reflected.matches.relativeHigh },
    primary: reflected.primary === 'relativeHigh' ? 'relativeLow' : reflected.primary,
    thresholds: { ...thresholds },
    evidence: {
      longBear: evidence.longBull, smallMiddle: evidence.smallMiddle, smallLast: evidence.smallLast,
      longLowerShadow: evidence.longUpperShadow, longBull: evidence.longBear,
      brokeFirstHigh: evidence.brokeFirstLow, lastBear: evidence.lastBull,
      failedMiddleDrop: evidence.failedMiddleRecovery, failedFirstDrop: evidence.failedFirstRecovery,
      firstMidpoint: -evidence.firstMidpoint, middleMidpoint: -evidence.middleMidpoint,
      firstHigh: -evidence.firstLow, lastHigh: -evidence.lastLow, lastClose: -evidence.lastClose,
    },
  };
}

export function bottomFractalTraitDescription(traits) {
  if (!traits?.applicable || !traits.primary) return '';
  const reasons = {
    continuation: '第一根阴线满足软件实体占比条件，第二、三根为非零小阴或小阳；符合延续此前的下跌方向的软件候选形态。',
    strong: '第二根满足软件长下影占比或阳线实体占比条件，第三根未以阴线收在第二根高低区间中点之下；符合向上成笔倾向的软件候选形态。',
    relativeLow: '第三根突破第一根最高价，且收盘不低于第一根高低区间中点；相对低点特征较强。',
  };
  const { longBodyRatio, smallBodyRatio, lowerShadowRatio } = traits.thresholds;
  const otherMatches = Object.keys(traits.matches).filter((key) => traits.matches[key] && key !== traits.primary);
  const overlap = otherMatches.length ? `同时符合${otherMatches.map((key) => BOTTOM_FRACTAL_LABELS[key]).join('、')}，按展示规则优先显示。` : '';
  const thresholdNote = traits.primary === 'relativeLow'
    ? '本项软件识别规则不使用长短阈值：突破不含触及，中点取第一根最高与最低价的平均值。'
    : `软件识别阈值（实现约定）：实体占本K振幅至少${longBodyRatio * 100}%；非零小实体不超过首K实体${smallBodyRatio * 100}%；`
      + `下影占振幅至少${lowerShadowRatio * 100}%且不短于实体。这些比例仅描述软件占比特征，不能证实真实绝对长K；这些数值不是原文规定。`;
  return `${reasons[traits.primary]}仅依据这三根K线，未使用后续行情，仍需后续走势验证。${overlap}${thresholdNote}`;
}
