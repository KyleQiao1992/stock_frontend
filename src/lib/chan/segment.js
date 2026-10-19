/**
 * 线段：第 67 / 71 / 77 / 78 课定义，以及第 81 课对第二种情况的更正。
 * 只接收已确认笔端。特征元素是反向笔，不是三笔价格折线的转折猜测。
 * https://blog.sina.com.cn/s/blog_486e105c01000c16.html
 * https://blog.sina.com.cn/s/blog_486e105c01000c8i.html
 * https://blog.sina.com.cn/s/blog_486e105c01000cih.html
 * https://blog.sina.com.cn/s/blog_486e105c01000cio.html
 * https://blog.sina.com.cn/s/blog_486e105c01000cmz.html
 */

const opposite = (direction) => direction === 'up' ? 'down' : 'up';
const contains = (a, b) => (a.high >= b.high && a.low <= b.low)
  || (b.high >= a.high && b.low <= a.low);
const overlaps = (a, b) => Math.max(a.low, b.low) <= Math.min(a.high, b.high);

function feature(points, index) {
  const a = points[index];
  const b = points[index + 1];
  const highPoint = a.price >= b.price ? a : b;
  const lowPoint = a.price <= b.price ? a : b;
  return {
    high: highPoint.price, low: lowPoint.price,
    highIndex: a.price >= b.price ? index : index + 1,
    lowIndex: a.price <= b.price ? index : index + 1,
    from: index, to: index + 1,
  };
}

/** 包含处理使用此前无包含的两个元素的方向，初始方向来自当前线段。 */
function appendFeature(sequence, item, initialDirection) {
  const last = sequence.at(-1);
  if (!last || !contains(last, item)) {
    sequence.push(item);
    return;
  }
  const previous = sequence.at(-2);
  const direction = previous
    ? (last.high > previous.high ? 'up' : 'down') : initialDirection;
  const selectHigh = direction === 'up' ? item.high > last.high : item.high < last.high;
  const selectLow = direction === 'up' ? item.low > last.low : item.low < last.low;
  sequence[sequence.length - 1] = {
    high: selectHigh ? item.high : last.high,
    low: selectLow ? item.low : last.low,
    highIndex: selectHigh ? item.highIndex : last.highIndex,
    lowIndex: selectLow ? item.lowIndex : last.lowIndex,
    from: last.from, to: item.to,
  };
}

function isFractal(a, b, c, direction) {
  return direction === 'up'
    ? b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low
    : b.high < a.high && b.high < c.high && b.low < a.low && b.low < c.low;
}

function firstThreeOverlap(points, start) {
  if (start + 3 >= points.length) return false;
  const first = [0, 1, 2].map((offset) => feature(points, start + offset));
  return Math.max(...first.map((x) => x.low)) < Math.min(...first.map((x) => x.high));
}

function validEnd(points, start, end, direction) {
  return end - start >= 3 && (end - start) % 2 === 1
    && (direction === 'up' ? points[end].price > points[start].price
      : points[end].price < points[start].price);
}

/**
 * 第二种情况：从假设转折点开始，反向线段的特征序列必须出现分型。
 * 此处全序列做包含处理，不能套用第一种情况跨分界点禁合并的例外（78 / 81 课）。
 * 在分型出现前若先突破假设转折点，旧段继续，不确认 A / B / C 三段。
 */
function reverseFractal(points, end, direction) {
  const reverseDirection = opposite(direction);
  const sequence = [];
  if (!firstThreeOverlap(points, end)) return null;
  for (let index = end + 1; index + 1 < points.length; index += 2) {
    const limit = index + 1;
    appendFeature(sequence, feature(points, index), reverseDirection);
    if (sequence.length >= 3) {
      const [a, b, c] = sequence.slice(-3);
      if (isFractal(a, b, c, reverseDirection)) {
        const nextEnd = reverseDirection === 'up' ? b.highIndex : b.lowIndex;
        if (validEnd(points, end, nextEnd, reverseDirection)) {
          return { confirmedIndex: limit, nextEnd };
        }
      }
    }
    // 右侧笔可能先形成反向分型、然后再越过旧段端点（第 81 课图）。
    // 完成笔的端价已跨过旧端时，必须先检查这一分型，不能先取消候选。
    for (let p = Math.max(end + 1, index - 1); p <= limit; p++) {
      if (direction === 'up' ? points[p].price >= points[end].price
        : points[p].price <= points[end].price) return null;
    }
  }
  return null;
}

function boundaryProof(points, start, end, direction) {
  if (!validEnd(points, start, end, direction) || !firstThreeOverlap(points, end)) return null;
  const leftSequence = [];
  for (let index = start + 1; index + 1 <= end; index += 2) {
    appendFeature(leftSequence, feature(points, index), direction);
  }
  const left = leftSequence.at(-1);
  const center = feature(points, end);
  if (!left) return null;
  const gap = !overlaps(left, center);

  // 第 71 课：首笔即破坏，第三笔继续越过首笔结束位置，反向段成立。
  // 前后两元素不能包含合并，否则会抹去这一转折力度。
  const firstBreak = direction === 'up' ? center.low <= left.low : center.high >= left.high;
  if (!gap && firstBreak) {
    for (let index = end + 2; index < points.length; index++) {
      const resumes = direction === 'up' ? points[index].price >= points[end].price
        : points[index].price <= points[end].price;
      if (resumes) return null;
      if ((index - end) % 2 !== 1) continue;
      const breaksEnd = direction === 'up' ? points[index].price < points[end + 1].price
        : points[index].price > points[end + 1].price;
      if (breaksEnd) return { end, confirmedIndex: index, mode: 'first_stroke_break', gap: false };
    }
    return null;
  }

  // 跨假设转折点的 left / center 不合并；转折点之后的同性质元素仍做包含处理。
  const rightSequence = [center];
  for (let index = end + 2; index + 1 < points.length; index += 2) {
    appendFeature(rightSequence, feature(points, index), direction);
    if (rightSequence.length < 2) continue;
    const [middle, right] = rightSequence;
    const pivot = direction === 'up' ? middle.highIndex : middle.lowIndex;
    if (pivot !== end || !isFractal(left, middle, right, direction)) return null;
    if (!gap) return { end, confirmedIndex: index + 1, mode: 'feature_no_gap', gap: false };
    const reverse = reverseFractal(points, end, direction);
    if (!reverse) return null;
    return {
      end, confirmedIndex: Math.max(index + 1, reverse.confirmedIndex),
      mode: 'feature_gap_reverse_fractal', gap: true, nextEnd: reverse.nextEnd,
    };
  }
  return null;
}

function makeSegment(points, start, proof, direction) {
  const end = proof.end;
  const interior = points.slice(start, end + 1);
  const highPoint = interior.reduce((a, b) => b.price > a.price ? b : a);
  const lowPoint = interior.reduce((a, b) => b.price < a.price ? b : a);
  return {
    id: `segment-${points[start].time}-${points[end].time}`,
    start: { ...points[start] }, end: { ...points[end] },
    startIndex: start, endIndex: end, direction, confirmed: true,
    stroke_count: end - start,
    high: highPoint.price, low: lowPoint.price,
    high_time: highPoint.time, low_time: lowPoint.time,
    high_point: { ...highPoint }, low_point: { ...lowPoint },
    confirmation: proof.mode, feature_gap: proof.gap,
    confirmedIndex: proof.confirmedIndex,
    // A pen endpoint occurs before the candle which fixes it. Confirmation
    // belongs to the latest required evidence candle, never to the old pivot.
    confirmed_endpoint_time: points[proof.confirmedIndex].time,
    confirmed_time: Math.max(...points.slice(0, proof.confirmedIndex + 1)
      .map((p) => p.confirmed_time ?? p.time)),
  };
}

/**
 * 返回完成段及未破坏的最后一段参考端点。
 * 奇数笔、前三笔重合、顶底方向正确均为硬条件。确认状态缺失也在该点截断。
 * 开始点之前不足三笔重合的片段不伪造为线段；此后各完成段共享分界点。
 */
export function buildSegments(biPoints) {
  const points = [];
  for (const point of biPoints) {
    if (point.confirmed !== true || !Number.isFinite(point.price)) break;
    const previous = points.at(-1);
    if (previous && (previous.mark === point.mark || previous.time >= point.time)) break;
    points.push(point);
  }
  const segments = [];
  let start = 0;
  while (start + 3 < points.length && !firstThreeOverlap(points, start)) start++;
  let forced = null;
  while (firstThreeOverlap(points, start)) {
    const direction = points[start + 1].price > points[start].price ? 'up' : 'down';
    let proof = forced;
    forced = null;
    if (!proof) {
      for (let end = start + 3; end + 3 < points.length; end += 2) {
        const candidate = boundaryProof(points, start, end, direction);
        if (candidate && (!proof || candidate.confirmedIndex < proof.confirmedIndex)) proof = candidate;
      }
    }
    if (!proof) break;
    // 当前段的起点要等前一段的完成性确认。不能把后段历史上的局部分型时间
    // 作为当时已经可知的确认时间（第 77 / 78 课的破坏关系沿时间反向传递）。
    proof = { ...proof, confirmedIndex: Math.max(proof.confirmedIndex,
      segments.at(-1)?.confirmedIndex ?? 0) };
    segments.push(makeSegment(points, start, proof, direction));
    start = proof.end;
    // 第 77 课：第二序列的分型已确认 B 被 C 破坏，完成性沿时间向前传递。
    if (proof.nextEnd !== undefined) {
      forced = { end: proof.nextEnd, confirmedIndex: proof.confirmedIndex,
        mode: 'reverse_feature_fractal', gap: false };
    }
  }
  let pendingEnd = null;
  const direction = points[start + 1]?.price > points[start]?.price ? 'up' : 'down';
  for (let index = start + 1; index < points.length; index += 2) {
    if (!pendingEnd || (direction === 'up' ? points[index].price > pendingEnd.price
      : points[index].price < pendingEnd.price)) pendingEnd = points[index];
  }
  const pending = pendingEnd && firstThreeOverlap(points, start)
    ? [{ ...points[start], confirmed: false }, { ...pendingEnd, confirmed: false }] : [];
  return { segments, pending };
}
