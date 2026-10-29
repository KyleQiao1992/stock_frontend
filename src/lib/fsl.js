// Published FSL, with the verified HQChart DMA boundary: A >= 1 returns X.
// MAX(1, 100 * SUM(VOL,5)/(3*CAPITAL)) is always >= 1, so SWS = EMA12.
// This equivalence removes the need to estimate CAPITAL from present quotes.
// Independent reference outputs and source blob IDs are in fixtures/fsl-hqchart-reference.json.
export function calcFslSeries(rows) {
  let ema5 = null, ema10 = null, ema12 = null;
  return rows.map(row => {
    if (!Number.isFinite(row.close)) {
      ema5 = ema10 = ema12 = null;
      return { date: row.date, swl: null, sws: null, reason: '缺少收盘价', complete: row.complete };
    }
    ema5 = ema5 == null ? row.close : ema5 + (row.close - ema5) * 2 / 6;
    ema10 = ema10 == null ? row.close : ema10 + (row.close - ema10) * 2 / 11;
    ema12 = ema12 == null ? row.close : ema12 + (row.close - ema12) * 2 / 13;
    return { date: row.date, swl: (ema5 * 7 + ema10 * 3) / 10, sws: ema12, reason: null, complete: row.complete };
  });
}

export function findFslCrosses(series) {
  const crosses = [];
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1], current = series[index];
    if (previous.complete === false || current.complete === false
      || ![previous.swl, previous.sws, current.swl, current.sws].every(Number.isFinite)) continue;
    const before = previous.swl - previous.sws, after = current.swl - current.sws;
    const type = before <= 0 && after > 0 ? 'golden' : before >= 0 && after < 0 ? 'death' : null;
    if (type) crosses.push({ date: current.date, type, value: (current.swl + current.sws) / 2 });
  }
  return crosses;
}
