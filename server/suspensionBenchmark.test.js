import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeRisk } from './suspensionAlert.js';

test('Shanghai main-board A shares use the SSE A-share index rather than the composite index', async () => {
  const rules = JSON.parse(readFileSync(new URL('./suspensionRules.json', import.meta.url), 'utf8'));
  assert.deepEqual(rules.boards.SH_MAIN.benchmarkIndex, { name: '上证A股指数', code: '000002' });
  assert.equal(rules.boards.STAR.benchmarkIndex.code, '000688');
  const rows = Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
    close: 100, referenceClose: 100,
  }));
  const calls = [];
  const result = await computeRisk('600519', '贵州茅台', {
    today: '2026-10-20',
    loadFeed: async () => ({}),
    loadDaily: async (code, { isIndex }) => {
      calls.push({ code, isIndex });
      return { name: isIndex ? '上证A股指数' : '贵州茅台', rows };
    },
  });
  assert.deepEqual(calls, [{ code: '600519', isIndex: false }, { code: '000002', isIndex: true }]);
  assert.equal(result.level, 'normal');
  assert.equal(result.benchmark, '上证A股指数(000002)');
});
