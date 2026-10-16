import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Exercise the actual Chart and modal without requiring a live market API/login.
const fixture = JSON.parse(await readFile(new URL('../src/lib/chan/fixtures/reference/sh603818-day.json', import.meta.url), 'utf8'));
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chart } from '/src/components/AShareTD9InteractiveChart.jsx';
import { analyzeChan } from '/src/lib/chan/index.js';
import '/src/index.css';
const fixture = ${JSON.stringify(fixture)};
const sample = (ranges) => ranges.map(([high, low], i) => ({ high, low, open: low + (high-low)/3,
close: high - (high-low)/3, volume: 100, date: '2026-09-' + String(i + 1).padStart(2,'0') }));
const ohlc = (values) => values.map(([open, high, low, close], i) => ({ open, high, low, close,
volume: 100, date: '2026-09-' + String(i + 1).padStart(2,'0') }));
const mirror = (bars) => bars.map((bar) => ({ ...bar, open: 30 - bar.open,
high: 30 - bar.low, low: 30 - bar.high, close: 30 - bar.close }));
const displayDate = (time) => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time*1000));
const cases = {
top: sample([[8,4],[10,6],[11,5],[9,4]]),
directTop: sample([[8,4],[10,6],[9,5]]),
continuationTop: ohlc([[10.5,20,10,19.5],[20,22,12,21],[18,21,11,19]]),
strongTop: ohlc([[11,15,10,14],[19,20,12,13],[13,17,11,14]]),
relativeHighTop: ohlc([[11,15,10,14],[15,19,14,17],[14,16,9,12]]),
bottom: sample([[16,12],[14,10],[15,9],[16,11]]),
geometry: sample([[16,12],[14,10],[16,11]]),
recolored: sample([[16,12],[14,10],[16,11]]).map(bar=>({...bar,open:bar.close,close:bar.open})),
pen: sample([[3,2],[2,1],[3,2],[4,3],[5,4],[6,5],[5,4]]),
invalidTop: ohlc([[11,15,10,14],[25,20,12,13],[13,17,11,14]]),
long: sample([[8,4],...Array.from({length:125},()=>[10,6]),[9,4]]),
fixture: fixture.candles.map(({time,vol,...bar})=>({...bar,date:displayDate(time),volume:vol})),
};
cases.directBottom = mirror(cases.directTop);
cases.continuationBottom = mirror(cases.continuationTop);
cases.strongBottom = mirror(cases.strongTop);
cases.relativeLowBottom = mirror(cases.relativeHighTop);
const input = cases[new URLSearchParams(location.search).get('case') || 'top'];
const data = analyzeChan(input);
window.chanTestData = data;
window.behindEvents = 0;
window.zoomEvents = 0;
function App() {
const [changed,setChanged] = useState(false);
return React.createElement('main', { style: {maxWidth:1100,margin:'24px auto',padding:12} },
React.createElement('button',{id:'change-stock',onClick:()=>setChanged(true)},'切换测试股票'),
React.createElement('div',{onMouseDown:()=>window.behindEvents++,onTouchStart:()=>window.behindEvents++},
React.createElement(Chart,{rows:input.slice(-80),fullRows:input,chanData:changed ? {...data} : data,
chanOptions:{enabled:true,bi:true,fx:true,zs:true},onDisplayCountChange:()=>window.zoomEvents++})));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

const server = await createServer({ configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss(), { name: 'chan-detail-test-page', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__chan-fractal-test')) return next();
      try {
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, html));
      } catch (error) { next(error); }
    });
  } }],
  resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
  cacheDir: '/tmp/chan-detail-browser-cache',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
const output = process.env.CHAN_DETAIL_SCREENSHOTS || '/tmp/chan-fractal-detail';
try {
  await server.listen();
  const address = server.httpServer.address();
  const executablePath = process.env.CHAN_DETAIL_BROWSER || (existsSync(chromium.executablePath())
    ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const visit = async (name, dark = false) => {
    await page.goto(`http://127.0.0.1:${address.port}/__chan-fractal-test?case=${name}`);
    await page.locator('[data-chan-fractal]').first().waitFor();
    await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
  };
  const dialog = page.locator('dialog[data-chan-fractal-detail]');
  const checkComparison = async (rawCount) => {
    assert.equal(await dialog.locator('[data-chan-detail-candle]').count(), rawCount);
    assert.deepEqual(await dialog.locator('[data-chan-detail-merged]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-chan-detail-merged'))), ['0', '1', '2']);
    assert.deepEqual(await dialog.locator('[data-chan-detail-number="raw"]').allTextContents(),
      Array.from({ length: rawCount }, (_, i) => String(i + 1)));
    assert.deepEqual(await dialog.locator('[data-chan-detail-number="merged"]').allTextContents(), ['1', '2', '3']);
    assert.equal(await dialog.locator('table, details, [data-chan-detail-condition], [data-chan-detail-merge-step]').count(), 0);
    const comparison = dialog.locator('[data-chan-detail-comparison]');
    assert.equal(await comparison.count(), 1);
    const raw = comparison.locator('[data-chan-detail-panel="raw"]');
    const merged = comparison.locator('[data-chan-detail-panel="merged"]');
    const standard = comparison.locator('[data-chan-detail-panel="standard"]');
    const mark = await dialog.getAttribute('data-chan-fractal-detail');
    const fractalName = mark === 'G' ? '顶分型' : '底分型';
    assert.equal(await dialog.locator('[data-chan-detail-top-trait]').count(), mark === 'G' ? 1 : 0,
      'only top fractals should carry a top-trait classification');
    assert.equal(await dialog.locator('[data-chan-detail-bottom-trait]').count(), mark === 'D' ? 1 : 0,
      'only bottom fractals should carry a bottom-trait classification');
    assert.equal(await dialog.locator('[data-chan-detail-conclusion] strong').textContent(),
      rawCount > 3 ? `第二种：包含关系的${fractalName}` : `第一种：直接${fractalName}`);
    assert.equal(await standard.getByRole('heading', { name: mark === 'G' ? '标准顶分型' : '标准底分型' }).count(), 1);
    const bars = await standard.locator('[data-chan-detail-standard-bar]').evaluateAll((elements) =>
      elements.map((element) => ({ top: Number(element.getAttribute('y')), bottom: Number(element.getAttribute('y')) + Number(element.getAttribute('height')) })));
    assert.equal(bars.length, 3);
    for (const index of [0, 2]) {
      for (const edge of ['top', 'bottom']) assert.ok(mark === 'G' ? bars[1][edge] < bars[index][edge] : bars[1][edge] > bars[index][edge],
        'standard fractal must show the correct middle high/low relationship');
    }
    for (const edge of ['top', 'bottom']) {
      assert.ok(bars[2][edge] < bars[0][edge], 'reference diagram places the right side above the left, not at the same height');
    }
    assert.equal(await raw.locator('[data-chan-detail-chart="raw"]').count(), 1);
    assert.equal(await merged.locator('[data-chan-detail-chart="merged"]').count(), 1);
    assert.equal(await merged.locator('[data-chan-detail-range]').count(), 3);
    assert.equal(await merged.locator('rect[data-chan-detail-range]').count(), 3);
    assert.equal(await merged.locator('[data-chan-detail-body], [data-chan-detail-wick]').count(), 0,
      'processed Ks must use high/low rectangles, never open/close bodies or wicks');
    const left = await raw.boundingBox();
    const right = await merged.boundingBox();
    const reference = await standard.boundingBox();
    assert.ok(reference.x + reference.width <= left.x + 1, 'standard pattern must be the leftmost panel');
    assert.ok(Math.abs(reference.y - left.y) <= 2, 'all three panels should share a row');
    assert.ok(left && right, 'both comparison panels should be visible');
    assert.ok(Math.abs(left.y - right.y) <= 2, 'raw and merged panels should share the same row');
    assert.ok(left.x + left.width <= right.x + 1, 'raw candles should remain to the left of the merged result');
    assert.ok(left.width > 0 && right.width > 0, 'both comparison panels should retain visible width');
  };
  const checkTrait = async (side, expected, label) => {
    const attribute = `data-chan-detail-${side}-trait`;
    const trait = dialog.locator(`[${attribute}]`);
    assert.equal(await trait.count(), 1);
    assert.equal(await trait.getAttribute(attribute), expected);
    assert.equal(await dialog.locator(`[data-chan-detail-conclusion] [${attribute}]`).count(), 1,
      'fractal-trait classification should stay inside the existing conclusion footer');
    if (expected === 'ordinary' || expected === 'inclusion') {
      assert.equal(await trait.evaluate((element) => element.tagName), 'STRONG',
        'ordinary and inclusion results should add metadata to the geometry conclusion, without a badge');
      return;
    }
    assert.equal(await trait.evaluate((element) => element.tagName), 'BUTTON');
    assert.equal(await trait.textContent(), label);
    assert.equal(await dialog.locator('[data-chan-detail-software-reference]').textContent(), '软件形态参考');
    const explanation = await trait.getAttribute('title');
    assert.ok(explanation && /(?:三|3)根/.test(explanation), 'trait tooltip should identify the three-candle basis');
    assert.match(explanation, /阈值/);
    assert.match(explanation, /软件/);
    assert.match(explanation, /后续/);
    assert.match(explanation, /未|没有|不使用/, 'trait tooltip should not imply later price confirmation');
    assert.doesNotMatch(await trait.textContent(), /几乎确定|已确认/);
    const help = dialog.locator('[data-chan-detail-trait-help]');
    assert.equal(await trait.getAttribute('aria-expanded'), 'false');
    assert.equal(await help.count(), 0, 'trait explanation should be collapsed by default');
    await trait.click();
    await help.waitFor({ state: 'visible' });
    assert.equal(await trait.getAttribute('aria-expanded'), 'true');
    assert.equal(await trait.getAttribute('aria-controls'), await help.getAttribute('id'));
    assert.ok((await help.textContent()).startsWith(explanation), 'expanded explanation should preserve the tooltip rules and limits');
    assert.equal(await trait.textContent(), label);
    await trait.click();
    await help.waitFor({ state: 'detached' });
    assert.equal(await trait.getAttribute('aria-expanded'), 'false');
  };
  const checkTopTrait = (expected, label) => checkTrait('top', expected, label);
  const checkBottomTrait = (expected, label) => checkTrait('bottom', expected, label);
  const checkRawScroll = async () => {
    const rawScroll = dialog.locator('[data-chan-detail-raw-scroll]');
    assert.ok(await rawScroll.evaluate((element) => element.scrollWidth > element.clientWidth),
      'long raw candle history should scroll inside its own panel');
    await page.waitForFunction(() => {
      const container = document.querySelector('[data-chan-detail-raw-scroll]');
      const anchor = container.querySelector('[data-chan-detail-anchor="true"] circle');
      const bounds = container.getBoundingClientRect();
      const point = anchor.getBoundingClientRect();
      return point.left >= bounds.left && point.right <= bounds.right;
    });
  };
  await mkdir(output, { recursive: true });
  for (const [name, mark, high, low] of [['top', 'G', 11, 6], ['bottom', 'D', 14, 9]]) {
    await visit(name, name === 'bottom');
    const marker = page.locator(`[data-chan-fractal^="fx:${mark}:"]`).first();
    await marker.click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getAttribute('data-chan-fractal-detail'), mark);
    assert.equal(await dialog.locator('[data-chan-detail-snapshot]').getAttribute('data-chan-detail-snapshot'), 'fx');
    await checkComparison(4);
    if (mark === 'G') await checkTopTrait('inclusion');
    else await checkBottomTrait('inclusion');
    assert.equal(await dialog.locator('[data-chan-detail-merged="1"]').getAttribute('data-high'), String(high));
    assert.equal(await dialog.locator('[data-chan-detail-merged="1"]').getAttribute('data-low'), String(low));
    assert.equal(await dialog.locator('[data-chan-detail-merged="1"]').getAttribute('data-chan-detail-rendering'), 'range');
    assert.equal(await dialog.locator('[data-chan-detail-merged="1"] [data-chan-detail-body]').count(), 0,
      'actual inclusion must not invent an open/close body');
    await page.waitForFunction(() => document.querySelectorAll('[data-chan-detail-guide]').length === 2);
    for (const field of ['high', 'low']) {
      const aligned = await dialog.evaluate((element, field) => {
        const guide = element.querySelector(`[data-chan-detail-guide="1:${field}"]`).getBoundingClientRect();
        const boundary = element.querySelector('[data-chan-detail-merged="1"] [data-chan-detail-range]').getBoundingClientRect();
        return Math.abs(guide.top - (field === 'high' ? boundary.top : boundary.bottom)) <= 1;
      }, field);
      assert.ok(aligned, `inclusion ${field} guide must connect to its matching processed boundary`);
    }
    await page.evaluate(() => { window.behindEvents = 0; window.zoomEvents = 0; });
    await dialog.locator('[data-chan-detail-chart="raw"]').dispatchEvent('mousedown', { bubbles: true, clientX: 400 });
    await dialog.locator('[data-chan-detail-chart="raw"]').dispatchEvent('mouseup', { bubbles: true });
    await dialog.locator('[data-chan-detail-chart="raw"]').dispatchEvent('touchstart', { bubbles: true });
    await dialog.locator('[data-chan-detail-chart="raw"]').dispatchEvent('touchend', { bubbles: true });
    await dialog.locator('[data-chan-detail-chart="raw"]').dispatchEvent('wheel', { bubbles: true, deltaY: 120 });
    assert.deepEqual(await page.evaluate(() => [window.behindEvents, window.zoomEvents]), [0, 0]);
    await page.screenshot({ path: `${output}/${name}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await marker.evaluate((element) => document.activeElement === element), 'focus should return to SVG marker');
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await marker.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '关闭分型详情' }).click();
    await dialog.waitFor({ state: 'detached' });
    await marker.focus();
    await page.keyboard.press('Space');
    await dialog.waitFor({ state: 'visible' });
    await page.mouse.click(3, 3);
    await dialog.waitFor({ state: 'detached' });
  }

  await visit('directTop');
  await page.locator('[data-chan-fractal^="fx:G:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  await checkTopTrait('ordinary');
  await dialog.screenshot({ path: `${output}/direct-top-conclusion.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // These independent inputs end at the third raw candle: no subsequent price
  // exists that could confirm continuation, reversal or a lasting relative high.
  for (const [name, expected, label] of [
    ['continuationTop', 'continuation', '中继倾向'],
    ['strongTop', 'strong', '力度较大顶分型'],
    ['relativeHighTop', 'relativeHigh', '相对高点特征'],
  ]) {
    await visit(name);
    assert.equal(await page.evaluate(() => window.chanTestData.dates.length), 3);
    await page.locator('[data-chan-fractal^="fx:G:"]').click();
    await dialog.waitFor({ state: 'visible' });
    await checkComparison(3);
    await checkTopTrait(expected, label);
    await dialog.screenshot({ path: `${output}/${name}-trait.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }

  await visit('directBottom');
  await page.locator('[data-chan-fractal^="fx:D:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  await checkBottomTrait('ordinary');
  await dialog.screenshot({ path: `${output}/direct-bottom-conclusion.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // Reflect the same three-candle examples to verify the matching bottom rules
  // without adding subsequent prices that could imply later confirmation.
  for (const [name, expected, label] of [
    ['continuationBottom', 'continuation', '中继倾向'],
    ['strongBottom', 'strong', '力度较大底分型'],
    ['relativeLowBottom', 'relativeLow', '相对低点特征'],
  ]) {
    await visit(name);
    assert.equal(await page.evaluate(() => window.chanTestData.dates.length), 3);
    await page.locator('[data-chan-fractal^="fx:D:"]').click();
    await dialog.waitFor({ state: 'visible' });
    await checkComparison(3);
    await checkBottomTrait(expected, label);
    await dialog.screenshot({ path: `${output}/${name}-trait.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }

  await visit('invalidTop');
  await page.locator('[data-chan-fractal^="fx:G:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  assert.equal(await dialog.locator('[data-chan-detail-top-trait]').getAttribute('data-chan-detail-top-trait'), 'invalid-ohlc');
  assert.equal(await dialog.locator('[data-chan-detail-data-error]').textContent(), '原K数据异常，未进行力度识别');
  assert.equal(await dialog.locator('[data-chan-detail-conclusion] button').count(), 0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await visit('pen');
  await page.locator('[data-chan-fractal="bi:D:2"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  assert.equal(await dialog.locator('[data-chan-detail-snapshot]').getAttribute('data-chan-detail-snapshot'), 'bi');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // Select a visible, unmerged 603818 fractal from the corrected production
  // calculation. Historical website endpoint dates are not an accuracy oracle. Its endpoints must
  // still match the originals, while its high/low geometry is independent of open/close.
  await visit('fixture');
  const directTime = await page.evaluate(() => {
    const data = window.chanTestData;
    return data.fx.find((point) => point.mark === 'D' && point.time > data.dates.length - 80
      && data.fractalDetails.fx[point.time].rawCandles.length === 3)?.time;
  });
  assert.ok(directTime, 'saved history must exercise an actual visible direct bottom');
  await page.locator(`[data-chan-fractal="fx:D:${directTime}"]`).click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  for (let i = 0; i < 3; i++) {
    const raw = dialog.locator('[data-chan-detail-candle]').nth(i);
    const merged = dialog.locator(`[data-chan-detail-merged="${i}"]`);
    assert.equal(await merged.getAttribute('data-chan-detail-rendering'), 'range');
    const read = (locator) => locator.evaluate((element) =>
      [Number(element.getAttribute('y1')), Number(element.getAttribute('y2'))]);
    const bounds = await merged.locator('[data-chan-detail-range]').evaluate((element) =>
      [Number(element.getAttribute('y')), Number(element.getAttribute('y')) + Number(element.getAttribute('height'))]);
    assert.deepEqual(bounds,
      await read(raw.locator('[data-chan-detail-wick]')), `unmerged candle ${i + 1} must keep its high/low endpoints`);
  }
  const position = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2 - innerWidth / 2, y: rect.y + rect.height / 2 - innerHeight / 2 };
  });
  assert.ok(Math.abs(position.x) <= 2 && Math.abs(position.y) <= 2, `dialog must center in the viewport: ${JSON.stringify(position)}`);
  await page.screenshot({ path: `${output}/no-inclusion-603818.png` });
  await dialog.screenshot({ path: `${output}/high-low-comparison.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // Reversing every open/close flips raw red/green bodies, but cannot
  // change the processed high/low geometry. Color is an auxiliary cue.
  const geometries = [], rawColors = [];
  for (const name of ['geometry', 'recolored']) {
    await visit(name);
    await page.locator('[data-chan-fractal^="fx:D:"]').click();
    await dialog.waitFor({ state: 'visible' });
    await checkComparison(3);
    geometries.push(await dialog.locator('[data-chan-detail-range]').evaluateAll((elements) =>
      elements.map((element) => ['x', 'y', 'width', 'height'].map((name) => element.getAttribute(name)))));
    rawColors.push(await dialog.locator('[data-chan-detail-body]').evaluateAll((elements) => elements.map((element) => element.getAttribute('fill'))));
    const processedColors = await dialog.locator('[data-chan-detail-range]').evaluateAll((elements) => elements.map((element) => element.getAttribute('fill')));
    assert.deepEqual(processedColors, rawColors.at(-1), 'unmerged color follows its source, not a fabricated open/close body');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  assert.deepEqual(geometries[0], geometries[1], 'processed K display must depend on high/low, not open/close');
  assert.notDeepEqual(rawColors[0], rawColors[1], 'raw candle colors must still reflect the actual open/close');

  await visit('long', true);
  await page.locator('[data-chan-fractal^="fx:G:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(127);
  await checkTopTrait('inclusion');
  await checkRawScroll();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await visit('fixture', true);
  const marker = page.locator('[data-chan-fractal^="bi:"]').filter({ visible: true }).last();
  await marker.click();
  await dialog.waitFor({ state: 'visible' });
  await page.screenshot({ path: `${output}/real-chart.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  await visit('strongTop', true);
  await page.locator('[data-chan-fractal^="fx:G:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  await checkTopTrait('strong', '力度较大顶分型');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await visit('strongBottom', true);
  await page.locator('[data-chan-fractal^="fx:D:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(3);
  await checkBottomTrait('strong', '力度较大底分型');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await visit('bottom', true);
  await page.locator('[data-chan-fractal^="fx:D:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(4);
  assert.ok(await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await visit('long', true);
  await page.locator('[data-chan-fractal^="fx:G:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await checkComparison(127);
  await checkRawScroll();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile-long.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // A data refresh/stock switch must remove details belonging to old data.
  await visit('bottom', true);
  await page.locator('[data-chan-fractal^="fx:D:"]').click();
  await dialog.waitFor({ state: 'visible' });
  await page.evaluate(() => document.querySelector('#change-stock').click());
  await dialog.waitFor({ state: 'detached' });
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  assert.deepEqual(errors, []);
  console.log(`Chan fractal browser checks passed: solid high/low rectangles without wicks, open/close independence, inclusion guide alignment, top/bottom traits from three raw candles, inclusion exclusion, trait-help toggles on desktop/mobile, numbered side-by-side comparison, pen anchor, long inclusion scroll, real chart, keyboard, focus, event isolation, data refresh, light/dark and mobile. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
