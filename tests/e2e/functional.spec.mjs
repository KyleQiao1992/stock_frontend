import { test, expect, control, login, requests, assertLayout } from './support.mjs';
import { chartReady, heatmapTilesReady, heatmapCaptionReady } from './pages.mjs';
import { createFixtureData } from './fixtures.mjs';

const marketButton = (page, name) => page.getByRole('button', { name, exact: true });
const search = (page, market) => page.getByPlaceholder({ ashare: '代码 / 简称 / 拼音首字母', hk: '代码 / 简称 / 拼音', us: '如 AAPL' }[market], { exact: true });
const chart = page => page.locator('svg[data-kline-count]').first();
async function queryStock(page, market, code) {
  await search(page, market).fill(code);
  await marketButton(page, '查询').first().click();
  await chartReady(page);
  await expect(page.locator('.chart-panel-header').first()).toContainText(code);
}
test.beforeEach(async ({ request }) => control(request, { reset: true }));

test('登录、注册切换和退出使用完整 App', async ({ page }) => {
  await page.goto('/');
  await marketButton(page, '注册').click();
  await expect(page.getByRole('heading', { name: '注册', exact: true })).toBeVisible();
  await marketButton(page, '去登录').click();
  await login(page);
  await chartReady(page);
  await marketButton(page, '个人菜单').click();
  await marketButton(page, '退出登录').click();
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
});

test('登录校验失败必须显示原因，恢复后重试成功', async ({ page, request, audit }) => {
  audit.allowedHttp.push({ path: '/api/auth/me', status: 503 });
  await control(request, { failPaths: { '/api/auth/me': 503 } });
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('test_audit');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password');
  await marketButton(page, '登录').click();
  await expect(marketButton(page, '重试')).toBeVisible();
  await expect(marketButton(page, 'A股')).toHaveCount(0);
  await control(request, { failPaths: {} });
  await marketButton(page, '重试').click();
  await chartReady(page);
});

test('普通用户看不到管理入口', async ({ page, request }) => {
  await control(request, { role: 'user' });
  await login(page);
  await chartReady(page);
  await expect(marketButton(page, '账号管理')).toHaveCount(0);
  await expect(marketButton(page, '因子研究')).toHaveCount(0);
});

for (const [market, label, code, name] of [
  ['ashare', 'A股', '002594', '比亚迪'], ['hk', '港股', '00700', '腾讯控股'], ['us', '美股', 'AAPL', 'Apple'],
]) {
  test(`${label}首次进入、代码搜索、逐字输入与自选选股`, async ({ page }) => {
    await login(page);
    await marketButton(page, label).click();
    await chartReady(page);
    await expect(search(page, market)).not.toHaveValue('');
    await search(page, market).fill('');
    await search(page, market).pressSequentially(code);
    await expect(search(page, market)).toHaveValue(code); // Every physical letter appears once.
    await marketButton(page, '查询').first().click();
    await chartReady(page);
    await expect(page.locator('.chart-panel-header').first()).toContainText(name);
    await expect(page.locator('.chart-panel-header').first()).toContainText(code);
    const draft = page.locator('textarea').first();
    await draft.fill(code);
    await marketButton(page, '生成列表').click();
    const card = page.locator('[role="button"]').filter({ hasText: code }).last();
    await expect(card).toContainText(name);
    await card.click();
    await chartReady(page);
    await expect(search(page, market)).toHaveValue(code);
  });
}

test('港股首次收藏慢响应：生成按钮等待，默认代码、名称和图表最终就绪', async ({ page, request }) => {
  await control(request, { delayPaths: { '/api/favorites': 1800 } });
  await login(page);
  await marketButton(page, '港股').click();
  await expect(marketButton(page, '生成中')).toBeDisabled();
  await chartReady(page);
  await expect(page.locator('textarea').first()).not.toHaveValue('');
  await expect(search(page, 'hk')).toHaveValue('09618');
  await expect(page.locator('.chart-panel-header').first()).toContainText('京东集团');
  await marketButton(page, 'A股').click();
  await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  await expect(search(page, 'hk')).toHaveValue('09618');
});

test('港股初始化期间编辑自选，迟到的默认收藏不得覆盖草稿', async ({ page, request }) => {
  await control(request, { delayPaths: { '/api/favorites': 1800 } });
  await login(page);
  await marketButton(page, '港股').click();
  await page.locator('textarea').first().fill('00700');
  await marketButton(page, '生成列表').click();
  const card = page.locator('[role="button"]').filter({ hasText: '00700' }).last();
  await expect(card).toContainText('腾讯控股');
  await card.click();
  await chartReady(page);
  await expect(search(page, 'hk')).toHaveValue('00700');
  // A completed API response is the synchronization point, not an arbitrary sleep.
  await expect.poll(async () => (await requests(request, '/api/favorites'))
    .filter(item => item.query.market === 'hk' && item.status === 200 && item.completedAt && !item.aborted).length).toBeGreaterThan(0);
  await expect(page.locator('textarea').first()).toHaveValue('00700');
  await expect(page.locator('.chart-panel-header').first()).toContainText('腾讯控股');
});

test('A股周期切换确实更新K线，4小时切港股后恢复有效周期', async ({ page }) => {
  await login(page);
  await chartReady(page);
  for (const label of ['5分钟', '30分钟', '4小时', '周K', '月K', '日K']) {
    await page.getByRole('combobox', { name: 'K线周期' }).selectOption({ label });
    await chartReady(page);
    const value = await page.getByRole('combobox', { name: 'K线周期' }).inputValue();
    await expect(chart(page)).toHaveAttribute('data-kline-period', value);
  }
  await page.getByRole('combobox', { name: 'K线周期' }).selectOption({ label: '4小时' });
  await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  await expect(page.getByRole('combobox', { name: 'K线周期' })).toHaveValue('101');
  await expect(chart(page)).toHaveAttribute('data-kline-period', '101');
});

test('主图缩放、缠论开关、全屏及关闭', async ({ page }) => {
  await login(page);
  await chartReady(page);
  const before = Number(await chart(page).getAttribute('data-kline-count'));
  await marketButton(page, '放大，显示更少K线').click();
  await expect.poll(async () => Number(await chart(page).getAttribute('data-kline-count'))).toBeLessThan(before);
  await page.getByRole('checkbox', { name: '分型', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: '分型', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '分型', exact: true }).check();
  await page.locator('button[title="全屏查看图表"]').click();
  await expect(page.locator('button[title="退出全屏图表"]').last()).toBeVisible();
  await page.locator('button[title="退出全屏图表"]').last().click();
  await expect(page.locator('button[title="全屏查看图表"]')).toBeVisible();
});

test('公司资料、财报和慢内外盘请求均完成，手动刷新只发送一次', async ({ page, request }) => {
  await control(request, { delayPaths: { '/api/ashare-profile': 1000, '/api/ashare-finance': 1200, '/api/ashare-trade-side-history': 4200 } });
  await login(page);
  await chartReady(page);
  await expect(page.getByText('模拟股份有限公司', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '财报', exact: true }).click();
  await expect(page.getByText('2026年第3季度', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '内外盘历史', exact: true }).click();
  const table = page.getByRole('table', { name: '内外盘历史列表' });
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  const refresh = marketButton(page, '刷新内外盘历史');
  await expect(refresh).toBeEnabled();
  const start = (await requests(request, '/api/ashare-trade-side-history')).length;
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled();
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  expect((await requests(request, '/api/ashare-trade-side-history')).length - start).toBe(1);
});

test('分析各分类有可用内容，资讯分类切换并刷新', async ({ page }) => {
  await login(page); await chartReady(page);
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  await expect(page.getByLabel('缠论结构研判', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '笔端参考', exact: true }).click();
  await marketButton(page, '笔低').click();
  await expect(marketButton(page, '笔低')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: '资讯', exact: true }).click();
  for (const name of ['新闻', '公告', '研报']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true }).getByRole('link').first()).toBeVisible();
  }
  await marketButton(page, '刷新资讯').click();
  await expect(page.getByRole('tabpanel', { name: '研报', exact: true }).getByRole('link').first()).toBeVisible();
});

test('Agent逐字输入、Shift+Enter换行、Enter发送和Markdown回复', async ({ page, request }) => {
  await login(page);
  await marketButton(page, 'Agent').click();
  const input = page.getByPlaceholder('输入股票、行业、策略或财报问题（Enter 发送，Shift+Enter 换行）');
  await input.pressSequentially('MSFT');
  await expect(input).toHaveValue('MSFT');
  await input.press('Shift+Enter');
  await input.pressSequentially('test');
  await expect(input).toHaveValue('MSFT\ntest');
  expect(await requests(request, '/api/agent/chat')).toHaveLength(0);
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: '模拟研究结果' })).toBeVisible();
  expect(await requests(request, '/api/agent/chat')).toHaveLength(1);
  await expect(input).toHaveValue('');
});

test('账号列表第二页失败隐藏旧行，恢复后重试当前页，再搜索', async ({ page, request, audit }) => {
  await login(page);
  await marketButton(page, '账号管理').click();
  await expect(page.getByText('audit_member_with_long_name', { exact: true })).toBeVisible();
  audit.allowedHttp.push({ path: '/api/admin/users', status: 503 });
  await control(request, { failUsersPage2: true });
  await marketButton(page, '下一页').click();
  await expect(page.getByRole('alert')).toContainText('第二页');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await control(request, { failUsersPage2: false });
  await marketButton(page, '重新加载列表').click();
  await expect(page.getByText('audit_member_02', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索用户名' }).fill('disabled');
  await marketButton(page, '搜索').click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('audit_disabled');
});

test('因子详情查询、第二页失败不显示旧结果、重试和收藏夹回测', async ({ page, request, audit }) => {
  await login(page);
  await marketButton(page, '因子研究').click();
  await marketButton(page, '成熟因子').click();
  const query = marketButton(page, '查询').last();
  await expect(query).toBeEnabled();
  await query.click();
  await expect(page.locator('tbody')).toContainText('海欣股份');
  audit.allowedHttp.push({ path: '/api/factor-detail', status: 503 });
  await control(request, { failFactorPage2: true });
  await marketButton(page, '下一页').click();
  await expect(page.getByRole('alert')).toContainText('第二页');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await control(request, { failFactorPage2: false });
  await marketButton(page, '重试查询').click();
  await expect(page.locator('tbody')).toContainText('北新路桥');
  await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
  await marketButton(page, '因子1').click();
  await page.getByRole('checkbox', { name: '我的收藏夹', exact: true }).check();
  await query.click();
  await expect(page.getByRole('columnheader', { name: '收藏日', exact: true })).toBeVisible();
  expect((await requests(request, '/api/favorites-backtest')).length).toBeGreaterThan(0);
});

test('推荐列表有代码和名称，可点击选股', async ({ page, request }) => {
  await login(page); await chartReady(page);
  await marketButton(page, '推荐').click();
  await expect(page.getByText('A股推荐列表', { exact: true })).toBeVisible();
  await marketButton(page, '查询').last().click();
  const card = page.locator('[role="button"]').filter({ hasText: '600851' }).last();
  await expect(card).toContainText('海欣股份');
  await card.click();
  await chartReady(page);
  await expect(page.locator('.chart-panel-header').first()).toContainText('海欣股份');
  expect((await requests(request, '/api/recommendations')).length).toBeGreaterThan(0);
});

test('热力图行业下钻、返回和点击股票进入A股图表', async ({ page }) => {
  await login(page);
  await marketButton(page, '趋势大盘').click();
  await marketButton(page, '热力图').click();
  const tile = page.locator('div.absolute.cursor-pointer').filter({ hasText: '半导体' }).first();
  await expect(tile).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await heatmapTilesReady(page);
    await heatmapCaptionReady(page);
  }
  await page.locator('div.absolute.cursor-pointer').filter({ hasText: '新能源汽车与高端制造' }).first().click();
  await expect(marketButton(page, '← 返回全市场')).toBeVisible();
  await heatmapTilesReady(page);
  await heatmapCaptionReady(page);
  await marketButton(page, '← 返回全市场').click();
  await heatmapTilesReady(page);
  await tile.click();
  await expect(marketButton(page, '← 返回全市场')).toBeVisible();
  await marketButton(page, '← 返回全市场').click();
  await expect(tile).toBeVisible();
  await tile.click();
  const stock = page.locator('div.absolute.cursor-pointer').filter({ hasText: '海欣股份' }).first();
  await expect(stock).toBeVisible();
  await stock.click();
  await chartReady(page);
  await expect(search(page, 'ashare')).toHaveValue('600851');
});

test('主导航清单登记全部页面，新增入口不得漏测', async ({ page }) => {
  await login(page);
  const expected = ['趋势大盘', 'A股', '港股', '美股', 'Agent', '因子研究', '账号管理'];
  const nav = marketButton(page, 'A股').locator('..');
  expect((await nav.getByRole('button').allTextContents()).map(text => text.trim())).toEqual(expected);
  await marketButton(page, '趋势大盘').click();
  const trend = marketButton(page, '热力图').locator('..');
  expect((await trend.getByRole('button').allTextContents()).map(text => text.trim()))
    .toEqual(['热力图', '今日盘面', '中长期多头趋势', '中短期多头趋势', '资金流分化']);
});

test('财报30秒截止不拖住其他资料，重新查询后恢复', async ({ page, request }) => {
  test.setTimeout(70_000);
  await control(request, { routeRules: [{ path: '/api/ashare-finance', hold: 'finance-timeout' }] });
  await login(page); await chartReady(page);
  await expect(page.getByText('模拟股份有限公司', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '财报', exact: true }).click();
  await expect(page.getByText(/财报加载超时/)).toBeVisible({ timeout: 35_000 });
  await page.getByRole('tab', { name: '内外盘历史', exact: true }).click();
  await expect(page.getByRole('table', { name: '内外盘历史列表' }).getByRole('cell').filter({ hasText: /^\d{4}-\d{2}-\d{2}$/ }).first()).toBeVisible();
  await control(request, { routeRules: [], release: 'finance-timeout' });
  await marketButton(page, '查询').first().click();
  await chartReady(page);
  await page.getByRole('tab', { name: '财报', exact: true }).click();
  await expect(page.getByText('2026年第3季度', { exact: true })).toBeVisible();
  await expect(page.getByText(/财报加载超时/)).toHaveCount(0);
});

test('快速切换搜索标的，迟到的港股响应不能覆盖新标的', async ({ page, request }) => {
  await control(request, { routeRules: [{ path: '/api/hk-kline', search: { code: '09618' }, delayMs: 1800 }] });
  await login(page);
  await marketButton(page, '港股').click();
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).filter(item => item.query.code === '09618').length).toBeGreaterThan(0);
  await queryStock(page, 'hk', '00700');
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).filter(item => item.query.code === '09618' && (item.completedAt || item.aborted)).length).toBeGreaterThan(0);
  await expect(search(page, 'hk')).toHaveValue('00700');
  await expect(page.locator('.chart-panel-header').first()).toContainText('腾讯控股');
});

test('收藏夹入口可在窄屏打开、查看名称、切换分组并关闭', async ({ page }) => {
  await login(page); await chartReady(page);
  await page.setViewportSize({ width: 320, height: 760 });
  const launcher = marketButton(page, '收藏夹');
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '我的股票收藏夹', exact: true });
  await expect(dialog).toBeVisible();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.height).toBeLessThanOrEqual(760);
  await dialog.getByRole('button', { name: /^默认/ }).click();
  await expect(dialog).toContainText('海欣股份');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 600 });
    await assertLayout(page);
    await dialog.getByText('600519', { exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByText('贵州茅台', { exact: true })).toBeVisible();
    await assertLayout(page);
    await dialog.locator('button[title="收起收藏夹"]').scrollIntoViewIfNeeded();
  }
  await dialog.locator('button[title="收起收藏夹"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
});

for (const [label, status] of [['成熟因子', 'production'], ['预备因子', 'preliminary']]) {
  test(`${label}自选起始日期更新实际收益，硬刷新保留日期和分类`, async ({ page, request }) => {
    const data = createFixtureData();
    const returns = Object.fromEntries(Object.entries(data.returns).map(([period, rows]) => [
      period, rows.map((row, index) => ({ ...row, value: index === 0 ? 12.3 : row.value })),
    ]));
    await control(request, { routeRules: [{
      path: '/api/factor-returns', search: { mode: 'custom', status, startDate: '2026-09-01' },
      body: { ok: true, data: returns },
    }] });
    await login(page);
    await marketButton(page, '因子研究').click();
    await marketButton(page, label).click();
    await marketButton(page, '自选起始日').click();
    const dateInput = page.getByText('起始日期', { exact: true }).locator('..').locator('input[type="date"]');
    await dateInput.fill('2026-09-01');
    const firstCard = page.getByText('9/1 起 · 第1天', { exact: true }).locator('..');
    await expect(firstCard.getByText('+12.30%', { exact: true })).toBeVisible();
    await expect.poll(async () => (await requests(request, '/api/factor-returns')).filter(item =>
      item.query.mode === 'custom' && item.query.status === status && item.query.startDate === '2026-09-01'
      && item.completedAt && !item.aborted && item.status === 200).length).toBeGreaterThan(0);
    await marketButton(page, '硬刷新因子').click();
    await expect.poll(async () => (await requests(request, '/api/factor-returns')).filter(item =>
      item.query.force === '1' && item.query.status === status && item.query.startDate === '2026-09-01'
      && item.completedAt && !item.aborted && item.status === 200).length).toBeGreaterThan(0);
    await expect(marketButton(page, '硬刷新因子')).toBeEnabled();
    await expect(page.getByText(/^已硬刷新 /)).toBeVisible();
    await expect(dateInput).toHaveValue('2026-09-01');
    await expect(firstCard.getByText('+12.30%', { exact: true })).toBeVisible();
    await marketButton(page, '滚动区间').click();
    await expect(page.getByText('近1天收益率', { exact: true }).locator('..')
      .getByText('+2.30%', { exact: true }).first()).toBeVisible();
  });
}

test('港股资讯分类使用当前港股代码，刷新研报完成新请求', async ({ page, request }) => {
  const path = '/__audit/remote/proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search';
  await login(page);
  await marketButton(page, '港股').click();
  await queryStock(page, 'hk', '00700');
  await page.getByRole('tab', { name: '资讯', exact: true }).click();
  for (const [name, type] of [['新闻', '2'], ['公告', '0'], ['研报', '1']]) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true }).getByRole('link').first()).toBeVisible();
    await expect.poll(async () => (await requests(request, path)).filter(item =>
      item.query.symbol === 'hk00700' && item.query.type === type
      && item.completedAt && !item.aborted && item.status === 200).length).toBeGreaterThan(0);
  }
  const before = (await requests(request, path)).length;
  await marketButton(page, '刷新资讯').click();
  await expect.poll(async () => (await requests(request, path)).slice(before).filter(item =>
    item.query.symbol === 'hk00700' && item.query.type === '1'
    && item.completedAt && !item.aborted && item.status === 200).length).toBeGreaterThan(0);
  await expect(page.getByRole('tabpanel', { name: '研报', exact: true }).getByRole('link').first()).toBeVisible();
});
