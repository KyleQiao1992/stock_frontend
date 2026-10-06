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
try {
  const { default: ChanOverlay } = await server.ssrLoadModule('/src/components/ChanOverlay.jsx');
  const directory = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const name of names) {
    const fixture = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    const allRows = fixture.candles.map(({ time, vol, ...bar }) => ({ ...bar, date: String(time), volume: vol }));
    const data = analyzeChan(allRows, fixture.period);
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
} finally {
  await server.close();
}
