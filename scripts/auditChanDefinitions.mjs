// Source-rule audit of the active pipeline. This is not a return backtest or
// full original-text certification. Known counterexamples deliberately fail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { analyzeChan } from '../src/lib/chan/index.js';
import { analyzeReferenceCandles, findReferenceFractals, mergeReferenceBar } from '../src/lib/chan/referenceEngine.js';
import { buildSegments } from '../src/lib/chan/segment.js';
import { buildZs } from '../src/lib/chan/referenceZs.js';

const source = lesson => ({
  62: 'https://blog.sina.com.cn/s/blog_486e105c01000bf2.html',
  65: 'https://blog.sina.com.cn/s/blog_486e105c01000bpo.html',
  67: 'https://blog.sina.com.cn/s/blog_486e105c01000c16.html',
  77: 'https://blog.sina.com.cn/s/blog_486e105c01000cih.html',
}[lesson]);
const checks = [];
function check(id, lesson, description, expected, actual, evidence = {}) {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; }
  checks.push({ id, source: source(lesson), description, status: passed ? 'pass' : 'fail', expected, actual, ...evidence });
}
const candles = ranges => ranges.map(([high, low], i) => ({
  time: i + 1, date: `K${i + 1}`, high, low, open: low, close: high, volume: 100, complete: true,
}));
const processed = ranges => candles(ranges).map((bar, i) => ({
  ...bar, from: i, to: i, elements: [{ ...bar, idx: i }], mergeSteps: [],
}));
const endpoints = (prices, sign = 1) => prices.map((price, i) => ({
  time: i + 1, price: sign * price, mark: (i % 2 === 0) === (sign === 1) ? 'D' : 'G',
  confirmed: true, confirmed_time: i + 1,
}));

const upBars = processed([[8, 4], [10, 6], [11, 5]]);
const up = mergeReferenceBar(upBars[0], upBars[1], upBars[2], 2);
check('F01', 62, 'Upward inclusion takes higher high and higher low', [11, 6], [up.high, up.low]);
const downBars = processed([[14, 10], [12, 8], [13, 7]]);
const down = mergeReferenceBar(downBars[0], downBars[1], downBars[2], 2);
check('F02', 62, 'Downward inclusion takes lower high and lower low', [12, 7], [down.high, down.low]);
for (const [id, ranges, expected] of [
  ['F03', [[8, 4], [10, 6], [9, 5]], [['G', 2, 10]]],
  ['F04', [[9, 5], [7, 3], [8, 4]], [['D', 2, 3]]],
]) check(id, 62, 'Three processed K high/low fractal geometry', expected,
  findReferenceFractals(processed(ranges)).map(p => [p.mark, p.time, p.price]));

const six = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [4, 3]];
const seven = [[3, 2], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [5, 4]];
check('B01', 77, 'Old pen rejects six processed K without an independent K', [],
  analyzeReferenceCandles(candles(six)).bi);
check('B02', 77, 'Old pen accepts two three-K fractals separated by one independent K', [[2, 'D'], [6, 'G']],
  analyzeReferenceCandles(candles(seven)).bi.map(p => [p.time, p.mark]));
check('L01', 67, 'Ordinary no-gap top characteristic fractal', [[3, 'feature_no_gap']],
  buildSegments(endpoints([0, 100, 40, 120, 50, 90, 30])).segments.map(s => [s.endIndex, s.confirmation]));
check('L02', 67, 'Gap case can confirm with reverse fractal without filling old gap',
  [[3, 'feature_gap_reverse_fractal'], [6, 'reverse_feature_fractal']],
  buildSegments(endpoints([0, 40, 20, 100, 70, 90, 60, 80, 70, 90])).segments.map(s => [s.endIndex, s.confirmation]));

// Independent hand derivation from lesson 67: after upward inclusion,
// [50,120] + [110,115] = [110,120]. Thus the STANDARD sequence
// [40,100], [110,120], [105,114] has a gap (100,110).
// The reverse feature sequence has not formed a bottom fractal yet.
const gapPrices = [0, 100, 40, 120, 50, 115, 110, 114, 105];
const standardEvidence = {
  prices: gapPrices,
  featureIntervalsLowHigh: [[40, 100], [50, 120], [110, 115], [105, 114]],
  standardIntervalsLowHigh: [[40, 100], [110, 120], [105, 114]],
  gapAfterInclusion: [100, 110],
  reverseFeatureIntervalsLowHigh: [[50, 115], [110, 114]],
  expectedExplanation: 'No confirmed segment: the standardized first two elements have a gap and the reverse sequence has no fractal.',
};
for (const sign of [1, -1]) {
  const actual = buildSegments(endpoints(gapPrices, sign)).segments;
  check(`L03-${sign === 1 ? 'up' : 'down'}`, 67,
    'Gap branch must be determined AFTER feature inclusion', [],
    actual.map(s => ({ endIndex: s.endIndex, confirmation: s.confirmation, feature_gap: s.feature_gap })),
    { sign, evidence: standardEvidence });
}

// Reach the same case through the real active OHLC -> fractal -> pen pipeline.
const turns = [20, ...gapPrices, 113, 104, 112];
const prices = turns.flatMap((price, i) => i
  ? Array.from({ length: 8 }, (_, j) => turns[i - 1] + (price - turns[i - 1]) * (j + 1) / 8)
  : [price]);
for (const sign of [1, -1]) {
  const rows = prices.slice(0, 82).map((price, i) => ({
    date: `K${i + 1}`, open: 200 + sign * price, close: 200 + sign * price,
    high: 200 + sign * price + .1, low: 200 + sign * price - .1, volume: 100, complete: true,
  }));
  const result = analyzeChan(rows, 'day');
  check(`L04-${sign === 1 ? 'up' : 'down'}`, 67,
    'Active OHLC pipeline must retain the gap case as unconfirmed', [],
    result.segments.map(s => ({ start: s.start.time, end: s.end.time,
      confirmed_time: s.confirmed_time, confirmation: s.confirmation })),
    { sign, turns, barsPerLeg: 8, prefixLength: rows.length, confirmedPenEndpoints: result.segmentBi.filter(p => p.confirmed) });
}

const fixtureDirectory = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
const fixtureReports = [];
let endpointPairs = 0;
const invalidEndpointPairs = [];
for (const filename of readdirSync(fixtureDirectory).filter(name => name.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(new URL(filename, fixtureDirectory), 'utf8'));
  const rows = fixture.candles.map(({ time, vol, ...row }) => ({ ...row, date: String(time), volume: vol }));
  const result = analyzeChan(rows, fixture.period);
  for (let i = 1; i < result.bi.length; i++) {
    endpointPairs++;
    const a = result.bi[i - 1], b = result.bi[i];
    const top = result.fractalDetails.bi[(a.mark === 'G' ? a : b).time].mergedCandles[1];
    const bottom = result.fractalDetails.bi[(a.mark === 'D' ? a : b).time].mergedCandles[1];
    if (!(top.high > bottom.high)) invalidEndpointPairs.push({ filename, index: i, top, bottom });
  }
  fixtureReports.push({ filename, bars: rows.length, strokes: Math.max(0, result.bi.length - 1),
    confirmedSegments: result.segments.length, slidingZones: result.zs.length,
    unconfirmedTailInZone: result.bi.at(-1)?.confirmed === false
      && result.zs.some(z => z.edt === result.bi.at(-1).time) });
}
check('B03', 77, 'Saved-sample top K extends above bottom K (finite sample, not proof)', [], invalidEndpointPairs,
  { endpointPairs });

// Seeded exploration of that same single necessary condition, not an alternate
// pen algorithm and not a claim that 30,000 synthetic histories match the text.
let state = 771062, sampledPairs = 0;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
let sampledViolation = null;
for (let trial = 0; trial < 30000 && !sampledViolation; trial++) {
  const ranges = Array.from({ length: 35 }, () => {
    const low = 1 + Math.floor(random() * 16);
    return [low + 1 + Math.floor(random() * 16), low];
  });
  const result = analyzeReferenceCandles(candles(ranges));
  for (let i = 1; i < result.bi.length; i++) {
    sampledPairs++;
    const a = result.bi[i - 1], b = result.bi[i];
    const top = result.fractalDetails.bi[(a.mark === 'G' ? a : b).time].mergedCandles[1];
    const bottom = result.fractalDetails.bi[(a.mark === 'D' ? a : b).time].mergedCandles[1];
    if (!(top.high > bottom.high)) { sampledViolation = { trial, ranges, top, bottom }; break; }
  }
}
check('B04', 77, 'Seeded search for top-K endpoint-range violation (one condition only)', null, sampledViolation,
  { seed: 771062, histories: 30000, barsPerHistory: 35, endpointPairs: sampledPairs });

const pendingFractalRows = candles([[8, 4], [10, 6], [9, 5]]);
pendingFractalRows.at(-1).complete = false;
const openFractal = analyzeReferenceCandles(pendingFractalRows).fx;
const unconfirmedZonePoints = endpoints([0, 10, 4, 12]);
unconfirmedZonePoints.at(-1).confirmed = false;
const persistentOverlapPrices = [0, 10, 4, 12, 3, 11, 4, 13, 2, 12, 3, 11, 4, 12];
const sourceFiles = ['src/lib/chan/index.js', 'src/lib/chan/referenceEngine.js', 'src/lib/chan/segment.js',
  'src/lib/chan/referenceZs.js', 'src/components/ChanOverlay.jsx'];
const report = {
  scope: 'Active pipeline source-rule audit; observations and bounded checks do not certify all original figures or live services.',
  auditedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(sourceFiles.map(path => [path,
    createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')])),
  checks,
  summary: { passed: checks.filter(c => c.status === 'pass').length, failed: checks.filter(c => c.status === 'fail').length },
  observations: {
    explicitUnclosedRightKStillEmitsFractalWithoutStatus: openFractal,
    firstPenAnchorCircleOmission: { pens: analyzeReferenceCandles(candles(seven)).bi,
      circles: analyzeReferenceCandles(candles(seven)).fx },
    unconfirmedEndpointIncludedInZone: buildZs(unconfirmedZonePoints),
    persistentOverlapProducesMultipleWindows: { prices: persistentOverlapPrices,
      zones: buildZs(endpoints(persistentOverlapPrices)) },
  },
  fixtureReports,
};
if (process.argv.includes('--report')) writeFileSync(new URL('../docs/chan-definition-audit-2026-10-23.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report.summary, failedChecks: checks.filter(c => c.status === 'fail'),
  savedHistories: fixtureReports.length, savedEndpointPairs: endpointPairs, sampledEndpointPairs: sampledPairs }, null, 2));
if (report.summary.failed) process.exitCode = 1;
