import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCenterExtension } from './recursiveExtension.js';
import { formCenterFromMoves } from './recursiveCenter.js';

// Synthetic, caller-classified movements. These cases verify price/time logic,
// not whether a real-world movement decomposition is valid.
const basis = 'example:qfq:5m';
const movement = (id, type, start, end, low, high, confirmed_time) => ({
  id, kind: 'movement', type, level: 1, basis, start: { time: start[0], price: start[1] },
  end: { time: end[0], price: end[1] }, low, high, status: 'confirmed', confirmed_time,
});
function fixture(dLow = 5) {
  const prices = [0, 5, 10, 7, 4, 8, 12, (12 + dLow) / 2, dLow, 13, 15, ...Array(13).fill(15)];
  const source = { basis, bars: prices.map((p, i) => ({ time: i + 1, low: p, high: p, complete: true })) };
  const moves = [
    movement('a', 'up', [1, 0], [3, 10], 0, 10, 10),
    movement('b', 'down', [3, 10], [5, 4], 4, 10, 12),
    movement('c', 'up', [5, 4], [7, 12], 4, 12, 15),
    movement('d', 'down', [7, 12], [9, dLow], dLow, 12, 17),
    movement('e', 'up', [9, dLow], [11, 15], dLow, 15, 19),
  ];
  return { moves, source, opts: { targetLevel: 2, source, asOfTime: 24 } };
}

test('next same-direction movement extends the fixed core but never certifies caller-supplied movement classifications', () => {
  const { moves, opts } = fixture();
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.status, 'conditional');
  assert.deepEqual([result.center.zd, result.center.zg], [4, 10]);
  assert.equal(result.extension.status, 'extending');
  assert.deepEqual(result.extension.z_move_ids, ['a', 'c', 'e']);
  assert.deepEqual([result.extension.gg, result.extension.g, result.extension.d, result.extension.dd], [15, 10, 5, 0]);
  assert.equal(result.extension.observed_time, 19);
  assert.equal(result.extension.classification_proof, 'caller_supplied');
  assert.equal(result.center.completion, 'undetermined');
});

test('overlap at either core boundary is an overlap for the extension theorem', () => {
  const { moves, opts } = fixture(10);
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.extension.status, 'extending');
  assert.deepEqual([result.center.zd, result.center.zg], [4, 10]);
});

test('non-overlapping Z stops extension without claiming a new center, a trend, or a trading signal', () => {
  const { moves, opts } = fixture(11);
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.status, 'conditional');
  assert.equal(result.extension.status, 'no_longer_extending');
  assert.equal(result.extension.first_outside_z_move_id, 'e');
  assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
  assert.deepEqual([result.extension.gg, result.extension.g, result.extension.d, result.extension.dd], [12, 10, 4, 0]);
  assert.equal(result.extension.observed_time, 19);
  assert.equal(result.center.completion, 'undetermined');
});

test('does not infer extension or a break from an unseen or unconfirmed Z movement', () => {
  const { moves, opts } = fixture(11);
  assert.equal(inspectCenterExtension(moves, { ...opts, asOfTime: 14 }).status, 'pending');
  for (const asOfTime of [15, 17, 18]) {
    const result = inspectCenterExtension(moves, { ...opts, asOfTime });
    assert.equal(result.status, 'conditional');
    assert.equal(result.extension.status, 'awaiting_next_z');
    assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
    assert.equal(result.extension.observed_time, 15);
    assert.equal(result.extension.first_outside_z_move_id, undefined);
  }
  assert.equal(inspectCenterExtension(moves.slice(0, 4), opts).extension.status, 'awaiting_next_z');
  assert.equal(inspectCenterExtension(moves, { ...opts, asOfTime: 19 }).extension.status, 'no_longer_extending');
  moves[4].status = 'pending'; moves[4].confirmed_time = null;
  assert.equal(inspectCenterExtension(moves, opts).extension.status, 'awaiting_next_z');
});

test('unknown confirmation candle delays the theorem observation until a successor is observed', () => {
  const { moves, source, opts } = fixture();
  delete source.bars[18].complete;
  assert.equal(inspectCenterExtension(moves, { ...opts, asOfTime: 19 }).extension.status, 'awaiting_next_z');
  const result = inspectCenterExtension(moves, { ...opts, asOfTime: 20 });
  assert.equal(result.extension.status, 'extending');
  assert.equal(result.extension.observed_time, 20);
});

test('mirror image preserves extension, and unspecified movement direction is explicitly unsupported', () => {
  const { moves, source, opts } = fixture();
  const reflected = moves.map(m => ({ ...m, type: m.type === 'up' ? 'down' : 'up',
    start: { ...m.start, price: -m.start.price }, end: { ...m.end, price: -m.end.price },
    low: -m.high, high: -m.low }));
  const reflectedSource = { ...source, bars: source.bars.map(b => ({ ...b, low: -b.high, high: -b.low })) };
  const result = inspectCenterExtension(reflected, { ...opts, source: reflectedSource });
  assert.equal(result.extension.status, 'extending');
  assert.deepEqual([result.center.zd, result.center.zg], [-10, -4]);
  assert.deepEqual([result.extension.gg, result.extension.g, result.extension.d, result.extension.dd], [-0, -5, -10, -15]);
  moves[0].type = 'consolidation';
  assert.equal(inspectCenterExtension(moves, opts).extension.status, 'unsupported_direction_pattern');
});

test('repeated overlaps extend without an artificial nine-movement limit', () => {
  const { moves, source, opts } = fixture();
  const laterPrices = [11, 8, 12, 16, 12, 9, 13, 17, 13, 9, 14, 18];
  const prices = source.bars.slice(0, 11).map(bar => bar.high)
    .concat(laterPrices, Array(17).fill(18));
  source.bars = prices.map((p, i) => ({ time: i + 1, low: p, high: p, complete: true }));
  moves.push(
    movement('f', 'down', [11, 15], [13, 8], 8, 15, 25),
    movement('g', 'up', [13, 8], [15, 16], 8, 16, 26),
    movement('h', 'down', [15, 16], [17, 9], 9, 16, 27),
    movement('i', 'up', [17, 9], [19, 17], 9, 17, 28),
    movement('j', 'down', [19, 17], [21, 9], 9, 17, 29),
    movement('k', 'up', [21, 9], [23, 18], 9, 18, 30),
  );
  const result = inspectCenterExtension(moves, { ...opts, asOfTime: 40 });
  assert.equal(result.extension.status, 'extending');
  assert.deepEqual(result.extension.z_move_ids, ['a', 'c', 'e', 'g', 'i', 'k']);
  assert.deepEqual([result.center.zd, result.center.zg], [4, 10]);
  assert.equal(result.extension.observed_time, 30);
});

test('rejects forged later price evidence, repeated movement ids, and disconnected movement endpoints', () => {
  for (const change of [m => { m[4].high = 16; }, m => { m[4].id = 'a'; },
    m => { m[3].start.price = 11; }]) {
    const { moves, opts } = fixture(); change(moves);
    assert.throws(() => inspectCenterExtension(moves, opts));
  }
});

test('an unsupported later decomposition is reported only when its evidence is observable', () => {
  const { moves, opts } = fixture();
  moves[4].type = 'consolidation';
  assert.equal(inspectCenterExtension(moves, { ...opts, asOfTime: 18 }).extension.status, 'awaiting_next_z');
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.extension.status, 'unsupported_direction_pattern');
  assert.equal(result.extension.observed_time, 19);
  assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
});

test('rejects direction-only inference when consecutive movement extrema do not meet the theorem premises', () => {
  {
    const { moves, source, opts } = fixture();
    source.bars[3].high = 11; moves[1].high = 11;
    const result = inspectCenterExtension(moves, opts);
    assert.equal(result.status, 'conditional');
    assert.equal(result.extension.status, 'unsupported_endpoint_extrema');
  }
  {
    const { moves, source, opts } = fixture();
    source.bars[7].high = 13; moves[3].high = 13;
    const result = inspectCenterExtension(moves, opts);
    assert.equal(result.extension.status, 'unsupported_endpoint_extrema');
    assert.equal(result.extension.observed_time, 19);
    assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
  }
});

test('unseen intrabar order at an initial endpoint prevents a price-valid extension assertion', () => {
  const { moves, source, opts } = fixture();
  // The high could happen before movement a begins at its endpoint price 0.
  // Its claimed range remains possible, but is no longer independently known.
  source.bars[0].high = 11;
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.status, 'conditional');
  assert.equal(result.center.source_moves[0].price_range_evidence, 'endpoint_candle_order_unknown');
  assert.equal(result.center.source_moves[0].high_time, null);
  assert.equal(result.extension.status, 'unsupported_endpoint_candle_order');
});

test('unknown endpoint candle order in a later Z prevents both extension and break conclusions', () => {
  for (const low of [5, 11]) {
    const { moves, source, opts } = fixture(low);
    // t9 is shared by d/e: its low may occur before or after their endpoint.
    // This may change whether e reaches the center in the low=11 case.
    source.bars[8].low = low === 5 ? 3 : 9;
    const result = inspectCenterExtension(moves, opts);
    assert.equal(result.status, 'conditional');
    assert.equal(result.extension.status, 'unsupported_endpoint_candle_order');
    assert.equal(result.extension.observed_time, 19);
    assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
    assert.equal(result.extension.first_outside_z_move_id, undefined);
  }
});

test('an indeterminate later window is propagated without asserting an extension or break', () => {
  const { moves, source, opts } = fixture();
  moves[3].type = 'up'; moves[3].end.price = 13; moves[3].low = 12; moves[3].high = 13;
  moves[4].start.price = 13; moves[4].low = 13;
  source.bars[7] = { time: 8, low: 12.5, high: 12.5, complete: true };
  source.bars[8] = { time: 9, low: 11, high: 13, complete: true };
  source.bars[9] = { time: 10, low: 14, high: 14, complete: true };
  assert.equal(formCenterFromMoves(moves.slice(2, 5), opts).status, 'indeterminate');
  const result = inspectCenterExtension(moves, opts);
  assert.equal(result.status, 'conditional');
  assert.equal(result.extension.status, 'unsupported_endpoint_candle_order');
  assert.equal(result.extension.observed_time, 19);
  assert.deepEqual(result.extension.z_move_ids, ['a', 'c']);
  assert.equal(result.extension.first_outside_z_move_id, undefined);
});
