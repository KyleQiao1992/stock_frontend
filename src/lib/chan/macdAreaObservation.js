/**
 * Discrete, sign-separated sums of caller-supplied MACD histogram samples.
 * This is a numeric observation, not trend-strength from lesson 15, a trend
 * classification, divergence, a completed movement, or a trading signal.
 *
 * The chart currently calculates hist = 2 * (DIF - DEA), with 12/26/9 EMA and
 * first-value initialization. This module does not recalculate or verify that
 * formula, the source, the price adjustment, the trading calendar, or the full
 * preceding history. The caller must use one consistent basis for both spans.
 * Lesson 24 motivates histogram area as an auxiliary observation only:
 * https://blog.sina.com.cn/s/blog_486e105c0100087y.html
 *
 * Time is a one-based index into this exact supplied series. Missing K lines
 * before they were numbered cannot be detected here. No future bar is read.
 */
export function observeMacdAreas({ basis, bars, asOfTime, windows } = {}) {
  if (typeof basis !== 'string' || !basis.trim()) throw new TypeError('source basis is required');
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array');
  if (!Number.isSafeInteger(asOfTime) || asOfTime < 1 || asOfTime > bars.length) {
    throw new RangeError('asOfTime must identify an observed bar');
  }
  if (!windows || typeof windows !== 'object' || !windows.a || !windows.c) throw new TypeError('two observation windows are required');
  for (const window of [windows.a, windows.c]) {
    if (window.basis !== basis) throw new RangeError('window basis must match the caller-supplied source basis');
    if (![window.start, window.end].every(value => Number.isSafeInteger(value) && value >= 1)
        || window.start > window.end) throw new RangeError('invalid window bounds');
    if (window.end > asOfTime) throw new RangeError('window cannot include a future unobserved bar');
  }
  if (windows.a.end >= windows.c.start) throw new RangeError('observation windows must be ordered and nonoverlapping');

  // Validate the observed numbering, including an observed successor used to
  // establish closure; never traverse a future suffix of the supplied array.
  for (let i = 0; i < asOfTime; i++) {
    const bar = bars[i];
    if (!bar || bar.time !== i + 1) throw new RangeError('bar times must be consecutive');
    if (bar.complete != null && typeof bar.complete !== 'boolean') throw new TypeError('invalid candle completion state');
    if (i < windows.c.end) {
      if (!Number.isFinite(bar.hist)) throw new TypeError(`invalid histogram value at bar ${i + 1}`);
      for (const field of ['dif', 'dea']) {
        if (Object.hasOwn(bar, field) && !Number.isFinite(bar[field])) throw new TypeError(`invalid ${field} value at bar ${i + 1}`);
      }
      if (Object.hasOwn(bar, 'date') && (typeof bar.date !== 'string' || !bar.date.trim())) {
        throw new TypeError(`invalid sample date at bar ${i + 1}`);
      }
    }
  }
  const shared = { basis, source_proof: 'caller_supplied', scope: 'numeric_observation_only', as_of_time: asOfTime };
  let lastKnownAt = 0;
  const known = [];
  // MACD is causal but depends on the preceding history. Check candle closure
  // for the entire supplied prefix up to each requested sample, not only A/C.
  for (let i = 0; i < windows.c.end; i++) {
    const bar = bars[i], time = i + 1;
    if (bar.complete === false || (bar.complete == null && time === asOfTime)) {
      return { ...shared, status: 'pending', reason: 'candle_incomplete', incomplete_time: time };
    }
    lastKnownAt = Math.max(lastKnownAt, bar.complete === true ? time : time + 1);
    known.push(lastKnownAt);
  }
  const summarize = window => {
    const samples = bars.slice(window.start - 1, window.end).map(bar => {
      // Whitelist observed sample fields. Spreading arbitrary caller data could
      // read or expose properties containing future information.
      const sample = { time: bar.time, hist: bar.hist };
      for (const field of ['date', 'dif', 'dea', 'complete']) {
        if (Object.hasOwn(bar, field)) sample[field] = bar[field];
      }
      return sample;
    });
    let positive = 0, negative = 0;
    for (const sample of samples) {
      positive += Math.max(0, sample.hist);
      negative += Math.max(0, -sample.hist);
      if (!Number.isFinite(positive) || !Number.isFinite(negative)) throw new RangeError('histogram sum overflow');
    }
    return { start: window.start, end: window.end, positive_sum: positive, negative_magnitude_sum: negative,
      sample_count: samples.length, evidence_known_at: known[window.end - 1], samples };
  };
  const a = summarize(windows.a), c = summarize(windows.c);
  const positiveDifference = c.positive_sum - a.positive_sum;
  const negativeDifference = c.negative_magnitude_sum - a.negative_magnitude_sum;
  if (!Number.isFinite(positiveDifference) || !Number.isFinite(negativeDifference)) throw new RangeError('histogram difference overflow');
  return { ...shared, status: 'observed', windows: { a, c },
    difference: { positive_sum: positiveDifference, negative_magnitude_sum: negativeDifference } };
}
