import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formCenterFromMoves } from './recursiveCenter.js';
import { analyzeChan } from './index.js';
import { zoneLifecycleRows } from './fixtures/zoneLifecycle.js';

// A completed movement is an input from a separately verified decomposition;
// these handcrafted fixtures test the definition, not an OHLC algorithm.
const move = (id, start, end, low, high, confirmedTime, overrides = {}) => ({
  id, kind: 'movement', type: 'consolidation', level: 1, basis: 'SH600851:qfq:5m',
  start: { time: start[0], price: start[1] }, end: { time: end[0], price: end[1] },
  low, high, status: 'confirmed', confirmed_time: confirmedTime, ...overrides,
});
const three = () => [
  move('a', [1, 0], [3, 10], 0, 10, 10, { type: 'up' }),
  move('b', [3, 10], [5, 4], 4, 10, 12, { type: 'down' }),
  move('c', [5, 4], [7, 12], 4, 12, 15, { type: 'up' }),
];
const source = () => ({ basis: 'SH600851:qfq:5m', bars: [0, 5, 10, 7, 4, 8, 12,
  ...Array(13).fill(12)].map((price, index) => ({ time: index + 1, high: price, low: price, complete: true })) });
const opts = (asOfTime = 20, evidence = source()) => ({ targetLevel: 2, asOfTime, source: evidence });

test('three consecutive completed next-lower movements create a center from their common actual range', () => {
  const input = three();
  const result = formCenterFromMoves(input, opts());
  assert.equal(result.status, 'conditional');
  assert.deepEqual({ level: result.center.level, lowerLevel: result.center.lower_level,
    zd: result.center.zd, zg: result.center.zg, sdt: result.center.sdt, edt: result.center.edt,
    confirmed: result.center.confirmed_time, ids: result.center.source_move_ids },
  { level: 2, lowerLevel: 1, zd: 4, zg: 10, sdt: 1, edt: 7,
    confirmed: 15, ids: ['a', 'b', 'c'] });
  assert.equal(result.center.completion, 'undetermined');
  assert.equal(result.center.classification_proof, 'caller_supplied');
  assert.equal(result.center.source_price_and_candle_completion, 'checked_against_caller_supplied_source');
  assert.deepEqual(input, three(), 'input is not mutated');
});

test('confirmation is not backdated to the last movement endpoint', () => {
  assert.equal(formCenterFromMoves(three(), opts(14)).status, 'pending');
  assert.equal(formCenterFromMoves(three(), opts(15)).status, 'conditional');
  const pending = three();
  pending[2] = { ...pending[2], status: 'pending', confirmed_time: null };
  assert.equal(formCenterFromMoves(pending, opts()).status, 'pending');
  assert.equal(formCenterFromMoves(three().slice(0, 2), opts()).status, 'pending');
});

test('wrong structural level, basis, broken continuity or a segment cannot masquerade as three movements', () => {
  for (const change of [
    a => { a[1].level = 2; }, a => { a[1].basis = 'SH600851:qfq:30m'; },
    a => { a[1].start.time = 4; }, a => { a[1].start.price = 9; },
    a => { a[1].kind = 'segment'; }, a => { a[2].id = a[0].id; },
  ]) {
    const input = three(); change(input);
    assert.throws(() => formCenterFromMoves(input, opts()));
  }
});

test('no price overlap and zero-width contact do not form a positive-width center', () => {
  const touch = [
    move('a', [1, 0], [2, 4], 0, 4, 4),
    move('b', [2, 4], [3, 2], 2, 4, 5),
    move('c', [3, 2], [4, 4], 2, 4, 6, { low: 4 }),
  ];
  // The final move must contain both endpoints; use a valid sequence whose
  // three ranges touch at 4 without sharing a price interval.
  touch[1].end.price = 4; touch[1].low = 4; touch[1].high = 6;
  touch[2].start.price = 4; touch[2].end.price = 6; touch[2].high = 6;
  const evidence = source();
  evidence.bars[1] = { time: 2, high: 4, low: 4, complete: true };
  evidence.bars[2] = { time: 3, high: 6, low: 4, complete: true };
  evidence.bars[3] = { time: 4, high: 6, low: 6, complete: true };
  const result = formCenterFromMoves(touch, opts(10, evidence));
  assert.equal(result.status, 'disjoint');
  assert.equal(result.classification_proof, 'caller_supplied');
  assert.equal(result.source_price_and_candle_completion, 'partially_checked_endpoint_order_unknown');
});

test('the first three movements fix the core even when later movements are supplied', () => {
  const input = three();
  input.push(move('d', [7, 12], [9, 6], 6, 12, 20, { type: 'down' }));
  const result = formCenterFromMoves(input, opts());
  assert.deepEqual([result.center.zd, result.center.zg, result.center.edt], [4, 10, 7]);
  assert.deepEqual(result.center.source_move_ids, ['a', 'b', 'c']);
});

test('invalid evidence, impossible prices and malformed time never generate a center', () => {
  for (const change of [
    a => { a[0].confirmed_time = 2; }, a => { a[0].high = 3; },
    a => { a[0].low = NaN; }, a => { a[0].end.time = 1; },
    a => { a[0].type = 'unknown'; },
  ]) {
    const input = three(); change(input);
    assert.throws(() => formCenterFromMoves(input, opts()));
  }
});

test('source candles verify each full movement range and all confirmation candles', () => {
  const forged = three(); forged[0].high = 11; // endpoints fit, but raw prices never reached 11
  assert.throws(() => formCenterFromMoves(forged, opts()), /range.*source/i);
  const missing = source(); missing.bars.splice(1, 1);
  assert.throws(() => formCenterFromMoves(three(), opts(20, missing)), /source.*time/i);
  const wrongBasis = source(); wrongBasis.basis = 'OTHER';
  assert.throws(() => formCenterFromMoves(three(), opts(20, wrongBasis)), /basis/i);
  const stillOpen = source(); stillOpen.bars[11].complete = false;
  assert.deepEqual(formCenterFromMoves(three(), opts(20, stillOpen)),
    { status: 'pending', reason: 'evidence_candle_incomplete' });
});

test('formation first appears at the last required confirmation; retracting a movement removes it', () => {
  const values = three();
  for (let asOfTime = 1; asOfTime <= 20; asOfTime++) {
    const result = formCenterFromMoves(values, opts(asOfTime));
    assert.equal(result.status, asOfTime < 15 ? 'pending' : 'conditional', `as of K${asOfTime}`);
    if (result.status === 'conditional') assert.equal(result.center.confirmed_time, 15);
  }
  assert.equal(formCenterFromMoves(values.slice(0, 2), opts()).status, 'pending');
  const changed = three(); changed[2].status = 'pending'; changed[2].confirmed_time = null;
  assert.equal(formCenterFromMoves(changed, opts()).status, 'pending');
});

test('the existing confirmed segments cannot be silently supplied as next-level movements', () => {
  const rows = zoneLifecycleRows(114);
  const { segments } = analyzeChan(rows);
  assert.equal(segments.length, 3);
  assert.throws(() => formCenterFromMoves(segments, {
    targetLevel: 2, asOfTime: rows.length,
    source: { basis: 'synthetic', bars: rows.map((bar, index) => ({ ...bar, time: index + 1 })) },
  }), /movement/);
});

test('higher structural levels are relative and price reflection preserves the center', () => {
  const values = three().map(m => ({ ...m, level: 4 }));
  const evidence = source();
  assert.equal(formCenterFromMoves(values, { ...opts(20, evidence), targetLevel: 5 }).center.level, 5);
  const reflected = values.map(m => ({ ...m, type: m.type === 'up' ? 'down' : m.type === 'down' ? 'up' : m.type,
    start: { ...m.start, price: -m.start.price }, end: { ...m.end, price: -m.end.price },
    low: -m.high, high: -m.low }));
  const reflectedSource = { ...evidence, bars: evidence.bars.map(b => ({ ...b, high: -b.low, low: -b.high })) };
  const result = formCenterFromMoves(reflected, { ...opts(20, reflectedSource), targetLevel: 5 });
  assert.equal(result.status, 'conditional');
  assert.deepEqual([result.center.zd, result.center.zg], [-10, -4]);
  assert.equal(result.center.confirmed_time, 15);
});

test('unknown completion is established by a later same-series K, never by a future unseen K', () => {
  const missingClosure = source(); delete missingClosure.bars[9].complete;
  assert.equal(formCenterFromMoves(three(), opts(20, missingClosure)).status, 'conditional');
  const lastEvidence = source(); delete lastEvidence.bars[14].complete;
  assert.deepEqual(formCenterFromMoves(three(), opts(15, lastEvidence)),
    { status: 'pending', reason: 'evidence_candle_incomplete' });
  const next = formCenterFromMoves(three(), opts(16, lastEvidence));
  assert.equal(next.status, 'conditional');
  assert.equal(next.center.confirmed_time, 16, 'the unmarked evidence K becomes known only when K16 appears');
  const historicalDayBars = source();
  historicalDayBars.bars.forEach(bar => { delete bar.complete; });
  assert.equal(formCenterFromMoves(three(), opts(15, historicalDayBars)).status, 'pending');
  assert.equal(formCenterFromMoves(three(), opts(16, historicalDayBars)).center.confirmed_time, 16);
  const explicitOpen = source(); explicitOpen.bars[14].complete = false;
  assert.deepEqual(formCenterFromMoves(three(), opts(20, explicitOpen)),
    { status: 'pending', reason: 'evidence_candle_incomplete' },
    'an explicit open candle is not promoted merely because later rows exist');
  const malformedState = source(); malformedState.bars[14].complete = 'false';
  assert.throws(() => formCenterFromMoves(three(), opts(20, malformedState)), /completion state/);
  assert.throws(() => formCenterFromMoves(three(), { targetLevel: 2, asOfTime: 21, source: source() }), /asOfTime/);
  assert.throws(() => formCenterFromMoves(three(), { targetLevel: 2, asOfTime: 20 }), /source/);
});

test('identical ordinal endpoints in a different data basis do not share a center id', () => {
  const initial = formCenterFromMoves(three(), opts()).center;
  const different = three().map(m => ({ ...m, basis: 'SZ000001:qfq:5m' }));
  const evidence = { ...source(), basis: 'SZ000001:qfq:5m' };
  const next = formCenterFromMoves(different, opts(20, evidence)).center;
  assert.notEqual(initial.id, next.id);
});

test('boundary provenance records the actual source K and all tied movements, including interior extrema', () => {
  const first = formCenterFromMoves(three(), opts()).center;
  assert.equal(first.zg_time, 3);
  assert.equal(first.zd_time, 5);
  assert.deepEqual(first.boundary_evidence.zg, [{ move_id: 'a', time: 3, price: 10 },
    { move_id: 'b', time: 3, price: 10 }]);
  assert.deepEqual(first.boundary_evidence.zd, [{ move_id: 'b', time: 5, price: 4 },
    { move_id: 'c', time: 5, price: 4 }]);

  const values = three(), evidence = source();
  evidence.bars[1] = { ...evidence.bars[1], high: 11 };
  evidence.bars[3] = { ...evidence.bars[3], low: 3.5 };
  values[0].high = 11; values[1].low = 3.5;
  const next = formCenterFromMoves(values, opts(20, evidence)).center;
  assert.deepEqual([next.zd, next.zg, next.zd_time, next.zg_time], [4, 10, 5, 3]);
  assert.deepEqual(next.boundary_evidence.zg, [{ move_id: 'b', time: 3, price: 10 }]);
  assert.deepEqual(next.boundary_evidence.zd, [{ move_id: 'c', time: 5, price: 4 }]);
});

test('endpoint K high-low order is unknown and cannot certify a claimed movement range', () => {
  const evidence = source();
  // On the first endpoint K, 11 might occur before the movement starts at 0.
  // Both 0→10 and 0→11→10 are compatible with the same candle OHLC.
  evidence.bars[0].high = 11;
  const exactTen = formCenterFromMoves(three(), opts(20, evidence));
  assert.equal(exactTen.status, 'conditional');
  assert.equal(exactTen.center.source_moves[0].price_range_evidence, 'endpoint_candle_order_unknown');
  assert.equal(exactTen.center.source_price_and_candle_completion, 'partially_checked_endpoint_order_unknown');
  const mayIncludeEleven = three(); mayIncludeEleven[0].high = 11;
  const possibleEleven = formCenterFromMoves(mayIncludeEleven, opts(20, evidence));
  assert.equal(possibleEleven.center.source_moves[0].price_range_evidence, 'endpoint_candle_order_unknown');
  const impossible = three(); impossible[0].high = 12;
  assert.throws(() => formCenterFromMoves(impossible, opts(20, evidence)), /range.*source/i);
});

test('endpoint order that can change whether a core exists is indeterminate for both caller claims', () => {
  // At K2, the high of 6 can occur before or after the shared endpoint 4.
  // If before, A is 0..6 and the three movements overlap at 5..6; if after,
  // A is 0..4 and there is no positive-width common range. OHLC is identical.
  const evidence = { basis: 'SH600851:qfq:5m', bars: [
    { time: 1, low: 0, high: 0, complete: true },
    { time: 2, low: 4, high: 6, complete: true },
    { time: 3, low: 6, high: 6, complete: true },
    { time: 4, low: 5, high: 5, complete: true },
  ] };
  const input = [move('a', [1, 0], [2, 4], 0, 4, 4),
    move('b', [2, 4], [3, 6], 4, 6, 4),
    move('c', [3, 6], [4, 5], 5, 6, 4)];
  const first = formCenterFromMoves(input, opts(4, evidence));
  assert.equal(first.status, 'indeterminate');
  assert.equal(first.reason, 'endpoint_candle_order_unknown');
  const otherClaim = structuredClone(input); otherClaim[0].high = 6;
  const second = formCenterFromMoves(otherClaim, opts(4, evidence));
  assert.equal(second.status, 'indeterminate');
  assert.equal(second.reason, 'endpoint_candle_order_unknown');
});

test('guaranteed overlap with uncertain core boundaries remains explicitly conditional', () => {
  const evidence = source();
  // The first two movements share K3: the K high 11 may be before or after
  // their 10 endpoint. Both must overlap, but the exact upper core is unknown.
  evidence.bars[2].high = 11;
  const result = formCenterFromMoves(three(), opts(20, evidence));
  assert.equal(result.status, 'conditional');
  assert.equal(result.center.core_price_proof, 'caller_supplied_endpoint_order_unknown');
  assert.deepEqual(result.center.core_bounds, { zg: [10, 11], zd: [4, 4] });
  assert.equal(result.center.zg, 10, 'displayed upper boundary is caller supplied, not independently proved');
});
