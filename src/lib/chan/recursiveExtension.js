import { createCenterFormationInspector } from './recursiveCenter.js';

/**
 * Lesson 20, center theorem 1, for an explicitly directional up/down/up (or
 * down/up/down) decomposition. Its three input movements and all following
 * movements must be independently proven by the caller: neither a segment nor
 * a declared status is itself a proof of a completed lower-level movement.
 *
 * Result is conditional even after raw-price evidence has been checked. The
 * first three fix [ZD, ZG]; each later same-direction Z range touching that
 * closed interval continues this particular extension. An outside Z only says
 * this extension condition no longer holds: it does not by itself prove the
 * precise center end, a trend, level expansion, or a trading signal.
 *
 * Consolidation movements and other decomposition patterns are deliberately
 * unsupported here. For this restricted case the directional movements must
 * start and end at their respective full-range extrema. This verifies the
 * endpoint-equality premise used by lesson 20 rather than inferring it from
 * endpoint direction alone; valid structures outside this subset are unsupported.
 * The full endpoint candles must also stay inside each claimed movement range:
 * otherwise their highs/lows may fall before or after the movement endpoint,
 * and neither the Z range nor the extension condition is known from OHLC.
 * Source: https://blog.sina.com.cn/s/blog_486e105c010007zw.html
 */
export function inspectCenterExtension(moves, options) {
  if (!Array.isArray(moves)) throw new TypeError('moves must be an array');
  const checked = createCenterFormationInspector(options);
  const formed = checked.form(moves);
  if (formed.status !== 'conditional') return formed;
  const { center } = formed;
  const opposite = { up: 'down', down: 'up' };
  const direction = moves[0].type;
  const isDirectionalPattern = (first, middle, last) =>
    opposite[first] === middle && first === last;
  const extremaAtEndpoints = move => move.type === 'up'
    ? move.start.price === move.low && move.end.price === move.high
    : move.start.price === move.high && move.end.price === move.low;
  const endpointCandleRangeCertain = move => [move.start.time, move.end.time].every(time => {
    const bar = checked.source.bars[time - 1];
    return bar.high <= move.high && bar.low >= move.low;
  });
  if (!isDirectionalPattern(direction, moves[1].type, moves[2].type)) {
    return { status: 'conditional', center, extension: {
      status: 'unsupported_direction_pattern', classification_proof: 'caller_supplied',
    } };
  }
  if (!moves.slice(0, 3).every(extremaAtEndpoints)
      || Math.min(moves[0].high, moves[2].high) !== center.zg
      || Math.max(moves[0].low, moves[2].low) !== center.zd) {
    return { status: 'conditional', center, extension: {
      status: 'unsupported_endpoint_extrema', classification_proof: 'caller_supplied',
    } };
  }
  if (!moves.slice(0, 3).every(endpointCandleRangeCertain)) {
    return { status: 'conditional', center, extension: {
      status: 'unsupported_endpoint_candle_order', classification_proof: 'caller_supplied',
    } };
  }

  const zs = [moves[0], moves[2]];
  const ids = new Set(moves.slice(0, 3).map(move => move.id));
  let observedTime = center.confirmed_time;
  let extensionStatus = 'awaiting_next_z';
  let firstOutside;
  for (let i = 4; i < moves.length; i += 2) {
    // Reuse the formation kernel for full source, continuity and candle checks.
    // A disjoint triple is valid evidence too: we do not use its own core.
    const window = moves.slice(i - 2, i + 1);
    const proof = checked.form(window);
    if (proof.status === 'pending') break;
    if (ids.has(moves[i - 1].id) || ids.has(moves[i].id)) {
      throw new RangeError('movement IDs must be unique across the whole extension');
    }
    ids.add(moves[i - 1].id);
    ids.add(moves[i].id);
    if (proof.status === 'indeterminate') {
      observedTime = Math.max(observedTime, proof.observed_time);
      extensionStatus = 'unsupported_endpoint_candle_order';
      break;
    }
    // The kernel establishes unknown candle completion via the successor.
    // Reconstruct this time also for disjoint triples, which have no center.
    for (const move of window) {
      observedTime = Math.max(observedTime, move.confirmed_time);
      for (let time = move.start.time; time <= move.confirmed_time; time++) {
        if (checked.source.bars[time - 1].complete !== true) observedTime = Math.max(observedTime, time + 1);
      }
    }
    if (!isDirectionalPattern(direction, moves[i - 1].type, moves[i].type)) {
      extensionStatus = 'unsupported_direction_pattern';
      break;
    }
    if (!window.every(extremaAtEndpoints)) {
      extensionStatus = 'unsupported_endpoint_extrema';
      break;
    }
    if (!window.every(endpointCandleRangeCertain)) {
      extensionStatus = 'unsupported_endpoint_candle_order';
      break;
    }
    const candidate = moves[i];
    if (candidate.low > center.zg || candidate.high < center.zd) {
      extensionStatus = 'no_longer_extending';
      firstOutside = candidate.id;
      break;
    }
    zs.push(candidate);
    extensionStatus = 'extending';
  }

  return { status: 'conditional', center, extension: {
    status: extensionStatus, direction, z_move_ids: zs.map(move => move.id),
    gg: Math.max(...zs.map(move => move.high)), g: Math.min(...zs.map(move => move.high)),
    d: Math.max(...zs.map(move => move.low)), dd: Math.min(...zs.map(move => move.low)),
    observed_time: observedTime, classification_proof: 'caller_supplied',
    ...(firstOutside === undefined ? {} : { first_outside_z_move_id: firstOutside }),
  } };
}
