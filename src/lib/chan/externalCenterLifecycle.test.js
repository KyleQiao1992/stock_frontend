import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeExternalChan } from './external/index.js';
import { buildPenCenters } from './penCenters.js';

function samples(prices) {
  const candles = prices.map((price, i) => ({ time: i + 1, high: price, low: price, complete: true }));
  const points = prices.map((price, i) => ({ time: i + 1, idx: i, price,
    mark: i % 2 ? 'G' : 'D', confirmed: i + 1 < prices.length,
    confirmed_time: i + 1 < prices.length ? i + 2 : null }));
  return { candles, points };
}

test('default chart must use the lifecycle and uncertainty of its production pen reference', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const chart = analyzeExternalChan(rows, 'day');
  assert.ok(chart.penZs.length > 0);
  assert.deepEqual(chart.zs.map(z => [z.sdt, z.edt, z.zd, z.zg, z.status, z.phase, z.confirmed_time, z.closed_time]),
    chart.penZs.map(z => [z.sdt, z.edt, z.zd, z.zg, z.status, z.phase, z.confirmed_time, z.closed_time]));
  assert.deepEqual(chart.zsUncertainty, chart.penZsUncertainty);
  assert.ok(chart.zs.every(z => z.level === 'pen_reference'));
});

test('600851 reference first appears when its evidence candle becomes observable', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
  const through = date => rows.filter(row => row.date <= date);
  const locate = data => data.zs.find(zone => zone.id === 'pen-zs-446-487');
  assert.equal(locate(analyzeExternalChan(through('2026-03-12'))), undefined);
  const observed = locate(analyzeExternalChan(through('2026-03-13')));
  assert.ok(observed);
  assert.equal(rows[observed.confirmed_time - 1].date, '2026-03-13');
  assert.deepEqual([observed.zd, observed.zg], [7.55, 8.91]);
  assert.equal(observed.closed_time, null);
});

test('a completed crossing pen ending outside the core does not by itself close the reference zone', () => {
  const { points, candles } = samples([5, 15, 9, 17, 8, 13, 7]);
  const result = buildPenCenters(points, candles);
  assert.equal(result.zones.length, 1);
  const zone = result.zones[0];
  assert.deepEqual([zone.zd, zone.zg], [9, 15]);
  assert.equal(zone.status, 'active');
  assert.equal(zone.confirmed_time, 4);
  assert.equal(zone.closed_time, null);
  assert.ok(zone.edt >= 6, 'subsequent crossings extend the same fixed core');
  assert.equal(zone.evidence.formation.kind, 'three_completed_pens');
  assert.equal(zone.evidence.formation.pens.length, 3);
  assert.equal(zone.evidence.formation.confirmed_time, zone.confirmed_time);
});

test('reference formation and closure use only evidence observable by that candle', () => {
  const { points, candles } = samples([5, 15, 9, 17, 16, 19]);
  const before = buildPenCenters(points.slice(0, 3), candles.slice(0, 3));
  assert.equal(before.zones.length, 0);
  const formed = buildPenCenters(points.slice(0, 4), candles.slice(0, 4)).zones[0];
  assert.deepEqual([formed.zd, formed.zg, formed.confirmed_time, formed.closed_time], [9, 15, 4, null]);
  assert.equal(formed.phase, 'leaving');
  const closed = buildPenCenters(points.slice(0, 5), candles.slice(0, 5)).zones[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_time, 5);
  assert.equal(closed.evidence.closure.confirmed_time, 5);
  assert.ok(closed.confirmed_time < closed.closed_time);
  assert.equal('thirdSignal' in closed, false);
});

test('the reference builder scans past 500 zones across 2500 completed pens', () => {
  const prices = Array.from({ length: 2501 }, (_, i) => 2 * Math.floor(i / 2) + (i % 2 ? 4 : 0));
  const { points, candles } = samples(prices);
  const result = buildPenCenters(points, candles);
  assert.equal(result.zones.length, 625);
  assert.equal(result.zones.at(-1).edt, 2501, 'the final completed pen was included');
  assert.deepEqual(result.uncertainties, []);
});
