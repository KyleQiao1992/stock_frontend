// Lesson 82 gives qualitative candle descriptions, not numeric thresholds.
// These configurable thresholds are application rules, not quotations.
export const TOP_FRACTAL_THRESHOLDS = Object.freeze({
  longBodyRatio: 0.6,
  smallBodyRatio: 0.5,
  upperShadowRatio: 0.5,
});

export const TOP_FRACTAL_LABELS = Object.freeze({
  continuation: '中继倾向',
  strong: '力度较大顶分型',
  relativeHigh: '相对高点特征',
});

export function topFractalTraitDescription(traits) {
  if (!traits?.applicable || !traits.primary) return '';
  const reasons = {
    continuation: '第一根阳线满足软件实体占比条件，第二、三根为非零小阴或小阳；符合延续此前的上涨方向的软件候选形态。',
    strong: '第二根满足软件长上影占比或阴线实体占比条件，第三根未以阳线收在第二根高低区间中点之上；符合向下成笔倾向的软件候选形态。',
    relativeHigh: '第三根跌破第一根最低价，且收盘未超过第一根高低区间中点；相对高点特征较强。',
  };
  const { longBodyRatio, smallBodyRatio, upperShadowRatio } = traits.thresholds;
  const otherMatches = Object.keys(traits.matches).filter((key) => traits.matches[key] && key !== traits.primary);
  const overlap = otherMatches.length ? `同时符合${otherMatches.map((key) => TOP_FRACTAL_LABELS[key]).join('、')}，按展示规则优先显示。` : '';
  const thresholdNote = traits.primary === 'relativeHigh'
    ? '本项软件识别规则不使用长短阈值：跌破不含触及，中点取第一根最高与最低价的平均值。'
    : `软件识别阈值（实现约定）：实体占本K振幅至少${longBodyRatio * 100}%；非零小实体不超过首K实体${smallBodyRatio * 100}%；`
      + `上影占振幅至少${upperShadowRatio * 100}%且不短于实体。这些比例仅描述软件占比特征，不能证实真实绝对长K；这些数值不是原文规定。`;
  return `${reasons[traits.primary]}仅依据这三根K线，未使用后续行情，仍需后续走势验证。${overlap}${thresholdNote}`;
}

export function classifyTopFractal(detail, thresholds = TOP_FRACTAL_THRESHOLDS) {
  if (detail.mark !== 'G') return { applicable: false, reason: 'bottom' };
  if (!Array.isArray(detail.rawCandles) || detail.rawCandles.length < 3 || Array.from(detail.rawCandles).some((bar) => !bar
    || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close))) {
    return { applicable: false, reason: 'invalid-ohlc' };
  }
  if (detail.mergedCandles.some((bar) => bar.sources.length !== 1) || detail.rawCandles.length !== 3) {
    return { applicable: false, reason: 'inclusion' };
  }
  const [first, middle, last] = detail.rawCandles;
  const top = middle.high > first.high && middle.high > last.high
    && middle.low > first.low && middle.low > last.low;
  if (!top) return { applicable: false, reason: 'not-top' };

  const body = (bar) => Math.abs(bar.close - bar.open);
  const range = (bar) => bar.high - bar.low;
  const longBody = (bar) => range(bar) > 0 && body(bar) / range(bar) >= thresholds.longBodyRatio;
  const longBull = first.close > first.open && longBody(first);
  const smallMiddle = body(middle) > 0 && body(middle) <= body(first) * thresholds.smallBodyRatio;
  const smallLast = body(last) > 0 && body(last) <= body(first) * thresholds.smallBodyRatio;
  const upperShadow = middle.high - Math.max(middle.open, middle.close);
  const longUpperShadow = range(middle) > 0 && upperShadow / range(middle) >= thresholds.upperShadowRatio
    && upperShadow >= body(middle);
  const longBear = middle.close < middle.open && longBody(middle);
  const firstMidpoint = (first.high + first.low) / 2;
  const middleMidpoint = (middle.high + middle.low) / 2;
  // Lesson 82 negates the combined condition: bullish AND above halfway.
  const lastBull = last.close > last.open;
  const failedMiddleRecovery = !(lastBull && last.close > middleMidpoint);
  const failedFirstRecovery = last.close <= firstMidpoint;
  const brokeFirstLow = last.low < first.low;
  const matches = {
    continuation: longBull && smallMiddle && smallLast,
    strong: (longUpperShadow || longBear) && failedMiddleRecovery,
    relativeHigh: brokeFirstLow && failedFirstRecovery,
  };
  return {
    applicable: true,
    // Patterns may overlap; this is display priority, not statistical confidence.
    matches,
    primary: matches.relativeHigh ? 'relativeHigh' : matches.strong ? 'strong' : matches.continuation ? 'continuation' : null,
    thresholds: { ...thresholds },
    evidence: { longBull, smallMiddle, smallLast, longUpperShadow, longBear, brokeFirstLow,
      lastBull, failedMiddleRecovery, failedFirstRecovery, firstMidpoint, middleMidpoint,
      firstLow: first.low, lastLow: last.low, lastClose: last.close },
  };
}
