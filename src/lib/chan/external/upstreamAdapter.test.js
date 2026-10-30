import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKlineTime } from '../../klinePeriod.js';
import { analyze } from './upstream.js';
import { analyzeUpstreamReference } from './upstreamAdapter.js';

const rows = JSON.parse(readFileSync(new URL('../fixtures/600851-qfq-2026-10-27.json', import.meta.url)));
const baseline = JSON.parse(readFileSync(new URL('../fixtures/600851-external-upstream-274f7a2.json', import.meta.url)));
const toBars = history => history.map(r => ({ t: parseKlineTime(r.date) * 1000, o: r.open,
  h: r.high, l: r.low, c: r.close, v: r.volume }));

test('original upstream replay retains every original pen, segment, center and fractal on the same real history', () => {
  const result = analyzeUpstreamReference(rows, '101');
  const raw = analyze(toBars(rows), { period: 'day', limit: rows.length });
  assert.equal(result.definition.engine, 'upstream');
  assert.deepEqual(result.upstreamRaw, raw);
  assert.equal(raw.bars.length, 641);
  assert.deepEqual([raw.bis.length, raw.segments.length, raw.pivots.length], [51, 9, 13]);
  assert.deepEqual(raw.bis, baseline.bis);
  assert.deepEqual(raw.segments, baseline.segments);
  assert.deepEqual(raw.fractals, baseline.fractals);
  // The saved upstream snapshot used midnight UTC, while the chart's market
  // timestamp parser uses Shanghai midnight; their bar indices must agree.
  assert.deepEqual(raw.pivots.map(p => ({ ...p, t0: p.t0 + 8 * 3600000, t1: p.t1 + 8 * 3600000 })), baseline.pivots);
  assert.equal(result.segments.length, raw.segments.length);
  raw.segments.forEach((s, i) => {
    const segment = result.segments[i];
    assert.deepEqual(segment.start, { time: s.i0 + 1, price: s.p0 });
    assert.deepEqual(segment.end, { time: s.i1 + 1, price: s.p1 });
    assert.equal(segment.done, s.done);
    assert.equal(segment.stroke_count, s.endBi - s.startBi + 1);
    assert.equal(Object.hasOwn(segment, 'confirmed_time'), false);
  });
  assert.notDeepEqual(result.segments[0].end, result.segments[1].start,
    'original mismatched segment endpoints are not silently joined');
  assert.equal(result.zs.length, raw.pivots.length);
  raw.pivots.forEach((p, i) => assert.deepEqual(result.zs[i], {
    id: `upstream-pivot-${p.idx}`, sdt: p.i0 + 1, edt: p.i1 + 1, zg: p.zg, zd: p.zd,
    pen_count: p.count, segment_count: p.count, status: 'reference', isLast: p.active,
  }));
  assert.deepEqual(result.bi, []);
  assert.deepEqual(result.biLine, []);
  assert.deepEqual(result.fx, []);
});

test('zero or negative closes stop upstream replay instead of silently deleting a bar', () => {
  for (const close of [0, -0.5]) {
    const input = rows.map(row => ({ ...row }));
    input[19].low = Math.min(input[19].low, close);
    input[19].close = close;
    const result = analyzeUpstreamReference(input);
    assert.deepEqual(result.inputProblem, { reason: 'upstream_non_positive_close', index: 19, date: input[19].date });
    assert.equal(result.upstreamRaw, null);
    assert.deepEqual(result.segments, []);
    assert.deepEqual(result.zs, []);
    assert.equal(analyze(toBars(input), { limit: input.length }).bars.length, input.length - 1,
      'the original upstream batch silently removes the close, so the adapter must stop');
  }
});

test('invalid, duplicate or reversed history cannot be sorted or filtered into a fabricated original replay', () => {
  const invalid = rows.map(row => ({ ...row })); invalid[19].high = null;
  assert.equal(analyzeUpstreamReference(invalid).inputProblem.reason, 'invalid_candle');
  const duplicate = rows.map(row => ({ ...row })); duplicate[19].date = duplicate[18].date;
  assert.equal(analyzeUpstreamReference(duplicate).inputProblem.reason, 'non_increasing_timestamp');
  const reverse = rows.map(row => ({ ...row })); [reverse[18], reverse[19]] = [reverse[19], reverse[18]];
  assert.deepEqual(analyzeUpstreamReference(reverse).inputProblem,
    { reason: 'non_increasing_timestamp', index: 19, date: reverse[19].date });
  const malformed = rows.map(row => ({ ...row })); malformed[19].date = 'not-a-date';
  assert.equal(analyzeUpstreamReference(malformed).inputProblem.reason, 'invalid_timestamp');
  assert.equal(analyzeUpstreamReference(rows, 'unknown').inputProblem.reason, 'unsupported_period');
});

test('period mapping preserves original metadata and full history past upstream default 800 bars', () => {
  assert.equal(analyzeUpstreamReference(rows, '102').upstreamRaw.period, 'week');
  assert.equal(analyzeUpstreamReference(rows, '240').upstreamRaw.period, '4h');
  const history = Array.from({ length: 1001 }, (_, index) => ({
    date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
    open: 10, high: 11, low: 9, close: 10, volume: 1,
  }));
  assert.equal(analyzeUpstreamReference(history).upstreamRaw.bars.length, 1001);
  assert.equal(analyze(toBars(history), { period: 'day' }).bars.length, 800);
  const short = analyzeUpstreamReference(history.slice(0, 19));
  assert.equal(short.upstreamRaw.ok, false);
  assert.deepEqual(short.zs, []);
});

test('upstream replay exposes missing or unfinished last-candle status without changing original output', () => {
  const missing = rows.map(row => ({ ...row }));
  const open = rows.map(row => ({ ...row })); open.at(-1).complete = false;
  const closed = rows.map(row => ({ ...row })); closed.at(-1).complete = true;
  const unknown = analyzeUpstreamReference(missing);
  const developing = analyzeUpstreamReference(open);
  const completed = analyzeUpstreamReference(closed);
  assert.equal(unknown.lastBarCompletion, null);
  assert.equal(developing.lastBarCompletion, false);
  assert.equal(completed.lastBarCompletion, true);
  assert.deepEqual(developing.upstreamRaw, completed.upstreamRaw,
    'the original engine ignores completion state; the UI must not infer confirmation');
});
