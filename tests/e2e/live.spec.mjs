import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from 'playwright/test';
import { attachBrowserAudit, startBrowserAudit } from './browserAudit.mjs';

// This suite drives the complete App against the real local server. It never
// intercepts routes, fabricates API responses, reads tokens, or exports state.
const LIVE_ORIGIN = 'http://localhost:5173';
const storageFile = process.env.E2E_LIVE_STORAGE_STATE;
if (!storageFile) {
  throw new Error('真实 E2E 必须提供 E2E_LIVE_STORAGE_STATE；缺少真实登录状态不能跳过或计为通过。');
}
try {
  if (!statSync(resolve(storageFile)).isFile()) throw new Error('not a file');
} catch {
  throw new Error('E2E_LIVE_STORAGE_STATE 必须指向外部提供的有效状态文件；测试不会自动创建账号或提取登录凭证。');
}

test.use({ baseURL: LIVE_ORIGIN, trace: 'off', video: 'off' });
test.describe.configure({ timeout: 300_000 });

const CHART_TIMEOUT = 90_000;
const DATA_TIMEOUT = 45_000;
const MARKETS = [
  { title: 'A股', key: 'ashare', code: '600851', placeholder: '代码 / 简称 / 拼音首字母', pattern: /^\d{6}$/ },
  { title: '港股', key: 'hk', code: '00700', placeholder: '代码 / 简称 / 拼音', pattern: /^\d{5}$/ },
  { title: '美股', key: 'us', code: 'MSFT', placeholder: '如 AAPL', pattern: /^[A-Z][A-Z0-9.-]{0,11}$/ },
];
const diagnostics = new WeakMap();

function queryButton(page) {
  return page.locator('.market-query-controls').getByRole('button', { name: '查询', exact: true });
}

function tickerInput(page, market) {
  return page.getByPlaceholder(market.placeholder, { exact: true });
}

const klinePaths = market => market.key === 'ashare' ? [
  '/ifzqgtimg/appstock/app/fqkline/get', '/appstock/app/fqkline/get',
  '/ifzqgtimg/appstock/app/kline/kline', '/appstock/app/kline/kline', '/api/qt/stock/kline/get',
] : [`/api/${market.key}-kline`];

function quotePanel(page) {
  return page.getByText('当前标的', { exact: true }).locator('..');
}

async function noRenderFailure(page) {
  await expect(page.getByText('页面遇到异常', { exact: true })).toHaveCount(0);
  await expect(page.getByText('因子研究页面加载异常', { exact: true })).toHaveCount(0);
}

async function chartReady(page, period = '101') {
  const chart = page.locator('svg[data-kline-period]:visible').first();
  await expect(chart, '真实行情必须渲染图表，空白或错误提示不算就绪').toBeVisible({ timeout: CHART_TIMEOUT });
  await expect(chart).toHaveAttribute('data-kline-period', period, { timeout: CHART_TIMEOUT });
  await expect.poll(async () => Number(await chart.getAttribute('data-kline-count')), {
    timeout: CHART_TIMEOUT,
    message: '真实图表必须包含已加载的 K 线',
  }).toBeGreaterThan(0);
  await expect(chart.locator('g[data-kline-time]').first()).toBeVisible();
  await expect(queryButton(page)).toBeEnabled({ timeout: CHART_TIMEOUT });
  await expect(chart).not.toContainText(/\bNaN\b|Invalid Date|undefined/);
  await noRenderFailure(page);
  return chart;
}

async function selectedStockReady(page, market, expectedCode) {
  const input = tickerInput(page, market);
  await expect(input).toHaveValue(expectedCode || market.pattern, { timeout: CHART_TIMEOUT });
  const code = expectedCode || await input.inputValue();
  const panel = quotePanel(page);
  await expect(panel.getByText(code, { exact: true }).first()).toBeVisible({ timeout: CHART_TIMEOUT });
  await expect.poll(async () => {
    const name = (await panel.locator('.text-2xl').first().innerText()).trim();
    return name.length > 0 && !['-', '—', code].includes(name);
  }, { timeout: CHART_TIMEOUT, message: '当前标的必须有真实名称，代码或占位符不能冒充名称' }).toBe(true);
  await chartReady(page, await page.getByRole('combobox', { name: 'K线周期', exact: true }).inputValue());
  return code;
}

async function openMarket(page, market) {
  await diagnostics.get(page).transition({
    name: 'market-switch', cancelPaths: ['/api/ashare-search', '/api/hk-search'],
    successPaths: klinePaths(market),
  }, async () => {
    await page.getByRole('button', { name: market.title, exact: true }).click();
    await expect(tickerInput(page, market)).toBeEditable();
    await selectedStockReady(page, market);
  });
}

async function search(page, market, code = market.code) {
  await openMarket(page, market);
  await expect(queryButton(page)).toBeEnabled({ timeout: CHART_TIMEOUT });
  await diagnostics.get(page).transition({
    name: 'stock-search', cancelPaths: ['/api/ashare-search', '/api/hk-search'],
    successPaths: klinePaths(market),
  }, async () => {
    await tickerInput(page, market).fill(code);
    await tickerInput(page, market).press('Enter');
    // A manual query keeps an old same-stock chart while its fresh request is
    // pending; the enabled query control also checks that request has settled.
    await expect(queryButton(page)).toBeEnabled({ timeout: CHART_TIMEOUT });
    await selectedStockReady(page, market, code);
  });
}

async function withDeadline(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}未在限定时间内结束`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nextJsonRequest(page, pathname, code) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === LIVE_ORIGIN && url.pathname === pathname
      && url.searchParams.get('code') === code && request.method() === 'GET';
  }, { timeout: CHART_TIMEOUT + DATA_TIMEOUT }).then(async (request) => {
    // Match a newly issued request, rather than accidentally accepting a
    // response from the page's initial load of the same stock.
    const response = await withDeadline(request.response(), DATA_TIMEOUT, pathname);
    expect(response !== null, `${pathname} 的真实请求必须收到响应`).toBe(true);
    expect(response.status(), `${pathname} 的真实响应必须成功`).toBe(200);
    return withDeadline(response.json(), DATA_TIMEOUT, `${pathname} JSON`);
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  diagnostics.set(page, startBrowserAudit(page, { origin: LIVE_ORIGIN }));
  testInfo.annotations.push({ type: 'backend', description: '真实 localhost:5173；无接口拦截；仅只读用户流程' });
  await diagnostics.get(page).transition({
    name: 'initial-authentication', cancelPaths: ['/api/auth/me'], successPaths: ['/api/auth/me'],
  }, () => diagnostics.get(page).transition({
    name: 'initial-factors', cancelPaths: ['/api/factors'], successPaths: ['/api/factors'],
  }, async () => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: '个人菜单', exact: true }),
      '真实登录状态必须完成验证；会话失效或认证接口挂起必须失败').toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.getByText('正在验证登录状态…', { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).origin).toBe(LIVE_ORIGIN);
    await noRenderFailure(page);
    await chartReady(page);
  }));
});

test.afterEach(async ({ page }, testInfo) => {
  const monitor = diagnostics.get(page);
  expect(monitor, '真实验收必须启用完整浏览器监控').toBeTruthy();
  const report = await monitor.stop();
  await attachBrowserAudit(testInfo, report);
  expect(report.issues, '真实验收不得出现 HTTP/传输失败、控制台错误、JS 异常、可见错误提示或业务写请求').toEqual([]);
  if (!page.isClosed()) await noRenderFailure(page);
});

test('真实首次进入 A 股、港股、美股，默认输入、名称、自选卡片和 K 线均就绪', async ({ page }) => {
  const selected = new Map();
  for (const market of MARKETS) {
    await test.step(market.title, async () => {
      await openMarket(page, market);
      await page.getByRole('button', { name: '自选', exact: true }).click();
      const code = await selectedStockReady(page, market);
      selected.set(market.key, code);
      const listInput = page.locator('textarea[placeholder^="例如"]');
      await expect(listInput).not.toHaveValue('', { timeout: CHART_TIMEOUT });
      await expect(page.getByRole('button', { name: '生成列表', exact: true })).toBeEnabled({ timeout: CHART_TIMEOUT });
      const codes = (await listInput.inputValue()).split(/[,，\s]+/).filter(Boolean);
      expect(codes.length).toBeGreaterThan(0);
      for (const item of codes) expect(item).toMatch(market.pattern);
      const cards = page.locator('div[role="button"][tabindex="0"]').filter({ has: page.locator('div.font-mono') });
      await expect(cards.first()).toBeVisible({ timeout: CHART_TIMEOUT });
      await expect(cards, '默认输入中的每个代码都必须有卡片，部分加载失败不能算完成').toHaveCount(new Set(codes).size);
      for (const card of await cards.all()) {
        const cardCode = (await card.locator('div.font-mono').innerText()).trim();
        const name = (await card.locator('div.mt-1.text-sm').innerText()).trim();
        expect(name, `${market.title}自选卡片应显示名称`).not.toMatch(/^名称加载中$|^[-—]$/);
        expect(name).not.toBe('');
        expect(name).not.toBe(cardCode);
      }
      await expect(page.getByText(/请先输入至少一个/)).toHaveCount(0);
      await expect(page.getByText(/^以下代码暂时未能加载名称：/)).toHaveCount(0);
    });
  }
  await openMarket(page, MARKETS[0]);
  await selectedStockReady(page, MARKETS[0], selected.get('ashare'));
});

test('真实代码搜索 600851 / 00700 / MSFT，输入、名称和图表对应同一标的', async ({ page }) => {
  await chartReady(page);
  for (const market of MARKETS) {
    await test.step(`${market.title} ${market.code}`, () => search(page, market));
  }
});

for (const market of MARKETS) {
  test(`${market.title}真实日 K、周 K、月 K 切换保持已选标的`, async ({ page }) => {
    await chartReady(page);
    await search(page, market);
    const period = page.getByRole('combobox', { name: 'K线周期', exact: true });
    for (const value of ['102', '103', '101']) {
      await period.selectOption(value);
      await chartReady(page, value);
      await selectedStockReady(page, market, market.code);
    }
  });
}

test('A 股真实 4 小时图切换港股时恢复日 K，不发送港股分钟周期', async ({ page }) => {
  await chartReady(page);
  await search(page, MARKETS[0]);
  const period = page.getByRole('combobox', { name: 'K线周期', exact: true });
  await period.selectOption('240');
  await chartReady(page, '240');
  const chart = page.locator('svg[data-kline-period="240"]:visible').first();
  await expect(chart.locator('g[data-kline-start][data-kline-end]').first()).toBeVisible();
  const foreignPeriods = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === LIVE_ORIGIN && url.pathname === '/api/hk-kline') foreignPeriods.push(url.searchParams.get('period'));
  });
  await openMarket(page, MARKETS[1]);
  await expect(period).toHaveValue('101');
  await selectedStockReady(page, MARKETS[1]);
  expect(foreignPeriods.length).toBeGreaterThan(0);
  expect(foreignPeriods.every(value => ['101', '102', '103'].includes(value))).toBe(true);
});

test('600851 真实财报、公司资料与已验证内外盘历史可读取，刷新后保留真实记录', async ({ page }) => {
  await chartReady(page);
  const financePromise = nextJsonRequest(page, '/api/ashare-finance', '600851');
  const profilePromise = nextJsonRequest(page, '/api/ashare-profile', '600851');
  const historyPromise = nextJsonRequest(page, '/api/ashare-trade-side-history', '600851');
  const [, finance, profile, history] = await Promise.all([
    search(page, MARKETS[0]), financePromise, profilePromise, historyPromise,
  ]);
  expect(String(finance.code)).toBe('600851');
  expect(Array.isArray(finance.reports)).toBe(true);
  expect(finance.reports.length).toBeGreaterThan(0);
  expect(finance.reports.some(report => Number.isFinite(report.revenue))).toBe(true);
  expect(String(profile.code)).toBe('600851');
  expect(typeof profile.company?.orgName).toBe('string');
  expect(profile.company.orgName.trim()).not.toBe('');
  await expect(page.getByText(profile.company.orgName, { exact: true }).first()).toBeVisible();
  const analysis = page.getByRole('region', { name: '个股分析', exact: true });
  await analysis.getByRole('tab', { name: '财报', exact: true }).click();
  const financeTable = analysis.getByRole('table');
  await expect(financeTable).toBeVisible();
  await expect(financeTable.locator('tbody tr')).toHaveCount(6);
  await expect(financeTable.getByRole('columnheader')).toHaveCount(Math.min(3, finance.reports.length) + 1);
  expect(history.code).toBe('600851');
  expect(Array.isArray(history.rows)).toBe(true);
  await analysis.getByRole('tab', { name: '内外盘历史', exact: true }).click();
  const panel = page.getByTestId('trade-side-history');
  await panel.getByRole('button', { name: '近2月', exact: true }).click();
  const datedCells = panel.getByRole('cell').filter({ hasText: /^\d{4}-\d{2}-\d{2}$/ });
  // A cold official-file cache may fill in the background. A 200 response with
  // zero rows is insufficient; wait for an actual dated historical record.
  await expect(datedCells.first()).toBeVisible({ timeout: 180_000 });
  const refresh = panel.getByRole('button', { name: '刷新内外盘历史', exact: true });
  await expect(refresh).toBeEnabled({ timeout: DATA_TIMEOUT });
  const refreshedPromise = nextJsonRequest(page, '/api/ashare-trade-side-history', '600851');
  const [, refreshed] = await Promise.all([refresh.click(), refreshedPromise]);
  expect(refreshed.code).toBe('600851');
  expect(refreshed.rows.length).toBeGreaterThan(0);
  expect(refreshed.rows.every(row => row.complete === true && row.quality?.validated === true)).toBe(true);
  expect(refreshed.history?.status, '明确的历史读取失败不能当作成功').not.toBe('error');
  await expect(refresh).toBeEnabled({ timeout: DATA_TIMEOUT });
  await expect(datedCells.first()).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByText('内外盘历史加载中', { exact: true })).toHaveCount(0);
});
