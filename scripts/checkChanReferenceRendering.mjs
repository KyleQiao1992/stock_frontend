import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeChan } from '../src/lib/chan/index.js';

// Load the real JSX overlay; don't duplicate its path/zone drawing implementation.
const server = await createServer({ configFile: false, plugins: [react()],
  cacheDir: '/tmp/chan-reference-svg-cache', optimizeDeps: { noDiscovery: true },
  resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let count = 0;
let outlookCount = 0;
try {
  const { default: ChanOverlay } = await server.ssrLoadModule('/src/components/ChanOverlay.jsx');
  const { default: StockAnalysisPanel } = await server.ssrLoadModule('/src/components/StockAnalysisPanel.jsx');
  const directory = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const name of names) {
    const fixture = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    const allRows = fixture.candles.map(({ time, vol, ...bar }) => ({ ...bar, date: String(time), volume: vol }));
    const data = analyzeChan(allRows, fixture.period);
    const panel = renderToStaticMarkup(React.createElement(StockAnalysisPanel, {
      data, enabled: true, tab: 'outlook', onTabChange: () => {}, code: fixture.symbol, period: fixture.period,
    }));
    const escaped = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
    const { conclusion, levels, scenarios } = fixture.outlook;
    const texts = [conclusion.title, `${conclusion.kind_hint} · 观察`, conclusion.status_label,
      conclusion.structure_fact, conclusion.observation, conclusion.observation_basis,
      conclusion.trigger_condition, conclusion.invalidation, conclusion.action_hint,
      levels.last_bi_high_bar, levels.last_bi_low_bar, levels.zs_zg_bar, levels.zs_zd_bar,
      levels.vs_zs_label, levels.zs_range, levels.active_zs_id, fixture.outlook.disclaimer,
      '已确认信号：近期无一二三类触发', '观察依据（非确认信号）',
      '1 · 结构事实', '2 · 已确认信号', '3 · 观察条件', '4 · 失效与操作参考'];
    for (const scenario of scenarios) {
      texts.push(scenario.name, `评分 ${scenario.score}/${scenario.score_max} · ${scenario.bias}`,
        scenario.explain, scenario.condition, scenario.path, scenario.invalid);
      for (const point of scenario.next_points) texts.push(`若触发 ${point.kind}`, point.title, point.trigger, point.action);
    }
    for (const text of texts) assert.ok(panel.includes(escaped(text)), `${name}: actual outlook panel missing ${text}`);
    assert.equal(panel.includes('缠论结构 · 结构观察'), false);
    assert.ok(panel.indexOf(escaped(conclusion.title)) < panel.indexOf('参考站划线口径'));
    outlookCount++;
    for (const visible of [80, 120, allRows.length]) {
      const rows = allRows.slice(-visible);
      const offset = allRows.length - rows.length;
      const chart = { margin: { left: 40, top: 20 }, plotW: 900, mainH: 400,
        x: (i) => 40 + i * 4, y: (price) => 1000 - price * 2 };
      const x = (time) => chart.x(fixture.candles.findIndex((c) => c.time === time) - offset);
      const options = { enabled: true, bi: true, zs: true, fx: true };
      const props = { data, options, rows, chart };
      const lineHtml = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ChanOverlay, { ...props, layer: 'lines' })));
      const zoneHtml = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ChanOverlay, { ...props, layer: 'zones' })));
      const line = attrs(lineHtml.match(/<path\b[^>]*data-chan-path="bi"[^>]*>/)?.[0] || '');
      const expectedPath = fixture.bi.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${chart.y(p.price)}`).join(' ');
      assert.equal(line.d, expectedPath, `${name}/${visible}: real SVG pen line`);
      assert.equal(line.stroke, '#ffd54f');
      assert.equal(line['stroke-width'], '1.5');
      assert.equal(line['stroke-dasharray'], undefined);
      assert.equal(lineHtml.includes('pending-bi'), false);
      assert.equal(lineHtml.includes('pending-segment'), false);
      const circles = [...lineHtml.matchAll(/<circle\b[^>]*>/g)].map((m) => attrs(m[0]));
      assert.deepEqual(circles.map((p) => [Number(p.cx), Number(p.cy), Number(p.r)]),
        fixture.fx.map((p) => [x(p.time), chart.y(p.price) + (p.mark === 'G' ? -10 : 10), 3.5]), `${name}/${visible}: fractal circles`);
      const markers = [...lineHtml.matchAll(/<polygon\b[^>]*>/g)].map((m) => attrs(m[0]));
      assert.deepEqual(markers.map((m) => m.points), fixture.trades.map((p) => {
        const px = x(p.time), py = chart.y(p.price);
        return p.side === 'sell' ? `${px},${py + 9} ${px + 9},${py - 9} ${px - 9},${py - 9}`
          : `${px},${py - 9} ${px + 9},${py + 9} ${px - 9},${py + 9}`;
      }), `${name}/${visible}: pen endpoint markers`);
      const zones = [...zoneHtml.matchAll(/<rect\b[^>]*data-chan-zone[^>]*>/g)].map((m) => attrs(m[0]));
      assert.deepEqual(zones.map((z) => [Number(z.x), Number(z.y), Number(z.width), Number(z.height)]),
        fixture.zs.map((z) => [x(z.sdt), chart.y(z.zg), x(z.edt) - x(z.sdt), chart.y(z.zd) - chart.y(z.zg)]), `${name}/${visible}: zone rectangles`);
      const active = fixture.zs.reduce((latest, z) => !latest || z.edt > latest.edt ? z : latest, null);
      assert.deepEqual(zones.map((z) => Number(z['stroke-width'])), fixture.zs.map((z) => z === active ? 2 : 1));
      count++;
    }
  }
  console.log(`Actual ChanOverlay SVG matches reference geometry: ${count}/${count} (13 cases × 3 viewports).`);
  console.log(`Actual StockAnalysisPanel renders reference classification, facts, conditions, levels and all scenarios: ${outlookCount}/${outlookCount}.`);
} finally {
  await server.close();
}
