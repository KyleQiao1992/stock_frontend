import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Independent counterexamples: compare rendered source price endpoints with
// result endpoints, rather than treating a drawn rectangle as the price truth.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CHAN_GUIDE_SCREENSHOTS || join(tmpdir(), 'chan-guide-geometry');
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Detail from '/src/components/ChanFractalDetail.jsx';
import { analyzeChan } from '/src/lib/chan/index.js';
import '/src/index.css';
const sample = ranges => ranges.map(([high,low],i)=>({high,low,
  open:low+(high-low)/3,close:high-(high-low)/3,volume:100,
  date:'2026-09-'+String(i+1).padStart(2,'0')}));
const cases = {
  normal:sample([[8,4],[10,6],[11,5],[9,4]]),
  tiny:sample([[99,1],[100,99.998],[100.001,99.997],[99.5,90]]),
  flat:sample([[8,4],[10,10],[10,10],[9,5]]),
  leftmerge:sample([[7,3],[8,4],[8.5,3.5],[10,6],[9,5]]),
  long:sample([[8,4],...Array.from({length:125},()=>[10,6]),[9,4]]),
};
const data = analyzeChan(cases[new URLSearchParams(location.search).get('case') || 'normal']);
const detail = Object.values(data.fractalDetails.fx)[0];
window.geometryDetail = detail;
const listeners = new Set();
const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
window.addEventListener = (type, handler, options) => {
  if(type==='scroll' && options===true) listeners.add(handler);
  return add(type,handler,options);
};
window.removeEventListener = (type, handler, options) => {
  if(type==='scroll' && options===true) listeners.delete(handler);
  return remove(type,handler,options);
};
const observers = new Set(), NativeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeObserver {
  constructor(callback) { super(callback); observers.add(this); }
  disconnect() { observers.delete(this); return super.disconnect(); }
};
window.geometryResources = () => ({ scrollListeners:listeners.size, resizeObservers:observers.size });
function App() {
  const [open,setOpen] = useState(true);
  return open ? React.createElement(Detail,{detail,onClose:()=>setOpen(false)}) : null;
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

const server = await createServer({ root, configFile: false, appType: 'custom',
  cacheDir: join(tmpdir(), 'chan-guide-geometry-vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [react(), tailwindcss(), { name: 'independent-chan-guide-geometry', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__chan-guide-geometry')) return next();
      try {
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, html));
      } catch (error) { next(error); }
    });
  } }], server: { host: '127.0.0.1', port: 0, hmr: false },
});

let browser;
const observations = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHAN_DETAIL_BROWSER || (existsSync(chromium.executablePath())
      ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const visit = async (name) => {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chan-guide-geometry?case=${name}`);
    await page.locator('dialog[open] [data-chan-detail-range]').first().waitFor();
    await settle();
  };
  const scrollOuter = async (toEnd) => {
    await page.evaluate((end) => {
      const outer = document.querySelector('[data-chan-detail-comparison]').parentElement;
      outer.scrollLeft = end ? outer.scrollWidth : 0;
    }, toEnd);
    await settle();
  };
  const read = () => page.evaluate(() => {
    const comparison = document.querySelector('[data-chan-detail-comparison]');
    const outer = comparison.parentElement.getBoundingClientRect();
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const guides = [...comparison.querySelectorAll('[data-chan-detail-guide]')].map((line) => {
      const [group, field] = line.dataset.chanDetailGuide.split(':');
      const source = comparison.querySelector('[data-chan-detail-candle="'+line.dataset.sourceIdx+'"] [data-chan-detail-wick]');
      const result = comparison.querySelector('[data-chan-detail-merged="'+group+'"] [data-chan-detail-range]');
      const sourceBox = bounds(source), resultBox = bounds(result), guideBox = bounds(line);
      const sourcePanel = source.closest('[role="region"]').getBoundingClientRect();
      const resultPanel = result.closest('[role="region"]').getBoundingClientRect();
      const sourcePriceY = field === 'high' ? sourceBox.top : sourceBox.bottom;
      const resultPriceY = field === 'high' ? resultBox.top : resultBox.bottom;
      return { key: line.dataset.chanDetailGuide, price: Number(line.dataset.price), sourceIdx: Number(line.dataset.sourceIdx),
        sourceY: sourcePriceY, resultY: resultPriceY, guideY: guideBox.top,
        sourceX: sourceBox.left, targetX: resultBox.left,
        sourceVisible: sourceBox.left >= Math.max(outer.left, sourcePanel.left+1, 0)
          && sourceBox.right <= Math.min(outer.right, sourcePanel.right-1, innerWidth),
        targetVisible: resultBox.left >= Math.max(outer.left, resultPanel.left+1, 0)
          && resultBox.left <= Math.min(outer.right, resultPanel.right-1, innerWidth) };
    });
    return { guides, rangeHeights: [...comparison.querySelectorAll('[data-chan-detail-range]')].map((element) => Number(element.getAttribute('height'))),
      flatLines: [...comparison.querySelectorAll('[data-chan-detail-flat-range]')].map((element) =>
        ({ y1: Number(element.getAttribute('y1')), y2: Number(element.getAttribute('y2')) })) };
  });
  const verify = async (name, keys) => {
    const actual = await read();
    assert.deepEqual(actual.guides.map((guide) => guide.key).sort(), keys.toSorted(), name + ': visible endpoint pairs');
    for (const guide of actual.guides) {
      assert.ok(guide.sourceVisible && guide.targetVisible, name + ': both endpoints survive viewport clipping');
      assert.ok(Math.abs(guide.guideY - guide.sourceY) < 0.0001,
        name + ': guide must align with the actual source price ' + JSON.stringify(guide));
      assert.ok(Math.abs(guide.guideY - guide.resultY) < 0.0001,
        name + ': result must keep the same price as its source ' + JSON.stringify(guide));
    }
    observations.push({ name, ...actual });
    return actual;
  };

  await visit('normal');
  await verify('normal-desktop', ['1:high', '1:low']);

  await visit('tiny');
  const tiny = await verify('tiny-retained-prices', ['1:high', '1:low']);
  assert.ok(tiny.rangeHeights[1] > 0 && tiny.rangeHeights[1] < 0.01, 'tiny range must retain its true subpixel height');
  await page.screenshot({ path: join(output, 'tiny.png') });

  await visit('flat');
  const flat = await verify('flat-zero-price-range', ['1:high', '1:low']);
  assert.equal(flat.rangeHeights[1], 0, 'H=L cannot create a nonzero price interval');
  assert.equal(flat.flatLines.length, 1, 'H=L should remain visible as a horizontal price line');
  assert.equal(flat.flatLines[0].y1, flat.flatLines[0].y2);
  assert.equal(flat.guides[0].guideY, flat.guides[1].guideY);

  await page.setViewportSize({ width: 390, height: 844 });
  await visit('normal');
  await verify('mobile-result-offscreen', []);
  await scrollOuter(true);
  await verify('mobile-both-panels-visible', ['1:high', '1:low']);
  await scrollOuter(false);
  await verify('mobile-outer-scroll-back', []);

  await page.setViewportSize({ width: 320, height: 844 });
  await visit('leftmerge');
  await scrollOuter(true);
  await verify('mobile-320-source-clipped', ['0:high']);
  await page.screenshot({ path: join(output, 'mobile-320-source-clipped.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollOuter(true);
  await verify('mobile-resize-source-restored', ['0:high', '0:low']);

  await page.setViewportSize({ width: 1280, height: 900 });
  await visit('long');
  assert.equal(await page.locator('[data-chan-detail-candle]').count(), 127, 'all original candles must remain present');
  await page.locator('[data-chan-detail-raw-scroll]').evaluate((element) => { element.scrollLeft = 0; });
  await settle();
  await verify('long-source-offscreen', []);
  await page.locator('[data-chan-detail-raw-scroll]').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await settle();
  await verify('long-source-restored', ['1:high', '1:low']);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await settle();
  await verify('dark-retained-prices', ['1:high', '1:low']);

  const active = await page.evaluate(() => window.geometryResources());
  assert.equal(active.scrollListeners, 1, 'guide scroll capture should be registered once');
  assert.ok(active.resizeObservers >= 4);
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  await settle();
  assert.deepEqual(await page.evaluate(() => window.geometryResources()), { scrollListeners: 0, resizeObservers: 0 },
    'closing must clean up scroll and ResizeObservers');
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify(observations, null, 2));
  console.log(`Passed ${observations.length} independent Chan guide geometry cases; evidence: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
