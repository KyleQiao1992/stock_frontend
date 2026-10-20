// Risk returns use actual daily trading reference prices. A raw previous close
// is not comparable across an ex-rights/ex-dividend date (SSE 4.3.2–4.3.3).
function number(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  return typeof value === "string" && !value.trim() ? NaN : Number(value);
}

function validateRows(rows) {
  if (!rows.length) throw new Error("没有有效的日K交易记录");
  const dates = new Set();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !(row.close > 0)
      || !Number.isFinite(row.close) || !Number.isFinite(row.volume) || row.volume < 0
      || dates.has(row.date)) throw new Error("日K日期、价格或成交量异常");
    dates.add(row.date);
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseEastmoneyDailyKline(payload, { isIndex = false } = {}) {
  const source = payload?.data;
  if (!Array.isArray(source?.klines)) throw new Error("东财未返回不复权日K");
  const rows = validateRows(source.klines.map(value => {
    const fields = String(value).split(",");
    const close = number(fields[2]);
    const change = number(fields[9]);
    const volume = number(fields[5]);
    const referenceClose = close - change;
    // f60 (change) retains the price tick; f59 (pct) is rounded to 0.01%.
    // On ex-dates f60 is relative to the ex-rights reference, not yesterday's raw close.
    if (!isIndex && volume > 0 && (!(referenceClose > 0) || !Number.isFinite(referenceClose))) {
      throw new Error(`东财日K缺少有效涨跌额/参考前收价：${fields[0]}`);
    }
    const pct = number(fields[8]);
    if (!isIndex && volume > 0 && (!Number.isFinite(pct)
      || Math.abs((close / referenceClose - 1) * 100 - pct) > 0.006)) {
      throw new Error(`东财日K涨跌额与涨跌幅不一致：${fields[0]}`);
    }
    return { date: fields[0], close, referenceClose, volume };
  })).filter(row => isIndex || row.volume > 0);
  return { name: source.name || "", rows };
}

function corporateAction(event) {
  const date = String(event.cqr || "");
  const content = String(event.FHcontent || "").replace(/\s+/g, "");
  const match = /^(\d+(?:\.\d+)?)(.*)$/.exec(content);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !match || !(+match[1] > 0)) {
    throw new Error(`腾讯除权事件无法确认：${date} ${content}`);
  }
  let remaining = match[2], cash = 0, shares = 0, count = 0;
  while (remaining) {
    const token = /^(派|送|转增|转)(\d+(?:\.\d+)?)(元|股)/.exec(remaining);
    if (!token || (token[1] === "派") !== (token[3] === "元")) {
      throw new Error(`腾讯除权参考价暂不支持该分配方案：${date} ${content}`);
    }
    if (token[1] === "派") cash += +token[2] / +match[1];
    else shares += +token[2] / +match[1];
    remaining = remaining.slice(token[0].length);
    count += 1;
  }
  if (!count) throw new Error(`腾讯除权事件缺少分配信息：${date}`);
  return { date, content, cash, shares };
}

export function parseTencentDailyKline(payload, symbol, { isIndex = false } = {}) {
  const source = payload?.data?.[symbol];
  // Never silently mix qfqday with raw day. Corporate-action metadata belongs
  // to the unadjusted series; applying it to qfq prices would adjust twice.
  if (payload?.code !== 0 || !Array.isArray(source?.day)) throw new Error("腾讯未返回不复权日K（day）");
  const raw = validateRows(source.day.map(row => ({
    date: String(row[0]), close: number(row[2]), volume: number(row[5]),
  })));
  if (isIndex) return { name: "", rows: raw };

  const firstDate = raw[0].date;
  const lastDate = raw.at(-1).date;
  const byDate = new Map();
  for (const row of source.day) for (const event of row.slice(6)) {
    if (!event || typeof event !== "object" || (!event.cqr && !event.FHcontent)) continue;
    // No reference price is needed for the first row or beyond this snapshot.
    if (event.cqr && (String(event.cqr) <= firstDate || String(event.cqr) > lastDate)) continue;
    const parsed = corporateAction(event);
    if (byDate.has(parsed.date) && byDate.get(parsed.date).content !== parsed.content) {
      throw new Error(`腾讯除权事件冲突：${parsed.date}`);
    }
    byDate.set(parsed.date, parsed);
  }
  const events = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const rows = raw.filter(row => row.volume > 0).map((row, i, trading) => {
    const previous = trading[i - 1];
    if (!previous) return { ...row, referenceClose: null };
    let referenceClose = previous.close;
    for (const event of events) if (event.date > previous.date && event.date <= row.date) {
      referenceClose = (referenceClose - event.cash) / (1 + event.shares);
      // A-share trading reference prices are quoted at the CNY 0.01 tick.
      // Correct floating-point noise at half a tick (e.g. 10.075 -> 10.08).
      const ticks = referenceClose * 100;
      referenceClose = Math.round(ticks + Number.EPSILON * Math.max(1, Math.abs(ticks)) * 4) / 100;
    }
    if (!(referenceClose > 0)) throw new Error(`腾讯除权参考前收价异常：${row.date}`);
    return { ...row, referenceClose };
  });
  const quote = source.qt?.[symbol];
  const quoteDay = String(quote?.[30] || "").slice(0, 8);
  const latest = rows.at(-1);
  if (latest?.referenceClose && quoteDay === latest.date.replaceAll("-", "")) {
    const quotedReference = number(quote?.[4]);
    if (!(quotedReference > 0) || Math.abs(quotedReference - latest.referenceClose) > 0.005) {
      throw new Error(`腾讯日K参考前收价与同日报价不一致：${latest.date}`);
    }
  }
  return { name: quote?.[1] || "", rows };
}

// With no corporate action, the daily factors telescope to end/startPrev.
// Around an action, referenceClose removes the mechanical price drop. Use the
// index's matching endpoints so suspended stock dates do not drop index moves.
export function cumDeviation(rows, idxByDate, n, endIndex = rows.length - 1) {
  if (endIndex < n) return null;
  const end = rows[endIndex], startPrev = rows[endIndex - n];
  const idxEnd = idxByDate.get(end.date), idxStartPrev = idxByDate.get(startPrev.date);
  if (!(idxEnd > 0) || !(idxStartPrev > 0) || !Number.isFinite(idxEnd) || !Number.isFinite(idxStartPrev)) return null;
  let growth = 1;
  for (let i = endIndex - n + 1; i <= endIndex; i += 1) {
    const { close, referenceClose } = rows[i];
    if (!(close > 0) || !(referenceClose > 0) || !Number.isFinite(close) || !Number.isFinite(referenceClose)) return null;
    growth *= close / referenceClose;
  }
  return (growth - idxEnd / idxStartPrev) * 100;
}

// Inspect every suffix allowed by “within N trading sessions”. Asymmetric
// thresholds require comparison by the fraction of the applicable threshold,
// so a −60% move outranks +70% against a +100%/−50% rule.
export function deviationWindow(rows, idxByDate, maxDays, { up, down }, endIndex = rows.length - 1) {
  let strongest = null;
  for (let days = 1; days <= maxDays; days += 1) {
    const deviation = cumDeviation(rows, idxByDate, days, endIndex);
    if (!Number.isFinite(deviation)) return null;
    const severity = deviation / (deviation >= 0 ? up : down);
    if (!strongest || severity > strongest.severity) {
      strongest = { days, deviation, severity };
    }
  }
  return strongest;
}

export function abnormalWindow(rows, idxByDate, endIndex = rows.length - 1) {
  return deviationWindow(rows, idxByDate, 3, { up: 1, down: -1 }, endIndex);
}

export function severityReached(window, ratio = 1) {
  // At the largest configured threshold this tolerates only 2e-9 percentage
  // points, covering binary floating noise without rounding displayed prices.
  return window.severity + 1e-11 >= ratio;
}

export function abnormalDirection(deviation, threshold) {
  // Exact decimal boundaries such as (1.2 - 0.9) * 100 can fall just below
  // 30 in binary floating point. This tolerance is only a billionth of a point.
  if (Math.abs(deviation) + 1e-9 < threshold) return 0;
  return deviation >= 0 ? 1 : -1;
}

// This retains the documented rising-edge approximation; exchange publication
// dates and the official post-announcement reset are not available here.
export function countSameDirAbnormal(rows, idxByDate, threshold, windowDays) {
  let up = 0, down = 0;
  const from = Math.max(3, rows.length - windowDays);
  const dirAt = i => {
    if (i < 3) return 0;
    const window = abnormalWindow(rows, idxByDate, i);
    if (!window) throw new Error("同向异波窗口参考前收价或同期指数数据缺失，无法计数");
    const { deviation } = window;
    return abnormalDirection(deviation, threshold);
  };
  let previous = dirAt(from - 1);
  for (let i = from; i < rows.length; i += 1) {
    const current = dirAt(i);
    if (current && current !== previous) {
      if (current > 0) up += 1;
      else down += 1;
    }
    previous = current;
  }
  return Math.max(up, down);
}
