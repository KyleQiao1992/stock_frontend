import { mergeCandles, findFractals } from './fractal.js';
import { buildBi } from './bi.js';
import { analyzeReferenceCandles, mergeReferenceBar } from './referenceEngine.js';

const contains = (a, b) => (a.high <= b.high && a.low >= b.low)
  || (a.high >= b.high && a.low <= b.low);
const asReferenceBar = (candle, idx) => ({ high: candle.high, low: candle.low, time: candle.time,
  from: idx, to: idx, elements: [{ ...candle, idx }], mergeSteps: [] });

// Experiment with the active engine's inclusion and equal-price policy, while
// keeping a separate strict pen replay. Do not use this to claim both engines
// have identical fractal selection or confirmation rules.
function mergeActiveBars(candles) {
  let merged = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (merged.length < 2) {
      if (merged.length === 1 && contains(merged[0], candle)) merged[0] = asReferenceBar(candle, i);
      else merged.push(asReferenceBar(candle, i));
    } else {
      const next = mergeReferenceBar(merged.at(-2), merged.at(-1), candle, i);
      if (next.from === i) merged.push(next);
      else merged[merged.length - 1] = next;
    }
  }
  return merged.map(bar => ({ ...bar, idx: bar.time - 1,
    highIdx: bar.time - 1, lowIdx: bar.time - 1 }));
}

/**
 * Research-only replay of the repository's strict old-pen construction.
 * This is not wired to analyzeChan or the chart. Fractals are rebuilt on every
 * observed prefix; a surviving confirmed endpoint keeps the first time at
 * which it was known. This prevents using the final pen path as historical
 * evidence. A later rollback may still withdraw a previously confirmed point.
 *
 * With inclusion='strict', this uses fractal.js and buildBi and remains a
 * separate research algorithm. With inclusion='active', it replays the active
 * reference engine itself and verifies its prefix/confirmation contract;
 * the two modes do not constitute independent confirmation of one another.
 */
export function replayStrictPens(input, { inclusion = 'strict' } = {}) {
  if (!Array.isArray(input)) throw new TypeError('input must be an array');
  if (inclusion !== 'strict' && inclusion !== 'active') throw new TypeError('invalid inclusion policy');
  const candles = input.map((row, i) => {
    if (!row || !Number.isFinite(row.high) || !Number.isFinite(row.low) || row.high < row.low) {
      throw new RangeError(`invalid range at row ${i + 1}`);
    }
    if (row.complete != null && typeof row.complete !== 'boolean') {
      throw new TypeError(`invalid completion at row ${i + 1}`);
    }
    return { ...row, time: i + 1 };
  });

  let previous = new Map();
  let bi = [];
  let retractions = 0;
  let merged = [];
  let fractals = [];
  for (let n = 1; n <= candles.length; n++) {
    const prefix = candles.slice(0, n);
    merged = inclusion === 'active' ? mergeActiveBars(prefix) : mergeCandles(prefix);
    fractals = findFractals(prefix, merged);
    let points;
    if (inclusion === 'active') {
      const byTime = new Map(fractals.map(point => [point.time, point]));
      points = analyzeReferenceCandles(prefix).bi.map(point => {
        const detail = byTime.get(point.time);
        if (!detail || detail.mark !== point.mark || detail.price !== point.price) {
          throw new Error(`active pen endpoint ${point.time} lacks matching processed fractal`);
        }
        return { ...detail, ...point };
      });
    } else points = buildBi(fractals, { merged });
    const next = new Map();
    bi = points.map((point, index) => {
      const successor = points[index + 1];
      let closed = point.confirmed === true && !!successor;
      // The next endpoint's right fractal candle (and all raw candles from the
      // start's left fractal through it) are evidence for this pen. Unknown
      // completion is observable only once its next same-series K arrives.
      if (closed) {
        for (let i = point.from; i <= successor.to; i++) {
          if (prefix[i].complete === false || (prefix[i].complete !== true && i + 1 >= n)) {
            closed = false;
            break;
          }
        }
      }
      // A surviving starting endpoint can be followed by a *different* pen
      // after rollback. Its earlier confirmation did not establish that new
      // endpoint, so retain times only for the same complete pair.
      const key = JSON.stringify([point.time, point.mark, point.price,
        successor?.time ?? null, successor?.mark ?? null, successor?.price ?? null]);
      const earlier = previous.get(key);
      const observed = { time: point.time, idx: point.idx, mark: point.mark, price: point.price,
        confirmed: closed, confirmed_time: closed ? earlier?.confirmed ? earlier.confirmed_time : n : null };
      next.set(key, observed);
      return observed;
    });
    for (const [key, old] of previous) {
      if (old.confirmed && !next.has(key)) retractions++;
    }
    previous = next;
  }
  return { bi, merged, fractals, retractions, definition: {
    status: 'research_only', price_source: 'caller_supplied',
    pen_rule: inclusion === 'active' ? 'referenceEngine.js' : 'fractal.js+bi.js',
    confirmation: 'closed evidence and first visible prefix; surviving endpoint may later retract',
  } };
}
