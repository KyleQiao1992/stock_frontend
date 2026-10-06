/**
 * 本图最小分析级别：三个连续完成线段的实际区间重合。
 * 核心区间固定于前三段；按时间顺序延伸，离开和首次回试另行确认。
 * 第 17 / 20 课的递归走势中枢不能直接等同于某个 K 线周期的三笔重合。
 * 第 78 课：线段内部极值可不在端点，构枢使用实际全段区间。
 */

export const ZS_MIN_SEGMENTS = 3;

const overlaps = (segment, zd, zg) => segment.high >= zd && segment.low <= zg;

function validSegment(segment) {
  return segment?.confirmed === true && segment.start && segment.end
    && Number.isFinite(segment.high) && Number.isFinite(segment.low)
    && segment.high > segment.low
    && (segment.direction === 'up' || segment.direction === 'down');
}

function connected(a, b) {
  return a.end.time === b.start.time && a.direction !== b.direction;
}

function departureSide(segment, zd, zg) {
  if (segment.direction === 'up' && segment.end.price > zg) return 'up';
  if (segment.direction === 'down' && segment.end.price < zd) return 'down';
  return null;
}

/** 只确认完成线段之间的离开 / 首次回试几何关系，不冒充跨周期递归级别买卖点。 */
function thirdPoint(departure, retracement, zone) {
  if (!retracement || !connected(departure, retracement)) return null;
  const side = departureSide(departure, zone.zd, zone.zg);
  const outside = side === 'up' ? retracement.low >= zone.zg
    : side === 'down' && retracement.high <= zone.zd;
  if (!outside || !overlaps(departure, zone.zd, zone.zg)) return null;
  const point = side === 'up' ? retracement.low_point : retracement.high_point;
  return {
    kind: side === 'up' ? 'up_departure_retest' : 'down_departure_retest',
    label: side === 'up' ? '向上离开回试结构' : '向下离开回试结构',
    level: 'segment', scope: 'segment_geometry', status: 'confirmed',
    time: point?.time ?? (side === 'up' ? retracement.low_time : retracement.high_time),
    price: side === 'up' ? retracement.low : retracement.high,
    confirmed_time: retracement.confirmed_time,
    zone_id: zone.id, departure_id: departure.id, retracement_id: retracement.id,
    departure, retracement,
    basis: '完成线段离开后首次完成反向线段回试，不越过中枢边界；仅为本图线段级几何确认',
  };
}

function makeZone(segments, start) {
  const first = segments.slice(start, start + ZS_MIN_SEGMENTS);
  const upper = first.reduce((a, b) => b.high < a.high ? b : a);
  const lower = first.reduce((a, b) => b.low > a.low ? b : a);
  return {
    id: `zs-${first[0].start.time}-${first[2].end.time}`,
    sdt: first[0].start.time, edt: first[2].end.time,
    formation_edt: first[2].end.time,
    zg: upper.high, zd: lower.low, zz: (upper.high + lower.low) / 2,
    zg_time: upper.high_time, zd_time: lower.low_time,
    zg_point: upper.high_point, zd_point: lower.low_point,
    formation_direction: first[0].direction,
    startIndex: start, endIndex: start + 2,
    segment_count: 3, level: 'segment', label: '线段中枢（本图最小级别）',
    algorithm: 'confirmed_segment_sequence', confirmed: true,
    status: 'active', phase: 'extending', departure: null, thirdSignal: null,
  };
}

function finishRange(zone, segments) {
  const members = segments.slice(zone.startIndex, zone.endIndex + 1);
  const zSegments = members.filter((segment) => segment.direction === zone.formation_direction);
  zone.segment_count = members.length;
  zone.segment_ids = members.map((segment) => segment.id);
  zone.edt = members.at(-1).end.time;
  zone.gg = Math.max(...zSegments.map((segment) => segment.high));
  zone.dd = Math.min(...zSegments.map((segment) => segment.low));
  zone.range_high = Math.max(...members.map((segment) => segment.high));
  zone.range_low = Math.min(...members.map((segment) => segment.low));
}

/**
 * 输入必须为完成线段对象。笔端点 / 未确认线段不参与中枢。
 * 完成一个中枢后从离开 / 回试后的新位置继续查找，取消相邻三笔滑窗与九笔截断。
 */
export function buildZs(inputSegments) {
  const segments = [];
  for (const segment of inputSegments) {
    if (!validSegment(segment)) break;
    if (segments.length && !connected(segments.at(-1), segment)) break;
    segments.push(segment);
  }
  const zones = [];
  let start = 0;
  while (start + ZS_MIN_SEGMENTS <= segments.length) {
    const head = segments.slice(start, start + ZS_MIN_SEGMENTS);
    const zg = Math.min(...head.map((segment) => segment.high));
    const zd = Math.max(...head.map((segment) => segment.low));
    if (zg <= zd) { start++; continue; }
    const zone = makeZone(segments, start);
    let nextStart = segments.length;
    // 构成中枢的第三段也可能同时是离开段；其后的首次回试必须纳入检查。
    for (let index = start + ZS_MIN_SEGMENTS - 1; index < segments.length; index++) {
      const segment = segments[index];
      const next = segments[index + 1];
      const side = departureSide(segment, zd, zg);
      const signal = side ? thirdPoint(segment, next, zone) : null;
      if (signal) {
        zone.status = 'closed';
        zone.phase = 'completed';
        // 第 20 课的 Z 段只要触枢仍属于延伸。离开段若与成枢方向一致也须计入。
        if (segment.direction === zone.formation_direction) zone.endIndex = index;
        zone.departure = segment;
        zone.thirdSignal = signal;
        nextStart = index + 1;
        break;
      }
      if (index >= start + ZS_MIN_SEGMENTS && side && !next && overlaps(segment, zd, zg)) {
        zone.phase = 'leaving';
        zone.departure = segment;
        if (segment.direction === zone.formation_direction) zone.endIndex = index;
        break;
      }
      if (!overlaps(segment, zd, zg)) {
        // 单个离枢段尚不等于三买卖。Z 段不触枢，或连续两段不触枢，延伸停止。
        const zDirection = segment.direction === zone.formation_direction;
        if (zDirection || (next && !overlaps(next, zd, zg))) {
          zone.status = 'closed';
          zone.phase = 'departed';
          zone.departure = segment;
          nextStart = index;
          break;
        }
        if (!next) {
          zone.phase = 'leaving';
          zone.departure = segment;
          break;
        }
      }
      zone.endIndex = index;
    }
    finishRange(zone, segments);
    const previous = zones.at(-1);
    if (previous) {
      zone.relation = zone.dd > previous.gg ? 'up_separated'
        : zone.gg < previous.dd ? 'down_separated'
          : 'overlapping_fluctuations';
      zone.requires_recursive_level = zone.relation === 'overlapping_fluctuations';
    }
    zones.push(zone);
    start = Math.max(start + ZS_MIN_SEGMENTS, nextStart);
  }
  return zones;
}

/** 现价相对本图最小级别线段中枢的位置。 */
export function positionVsZs(price, zs) {
  if (!zs) return { vs: 'none', label: '无已确认线段中枢' };
  if (price > zs.zg) return { vs: 'above', label: '中枢上方' };
  if (price < zs.zd) return { vs: 'below', label: '中枢下方' };
  return { vs: 'inside', label: '中枢内部' };
}
