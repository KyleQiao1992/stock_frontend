import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { analyzeChan } from '../src/lib/chan/index.js';

// These deterministic synthetic daily bars verify UI integration and geometry;
// they are not live quotations or an independent audit of the Chan algorithm.
const rows = [];
for (let day = new Date('2024-01-01T12:00:00Z'); day <= new Date('2026-10-21T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
  const i = rows.length;
  const center = 100 + i * 0.04 + Math.sin(i * Math.PI / 12) * 13 + Math.sin(i * Math.PI / 37) * 3;
  const open = center - Math.sin(i * 0.81) * 0.6;
  const close = center + Math.cos(i * 0.67) * 0.7;
  rows.push({ date: day.toISOString().slice(0, 10), open, close,
    high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: 1000 + i });
}
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.INDEX_TREND_SCREENSHOTS || '/tmp/index-trend-chart';
const counters = `window.__indexTrendCalls ||= { chan: [], ma: 0, macd: 0 };`;
const html = `<!doctype html><html lang="zh-CN" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarketTrendPageLayout } from '/src/components/AShareTD9InteractiveChart.jsx';
import '/src/index.css';
${counters}
createRoot(document.getElementById('root')).render(React.createElement('main',
  {style:{maxWidth:1440,margin:'20px auto',padding:12}}, React.createElement(MarketTrendPageLayout)));
</script></body></html>`;

// Test-only transforms expose the actual private page and record work. The
// production component and the indicator/Chan implementations remain intact.
const server = await createServer({ root, configFile: false, appType: 'custom',
  cacheDir: join(tmpdir(), 'index-trend-chart-vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [{ name: 'index-trend-test-instrumentation', enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0];
      if (path.endsWith('/src/components/AShareTD9InteractiveChart.jsx')) {
        return source
          .replace('import { analyzeChan } from "../lib/chan/index.js";',
            'import { analyzeChan as realAnalyzeChan } from "../lib/chan/index.js";\n'
            + 'function analyzeChan(rows, period) { const result = realAnalyzeChan(rows, period); '
            + '(window.__indexTrendResults ||= []).push(result); return result; }')
          .replace('function movingAverage(rows, n, pick = (r) => r.close) {',
            `function movingAverage(rows, n, pick = (r) => r.close) { ${counters} window.__indexTrendCalls.ma++;`)
          .replace('function calcMACDSeries(rows) {',
            `function calcMACDSeries(rows) { ${counters} window.__indexTrendCalls.macd++;`)
          + '\nexport { MarketTrendPageLayout };\n';
      }
      if (path.endsWith('/src/lib/chan/index.js')) {
        return source.replace("export function analyzeChan(rows, period = 'day') {",
          `export function analyzeChan(rows, period = 'day') { ${counters} window.__indexTrendCalls.chan.push(rows.map(row => row.date));`);
      }
      return null;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__index-trend-test')) return next();
        try {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml(req.url, html));
        } catch (error) { next(error); }
      });
    },
  }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});

let browser;
const observations = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.INDEX_TREND_BROWSER || (existsSync(chromium.executablePath())
      ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let responseBars = rows.length;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'web.ifzq.gtimg.cn' && url.pathname.endsWith('/kline/kline')) {
      const [symbol, period] = url.searchParams.get('param').split(',');
      const payload = { code: 0, data: { [symbol]: { [period]: rows.slice(-responseBars).map((row) =>
        [row.date, row.open, row.close, row.high, row.low, row.volume]) } } };
      const variable = url.searchParams.get('_var');
      return route.fulfill({ contentType: 'application/javascript',
        body: variable ? `var ${variable}=${JSON.stringify(payload)};` : JSON.stringify(payload) });
    }
    // The page initially mounts its heatmap. Keep that unrelated snapshot
    // deterministic while exercising both real trend tabs below.
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, data: [] } });
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort();
    return route.continue();
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const calls = () => page.evaluate(() => ({
    chan: window.__indexTrendCalls.chan.length,
    ma: window.__indexTrendCalls.ma,
    macd: window.__indexTrendCalls.macd,
  }));
  const charts = page.locator('svg[data-index-trend-chart]');
  const candleCount = () => charts.first().locator('[data-index-candle]').count();
  const chartCounts = () => charts.evaluateAll((elements) => Object.fromEntries(elements.map((element) =>
    [element.getAttribute('data-index-trend-chart'), element.querySelectorAll('[data-index-candle]').length])));
  const ensureCharts = async () => {
    await charts.first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('svg[data-index-trend-chart]').length === 4);
    await settle();
  };
  const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7,
    `${message}: expected ${expected}, got ${actual}`);
  const checkGeometry = async (chart, sourceRows) => {
    const geometry = await chart.evaluate((element) => ({
      candles: [...element.querySelectorAll('[data-index-candle]')].map((candle) => {
        const wick = candle.querySelector('line');
        return { date: candle.getAttribute('data-index-candle'), x: Number(wick.getAttribute('x1')),
          high: Number(wick.getAttribute('y1')), low: Number(wick.getAttribute('y2')) };
      }),
      bi: element.querySelector('[data-chan-path="bi"]')?.getAttribute('d'),
      endpoints: [...element.querySelectorAll('[data-chan-endpoint]')].map((point) => ({
        key: point.getAttribute('data-chan-endpoint'), points: point.getAttribute('points'),
      })),
      macd: [...element.querySelectorAll('[data-index-macd]')].map((bar) => ({
        date: bar.getAttribute('data-index-macd'), x: Number(bar.getAttribute('x1')),
      })),
    }));
    const data = analyzeChan(sourceRows, '101');
    const byDate = new Map(sourceRows.map((row) => [row.date, row]));
    const visible = new Map(geometry.candles.map((candle) => [candle.date, candle]));
    const first = geometry.candles[0], second = geometry.candles[1];
    const rawFirst = byDate.get(first.date);
    const scale = (first.low - first.high) / (rawFirst.high - rawFirst.low);
    const y = (price) => first.high + (rawFirst.high - price) * scale;
    const start = sourceRows.findIndex((row) => row.date === first.date);
    const x = (time) => first.x + (time - 1 - start) * (second.x - first.x);
    const points = [...geometry.bi.matchAll(/[ML]([-\d.e+]+),([-\d.e+]+)/g)]
      .map((match) => [Number(match[1]), Number(match[2])]);
    assert.equal(points.length, data.biLine.length, 'zoom must preserve every calculated pen-line endpoint');
    data.biLine.forEach((point, i) => {
      closeTo(points[i][0], x(point.time), 'pen-line X must follow the visible candle offset');
      closeTo(points[i][1], y(point.price), 'pen-line Y must use the candle price scale');
    });
    let visibleEndpoints = 0;
    for (const point of data.bi) {
      const candle = visible.get(data.dates[point.time - 1]);
      if (!candle) continue;
      const marker = geometry.endpoints.find((endpoint) => endpoint.key === `${point.time}:${point.price}`);
      assert.ok(marker, 'visible production pen endpoints must be rendered');
      const [px, py] = marker.points.split(' ')[0].split(',').map(Number);
      closeTo(px, candle.x, 'pen endpoint X must align with its source candle');
      closeTo(py + (point.mark === 'G' ? -9 : 9), point.mark === 'G' ? candle.high : candle.low,
        'pen endpoint Y must align with its original high/low');
      visibleEndpoints++;
    }
    assert.ok(visibleEndpoints > 0, 'synthetic history must exercise visible confirmed pen endpoints');
    assert.equal(geometry.macd.length, geometry.candles.length, 'every visible candle must keep its MACD bar');
    for (const bar of geometry.macd) closeTo(bar.x, visible.get(bar.date).x, 'MACD bars must align by source date');
    return { candles: geometry.candles.length, first: first.date, last: geometry.candles.at(-1).date, visibleEndpoints };
  };
  const checkAnalysisHistory = async (sourceRows) => {
    const actual = await page.evaluate(({ first, last, count }) => {
      const data = window.__indexTrendResults?.findLast((result) => result.dates.length === count
        && result.dates[0] === first && result.dates.at(-1) === last);
      return data && { dates: data.dates, historyOffset: data.historyOffset, historyDates: data.historyDates,
        analysisDates: data.analysisCandles.map((candle) => candle.date), definition: data.definition,
        biCount: data.bi.length, early: data.bi.find((point) => point.time <= count - 300) };
    }, { first: sourceRows[0].date, last: sourceRows.at(-1).date, count: sourceRows.length });
    assert.ok(actual, 'the actual trend component must expose its completed full-history calculation');
    assert.deepEqual(actual.dates, sourceRows.map((row) => row.date), 'every loaded valid bar must enter Chan analysis');
    assert.equal(actual.definition.analysisScope, 'all-loaded');
    assert.equal(actual.definition.requestedBars, sourceRows.length);
    assert.equal(actual.definition.segmentHistoryBars, sourceRows.length);
    assert.equal(actual.definition.segmentHistoryStart, sourceRows[0].date);
    assert.equal(actual.historyOffset + actual.definition.historyBars, sourceRows.length,
      'rule-based initial structure trimming must preserve the entire remaining loaded history');
    assert.deepEqual(actual.analysisDates, sourceRows.slice(actual.historyOffset).map((row) => row.date));
    assert.deepEqual(actual.historyDates, actual.analysisDates);
    assert.ok(actual.early, 'a confirmed pen endpoint preceding the final 300 bars must remain in the analysis');
    if (sourceRows.length === 733) assert.ok(actual.biCount > 50,
      'the long synthetic history must retain more than the former 50-pen display limit');
    const legend = await page.getByLabel('指数缠论图例', { exact: true }).first().textContent();
    assert.ok(legend.includes(`全部已加载 ${sourceRows.length} 根日K`), 'the legend must show the actual loaded history size');
    assert.ok(legend.includes(`截至 ${sourceRows.at(-1).date}`), 'the legend must identify the analysis cutoff');
    return { loadedBars: sourceRows.length, historyOffset: actual.historyOffset,
      retainedHistoryBars: actual.definition.historyBars, biCount: actual.biCount, early: actual.early };
  };
  const checkEarlyEndpoint = async (chart, point, visible) => {
    const marker = chart.locator(`[data-chan-endpoint="${point.time}:${point.price}"]`);
    assert.equal(await marker.count(), 1, 'the original early pen endpoint must remain in the real SVG');
    assert.equal(await marker.locator('..').getAttribute('aria-hidden'), visible ? null : 'true');
    const position = await marker.evaluate((element, mark) => {
      const panel = element.closest('svg').querySelector(':scope > rect');
      const first = element.points.getItem(0);
      return { x: first.x, y: first.y + (mark === 'G' ? -9 : 9), left: panel.x.baseVal.value,
        right: panel.x.baseVal.value + panel.width.baseVal.value, top: panel.y.baseVal.value,
        bottom: panel.y.baseVal.value + panel.height.baseVal.value };
    }, point.mark);
    if (visible) assert.ok(position.x >= position.left && position.x <= position.right
      && position.y >= position.top && position.y <= position.bottom,
    'zooming out to the full loaded range must reveal the early structure inside the price panel');
    else assert.ok(position.x < position.left, 'the preserved early structure should initially sit left of the visible window');
  };
  const wheelAt = async (target, deltaY) => {
    await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.5);
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, deltaY);
    await settle();
    assert.equal(await page.evaluate(() => window.scrollY), scrollY,
      'wheel gestures inside a chart must not scroll the surrounding page');
  };
  const checkWheelZoom = async (chart, panel, deltaY, sourceRows, boundary = false) => {
    const name = await chart.getAttribute('data-index-trend-chart');
    const before = await chartCounts();
    const beforeCalls = await calls();
    await wheelAt(chart.locator(':scope > rect').nth(panel), deltaY);
    const after = await chartCounts();
    if (boundary) assert.equal(after[name], before[name], 'wheel zoom must respect its current history/minimum boundary');
    else assert.ok(deltaY < 0 ? after[name] < before[name] : after[name] > before[name],
      `${panel ? 'MACD' : 'price'} panel wheel ${deltaY < 0 ? 'up' : 'down'} must change the visible candle count`);
    for (const [otherName, count] of Object.entries(before)) {
      if (otherName !== name) assert.equal(after[otherName], count, 'wheel zoom must change only the targeted index card');
    }
    assert.deepEqual(await calls(), beforeCalls, 'wheel zoom must reuse existing Chan, MA and MACD calculations');
    await checkGeometry(chart, sourceRows);
    return { panel: panel ? 'MACD' : 'price', deltaY, before: before[name], after: after[name], boundary };
  };
  const checkBothWheelPanels = async (chart, sourceRows, reset) => {
    const results = [];
    for (const panel of [0, 1]) {
      results.push(await checkWheelZoom(chart, panel, -120, sourceRows));
      results.push(await checkWheelZoom(chart, panel, 120, sourceRows));
      if (!await reset.isDisabled()) await reset.click();
    }
    return results;
  };
  const syntheticWheel = (chart, deltaY, deltaMode = 0, count = 1) => chart.evaluate((element, event) => {
    let prevented = true;
    for (let i = 0; i < event.count; i++) {
      const wheel = new WheelEvent('wheel', { deltaY: event.deltaY, deltaMode: event.deltaMode,
        bubbles: true, cancelable: true });
      element.dispatchEvent(wheel);
      prevented &&= wheel.defaultPrevented;
    }
    return prevented;
  }, { deltaY, deltaMode, count });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__index-trend-test`);
  await page.getByRole('button', { name: '中长期多头趋势', exact: true }).click();
  await ensureCharts();
  assert.equal(await candleCount(), 250);

  const fullAnalysis = await checkAnalysisHistory(rows);
  await checkEarlyEndpoint(charts.first(), fullAnalysis.early, false);
  observations.push({ case: 'all-loaded-history-733', ...fullAnalysis });
  observations.push({ case: 'long-default', ...await checkGeometry(charts.first(), rows) });
  await page.screenshot({ path: join(output, 'long-default.png') });

  const originalCalls = await calls();
  const mainSwitch = page.getByRole('button', { name: '缠论', exact: true });
  assert.equal(await mainSwitch.getAttribute('aria-pressed'), 'true');
  for (const [label, selector] of [
    ['笔', '[data-chan-path="bi"], [data-chan-endpoint]'],
    ['线段', '[data-chan-path="segment"], [data-chan-path="pending-segment"]'],
    ['重叠区', '[data-chan-zone]'],
    ['分型', '[data-chan-layer="lines"] circle'],
  ]) {
    const count = await charts.first().locator(selector).count();
    assert.ok(count > 0, `synthetic data must exercise ${label}`);
    await page.getByRole('checkbox', { name: label, exact: true }).uncheck();
    assert.equal(await charts.first().locator(selector).count(), 0, `${label} sub-switch must hide its own overlays`);
    await page.getByRole('checkbox', { name: label, exact: true }).check();
    assert.equal(await charts.first().locator(selector).count(), count, `${label} sub-switch must restore existing overlays`);
  }
  await mainSwitch.click();
  assert.equal(await page.locator('[data-chan-layer]').count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: '笔', exact: true }).count(), 0);
  await mainSwitch.click();
  assert.equal(await charts.locator('[data-chan-path="bi"]').count(), 4);
  await settle();
  assert.deepEqual(await calls(), originalCalls, 'overlay switches must not recalculate Chan, MA or MACD');
  observations.push({ case: 'master-and-four-sub-switches', calls: originalCalls });

  const zoomIn = page.getByRole('button', { name: '放大K线', exact: true }).first();
  const zoomOut = page.getByRole('button', { name: '缩小K线', exact: true }).first();
  const reset = page.getByRole('button', { name: '重置缩放', exact: true }).first();
  await zoomIn.click();
  assert.ok(await candleCount() < 250, 'zoom in should show fewer and wider candles');
  observations.push({ case: 'zoom-in', ...await checkGeometry(charts.first(), rows) });
  await reset.click();
  assert.equal(await candleCount(), 250);
  await zoomOut.click();
  assert.ok(await candleCount() > 250, 'zoom out should show more candles');
  observations.push({ case: 'zoom-out', ...await checkGeometry(charts.first(), rows) });
  for (let attempt = 0; attempt < 20 && !await zoomIn.isDisabled(); attempt++) await zoomIn.click();
  assert.equal(await zoomIn.isDisabled(), true, 'zoom in must stop at its minimum');
  assert.ok(await candleCount() >= 2);
  await checkGeometry(charts.first(), rows);
  for (let attempt = 0; attempt < 30 && !await zoomOut.isDisabled(); attempt++) await zoomOut.click();
  assert.equal(await zoomOut.isDisabled(), true, 'zoom out must stop at the loaded-history boundary');
  assert.equal(await candleCount(), rows.length);
  await checkGeometry(charts.first(), rows);
  await checkEarlyEndpoint(charts.first(), fullAnalysis.early, true);
  await page.screenshot({ path: join(output, 'all-loaded-733.png') });
  await reset.click();
  await settle();
  assert.deepEqual(await calls(), originalCalls, 'zooming must not recalculate Chan, MA or MACD');
  assert.deepEqual(await checkAnalysisHistory(rows), fullAnalysis, 'zooming must preserve the full calculated history');
  observations.push({ case: 'zoom-boundaries-and-reset', minReached: true, maxCandles: rows.length });
  observations.push({ case: 'long-real-wheel', results: await checkBothWheelPanels(charts.first(), rows, reset) });

  const syntheticCalls = await calls();
  for (const [deltaMode, deltaY] of [[1, -3], [2, -1]]) {
    const count = await candleCount();
    assert.equal(await syntheticWheel(charts.first(), deltaY, deltaMode), true,
      'line/page wheel events must be cancelable by the chart listener');
    await settle();
    assert.ok(await candleCount() < count, 'line/page wheel units must normalize into zoom input');
    await checkGeometry(charts.first(), rows);
    await reset.click();
  }
  await page.waitForTimeout(200);
  const beforeFine = await candleCount();
  assert.equal(await syntheticWheel(charts.first(), -0.5), true);
  await settle();
  assert.equal(await candleCount(), beforeFine, 'a single tiny touchpad delta must not jump the time window');
  assert.equal(await syntheticWheel(charts.first(), -1, 0, 120), true);
  await settle();
  assert.ok(await candleCount() < beforeFine, 'accumulated small touchpad deltas must eventually zoom');
  await checkGeometry(charts.first(), rows);
  await reset.click();
  assert.deepEqual(await calls(), syntheticCalls, 'normalized and accumulated wheel input must reuse calculations');
  observations.push({ case: 'synthetic-wheel-units-and-touchpad', deltaModes: [1, 2], tinyDeltaAccumulation: true });

  const fullscreen = page.getByRole('button', { name: '全屏查看图表', exact: true }).first();
  await fullscreen.click();
  const dialog = page.getByRole('dialog', { name: '上证指数全屏趋势图', exact: true });
  await dialog.waitFor({ state: 'visible' });
  await settle();
  assert.equal(await dialog.evaluate((element) => element.open && element.matches(':modal')), true,
    'expanded chart must use a native modal dialog');
  await checkGeometry(dialog.locator('svg[data-index-trend-chart]'), rows);
  const dialogBounds = await dialog.boundingBox();
  assert.ok(dialogBounds.width > 1200, 'expanded chart should use the desktop viewport');
  observations.push({ case: 'fullscreen-real-wheel', results: await checkBothWheelPanels(
    dialog.locator('svg[data-index-trend-chart]'), rows,
    dialog.getByRole('button', { name: '重置缩放', exact: true })) });
  await page.screenshot({ path: join(output, 'fullscreen.png') });
  // Pen-end markers can share the same source fractal and sit above its circle.
  await dialog.locator('[data-chan-fractal^="bi:"]:not([aria-hidden="true"])').last().click();
  const detail = page.locator('dialog[data-chan-fractal-detail]');
  await detail.waitFor({ state: 'visible' });
  const detailCounts = await chartCounts();
  const detailCalls = await calls();
  for (const deltaY of [-120, 120]) await wheelAt(detail.locator('[data-chan-detail-chart="raw"]'), deltaY);
  assert.deepEqual(await chartCounts(), detailCounts, 'wheel input inside fractal details must not zoom the background chart');
  assert.deepEqual(await calls(), detailCalls, 'wheel input inside fractal details must not recalculate the background chart');
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'detached' });
  assert.equal(await dialog.count(), 1, 'first Escape must dismiss only the nested fractal detail');
  assert.equal(await dialog.evaluate((element) => element.open && element.matches(':modal')), true,
    'expanded trend dialog must remain modal after fractal detail closes');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await fullscreen.evaluate((element) => document.activeElement === element), true,
    'Escape must restore keyboard focus to the fullscreen trigger');
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
  observations.push({ case: 'fullscreen-escape', width: Math.round(dialogBounds.width),
    nestedDetailEscape: true, restoredFocus: true });

  const beforeShort = await calls();
  await page.getByRole('button', { name: '中短期多头趋势', exact: true }).click();
  await ensureCharts();
  assert.equal(await candleCount(), 140, 'switching trend tabs should reset to its own default window');
  assert.match(await charts.first().textContent(), /MA20：/);
  assert.equal((await calls()).chan, beforeShort.chan, 'MA period changes must reuse the same Chan history');
  observations.push({ case: 'short-default', ...await checkGeometry(charts.first(), rows) });
  observations.push({ case: 'short-real-wheel', results: await checkBothWheelPanels(charts.first(), rows, reset) });
  await page.screenshot({ path: join(output, 'short-default.png') });

  const historicalRows = rows.filter((row) => row.date <= '2025-12-31');
  const historicalYearRows = rows.filter((row) => row.date.startsWith('2025-'));
  const beforeYear = (await calls()).chan;
  await page.getByRole('combobox').selectOption('2025');
  await page.waitForFunction(() => {
    const charts = [...document.querySelectorAll('svg[data-index-trend-chart]')];
    return charts.length === 4 && charts.every((chart) =>
      [...chart.querySelectorAll('[data-index-candle]')].every((candle) => candle.getAttribute('data-index-candle').startsWith('2025-')));
  });
  await settle();
  assert.equal(await candleCount(), historicalYearRows.length);
  const historicalAnalysis = await checkAnalysisHistory(historicalRows);
  const historicalCalls = await page.evaluate((start) => window.__indexTrendCalls.chan.slice(start), beforeYear);
  assert.ok(historicalCalls.length >= 4);
  for (const dates of historicalCalls) {
    assert.ok(dates.every((date) => date <= '2025-12-31'), 'historical Chan analysis must exclude future-year candles');
    assert.equal(dates[0], rows[0].date, 'historical analysis should retain all loaded prior history');
  }
  assert.equal(await zoomOut.isDisabled(), true, 'historical zoom out must stop at the selected-year boundary');
  observations.push({ case: 'historical-2025', ...await checkGeometry(charts.first(), historicalRows),
    analysisLastDate: historicalCalls.at(-1).at(-1), loadedAnalysisBars: historicalAnalysis.loadedBars });
  const maxWheel = await checkWheelZoom(charts.first(), 0, 120, historicalRows, true);
  await zoomIn.click();
  await checkGeometry(charts.first(), historicalRows);
  for (let attempt = 0; attempt < 20 && !await zoomIn.isDisabled(); attempt++) await zoomIn.click();
  assert.equal(await zoomIn.isDisabled(), true);
  const minWheel = await checkWheelZoom(charts.first(), 1, -120, historicalRows, true);
  await reset.click();
  assert.equal(await candleCount(), historicalYearRows.length);
  observations.push({ case: 'historical-real-wheel-boundaries', maxWheel, minWheel });
  await page.screenshot({ path: join(output, 'historical-2025.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox').selectOption('latest');
  await ensureCharts();
  assert.equal(await candleCount(), 140);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'trend controls and charts must not force horizontal page scrolling on mobile');
  for (const box of await charts.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  }))) assert.ok(box.left >= 0 && box.right <= 391, 'mobile chart should fit the viewport');
  await page.screenshot({ path: join(output, 'mobile.png') });
  await fullscreen.click();
  await dialog.waitFor({ state: 'visible' });
  await settle();
  const mobileDialog = await dialog.boundingBox();
  assert.ok(mobileDialog.width <= 390 && mobileDialog.height <= 844, 'mobile expanded chart must fit the viewport');
  const mobileChart = dialog.locator('svg[data-index-trend-chart]');
  await checkGeometry(mobileChart, rows);
  const mobilePricePanel = await mobileChart.locator(':scope > rect').first().boundingBox();
  assert.ok(mobilePricePanel.height > 250,
    `mobile fullscreen price panel must use the available height, got ${mobilePricePanel.height}px`);
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await checkGeometry(mobileChart, rows);
  const landscapeDialog = await dialog.boundingBox();
  assert.ok(landscapeDialog.x >= 0 && landscapeDialog.y >= 0
    && landscapeDialog.width <= 844 && landscapeDialog.height <= 390,
  'open fullscreen dialog must resize to the landscape viewport');
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden',
    'rotating the open fullscreen dialog must keep the background scroll locked');
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  await checkGeometry(mobileChart, rows);
  const restoredPricePanel = await mobileChart.locator(':scope > rect').first().boundingBox();
  assert.ok(restoredPricePanel.height > 250,
    `rotating back to portrait must restore a tall price panel, got ${restoredPricePanel.height}px`);
  await page.screenshot({ path: join(output, 'mobile-fullscreen.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  observations.push({ case: 'mobile-and-fullscreen', viewport: '390x844', width: Math.round(mobileDialog.width),
    height: Math.round(mobileDialog.height), pricePanelHeight: Math.round(restoredPricePanel.height),
    landscape: `${Math.round(landscapeDialog.width)}x${Math.round(landscapeDialog.height)}` });

  // A separate market-response size verifies that "all loaded" is neither a
  // renamed constant nor tied to the 733-bar scenario above.
  responseBars = 500;
  const fiveHundredRows = rows.slice(-responseBars);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__index-trend-test?bars=500`);
  await page.getByRole('button', { name: '中长期多头趋势', exact: true }).click();
  await ensureCharts();
  assert.equal(await candleCount(), 250);
  const fiveHundredAnalysis = await checkAnalysisHistory(fiveHundredRows);
  await checkGeometry(charts.first(), fiveHundredRows);
  await checkEarlyEndpoint(charts.first(), fiveHundredAnalysis.early, false);
  const fiveHundredCalls = await calls();
  for (let attempt = 0; attempt < 30 && !await zoomOut.isDisabled(); attempt++) await zoomOut.click();
  assert.equal(await candleCount(), 500);
  await checkGeometry(charts.first(), fiveHundredRows);
  await checkEarlyEndpoint(charts.first(), fiveHundredAnalysis.early, true);
  assert.deepEqual(await calls(), fiveHundredCalls, '500-bar zooming must not recalculate the complete history');
  assert.deepEqual(await checkAnalysisHistory(fiveHundredRows), fiveHundredAnalysis);
  await page.screenshot({ path: join(output, 'all-loaded-500.png') });
  observations.push({ case: 'all-loaded-history-500', ...fiveHundredAnalysis });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ synthetic: true, inputBars: rows.length, observations, screenshots: output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
