import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildSegments, SEGMENT_RULE_VERSION } from '../src/lib/chan/segment.js';
import { analyzeChan } from '../src/lib/chan/index.js';
import { SEGMENT_SPEC_CASES, segmentGapRows, retractionRows } from '../src/lib/chan/fixtures/segmentGap.js';

const endpoints = prices => prices.map((price, i) => ({ price, time: i + 1, idx: i,
  mark: (i % 2 === 0) === (prices[1] > prices[0]) ? 'D' : 'G', confirmed: true, confirmed_time: i + 1 }));
const compact = result => result.segments.map(s => [s.startIndex, s.endIndex, s.confirmedIndex, s.confirmation]);
const dated = result => result.segments.map(s => [s.id, s.confirmed_time, s.confirmation]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [];
const record = (id, expected, actual, evidence = {}) => cases.push({ id, ...evidence, expected, actual, passed: equal(expected, actual) });
for (const fixture of SEGMENT_SPEC_CASES) for (const sign of [1, -1]) {
  record(fixture.id, fixture.expected, compact(buildSegments(endpoints(fixture.prices.map(p => sign * p)))),
    { sign, prices: fixture.prices });
}
for (const sign of [1, -1]) for (const count of [82, 121, 122]) {
  const expected = count < 122 ? [] : [['segment-9-33', 122, 'feature_gap_reverse_fractal'],
    ['segment-33-89', 122, 'reverse_feature_fractal']];
  record('active-closed-ohlc', expected, dated(analyzeChan(segmentGapRows(count, sign))), { count, sign });
}
for (const seed of [1283762, 27]) {
  const rows = retractionRows(seed);
  const expected = seed === 1283762 ? [[], []] : [
    [['segment-35-99', 147, 'feature_no_gap'], ['segment-99-129', 184, 'first_stroke_break']],
    [['segment-35-99', 147, 'feature_no_gap']],
  ];
  record(seed === 27 ? 'upstream-retraction-preserved' : 'old-retraction-fixture-invalid-confirmation', expected,
    [199, 200].map(count => dated(analyzeChan(rows.slice(0, count)))), { seed });
}

let state = 67177881;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
const properties = { seed: state, inputs: 2000, endpoints: 31,
  prefixFailures: 0, mirrorFailures: 0, positiveScaleFailures: 0, evidenceFailures: 0, examples: [] };
for (let n = 0; n < properties.inputs; n++) {
  const prices = [100];
  for (let i = 1; i < properties.endpoints; i++) prices.push(prices.at(-1) + (i % 2 ? 1 : -1) * (1 + Math.floor(random() * 30)));
  const points = endpoints(prices);
  const result = buildSegments(points), full = compact(result);
  for (let count = 0; count <= points.length; count++) {
    if (!equal(compact(buildSegments(points.slice(0, count))), full.filter(s => s[2] < count))) {
      properties.prefixFailures++;
      if (properties.examples.length < 3) properties.examples.push({ kind: 'prefix', prices, count });
      break;
    }
  }
  if (!equal(full, compact(buildSegments(endpoints(prices.map(p => -p)))))) properties.mirrorFailures++;
  if (!equal(full, compact(buildSegments(endpoints(prices.map(p => 7 * p + 101)))))) properties.positiveScaleFailures++;
  for (const segment of result.segments) {
    const evidence = segment.evidence;
    const elements = [...(evidence.initial ?? []), ...(evidence.standard ?? []), ...(evidence.reverse ?? []),
      ...(evidence.breaking ? [evidence.breaking] : [])];
    if (elements.some(e => e.to > segment.confirmedIndex || e.from > e.to
      || e.high !== points[e.highIndex].price || e.low !== points[e.lowIndex].price)) properties.evidenceFailures++;
  }
}
const report = { scope: 'Current production rules: finite source-derived checks and structural properties, not proof of all original figures.',
  version: SEGMENT_RULE_VERSION,
  hashes: Object.fromEntries(['segment.js', 'referenceEngine.js', 'index.js'].map(name => [name,
    createHash('sha256').update(readFileSync(new URL(`../src/lib/chan/${name}`, import.meta.url))).digest('hex')])),
  cases, properties, pageTests: 'Recorded separately in test-results/isolated; this script does not run a browser.' };
if (process.argv.includes('--report')) writeFileSync(new URL('../docs/chan-segment-validation.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ version: report.version, total: cases.length, passed: cases.filter(c => c.passed).length,
  failed: cases.filter(c => !c.passed).length, properties }, null, 2));
if (cases.some(c => !c.passed) || properties.prefixFailures || properties.mirrorFailures
  || properties.positiveScaleFailures || properties.evidenceFailures) process.exitCode = 1;
