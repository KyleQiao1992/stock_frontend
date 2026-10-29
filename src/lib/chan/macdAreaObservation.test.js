import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMacdAreas } from './macdAreaObservation.js';

const basis = 'example:5m:qfq:macd12-26-9';
const bars = values => values.map((hist, index) => ({ time: index + 1, hist, complete: true }));
const windows = (a = [1, 2], c = [4, 5]) => ({
  a: { basis, start: a[0], end: a[1] }, c: { basis, start: c[0], end: c[1] },
});
const observe = (series, changes = {}) => observeMacdAreas({
  basis, bars: series, asOfTime: 5, windows: windows(), ...changes,
});

test('reports sign-separated discrete sums with original samples and caller-supplied provenance', () => {
  const result = observe(bars([3, -2, 0, -4, 1]));
  assert.equal(result.status, 'observed');
  assert.equal(result.scope, 'numeric_observation_only');
  assert.equal(result.source_proof, 'caller_supplied');
  assert.equal(result.basis, basis);
  assert.deepEqual(result.windows.a, { start: 1, end: 2, positive_sum: 3, negative_magnitude_sum: 2,
    sample_count: 2, evidence_known_at: 2, samples: [{ time: 1, hist: 3, complete: true }, { time: 2, hist: -2, complete: true }] });
  assert.deepEqual(result.windows.c, { start: 4, end: 5, positive_sum: 1, negative_magnitude_sum: 4,
    sample_count: 2, evidence_known_at: 5, samples: [{ time: 4, hist: -4, complete: true }, { time: 5, hist: 1, complete: true }] });
  assert.deepEqual(result.difference, { positive_sum: -2, negative_magnitude_sum: 2 });
  assert.equal('divergence' in result, false);
  assert.equal('movement_complete' in result, false);
});

test('the same prefix produces the same observation despite opposite later outcomes', () => {
  const prefix = [3, 2, -1, 1, 1];
  const weak = bars([...prefix, -2, -2]), strong = bars([...prefix, 4, 4]);
  assert.deepEqual(observe(weak), observe(strong));
  const laterOptions = { asOfTime: 7, windows: windows([1, 2], [4, 7]) };
  assert.equal(observe(weak, laterOptions).windows.c.positive_sum, 2);
  assert.equal(observe(strong, laterOptions).windows.c.positive_sum, 10);
  assert.equal(observe(strong, laterOptions).windows.a.positive_sum, 5);
});

test('future bars are never examined; future windows are rejected', () => {
  const prefix = bars([3, 2, -1, 1, 1]);
  const future = [...prefix, { time: -100, hist: NaN, complete: 'invalid' }];
  assert.deepEqual(observe(future), observe(prefix));
  assert.throws(() => observe(prefix, { windows: windows([1, 2], [4, 6]) }), /future|observ/i);
  assert.throws(() => observe(prefix, { asOfTime: 6 }), /asOfTime/i);
});

test('requires same declared basis, chronological nonoverlapping windows and contiguous raw indices', () => {
  assert.throws(() => observe(bars([3, 2, -1, 1, 1]), { windows: {
    a: { basis, start: 1, end: 2 }, c: { basis: 'another', start: 4, end: 5 },
  } }), /basis/i);
  assert.throws(() => observe(bars([3, 2, -1, 1, 1]), { windows: windows([1, 4], [4, 5]) }), /overlap/i);
  const gap = bars([3, 2, -1, 1, 1]); gap[2].time = 4;
  assert.throws(() => observe(gap), /consecutive/i);
});

test('unknown completion requires an observed successor; explicit unclosed evidence stays pending', () => {
  const unknown = bars([3, 2, -1, 1, 1, 0]); delete unknown[4].complete;
  assert.equal(observe(unknown).status, 'pending');
  const known = observe(unknown, { asOfTime: 6 });
  assert.equal(known.status, 'observed');
  assert.equal(known.windows.c.evidence_known_at, 6);
  unknown[4].complete = false;
  assert.equal(observe(unknown, { asOfTime: 6 }).status, 'pending');
  unknown[4].complete = 'true';
  assert.throws(() => observe(unknown, { asOfTime: 6 }), /completion/i);
  const gap = bars([3, 2, -1, 1, 1]); gap[2].complete = false;
  assert.equal(observe(gap).status, 'pending', 'a nonclosed K between A and C affects the causal indicator prefix');
});

test('rejects unavailable or malformed histogram values without filling or skipping bars', () => {
  for (const value of [null, '', NaN, Infinity, '1']) {
    const source = bars([3, 2, -1, 1, 1]); source[1].hist = value;
    assert.throws(() => observe(source), /histogram/i);
  }
  for (const field of ['dif', 'dea']) for (const value of [null, NaN, Infinity, '1']) {
    const source = bars([3, 2, -1, 1, 1]); source[1][field] = value;
    assert.throws(() => observe(source), new RegExp(field));
  }
});

test('keeps observed original date, DIF, DEA and completion samples without modifying input', () => {
  const source = bars([3, 2, -1, 1, 1]);
  source[0] = { ...source[0], date: '2026-10-20', dif: 2, dea: 0.5 };
  const before = structuredClone(source);
  const result = observe(source);
  assert.deepEqual(result.windows.a.samples[0], before[0]);
  assert.deepEqual(source, before);
  result.windows.a.samples[0].hist = 900;
  assert.equal(source[0].hist, 3);
});

test('throws on numeric overflow instead of claiming a finite area', () => {
  assert.throws(() => observe(bars([Number.MAX_VALUE, Number.MAX_VALUE, 0, 1, 1])), /overflow/i);
});

test('sample output excludes unknown future fields without even accessing their getters', () => {
  const source = bars([3, 2, -1, 1, 1]);
  source[0].date = '2026-10-20'; source[0].dif = 2; source[0].dea = 0.5;
  source[0].future_value = 12345;
  Object.defineProperty(source[3], 'future_secret', { enumerable: true, get() { throw new Error('read future field'); } });
  const result = observe(source);
  assert.deepEqual(result.windows.a.samples[0], { time: 1, hist: 3, complete: true,
    date: '2026-10-20', dif: 2, dea: 0.5 });
  assert.equal('future_secret' in result.windows.c.samples[0], false);
  assert.equal('future_value' in result.windows.a.samples[0], false);
});

test('different declared security, interval, or adjustment basis is never combined', () => {
  const source = bars([3, 2, -1, 1, 1]);
  for (const other of ['different:5m:qfq:macd12-26-9', 'example:30m:qfq:macd12-26-9',
    'example:5m:raw:macd12-26-9']) {
    const two = windows(); two.c.basis = other;
    assert.throws(() => observe(source, { windows: two }), /basis/i);
  }
});

test('an unclosed current sample does not expose or read fields on a later bar', () => {
  const source = bars([3, 2, -1, 1, 1]);
  source[4].complete = false;
  Object.defineProperty(source[4], 'future_value', { get() { throw new Error('read future field'); } });
  source.push(Object.defineProperty({}, 'time', { get() { throw new Error('read future bar'); } }));
  const result = observe(source);
  assert.equal(result.status, 'pending');
  assert.equal('windows' in result, false);
});
