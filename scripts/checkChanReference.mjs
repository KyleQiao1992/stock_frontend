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
console.log(`Current chart parity: ${count}/${results.length}; website-fractal candidate: ${results.filter((r) => r.referenceFractalMatches).length}/${results.length}.`);
console.log(`Website-zone candidate with oracle pen endpoints: ${results.filter((r) => r.referenceZonesMatchWithOraclePens).length}/${results.length}.`);
if (process.argv.includes('--report')) {
  await writeFile(new URL('../docs/chan-reference-results.json', import.meta.url), JSON.stringify({
    capturedAt: '2026-10-06', currentChartMatched: count, total: results.length, results,
  }, null, 2) + '\n');
}
// This gate must fail until the actual chart agrees with every fixture.
if (count !== results.length || !results.length) process.exitCode = 1;
