import { replayStrictPens } from './strictPenReplayPrototype.js';
import { buildFractalDetail } from './fractalDetail.js';

/** Experimental replacement adapter; it is deliberately not used by the main chart. */
export function analyzeStrictReferenceCandidate(candles) {
  if (!Array.isArray(candles) || candles.some((candle, index) => candle?.time !== index + 1)) {
    throw new RangeError('candidate requires consecutive one-based candle times');
  }
  const replay = replayStrictPens(candles, { inclusion: 'active' });
  const point = p => ({ time: p.time, idx: p.time - 1, price: p.price, mark: p.mark });
  const detailed = p => ({ ...p, elements: replay.merged.slice(p.mi - 1, p.mi + 2) });
  const byTime = new Map(replay.fractals.map(p => [p.time, p]));
  // buildBi may contain one candidate fractal before any pen exists; the main
  // chart contract exposes a pen only once it has two endpoints.
  const bi = replay.bi.length >= 2 ? replay.bi : [];
  // Preserve the existing chart convention: the first retained pen endpoint
  // has pen details but is omitted from the separately drawn fractal circles.
  const drawableFractals = replay.fractals.filter(p => !bi.length || p.time !== bi[0].time);
  const fx = drawableFractals.map(point);
  const biFractals = bi.map(p => byTime.get(p.time));
  const fractalDetails = {
    fx: Object.fromEntries(drawableFractals.map(p => [p.time, buildFractalDetail(candles, detailed(p))])),
    bi: Object.fromEntries(biFractals.map(p => [p.time, buildFractalDetail(candles, detailed(p))])),
  };
  const pending = [];
  if (bi.length) {
    const start = bi.at(-1);
    const up = start.mark === 'D';
    let extreme = candles[start.time - 1];
    for (const candle of candles.slice(start.time)) {
      if (up ? candle.high > extreme.high : candle.low < extreme.low) extreme = candle;
    }
    pending.push(start, { time: extreme.time, idx: extreme.time - 1,
      price: up ? extreme.high : extreme.low, mark: up ? 'G' : 'D',
      extremeTime: extreme.time, confirmed: false, confirmed_time: null });
  }
  const historyStart = bi.length ? biFractals[0].from : 0;
  return { candles: candles.slice(historyStart), fx, bi, segmentBi: bi, pending, fractalDetails,
    strokeCount: Math.max(0, bi.length - 1), segmentStrokeCount: Math.max(0, bi.length - 1) };
}
