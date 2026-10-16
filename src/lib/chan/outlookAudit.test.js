import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { buildReferenceOutlook } from './referenceOutlook.js';

const candles = [
  { time: '2026-10-12', open: 13, high: 16, low: 12, close: 14 },
  { time: '2026-10-13', open: 14, high: 19, low: 11, close: 15 },
  { time: '2026-10-14', open: 15, high: 19, low: 11, close: 14 },
];
const zone = { sdt: '2026-10-12', edt: '2026-10-14', zd: 12, zg: 16,
  zd_time: '2026-10-12', zg_time: '2026-10-13', algorithm: 'sliding_window', bi_count: 3 };
const input = (up, close) => ({ candles, close, zsList: [zone], period: 'day',
  biPoints: [{ time: '2026-10-12', price: up ? 10 : 20 },
    { time: '2026-10-13', price: up ? 20 : 10 }] });
function assertNoScoreFields(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.hasOwn(value, 'score'), false);
  assert.equal(Object.hasOwn(value, 'score_max'), false);
  for (const child of Object.values(value)) assertNoScoreFields(child);
}

for (const [up, close, position, label] of [
  [true, 18, 'above', '上方'], [true, 14, 'inside', '内部'], [true, 11, 'below', '下方'],
  [false, 18, 'above', '上方'], [false, 14, 'inside', '内部'], [false, 11, 'below', '下方'],
]) {
  test(`outlook audit: ${up ? 'up' : 'down'}-${position} reports facts without a fabricated class, score or scan result`, () => {
    const result = buildReferenceOutlook(input(up, close));
    assert.equal(result.conclusion.kind_hint, null);
    assert.equal(result.levels.vs_zs, position);
    assert.equal(result.conclusion.position_branch, `${up ? 'up' : 'down'}-${position}`);
    assert.equal(result.conclusion.kind, null);
    assert.equal(result.conclusion.confirmed_signal, null);
    assert.equal(result.conclusion.latest_signal, null);
    assert.equal(result.conclusion.is_hypothesis, true);
    assert.equal(result.scenarios.length, 3, 'retain all existing scenario branches');
    for (const scenario of result.scenarios) {
      assert.ok(scenario.condition && scenario.path && scenario.invalid);
      assert.ok(scenario.next_points.length > 0);
      assert.ok(scenario.next_points.every((point) => point.hypothetical === true));
    }
    assertNoScoreFields(result);
    assert.match(result.conclusion.observation, /未执行一二三类买卖点识别/);
    assert.equal(result.conclusion.title, `向${up ? '上' : '下'}末笔 · 重叠区${label}`);
    assert.match(result.conclusion.trigger_condition, /后续需另行核验/);
    assert.match(result.conclusion.trigger_condition, /本功能未执行/);
    assert.doesNotMatch(result.conclusion.trigger_condition, /由.*K.*触发/);
    assert.match(result.conclusion.trigger_condition, /滑动笔重叠区边界或单根 K 线不能直接推出一二三类买卖点/);
    assert.match(result.conclusion.observation_basis, /最新完成笔方向与现价相对滑动笔重叠区的位置/);
    assert.doesNotMatch(result.conclusion.observation_basis, /未完成段/);
    assert.doesNotMatch(JSON.stringify(result), /近期无一二三类|吻合度赋分|评分满分/);
    assert.doesNotMatch(JSON.stringify(result), /[BS][123]|[一二三]类[买卖]点|中枢上[下沿方]|中枢下[沿方]|中枢震荡/,
      'no nested template may classify a point from the sliding overlap boundary');
    assert.deepEqual(result.scenarios.map((scenario) => scenario.name), ['重叠区上方', '重叠区内部', '重叠区下方']);
    assert.ok(result.scenarios.every((scenario) => scenario.next_points.every((point) =>
      point.kind === 'verification' && point.trigger.includes('本功能未执行'))));
  });
}

test('outlook audit: pending direction does not masquerade as an observation input', () => {
  const base = input(true, 14);
  const rising = buildReferenceOutlook({ ...base, pendingBi: { direction: 'up', price: 100 } });
  const falling = buildReferenceOutlook({ ...base, pendingBi: { direction: 'down', price: 1 } });
  assert.deepEqual(rising, falling);
  assert.equal(rising.conclusion.observation_basis, buildReferenceOutlook(base).conclusion.observation_basis);
});

test('outlook audit: absent overlap evidence does not become a buy/sell scan with zero results', () => {
  const result = buildReferenceOutlook({ ...input(false, 14), zsList: [] });
  assert.equal(result.conclusion.kind_hint, null);
  assert.equal(result.conclusion.latest_signal, null);
  assert.deepEqual(result.scenarios, []);
  assert.match(result.conclusion.observation, /未执行一二三类买卖点识别/);
  assert.match(result.conclusion.structure_fact, /尚无滑动笔重叠区/);
  assertNoScoreFields(result);
});

test('outlook audit: the real panel exposes computation scope and does not render legacy scoring claims', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'chan-outlook-audit-'));
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)),
    plugins: [react()], cacheDir, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { default: StockAnalysisPanel } = await server.ssrLoadModule('/src/components/StockAnalysisPanel.jsx');
    for (const zsList of [[zone], []]) {
      const data = { outlook: buildReferenceOutlook({ ...input(true, 14), zsList }),
        definition: { historyBars: candles.length }, historyDates: candles.map((candle) => candle.time), trades: [] };
      const markup = renderToStaticMarkup(React.createElement(StockAnalysisPanel, {
        data, enabled: true, tab: 'outlook', onTabChange() {}, code: 'AUDIT', period: '101',
      }));
      assert.match(markup, /未执行一二三类买卖点识别/);
      assert.match(markup, /计算口径与范围/);
      assert.match(markup, /第62、65、77课旧笔口径/);
      assert.match(markup, /不属于任一分型的独立K线/);
      assert.match(markup, /窗口截断可能影响起笔及后续结构/);
      assert.match(markup, /连续前三笔固定ZG\/ZD/);
      assert.match(markup, /最多延伸九笔/);
      assert.match(markup, /不是原文按次级别走势递归定义的中枢/);
      assert.match(markup, /未核验走势级别、递归中枢、背驰、线段及后续确认条件/);
      if (zsList.length) assert.match(markup, /后续核验项目（未执行）/);
      assert.doesNotMatch(markup, /评分|吻合度赋分|近期无一二三类|参考站划线口径/);
      assert.doesNotMatch(markup, /[BS][123]|[一二三]类[买卖]点|中枢震荡|中枢上沿|中枢下沿/);
      if (zsList.length) {
        assert.match(markup, /接下来三种位置情景/);
        assert.match(markup, /待核验/);
      }
    }
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
