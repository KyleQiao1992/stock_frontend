// Source-derived examples: lessons 67/71, with the second-sequence rule corrected
// by lessons 78/81. These prices are synthetic, not recovered original chart data.
export const GAP_PRICES = [0, 100, 40, 120, 50, 115, 110, 114, 105];
export const GAP_TURNS = [20, ...GAP_PRICES, 113, 40, 112, 45, 114, 100, 113];

export function segmentGapRows(count = 129, sign = 1) {
  return GAP_TURNS.flatMap((price, i) => i ? Array.from({ length: 8 }, (_, j) =>
    GAP_TURNS[i - 1] + (price - GAP_TURNS[i - 1]) * (j + 1) / 8) : [price])
    .slice(0, count).map((price, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 200 + sign * price, close: 200 + sign * price,
      high: 200 + sign * price + .1, low: 200 + sign * price - .1,
      volume: 100, complete: true,
    }));
}

export function retractionRows(seed) {
  let state = seed, price = 1000;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: 200 }, (_, i) => {
    price += (random() - .5) * 40;
    const width = .2 + random() * 10;
    return { date: `K${i + 1}`, open: price, close: price, low: price - width,
      high: price + width, volume: 100, complete: true };
  });
}

export const SEGMENT_SPEC_CASES = [
  { id: 'merged-gap-waits', prices: GAP_PRICES, expected: [] },
  { id: 'merged-gap-resumes', prices: [...GAP_PRICES, 121], expected: [] },
  { id: 'merged-gap-lower-local-top', prices: [...GAP_PRICES, 113, 40], expected: [] },
  { id: 'merged-gap-eventually-confirms', prices: [...GAP_PRICES, 113, 40, 112, 45, 114],
    expected: [[0, 3, 13, 'feature_gap_reverse_fractal'], [3, 10, 13, 'reverse_feature_fractal']] },
  { id: 'ordinary-no-gap', prices: [0, 10, 4, 12, 5, 9, 3], expected: [[0, 3, 6, 'feature_no_gap']] },
  { id: 'first-break', prices: [0, 10, 4, 12, 3, 8, 2], expected: [[0, 3, 6, 'first_stroke_break']] },
  { id: 'gap-without-price-fill', prices: [0, 4, 2, 10, 7, 9, 6, 8, 7, 9],
    expected: [[0, 3, 9, 'feature_gap_reverse_fractal'], [3, 6, 9, 'reverse_feature_fractal']] },
];
