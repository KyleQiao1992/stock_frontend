import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Drive the actual A-share screen, rather than a component stand-in. Expected
// 4h prices below are calculated directly from independent 30m provider rows.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(`${tmpdir()}/four-hour-kline-check-`);
const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__four-hour-check-entry.jsx"></script></body></html>';
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/index.css'; import Chart from '/src/components/AShareTD9InteractiveChart.jsx'; createRoot(document.getElementById('root')).render(React.createElement(Chart,{user:{username:'4小时验收',role:'user'}}));`;
const server = await createServer({ root, configFile: false, plugins: [{
  name: 'four-hour-check-entry',
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__four-hour-check') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__four-hour-check', html));
    });
  },
  resolveId(id) { if (id === '/__four-hour-check-entry.jsx') return '\0four-hour-check-entry.jsx'; },
  load(id) { if (id === '\0four-hour-check-entry.jsx') return entry; },
}, react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } }, cacheDir: `${out}/vite-cache`,
server: { host: '127.0.0.1', port: 0, hmr: false },
optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] } });

const today = '2026-10-20';
const exDate = '2026-10-09';
const cash = 0.2, shareFactor = 1.4;
const fixedNow = new Date(`${today}T13:10:00+08:00`);
const times30 = ['1000', '1030', '1100', '1130', '1330', '1400', '1430', '1500'];
const dayDates = [];
for (let date = new Date('2024-01-01T00:00:00Z'); date <= new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dayDates.push(date.toISOString().slice(0, 10));
}
const round = value => +value.toFixed(6);
const slotPrices = [
  [71, 71.15, 71.3, 70.85], [71.2, 71.05, 71.4, 70.9],
  [70.8, 71.5, 71.6, 70.6], [71.5, 71.35, 71.7, 71.2],
  [71.35, 71.75, 71.9, 71.3], [72, 71.8, 72.3, 71.7],
  [71.8, 72.2, 72.4, 71.6], [72.2, 72.1, 72.6, 71.9],
];
const adjusted30 = dayDates.flatMap((date, dayIndex) => times30.filter(time => date !== today || time <= '1330').map((time, slot) => {
  const offset = Math.sin(dayIndex * 0.17) * 0.3;
  return [date.replaceAll('-', '') + time, ...slotPrices[slot].map(price => round(price + offset)), (slot + 1) * 100];
}));
function sourceMinuteRows(type, symbol) {
  let result;
  if (type === 'm30') result = adjusted30;
  else {
    result = dayDates.flatMap((date, dayIndex) => {
      const times = [];
      for (const [start, end] of [[570, 690], [780, 900]]) for (let minute = start + 5; minute <= end; minute += 5) {
        const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`;
        if (date !== today || time <= '1310') times.push(time);
      }
      return times.map((time, index) => [date.replaceAll('-', '') + time, 71 + dayIndex / 10000, 71.1 + dayIndex / 10000, 71.2 + dayIndex / 10000, 70.9 + dayIndex / 10000, 100 + index]);
    });
  }
  return result.map(row => row.map((value, index) => {
    if (index < 1 || index > 4) return value;
    if (symbol === 'sh000688') return round(value * 20); // realistic four-digit index labels
    return row[0].slice(0, 8) < exDate.replaceAll('-', '') ? round(value * shareFactor + cash) : value;
  }));
}
function dailyBars(adjusted = true, count = 640) {
  return dayDates.slice(-count).map(date => {
    const prices = date < exDate ? [100, 100, 103, 97] : [(100 - cash) / shareFactor, (100 - cash) / shareFactor, (103 - cash) / shareFactor, (97 - cash) / shareFactor];
    const bar = [date, ...prices.map(price => String(round(adjusted && date < exDate ? (price - cash) / shareFactor : price))), '1000000'];
    if (date === exDate) bar.push({ cqr: exDate, FHcontent: '10派2元转4股' });
    return bar;
  });
}

// A deliberately simple independent reference: known exchange slots, first O,
// last C, max H, min L, sum V. The production aggregator is never imported.
const expected4h = [];
const available30 = adjusted30.slice(-2400);
for (const date of dayDates) {
  for (const [slots, start, end] of [[times30.slice(0, 5), '09:30', '13:30'], [times30.slice(5), '13:30', '15:00']]) {
    const prefix = date.replaceAll('-', '');
    const bars = available30.filter(row => row[0].startsWith(prefix) && slots.includes(row[0].slice(8)));
    if (!bars.length || bars[0][0].slice(8) !== slots[0]) continue;
    expected4h.push({ date: `${date} ${end}`, start: `${date} ${start}`, end: `${date} ${end}`, sourceCount: bars.length,
      open: +bars[0][1], close: +bars.at(-1)[2], high: Math.max(...bars.map(bar => +bar[3])), low: Math.min(...bars.map(bar => +bar[4])), volume: bars.reduce((sum, bar) => sum + +bar[5], 0) });
  }
}

let browser;
const requests = [], errors = [], routeErrors = [], results = [];
let fixtureMode = '', quoteTime = '20261020131000';
let holdNext30 = false, heldStarted, markHeld, heldRequest, releaseHeld;
function prepareHeldRequest() {
  heldStarted = new Promise(resolve => { markHeld = resolve; });
  heldRequest = new Promise(resolve => { releaseHeld = resolve; });
  holdNext30 = true;
}
const periodSelector = 'select[aria-label="K线周期"]';
const countSelector = 'select[title="也可在 K 线图内滚动鼠标滚轮调整"]';
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1080 }, timezoneId: 'America/Toronto' });
  await page.clock.setFixedTime(fixedNow);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('gtimg.cn')) {
        const parts = (url.searchParams.get('param') || '').split(',');
        const [symbol, type] = parts;
        const minute = /^m(?:5|30)$/.test(type);
        const request = { symbol, type, end: parts[2], requested: Number(parts[minute ? 3 : 4]), path: url.pathname };
        requests.push(request);
        let bars, key;
        if (minute) {
          assert.equal(url.pathname, '/appstock/app/kline/mkline');
          assert.ok(request.requested <= 800, 'Tencent minute request stays within its 800-row page limit');
          if (holdNext30 && type === 'm30') { holdNext30 = false; markHeld(); await heldRequest; }
          let source = sourceMinuteRows(type, symbol);
          if (fixtureMode === 'missing' && type === 'm30') source = source.filter(row => row[0] !== '202610191100');
          if (fixtureMode === 'prefix' && type === 'm30') source = source.filter(row => row[0] !== '202610201330');
          if (fixtureMode === 'truncated' && type === 'm30') source = source.filter(row => row[0] >= '202610161030');
          bars = source.filter(row => !request.end || row[0] < request.end).slice(-request.requested);
          key = type;
        } else {
          assert.ok(['day', 'week', 'month'].includes(type), `4h must not request a fabricated provider period ${type}`);
          const adjusted = parts.includes('qfq');
          key = adjusted ? `qfq${type}` : type;
          bars = dailyBars(adjusted, request.requested || 640);
        }
        const qt = [];
        qt[1] = `验收${symbol}`; qt[3] = '71.75'; qt[6] = '1500'; qt[30] = quoteTime; qt[32] = '3.58'; qt[38] = '2.50'; qt[44] = '100';
        const payload = { code: 0, data: { [symbol]: { [key]: bars, qt: { [symbol]: qt } } } };
        const variable = url.searchParams.get('_var');
        await route.fulfill({ contentType: variable ? 'application/javascript' : 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: variable ? `window[${JSON.stringify(variable)}]=${JSON.stringify(payload)};` : JSON.stringify(payload) });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const market = url.searchParams.get('market') || 'ashare';
        let body = { ok: true, items: [], groups: ['默认'] };
        if (url.pathname === '/api/favorites') body = { ok: true, groups: ['默认'], items: [{ code: market === 'hk' ? '00700' : market === 'us' ? 'AAPL' : '603268', name: '验收收藏', group: '默认', createdAt: 1 }] };
        if (url.pathname === '/api/market-indices') body = { ok: true, indices: [] };
        if (url.pathname === '/api/suspension-alert') body = { ok: true, level: 'normal', label: '正常', reasons: [] };
        if (url.pathname === '/api/ashare-trade-side-history') body = { ok: true, code: url.searchParams.get('code'), items: [], latest: null };
        if (['/api/hk-kline', '/api/us-kline'].includes(url.pathname)) {
          requests.push({ market: url.pathname.includes('hk') ? 'hk' : 'us', type: url.searchParams.get('period') });
          body = { ok: true, code: market === 'hk' ? '00700' : 'AAPL', name: '跨市场验收', klines: dailyBars().map(([date, open, close, high, low, volume]) => ({ date, open: +open, close: +close, high: +high, low: +low, volume: +volume })) };
        }
        await route.fulfill({ json: body });
        return;
      }
      if (url.hostname !== '127.0.0.1') return route.abort();
      await route.continue();
    } catch (error) { routeErrors.push(error.stack); await route.abort().catch(() => {}); }
  });
  const chart = () => page.locator('svg[data-kline-period]').last();
  const candles = () => chart().locator('g[data-kline-time]');
  const record = (name, details = {}) => results.push({ name, ...details });
  async function ready(period, count) {
    await page.waitForFunction(({ period, count }) => {
      const charts = [...document.querySelectorAll('svg[data-kline-period]')];
      return charts.length && charts.every(svg => svg.dataset.klinePeriod === period && +svg.dataset.klineCount === count);
    }, { period, count });
    assert.equal(await candles().count(), count);
  }
  async function changePeriod(period, count = 80) {
    await page.locator(periodSelector).selectOption(period);
    await ready(period, count);
    assert.equal(await page.getByRole('button', { name: '查询', exact: true }).isEnabled(), true);
  }
  async function hover(index) {
    await chart().evaluate((svg, index) => {
      const line = svg.querySelectorAll('g[data-kline-time]')[index].querySelector('line');
      const point = svg.createSVGPoint(); point.x = +line.getAttribute('x1'); point.y = +line.getAttribute('y1');
      const screen = point.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: screen.x, clientY: screen.y, bubbles: true }));
    }, index);
    const texts = await chart().locator('text').allTextContents();
    const header = texts.find(text => / 开 .* 高 .* 低 .* 收 /.test(text));
    assert.ok(header, 'hover displays real candle OHLC');
    return { header, texts };
  }
  async function latestHeader() { await chart().hover({ position: { x: 120, y: 100 } }); await page.mouse.move(1, 1); return chart().locator('text').allTextContents(); }
  await page.goto(`${base}__four-hour-check`);
  await ready('101', 80);
  assert.deepEqual(await page.locator(periodSelector).locator('option').evaluateAll(options => options.map(option => option.value)), ['5', '30', '240', '101', '102', '103']);
  await changePeriod('5'); await changePeriod('30');
  const start = requests.length;
  await changePeriod('240');
  const minuteRequests = requests.slice(start).filter(request => request.type?.startsWith('m'));
  assert.equal(minuteRequests.length, 3, '4h loads all 2400 source rows in three pages');
  assert.ok(minuteRequests.every(request => request.type === 'm30' && request.requested === 800), '4h only requests real m30 pages');
  record('A-share exposes 4h, and switches 5m → 30m → 4h using three real 800-row m30 pages');

  const actualMax = +(await page.locator(countSelector).locator('option').last().getAttribute('value'));
  assert.equal(actualMax, expected4h.length);
  assert.ok(actualMax > 500, 'source pagination produces more than 500 actual target bars');
  await page.locator(countSelector).selectOption(String(actualMax));
  await ready('240', actualMax);
  const timeKeys = await candles().evaluateAll(elements => elements.map(element => element.dataset.klineTime));
  assert.deepEqual(timeKeys, expected4h.map(row => row.date));
  assert.equal(new Set(timeKeys).size, timeKeys.length, 'target candles have unique date+time keys');
  record('4h dates are independently derived 13:30/15:00 windows with actual loaded maximum', { sourceBars: 2400, targetBars: actualMax });

  // Use the final 80 bars for readable, precise hovering. One complete day's
  // eight source rows must form exactly two OHLCV bars; no 8-row daily collapse.
  await page.locator(countSelector).selectOption('80'); await ready('240', 80);
  const visible = expected4h.slice(-80);
  const sampleDayIndices = visible.map((row, index) => row.date.startsWith('2026-10-08') ? index : -1).filter(index => index >= 0);
  assert.equal(sampleDayIndices.length, 2, 'independent OHLCV assertion covers both windows of the sample day');
  for (const index of sampleDayIndices) {
    const expected = visible[index];
    const { header, texts } = await hover(index);
    assert.ok(header.includes(`${expected.start.slice(0, 10)} ${expected.start.slice(11)}–${expected.end.slice(11)}`), `header shows actual 4h interval: ${header}`);
    for (const [label, key] of [['开', 'open'], ['高', 'high'], ['低', 'low'], ['收', 'close']]) assert.equal(Number(header.match(new RegExp(`${label} ([\\d.]+)`))[1]), +expected[key].toFixed(2), `${key} aggregates adjusted 30m rows`);
    assert.ok(texts.some(text => text.startsWith('成交量 ') && text.includes(expected.volume.toFixed(2))), `volume sums ${expected.volume} actual lots`);
    const attributes = await candles().nth(index).evaluate(element => ({ start: element.dataset.klineStart, end: element.dataset.klineEnd, count: +element.dataset.klineSourceCount }));
    assert.deepEqual(attributes, { start: expected.start, end: expected.end, count: expected.sourceCount });
  }
  record('hand-calculated eight-row day produces two correctly adjusted OHLCV windows, five source bars plus three');

  const latest = await candles().last().evaluate(element => ({ complete: element.dataset.klineComplete, start: element.dataset.klineStart, end: element.dataset.klineEnd, sourceTime: element.dataset.klineSourceTime, sourceCount: +element.dataset.klineSourceCount }));
  assert.equal(latest.complete, 'false');
  assert.equal(latest.start, `${today} 09:30`); assert.equal(latest.end, `${today} 13:30`); assert.equal(latest.sourceCount, 5);
  assert.equal(latest.sourceTime, `${today} 13:30`, 'source retains its own 30m closing label, even while forming');
  const latestTexts = await latestHeader();
  assert.ok(latestTexts.some(text => /4小时.*09:30–13:30.*盘中/.test(text)), 'forming header shows 4h interval and in-progress state');
  assert.ok((await page.locator('body').innerText()).includes('09:30–13:30'), 'page documents the selected 4h boundaries');
  assert.ok((await page.locator('body').innerText()).includes('13:30–15:00'), 'page documents the truncated closing window');
  record('13:30 boundary belongs to the first window and unfinished source never confirms a target candle', latest);

  const lastMean = count => expected4h.slice(-count).reduce((sum, row) => sum + row.close, 0) / count;
  const expectedMA120 = lastMean(120).toFixed(2), expectedBBI = ([3, 6, 12, 24].map(lastMean).reduce((sum, value) => sum + value, 0) / 4).toFixed(2);
  for (const count of [20, 80, actualMax]) {
    await page.locator(countSelector).selectOption(String(count)); await ready('240', count);
    const texts = await latestHeader();
    assert.equal(texts.find(text => /^MA120 [\d.]+$/.test(text))?.slice(6), expectedMA120, `MA120 uses 120 target candles at viewport ${count}`);
    assert.equal(texts.find(text => /^BBI [\d.]+$/.test(text))?.slice(4), expectedBBI, `BBI uses target candles at viewport ${count}`);
  }
  await chart().evaluate(svg => svg.parentElement.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })));
  const lowerCount = +await chart().getAttribute('data-kline-count');
  assert.ok(lowerCount < actualMax && lowerCount > 0);
  await chart().evaluate(svg => svg.parentElement.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })));
  await ready('240', actualMax);
  await page.getByRole('button', { name: '全屏', exact: true }).click(); await ready('240', actualMax);
  await page.getByRole('button', { name: '退出全屏', exact: true }).last().click(); await ready('240', actualMax);
  record('4h MA120 and BBI are recalculated from target bars; zoom, wheel and fullscreen preserve period and actual maximum', { expectedMA120, expectedBBI });

  const analysisTab = page.getByRole('tab', { name: '缠论研判', exact: true });
  await analysisTab.click();
  assert.ok((await page.getByRole('region', { name: '个股分析' }).innerText()).includes('4小时 ·'), 'analysis panel labels the actual loaded target period');
  await page.locator(countSelector).selectOption('80'); await ready('240', 80);
  await changePeriod('101');
  await page.getByRole('button', { name: /^科创50，/ }).click(); await ready('101', 80);
  for (const period of ['5', '30', '240']) await changePeriod(period);
  assert.ok(requests.some(request => request.symbol === 'sh000688' && request.type === 'm30'));
  await page.setViewportSize({ width: 1360, height: 1080 });
  await latestHeader();
  const headerBox = await chart().locator('text').filter({ hasText: / 开 .* 高 .* 低 .* 收 / }).evaluate(element => {
    const box = element.getBBox(); return { x: box.x, width: box.width, svgWidth: element.ownerSVGElement.viewBox.baseVal.width, text: element.textContent };
  });
  assert.ok(headerBox.x >= 0, `4h index header remains inside the narrow chart: ${JSON.stringify(headerBox)}`);
  assert.ok(headerBox.x + headerBox.width <= headerBox.svgWidth, '4h header right edge remains in the SVG');
  await page.screenshot({ path: `${out}/narrow-index.png`, fullPage: true });
  await page.setViewportSize({ width: 1680, height: 1080 });
  await changePeriod('101');
  record('analysis panel uses 4小时; STAR50 switches all periods and four-digit OHLC stays inside the narrow chart', { headerBox });

  prepareHeldRequest();
  await page.locator(periodSelector).selectOption('240');
  let timeout;
  try { await Promise.race([heldStarted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('4h m30 request was not started')), 15000); })]); } finally { clearTimeout(timeout); }
  await changePeriod('5');
  const released = page.waitForResponse(response => decodeURIComponent(response.url()).includes('sh000688,m30,'));
  releaseHeld(); await released; await page.waitForLoadState('networkidle'); await ready('5', 80);
  assert.equal(await page.locator(periodSelector).inputValue(), '5');
  record('late 4h response cannot overwrite a more recent 5m request');

  await changePeriod('240');
  for (const market of ['港股', '美股']) {
    await page.getByRole('button', { name: market, exact: true }).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.value === '101', periodSelector);
    assert.deepEqual(await page.locator(periodSelector).locator('option').evaluateAll(elements => elements.map(element => element.value)), ['101', '102', '103']);
    if (market === '港股') { await page.getByRole('button', { name: 'A股', exact: true }).click(); await ready('101', 80); await changePeriod('240'); }
  }
  assert.ok(requests.filter(request => request.market).every(request => ['101', '102', '103'].includes(request.type)));
  record('HK and US hide unsupported 4h and reset to daily before loading');

  await page.getByRole('button', { name: 'A股', exact: true }).click(); await ready('101', 80);
  fixtureMode = 'prefix'; quoteTime = '20261020125900'; await page.clock.setFixedTime(new Date(`${today}T13:00:00+08:00`));
  await changePeriod('240');
  const prefix = await candles().last().evaluate(element => ({ complete: element.dataset.klineComplete, count: +element.dataset.klineSourceCount, end: element.dataset.klineEnd }));
  assert.deepEqual(prefix, { complete: 'false', count: 4, end: `${today} 13:30` });
  record('valid current-day four-row prefix remains a forming 13:30 window', prefix);

  await changePeriod('101'); fixtureMode = 'missing'; quoteTime = '20261020131000'; await page.clock.setFixedTime(fixedNow);
  await page.locator(periodSelector).selectOption('240');
  await page.getByText(/4小时聚合缺少30分钟K线/).first().waitFor();
  assert.equal(await page.locator('svg[data-kline-period]').count(), 0, 'missing source interval never renders a misleading 4h chart');
  record('missing historical 30m child produces an explicit error and removes the chart');

  await changePeriod('101'); fixtureMode = 'truncated';
  await changePeriod('240', 4);
  assert.equal(await candles().first().getAttribute('data-kline-time'), '2026-10-16 15:00', 'initial partial 09:30–13:30 window is removed');
  assert.equal(await candles().first().getAttribute('data-kline-source-count'), '3');
  record('source retention starting at 10:30 discards the truncated initial window and retains the complete afternoon window');

  assert.deepEqual(errors, []); assert.deepEqual(routeErrors, []);
  await page.screenshot({ path: `${out}/final.png`, fullPage: true });
  await writeFile(`${out}/result.json`, JSON.stringify({ ok: true, results, errors, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: results.length, results, output: out }, null, 2));
} catch (error) {
  if (releaseHeld) releaseHeld();
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${out}/failure.json`, JSON.stringify({ error: error.stack, errors, routeErrors, requests, results }, null, 2));
  console.error(error.stack); console.error(JSON.stringify({ output: out, errors, routeErrors, results }, null, 2)); process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
