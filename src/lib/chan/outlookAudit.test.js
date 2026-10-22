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
const watchKinds = ['B1', 'B2', 'B3', 'S1', 'S2', 'S3'];
const pointsByKind = (result) => Object.fromEntries(result.scenarios
  .flatMap((scenario) => scenario.next_points).map((point) => [point.kind, point]));
const cases = [
  [true, 18, 'above', '上方'], [true, 14, 'inside', '内部'], [true, 11, 'below', '下方'],
  [false, 18, 'above', '上方'], [false, 14, 'inside', '内部'], [false, 11, 'below', '下方'],
];

for (const [up, close, position, label] of cases) {
  test(`outlook audit: ${up ? 'up' : 'down'}-${position} retains six conditional watches without claiming a detected class`, () => {
    const result = buildReferenceOutlook(input(up, close));
    assert.equal(result.conclusion.kind_hint, null);
    assert.equal(result.levels.vs_zs, position);
    assert.equal(result.conclusion.position_branch, `${up ? 'up' : 'down'}-${position}`);
    assert.equal(result.conclusion.kind, null);
    assert.equal(result.conclusion.confirmed_signal, null);
    assert.equal(result.conclusion.latest_signal, null);
    assert.equal(result.conclusion.is_hypothesis, true);
    assert.notEqual(result.conclusion.status, 'confirmed');
    assert.equal(result.scenarios.length, 3, 'retain all existing scenario branches');
    const points = result.scenarios.flatMap((scenario) => scenario.next_points);
    assert.deepEqual(points.map((point) => point.kind).sort(), watchKinds,
      'all six classes remain available, regardless of the current price position');
    assert.equal(new Set(points.map((point) => point.trigger)).size, 6,
      'each class needs its own structural sequence, not a repeated verification placeholder');
    for (const scenario of result.scenarios) {
      assert.ok(scenario.condition && scenario.path && scenario.invalid);
      for (const point of scenario.next_points) {
        assert.equal(point.hypothetical, true);
        assert.match(point.title, /观察$/);
        assert.match(point.trigger, /^若/);
        assert.ok(point.action);
        assert.doesNotMatch(JSON.stringify(point), /待核验|买卖点需另行核验|本功能未执行|已确认|已触发/);
      }
    }
    assertNoScoreFields(result);
    assert.equal(result.conclusion.title, `向${up ? '上' : '下'}末笔 · 重叠区${label}`);
    assert.doesNotMatch(result.conclusion.title, /[BS][123]|[一二三]类[买卖]点/);
    assert.match(result.conclusion.observation_basis, /最新完成笔方向与现价相对滑动笔重叠区的位置/);
    assert.match(result.conclusion.observation_basis, /未执行一二三类买卖点识别/);
    assert.doesNotMatch(result.conclusion.observation_basis, /未完成段/);
    assert.match(result.watch_note, /后续条件观察，未判定已触发/);
    assert.match(result.watch_note, /不能代替.*级别、背驰及中枢结构/);
    assert.doesNotMatch(JSON.stringify(result), /近期无一二三类|吻合度赋分|评分满分/);
    assert.deepEqual(result.scenarios.map((scenario) => scenario.name), ['重叠区上方', '重叠区内部', '重叠区下方']);
  });
}

test('outlook audit: class definitions do not change when only price position or last-pen direction changes', () => {
  const baseline = pointsByKind(buildReferenceOutlook(input(true, 14)));
  for (const [up, close] of cases) {
    const points = pointsByKind(buildReferenceOutlook(input(up, close)));
    for (const kind of watchKinds) {
      assert.equal(points[kind].trigger, baseline[kind].trigger,
        `${kind} must keep its structural prerequisites instead of being inferred from position`);
    }
  }
});

test('outlook audit: watches preserve the distinct original first, second and third-class prerequisites', () => {
  const points = pointsByKind(buildReferenceOutlook(input(true, 14)));
  assert.match(points.B1.trigger, /同级别下跌趋势.*底背驰.*次级别转折/);
  assert.match(points.S1.trigger, /同级别上涨趋势.*顶背驰.*次级别转折/);
  assert.match(points.B2.trigger, /已形成一买.*次级别回升结束.*再次探底或回试.*次级别走势结束/);
  assert.match(points.S2.trigger, /已形成一卖.*次级别回落结束.*再次上探或回抽.*次级别走势结束/);
  assert.match(points.B2.action, /真实一买.*弱二买可以低于一买/);
  assert.match(points.S2.action, /真实一卖.*弱二卖可以高于一卖/);
  assert.doesNotMatch(points.B2.trigger, /不破前低|不低于前低|不低于一买/,
    'lesson 101 allows a weak second buy below the first buy');
  assert.doesNotMatch(points.S2.trigger, /不破前高|不高于前高|不高于一卖/);
  assert.match(points.B3.trigger, /次级别走势向上离开同级别中枢.*首次次级别回试完成.*低点不跌破该中枢ZG/);
  assert.match(points.S3.trigger, /次级别走势向下离开同级别中枢.*首次次级别回抽完成.*高点不升破该中枢ZD/);
  for (const point of [points.B3, points.S3]) {
    assert.doesNotMatch(point.trigger, /滑动|重叠区|单根|收盘/,
      'a sliding pen overlap or a closing-price crossing cannot replace the real same-level center and sublevel sequence');
  }
});

test('outlook audit: observations retain the supplied pen and overlap price/date anchors', () => {
  for (const up of [true, false]) {
    const result = buildReferenceOutlook(input(up, 14));
    const points = pointsByKind(result);
    assert.equal(result.levels.last_bi_high, 20);
    assert.equal(result.levels.last_bi_low, 10);
    assert.equal(result.levels.last_bi_high_bar, `${up ? '2026-10-13' : '2026-10-12'} @ 20.00`);
    assert.equal(result.levels.last_bi_low_bar, `${up ? '2026-10-12' : '2026-10-13'} @ 10.00`);
    assert.ok(points.B1.action.includes(result.levels.last_bi_low_bar));
    assert.ok(points.S1.action.includes(result.levels.last_bi_high_bar));
    assert.equal(result.levels.zs_zg_bar, '2026-10-13 @ 16.00');
    assert.equal(result.levels.zs_zd_bar, '2026-10-12 @ 12.00');
    assert.ok(result.scenarios[0].condition.includes(result.levels.zs_zg_bar));
    assert.ok(result.scenarios[2].condition.includes(result.levels.zs_zd_bar));
    assert.match(result.scenarios[1].condition, /12\.00.*16\.00/);
  }
  const changed = input(true, 14);
  changed.biPoints = [{ time: '2026-10-10', price: 8.25 }, { time: '2026-10-11', price: 23.75 }];
  changed.zsList = [{ ...zone, zg: 17.5, zd: 11.25, zg_time: '2026-10-10', zd_time: '2026-10-11' }];
  const result = buildReferenceOutlook(changed);
  const points = pointsByKind(result);
  assert.match(points.B1.action, /2026-10-10 @ 8\.25/);
  assert.match(points.S1.action, /2026-10-11 @ 23\.75/);
  assert.match(result.scenarios[0].condition, /2026-10-10 @ 17\.50/);
  assert.match(result.scenarios[2].condition, /2026-10-11 @ 11\.25/);
});

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
  assert.equal(result.conclusion.kind, null);
  assert.equal(result.conclusion.confirmed_signal, null);
  assert.equal(result.conclusion.latest_signal, null);
  assert.deepEqual(result.scenarios, []);
  assert.match(result.conclusion.observation, /尚无滑动笔重叠区/);
  assert.match(result.conclusion.structure_fact, /尚无滑动笔重叠区/);
  assert.doesNotMatch(JSON.stringify(result), /近期无一二三类|无.*信号触发/);
  assertNoScoreFields(result);
});

test('outlook audit: the real panel exposes computation scope and does not render legacy scoring claims', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'chan-outlook-audit-'));
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)),
    plugins: [react()], cacheDir, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { default: StockAnalysisPanel } = await server.ssrLoadModule('/src/components/StockAnalysisPanel.jsx');
    for (const request of [...cases.map(([up, close]) => input(up, close)), { ...input(true, 14), zsList: [] }]) {
      const data = { outlook: buildReferenceOutlook(request),
        definition: { historyBars: candles.length }, dates: candles.map((candle) => candle.time),
        historyDates: candles.map((candle) => candle.time), trades: [] };
      const markup = renderToStaticMarkup(React.createElement(StockAnalysisPanel, {
        data, enabled: true, tab: 'outlook', onTabChange() {}, code: 'AUDIT', period: '101',
      }));
      assert.match(markup, /计算口径与范围/);
      assert.match(markup, /第62、65、77课旧笔口径/);
      assert.match(markup, /不属于任一分型的独立K线/);
      assert.match(markup, /全部已加载.*根K线参与计算/);
      assert.match(markup, /不按固定根数或笔数截断/);
      assert.match(markup, /加载更早历史可能改变起笔及后续结构/);
      assert.doesNotMatch(markup, /最近50笔展示上限/);
      assert.match(markup, /连续前三笔固定ZG\/ZD/);
      assert.match(markup, /最多延伸九笔/);
      assert.match(markup, /不是原文按次级别走势递归定义的中枢/);
      assert.match(markup, /当前未执行走势级别、递归中枢、背驰及一二三类买卖点的自动识别/);
      assert.doesNotMatch(markup, /评分|吻合度赋分|近期无一二三类|参考站划线口径|待核验|买卖点需另行核验|后续核验项目/);
      assert.doesNotMatch(markup, /aria-label="已确认信号"/);
      if (request.zsList.length) {
        assert.match(markup, /买卖点观察 · 接下来三种情景/);
        assert.equal((markup.match(/data-chan-watch-intro/g) || []).length, 1);
        assert.equal(markup.split(data.outlook.watch_note).length - 1, 1,
          'the shared conditional-observation explanation appears once');
        assert.equal((markup.match(/data-chan-scenario=/g) || []).length, 3);
        assert.equal((markup.match(/data-chan-signal-watch=/g) || []).length, 6);
        const points = pointsByKind(data.outlook);
        for (const kind of watchKinds) {
          assert.equal(markup.split(`data-chan-signal-watch="${kind}"`).length - 1, 1);
          assert.ok(markup.includes(points[kind].title));
          assert.ok(markup.includes(points[kind].trigger));
        }
        for (const key of ['last_bi_high_bar', 'last_bi_low_bar', 'zs_zg_bar', 'zs_zd_bar']) {
          assert.ok(markup.includes(data.outlook.levels[key]), `${key} remains visible with its actual supplied date and price`);
        }
      } else {
        assert.doesNotMatch(markup, /data-chan-watch-intro|data-chan-signal-watch|data-chan-scenario/);
      }
    }
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
