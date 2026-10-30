import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Independently saved raw candles, not the third-party fx/bi/zs objects in
// these files. The 5m history starts in the middle of a 30m window. Source
// continuity across entirely missing trading days and adjustment provenance
// cannot be proven merely by observing matching candles.
const five = JSON.parse(readFileSync(new URL('./fixtures/reference/sh603818-5m.json', import.meta.url)));
const thirty = JSON.parse(readFileSync(new URL('./fixtures/reference/sh603818-30m.json', import.meta.url)));

function aggregateWindow(rows, end) {
  if (!rows.every((row, index) => Number.isSafeInteger(row.time)
      && (index === 0 || row.time > rows[index - 1].time))) return { status: 'invalid_order' };
  const expected = Array.from({ length: 6 }, (_, index) => end - (5 - index) * 300);
  const byTime = new Map(rows.map(row => [row.time, row]));
  const members = expected.map(time => byTime.get(time));
  const missing = expected.filter((_, index) => !members[index]);
  if (missing.length) return { status: 'incomplete', missing };
  return { status: 'complete', members: members.map(row => row.time),
    aggregate: { open: members[0].open, high: Math.max(...members.map(row => row.high)),
      low: Math.min(...members.map(row => row.low)), close: members[5].close,
      vol: members.reduce((sum, row) => sum + row.vol, 0) } };
}

test('603818 saved 5m/30m overlap: all 51 fully covered windows match each OHLC and volume', () => {
  assert.equal(five.symbol, '603818'); assert.equal(thirty.symbol, '603818');
  assert.equal(five.period, '5m'); assert.equal(thirty.period, '30m');
  assert.equal(five.capturedAt, '2026-10-06'); assert.equal(thirty.capturedAt, '2026-10-06');
  assert.equal(five.candles.length, 308); assert.equal(thirty.candles.length, 293);
  const window = thirty.candles.filter(row => row.time >= five.candles[0].time
    && row.time <= five.candles.at(-1).time);
  let complete = 0, partial = 0;
  for (const bar of window) {
    const result = aggregateWindow(five.candles, bar.time);
    if (result.status === 'incomplete') {
      partial++;
      assert.equal(bar.time, Date.parse('2026-09-21T05:30:00Z') / 1000);
      assert.equal(result.missing.length, 4);
      assert.equal(Object.hasOwn(result, 'aggregate'), false);
      continue;
    }
    assert.equal(result.status, 'complete');
    complete++;
    assert.equal(result.members.length, 6);
    for (const field of ['open', 'high', 'low', 'close', 'vol']) {
      assert.ok(Math.abs(result.aggregate[field] - bar[field]) < 1e-6,
        `${field} differs for 30m ending ${bar.time}`);
    }
  }
  assert.equal(complete, 51);
  assert.equal(partial, 1);
});

test('reversed, duplicated or missing constituent history cannot be certified as a complete 30m window', () => {
  const firstFullyCovered = thirty.candles.find(bar => bar.time > five.candles[0].time
    && aggregateWindow(five.candles, bar.time).status === 'complete');
  const end = firstFullyCovered.time;
  assert.equal(aggregateWindow([...five.candles].reverse(), end).status, 'invalid_order');
  const duplicated = [...five.candles]; duplicated.splice(10, 0, duplicated[9]);
  assert.equal(aggregateWindow(duplicated, end).status, 'invalid_order');
  const removed = five.candles.filter(row => row.time !== end - 600);
  const incomplete = aggregateWindow(removed, end);
  assert.deepEqual(incomplete, { status: 'incomplete', missing: [end - 600] });
  assert.equal(Object.hasOwn(incomplete, 'aggregate'), false);
});
