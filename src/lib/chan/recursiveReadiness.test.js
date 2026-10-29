import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';
import { assessRecursiveReadiness } from './recursiveReadiness.js';
import { zoneLifecycleRows } from './fixtures/zoneLifecycle.js';

const assess = rows => assessRecursiveReadiness(rows, analyzeChan(rows, 'day'), { period: 'day' });

test('real 600851 input exposes insufficient confirmed minimum structures without inventing movements', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const result = assess(rows);
  assert.equal(result.status, 'insufficient_confirmed_segments');
  assert.equal(result.foundation.confirmedSegmentCount, 2);
  assert.equal(result.foundation.centers.length, 0);
  assert.equal(result.nextLevel.status, 'undetermined');
  assert.equal(result.nextLevel.completedMovements, null);
  assert.equal(result.nextLevel.centers, null);
  assert.equal(result.source.historyBeforeStart, 'unverified');
  assert.equal(result.source.marketContinuity, 'unverified');
  const production = analyzeChan(rows, 'day');
  assert.deepEqual(production.recursiveReadiness, result, 'production results expose the same checked evidence');
});

test('a formed lowest-layer center does not prove an entire movement or a higher-level center', () => {
  const rows = zoneLifecycleRows(114);
  const result = assess(rows);
  assert.equal(result.status, 'movement_completion_unproven');
  assert.equal(result.foundation.confirmedSegmentCount, 3);
  assert.equal(result.foundation.centers.length, 1);
  assert.deepEqual([result.foundation.centers[0].zd, result.foundation.centers[0].zg], [199.9, 212.1]);
  assert.equal(result.foundation.centers[0].observedAt, 114);
  assert.equal(result.foundation.centers[0].evidenceType, 'confirmed_segment_geometry');
  assert.equal(result.nextLevel.completedMovements, null);
  assert.equal(result.nextLevel.centers, null);
  assert.deepEqual(analyzeChan(rows, 'day').recursiveReadiness, result);
});

test('the formation appears only at its observed prefix and full-history output cannot be backdated', () => {
  const before = zoneLifecycleRows(113), after = zoneLifecycleRows(114);
  assert.equal(assess(before).foundation.centers.length, 0);
  assert.equal(assess(after).foundation.centers[0].observedAt, 114);
  assert.throws(() => assessRecursiveReadiness(before, analyzeChan(after, 'day'), { period: 'day' }), /basis|history/i);
  assert.throws(() => assessRecursiveReadiness(after, analyzeChan(after, 'day'), { period: 'day', asOfTime: 113 }), /prefix/i);
});

test('invalid candles stop analysis and inconsistent structure evidence is rejected', () => {
  const rows = zoneLifecycleRows(114);
  const invalid = structuredClone(rows); invalid[10].high = null;
  const stopped = assess(invalid);
  assert.equal(stopped.status, 'invalid_input');
  assert.equal(stopped.foundation.centers.length, 0);
  const data = analyzeChan(rows, 'day');
  const broken = structuredClone(data); broken.segments[1].start.price += 1;
  assert.throws(() => assessRecursiveReadiness(rows, broken, { period: 'day' }), /segment/i);
  const forged = structuredClone(data); forged.zs[0].zg += 1;
  assert.throws(() => assessRecursiveReadiness(rows, forged, { period: 'day' }), /center/i);
  const revised = structuredClone(rows); revised[50].high += 1;
  assert.throws(() => assessRecursiveReadiness(revised, data, { period: 'day' }), /history basis/i,
    'a later price revision with identical dates must not reuse stale structural evidence');
});

test('flat prices, legitimate negative adjusted prices and minute time keys remain valid', () => {
  const minute = Array.from({ length: 90 }, (_, i) => ({
    date: `2026-01-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    open: -3, high: -3, low: -3, close: -3, volume: 0, complete: true,
  }));
  const result = assessRecursiveReadiness(minute, analyzeChan(minute, '5m'), { period: '5m' });
  assert.equal(result.status, 'insufficient_confirmed_segments');
  assert.equal(result.source.period, '5m');
  assert.equal(result.foundation.confirmedSegmentCount, 0);
  assert.equal(result.nextLevel.completedMovements, null);
});

test('every prefix observes no center before its required confirmation candle', () => {
  for (let n = 1; n <= 120; n++) {
    const result = assess(zoneLifecycleRows(n));
    for (const center of result.foundation.centers) assert.ok(center.observedAt <= n);
    assert.equal(result.foundation.centers.length, n < 114 ? 0 : 1, `prefix ${n}`);
    assert.equal(result.nextLevel.status, 'undetermined');
  }
});
