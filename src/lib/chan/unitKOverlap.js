import { prepareRecursiveSource } from './recursiveSource.js';

/**
 * Candidate overlaps in a caller-selected irreducible unit-K basis.
 * Lesson 17 describes the lowest level in terms of at least three unit K
 * bars: https://blog.sina.com.cn/s/blog_486e105c010007p1.html
 *
 * This enumerates *each* consecutive three-bar window independently. It
 * does not merge windows, infer a center's lifetime or level extension, or
 * identify an independently completed trend/consolidation. The selected
 * period is a caller declaration, not proof of structural level or that
 * the market-data history is complete. Equal-boundary contact is reported
 * separately rather than asserting that the original text resolves it.
 *
 * A bar with complete:true is observable at its own ordinal; a missing
 * completion flag is observable only when the next bar has arrived. A bar
 * explicitly complete:false is not inferred complete merely from later data.
 * Calling on a historical prefix never looks into a subsequent prefix.
 */
export function findUnitKOverlapCandidates(rows, provenance) {
  const source = prepareRecursiveSource(rows, provenance);
  const { bars, basis } = source;
  for (const [index, bar] of bars.entries()) {
    if (Object.hasOwn(bar, 'volume') && (!Number.isFinite(bar.volume) || bar.volume < 0)) {
      throw new RangeError(`source row ${index + 1} has invalid volume`);
    }
  }
  const closedAt = bar => bar.complete === true ? bar.time
    : bar.complete === false ? null : bar.time < bars.length ? bar.time + 1 : null;
  const candidates = [], boundaryTouches = [], pending = [];
  for (let start = 0; start + 2 < bars.length; start++) {
    const window = bars.slice(start, start + 3);
    const confirmedTimes = window.map(closedAt);
    const startTime = window[0].time, endTime = window[2].time;
    if (confirmedTimes.some(time => time == null)) {
      pending.push({ start: startTime, end: endTime,
        reason: window.some(bar => bar.complete === false) ? 'explicitly_unfinished_k' : 'completion_not_observed' });
      continue;
    }
    const zd = Math.max(...window.map(bar => bar.low));
    const zg = Math.min(...window.map(bar => bar.high));
    if (zd > zg) continue;
    const overlap = {
      id: `unit-k-${startTime}-${endTime}`, kind: 'unit_k_three_overlap_candidate', basis,
      start: startTime, end: endTime, zd, zg, observed_at: Math.max(...confirmedTimes),
      evidence: window.map((bar, i) => ({ time: bar.time, date: bar.date,
        low: bar.low, high: bar.high, complete: bar.complete ?? null, observed_at: confirmedTimes[i] })),
    };
    if (zd === zg) boundaryTouches.push({ ...overlap, status: 'boundary_touch_only' });
    else candidates.push({ ...overlap, status: 'positive_width_overlap' });
  }
  return { basis, provenance: source.provenance, coverage: source.coverage,
    selection: 'caller_selected_irreducible_unit_k', boundaryPolicy: 'report_zero_width_separately',
    scope: 'independent_three_bar_candidates_not_movement_or_recursive_center',
    candidates, boundaryTouches, pending };
}
