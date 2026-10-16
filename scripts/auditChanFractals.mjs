import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { analyzeChan } from '../src/lib/chan/index.js';
import { analyzeReferenceCandles, findReferenceFractals, mergeReferenceBar } from '../src/lib/chan/referenceEngine.js';

// Definition expectations are hand-calculated from lessons 62/65.
// Full enumeration is a separate diagnostic, not an established UI requirement.
const raw = (ranges) => ranges.map(([high, low], i) => ({ high, low, time: i + 1,
  open: (high + low) / 2, close: (high + low) / 2, vol: 100 }));
const points = (items) => items.map(({ mark, time, price }) => [mark, time, price]);
const local = (ranges) => points(findReferenceFractals(raw(ranges)));
const main = (ranges) => analyzeChan(raw(ranges).map((bar) => ({ ...bar,
  volume: bar.vol, date: `2026-01-${String(bar.time).padStart(2, '0')}` })));
const results = [];
function check(id, scope, description, expected, actual, input) {
  results.push({ id, scope, description, input, expected, actual, matches: isDeepStrictEqual(expected, actual) });
}
const localCases = [
  ['top', '标准顶：中间高、低同时最高', [[7,3],[9,5],[8,4]], [['G',2,9]]],
  ['bottom', '标准底：中间高、低同时最低', [[9,5],[7,3],[8,4]], [['D',2,3]]],
  ['up', '连续上升不是分型', [[5,1],[6,2],[7,3]], []],
  ['down', '连续下降不是分型', [[7,3],[6,2],[5,1]], []],
  ['only-high', '只满足中间最高价最高不够（单独检查判定谓词）', [[7,3],[9,2],[8,4]], []],
  ['only-low', '只满足中间最低价最低不够（单独检查判定谓词）', [[9,3],[10,2],[8,4]], []],
  ['equal-high', '等高不能直接作为严格三K顶，须先处理包含', [[8,3],[8,5],[7,4]], []],
  ['equal-low', '等低不能直接作为严格三K底，须先处理包含', [[9,3],[7,3],[8,4]], []],
  ['no-right', '两根K线不生成分型', [[7,3],[9,5]], []],
  ['no-left', '一根K线不生成分型', [[7,3]], []],
  ['gap-top', '跳空不排除几何顶分型', [[4,1],[10,8],[6,5]], [['G',2,10]]],
  ['gap-bottom', '跳空不排除几何底分型', [[10,8],[4,1],[6,5]], [['D',2,1]]],
];
for (const [id, description, input, expected] of localCases) check(id, 'local-definition', description, expected, local(input), input);

const mergeCases = [
  ['up-inner', [[7,3],[9,5],[8,6]], [9,6,2]],
  ['up-outer', [[7,3],[9,5],[10,4]], [10,5,3]],
  ['down-inner', [[9,5],[7,3],[6,4]], [6,3,2]],
  ['down-outer', [[9,5],[7,3],[8,2]], [7,2,3]],
  ['up-equal-high', [[7,3],[9,5],[9,6]], [9,6,3]],
  ['down-equal-low', [[9,5],[7,3],[6,3]], [6,3,3]],
];
for (const [id, input, expected] of mergeCases) {
  const [a, b, c] = raw(input);
  const merged = mergeReferenceBar(a, { ...b, from: 1, to: 1, elements: [b] }, c, 2);
  check(id, 'directional-inclusion', '有明确前趋势的包含处理；同价极值时间采用参考站取右侧约定', expected,
    [merged.high, merged.low, merged.time], input);
}

const completeOutputDiagnostics = [];
const completenessCases = [
  ['first-bottom', [[3,2],[2,1],[3,2],[4,3],[5,4],[4,3]], [['D',2,1],['G',5,5]]],
  ['first-top', [[8,7],[9,8],[8,7],[7,6],[6,5],[7,6]], [['G',2,9],['D',5,5]]],
  ['pre-stroke-turns', [[2,1],[4,3],[3,2],[5,4],[4,3]], [['G',2,4],['D',3,2],['G',4,5]]],
];
for (const [id, input, expected] of completenessCases) {
  const actual = main(input);
  completeOutputDiagnostics.push({ id, input, allGeometricFractals: expected,
    displayedFractals: points(actual.fx), penEndpoints: points(actual.bi),
    displaysAll: isDeepStrictEqual(expected, points(actual.fx)),
    assessment: '全量几何分型与主图筛选输出不同；此项本身不判定算法错误，也不证明笔规则正确。' });
}

// Exercise inclusion through the public analysis entry, not just the primitive.
for (const [id, input, expected] of [
  ['merged-top-mapping', [[8,4],[10,6],[11,5],[9,4]], [['G',3,11]]],
  ['merged-bottom-mapping', [[16,12],[14,10],[15,9],[16,11]], [['D',3,9]]],
]) check(id, 'analysis-and-raw-chart-mapping', '原始三K扫描无分型；包含处理后成立，标在真实极值原K时间',
  expected, points(main(input).fx), input);

// Check all 9,261 three-interval inputs on six integer price levels, including
// zero-height candles and equality. This is finite-domain evidence, not a proof
// of the entire incremental engine for arbitrary histories.
const rankRanges = [];
for (let high = 0; high <= 5; high++) for (let low = 0; low <= high; low++) rankRanges.push([high, low]);
const included = ([h1,l1], [h2,l2]) => (h1 >= h2 && l1 <= l2) || (h2 >= h1 && l2 <= l1);
const finiteDomain = {
  description: '0 <= low <= high <= 5，包括一字K；三根K组合共21³组。',
  threeBarPredicate: { total: 0, mismatched: 0 },
  knownDirectionMerge: { total: 0, mismatched: 0 },
};
for (const a of rankRanges) for (const b of rankRanges) for (const c of rankRanges) {
  const input = [a,b,c];
  const highs = input.map(([h]) => h), lows = input.map(([,l]) => l);
  const uniqueMiddle = (values, extreme) => values[1] === extreme
    && values.filter((value) => value === extreme).length === 1;
  const isTop = uniqueMiddle(highs, Math.max(...highs)) && uniqueMiddle(lows, Math.max(...lows));
  const isBottom = uniqueMiddle(highs, Math.min(...highs)) && uniqueMiddle(lows, Math.min(...lows));
  const expected = isTop ? [['G',2,b[0]]] : isBottom ? [['D',2,b[1]]] : [];
  finiteDomain.threeBarPredicate.total++;
  if (!isDeepStrictEqual(expected, local(input))) finiteDomain.threeBarPredicate.mismatched++;
  if (included(a,b)) continue; // The definition requires a prior non-containing pair.
  const [first, middle, next] = raw(input);
  const actual = mergeReferenceBar(first, { ...middle, from: 1, to: 1, elements: [middle] }, next, 2);
  const hasInclusion = included(b,c);
  const orderedHighs = [b[0], c[0]].sort((x,y) => x-y);
  const orderedLows = [b[1], c[1]].sort((x,y) => x-y);
  const side = b[0] > a[0] ? 1 : 0;
  const expectedInterval = hasInclusion ? [orderedHighs[side], orderedLows[side], 1] : [...c, 2];
  finiteDomain.knownDirectionMerge.total++;
  if (!isDeepStrictEqual(expectedInterval, [actual.high, actual.low, actual.from])) finiteDomain.knownDirectionMerge.mismatched++;
}

// Exhaustive finite-domain mirror check, not a proof for all real-number inputs.
const ranges = [];
for (let high = 1; high <= 5; high++) for (let low = 0; low < high; low++) ranges.push([high, low]);
const mirror = (input) => input.map(([high, low]) => [10 - low, 10 - high]);
const mirroredPoints = (items) => items.map(([mark, time, price]) => [mark === 'G' ? 'D' : 'G', time, 10 - price]);
const symmetry = { knownInitialDirection: { total: 0, mismatched: 0 }, ambiguousInitialDirection: { total: 0, mismatched: 0 } };
for (const a of ranges) for (const b of ranges) for (const c of ranges) for (const d of ranges) {
  const input = [a,b,c,d];
  const group = included(a,b) ? symmetry.ambiguousInitialDirection : symmetry.knownInitialDirection;
  group.total++;
  const fx = points(analyzeReferenceCandles(raw(input)).fx);
  const mirroredFx = points(analyzeReferenceCandles(raw(mirror(input))).fx);
  if (!isDeepStrictEqual(mirroredPoints(fx), mirroredFx)) group.mismatched++;
}
const startupInput = [[1,0],[2,0],[2,1],[1,0]];
const realtimeTop = [[2,1],[3,2],[2.5,1.5]];
const realtimeUpdated = [[2,1],[3,2],[3.5,1.5]];
const report = {
  auditedAt: '2026-10-16', entry: 'src/lib/chan/index.js → referenceEngine.js → ChanOverlay.jsx',
  scope: '三K分型谓词、已知方向包含公式、合并后原K定位与四K上下对称的有限域审计。生产初始化已修复；不是全部笔/线段/中枢/买卖点的证明。',
  sources: [
    { lesson: 62, url: 'https://blog.sina.com.cn/s/blog_486e105c01000bf2.html' },
    { lesson: 65, url: 'https://blog.sina.com.cn/s/blog_486e105c01000bpo.html' },
    { lesson: 82, url: 'https://blog.sina.com.cn/s/blog_486e105c01000cq4.html' },
  ],
  correction: '保留全量圆点与笔筛选输出的差异诊断，不把二者差异本身计为定义错误。2026-10-16已修复未知初始方向的不对称；成笔和动态日期另有独立回归。',
  passed: results.filter((r) => r.matches).length, total: results.length,
  matchesAllDefinitionChecks: results.every((r) => r.matches), results,
  completeOutputDiagnostics, finiteDomain, symmetry,
  limitations: [
    { id: 'startup-direction', assessment: '已修复不对称；未知前缀按窗口边界政策跳过', input: startupInput,
      actual: points(main(startupInput).fx), mirroredInput: mirror(startupInput), mirroredActual: points(main(mirror(startupInput)).fx),
      reason: '原典方向定义需要更早的非包含对。方向未知时只保留最新原K作为边界，直到非包含对建立方向；不向未来借方向。此边界政策不是原文唯一实现。' },
    { id: 'live-right-bar', assessment: '未收盘快照允许变化；输出没有单独的收盘确认状态，不能据此判算法错误', input: realtimeTop,
      actual: points(main(realtimeTop).fx), updatedInput: realtimeUpdated, updatedActual: points(main(realtimeUpdated).fx),
      reason: '同一右侧K线盘中扩大高低区间后分型可消失；当前fx没有confirmed/confirmedAt，不能声称已验证收盘确认。' },
    { id: 'strength', assessment: '力度形态已实现，另有独立测试；本脚本未检验力度',
      reason: '第82课定性条件与软件比例阈值必须区分；不使用未来K，不宣称概率或相对高低点确认。' },
    { id: 'equal-extreme-time', assessment: '参考站取最后一次同价极值，非原典唯一定位要求',
      reason: '保留的旧fractal.js取较早极值；它的单元测试不能替代主图生产路径测试。' },
  ],
};
report.verifiedCoreChecksPassed = report.matchesAllDefinitionChecks
  && Object.values(finiteDomain).filter((item) => typeof item === 'object').every((item) => !item.mismatched)
  && symmetry.knownInitialDirection.mismatched === 0;
// A passing finite-domain subset is not an unconditional full-engine proof.
report.fractalAuditPassed = report.verifiedCoreChecksPassed && symmetry.ambiguousInitialDirection.mismatched === 0;
console.table(results.map(({ id, scope, matches }) => ({ id, scope, matches })));
console.log(`定义及合并后原K定位检查：${report.passed}/${report.total}。`);
console.log(`全量圆点输出差异：${completeOutputDiagnostics.filter((item) => !item.displaysAll).length}项（独立诊断，不作为已确立的定义失败）。`);
console.log(JSON.stringify(finiteDomain));
console.log(JSON.stringify(symmetry));
console.log(`本脚本有限域分型审计通过：${report.fractalAuditPassed}；不代表全部缠论功能已验证。`);
if (process.argv.includes('--report')) await writeFile(new URL('../docs/chan-fractal-audit-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
if (!report.fractalAuditPassed) process.exitCode = 1;
