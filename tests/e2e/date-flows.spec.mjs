import { test, expect, control, login, requests } from './support.mjs';
import { FIXTURE_DAY } from './fixtures.mjs';
import { heatmapTilesReady, heatmapCaptionReady } from './pages.mjs';
import { writeFile } from 'node:fs/promises';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const historyPath = '/api/market-heatmap';
const tile = page => page.locator('div.absolute.cursor-pointer').filter({ hasText: '半导体' }).first();
const indexCards = page => page.locator('[data-index-trend-card]');
const indexCodes = ['000001', '000688', '399001', '399006'];
const indexProviderPath = '/__audit/remote/web.ifzq.gtimg.cn/appstock/app/kline/kline';
const indexHistoryProviderPath = '/__audit/remote/push2delay.eastmoney.com/api/qt/stock/kline/get';

async function openHeatmap(page) {
  await login(page);
  await button(page, '趋势大盘').click();
  await button(page, '热力图').click();
  await expect(tile(page)).toBeVisible();
  await expect(button(page, '刷新')).toBeEnabled();
}

async function selectHistory(page, { start, end = start, mode = 'range' }) {
  await page.getByRole('combobox', { name: '热力图时间模式', exact: true }).selectOption(mode);
  await page.getByLabel('开始日期', { exact: true }).fill(start);
  if (mode === 'range') await page.getByLabel('结束日期', { exact: true }).fill(end);
  await button(page, '查询').click();
}

async function historyReady(page, { start, end = start, days, firstDate = start, lastDate = end }) {
  await expect(tile(page)).toBeVisible();
  await expect(page.getByText(/热力图加载中/)).toHaveCount(0);
  await expect(page.getByText(`${start} 至 ${end} · 面积为累计成交额，颜色为区间涨跌幅。休市日不补行情。`, { exact: false })).toBeVisible();
  await expect(page.getByText('同花顺行业历史日线 · 4 个行业', { exact: true })).toBeVisible();
  await expect(page.getByText('悬浮查看行业区间数据', { exact: true })).toBeVisible();
  await expect(button(page, '个股')).toHaveCount(0);
  await expect(button(page, '流通市值')).toHaveCount(0);
  await tile(page).hover();
  await expect(page.getByText(`${firstDate} 至 ${lastDate} · ${days} 个交易日`, { exact: true })).toBeVisible();
}

async function historyRequests(request, start, end = start) {
  return (await requests(request, historyPath)).filter(item => item.query.start === start && item.query.end === end);
}

const completed = calls => calls.filter(item => item.completedAt && !item.aborted);

function expectHistoryPoll(calls) {
  // StrictMode may deliver its cancelled initial request before cancellation
  // reaches the server. Both initial requests must share the same loading job.
  const initial = calls.filter(item => item.query.retry === '1');
  const polls = calls.filter(item => !item.query.retry);
  expect(initial.length).toBeGreaterThanOrEqual(1);
  expect(initial.length).toBeLessThanOrEqual(2);
  expect(polls).toHaveLength(1);
  expect(Date.parse(polls[0].time) - Date.parse(initial.at(-1).time)).toBeGreaterThanOrEqual(1100);
}

async function trendReady(page, { year = 'latest', ma = 60, count }) {
  await expect(indexCards(page)).toHaveCount(4);
  for (const code of indexCodes) {
    const card = page.locator(`[data-index-trend-card="${code}"]`);
    const chart = card.locator('svg[data-index-trend-chart]');
    const candles = chart.locator('[data-index-candle]');
    await expect(chart).toBeVisible();
    await expect.poll(() => candles.count()).toBeGreaterThan(1);
    if (count) await expect(candles).toHaveCount(count);
    await expect(chart.locator('tspan').filter({ hasText: new RegExp(`^MA${ma}：[0-9]+\\.[0-9]{2}`) })).toBeVisible();
    // A vertical SVG line has a zero-width bounding box despite a visible
    // stroke, so assert nonzero rendered bar lengths inside the visible SVG.
    await expect.poll(() => chart.locator('[data-index-macd]').evaluateAll(lines =>
      lines.some(line => Math.abs(Number(line.getAttribute('y2')) - Number(line.getAttribute('y1'))) > .1))).toBe(true);
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.getByText('加载中…', { exact: true })).toHaveCount(0);
    const dates = await candles.evaluateAll(elements => elements.map(element => element.getAttribute('data-index-candle')));
    if (year === 'latest') expect(dates.at(-1)).toBe(FIXTURE_DAY);
    else {
      expect(dates.every(date => date.startsWith(`${year}-`))).toBe(true);
      expect(dates.at(-1)).toBe(`${year}-12-31`);
    }
    await expect(card.getByText(new RegExp(`缠论计算：全部已加载 \\d+ 根日K · 截至 ${dates.at(-1)}`))).toBeVisible();
  }
}

test.beforeEach(async ({ request }) => control(request, { reset: true }));
test.afterEach(async ({ request }, testInfo) => {
  const path = testInfo.outputPath('date-flow-requests.json');
  await writeFile(path, JSON.stringify(await requests(request), null, 2));
  await testInfo.attach('date-flow-requests.json', {
    path, contentType: 'application/json',
  });
});

test('热力图指定日期与区间走历史进度轮询，悬浮信息对应所选交易日', async ({ page, request }, testInfo) => {
  await openHeatmap(page);
  await selectHistory(page, { mode: 'day', start: '2026-10-12' });
  await expect(page.getByText('已处理 0 / 4，首次加载需请求外部接口', { exact: true })).toBeVisible();
  await expect(tile(page)).toHaveCount(0);
  await historyReady(page, { start: '2026-10-12', days: 1 });
  await page.setViewportSize({ width: 390, height: 1000 });
  await heatmapTilesReady(page);
  await heatmapCaptionReady(page);
  await expect(tile(page)).toContainText('+1.27%');
  expectHistoryPoll(await historyRequests(request, '2026-10-12'));
  await page.screenshot({ path: testInfo.outputPath('heatmap-selected-day.png'), fullPage: true });
  // THS explicitly disallows historical component drilldown.
  await tile(page).click();
  await expect(button(page, '← 返回全市场')).toHaveCount(0);
  expect((await requests(request, historyPath)).filter(item => item.query.board)).toHaveLength(0);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await selectHistory(page, { start: '2026-10-12', end: '2026-10-16' });
  await expect(page.getByText('已处理 0 / 4，首次加载需请求外部接口', { exact: true })).toBeVisible();
  await historyReady(page, { start: '2026-10-12', end: '2026-10-16', days: 5 });
  await expect(tile(page)).not.toContainText('+1.27%');
  expectHistoryPoll(await historyRequests(request, '2026-10-12', '2026-10-16'));
  await page.screenshot({ path: testInfo.outputPath('heatmap-selected-range.png'), fullPage: true });

  await page.getByRole('combobox', { name: '热力图时间模式', exact: true }).selectOption('latest');
  await button(page, '查询').click();
  await expect(tile(page)).toContainText('+2.00%');
  await expect(button(page, '个股')).toBeVisible();
  await expect(button(page, '流通市值')).toBeVisible();
  await expect(button(page, '刷新')).toBeEnabled();
});

test('热力图六个常用日期使用固定北京时间并完成对应区间查询', async ({ page, request }) => {
  await openHeatmap(page);
  for (const [label, start, days, firstDate] of [
    ['近3天', '2026-10-19', 3, '2026-10-19'],
    ['近一周', '2026-10-15', 5, '2026-10-15'],
    ['近一月', '2026-09-22', 22, '2026-09-22'],
    ['近三月', '2026-07-24', 64, '2026-07-24'],
    ['近半年', '2026-04-25', 128, '2026-04-27'],
    ['今年以来', '2026-01-01', 210, '2026-01-01'],
  ]) {
    await button(page, label).click();
    await expect(button(page, label)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('combobox', { name: '热力图时间模式', exact: true })).toHaveValue('range');
    await expect(page.getByLabel('开始日期', { exact: true })).toHaveValue(start);
    await expect(page.getByLabel('结束日期', { exact: true })).toHaveValue(FIXTURE_DAY);
    await historyReady(page, { start, end: FIXTURE_DAY, days, firstDate });
    expectHistoryPoll(await historyRequests(request, start, FIXTURE_DAY));
  }
});

test('热力图区间超过366天不发请求，合法休市日显示空结果并可重新选日', async ({ page, request }) => {
  await openHeatmap(page);
  const before = (await requests(request, historyPath)).length;
  await selectHistory(page, { start: '2025-01-01', end: FIXTURE_DAY });
  await expect(page.getByText('请选择有效日期，结束不晚于今天，区间不超过366天。', { exact: true })).toBeVisible();
  expect(await requests(request, historyPath)).toHaveLength(before);
  await expect(tile(page)).toContainText('+2.00%');
  await selectHistory(page, { mode: 'day', start: '2026-10-17' });
  await expect(page.getByText('所选区间没有可展示的历史行情（休市、尚未上市或数据缺失），请更换日期。', { exact: true })).toBeVisible();
  await expect(page.getByText('4 个行业在所选区间无日线。', { exact: true })).toBeVisible();
  await expect(tile(page)).toHaveCount(0);
  await selectHistory(page, { mode: 'day', start: '2026-10-16' });
  await historyReady(page, { start: '2026-10-16', days: 1 });
});

test('热力图历史接口失败显示原因，重试重新走进度并恢复所选日期', async ({ page, request, audit }) => {
  await openHeatmap(page);
  audit.allowedHttp.push({ path: historyPath, status: 503 });
  await control(request, { failPaths: { [historyPath]: { status: 503, body: { error: '合成历史接口暂不可用，未提供历史结果' } } } });
  await selectHistory(page, { mode: 'day', start: '2026-10-13' });
  await expect(page.getByText('合成历史接口暂不可用，未提供历史结果', { exact: true })).toBeVisible();
  await expect(tile(page)).toHaveCount(0);
  await control(request, { failPaths: {} });
  await button(page, '重试').click();
  await expect(page.getByText('已处理 0 / 4，首次加载需请求外部接口', { exact: true })).toBeVisible();
  await historyReady(page, { start: '2026-10-13', days: 1 });
  const calls = completed(await historyRequests(request, '2026-10-13'));
  expect(calls.filter(item => item.status === 503).length).toBeGreaterThanOrEqual(1);
  expect(calls.filter(item => item.status !== 503).map(item => item.status)).toEqual([200, 200]);
  expectHistoryPoll(calls.filter(item => item.status === 200));
});

test('热力图快速改日期取消旧查询，迟到响应及旧轮询不覆盖新区间', async ({ page, request }) => {
  await openHeatmap(page);
  await control(request, { routeRules: [{ path: historyPath, search: { start: '2026-10-01' }, hold: 'old-history' }] });
  await selectHistory(page, { start: '2026-10-01', end: '2026-10-09' });
  await expect.poll(async () => (await historyRequests(request, '2026-10-01', '2026-10-09')).length).toBeGreaterThan(0);
  const oldCount = (await historyRequests(request, '2026-10-01', '2026-10-09')).length;
  await selectHistory(page, { start: '2026-10-12', end: '2026-10-16' });
  await historyReady(page, { start: '2026-10-12', end: '2026-10-16', days: 5 });
  await expect.poll(async () => (await historyRequests(request, '2026-10-01', '2026-10-09')).every(item => item.aborted)).toBe(true);
  await control(request, { routeRules: [], release: 'old-history' });
  expect(await historyRequests(request, '2026-10-01', '2026-10-09')).toHaveLength(oldCount);
  await expect(page.getByText('2026-10-01 至 2026-10-09 · 面积为累计成交额', { exact: false })).toHaveCount(0);
  await historyReady(page, { start: '2026-10-12', end: '2026-10-16', days: 5 });
});

test('四大指数年份和中长期/中短期切换更新窗口、MA周期与截至日期', async ({ page, request }, testInfo) => {
  await login(page);
  await button(page, '趋势大盘').click();
  await button(page, '中长期多头趋势').click();
  await trendReady(page, { count: 250 });
  await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('2024');
  await trendReady(page, { year: '2024', count: 261 });
  await page.screenshot({ path: testInfo.outputPath('indices-2024-long.png'), fullPage: true });
  await button(page, '中短期多头趋势').click();
  await expect(page.getByRole('combobox', { name: '年份', exact: true })).toHaveValue('2024');
  await trendReady(page, { year: '2024', ma: 20, count: 261 });
  await page.screenshot({ path: testInfo.outputPath('indices-2024-short.png'), fullPage: true });
  await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('2025');
  await trendReady(page, { year: '2025', ma: 20, count: 261 });
  await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('latest');
  await trendReady(page, { ma: 20, count: 140 });
  await button(page, '中长期多头趋势').click();
  await trendReady(page, { count: 250 });
  const calls = await requests(request, indexProviderPath);
  for (const symbol of ['sh000001', 'sh000688', 'sz399001', 'sz399006']) {
    expect(calls.some(item => item.query.param === `${symbol},day,,,780`)).toBe(true);
  }
  const historyCalls = await requests(request, indexHistoryProviderPath);
  for (const secid of ['1.000001', '1.000688', '0.399001', '0.399006']) {
    expect(historyCalls.some(item => item.query.secid === secid && item.query.lmt === '1040' && item.query.klt === '101')).toBe(true);
  }
});

test('指数历史年份慢响应晚到后，最新短期窗口仍保持正确日期和MA20', async ({ page, request }) => {
  await login(page);
  await button(page, '趋势大盘').click();
  await button(page, '中长期多头趋势').click();
  await trendReady(page, { count: 250 });
  await control(request, { routeRules: [{ path: indexHistoryProviderPath, search: { secid: '1.000001', lmt: '1040' }, hold: 'old-index-year' }] });
  await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('2024');
  await expect.poll(async () => (await requests(request, indexHistoryProviderPath)).filter(item => item.held === 'old-index-year').length).toBe(1);
  await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('latest');
  await button(page, '中短期多头趋势').click();
  await trendReady(page, { ma: 20, count: 140 });
  await control(request, { routeRules: [], release: 'old-index-year' });
  await expect.poll(async () => (await requests(request, indexHistoryProviderPath)).filter(item => item.held === 'old-index-year' && item.completedAt).length).toBe(1);
  await trendReady(page, { ma: 20, count: 140 });
  await expect(page.getByRole('combobox', { name: '年份', exact: true })).toHaveValue('latest');
});
