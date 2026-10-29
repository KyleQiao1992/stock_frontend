import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSegmentCenterFrontier } from './centerFrontierPrototype.js';
import { buildZsDetailed } from './zs.js';

// One shared endpoint candle can put a high anywhere between 6 and 8 into
// segment 2. This is an over-approximation, not a claim about real prices.
function fixture(highMin = 6, highMax = 8) {
  const endpoints = [7, 10, 5, 6, 5.5, 9, 5.5];
  return endpoints.slice(0, -1).map((value, i) => {
    const end = endpoints[i + 1];
    return { id: `s${i}`, confirmed: true, direction: end > value ? 'up' : 'down',
      start: { time: i + 1, price: value }, end: { time: i + 2, price: end }, confirmed_time: i + 3,
      range_bounds: { low_min: Math.min(value, end), low_max: Math.min(value, end),
        high_min: i === 2 ? highMin : Math.max(value, end), high_max: i === 2 ? highMax : Math.max(value, end) } };
  });
}

// Separate exact-price executable oracle, not the prototype's abstract engine.
// Used on interior points as well as endpoints; samples are NOT an exhaustive
// proof for a continuous interval. The prototype reasons over whole intervals.
function exactOracle(segments) {
  const result = [];
  let start = 0;
  const overlap = (s, zd, zg) => s.low <= zg && s.high >= zd;
  while (start + 2 < segments.length) {
    const first = segments.slice(start, start + 3);
    const zd = Math.max(...first.map(s => s.low)), zg = Math.min(...first.map(s => s.high));
    if (zd >= zg) { start++; continue; }
    const zone = { start, zd, zg, status: 'active' };
    let nextStart = segments.length;
    for (let i = start + 2; i < segments.length; i++) {
      const s = segments[i], next = segments[i + 1];
      const side = s.direction === 'up' && s.end.price > zg ? 'up'
        : s.direction === 'down' && s.end.price < zd ? 'down' : null;
      const outside = side && next && (side === 'up' ? next.low > zg : next.high < zd);
      if (outside && overlap(s, zd, zg)) { zone.status = 'closed'; nextStart = i; break; }
      if (side && !next && overlap(s, zd, zg)) break;
      if (!overlap(s, zd, zg)) {
        if (s.direction === first[0].direction || (next && !overlap(next, zd, zg))) {
          zone.status = 'closed'; nextStart = i; break;
        }
        if (!next) break;
      }
    }
    result.push(zone);
    start = Math.max(start + 1, nextStart);
  }
  return result;
}

function exactVersion(segments, high) {
  return segments.map((s, i) => ({ ...s, low: s.range_bounds.low_min,
    high: i === 2 ? high : s.range_bounds.high_min }));
}

test('ambiguous early core prevents asserting an unconditionally later core', () => {
  const segments = fixture();
  const a = exactOracle(exactVersion(segments, 8));
  const b = exactOracle(exactVersion(segments, 6));
  assert.deepEqual(a.map(z => [z.start, z.zd, z.zg]), [[0, 7, 8]]);
  assert.deepEqual(b.map(z => [z.start, z.zd, z.zg]), [[1, 5.5, 6]]);
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'multiple_possible_paths');
  assert.deepEqual(result.cores, []);
  assert.ok(result.ambiguous);
});

test('every claimed fixed core is present in every sampled concrete realization', () => {
  const segments = fixture();
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  for (const high of [6, 6.1, 6.9, 7, 7.1, 7.5, 8]) {
    const exact = exactOracle(exactVersion(segments, high));
    for (const core of result.cores) assert.ok(exact.some(z => z.start === core.start_index
      && z.zd === core.zd && z.zg === core.zg));
  }
});

test('fully known common core is returned only as conditional on supplied ranges', () => {
  const segments = fixture(8, 8);
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  assert.equal(result.status, 'conditional');
  assert.equal(result.source_proof, 'caller_supplied_bounds');
  assert.deepEqual(result.cores.map(z => [z.start_index, z.zd, z.zg]), [[0, 7, 8]]);
  assert.equal(result.cores[0].observed_at, 20);
});

test('later evidence can make all abstract paths agree on a new core', () => {
  const segments = fixture();
  const endpoints = [5.5, 15, 12, 16];
  for (let j = 0; j < 3; j++) {
    const i = segments.length, a = endpoints[j], b = endpoints[j + 1];
    segments.push({ id: `s${i}`, confirmed: true, direction: b > a ? 'up' : 'down',
      start: { time: i + 1, price: a }, end: { time: i + 2, price: b }, confirmed_time: i + 3,
      range_bounds: { low_min: Math.min(a, b), low_max: Math.min(a, b),
        high_min: Math.max(a, b), high_max: Math.max(a, b) } });
  }
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  assert.equal(result.status, 'indeterminate');
  assert.ok(result.cores.some(c => c.start_index === 6 && c.zd === 12 && c.zg === 15));
  for (const high of [6, 6.5, 7, 7.5, 8]) {
    assert.ok(exactOracle(exactVersion(segments, high)).some(z => z.start === 6 && z.zd === 12 && z.zg === 15));
  }
});

test('known formation remains visible when lifecycle paths disagree', () => {
  const segments = fixture(8, 8).slice(0, 4);
  segments.push({ id: 's4', confirmed: true, direction: 'up',
    start: { time: 5, price: 5.5 }, end: { time: 6, price: 6.5 }, confirmed_time: 7,
    range_bounds: { low_min: 5.5, low_max: 5.5, high_min: 6.5, high_max: 9 } });
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(result.cores.map(c => [c.start_index, c.zd, c.zg, c.status]), [[0, 7, 8, 'uncertain']]);
  for (const high of [6.5, 7, 7.5, 8, 9]) {
    const exact = segments.map((s, i) => ({ ...s, low: s.range_bounds.low_min,
      high: i === 4 ? high : s.range_bounds.high_min }));
    assert.ok(exactOracle(exact).some(z => z.start === 0 && z.zd === 7 && z.zg === 8));
  }
});

test('as-of replay does not use unobserved segments', () => {
  const segments = fixture(8, 8);
  const result = analyzeSegmentCenterFrontier(segments, { asOfTime: 4 });
  assert.deepEqual(result.cores, []);
  assert.equal(result.observed_segment_count, 2);
  const future = [...segments];
  future[4] = { ...future[4], range_bounds: null, id: 'future-invalid' };
  assert.deepEqual(analyzeSegmentCenterFrontier(future, { asOfTime: 4 }), result);
});

test('shared endpoint indices must agree with production connectivity when present', () => {
  const segments = fixture(8, 8);
  segments[0].end.idx = 3;
  segments[1].start.idx = 4; // same time/price but different source endpoint
  const production = buildZsDetailed(segments.map(s => ({ ...s,
    low: s.range_bounds.low_min, high: s.range_bounds.high_min,
  })));
  assert.deepEqual(production.zones, []);
  assert.throws(() => analyzeSegmentCenterFrontier(segments, { asOfTime: 20 }), /connected/);
});

test('reported segment ranges cannot contradict independently supplied range bounds', () => {
  const segments = fixture(8, 8).map(s => ({ ...s,
    low: s.range_bounds.low_max, high: s.range_bounds.high_min,
  }));
  segments[2].high = 9;
  assert.deepEqual(buildZsDetailed(segments).zones, []);
  assert.throws(() => analyzeSegmentCenterFrontier(segments, { asOfTime: 20 }), /bounds/);
});

test('confirmation and endpoint K coordinates must be finite positive integers', () => {
  for (const invalid of [NaN, Infinity, -1, 7.5, '7']) {
    const segments = fixture(8, 8).slice(0, 3);
    segments[2].confirmed_time = invalid;
    assert.throws(() => analyzeSegmentCenterFrontier(segments, { asOfTime: 20 }), /confirmation|time/i);
  }
  const segments = fixture(8, 8).slice(0, 3);
  segments[1].end.time = 3.5; segments[2].start.time = 3.5;
  assert.throws(() => analyzeSegmentCenterFrontier(segments, { asOfTime: 20 }), /time/i);
});

test('a valid future confirmation time does not cause unobserved segment details to be read', () => {
  const prefix = fixture(8, 8).slice(0, 3);
  const future = { confirmed: true, confirmed_time: 6, id: 'future-invalid', range_bounds: null };
  assert.deepEqual(analyzeSegmentCenterFrontier([...prefix, future], { asOfTime: 5 }),
    analyzeSegmentCenterFrontier(prefix, { asOfTime: 5 }));
  assert.throws(() => analyzeSegmentCenterFrontier([...prefix, future], { asOfTime: 6 }));
});

test('state cap reports indeterminate and never silently drops possibilities', () => {
  const result = analyzeSegmentCenterFrontier(fixture(), { asOfTime: 20, maxStates: 1 });
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'state_limit');
  assert.deepEqual(result.cores, []);
});

test('independent sampled realizations never contradict a reported core or its status', () => {
  let seed = 0x12345678;
  let comparisons = 0, sampled = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let trial = 0; trial < 100; trial++) {
    let price = 10;
    const segments = Array.from({ length: 7 }, (_, i) => {
      const next = price + (i % 2 ? -1 : 1) * (1 + Math.floor(random() * 5));
      const low = Math.min(price, next), high = Math.max(price, next);
      const s = { id: `r${i}`, confirmed: true, direction: next > price ? 'up' : 'down',
        start: { time: i + 1, price }, end: { time: i + 2, price: next }, confirmed_time: i + 3,
        range_bounds: { low_min: low - (i < 2 ? random() * 2 : 0), low_max: low,
          high_min: high, high_max: high + (i < 2 ? random() * 2 : 0) } };
      price = next;
      return s;
    });
    const abstract = analyzeSegmentCenterFrontier(segments, { asOfTime: 20, maxStates: 20000 });
    if (abstract.reason === 'state_limit') continue;
    for (let sample = 0; sample < 12; sample++) {
      const concrete = segments.map(s => ({ ...s,
        low: s.range_bounds.low_min + random() * (s.range_bounds.low_max - s.range_bounds.low_min),
        high: s.range_bounds.high_min + random() * (s.range_bounds.high_max - s.range_bounds.high_min) }));
      const oracle = exactOracle(concrete);
      sampled++;
      for (const core of abstract.cores) {
        comparisons++;
        const found = oracle.find(z => z.start === core.start_index && z.zd === core.zd && z.zg === core.zg);
        assert.ok(found, `trial ${trial} sample ${sample} lacks claimed core`);
        if (core.status !== 'uncertain') assert.equal(found.status, core.status, `trial ${trial} sample ${sample}`);
      }
    }
  }
  assert.equal(sampled, 1200);
  assert.ok(comparisons > 0, 'the sampled oracle should exercise at least one reported core');
});

// Explicit full-range examples, including interior extremes. Values are
// translated by 20 so these synthetic prices remain positive. Each scenario
// exercises the production geometric lifecycle, not the test oracle above.
function knownSegments(rows) {
  return rows.map(([start, end, low, high], index) => ({
    id: `p${index}`, confirmed: true, direction: end > start ? 'up' : 'down',
    start: { time: index + 1, price: start + 20 }, end: { time: index + 2, price: end + 20 },
    confirmed_time: index + 3, low: low + 20, high: high + 20,
    range_bounds: { low_min: low + 20, low_max: low + 20, high_min: high + 20, high_max: high + 20 },
  }));
}

test('frontier agrees with actual lifecycle for two misses, first retest, a Z exit, and every observed prefix', () => {
  const cases = [
    { expected: ['two_consecutive_segments_outside'], rows: [
      [10,13,10,15], [13,8,8,13], [8,14,6,16], [14,6,6,14], [6,11,5,13],
      [11,3,3,12], [3,8,2,10], [8,2,1,8], [2,4,1,5], [4,0,0,6],
    ] },
    { expected: ['first_retest_strictly_outside', 'z_segment_outside'], rows: [
      [10,13,9,13], [13,11,10,14], [11,14,11,14], [14,8,7,16], [8,15,6,15],
      [15,8,7,15], [8,9,6,10], [9,2,0,9], [2,6,1,8], [6,-2,-2,6],
    ] },
  ];
  for (const { expected, rows } of cases) {
    const segments = knownSegments(rows);
    for (const kind of expected) assert.ok(buildZsDetailed(segments).zones.some(zone => zone.evidence.closure?.kind === kind));
    for (let asOfTime = 1; asOfTime <= segments.at(-1).confirmed_time; asOfTime++) {
      const concrete = segments.filter(s => s.confirmed_time <= asOfTime);
      const production = buildZsDetailed(concrete);
      const frontier = analyzeSegmentCenterFrontier(segments, { asOfTime });
      assert.equal(production.uncertainties.length, 0);
      assert.equal(frontier.status, 'conditional');
      assert.deepEqual(frontier.cores.map(c => [c.start_index, c.zd, c.zg, c.status]),
        production.zones.map(z => [z.startIndex, z.zd, z.zg, z.status]), `${expected.join('/')} at K${asOfTime}`);
    }
  }
});

test('resynchronized common core is present in actual geometry for multiple early realizations', () => {
  const segments = fixture();
  for (const [a, b] of [[5.5, 15], [15, 12], [12, 16]]) {
    const i = segments.length;
    segments.push({ id: `s${i}`, confirmed: true, direction: b > a ? 'up' : 'down',
      start: { time: i + 1, price: a }, end: { time: i + 2, price: b }, confirmed_time: i + 3,
      range_bounds: { low_min: Math.min(a, b), low_max: Math.min(a, b),
        high_min: Math.max(a, b), high_max: Math.max(a, b) } });
  }
  const frontier = analyzeSegmentCenterFrontier(segments, { asOfTime: 20 });
  assert.ok(frontier.cores.some(c => c.start_index === 6 && c.zd === 12 && c.zg === 15));
  for (const high of [6, 6.1, 6.5, 7, 7.1, 7.5, 8]) {
    const concrete = exactVersion(segments, high).map(s => ({ ...s, range_bounds: {
      low_min: s.low, low_max: s.low, high_min: s.high, high_max: s.high,
    } }));
    const production = buildZsDetailed(concrete);
    for (const core of frontier.cores) {
      const matching = production.zones.find(z => z.startIndex === core.start_index && z.zd === core.zd && z.zg === core.zg);
      assert.ok(matching, `actual geometry lacks claimed common core for high=${high}`);
      if (core.status !== 'uncertain') assert.equal(core.status, matching.status);
    }
  }
});
