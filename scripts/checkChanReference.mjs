import { readdir, readFile, writeFile } from 'node:fs/promises';
import { compareReference } from '../src/lib/chan/referenceParity.js';

const fixturesDir = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
const names = (await readdir(fixturesDir)).filter((name) => name.endsWith('.json')).sort();
const results = [];
for (const name of names) {
  const fixture = JSON.parse(await readFile(new URL(name, fixturesDir), 'utf8'));
  results.push(compareReference(fixture));
}
const count = results.filter((r) => r.matches).length;
console.table(results.map((r) => ({
  case: `${r.market}${r.symbol}/${r.period}`, bars: r.bars,
  fx: `${r.checks.fx.actualCount}/${r.checks.fx.expectedCount}`,
  biLinePoints: `${r.checks.bi.actualCount}/${r.checks.bi.expectedCount}`,
  zs: `${r.checks.zs.actualCount}/${r.checks.zs.expectedCount}`,
  outlook: r.checks.outlook.difference === null,
  exactMatch: r.matches, candidateFx: r.referenceFractalMatches,
  candidateZsFromOraclePens: r.referenceZonesMatchWithOraclePens,
})));
console.log(`Historical website parity diagnostic: ${count}/${results.length}; website-fractal candidate: ${results.filter((r) => r.referenceFractalMatches).length}/${results.length}.`);
console.log(`Website-zone candidate with oracle pen endpoints: ${results.filter((r) => r.referenceZonesMatchWithOraclePens).length}/${results.length}.`);
if (process.argv.includes('--report')) {
  await writeFile(new URL('../docs/chan-reference-results.json', import.meta.url), JSON.stringify({
    capturedAt: '2026-10-06', auditedAt: '2026-10-16',
    scope: '历史网站兼容诊断；原文旧笔独立K、真实动态日期与无伪评分修正后允许产生差异。不是原典正确性验收。', currentChartMatched: count, total: results.length, results,
  }, null, 2) + '\n');
}
// Retain a nonzero exit on ANY historical difference. Do not rewrite archived
// expectations or present this diagnostic as a proof of original-text accuracy.
if (count !== results.length || !results.length) process.exitCode = 1;
