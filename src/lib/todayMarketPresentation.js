function validSessionDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

// Session labels come from the quotation date. Fetch time and the viewer's timezone
// cannot establish a trading session, including holidays and pre-market hours.
export function todayMarketPresentation(payload, now = Date.now()) {
  const date = validSessionDate(payload?.date) ? payload.date : "—";
  const previousDate = validSessionDate(payload?.previousDate) && payload.previousDate < date
    ? payload.previousDate : null;
  const timestamp = new Date(now).getTime();
  const beijingDate = Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) : null;
  const sessionNotice = date !== "—" && beijingDate && date < beijingDate
    ? `当前展示最近可用交易日 ${date} 的盘面；非交易日或开盘前继续展示该交易日快照。`
    : null;
  const previousLabel = previousDate || "前一交易日";
  let premiumUnavailableMessage;
  if (!previousDate) {
    premiumUnavailableMessage = `前一交易日尚未确定，无法计算 ${date} 的接力溢价。`;
  } else if (payload.poolAvailability?.previousZt !== true) {
    premiumUnavailableMessage = `${previousLabel} 的涨停池暂不可用，无法计算 ${date} 的接力溢价。`;
  } else if (payload.premiumCoverage?.expected === 0) {
    premiumUnavailableMessage = `${previousDate} 无涨停股票，${date} 暂无接力溢价样本。`;
  } else if (payload.premiumCoverage?.expected > 0 && payload.premiumCoverage.quoted === 0) {
    premiumUnavailableMessage = `${previousDate} 涨停股票在 ${date} 暂无可用报价，无法计算接力溢价。`;
  } else {
    premiumUnavailableMessage = `${previousDate} 涨停样本或 ${date} 相关报价暂不可用，无法计算接力溢价。`;
  }
  return {
    date,
    previousDate,
    sessionNotice,
    premiumExtra: previousDate ? `${previousDate} → ${date}` : "接力溢价",
    premiumUnavailableMessage,
    unavailableMessage: `${date} 的涨停、跌停或炸板池暂不可用，无法计算该指标。`,
    historyUnavailableMessage: `${date}：该交易日历史曲线暂无数据。`,
  };
}
