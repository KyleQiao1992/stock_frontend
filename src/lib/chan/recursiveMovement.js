/**
 * A narrow, conditional implementation of the examples in lesson 43:
 * https://blog.sina.com.cn/s/blog_486e105c010009mm.html
 *
 * Inputs are CALLER-ASSERTED trend centers and divergence events. This function
 * checks their geometry and chronology, not whether the underlying data really
 * prove a divergence, center, level or trend. It must not turn its result into
 * a confirmed market movement or trading signal. Only the selected same-level
 * decomposition view is covered. It does not implement the full decomposition,
 * consolidation endings, or a divergence detector.
 */

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`);
}

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
}

function observed(event, asOfTime, unconfirmedReason, futureReason) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  if (event.status === 'pending') return { status: 'pending', reason: unconfirmedReason };
  if (event.status !== 'confirmed') throw new TypeError('event status must be pending or confirmed');
  integer(event.confirmed_time, 'event confirmed_time', 1);
  if (event.confirmed_time > asOfTime) return { status: 'pending', reason: futureReason };
  return null;
}

function validateCenter(center, { basis, level }) {
  if (center.kind !== 'center') throw new TypeError('center kind is required');
  identity(center.id, 'center id');
  if (center.basis !== basis) throw new RangeError('center basis must match trend basis');
  if (center.level !== level) throw new RangeError('center level must match trend level');
  integer(center.sdt, 'center start time', 1);
  integer(center.edt, 'center end time', 1);
  if (center.sdt >= center.edt || center.confirmed_time < center.edt) {
    throw new RangeError('center time ordering is invalid');
  }
  if (![center.dd, center.zd, center.zg, center.gg].every(Number.isFinite)
      || center.dd > center.zd || center.zd >= center.zg || center.zg > center.gg) {
    throw new RangeError('center peripheral and core ranges are invalid');
  }
}

/**
 * Observation times use a single caller-identified basis and ordinal clock.
 * The historical boundary and when it became observable are distinct. The
 * surrounding-wave intervals [DD, GG] are used for the lesson 20 geometry;
 * touching is explicitly counted as overlap. This is a selected convention,
 * not a universal resolution of original-text equality questions.
 *
 * When a lower-level divergence is followed by a same-level center strictly
 * beyond the previous center in the original trend direction, the example
 * continues; overlap yields the conditional same-level decomposition boundary.
 * An opposite-side disjoint center is outside this narrow example.
 */
export function evaluateTrendCompletion({ trend, divergence, thirdPoint, nextCenter, sameLevelDivergenceExclusion, asOfTime } = {}) {
  integer(asOfTime, 'asOfTime', 1);
  if (!trend || typeof trend !== 'object') throw new TypeError('trend is required');
  identity(trend.basis, 'trend basis');
  integer(trend.level, 'trend level', 1);
  if (trend.direction !== 'up' && trend.direction !== 'down') throw new TypeError('trend direction is invalid');
  if (trend.decomposition !== 'same_level') return { status: 'indeterminate', reason: 'same_level_decomposition_required' };
  if (!Array.isArray(trend.centers)) throw new TypeError('trend centers are required');
  if (trend.centers.length < 2) return { status: 'indeterminate', reason: 'fewer_than_two_trend_centers' };

  let prior = null;
  let knownAt = 0;
  const ids = new Set();
  for (const center of trend.centers) {
    const waiting = observed(center, asOfTime, 'trend_center_unconfirmed', 'trend_center_not_observed');
    if (waiting) return waiting;
    validateCenter(center, trend);
    if (ids.has(center.id)) throw new RangeError('center IDs must be unique');
    ids.add(center.id);
    if (prior && center.sdt < prior.edt) throw new RangeError('trend center time ordering is invalid');
    if (prior && !(trend.direction === 'up' ? center.dd > prior.gg : center.gg < prior.dd)) {
      return { status: 'indeterminate', reason: 'centers_do_not_prove_same_direction_trend' };
    }
    knownAt = Math.max(knownAt, center.confirmed_time);
    prior = center;
  }

  if (!divergence) return { status: 'pending', reason: 'divergence_missing' };
  const waiting = observed(divergence, asOfTime, 'divergence_unconfirmed', 'divergence_not_observed');
  if (waiting) return waiting;
  if (divergence.kind !== 'trend_divergence') throw new TypeError('trend divergence event is required');
  identity(divergence.id, 'divergence id');
  if (divergence.basis !== trend.basis) throw new RangeError('divergence basis must match trend basis');
  integer(divergence.level, 'divergence level');
  if (divergence.level > trend.level) throw new RangeError('divergence level cannot exceed trend level');
  if (divergence.side !== (trend.direction === 'up' ? 'top' : 'bottom')) throw new RangeError('divergence side contradicts trend');
  integer(divergence.point?.time, 'divergence point time', 1);
  if (!Number.isFinite(divergence.point?.price)) throw new TypeError('divergence point price must be finite');
  if (divergence.point.time < prior.edt || divergence.confirmed_time < divergence.point.time) {
    throw new RangeError('divergence time ordering is invalid');
  }
  // Lesson 37 requires a new extreme for the trend-divergence example. Going
  // beyond the last center's peripheral extreme is necessary in this selected
  // case, but alone does not prove a new overall extreme or the required retest.
  if (trend.direction === 'up' ? divergence.point.price <= prior.gg : divergence.point.price >= prior.dd) {
    return { status: 'indeterminate', reason: 'divergence_point_not_beyond_last_center_extreme' };
  }
  knownAt = Math.max(knownAt, divergence.confirmed_time);
  const boundary = () => ({ time: divergence.point.time, price: divergence.point.price, observed_at: knownAt });
  const evidence = { trend_center_ids: trend.centers.map(center => center.id), divergence_id: divergence.id };

  // Lesson 37 requires the final trend leg to contain a third-class point of
  // the last center. This is caller-asserted; geometry alone is not proof of
  // departure, the first retest, or independently classified movements.
  if (!thirdPoint) return { status: 'indeterminate', reason: 'third_class_retest_missing' };
  const thirdWaiting = observed(thirdPoint, asOfTime, 'third_class_retest_unconfirmed', 'third_class_retest_not_observed');
  if (thirdWaiting) return thirdWaiting;
  if (thirdPoint.kind !== 'third_class_retest') throw new TypeError('third-class retest event is required');
  identity(thirdPoint.id, 'third-class retest id');
  if (thirdPoint.basis !== trend.basis) throw new RangeError('third-class retest basis must match trend basis');
  if (thirdPoint.level !== trend.level) throw new RangeError('third-class retest level must match trend level');
  if (thirdPoint.center_id !== prior.id) throw new RangeError('third-class retest must reference the last center');
  if (thirdPoint.side !== (trend.direction === 'up' ? 'buy' : 'sell')) throw new RangeError('third-class retest side contradicts trend');
  integer(thirdPoint.point?.time, 'third-class retest point time', 1);
  if (!Number.isFinite(thirdPoint.point?.price)) throw new TypeError('third-class retest point price must be finite');
  if (thirdPoint.point.time < prior.edt || thirdPoint.point.time >= divergence.point.time
      || thirdPoint.confirmed_time < thirdPoint.point.time) throw new RangeError('third-class retest time ordering is invalid');
  if (trend.direction === 'up' ? thirdPoint.point.price <= prior.zg : thirdPoint.point.price >= prior.zd) {
    return { status: 'indeterminate', reason: 'third_class_retest_not_strictly_outside' };
  }
  // Lesson 37 requires the final trend leg to make a new directional extreme.
  // A later claimed extreme cannot be new if the earlier third-class retest
  // has already reached it. Passing this necessary check is not proof that it
  // exceeds every earlier price, which this caller-supplied model does not see.
  if (trend.direction === 'up' ? divergence.point.price <= thirdPoint.point.price
    : divergence.point.price >= thirdPoint.point.price) {
    return { status: 'indeterminate', reason: 'divergence_point_not_beyond_third_retest' };
  }
  knownAt = Math.max(knownAt, thirdPoint.confirmed_time);
  evidence.third_point_id = thirdPoint.id;

  if (divergence.level === trend.level) return {
    status: 'conditional_completed', reason: 'same_level_trend_divergence',
    boundary: boundary(), evidence_proof: 'caller_supplied', evidence,
  };

  // Lesson 43's smaller-level example explicitly assumes same-level trend
  // divergence did not occur. This is another caller claim, not a detector.
  if (!sameLevelDivergenceExclusion) return { status: 'indeterminate', reason: 'same_level_divergence_not_excluded' };
  const exclusionWaiting = observed(sameLevelDivergenceExclusion, asOfTime,
    'same_level_divergence_exclusion_unconfirmed', 'same_level_divergence_exclusion_not_observed');
  if (exclusionWaiting) return exclusionWaiting;
  if (sameLevelDivergenceExclusion.kind !== 'same_level_divergence_excluded') {
    throw new TypeError('same-level divergence exclusion event is required');
  }
  identity(sameLevelDivergenceExclusion.id, 'same-level divergence exclusion id');
  if (sameLevelDivergenceExclusion.basis !== trend.basis) throw new RangeError('exclusion basis must match trend basis');
  if (sameLevelDivergenceExclusion.level !== trend.level) throw new RangeError('exclusion level must match trend level');
  if (sameLevelDivergenceExclusion.confirmed_time < divergence.point.time) {
    throw new RangeError('exclusion time precedes divergence point');
  }
  knownAt = Math.max(knownAt, sameLevelDivergenceExclusion.confirmed_time);
  evidence.exclusion_id = sameLevelDivergenceExclusion.id;

  if (!nextCenter) return { status: 'pending', reason: 'next_center_missing' };
  const nextWaiting = observed(nextCenter, asOfTime, 'next_center_unconfirmed', 'next_center_not_observed');
  if (nextWaiting) return nextWaiting;
  validateCenter(nextCenter, trend);
  if (ids.has(nextCenter.id)) throw new RangeError('center IDs must be unique');
  if (nextCenter.sdt < divergence.point.time) throw new RangeError('next center time precedes divergence point');
  knownAt = Math.max(knownAt, nextCenter.confirmed_time);

  // Lesson 20's expansion comparison describes distinct same-level cores.
  // Overlapping or touching cores can instead belong to extension and require
  // a separate decomposition; do not settle that case here.
  if (nextCenter.zd <= prior.zg && nextCenter.zg >= prior.zd) {
    return { status: 'indeterminate', reason: 'cores_overlap_or_touch_not_covered' };
  }

  const intersects = nextCenter.dd <= prior.gg && nextCenter.gg >= prior.dd;
  if (intersects) return {
    status: 'conditional_completed', reason: 'lower_divergence_followed_by_overlapping_center',
    boundary: boundary(), boundary_policy: 'peripheral_touch_counts_as_overlap',
    evidence_proof: 'caller_supplied', evidence: { ...evidence, next_center_id: nextCenter.id },
  };
  const continuation = trend.direction === 'up' ? nextCenter.dd > prior.gg : nextCenter.gg < prior.dd;
  if (!continuation) return { status: 'indeterminate', reason: 'opposite_side_separation_not_covered' };
  return {
    status: 'conditional_continuation', reason: 'next_center_separated_in_trend_direction',
    observed_at: knownAt, evidence_proof: 'caller_supplied', evidence: { ...evidence, next_center_id: nextCenter.id },
  };
}
