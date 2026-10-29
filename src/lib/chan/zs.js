/**
 * 本图最小分析级别：三个连续完成线段的实际区间重合。
 * 核心区间固定于前三段；按时间顺序延伸，离开和首次回试另行确认。
 * 第 17 / 20 课的递归走势中枢不能直接等同于某个 K 线周期的三笔重合。
 * 第 78 课：线段内部极值可不在端点，构枢使用实际全段区间。
 */

export const ZS_MIN_SEGMENTS = 3;
export const ZS_RULE_VERSION = 'chan-segment-zs-v1';

// Declared lowest-layer convention. Lesson 20 admits touching Z intervals in
// extension; we do not classify a boundary touch as termination or a buy/sell
// signal. This does not settle every equality statement across lessons 18–21.
const BOUNDARY_POLICY = {
  formation: 'positive_width', extension: 'touch_counts', retest: 'strictly_outside_to_close',
};

const bounds = segment => segment.range_bounds ?? {
  high_min: segment.high, high_max: segment.high, low_min: segment.low, low_max: segment.low,
};

// Return yes/no only when all admissible intrabar paths agree.
function overlapState(segment, zd, zg) {
  const b = bounds(segment);
  if (b.high_min >= zd && b.low_max <= zg) return 'yes';
  if (b.high_max < zd || b.low_min > zg) return 'no';
  return 'unknown';
}

function outsideState(segment, side, zd, zg) {
  const b = bounds(segment);
  if (side === 'up') return b.low_min > zg ? 'yes' : b.low_max <= zg ? 'no' : 'unknown';
  return b.high_max < zd ? 'yes' : b.high_min >= zd ? 'no' : 'unknown';
}

function validBounds(segment) {
  const b = bounds(segment);
  return [b.high_min, b.high_max, b.low_min, b.low_max].every(Number.isFinite)
    && b.low_min <= b.low_max && b.high_min <= b.high_max && b.low_max <= b.high_min
    && b.high_min === segment.high && b.low_max === segment.low;
}

function validSegment(segment) {
  return segment?.confirmed === true && segment.start && segment.end
    && [segment.start.time, segment.end.time, segment.start.price, segment.end.price,
      segment.confirmed_time].every(Number.isFinite)
    && segment.start.time < segment.end.time && segment.confirmed_time >= segment.end.time
    && Number.isFinite(segment.high) && Number.isFinite(segment.low) && validBounds(segment)
    && segment.high > segment.low
    && segment.high >= Math.max(segment.start.price, segment.end.price)
    && segment.low <= Math.min(segment.start.price, segment.end.price)
    && (segment.direction === 'up' ? segment.end.price > segment.start.price
      : segment.direction === 'down' && segment.end.price < segment.start.price);
}

function connected(a, b) {
  return a.end.time === b.start.time && a.end.price === b.start.price && a.direction !== b.direction
    && (a.end.idx === undefined || b.start.idx === undefined || a.end.idx === b.start.idx);
}

const segmentId = segment => segment.id ?? `segment-${segment.start.time}-${segment.end.time}`;

function evidenceFor(segments, startIndex, confirmedTime, kind) {
  return {
    kind, segment_ids: segments.map(segmentId), confirmed_time: confirmedTime,
    segments: segments.map((segment, offset) => ({
      id: segmentId(segment), index: startIndex + offset, direction: segment.direction,
      start: { ...segment.start }, end: { ...segment.end },
      high: segment.high, low: segment.low,
      high_time: segment.high_time, low_time: segment.low_time,
      range_bounds: { ...bounds(segment) },
      confirmed_time: segment.confirmed_time,
    })),
  };
}

function departureSide(segment, zd, zg) {
  if (segment.direction === 'up' && segment.end.price > zg) return 'up';
  if (segment.direction === 'down' && segment.end.price < zd) return 'down';
  return null;
}

/** 只确认完成线段之间的离开 / 首次回试几何关系，不冒充跨周期递归级别买卖点。 */
function departureRetest(departure, retracement, zone, confirmedTime) {
  if (!retracement || !connected(departure, retracement)) return null;
  const side = departureSide(departure, zone.zd, zone.zg);
  const outside = side === 'up' ? retracement.low > zone.zg
    : side === 'down' && retracement.high < zone.zd;
  if (!outside || overlapState(departure, zone.zd, zone.zg) !== 'yes') return null;
  const b = bounds(retracement);
  const exact = side === 'up' ? b.low_min === b.low_max : b.high_min === b.high_max;
  const point = exact ? (side === 'up' ? retracement.low_point : retracement.high_point) : null;
  return {
    kind: side === 'up' ? 'up_departure_retest' : 'down_departure_retest',
    label: side === 'up' ? '向上离开回试结构' : '向下离开回试结构',
    level: 'segment', scope: 'segment_geometry', status: 'confirmed',
    time: exact ? (point?.time ?? (side === 'up' ? retracement.low_time : retracement.high_time)) : null,
    price: exact ? (side === 'up' ? retracement.low : retracement.high) : null,
    price_bounds: side === 'up' ? [b.low_min, b.low_max] : [b.high_min, b.high_max],
    confirmed_time: confirmedTime,
    zone_id: zone.id, departure_id: segmentId(departure), retracement_id: segmentId(retracement),
    departure, retracement,
    basis: '完成线段离开后首次完成反向线段整体严格位于核心外；仅为本图最低结构层几何关系',
  };
}

function makeZone(segments, start, confirmationTimes, previous) {
  const first = segments.slice(start, start + ZS_MIN_SEGMENTS);
  const upperValue = Math.min(...first.map(segment => bounds(segment).high_min));
  const lowerValue = Math.max(...first.map(segment => bounds(segment).low_max));
  // An uncertain member may tie the fixed core boundary but not actually
  // provide that boundary on every admissible path. Cite an exact contributor.
  const upper = first.find(segment => bounds(segment).high_min === upperValue && bounds(segment).high_max === upperValue);
  const lower = first.find(segment => bounds(segment).low_min === lowerValue && bounds(segment).low_max === lowerValue);
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
    algorithm: 'confirmed_segment_sequence', ruleVersion: ZS_RULE_VERSION, confirmed: true,
    confirmed_time: Math.max(confirmationTimes[start + 2], previous?.closed_time ?? 0),
    closed_time: null, boundary_policy: { ...BOUNDARY_POLICY },
    status: 'active', phase: 'extending', departure: null, retest: null, thirdSignal: null,
    evidence: {
      formation: evidenceFor(first, start, confirmationTimes[start + 2], 'three_completed_segments'),
      previous_zone: previous ? { id: previous.id, closed_time: previous.closed_time } : null,
      extension: null, closure: null,
    },
  };
}

function finishRange(zone, segments, confirmationTimes) {
  const members = segments.slice(zone.startIndex, zone.endIndex + 1);
  const zSegments = members.filter((segment) => segment.direction === zone.formation_direction);
  zone.segment_count = members.length;
  zone.segment_ids = members.map(segmentId);
  zone.z_segment_ids = zSegments.map(segmentId);
  zone.edt = members.at(-1).end.time;
  const aggregate = (items, op, lowKey, highKey) => {
    const lower = op(...items.map(item => bounds(item)[lowKey]));
    const upper = op(...items.map(item => bounds(item)[highKey]));
    return { value: lower === upper ? lower : null, bounds: [lower, upper] };
  };
  const metrics = {
    gg: aggregate(zSegments, Math.max, 'high_min', 'high_max'),
    dd: aggregate(zSegments, Math.min, 'low_min', 'low_max'),
    g: aggregate(zSegments, Math.min, 'high_min', 'high_max'),
    d: aggregate(zSegments, Math.max, 'low_min', 'low_max'),
    range_high: aggregate(members, Math.max, 'high_min', 'high_max'),
    range_low: aggregate(members, Math.min, 'low_min', 'low_max'),
  };
  for (const [name, metric] of Object.entries(metrics)) zone[name] = metric.value;
  zone.range_bounds = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, metric.bounds]));
  zone.evidence.extension = evidenceFor(members, zone.startIndex,
    Math.max(zone.confirmed_time, confirmationTimes[zone.endIndex]), 'fixed_core_extension');
}

/** Compare the stored Z-segment price envelopes. This is a lowest-layer
 * geometric comparison, not proof that either input is an independently
 * completed same-level movement or that a higher-level center exists.
 *
 * The sequential builder can reuse the departure segment as a new center's
 * first segment. In that case the two candidate envelopes are not independent:
 * their overlap may be caused by construction, even if the departure is not
 * a Z segment of the older center. Do not infer expansion or trend from it.
 */
export function compareCenterGeometry(previous, current) {
  const previousZ = previous.z_segment_ids ?? [];
  const currentZ = current.z_segment_ids ?? [];
  const currentSegments = current.segment_ids ?? [];
  const sharedZ = currentZ.filter(id => previousZ.includes(id));
  const departureId = previous.departure ? segmentId(previous.departure) : null;
  const departureReused = departureId != null && currentSegments.includes(departureId);
  const validRanges = [current.dd, current.gg, previous.dd, previous.gg].every(Number.isFinite);
  const relation = !validRanges ? 'uncertain'
    : current.dd > previous.gg ? 'up_separated'
      : current.gg < previous.dd ? 'down_separated' : 'overlapping_fluctuations';
  return {
    relation,
    // True requests higher-level investigation; it does not establish one.
    // With reused departure or incomplete outer bounds even that inference is
    // unresolved under this provisional sequential decomposition.
    requires_recursive_level: !validRanges || departureReused ? null : relation === 'overlapping_fluctuations',
    relation_evidence: {
      kind: 'segment_geometry_only', previous_zone_id: previous.id, current_zone_id: current.id,
      previous_z_segment_ids: [...previousZ], current_z_segment_ids: [...currentZ],
      shared_z_segment_ids: sharedZ, departure_id: departureId, departure_reused: departureReused,
      previous_envelope: [previous.dd, previous.gg], current_envelope: [current.dd, current.gg],
      history_coverage: 'not_verified', movement_classification: 'not_verified', recursive_level: 'not_computed',
    },
  };
}

/**
 * 输入必须为完成线段对象。笔端点 / 未确认线段不参与中枢。
 * 中枢结束后允许离开段作为下一核心首段，避免漏掉最早的连续三段。
 * 这是本图最低层的顺序几何构造，未建立高层走势类型的唯一分解或递归。
 */
export function buildZsDetailed(inputSegments) {
  const segments = [];
  const confirmationTimes = [];
  for (const segment of inputSegments) {
    if (!validSegment(segment)) break;
    if (segments.length && !connected(segments.at(-1), segment)) break;
    segments.push(segment);
    confirmationTimes.push(Math.max(confirmationTimes.at(-1) ?? 0, segment.confirmed_time));
  }
  const zones = [];
  const uncertainties = [];
  const uncertainty = (kind, startIndex, affected, confirmedTime, extra = {}) => {
    const item = { kind, reason: 'endpoint_order', startIndex, confirmed_time: confirmedTime,
      segments: affected.map(s => ({ id: segmentId(s), start: { ...s.start }, end: { ...s.end },
        range_bounds: { ...bounds(s) } })),
      unprocessed_segment_ids: segments.slice(startIndex).map(segmentId), ...extra };
    uncertainties.push(item);
    return item;
  };
  let start = 0;
  while (start + ZS_MIN_SEGMENTS <= segments.length) {
    const head = segments.slice(start, start + ZS_MIN_SEGMENTS);
    const previous = zones.at(-1);
    const zg = Math.min(...head.map(segment => bounds(segment).high_min));
    const zgMax = Math.min(...head.map(segment => bounds(segment).high_max));
    const zd = Math.max(...head.map(segment => bounds(segment).low_max));
    const zdMin = Math.max(...head.map(segment => bounds(segment).low_min));
    if (zgMax <= zdMin) { start++; continue; }
    if (zg <= zd || zg !== zgMax || zd !== zdMin) {
      uncertainty('formation', start, head, Math.max(confirmationTimes[start + 2], previous?.closed_time ?? 0),
        { zg_bounds: [zg, zgMax], zd_bounds: [zdMin, zd] });
      break;
    }
    const zone = makeZone(segments, start, confirmationTimes, previous);
    zone.evidence.formation.confirmed_time = zone.confirmed_time;
    let nextStart = segments.length;
    // 构成中枢的第三段也可能同时是离开段；其后的首次回试必须纳入检查。
    for (let index = start + ZS_MIN_SEGMENTS - 1; index < segments.length; index++) {
      const segment = segments[index];
      const next = segments[index + 1];
      const side = departureSide(segment, zd, zg);
      const overlap = overlapState(segment, zd, zg);
      const outside = side && next ? outsideState(next, side, zd, zg) : null;
      if (overlap === 'unknown' || (side && next && overlap === 'yes' && outside === 'unknown')) {
        zone.status = 'uncertain';
        zone.phase = 'uncertain';
        zone.uncertainty = uncertainty('lifecycle', start, next && outside === 'unknown' ? [segment, next] : [segment],
          Math.max(zone.confirmed_time, confirmationTimes[index + (next && outside === 'unknown' ? 1 : 0)]));
        break;
      }
      const retest = side && outside === 'yes' ? departureRetest(segment, next, zone,
        Math.max(zone.confirmed_time, confirmationTimes[index + 1] ?? 0)) : null;
      if (retest) {
        zone.status = 'closed';
        zone.phase = 'completed';
        // 第 20 课的 Z 段只要触枢仍属于延伸。离开段若与成枢方向一致也须计入。
        if (segment.direction === zone.formation_direction) zone.endIndex = index;
        zone.departure = segment;
        zone.retest = retest;
        // Retained API alias; this is explicitly segment geometry, never a trade.
        zone.thirdSignal = retest;
        zone.closed_time = retest.confirmed_time;
        zone.evidence.closure = evidenceFor([segment, next], index, zone.closed_time,
          'first_retest_strictly_outside');
        nextStart = index;
        break;
      }
      if (side && !next && overlap === 'yes') {
        zone.phase = 'leaving';
        zone.departure = segment;
        if (segment.direction === zone.formation_direction) zone.endIndex = index;
        break;
      }
      if (overlap === 'no') {
        // 单个离枢段尚不等于三买卖。Z 段不触枢，或连续两段不触枢，延伸停止。
        const zDirection = segment.direction === zone.formation_direction;
        const nextOverlap = next ? overlapState(next, zd, zg) : null;
        if (!zDirection && nextOverlap === 'unknown') {
          zone.status = 'uncertain';
          zone.phase = 'uncertain';
          zone.uncertainty = uncertainty('lifecycle', start, [segment, next],
            Math.max(zone.confirmed_time, confirmationTimes[index + 1]));
          break;
        }
        if (zDirection || nextOverlap === 'no') {
          zone.status = 'closed';
          zone.phase = 'departed';
          zone.departure = segment;
          const evidenceEnd = zDirection ? index : index + 1;
          zone.closed_time = Math.max(zone.confirmed_time, confirmationTimes[evidenceEnd]);
          zone.evidence.closure = evidenceFor(segments.slice(index, evidenceEnd + 1), index,
            zone.closed_time, zDirection ? 'z_segment_outside' : 'two_consecutive_segments_outside');
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
    finishRange(zone, segments, confirmationTimes);
    if (previous) {
      Object.assign(zone, compareCenterGeometry(previous, zone));
    }
    zones.push(zone);
    start = Math.max(start + 1, nextStart);
  }
  return { zones, uncertainties };
}

export const buildZs = inputSegments => buildZsDetailed(inputSegments).zones;

/** 现价相对本图最小级别线段中枢的位置。 */
export function positionVsZs(price, zs) {
  if (!zs) return { vs: 'none', label: '无已确认线段中枢' };
  if (price > zs.zg) return { vs: 'above', label: '中枢上方' };
  if (price < zs.zd) return { vs: 'below', label: '中枢下方' };
  return { vs: 'inside', label: '中枢内部' };
}
