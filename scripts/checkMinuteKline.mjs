import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Exercise the actual default A-share screen. The independent provider fixtures
// distinguish intraday requests, cash/share adjustments, and stale responses.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(`${tmpdir()}/minute-kline-check-`);
const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__minute-check-entry.jsx"></script></body></html>';
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/index.css'; import Chart from '/src/components/AShareTD9InteractiveChart.jsx'; createRoot(document.getElementById('root')).render(React.createElement(Chart,{user:{username:'分钟周期验收',role:'user'}}));`;
const server = await createServer({ root, configFile: false, plugins: [{
  name: 'minute-check-entry',
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__minute-check') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__minute-check', html));
    });
  },
  resolveId(id) { if (id === '/__minute-check-entry.jsx') return '\0minute-check-entry.jsx'; },
  load(id) { if (id === '\0minute-check-entry.jsx') return entry; },
}, react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } }, cacheDir: `${out}/vite-cache`,
server: { host: '127.0.0.1', port: 0, hmr: false },
optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] } });

const fixedNow = new Date('2026-10-19T10:03:00+08:00');
const exDate = '2026-10-09';
const cash = 0.2;
const shareFactor = 1.4;
const normalizedBase = (100 - cash) / shareFactor;
const round = n => Number(n.toFixed(6));
const day = value => value.toISOString().slice(0, 10);
const tradingDays = [];
for (let date = new Date('2024-01-01T00:00:00Z'); date <= new Date('2026-10-19T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 1)) {
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) tradingDays.push(day(date));
}
function intradayTimes(minutes) {
  const result = [];
  for (const [start, end] of [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]]) {
    for (let time = start + minutes; time <= end; time += minutes) result.push(`${String(Math.floor(time / 60)).padStart(2, '0')}${String(time % 60).padStart(2, '0')}`);
  }
  return result;
}
function minuteBars(period) {
  const minutes = Number(period.slice(1));
  let index = 0;
  return tradingDays.flatMap(date => intradayTimes(minutes).filter(time => date !== '2026-10-19' || time <= (minutes === 5 ? '1005' : '1030')).map(time => {
    const base = normalizedBase + Math.sin(index++ * 0.13) * 0.35;
    const convert = n => round(date < exDate ? n * shareFactor + cash : n);
    return [date.replaceAll('-', '') + time, convert(base - 0.01), convert(base + 0.01), convert(base + 0.1), convert(base - 0.1), '100000'];
  })).slice(-1320);
}
const minuteFixtures = { m5: minuteBars('m5'), m30: minuteBars('m30') };
function dailyBars(type = 'day', adjusted = true, count = 640) {
  const source = type === 'week' ? tradingDays.filter((_, i) => i % 5 === 0) : type === 'month' ? tradingDays.filter((_, i) => i % 20 === 0) : tradingDays;
  return source.slice(-count).map(date => {
    const rawPrices = date < exDate ? [100, 100, 103, 97] : [normalizedBase, normalizedBase, (103 - cash) / shareFactor, (97 - cash) / shareFactor];
    const prices = adjusted && date < exDate ? rawPrices.map(n => (n - cash) / shareFactor) : rawPrices;
    const bar = [date, ...prices.map(n => String(round(n))), '10000000'];
    if (date === exDate) bar.push({ cqr: exDate, FHcontent: '10派2元转4股' });
    return bar;
  });
}
function foreignBars() {
  return dailyBars().map(([date, open, close, high, low, volume]) => ({ date, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume) }));
}

let browser;
const requests = [];
const errors = [];
const results = [];
const routeErrors = [];
let fixtureFailure = '';
let delayNextM5 = false;
let heldRequest;
let releaseHeld;
let markHeld;
let heldStarted;
function prepareHeldRequest() {
  heldStarted = new Promise(resolve => { markHeld = resolve; });
  heldRequest = new Promise(resolve => { releaseHeld = resolve; });
  delayNextM5 = true;
}
const periodSelector = 'select:has(option[value="101"])';
const countSelector = 'select[title="也可在 K 线图内滚动鼠标滚轮调整"]';
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1080 }, timezoneId: 'Asia/Shanghai' });
  await page.clock.setFixedTime(fixedNow);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('gtimg.cn')) {
        const parts = (url.searchParams.get('param') || '').split(',');
        const symbol = parts[0];
        const type = parts[1];
        const isMinute = /^m(?:5|30)$/.test(type);
        const request = { symbol, type, end: parts[2], requested: Number(parts[isMinute ? 3 : 4]), path: url.pathname, url: url.href };
        requests.push(request);
        let bars;
        let key;
        if (isMinute) {
          assert.equal(url.pathname, '/appstock/app/kline/mkline', 'minute data must use the minute endpoint');
          assert.ok(request.requested <= 800, 'Tencent minute pages must not exceed 800');
          if (delayNextM5 && type === 'm5') {
            delayNextM5 = false;
            markHeld();
            await heldRequest;
          }
          bars = minuteFixtures[type].filter(bar => !request.end || bar[0] < request.end).slice(-request.requested);
          key = type;
          if (fixtureFailure === 'daily-in-minute') {
            key = 'day';
            bars = dailyBars();
          }
        } else {
          assert.ok(['day', 'week', 'month'].includes(type), `unexpected provider period ${type}`);
          const adjusted = parts.includes('qfq');
          key = adjusted ? `qfq${type}` : type;
          bars = dailyBars(type, adjusted, request.requested || 640);
          if (fixtureFailure === 'invalid-qfq' && key === 'qfqday') bars = bars.map(bar => bar[0] < exDate ? bar.map((value, index) => index === 3 ? String(Number(value) + 1) : value) : bar);
        }
        const qt = [];
        qt[1] = `验收${symbol}`;
        qt[6] = '10000000';
        qt[32] = '3.58';
        qt[30] = '20261019100300';
        qt[38] = '2.50';
        qt[44] = '100';
        const payload = { code: 0, data: { [symbol]: { [key]: bars, qt: { [symbol]: qt } } } };
        const variable = url.searchParams.get('_var');
        await route.fulfill({ contentType: variable ? 'application/javascript' : 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
          body: variable ? `window[${JSON.stringify(variable)}]=${JSON.stringify(payload)};` : JSON.stringify(payload) });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        let body = { ok: true, items: [], groups: ['默认'] };
        const market = url.searchParams.get('market') || 'ashare';
        if (url.pathname === '/api/favorites') body = { ok: true, groups: ['默认'], items: [{ code: market === 'hk' ? '00700' : market === 'us' ? 'AAPL' : '603268', name: '验收收藏', group: '默认', createdAt: 1 }] };
        if (url.pathname === '/api/market-indices') body = { ok: true, indices: [] };
        if (url.pathname === '/api/suspension-alert') body = { ok: true, level: 'normal', label: '正常', reasons: [] };
        if (url.pathname === '/api/ashare-trade-side-history') body = { ok: true, code: url.searchParams.get('code'), items: [], latest: null };
        if (['/api/hk-kline', '/api/us-kline'].includes(url.pathname)) {
          requests.push({ market: url.pathname.includes('hk') ? 'hk' : 'us', type: url.searchParams.get('period'), path: url.pathname });
          body = { ok: true, code: market === 'hk' ? '00700' : 'AAPL', name: '跨市场验收', klines: foreignBars() };
        }
        await route.fulfill({ json: body });
        return;
      }
      if (url.hostname !== '127.0.0.1') return route.abort();
      await route.continue();
    } catch (error) {
      routeErrors.push(error.stack);
      await route.abort().catch(() => {});
    }
  });
  const chart = () => page.locator('svg[data-kline-period]').last();
  const candles = () => chart().locator('g[data-kline-time]');
  const record = (name, details = {}) => results.push({ name, ...details });
  async function ready(period, count) {
    await page.waitForFunction(({ period, count }) => {
      const charts = [...document.querySelectorAll('svg[data-kline-period]')];
      return charts.length && charts.every(svg => svg.dataset.klinePeriod === period && Number(svg.dataset.klineCount) === count);
    }, { period, count });
    assert.equal(await candles().count(), count);
  }
  async function changePeriod(period, count) {
    const provider = ({ 5: 'm5', 30: 'm30', 101: 'day', 102: 'week', 103: 'month' })[period];
    const response = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.hostname.endsWith('gtimg.cn') && url.searchParams.get('param')?.split(',')[1] === provider;
    });
    await page.locator(periodSelector).selectOption(period);
    await response;
    await ready(period, count);
    await page.getByRole('button', { name: '查询', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查询', exact: true }).isEnabled(), true);
  }
  async function assertMinuteTimes(period) {
    const times = await candles().evaluateAll(elements => elements.map(element => element.dataset.klineTime));
    assert.equal(new Set(times).size, times.length, 'minute candles must have unique complete date+time keys');
    assert.ok(times.every(time => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)), `period ${period} time format`);
    const texts = await chart().locator('text').allTextContents();
    assert.ok(texts.some(text => /\d{2}-\d{2}.*\d{2}:\d{2}/.test(text)), 'minute x axis and header retain hours and minutes');
    assert.ok(texts.every(text => !/undefined|Invalid Date|NaN/.test(text)), 'chart labels contain valid values');
    const box = await chart().boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.25);
    const hoverTexts = await chart().locator('text').allTextContents();
    assert.ok(hoverTexts.some(text => /\d{2}:\d{2}.*开 .*高 .*低 .*收 /.test(text)), 'hover header retains HH:mm');
    assert.ok(hoverTexts.some(text => /^\d{4}\/\d{2}\/\d{2} 周. \d{2}:\d{2}$/.test(text)), 'crosshair date label retains HH:mm');
    await page.mouse.move(1, 1);
    record(`minute ${period} unique times, axis, hover, crosshair`, { bars: times.length });
  }
  await page.goto(`${base}__minute-check`);
  await ready('101', 80);
  assert.deepEqual(await page.locator(periodSelector).locator('option').evaluateAll(options => options.map(option => option.value)), ['5', '30', '240', '101', '102', '103']);
  record('A-share exposes 5 and 30 minute and 4h options alongside daily, weekly, monthly');

  let start = requests.length;
  await changePeriod('5', 80);
  assert.ok(requests.slice(start).some(request => request.type === 'm5' && request.path.endsWith('/mkline')), 'period change must auto-request actual 5-minute data');
  assert.ok(requests.slice(start).filter(request => request.type === 'm5').length >= 2, 'minute history is paginated');
  await assertMinuteTimes('5');
  assert.equal(await candles().last().getAttribute('data-kline-complete'), 'false', '10:05 candle at 10:03 remains open');
  assert.equal(await candles().nth(78).getAttribute('data-kline-complete'), 'true', 'earlier same-period candle is complete');
  record('5-minute completion flags distinguish the in-progress final candle');
  const dailyChange = page.locator('.quote-metric').filter({ hasText: '当日涨跌幅' });
  assert.ok((await dailyChange.innerText()).includes('3.58%'), 'side panel uses Tencent daily quote change');
  const quoteTexts = await chart().locator('text').allTextContents();
  assert.ok(quoteTexts.some(text => text.startsWith('本根涨跌 ')), 'chart labels local candle-to-candle change separately');
  assert.ok(quoteTexts.filter(text => text.startsWith('成交量 ')).every(text => !/换手 0(?:\.0+)?%/.test(text)), 'missing minute turnover is not fabricated as zero');
  const turnoverButton = page.getByTitle('近期换手率走势', { exact: true });
  await turnoverButton.click();
  assert.ok((await turnoverButton.locator('..').innerText()).includes('0.03%'), 'minute turnover uses 100000 / dailyVolume 10000000 × dailyRate 2.5%, rather than the final minute volume');
  await turnoverButton.click();
  record('daily quote percentage and per-bar change labels remain distinct; turnover uses daily cumulative volume');
  const max = Number((await page.locator(countSelector).locator('option').evaluateAll(options => options.map(option => option.value))).at(-1));
  assert.equal(max, 1320, 'more than 500/800 minute bars remain viewable');
  await page.locator(countSelector).selectOption('1320');
  await ready('5', 1320);
  await page.screenshot({ path: `${out}/1320-minute-candles.png`, fullPage: true });
  await chart().evaluate(element => element.parentElement.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })));
  await ready('5', 1200);
  await chart().evaluate(element => element.parentElement.parentElement.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })));
  await ready('5', 1320);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await ready('5', 1320);
  await page.getByRole('button', { name: '退出全屏', exact: true }).last().click();
  await ready('5', 1320);
  record('1320 actual bars, wheel directions, and fullscreen preserve relaxed display limits');

  // Compare adjacent candles around the ex-right boundary through the rendered
  // hover prices. This detects a false 100 -> 71 gap without reading internals.
  const times = await candles().evaluateAll(elements => elements.map(element => element.dataset.klineTime));
  const boundary = times.findIndex(time => time.startsWith(exDate));
  assert.ok(boundary > 0, 'fixture includes candles before and after ex-rights');
  async function hoverClose(index) {
    await chart().evaluate((svg, index) => {
      const line = svg.querySelectorAll('g[data-kline-time]')[index].querySelector('line');
      const point = svg.createSVGPoint();
      point.x = Number(line.getAttribute('x1'));
      point.y = Number(line.getAttribute('y1'));
      const screen = point.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: screen.x, clientY: screen.y, bubbles: true }));
    }, index);
    const header = (await chart().locator('text').allTextContents()).find(text => / 开 .* 高 .* 低 .* 收 /.test(text));
    assert.ok(header, 'rendered candle header exists');
    const close = Number(header.match(/ 收 ([\d.]+)/)[1]);
    assert.ok(Number.isFinite(close));
    return close;
  }
  const before = await hoverClose(boundary - 1);
  const after = await hoverClose(boundary);
  assert.ok(Math.abs(after - before) < 1, `ex-right adjustment removes synthetic jump: ${before} -> ${after}`);
  await page.mouse.move(1, 1);
  record('cash plus share ex-right event is adjusted continuously in actual rendered candles', { before, after });

  // The selected viewport does not define indicator history. Check displayed
  // values at the exact same latest candle, including a 20-bar viewport shorter
  // than both MA120 and BBI's slowest 24-bar component.
  const expectedCloses = minuteFixtures.m5.map(bar => {
    const date = `${bar[0].slice(0, 4)}-${bar[0].slice(4, 6)}-${bar[0].slice(6, 8)}`;
    return date < exDate ? (Number(bar[2]) - cash) / shareFactor : Number(bar[2]);
  });
  const lastMean = size => expectedCloses.slice(-size).reduce((sum, value) => sum + value, 0) / size;
  const expectedMA120 = lastMean(120).toFixed(2);
  const expectedBBI = ([3, 6, 12, 24].map(lastMean).reduce((sum, value) => sum + value, 0) / 4).toFixed(2);
  const latestFixture = minuteFixtures.m5.at(-1)[0];
  const latestKey = `${latestFixture.slice(0, 4)}-${latestFixture.slice(4, 6)}-${latestFixture.slice(6, 8)} ${latestFixture.slice(8, 10)}:${latestFixture.slice(10, 12)}`;
  const averagesByViewport = [];
  for (const count of [20, 80, 1320]) {
    await page.locator(countSelector).selectOption(String(count));
    await ready('5', count);
    // A dense 1320-bar chart has subpixel candle centers; synthetic MouseEvent
    // clientX rounds to an integer and can select a neighboring candle. Real
    // pointer entry/exit restores the chart's documented latest-candle header.
    await chart().hover({ position: { x: 120, y: 100 } });
    await page.mouse.move(1, 1);
    const texts = await chart().locator('text').allTextContents();
    const header = texts.find(text => / 开 .* 高 .* 低 .* 收 /.test(text));
    assert.ok(header?.includes(latestKey), `viewport ${count} compares the same latest candle ${latestKey}`);
    const ma120 = texts.find(text => /^MA120 [\d.]+$/.test(text))?.slice('MA120 '.length);
    const bbi = texts.find(text => /^BBI [\d.]+$/.test(text))?.slice('BBI '.length);
    assert.equal(ma120, expectedMA120, `viewport ${count} MA120 uses the last 120 source candles`);
    assert.equal(bbi, expectedBBI, `viewport ${count} BBI uses full 3/6/12/24-candle histories`);
    averagesByViewport.push({ count, time: latestKey, ma120, bbi });
  }
  assert.equal(new Set(averagesByViewport.map(({ ma120, bbi }) => `${ma120}/${bbi}`)).size, 1, 'latest MA120 and BBI remain unchanged across viewports');
  await page.mouse.move(1, 1);
  record('latest MA120 and BBI match independent source averages at 20, 80, and 1320 visible candles', { expectedMA120, expectedBBI, averagesByViewport });

  await page.locator(countSelector).selectOption('80');
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母').fill('603269');
  start = requests.length;
  await changePeriod('30', 80);
  assert.ok(requests.slice(start).some(request => request.type === 'm30' && request.path.endsWith('/mkline')));
  assert.ok(requests.slice(start).filter(request => request.type === 'm30').every(request => request.symbol === 'sh603268'), 'period change stays on the loaded stock while the search box contains an unsubmitted different code');
  record('period change uses the loaded symbol instead of unsubmitted search text');
  await assertMinuteTimes('30');
  assert.equal(await candles().last().getAttribute('data-kline-complete'), 'false', '10:30 candle at 10:03 remains open');
  record('30-minute auto fetch and in-progress final candle');
  for (const [period, provider] of [['101', 'day'], ['102', 'week'], ['103', 'month']]) {
    start = requests.length;
    await changePeriod(period, Math.min(80, dailyBars(provider).length));
    assert.ok(requests.slice(start).some(request => request.type === provider), `switch back to ${provider} requests correct source period`);
    record(`minute to ${provider} uses correct period`);
  }
  await page.locator(countSelector).selectOption('30');
  await ready('103', 30);
  await changePeriod('5', 30);
  await page.getByRole('button', { name: /^科创50，/ }).click();
  await ready('5', 30);
  await page.waitForFunction(() => document.body.textContent.includes('当前指数'));
  assert.ok(requests.some(request => request.symbol === 'sh000688' && request.type === 'm5' && request.path.endsWith('/mkline')), 'index 5-minute data must use minute endpoint');
  await changePeriod('30', 30);
  assert.ok(requests.some(request => request.symbol === 'sh000688' && request.type === 'm30' && request.path.endsWith('/mkline')), 'index 30-minute data must use minute endpoint');
  record('STAR50 index uses genuine minute endpoints for both periods');

  // Hold a real provider response, switch periods, then release it. A request
  // settling later must not replace the user's newer period/data selection.
  prepareHeldRequest();
  await page.locator(periodSelector).selectOption('5');
  let heldTimeout;
  try {
    await Promise.race([heldStarted, new Promise((_, reject) => { heldTimeout = setTimeout(() => reject(new Error('5-minute provider request was not started')), 15000); })]);
  } finally { clearTimeout(heldTimeout); }
  await changePeriod('30', 30);
  const releasedResponse = page.waitForResponse(response => response.url().includes('param=') && decodeURIComponent(response.url()).includes('sh000688,m5,'));
  releaseHeld();
  await releasedResponse;
  await page.waitForLoadState('networkidle');
  await ready('30', 30);
  assert.equal(await page.locator(periodSelector).inputValue(), '30');
  record('slow 5-minute response cannot overwrite a newer 30-minute selection');

  for (const market of ['港股', '美股']) {
    await page.getByRole('button', { name: market, exact: true }).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.value === '101', periodSelector);
    const options = await page.locator(periodSelector).locator('option').evaluateAll(elements => elements.map(element => element.value));
    assert.deepEqual(options, ['101', '102', '103']);
    assert.ok(requests.filter(request => request.market).every(request => ['101', '102', '103'].includes(request.type)), 'foreign-market request never receives A-share minute period');
    record(`${market} hides minute options and resets unsupported period to daily`);
    if (market === '港股') {
      await page.getByRole('button', { name: 'A股', exact: true }).click();
      await page.waitForFunction(selector => document.querySelector(selector)?.querySelector('option[value="30"]'), periodSelector);
      await changePeriod('30', 30);
    }
  }
  await page.getByRole('button', { name: 'A股', exact: true }).click();
  await ready('101', 30);
  fixtureFailure = 'daily-in-minute';
  await page.locator(periodSelector).selectOption('5');
  await page.getByText(/腾讯没有返回 5 分钟 K 线/).first().waitFor();
  assert.equal(await page.locator('svg[data-kline-period]').count(), 0, 'a daily provider payload never renders as a minute chart');
  record('daily data returned to a minute request produces an explicit error and no fake minute chart');
  fixtureFailure = '';
  await changePeriod('101', 30);
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母').fill('603268');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByText('验收sh603268', { exact: true }).first().waitFor();
  await ready('101', 30);
  fixtureFailure = 'invalid-qfq';
  await page.locator(periodSelector).selectOption('5');
  await page.getByText(/不满足一致的除权变换/).first().waitFor();
  assert.equal(await page.locator('svg[data-kline-period]').count(), 0, 'failed daily OHLC verification never renders unverified adjusted minute prices');
  record('inconsistent raw and adjusted OHLC produces an explicit error and no unverified minute chart');
  fixtureFailure = '';
  await changePeriod('30', 30);
  record('valid minute data recovers after the provider or adjustment error is corrected');
  assert.deepEqual(errors, []);
  assert.deepEqual(routeErrors, []);
  await page.screenshot({ path: `${out}/final.png`, fullPage: true });
  await writeFile(`${out}/result.json`, JSON.stringify({ ok: true, results, errors, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: results.length, results, output: out }, null, 2));
} catch (error) {
  if (releaseHeld) releaseHeld();
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  }
  await writeFile(`${out}/failure.json`, JSON.stringify({ error: error.stack, errors, routeErrors, requests, results }, null, 2));
  console.error(error.stack);
  console.error(JSON.stringify({ output: out, errors, routeErrors, results }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
