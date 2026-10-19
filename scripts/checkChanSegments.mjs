import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { analyzeChan } from '../src/lib/chan/index.js';
import { buildSegments } from '../src/lib/chan/segment.js';

// The production pipeline supplies every saved history below. The independent
// endpoint example additionally makes the SVG checks non-vacuous if a market
// history does not yet contain a segment that meets the confirmation rules.
const fixtureDirectory = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
const fixtureNames = (await readdir(fixtureDirectory)).filter((name) => name.endsWith('.json')).sort();
const fixtureDate = (time, period) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  ...(period.endsWith('m') ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) }).format(new Date(time * 1000));
const cases = await Promise.all(fixtureNames.map(async (name) => {
  const fixture = JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
  const rows = fixture.candles.map(({ time, vol, ...bar }) => ({ ...bar, date: fixtureDate(time, fixture.period), volume: vol }));
  return { name, rows, data: analyzeChan(rows, fixture.period) };
}));
assert.equal(cases.length, 13, 'all saved production histories must be exercised');

const syntheticPoints = [10, 20, 14, 22, 15, 19, 13, 18, 12, 17, 14, 20, 16, 22].map((price, index) => ({
  time: 2 + 10 * index, idx: 1 + 10 * index, price,
  mark: index % 2 === 0 ? 'D' : 'G', confirmed: true,
}));
const syntheticRows = Array.from({ length: 140 }, (_, index) => {
  const time = index + 1;
  const rightIndex = syntheticPoints.findIndex((point) => point.time >= time);
  const right = syntheticPoints[rightIndex < 0 ? syntheticPoints.length - 1 : rightIndex];
  const left = syntheticPoints[Math.max(0, rightIndex < 0 ? syntheticPoints.length - 1 : rightIndex - 1)];
  const price = right.time === left.time ? left.price
    : left.price + (right.price - left.price) * (time - left.time) / (right.time - left.time);
  return { open: price - 0.1, close: price + 0.1, high: price + 0.25, low: price - 0.25,
    volume: 10000 + index * 100, date: new Date(Date.UTC(2026, 0, time)).toISOString().slice(0, 10) };
});
const syntheticResult = buildSegments(syntheticPoints);
assert.ok(syntheticResult.segments.length > 0, 'independent example must contain a confirmed segment');
assert.equal(syntheticResult.pending.length, 2, 'independent example must contain a developing segment');
const synthetic = { name: 'independent-endpoints', rows: syntheticRows,
  data: { ...analyzeChan(syntheticRows), bi: syntheticPoints, biLine: syntheticPoints, fx: [], zs: [],
    segments: syntheticResult.segments, pendingSegments: syntheticResult.pending } };

const attrs = (tag = '') => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
const segmentPaths = (markup, kind) => [...markup.matchAll(/<path\b[^>]*>/g)]
  .map((match) => attrs(match[0])).filter((item) => item['data-chan-path'] === kind);
const defaultOptions = { enabled: true, bi: true, segment: true, fx: true, zs: true };
const productionExample = cases.find((item) => item.name === 'sh603818-day.json');
assert.ok(productionExample, 'browser acceptance must include the stock discussed by the user');

const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0}#chart-workspace{background:var(--chart-surface);padding:12px;box-sizing:border-box;max-width:1100px;margin:20px auto}
#chart-workspace:fullscreen{max-width:none;width:100%;height:100%;margin:0;overflow:auto}.test-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
#analysis-workspace{max-width:1100px;margin:12px auto;padding:0 12px;box-sizing:border-box}
.test-toolbar button{padding:6px 10px;border:1px solid #64748b;border-radius:8px}.test-caption{font:12px sans-serif;color:var(--chart-ink-3);margin:8px 0}</style></head>
<body><div id="root"></div><script type="module">
import React,{useState,useRef,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Chart} from '/src/components/AShareTD9InteractiveChart.jsx';
import ChanControls from '/src/components/ChanControls.jsx';
import StockAnalysisPanel from '/src/components/StockAnalysisPanel.jsx';
import {analyzeChan} from '/src/lib/chan/index.js';
import '/src/index.css';
const saved=${JSON.stringify(productionExample)};
const synthetic=${JSON.stringify(synthetic)};
const input=new URLSearchParams(location.search).get('case')==='synthetic'?synthetic:saved;
// Re-run the real production analysis in the browser for the saved history.
const data=input===synthetic?input.data:analyzeChan(input.rows,${JSON.stringify(productionExample.name.replace(/\.json$/, '').split('-').at(-1))});
window.chanSegmentData=data;
function App(){
 const [options,setOptions]=useState(${JSON.stringify(defaultOptions)});
 const [count,setCount]=useState(input.rows.length);
 const [expanded,setExpanded]=useState(false);
 const host=useRef(null);
 useEffect(()=>{const change=()=>setExpanded(Boolean(document.fullscreenElement));document.addEventListener('fullscreenchange',change);return()=>document.removeEventListener('fullscreenchange',change)},[]);
 const toggle=async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await host.current.requestFullscreen()};
 return React.createElement(React.Fragment,null,React.createElement('main',{id:'chart-workspace',ref:host,'data-expanded':String(expanded)},
  React.createElement('div',{className:'test-toolbar'},React.createElement(ChanControls,{options,onChange:setOptions}),
   React.createElement('button',{onClick:toggle,'aria-label':'测试图表全屏'},expanded?'退出全屏':'全屏'),
   React.createElement('button',{onClick:()=>setCount(Math.min(80,input.rows.length))},'近80根'),
   React.createElement('button',{onClick:()=>setCount(input.rows.length)},'全部历史')),
  React.createElement('p',{className:'test-caption'},input.name+' · '+data.segments.length+' 已确认线段 · '+(data.pendingSegments.length===2?'有发展中线段':'无线段候选')),
  React.createElement(Chart,{rows:input.rows.slice(-count),fullRows:input.rows,displayCount:count,onDisplayCountChange:setCount,
   expanded,chanData:data,chanOptions:options})),
  React.createElement('section',{id:'analysis-workspace'},React.createElement(StockAnalysisPanel,{data,enabled:options.enabled,
   tab:'outlook',onTabChange:()=>{},code:input===synthetic?'SYNTHETIC':'603818',name:input===synthetic?'独立端点样例':'曲美家居',period:'day'})));
}
document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

const server = await createServer({ configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss(), { name: 'chan-segment-verification', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__chan-segment-test')) return next();
      try { response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml(request.url, html));
      } catch (error) { next(error); }
    });
  } }],
  resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
  cacheDir: '/tmp/chan-segment-verification-cache',
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
let svgChecks = 0;
let offscreenChecks = 0;
let offscreenStartChecks = 0;
let offscreenEndChecks = 0;
let segmentChecks = 0;
let pendingChecks = 0;
const output = process.env.CHAN_SEGMENT_SCREENSHOTS || '/tmp/chan-segments';
try {
  const { default: ChanOverlay } = await server.ssrLoadModule('/src/components/ChanOverlay.jsx');
  const render = (data, rows, chart, options = defaultOptions) => renderToStaticMarkup(React.createElement('svg', null,
    React.createElement(ChanOverlay, { layer: 'lines', data, rows, chart, options })));
  for (const { name, rows: allRows, data } of [...cases, synthetic]) {
    const windows = [allRows.slice(-80), allRows.slice(-120), allRows];
    // This central crop has a confirmed segment extending beyond both edges.
    if (name === synthetic.name) windows.push(allRows.slice(12, 22));
    for (const rows of windows) {
      const offset = allRows.findIndex((row) => row.date === rows[0].date);
      for (const scale of [1, 2]) {
        const lows = allRows.map((row) => row.low), highs = allRows.map((row) => row.high);
        const low = Math.min(...lows), high = Math.max(...highs);
        const chart = { margin: { left: 40, top: 20 }, plotW: 600 * scale, mainH: 300 * scale,
          x: (index) => 40 + (index + 0.5) * 600 * scale / rows.length,
          y: (price) => 20 + 300 * scale * (high - price) / (high - low) };
        const x = (time) => chart.x(time - 1 - offset);
        const path = (points) => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time)},${chart.y(point.price)}`).join(' ');
        const label = `${name}/${rows.length}/${scale}x`;
        const markup = render(data, rows, chart);
        const segments = segmentPaths(markup, 'segment');
        assert.equal(segments.length, data.segments.length, `${label}: confirmed segment count`);
        for (let index = 0; index < segments.length; index++) {
          const segment = data.segments[index];
          assert.equal(segments[index].d, path([segment.start, segment.end]), `${label}: real confirmed SVG endpoints`);
          assert.equal(segments[index]['stroke-dasharray'], undefined, `${label}: confirmed segments are solid`);
          assert.ok(Number(segments[index]['stroke-width']) > 1.5, `${label}: segments remain distinct from pens`);
          assert.equal(segments[index]['data-chan-segment'], segment.id);
          assert.ok(segments[index]['aria-label'].includes(`${segment.stroke_count} 笔`), `${label}: accessible segment stroke count`);
          assert.ok(segments[index]['aria-label'].includes(`确认依据K：${data.dates[segment.confirmed_time - 1]}`),
            `${label}: confirmation tooltip uses the actual known-at time`);
          segmentChecks++;
          if (segment.start.time - 1 < offset) offscreenStartChecks++;
          if (segment.end.time - 1 >= offset + rows.length) offscreenEndChecks++;
          if (segment.start.time - 1 < offset || segment.end.time - 1 >= offset + rows.length) offscreenChecks++;
        }
        const pending = segmentPaths(markup, 'pending-segment');
        assert.equal(pending.length, data.pendingSegments.length >= 2 ? 1 : 0, `${label}: developing segment count`);
        if (pending.length) {
          assert.equal(pending[0].d, path(data.pendingSegments), `${label}: developing SVG endpoints`);
          assert.match(pending[0]['stroke-dasharray'], /\d+[ ,]+\d+/, `${label}: developing segments are dashed`);
          assert.match(pending[0]['aria-label'], /尚未确认/, `${label}: developing tooltip cannot claim confirmation`);
          pendingChecks++;
        }
        const clip = attrs(markup.match(/<clipPath\b[^>]*>/)?.[0]);
        assert.ok(clip.id && markup.includes(`clip-path="url(#${clip.id})"`), `${label}: overlay uses its real SVG clip`);
        const clipRect = attrs(markup.match(/<clipPath\b[^>]*><rect\b[^>]*>/)?.[0]);
        assert.deepEqual(['x', 'y', 'width', 'height'].map((key) => Number(clipRect[key])),
          [40, 20, chart.plotW, chart.mainH], `${label}: clip matches the price panel`);
        const noSegments = render(data, rows, chart, { ...defaultOptions, segment: false });
        assert.equal(segmentPaths(noSegments, 'segment').length + segmentPaths(noSegments, 'pending-segment').length, 0,
          `${label}: segment checkbox disables both segment states`);
        assert.equal(segmentPaths(noSegments, 'bi').length, 1, `${label}: segment checkbox preserves pens`);
        const noPens = render(data, rows, chart, { ...defaultOptions, bi: false });
        assert.equal(segmentPaths(noPens, 'bi').length, 0, `${label}: pen checkbox disables pens`);
        assert.deepEqual(segmentPaths(noPens, 'segment').map((item) => item.d), segments.map((item) => item.d),
          `${label}: pen checkbox preserves confirmed segments`);
        assert.deepEqual(segmentPaths(noPens, 'pending-segment').map((item) => item.d), pending.map((item) => item.d),
          `${label}: pen checkbox preserves developing segments`);
        assert.equal(render(data, rows, chart, { ...defaultOptions, enabled: false }).includes('data-chan-path'), false,
          `${label}: main switch disables the overlay`);
        svgChecks++;
      }
    }
  }
  assert.ok(segmentChecks > 0 && pendingChecks > 0 && offscreenStartChecks > 0 && offscreenEndChecks > 0,
    'must exercise solid, dashed and offscreen start/end geometry with actual nonempty data');
  console.log(`Actual ChanOverlay segment SVG checks passed: ${svgChecks} views (13 production histories × 3 windows × 2 scales, plus independent endpoint/crop views); ${segmentChecks} solid segments, ${pendingChecks} developing paths, ${offscreenChecks} offscreen-endpoint checks.`);

  if (process.argv.includes('--svg-only')) process.exitCode = 0;
  else {
    await mkdir(output, { recursive: true });
    await server.listen();
    const address = server.httpServer.address();
    const executablePath = process.env.CHAN_SEGMENT_BROWSER || (existsSync(chromium.executablePath())
      ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const visit = async (kind) => {
      await page.goto(`http://127.0.0.1:${address.port}/__chan-segment-test?case=${kind}`);
      await page.getByRole('checkbox', { name: '线段', exact: true }).waitFor();
      await page.locator('[data-chan-path="bi"]').waitFor();
    };
    const expectCounts = async (segments, developing, pens = true) => {
      assert.equal(await page.locator('[data-chan-path="segment"]').count(), segments);
      assert.equal(await page.locator('[data-chan-path="pending-segment"]').count(), developing);
      assert.equal(await page.locator('[data-chan-path="bi"]').count(), pens ? 1 : 0);
    };
    const checkGeometry = async () => {
      const paths = await page.locator('[data-chan-path="segment"], [data-chan-path="pending-segment"]').evaluateAll((elements) => elements.map((element) => {
        const owner = element.closest('[clip-path]');
        const id = owner?.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1];
        const rect = id ? document.getElementById(id)?.querySelector('rect') : null;
        return { d: element.getAttribute('d'), dash: element.getAttribute('stroke-dasharray'),
          stroke: getComputedStyle(element).stroke, clip: rect ? ['x', 'y', 'width', 'height'].map((key) => Number(rect.getAttribute(key))) : null };
      }));
      assert.ok(paths.length, 'browser must draw at least one actual segment');
      for (const path of paths) {
        assert.ok(path.clip?.every(Number.isFinite) && path.clip[2] > 0 && path.clip[3] > 0,
          'segment clip must survive normal, zoomed and expanded Chart layouts');
        assert.doesNotMatch(path.d, /NaN|undefined|Infinity/);
        assert.ok(path.stroke && path.stroke !== 'none', 'segment theme color must resolve');
      }
      return paths;
    };
    const checkSegmentList = async (screenshot) => {
      const section = page.getByRole('region', { name: '线段结构', exact: true });
      await section.waitFor();
      const details = section.locator('details');
      const summary = details.locator('summary');
      const expected = await page.evaluate(() => window.chanSegmentData.segments.map((segment) => ({
        count: segment.stroke_count, direction: segment.direction === 'up' ? '向上' : '向下',
        start: window.chanSegmentData.dates[segment.start.time - 1],
        end: window.chanSegmentData.dates[segment.end.time - 1],
        confirmed: window.chanSegmentData.dates[segment.confirmed_time - 1],
      })));
      assert.ok(expected.length > 0, 'real production segment-list check must contain confirmed data');
      assert.equal(await details.getAttribute('open'), null, 'segment list starts collapsed');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.notEqual(await details.getAttribute('open'), null, 'native summary is accessible with the keyboard');
      const items = section.locator('ol > li');
      assert.equal(await items.count(), expected.length);
      for (let index = 0; index < expected.length; index++) {
        const text = await items.nth(index).textContent();
        const segment = expected[index];
        for (const value of [segment.direction, `${segment.count} 笔`, `起点：${segment.start}`,
          `终点：${segment.end}`, `确认依据K：${segment.confirmed}`]) assert.ok(text.includes(value), `segment list missing ${value}`);
      }
      await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        'expanded production segment list must not overflow the document');
      const bounds = await section.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1,
        'expanded segment-list region must remain within the viewport horizontally');
      await section.screenshot({ path: `${output}/${screenshot}.png` });
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await details.getAttribute('open'), null, 'segment list can be collapsed with the keyboard');
      await page.evaluate(() => scrollTo(0, 0));
    };
    const checkMobileLegend = async () => {
      const legend = page.locator('[aria-label="缠论图例"]');
      await legend.scrollIntoViewIfNeeded();
      const read = () => legend.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          textBounds: [...element.children].map((child) => {
            const bounds = child.getBoundingClientRect();
            return [bounds.left, bounds.right];
          }) };
      });
      const first = await read();
      assert.ok(first.left >= 0 && first.right <= first.viewportWidth + 1,
        'whole mobile legend must stay inside the horizontal viewport');
      assert.ok(first.top >= -1 && first.bottom <= first.viewportHeight + 1,
        'mobile legend must be fully viewable after scrolling into view');
      assert.ok(first.textBounds.every(([left, right]) => left >= 0 && right <= first.viewportWidth + 1),
        'mobile legend text must wrap within the viewport');
      const scroller = page.locator('#chart-workspace .overflow-x-auto').first();
      assert.ok(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth),
        'mobile test must exercise a genuinely horizontally scrolling Chart');
      for (const edge of ['left', 'right']) {
        await scroller.evaluate((element, edge) => { element.scrollLeft = edge === 'left' ? 0 : element.scrollWidth; }, edge);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const current = await read();
        assert.ok(Math.abs(current.left - first.left) < 1 && Math.abs(current.right - first.right) < 1,
          `mobile legend must not move when the Chart scrolls ${edge}`);
      }
      await page.evaluate(() => scrollTo(0, 0));
    };
    await visit('production');
    const productionCounts = await page.evaluate(() => [window.chanSegmentData.segments.length,
      window.chanSegmentData.pendingSegments.length >= 2 ? 1 : 0]);
    await expectCounts(...productionCounts);
    if (productionCounts.some(Boolean)) await checkGeometry();
    await page.screenshot({ path: `${output}/production-desktop.png` });
    await checkSegmentList('production-segment-list');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    const lightGeometry = await checkGeometry();
    assert.ok(lightGeometry.every((path) => path.stroke !== 'none'), 'segment color resolves in the light theme');
    await page.screenshot({ path: `${output}/production-light.png` });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const darkGeometry = await checkGeometry();
    assert.notDeepEqual(lightGeometry.map((path) => path.stroke), darkGeometry.map((path) => path.stroke),
      'light and dark themes must resolve the intended distinct segment colors');
    await page.getByRole('button', { name: '测试图表全屏', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'chart-workspace'
      && document.querySelector('#chart-workspace')?.getAttribute('data-expanded') === 'true');
    await page.waitForFunction(() => Number(document.querySelector('[data-chan-layer="lines"] clipPath rect')?.getAttribute('width')) > 1100);
    if (productionCounts.some(Boolean)) await checkGeometry();
    await page.screenshot({ path: `${output}/production-fullscreen.png` });
    await page.getByRole('button', { name: '测试图表全屏', exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);

    await visit('synthetic');
    const segmentCount = synthetic.data.segments.length;
    await expectCounts(segmentCount, 1);
    const originalGeometry = await checkGeometry();
    assert.ok(originalGeometry.some((path) => path.dash), 'browser must draw a developing dashed path');
    assert.ok(originalGeometry.some((path) => !path.dash), 'browser must draw a confirmed solid path');
    await page.screenshot({ path: `${output}/segments-and-pens.png` });
    await page.getByRole('checkbox', { name: '笔', exact: true }).uncheck();
    await expectCounts(segmentCount, 1, false);
    await page.screenshot({ path: `${output}/segments-only.png` });
    await page.getByRole('checkbox', { name: '线段', exact: true }).uncheck();
    await expectCounts(0, 0, false);
    await page.getByRole('checkbox', { name: '笔', exact: true }).check();
    await expectCounts(0, 0);
    await page.screenshot({ path: `${output}/pens-only.png` });
    await page.getByRole('checkbox', { name: '线段', exact: true }).check();
    await page.getByRole('button', { name: '近80根', exact: true }).click();
    const zoomedGeometry = await checkGeometry();
    assert.notDeepEqual(zoomedGeometry.map((path) => path.d), originalGeometry.map((path) => path.d),
      'segment coordinates must update when the visible candle window changes');
    await page.screenshot({ path: `${output}/zoomed-offscreen-start.png` });
    await page.getByRole('button', { name: '全部历史', exact: true }).click();
    await page.getByRole('button', { name: '测试图表全屏', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'chart-workspace'
      && document.querySelector('#chart-workspace')?.getAttribute('data-expanded') === 'true');
    await page.waitForFunction(() => Number(document.querySelector('[data-chan-layer="lines"] clipPath rect')?.getAttribute('width')) > 1100);
    await checkGeometry();
    await expectCounts(segmentCount, 1);
    await page.screenshot({ path: `${output}/fullscreen.png` });
    await page.getByRole('button', { name: '测试图表全屏', exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);

    await page.setViewportSize({ width: 390, height: 844 });
    await visit('synthetic');
    await expectCounts(segmentCount, 1);
    await checkGeometry();
    await checkMobileLegend();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      'mobile overflow must stay inside the actual Chart scroll container');
    await page.screenshot({ path: `${output}/mobile.png` });
    await page.getByRole('checkbox', { name: '笔', exact: true }).uncheck();
    await expectCounts(segmentCount, 1, false);
    await page.getByRole('checkbox', { name: '线段', exact: true }).uncheck();
    await expectCounts(0, 0, false);
    await page.getByRole('checkbox', { name: '线段', exact: true }).check();
    await expectCounts(segmentCount, 1, false);
    await page.screenshot({ path: `${output}/mobile-segments-only.png` });
    await page.getByRole('button', { name: '缠论', exact: true }).click();
    assert.equal(await page.locator('[data-chan-path]').count(), 0);
    await page.getByRole('button', { name: '缠论', exact: true }).click();
    await expectCounts(segmentCount, 1, false);
    await visit('production');
    await expectCounts(...productionCounts);
    if (productionCounts.some(Boolean)) await checkGeometry();
    await checkMobileLegend();
    await page.screenshot({ path: `${output}/production-mobile.png` });
    await checkSegmentList('production-mobile-segment-list');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await checkGeometry();
    await checkMobileLegend();
    await page.screenshot({ path: `${output}/production-mobile-light.png` });
    assert.deepEqual(errors, [], 'real Chart, controls and legend must render without browser errors');
    console.log(`Browser segment checks passed: production pipeline, independent nonempty segments, independent pen/segment switches, main switch, zoom, offscreen clipping, native fullscreen with expanded Chart, light/dark themes, mobile legend bounds independent of Chart scrolling, and keyboard-accessible production segment lists with actual confirmation dates on desktop/mobile. Screenshots: ${output}`);
  }
} finally {
  await browser?.close();
  await server.close();
}
