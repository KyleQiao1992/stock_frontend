import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKlineTime } from '../klinePeriod.js';
import { compareFiveMinuteToThirtyMinute } from './crossPeriodEvidence.js';

const fiveProvenance = { provider: 'test', symbol: '603818', adjustment: 'qfq', period: '5m' };
const thirtyProvenance = { ...fiveProvenance, period: '30m' };
const times = ['09:35', '09:40', '09:45', '09:50', '09:55', '10:00'];
const fiveRows = () => times.map((time, index) => ({ date: `2026-09-30 ${time}`,
  open: 10 + index, high: 11 + index, low: 9 + index, close: 10.5 + index, volume: 10 + index,
  complete: true }));
const thirtyRows = () => [{ date: '2026-09-30 10:00', open: 10, high: 16, low: 9, close: 15.5,
  volume: 75, complete: true }];
const input = (overrides = {}) => ({ fiveRows: fiveRows(), thirtyRows: thirtyRows(),
  fiveProvenance, thirtyProvenance, fiveSnapshotAt: '2026-09-30 10:00',
  thirtySnapshotAt: '2026-09-30 10:00', asOfTime: '2026-09-30 10:00', ...overrides });
const seconds = value => parseKlineTime(value);

test('six completed 5m bars and one completed 30m bar compare with separate basis and snapshot times', () => {
  const result = compareFiveMinuteToThirtyMinute(input());
  assert.match(result.scope, /caller_declared_basis_no_calendar_or_recursive_movement_proof/);
  assert.deepEqual(result.windows.map(w => w.status), ['complete']);
  const [window] = result.windows;
  assert.deepEqual(window.aggregate, { open: 10, high: 16, low: 9, close: 15.5, volume: 75 });
  assert.deepEqual(window.compared, window.aggregate);
  assert.equal(window.confirmationBasisAt, seconds('2026-09-30 10:00'));
  assert.equal(window.observedAt, seconds('2026-09-30 10:00'));
  assert.equal(window.constituentTimes.length, 6);
});

test('conflicting high and volume report exact fields; tolerance is explicit', () => {
  const higher = thirtyRows(); higher[0].high = 16.1; higher[0].volume = 76;
  const conflict = compareFiveMinuteToThirtyMinute(input({ thirtyRows: higher })).windows[0];
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.differences.map(d => d.field), ['high', 'volume']);
  const rounded = compareFiveMinuteToThirtyMinute(input({ thirtyRows: higher,
    priceTolerance: 0.11, volumeTolerance: 1 })).windows[0];
  assert.equal(rounded.status, 'complete');
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ priceTolerance: -1 })), /tolerance/);
});

test('missing internal five-minute bar and truncated coverage are distinguished', () => {
  const missing = fiveRows(); missing.splice(2, 1);
  const internal = compareFiveMinuteToThirtyMinute(input({ fiveRows: missing })).windows[0];
  assert.equal(internal.status, 'missing');
  assert.equal(internal.reason, 'missing_5m_inside_observed_coverage');
  assert.deepEqual(internal.missingTimes, [seconds('2026-09-30 09:45')]);
  assert.equal(Object.hasOwn(internal, 'aggregate'), false);
  const cutoff = compareFiveMinuteToThirtyMinute(input({ fiveRows: fiveRows().slice(2) })).windows[0];
  assert.equal(cutoff.reason, 'outside_observed_5m_coverage');
  assert.deepEqual(cutoff.missingTimes, [seconds('2026-09-30 09:35'), seconds('2026-09-30 09:40')]);
});

test('missing completion requires later bars in each series and explicitly unfinished is never completed', () => {
  const fives = fiveRows(); fives.forEach(row => { delete row.complete; });
  const thirties = thirtyRows(); thirties.forEach(row => { delete row.complete; });
  const pending = compareFiveMinuteToThirtyMinute(input({ fiveRows: fives, thirtyRows: thirties })).windows[0];
  assert.equal(pending.status, 'unconfirmed');
  assert.equal(pending.targetConfirmedAt, null);
  assert.equal(pending.sourceConfirmedAt.at(-1), null);
  const nextFive = { ...fives.at(-1), date: '2026-09-30 10:05' };
  const nextThirty = { ...thirties[0], date: '2026-09-30 10:30' };
  const later = compareFiveMinuteToThirtyMinute(input({ fiveRows: [...fives, nextFive], thirtyRows: [...thirties, nextThirty],
    fiveSnapshotAt: '2026-09-30 10:05', thirtySnapshotAt: '2026-09-30 10:30', asOfTime: '2026-09-30 10:30' }));
  assert.equal(later.windows[0].status, 'complete');
  assert.equal(later.windows[0].confirmationBasisAt, seconds('2026-09-30 10:30'));
  assert.equal(later.windows[0].observedAt, seconds('2026-09-30 10:30'));
  const unfinished = [...fives, nextFive]; unfinished[5] = { ...unfinished[5], complete: false };
  assert.equal(compareFiveMinuteToThirtyMinute(input({ fiveRows: unfinished, thirtyRows: [...thirties, nextThirty],
    fiveSnapshotAt: '2026-09-30 10:05', thirtySnapshotAt: '2026-09-30 10:30', asOfTime: '2026-09-30 10:30' })).windows[0].status, 'unconfirmed');
});

test('late snapshots and future-labelled rows are rejected without reading future prices or completion fields', () => {
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveSnapshotAt: '2026-09-30 10:05' })), /snapshot.*after/);
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ thirtySnapshotAt: '2026-09-30 10:30' })), /snapshot.*after/);
  const future = { date: '2026-09-30 10:05', get open() { throw new Error('future OHLC read'); },
    get complete() { throw new Error('future completion read'); } };
  const source = [...fiveRows(), future];
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveRows: source })), /after its observation time/);
  const futureThirty = { date: '2026-09-30 10:30', get open() { throw new Error('future 30m read'); } };
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ thirtyRows: [...thirtyRows(), futureThirty] })), /after its observation time/);
  const malformedFuture = { date: 'not-a-date', get open() { throw new Error('future OHLC read'); } };
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveRows: [...fiveRows(), future, malformedFuture] })), /after its observation time/);
});

test('basis mismatch, duplicates, reverse order and malformed visible candles are rejected', () => {
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveProvenance: { ...fiveProvenance, adjustment: 'none' } })), /basis/);
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ thirtyProvenance: { ...thirtyProvenance, period: '5m' } })), /provenance/);
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveRows: [...fiveRows()].reverse() })), /increasing/);
  const duplicated = fiveRows(); duplicated[2].date = duplicated[1].date;
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveRows: duplicated })), /unique/);
  const bad = fiveRows(); bad[2].high = null;
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ fiveRows: bad })), /invalid candle/);
  assert.throws(() => compareFiveMinuteToThirtyMinute(input({ asOfTime: null })), /asOf/);
});

test('mirroring negative prices preserves comparison and reverses extrema', () => {
  const mirror = row => ({ ...row, open: -row.open, close: -row.close, high: -row.low, low: -row.high });
  const result = compareFiveMinuteToThirtyMinute(input({ fiveRows: fiveRows().map(mirror), thirtyRows: thirtyRows().map(mirror) }));
  assert.equal(result.windows[0].status, 'complete');
  assert.deepEqual(result.windows[0].aggregate, { open: -10, high: -9, low: -16, close: -15.5, volume: 75 });
});

test('saved real 603818 data: 50 confirmed windows match, first is truncated, final lacks 5m and 30m successor', () => {
  const fixture = period => JSON.parse(readFileSync(new URL(`./fixtures/reference/sh603818-${period}.json`, import.meta.url)));
  const toRows = items => items.map(row => ({ date: new Date((row.time + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.vol }));
  const fives = toRows(fixture('5m').candles), thirties = toRows(fixture('30m').candles);
  // The archived files give only capturedAt=2026-10-06; midnight the next
  // day is a deliberately conservative caller assumption, not a verified
  // capture clock or evidence available on the candle's original date.
  const snapshot = '2026-10-07 00:00';
  const real = { fiveRows: fives, thirtyRows: thirties,
    fiveProvenance: { provider: 'saved_reference', symbol: '603818', adjustment: 'unknown', period: '5m' },
    thirtyProvenance: { provider: 'saved_reference', symbol: '603818', adjustment: 'unknown', period: '30m' },
    fiveSnapshotAt: snapshot, thirtySnapshotAt: snapshot, asOfTime: snapshot };
  const result = compareFiveMinuteToThirtyMinute(real);
  assert.equal(result.windows.filter(w => w.status === 'complete').length, 50);
  assert.equal(result.windows.filter(w => w.status === 'conflict').length, 0);
  const truncated = result.windows.find(w => w.end === '2026-09-21 13:30');
  assert.equal(truncated.status, 'missing');
  assert.equal(truncated.reason, 'outside_observed_5m_coverage');
  assert.equal(truncated.missingTimes.length, 4);
  const last = result.windows.at(-1);
  assert.equal(last.end, '2026-09-30 15:00');
  assert.equal(last.status, 'unconfirmed');
  assert.equal(last.targetConfirmedAt, null);
  assert.equal(last.sourceConfirmedAt.at(-1), null);
  assert.ok(result.windows.filter(w => w.status === 'complete').every(w => w.observedAt === seconds(snapshot)));
  for (const w of result.windows.filter(w => w.status === 'complete')) {
    assert.deepEqual(w.aggregate, w.compared, w.end);
  }
  // Model historical replay using independent caller-asserted snapshots,
  // without pretending the archive was actually available at those times.
  for (const bar of thirties) {
    if (bar.date < fives[0].date) continue;
    const at = bar.date;
    const before = compareFiveMinuteToThirtyMinute({ ...real, fiveRows: fives.filter(row => row.date <= at),
      thirtyRows: thirties.filter(row => row.date <= at), fiveSnapshotAt: at, thirtySnapshotAt: at, asOfTime: at });
    assert.ok(before.windows.every(w => w.endTime <= seconds(at)));
    for (const w of before.windows.filter(w => w.status === 'complete')) {
      assert.ok(w.confirmationBasisAt <= seconds(at));
      assert.equal(w.observedAt, seconds(at));
      assert.deepEqual(w.aggregate, result.windows.find(r => r.end === w.end).aggregate);
    }
  }
});
