/**
 * Research-only conservative frontier for the existing segment-center geometry.
 * This does not detect recursive Chan movements or verify input provenance.
 *
 * Every actual segment extremum MUST lie within the caller-provided bounds.
 * Bounds are treated independently, deliberately allowing impossible joint
 * assignments. Consequently the result may miss a real common center; a core
 * is returned only when every over-approximated state contains the exact same
 * formation triple and the same exact ZD/ZG. Continuous ranges are not sampled.
 *
 * Kept separate from the main chart. The transition conventions mirror the
 * current lowest-layer geometric code, not a proof of full original theory.
 */
const LIMIT = Symbol('state_limit');

function validateSegment(s, previous) {
  if (!s || typeof s.id !== 'string' || !s.id) throw new TypeError('segment id is required');
  if (!s.start || !s.end || ![s.start.time, s.end.time, s.start.price, s.end.price, s.confirmed_time].every(Number.isFinite)) {
    throw new TypeError('segment points and confirmation time are required');
  }
  if (![s.start.time, s.end.time, s.confirmed_time].every(value => Number.isSafeInteger(value) && value >= 1)) {
    throw new TypeError('segment time and confirmation time must be positive integers');
  }
  if (s.start.time >= s.end.time || s.confirmed_time < s.end.time) throw new RangeError('segment time ordering is invalid');
  if (s.direction !== 'up' && s.direction !== 'down') throw new TypeError('segment direction is invalid');
  if (s.direction === 'up' ? s.end.price <= s.start.price : s.end.price >= s.start.price) {
    throw new RangeError('segment direction contradicts endpoints');
  }
  if (previous && (previous.end.time !== s.start.time || previous.end.price !== s.start.price
    || previous.direction === s.direction
    || (previous.end.idx !== undefined && s.start.idx !== undefined && previous.end.idx !== s.start.idx))) {
    throw new RangeError('segments must have connected alternating endpoints');
  }
  const b = s.range_bounds;
  if (!b || ![b.low_min, b.low_max, b.high_min, b.high_max].every(Number.isFinite)
    || b.low_min > b.low_max || b.high_min > b.high_max || b.low_max > b.high_min
    || b.low_max > Math.min(s.start.price, s.end.price)
    || b.high_min < Math.max(s.start.price, s.end.price)
    || (s.low !== undefined && s.low !== b.low_max)
    || (s.high !== undefined && s.high !== b.high_min)) throw new RangeError('segment range bounds are invalid');
}

// Each pair contains every outcome that an independently bounded realization
// could take. Ignoring cross-segment correlations deliberately over-approximates.
function formationOptions(zd, zg) {
  return [ ...(zd[0] < zg[1] ? [true] : []), ...(zd[1] >= zg[0] ? [false] : []) ];
}
function overlapOptions(segment, zone) {
  const b = segment.range_bounds;
  return [ ...(b.high_max >= zone.zd[0] && b.low_min <= zone.zg[1] ? [true] : []),
    ...(b.high_min < zone.zd[1] || b.low_max > zone.zg[0] ? [false] : []) ];
}
function sideOptions(segment, zone) {
  const price = segment.end.price;
  if (segment.direction === 'up') return [ ...(price > zone.zg[0] ? ['up'] : []),
    ...(price <= zone.zg[1] ? [null] : []) ];
  return [ ...(price < zone.zd[1] ? ['down'] : []), ...(price >= zone.zd[0] ? [null] : []) ];
}
function outsideOptions(segment, side, zone) {
  const b = segment.range_bounds;
  if (side === 'up') return [ ...(b.low_max > zone.zg[0] ? [true] : []),
    ...(b.low_min <= zone.zg[1] ? [false] : []) ];
  return [ ...(b.high_min < zone.zd[1] ? [true] : []), ...(b.high_max >= zone.zd[0] ? [false] : []) ];
}

export function analyzeSegmentCenterFrontier(inputSegments, { asOfTime, maxStates = 20000 } = {}) {
  if (!Array.isArray(inputSegments)) throw new TypeError('segments must be an array');
  if (!Number.isSafeInteger(asOfTime) || asOfTime < 1) throw new TypeError('asOfTime must be a positive integer');
  if (!Number.isSafeInteger(maxStates) || maxStates < 1) throw new TypeError('maxStates must be a positive integer');
  const segments = [], ids = new Set();
  for (const s of inputSegments) {
    // Do not inspect the details of an unobserved future segment.
    if (s?.confirmed !== true) break;
    if (!Number.isSafeInteger(s.confirmed_time) || s.confirmed_time < 1) {
      throw new TypeError('segment confirmation time must be a positive integer');
    }
    if (s.confirmed_time > asOfTime) break;
    validateSegment(s, segments.at(-1));
    if (ids.has(s.id)) throw new RangeError('segment IDs must be unique');
    ids.add(s.id);
    segments.push(s);
  }
  let exploredStates = 0;
  const terminal = [];
  const stack = [{ phase: 'search', start: 0, zones: [] }];
  const add = state => stack.push(state);
  const finish = (state, status, nextStart) => {
    const zones = [...state.zones, { ...state.zone, status }];
    if (nextStart == null) terminal.push(zones);
    else add({ phase: 'search', start: Math.max(state.start + 1, nextStart), zones });
  };
  try {
    while (stack.length) {
      if (++exploredStates > maxStates) throw LIMIT;
      const state = stack.pop();
      if (state.phase === 'search') {
        if (state.start + 2 >= segments.length) { terminal.push(state.zones); continue; }
        const first = segments.slice(state.start, state.start + 3);
        const zd = [Math.max(...first.map(s => s.range_bounds.low_min)), Math.max(...first.map(s => s.range_bounds.low_max))];
        const zg = [Math.min(...first.map(s => s.range_bounds.high_min)), Math.min(...first.map(s => s.range_bounds.high_max))];
        for (const forms of formationOptions(zd, zg)) {
          if (!forms) add({ ...state, start: state.start + 1 });
          else add({ ...state, phase: 'zone', index: state.start + 2,
            zone: { start_index: state.start, source_segment_ids: first.map(s => s.id),
              zd, zg, formation_direction: first[0].direction } });
        }
        continue;
      }
      if (state.index >= segments.length) { finish(state, 'active', null); continue; }
      const segment = segments[state.index], next = segments[state.index + 1], zone = state.zone;
      const advance = () => add({ ...state, index: state.index + 1 });
      for (const side of sideOptions(segment, zone)) for (const overlaps of overlapOptions(segment, zone)) {
        if (side && next && overlaps) {
          for (const outside of outsideOptions(next, side, zone)) {
            if (outside) finish(state, 'closed', state.index);
            else advance();
          }
        } else if (side && !next && overlaps) finish(state, 'active', null);
        else if (!overlaps) {
          if (segment.direction === zone.formation_direction) finish(state, 'closed', state.index);
          else if (next) for (const nextOverlaps of overlapOptions(next, zone)) {
            if (nextOverlaps) advance();
            else finish(state, 'closed', state.index);
          }
          else finish(state, 'active', null);
        } else advance();
      }
    }
  } catch (error) {
    if (error !== LIMIT) throw error;
    return { status: 'indeterminate', reason: 'state_limit', cores: [], observed_segment_count: segments.length };
  }

  // A result only claims the formation core. Core extension/closure can differ
  // between paths and is labelled uncertain in that case. No path is preferred.
  const exact = zone => zone.zd[0] === zone.zd[1] && zone.zg[0] === zone.zg[1];
  const cores = (terminal[0] ?? []).filter(exact).flatMap(zone => {
    const matches = terminal.map(zones => zones.find(other => other.start_index === zone.start_index
      && exact(other) && other.zd[0] === zone.zd[0] && other.zg[0] === zone.zg[0]));
    if (matches.some(match => !match)) return [];
    const statuses = new Set(matches.map(match => match.status));
    return [{ start_index: zone.start_index, source_segment_ids: [...zone.source_segment_ids],
      zd: zone.zd[0], zg: zone.zg[0], status: statuses.size === 1 ? zone.status : 'uncertain', observed_at: asOfTime }];
  });
  const ambiguous = terminal.length > 1 || terminal.some(zones => zones.some(zone => !exact(zone)));
  return { status: ambiguous ? 'indeterminate' : 'conditional',
    ...(ambiguous ? { reason: 'multiple_possible_paths' } : {}),
    source_proof: 'caller_supplied_bounds', observed_segment_count: segments.length, ambiguous, cores,
    explored_states: exploredStates, terminal_states: terminal.length };
}
