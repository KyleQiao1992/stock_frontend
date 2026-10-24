import { test, expect, control, login, requests } from './support.mjs';
import { chartReady } from './pages.mjs';
import config from '../../playwright.config.mjs';
import { writeFile } from 'node:fs/promises';

// Playwright's headless default hides scrollbars altogether. This regression
// needs the traditional scrollbar layout used in the reported desktop browser.
test.use({ launchOptions: { ...config.use.launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] } });

const financePath = '/api/ashare-finance';
const chart = page => page.locator('svg[data-kline-count]').first();
const scroller = page => page.locator('[class~="xl:overflow-y-auto"]')
  .filter({ has: page.locator('svg[data-kline-count]') });
const analysis = page => page.locator('section[aria-label="个股分析"]');

async function attachJson(testInfo, name, data) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function classicScrollbar(page) {
  // This represents the user's non-overlay system scrollbar setting. It does
  // not alter the App's overflow, size, or responsive layout rules.
  await page.addStyleTag({ content: '*::-webkit-scrollbar { width: 17px; height: 17px; }' });
  const width = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-1000px;top:0;width:100px;height:100px;overflow:scroll;';
    document.body.append(probe);
    const occupied = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return occupied;
  });
  expect(width, '环境必须实际分配17px滚动条，悬浮滚动条不能覆盖此回归').toBe(17);
}

async function frames(page, count = 120) {
  return scroller(page).evaluate(async (host, frameCount) => {
    const original = host.querySelector('svg[data-kline-count]');
    const samples = [];
    // A viewport/tab change may legitimately resize once. Collect only after
    // the browser has had eight frames to deliver that ResizeObserver update.
    for (let index = -8; index < frameCount; index += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (index < 0) continue;
      const svg = host.querySelector('svg[data-kline-count]');
      const box = svg.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      samples.push({
        frame: index,
        sameNode: svg === original,
        viewBox: svg.getAttribute('viewBox'),
        svgWidth: box.width,
        svgHeight: box.height,
        hostWidth: hostBox.width,
        clientWidth: host.clientWidth,
        clientHeight: host.clientHeight,
        scrollHeight: host.scrollHeight,
        scrollTop: host.scrollTop,
        scrollbarGutter: style.scrollbarGutter,
        gutter: host.offsetWidth - host.clientWidth
          - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      });
    }
    return samples;
  }, count);
}

async function assertStable(page, testInfo, label) {
  await page.mouse.move(0, 0);
  const samples = await frames(page);
  const dimensions = [...new Set(samples.map(sample => JSON.stringify([
    sample.viewBox, sample.svgWidth, sample.svgHeight,
    sample.hostWidth, sample.clientWidth, sample.clientHeight,
  ])))];
  const transitions = samples.slice(1).filter((sample, index) =>
    sample.viewBox !== samples[index].viewBox || sample.clientWidth !== samples[index].clientWidth).length;
  await attachJson(testInfo, `${label}-120-frames.json`, { dimensions, transitions, samples });
  const screenshot = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(`${label}.png`, { path: screenshot, contentType: 'image/png' });
  expect(samples.every(sample => sample.sameNode), '静置时主图SVG不得被替换').toBe(true);
  expect(transitions, '鼠标移出后尺寸不得在两种宽高之间连续振荡').toBe(0);
  expect(dimensions, '合法单次resize完成后120帧应保持一种尺寸').toHaveLength(1);
  return samples;
}

async function thresholdViewport(page, testInfo) {
  await page.setViewportSize({ width: 1920, height: 1600 });
  await page.evaluate(() => document.fonts.ready);
  await frames(page, 3);
  const natural = await scroller(page).evaluate(host => {
    const svg = host.querySelector('svg[data-kline-count]');
    return { total: host.scrollHeight, clientHeight: host.clientHeight,
      width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height };
  });
  expect(natural.clientHeight, '校准时中列须完整展开，不能拿已截断高度作为自然高度').toBe(natural.total);
  expect(natural.width).toBeGreaterThan(835);
  expect(natural.height).toBeGreaterThan(600);
  // The original 864px SVG becomes 12px shorter when a 17px gutter appears.
  // Place max-height inside that interval: viewport - 32 = T - 6. Reserving
  // the gutter keeps the chart width fixed even at this overflow threshold.
  const viewportHeight = natural.total - 6 + 32;
  await attachJson(testInfo, 'threshold-calibration.json', {
    natural, viewportHeight, maximumHeight: viewportHeight - 32,
  });
  await page.setViewportSize({ width: 1920, height: viewportHeight });
}

async function failFinance(request, audit) {
  audit.allowedHttp.push({ path: financePath, status: 503 });
  await control(request, { routeRules: [{ path: financePath, method: 'GET',
    status: 503, body: { error: 'fetch failed' } }] });
}

test.beforeEach(async ({ page, request }) => {
  await control(request, { reset: true });
  await page.setViewportSize({ width: 1920, height: 1600 });
});

test('财报短错误接近独立滚动阈值时，鼠标移出后主图120帧不振荡', async ({ page, request, audit }, testInfo) => {
  await failFinance(request, audit);
  await login(page);
  await classicScrollbar(page);
  await chartReady(page);
  await expect(page.locator('.chart-panel-header').first()).toContainText('600851');
  await expect(analysis(page).getByText('fetch failed', { exact: true })).toBeVisible();
  await thresholdViewport(page, testInfo);
  const samples = await assertStable(page, testInfo, 'short-finance');
  expect(samples.some(sample => sample.gutter === 17), '中列须实际保留17px滚动条占位').toBe(true);
  const finance = await requests(request, financePath);
  expect(finance.filter(item => item.status === 503 && item.completedAt)).toHaveLength(1);
});

test('长财报可在中列真正滚动，切换资讯及短财报错误后尺寸仍稳定', async ({ page, request, audit }, testInfo) => {
  await login(page);
  await classicScrollbar(page);
  await chartReady(page);
  await expect(analysis(page).getByRole('table')).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 900 });
  await assertStable(page, testInfo, 'long-finance');
  const host = scroller(page);
  expect(await host.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const lastMetric = analysis(page).getByRole('cell', { name: '净利率', exact: true });
  await lastMetric.scrollIntoViewIfNeeded();
  expect(await host.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const inside = await lastMetric.evaluate(element => {
    const host = element.closest('[class~="xl:overflow-y-auto"]');
    const row = element.getBoundingClientRect(), viewport = host.getBoundingClientRect();
    return row.top >= viewport.top && row.bottom <= viewport.top + host.clientHeight;
  });
  expect(inside, '分析正文必须进入独立滚动区的可见窗口').toBe(true);
  await analysis(page).getByRole('tab', { name: '资讯', exact: true }).click();
  await expect(analysis(page).getByRole('tabpanel', { name: '新闻', exact: true }).getByRole('link').first()).toBeVisible();
  await assertStable(page, testInfo, 'news');
  await failFinance(request, audit);
  await page.locator('.market-query-controls').getByRole('button', { name: '查询', exact: true }).click();
  await chartReady(page);
  await analysis(page).getByRole('tab', { name: '财报', exact: true }).click();
  await expect(analysis(page).getByText('fetch failed', { exact: true })).toBeVisible();
  await thresholdViewport(page, testInfo);
  await assertStable(page, testInfo, 'returned-short-finance');
  await expect(chart(page)).toHaveAttribute('data-kline-period', '101');
});
