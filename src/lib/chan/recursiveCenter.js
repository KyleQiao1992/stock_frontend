/**
 * Core formation from three already-established, consecutive movements of the
 * same next-lower structural level (lesson 18). This is a narrow mathematical
 * operation, NOT a movement decomposition, lifecycle, level-expansion engine,
 * or verification that the supplied movement classification is correct.
 *
 * Time values are integer coordinates in one explicitly identified data basis.
 * Prices must cover the entire movement, including interior extremes. Supplied
 * raw candles verify the range and evidence times; the caller remains responsible
 * for proving the movement classifications and completion from structure.
 */
const MOVE_TYPES = new Set(['up', 'down', 'consolidation']);
const STATUSES = new Set(['confirmed', 'pending']);

function requireInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
}

function validateMove(move, index, targetLevel) {
  const prefix = `moves[${index}]`;
  if (!move || typeof move !== 'object' || Array.isArray(move)) throw new TypeError(`${prefix} must be an object`);
  if (move.kind !== 'movement') throw new TypeError(`${prefix}.kind must be movement, not a segment or stroke`);
  if (typeof move.id !== 'string' || !move.id.trim()) throw new TypeError(`${prefix}.id is required`);
  if (typeof move.basis !== 'string' || !move.basis.trim()) throw new TypeError(`${prefix}.basis is required`);
  if (!MOVE_TYPES.has(move.type)) throw new TypeError(`${prefix}.type is invalid`);
  if (!STATUSES.has(move.status)) throw new TypeError(`${prefix}.status is invalid`);
  requireInteger(move.level, `${prefix}.level`);
  if (move.level !== targetLevel - 1) throw new RangeError(`${prefix} must be exactly one structural level below target`);
  for (const name of ['start', 'end']) {
    if (!move[name] || typeof move[name] !== 'object') throw new TypeError(`${prefix}.${name} is required`);
    requireInteger(move[name].time, `${prefix}.${name}.time`, 1);
    if (!Number.isFinite(move[name].price)) throw new TypeError(`${prefix}.${name}.price must be finite`);
  }
  if (move.start.time >= move.end.time) throw new RangeError(`${prefix} must have increasing endpoint times`);
  if (!Number.isFinite(move.low) || !Number.isFinite(move.high) || move.low >= move.high) {
    throw new RangeError(`${prefix} must have a finite positive-width price range`);
  }
  if (Math.min(move.start.price, move.end.price) < move.low || Math.max(move.start.price, move.end.price) > move.high) {
    throw new RangeError(`${prefix} range must contain both endpoint prices`);
  }
  if ((move.type === 'up' && move.end.price <= move.start.price)
      || (move.type === 'down' && move.end.price >= move.start.price)) {
    throw new RangeError(`${prefix} direction contradicts endpoint prices`);
  }
  if (move.status === 'confirmed') {
    requireInteger(move.confirmed_time, `${prefix}.confirmed_time`, 1);
    if (move.confirmed_time < move.end.time) throw new RangeError(`${prefix} cannot be confirmed before its endpoint`);
  } else if (move.confirmed_time != null) throw new TypeError(`${prefix} pending movement cannot have confirmation time`);
}

/**
 * Form only the INITIAL core from supplied movements. Later movements are not
 * used to extend or end it. The input needs a decomposition that independently
 * proves each movement's type, level, completion and full actual range.
 *
 * Returns conditional / pending / disjoint / indeterminate; invalid or discontinuous evidence
 * throws. Even a price-valid triple is conditional until a separate engine
 * independently proves the supplied movement classifications and completion.
 * Equality is deliberately treated as a zero-width, non-forming contact under
 * this version's explicit convention; this is not a universal ruling on all
 * original-text boundary wording.
 */
// An immutable snapshot lets a multi-window extension validate history once
// without permitting later caller changes to bypass that validation.
export function createCenterFormationInspector({ targetLevel, asOfTime, source } = {}) {
  requireInteger(targetLevel, 'targetLevel', 1);
  requireInteger(asOfTime, 'asOfTime', 1);
  if (!source || typeof source !== 'object') {
    throw new TypeError('source basis and bars are required');
  }
  const { basis, bars } = source;
  if (typeof basis !== 'string' || !basis.trim() || !Array.isArray(bars)) {
    throw new TypeError('source basis and bars are required');
  }
  if (bars.length < asOfTime) throw new RangeError('source does not include the requested asOfTime');
  // One-based bar coordinates match analyzeChan's existing data contract.
  // Read only bars available as of the observation, never a future suffix.
  const checkedBars = [];
  for (let i = 0; i < asOfTime; i++) {
    const bar = bars[i];
    if (!bar || bar.time !== i + 1) throw new RangeError('source bar times must be complete and consecutive');
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low) || bar.high < bar.low) {
      throw new RangeError(`source bar ${i + 1} has an invalid price range`);
    }
    if (bar.complete != null && typeof bar.complete !== 'boolean') {
      throw new TypeError(`source bar ${i + 1} has an invalid completion state`);
    }
    checkedBars.push(Object.freeze({ time: bar.time, high: bar.high, low: bar.low, complete: bar.complete }));
  }
  const checkedSource = Object.freeze({ basis, bars: Object.freeze(checkedBars) });
  const form = moves => formCenterFromCheckedSource(moves, { targetLevel, asOfTime, source: checkedSource });
  return Object.freeze({ source: checkedSource, form });
}

export function formCenterFromMoves(moves, options = {}) {
  if (!Array.isArray(moves)) throw new TypeError('moves must be an array');
  return createCenterFormationInspector(options).form(moves);
}

function formCenterFromCheckedSource(moves, { targetLevel, asOfTime, source }) {
  if (!Array.isArray(moves)) throw new TypeError('moves must be an array');
  const first = moves.slice(0, 3);
  const ids = new Set();
  first.forEach((move, index) => {
    validateMove(move, index, targetLevel);
    if (move.basis !== source.basis) throw new RangeError('movement basis must match source basis');
    if (ids.has(move.id)) throw new RangeError('movement IDs must be unique');
    ids.add(move.id);
    if (index > 0) {
      const prior = first[index - 1];
      if (move.basis !== prior.basis) throw new RangeError('movement data bases must match');
      if (move.start.time !== prior.end.time || move.start.price !== prior.end.price) {
        throw new RangeError('movements must share consecutive endpoints');
      }
    }
  });
  if (first.length < 3) return { status: 'pending', reason: 'fewer_than_three_movements' };
  if (first.some(move => move.status !== 'confirmed')) return { status: 'pending', reason: 'movement_unconfirmed' };
  if (first.some(move => move.confirmed_time > asOfTime)) return { status: 'pending', reason: 'confirmation_not_yet_observed' };

  // The caller supplies a structural proof, but the raw-price and K completion
  // parts can be checked here without trusting claimed endpoint-only ranges.
  let evidenceKnownAt = Math.max(...first.map(move => move.confirmed_time));
  const sourceMoves = [];
  for (const move of first) {
    for (let time = move.start.time; time <= move.confirmed_time; time++) {
      const complete = source.bars[time - 1].complete;
      if (complete === false) return { status: 'pending', reason: 'evidence_candle_incomplete' };
      if (complete !== true) {
        // Match referenceEngine: a subsequent same-period K establishes that
        // an unmarked predecessor closed, but never before that K is observed.
        if (time + 1 > asOfTime) return { status: 'pending', reason: 'evidence_candle_incomplete' };
        evidenceKnownAt = Math.max(evidenceKnownAt, time + 1);
      }
    }
    // At an endpoint K, the other extreme may have occurred before the start
    // or after the end. OHLC does not reveal intrabar ordering. Interior bars
    // and the two endpoint prices are guaranteed; the rest is only possible.
    let guaranteedHigh = Math.max(move.start.price, move.end.price);
    let guaranteedLow = Math.min(move.start.price, move.end.price);
    for (let time = move.start.time + 1; time < move.end.time; time++) {
      const bar = source.bars[time - 1];
      guaranteedHigh = Math.max(guaranteedHigh, bar.high);
      guaranteedLow = Math.min(guaranteedLow, bar.low);
    }
    const firstBar = source.bars[move.start.time - 1], lastBar = source.bars[move.end.time - 1];
    const possibleHigh = Math.max(guaranteedHigh, firstBar.high, lastBar.high);
    const possibleLow = Math.min(guaranteedLow, firstBar.low, lastBar.low);
    if (move.high < guaranteedHigh || move.high > possibleHigh
        || move.low > guaranteedLow || move.low < possibleLow) {
      throw new RangeError('movement range does not match source candle bounds');
    }
    for (const endpoint of [move.start, move.end]) {
      const bar = source.bars[endpoint.time - 1];
      if (endpoint.price < bar.low || endpoint.price > bar.high) throw new RangeError('movement endpoint is outside its source candle');
    }
    const rangeCertain = guaranteedHigh === possibleHigh && guaranteedLow === possibleLow;
    const extremeTime = (price, field, guaranteed) => {
      if (!guaranteed) return null;
      const times = [];
      if (move.start.price === price) times.push(move.start.time);
      for (let time = move.start.time + 1; time < move.end.time; time++) {
        if (source.bars[time - 1][field] === price) times.push(time);
      }
      if (move.end.price === price) times.push(move.end.time);
      return times.length ? Math.min(...times) : null;
    };
    sourceMoves.push({
      id: move.id, type: move.type, level: move.level, basis: move.basis,
      start: { ...move.start }, end: { ...move.end }, low: move.low, high: move.high,
      high_time: extremeTime(move.high, 'high', guaranteedHigh === possibleHigh),
      low_time: extremeTime(move.low, 'low', guaranteedLow === possibleLow),
      price_range_evidence: rangeCertain ? 'checked_against_source' : 'endpoint_candle_order_unknown',
      range_bounds: { guaranteed_high: guaranteedHigh, possible_high: possibleHigh,
        guaranteed_low: guaranteedLow, possible_low: possibleLow },
      confirmed_time: move.confirmed_time,
    });
  }

  const zd = Math.max(...first.map(move => move.low));
  const zg = Math.min(...first.map(move => move.high));
  const priceProof = sourceMoves.every(move => move.price_range_evidence === 'checked_against_source')
    ? 'checked_against_caller_supplied_source' : 'partially_checked_endpoint_order_unknown';
  // A caller's plausible endpoint-K range is not proof of which intrabar
  // ordering happened. Reject a core only if the largest possible ranges
  // cannot overlap; report uncertainty if the guaranteed ranges do not
  // overlap but the possible ranges might. This deliberately over-approximates
  // possibilities when movements share endpoint candles.
  const zgMin = Math.min(...sourceMoves.map(move => move.range_bounds.guaranteed_high));
  const zgMax = Math.min(...sourceMoves.map(move => move.range_bounds.possible_high));
  const zdMin = Math.max(...sourceMoves.map(move => move.range_bounds.possible_low));
  const zdMax = Math.max(...sourceMoves.map(move => move.range_bounds.guaranteed_low));
  if (zgMax > zdMin && zgMin <= zdMax) return {
    status: 'indeterminate', reason: 'endpoint_candle_order_unknown',
    core_bounds: { zg: [zgMin, zgMax], zd: [zdMin, zdMax] },
    classification_proof: 'caller_supplied', source_price_and_candle_completion: priceProof,
    observed_time: evidenceKnownAt,
  };
  if (zg <= zd) return { status: 'disjoint', zd, zg,
    reason: zg === zd ? 'zero_width_contact' : 'no_common_price_range',
    classification_proof: 'caller_supplied', source_price_and_candle_completion: priceProof,
    observed_time: evidenceKnownAt };
  const zgEvidence = sourceMoves.filter(move => move.high === zg)
    .map(move => ({ move_id: move.id, time: move.high_time, price: zg }));
  const zdEvidence = sourceMoves.filter(move => move.low === zd)
    .map(move => ({ move_id: move.id, time: move.low_time, price: zd }));
  return { status: 'conditional', center: {
    id: JSON.stringify([source.basis, targetLevel, first[0].start.time, first[2].end.time]),
    level: targetLevel, lower_level: targetLevel - 1, basis: first[0].basis,
    sdt: first[0].start.time, edt: first[2].end.time,
    // Finite boundaries can overflow when added even though their average is
    // representable. Preserve ordinary/subnormal rounding for finite sums.
    zg, zd, zz: Number.isFinite(zg + zd) ? (zg + zd) / 2 : zg / 2 + zd / 2,
    // These bounds are conservative: shared endpoint-K ordering may couple
    // the movements, so not every point in the intervals must be realizable.
    core_bounds: { zg: [zgMin, zgMax], zd: [zdMin, zdMax] },
    core_price_proof: zgMin === zgMax && zdMin === zdMax
      ? 'checked_against_caller_supplied_source' : 'caller_supplied_endpoint_order_unknown',
    zg_time: zgEvidence.find(item => item.time != null)?.time ?? null,
    zd_time: zdEvidence.find(item => item.time != null)?.time ?? null,
    boundary_evidence: { zg: zgEvidence, zd: zdEvidence },
    confirmed_time: evidenceKnownAt,
    source_move_ids: first.map(move => move.id), source_moves: sourceMoves,
    completion: 'undetermined', classification_proof: 'caller_supplied',
    source_price_and_candle_completion: priceProof,
  } };
}
