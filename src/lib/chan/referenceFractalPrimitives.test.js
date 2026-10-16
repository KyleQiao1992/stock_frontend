import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReferenceBar, findReferenceFractals } from './referenceEngine.js';

// 人工区间均写为 [最高价, 最低价]。这些断言核验主图所调用的真实原语，
// 不用另一个分型实现作 oracle，也不把网站样本一致当成原典定义的证明。
// 三 K 分型的高、低比较以完成包含处理后的 K 线为前提；等价极值的时间
// 归属另列为「参考站定位约定」，不声称原典要求保留最新的一根。
function bars(ranges, times = ranges.map((_, i) => 100 + i * 10)) {
  return ranges.map(([high, low], i) => {
    const raw = { time: times[i], high, low, open: low, close: high, vol: 1, idx: i };
    return { high, low, time: times[i], from: i, to: i, elements: [raw] };
  });
}

const points = (input) => findReferenceFractals(input)
  .map(({ mark, time, price }) => ({ mark, time, price }));
const interval = ({ high, low, time, from, to }) => ({ high, low, time, from, to });
const append = (a, b, high, low, time, idx) => mergeReferenceBar(a, b,
  { high, low, time, open: low, close: high, vol: 1 }, idx);

test('top: the middle high and low are both strictly above both neighbours', () => {
  assert.deepEqual(points(bars([[8, 4], [10, 6], [9, 5]])),
    [{ mark: 'G', time: 110, price: 10 }]);
});

test('bottom: the middle low and high are both strictly below both neighbours', () => {
  assert.deepEqual(points(bars([[9, 5], [7, 3], [8, 4]])),
    [{ mark: 'D', time: 110, price: 3 }]);
});

test('a higher middle high alone is insufficient when its low is not also higher', () => {
  // 此原始三 K 存在包含，不能略过包含处理，仅凭最高价就判顶。
  assert.deepEqual(points(bars([[8, 4], [10, 3], [9, 5]])), []);
});

test('a lower middle low alone is insufficient when its high is not also lower', () => {
  assert.deepEqual(points(bars([[8, 4], [9, 2], [10, 3]])), []);
});

test('equal middle and left highs do not satisfy the strict top predicate', () => {
  assert.deepEqual(points(bars([[10, 4], [10, 6], [9, 5]])), []);
});

test('equal middle and right highs do not satisfy the strict top predicate', () => {
  assert.deepEqual(points(bars([[8, 4], [10, 6], [10, 5]])), []);
});

test('equal middle and left lows do not satisfy the strict bottom predicate', () => {
  assert.deepEqual(points(bars([[9, 3], [7, 3], [8, 4]])), []);
});

test('equal middle and right lows do not satisfy the strict bottom predicate', () => {
  assert.deepEqual(points(bars([[9, 5], [7, 3], [8, 3]])), []);
});

test('strictly rising high/low intervals contain no turning fractal', () => {
  assert.deepEqual(points(bars([[7, 1], [8, 2], [9, 3], [10, 4]])), []);
});

test('strictly falling high/low intervals contain no turning fractal', () => {
  assert.deepEqual(points(bars([[10, 4], [9, 3], [8, 2], [7, 1]])), []);
});

test('identical ranges alone cannot supply a strict top or bottom', () => {
  assert.deepEqual(points(bars([[8, 4], [8, 4], [8, 4]])), []);
});

test('zero, one or two available K lines cannot confirm a three-K fractal', () => {
  for (const ranges of [[], [[8, 4]], [[8, 4], [10, 6]]]) {
    assert.deepEqual(points(bars(ranges)), []);
  }
});

test('top does not require the third K to break below the first K low', () => {
  assert.deepEqual(points(bars([[7, 1], [10, 4], [8, 3]])),
    [{ mark: 'G', time: 110, price: 10 }]);
});

test('bottom does not require the third K to break above the first K high', () => {
  assert.deepEqual(points(bars([[10, 4], [7, 1], [9, 3]])),
    [{ mark: 'D', time: 110, price: 1 }]);
});

test('body colour and doji bodies do not change wick-defined tops or bottoms', () => {
  for (const [ranges, expected] of [
    [[[8, 4], [10, 6], [9, 5]], [{ mark: 'G', time: 110, price: 10 }]],
    [[[9, 5], [7, 3], [8, 4]], [{ mark: 'D', time: 110, price: 3 }]],
  ]) {
    // 全阳、全阴、十字，以及每根不同颜色。最高/最低与时间不动。
    for (const pattern of [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [1, 0, 1]]) {
      const input = bars(ranges).map((bar, i) => {
        const raw = bar.elements[0];
        const body = pattern[i] === 0 ? { open: raw.low + 0.2, close: raw.high - 0.2 }
          : pattern[i] === 1 ? { open: raw.high - 0.2, close: raw.low + 0.2 }
            : { open: (raw.low + raw.high) / 2, close: (raw.low + raw.high) / 2 };
        return { ...bar, elements: [{ ...raw, ...body }] };
      });
      assert.deepEqual(points(input), expected);
    }
  }
});

test('wick extremum, rather than body close, supplies the fractal price', () => {
  const input = bars([[8, 4], [10, 6], [9, 5]]);
  input[1].elements[0].open = 7;
  input[1].elements[0].close = 7;
  assert.deepEqual(points(input), [{ mark: 'G', time: 110, price: 10 }]);
});

test('valid consecutive local turns remain in their chronological order', () => {
  assert.deepEqual(points(bars([[8, 4], [10, 6], [9, 5], [11, 7], [8, 4]])), [
    { mark: 'G', time: 110, price: 10 },
    { mark: 'D', time: 120, price: 5 },
    { mark: 'G', time: 130, price: 11 },
  ]);
});

test('the marker carries the middle K timestamp, not the right confirmation timestamp', () => {
  assert.deepEqual(points(bars([[8, 4], [10, 6], [9, 5]], [17, 23, 41])),
    [{ mark: 'G', time: 23, price: 10 }]);
});

test('adding the missing right K is necessary before a top appears', () => {
  const input = bars([[8, 4], [10, 6], [9, 5]]);
  assert.deepEqual(points(input.slice(0, 2)), []);
  assert.deepEqual(points(input), [{ mark: 'G', time: 110, price: 10 }]);
});

test('upward inclusion with an inner new K retains the higher high and higher low', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  const merged = append(a, b, 9, 7, 120, 2);
  assert.deepEqual(interval(merged), { high: 10, low: 7, time: 110, from: 1, to: 2 });
  assert.deepEqual(merged.elements.map(({ time }) => time), [110, 120]);
});

test('upward inclusion with an outer new K retains the higher high and higher low', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  assert.deepEqual(interval(append(a, b, 11, 5, 120, 2)),
    { high: 11, low: 6, time: 120, from: 1, to: 2 });
});

test('downward inclusion with an inner new K retains the lower high and lower low', () => {
  const [a, b] = bars([[12, 8], [10, 6]]);
  assert.deepEqual(interval(append(a, b, 9, 7, 120, 2)),
    { high: 9, low: 6, time: 110, from: 1, to: 2 });
});

test('downward inclusion with an outer new K retains the lower high and lower low', () => {
  const [a, b] = bars([[12, 8], [10, 6]]);
  assert.deepEqual(interval(append(a, b, 11, 5, 120, 2)),
    { high: 10, low: 5, time: 120, from: 1, to: 2 });
});

test('successive upward inclusions are handled against the already merged interval', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  const first = append(a, b, 9, 7, 120, 2);
  const second = append(a, first, 11, 5, 130, 3);
  assert.deepEqual(interval(second), { high: 11, low: 7, time: 130, from: 1, to: 3 });
  const right = bars([[10, 4]], [140])[0];
  assert.deepEqual(points([a, second, right]), [{ mark: 'G', time: 130, price: 11 }]);
});

test('successive downward inclusions are handled against the already merged interval', () => {
  const [a, b] = bars([[12, 8], [10, 6]]);
  const first = append(a, b, 9, 7, 120, 2);
  const second = append(a, first, 11, 5, 130, 3);
  assert.deepEqual(interval(second), { high: 9, low: 5, time: 130, from: 1, to: 3 });
  const right = bars([[12, 6]], [140])[0];
  assert.deepEqual(points([a, second, right]), [{ mark: 'D', time: 130, price: 5 }]);
});

test('reference positioning convention: equal upward highs use the latest raw K time', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  const merged = append(a, b, 10, 5, 120, 2);
  assert.deepEqual(interval(merged), { high: 10, low: 6, time: 120, from: 1, to: 2 });
  assert.deepEqual(points([a, merged, bars([[9, 3]], [130])[0]]),
    [{ mark: 'G', time: 120, price: 10 }]);
});

test('reference positioning convention: equal downward lows use the latest raw K time', () => {
  const [a, b] = bars([[14, 10], [12, 8]]);
  const merged = append(a, b, 13, 8, 120, 2);
  assert.deepEqual(interval(merged), { high: 12, low: 8, time: 120, from: 1, to: 2 });
  assert.deepEqual(points([a, merged, bars([[15, 9]], [130])[0]]),
    [{ mark: 'D', time: 120, price: 8 }]);
});

test('a non-containing new K remains an independent interval', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  const independent = append(a, b, 9, 5, 120, 2);
  assert.deepEqual(interval(independent), { high: 9, low: 5, time: 120, from: 2, to: 2 });
  assert.deepEqual(independent.elements.map(({ time }) => time), [120]);
});

test('merging does not mutate a previously observed interval or its raw K list', () => {
  const [a, b] = bars([[8, 4], [10, 6]]);
  const snapshot = structuredClone(b);
  Object.freeze(a);
  Object.freeze(b.elements[0]);
  Object.freeze(b.elements);
  Object.freeze(b);
  assert.doesNotThrow(() => append(a, b, 11, 5, 120, 2));
  assert.deepEqual(b, snapshot);
});

test('a valid top and its price reflection produce the expected opposite turns', () => {
  assert.deepEqual(points(bars([[8, 4], [10, 6], [9, 5]])),
    [{ mark: 'G', time: 110, price: 10 }]);
  assert.deepEqual(points(bars([[16, 12], [14, 10], [15, 11]])),
    [{ mark: 'D', time: 110, price: 10 }]);
});

test('price translation changes only the fractal price, not its side or timestamp', () => {
  assert.deepEqual(points(bars([[108, 104], [110, 106], [109, 105]])),
    [{ mark: 'G', time: 110, price: 110 }]);
});

test('a changed right K can remove a previously observed unclosed-bar top', () => {
  // 原语没有「已收盘」状态；本例只证明同一右 K 的变化可改变结果，
  // 不把实时右 K 尚未收盘的三 K 观察冒充不可撤销的确认。
  assert.deepEqual(points(bars([[8, 4], [10, 6], [9, 5]])),
    [{ mark: 'G', time: 110, price: 10 }]);
  assert.deepEqual(points(bars([[8, 4], [10, 6], [11, 7]])), []);
});
