import { test, expect, control, login, requests, assertLayout } from './support.mjs';
import { chartReady, heatmapTilesReady, heatmapCaptionReady } from './pages.mjs';
import { createFixtureData } from './fixtures.mjs';
import { readFileSync } from 'node:fs';
import { segmentGapRows } from '../../src/lib/chan/fixtures/segmentGap.js';
import { zoneLifecycleRows, zoneLifecycleRawExtremesRows, zoneLifecycleAmbiguousEndpointsRows, zoneLifecycleAmbiguousRetestRows, zoneLifecycleLevels, ZONE_LIFECYCLE_CHECKPOINTS } from '../../src/lib/chan/fixtures/zoneLifecycle.js';

const fslReference = JSON.parse(readFileSync(new URL('../../src/lib/fixtures/fsl-hqchart-reference.json', import.meta.url), 'utf8'));

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

test('复权方式按市场明确显示并保留，切换周期使用当前口径', async ({ page, request }) => {
  await login(page); await chartReady(page);
  const adjustment = page.getByRole('combobox', { name: '复权方式' });
  await expect(adjustment).toHaveValue('1');
  await marketButton(page, '港股').click(); await chartReady(page);
  await expect(adjustment).toHaveValue('0');
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.adjust === '0')).toBeTruthy();
  await adjustment.selectOption('1'); await chartReady(page);
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.adjust === '1')).toBeTruthy();
  await page.getByRole('combobox', { name: 'K线周期' }).selectOption('102'); await chartReady(page);
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.adjust === '1' && r.query.period === '102')).toBeTruthy();
  await marketButton(page, '美股').click(); await chartReady(page);
  await expect(adjustment).toHaveValue('0');
  await expect.poll(async () => (await requests(request, '/api/us-kline')).some(r => r.query.adjust === '0')).toBeTruthy();
  await marketButton(page, 'A股').click(); await chartReady(page);
  await expect(adjustment).toHaveValue('1');
  await marketButton(page, '港股').click(); await chartReady(page);
  await expect(adjustment).toHaveValue('1');
});

test('迟到的港股复权行情不能覆盖切回不复权后的图', async ({ page, request }) => {
  const rows = createFixtureData().candles.map(row => ({ ...row, open: row.open + 1000,
    close: row.close + 1000, high: row.high + 1000, low: row.low + 1000 }));
  await control(request, { routeRules: [{ path: '/api/hk-kline', search: { adjust: '1' }, hold: 'old-adjust',
    body: { code: '09618', name: '京东集团–SW', klines: rows } }] });
  await login(page); await marketButton(page, '港股').click(); await chartReady(page);
  const adjustment = page.getByRole('combobox', { name: '复权方式' });
  const lastClose = () => chart(page).locator('[data-kline-close]').last().getAttribute('data-kline-close');
  const rawClose = await lastClose();
  await adjustment.selectOption('1');
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.adjust === '1')).toBeTruthy();
  await expect(chart(page)).toHaveCount(0);
  await adjustment.selectOption('0'); await chartReady(page);
  await expect.poll(lastClose).toBe(rawClose);
  await control(request, { release: 'old-adjust' });
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.adjust === '1' && r.completedAt)).toBeTruthy();
  await expect(adjustment).toHaveValue('0');
  await expect.poll(lastClose).toBe(rawClose);
});

test('港股收藏初始化慢时使用最新复权选择加载默认标的', async ({ page, request }) => {
  await control(request, { routeRules: [{ path: '/api/favorites', search: { market: 'hk' }, hold: 'hk-favorites' }] });
  await login(page); await chartReady(page); await marketButton(page, '港股').click();
  await expect.poll(async () => (await requests(request, '/api/favorites')).some(r => r.query.market === 'hk')).toBeTruthy();
  await page.getByRole('combobox', { name: '复权方式' }).selectOption('1');
  await control(request, { release: 'hk-favorites' });
  await chartReady(page);
  await expect.poll(async () => (await requests(request, '/api/hk-kline')).some(r => r.query.code === '09618' && r.query.adjust === '1')).toBeTruthy();
  await expect(page.getByRole('combobox', { name: '复权方式' })).toHaveValue('1');
});

test('美股所选复权不可用时显示接口错误而非其他口径', async ({ page, request, audit }) => {
  audit.allowedHttp.push({ path: '/api/us-kline', status: 503 });
  await control(request, { routeRules: [{ path: '/api/us-kline', search: { adjust: '1' }, status: 503,
    body: { error: '所选前复权行情不可用' } }] });
  await login(page); await chartReady(page); await marketButton(page, '美股').click(); await chartReady(page);
  await page.getByRole('combobox', { name: '复权方式' }).selectOption('1');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('所选前复权行情不可用');
  await expect(chart(page)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '复权方式' })).toHaveValue('1');
  await page.getByRole('combobox', { name: '复权方式' }).selectOption('0');
  await chartReady(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('美股复权请求使用对应数据，旧预加载迟到不能覆盖新口径进度', async ({ page, request }) => {
  const rows = createFixtureData().candles.map(row => ({ ...row, open: row.open + 1000,
    close: row.close + 1000, high: row.high + 1000, low: row.low + 1000 }));
  await control(request, { routeRules: [{ path: '/api/us-kline', search: { adjust: '1' }, hold: 'old-us-adjust',
    body: { code: 'MSFT', name: 'Microsoft Corporation', klines: rows } }] });
  await login(page); await marketButton(page, '美股').click(); await chartReady(page);
  const adjustment = page.getByRole('combobox', { name: '复权方式' });
  const lastClose = () => chart(page).locator('[data-kline-close]').last().getAttribute('data-kline-close');
  const rawClose = await lastClose();
  await adjustment.selectOption('1');
  await expect.poll(async () => (await requests(request, '/api/us-kline')).some(r => r.query.adjust === '1')).toBeTruthy();
  await adjustment.selectOption('0'); await chartReady(page);
  await expect.poll(lastClose).toBe(rawClose);
  await expect(page.getByText('已缓存 2/2', { exact: true })).toBeVisible();
  await control(request, { release: 'old-us-adjust' });
  await expect.poll(async () => (await requests(request, '/api/us-kline')).some(r => r.query.adjust === '1' && r.completedAt)).toBeTruthy();
  await expect(adjustment).toHaveValue('0');
  await expect.poll(lastClose).toBe(rawClose);
  await expect(page.getByText('已缓存 2/2', { exact: true })).toBeVisible();
  // The separately keyed adjusted cache is only displayed when selected.
  await adjustment.selectOption('1'); await chartReady(page);
  await expect.poll(lastClose).toBe(String(rows.at(-1).close));
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

for (const sign of [1, -1]) test(`线段包含后缺口：${sign === 1 ? '上涨' : '下跌'}候选等待反向分型且重载保持端点`, async ({ page, request }, testInfo) => {
  const setHistory = async count => control(request, { routeRules: [{
    path: '/api/hk-kline', method: 'GET', search: { code: '09618' }, status: 200,
    body: { ok: true, code: '09618', name: '京东集团–SW', klines: segmentGapRows(count, sign) },
  }] });
  await setHistory(82);
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  for (const count of [82, 121, 122]) {
    await setHistory(count);
    await marketButton(page, '查询').first().click();
    await chartReady(page);
    const rows = segmentGapRows(count, sign);
    await expect(chart(page).locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', rows.at(-1).date);
    await expect(chart(page).locator('[data-chan-endpoint]').first()).toBeAttached();
    const segments = chart(page).locator('[data-chan-segment]');
    await expect(segments).toHaveCount(count < 122 ? 0 : 2);
    if (count < 122) {
      await expect(chart(page).locator('[data-chan-path="pending-segment"]')).toHaveAttribute('d', /^M[-\d., ]+L[-\d., ]+$/);
    } else {
      for (const id of ['segment-9-33', 'segment-33-89']) {
        const path = chart(page).locator(`[data-chan-segment="${id}"]`);
        await expect(path).toHaveAttribute('d', /^M[-\d., ]+L[-\d., ]+$/);
        await expect(path).toHaveAttribute('aria-label', new RegExp(`确认依据K：${rows[121].date}`));
      }
      await expect(chart(page).locator('[data-chan-segment="segment-9-33"]')).toHaveAttribute('aria-label',
        new RegExp(`终点：${rows[32].date} @ ${sign === 1 ? '320.1' : '79.9'}`));
    }
  }
  const ids = target => target.locator('[data-chan-segment]').evaluateAll(paths => paths.map(p => p.dataset.chanSegment));
  const expected = ['segment-9-33', 'segment-33-89'];
  await marketButton(page, '放大，显示更少K线').click();
  await expect.poll(() => ids(chart(page))).toEqual(expected);
  await page.locator('button[title="全屏查看图表"]').click();
  await expect.poll(() => ids(page.locator('svg[data-kline-count]').last())).toEqual(expected);
  await page.locator('button[title="退出全屏图表"]').last().click();
  await page.reload();
  await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect.poll(() => ids(chart(page))).toEqual(expected);
  await chart(page).scrollIntoViewIfNeeded();
  await testInfo.attach('segment-gap-confirmed', { body: await chart(page).screenshot(), contentType: 'image/png' });
});

for (const sign of [1, -1]) test(`线段中枢：${sign === 1 ? '向上' : '向下'}形成、超过九段延伸、离开回试及切换重载`, async ({ page, request }, testInfo) => {
  const levels = zoneLifecycleLevels(sign);
  const setHistory = async bars => control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: zoneLifecycleRows(bars, sign) } },
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '102' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: zoneLifecycleRows(113, sign) } },
    { path: '/api/us-kline', method: 'GET', search: { symbol: 'MSFT', period: '101' }, status: 200,
      body: { ok: true, code: 'MSFT', name: 'Microsoft', klines: zoneLifecycleRows(113, sign) } },
  ] });
  const expectZone = async (target, level, { members, status, phase, closedTime }) => {
    const zone = target.locator(`[data-chan-zone="${level.id}"]`);
    await expect(zone).toHaveAttribute('data-chan-zone-zd', String(level.zd));
    await expect(zone).toHaveAttribute('data-chan-zone-zg', String(level.zg));
    await expect(zone).toHaveAttribute('data-chan-zone-confirmed-time', String(level.formedAt));
    await expect(zone).toHaveAttribute('data-chan-zone-segment-count', String(members));
    await expect(zone).toHaveAttribute('data-chan-zone-status', status);
    await expect(zone).toHaveAttribute('data-chan-zone-phase', phase);
    if (closedTime) await expect(zone).toHaveAttribute('data-chan-zone-closed-time', String(closedTime));
    else await expect(zone).not.toHaveAttribute('data-chan-zone-closed-time', /\d/);
    await expect(zone.locator('title')).toContainText('线段中枢');
    await expect.poll(async () => Number(await zone.getAttribute('height'))).toBeGreaterThan(0);
  };
  const expectHistory = async bars => {
    await chartReady(page);
    await expect(chart(page).locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', zoneLifecycleRows(bars, sign).at(-1).date);
  };
  const finalZones = async target => {
    await expect(target.locator('[data-chan-zone]')).toHaveCount(2);
    await expectZone(target, levels.first, { members: 13, status: 'closed', phase: 'completed', closedTime: 378 });
    await expectZone(target, levels.next, { members: 3, status: 'active', phase: 'leaving' });
  };

  await setHistory(113);
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click();
  await expectHistory(113);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  for (const checkpoint of ZONE_LIFECYCLE_CHECKPOINTS) {
    await setHistory(checkpoint.bars);
    await marketButton(page, '查询').first().click();
    await expectHistory(checkpoint.bars);
    await page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]').selectOption(String(checkpoint.bars));
    await expect(chart(page)).toHaveAttribute('data-kline-count', String(checkpoint.bars));
    await expect(chart(page).locator('[data-chan-segment]')).toHaveCount(checkpoint.segments);
    await expect(chart(page).locator('[data-chan-zone]')).toHaveCount(checkpoint.zones);
    if (checkpoint.zones) {
      await expectZone(chart(page), levels.first, {
        members: checkpoint.members, status: checkpoint.status, phase: checkpoint.phase,
        closedTime: checkpoint.bars >= 378 ? 378 : undefined,
      });
    } else await expect(chart(page).locator('[data-chan-path="pending-segment"]')).toHaveCount(1);
    if (checkpoint.zones === 2) await finalZones(chart(page));
    if ([114, 282, 377, 378, 402].includes(checkpoint.bars)) {
      await chart(page).scrollIntoViewIfNeeded();
      await testInfo.attach(`zone-${sign === 1 ? 'up' : 'down'}-${checkpoint.bars}`, {
        body: await chart(page).screenshot(), contentType: 'image/png',
      });
    }
  }

  await marketButton(page, '放大，显示更少K线').click();
  await expect.poll(async () => Number(await chart(page).getAttribute('data-kline-count'))).toBeLessThan(402);
  await finalZones(chart(page));
  await page.locator('button[title="全屏查看图表"]').click();
  await finalZones(page.locator('svg[data-kline-count]').last());
  await page.locator('button[title="退出全屏图表"]').last().click();

  // Different completed data must replace the old market/period structures.
  const period = page.getByRole('combobox', { name: 'K线周期' });
  await period.selectOption('102');
  await expectHistory(113);
  await expect(chart(page)).toHaveAttribute('data-kline-period', '102');
  await expect(chart(page).locator('[data-chan-zone]')).toHaveCount(0);
  await period.selectOption('101');
  await expectHistory(402);
  await finalZones(chart(page));
  await marketButton(page, '美股').click();
  await expect(search(page, 'us')).toHaveValue('MSFT');
  await expectHistory(113);
  await expect(chart(page).locator('[data-chan-zone]')).toHaveCount(0);
  await marketButton(page, '港股').click();
  await expectHistory(402);
  await finalZones(chart(page));
  await page.reload();
  await chartReady(page);
  await marketButton(page, '港股').click();
  await expectHistory(402);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await finalZones(chart(page));
});

test('行情中间的无效 K 线不能被悄悄删除，修正后恢复计算', async ({ page, request }) => {
  const valid = zoneLifecycleRows(114);
  const malformed = valid.map((row, index) => index === 19 ? { ...row, high: null } : row);
  const setRows = rows => control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: rows } },
  ] });
  await setRows(malformed);
  await login(page); await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await marketButton(page, '港股').click();
  await expect(page.getByRole('alert')).toContainText('行情 K 线第 20 行数据格式异常');
  await expect(page.locator('[data-chan-zone]')).toHaveCount(0);
  await setRows(valid);
  await marketButton(page, '查询').first().click();
  await chartReady(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(chart(page).locator('[data-chan-segment]')).toHaveCount(3);
  await expect(chart(page).locator('[data-chan-zone="zs-9-81"]')).toHaveCount(1);
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  const recursive = page.getByLabel('递归走势中枢状态', { exact: true });
  await expect(recursive).toHaveAttribute('data-chan-recursive-status', 'undetermined');
  await expect(recursive).toContainText('3 条已确认线段');
  await expect(recursive).toContainText('1 个已确定的线段构造中枢');
  await expect(recursive).toContainText('更高级别走势中枢尚未判定');
});

for (const sign of [1, -1]) test(`端点 K 顺序不明：${sign === 1 ? '向上' : '向下'}回试后续状态可见`, async ({ page, request }, testInfo) => {
  const rows = zoneLifecycleAmbiguousRetestRows(378, sign);
  await control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: rows } },
  ] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click(); await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect(chart(page).locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', rows.at(-1).date);
  await page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]').selectOption('378');
  await expect(chart(page)).toHaveAttribute('data-kline-count', '378');
  const zone = chart(page).locator('[data-chan-zone="zs-9-81"]');
  await expect(zone).toHaveAttribute('data-chan-zone-status', 'uncertain');
  await expect(zone).toHaveAttribute('stroke-dasharray', '5 3');
  await expect(zone).not.toHaveAttribute('data-chan-zone-closed-time', /\d/);
  await expect(zone.locator('title')).toContainText('后续状态无法确定');
  await expect(page.locator('[aria-label="缠论图例"]')).toContainText('虚线框：后续状态无法确定');
  await chart(page).scrollIntoViewIfNeeded();
  await testInfo.attach(`uncertain-zone-${sign}`, { body: await chart(page).screenshot(), contentType: 'image/png' });
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  const outlook = page.getByLabel('缠论结构研判', { exact: true });
  await expect(outlook).toContainText('后续状态无法确定');
  await expect(outlook).not.toContainText('这个中枢已经结束');
});

for (const sign of [1, -1]) test(`端点 K 顺序不明：${sign === 1 ? '向上' : '向下'}中枢不冒充确定区间`, async ({ page, request }) => {
  const rows = zoneLifecycleAmbiguousEndpointsRows(114, sign);
  await control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: rows } },
  ] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click(); await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect(chart(page).locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', rows.at(-1).date);
  await expect(chart(page).locator('[data-chan-segment]')).toHaveCount(3);
  await expect(chart(page).locator('[data-chan-zone]')).toHaveCount(0);
  const legend = page.locator('[aria-label="缠论图例"]');
  await expect(legend).toContainText('K线内高低价的先后顺序无法确定');
  await expect(legend).not.toContainText('已确认线段尚未形成有效的三段共同区间');
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  const outlook = page.getByLabel('缠论结构研判', { exact: true });
  await expect(outlook).toContainText('无法确定是否形成线段中枢');
  await expect(outlook).toContainText('无法确定中枢是否形成');
});

for (const sign of [1, -1]) test(`线段中枢边界取原始 K 线内部${sign === 1 ? '高点' : '低点'}`, async ({ page, request }, testInfo) => {
  const rows = zoneLifecycleRawExtremesRows(114, sign);
  await control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: rows } },
  ] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click(); await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect(chart(page).locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', rows.at(-1).date);
  const zone = chart(page).locator('[data-chan-zone="zs-9-81"]');
  await expect(zone).toHaveAttribute('data-chan-zone-zd', String(sign === 1 ? 199.9 : 170));
  await expect(zone).toHaveAttribute('data-chan-zone-zg', String(sign === 1 ? 230 : 200.1));
  await expect(zone).toHaveAttribute('data-chan-zone-confirmed-time', '114');
  await chart(page).scrollIntoViewIfNeeded();
  await testInfo.attach(`zone-raw-extreme-${sign}`, { body: await chart(page).screenshot(), contentType: 'image/png' });
});

test('中枢在可见历史之外时图例区分窗口与总数，展开历史后真实色框恢复可见', async ({ page, request }) => {
  await control(request, { routeRules: [
    { path: '/api/hk-kline', method: 'GET', search: { code: '09618', period: '101' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines: zoneLifecycleRows(402) } },
  ] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click(); await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  const range = page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]');
  const legend = page.locator('[aria-label="缠论图例"]');
  await range.selectOption('20');
  await expect(chart(page)).toHaveAttribute('data-kline-count', '20');
  await expect(chart(page).locator('[data-chan-zone]')).toHaveCount(2);
  await expect(legend).toContainText('当前时间窗口 0 个中枢 / 全部历史 2 个中枢');
  await expect(legend).toContainText('中枢位于当前窗口之外，可缩小图表查看更早历史');
  await expect(legend).not.toContainText('滑动笔重叠区');
  const painted = () => chart(page).evaluate(svg => {
    const clip = svg.querySelector('clipPath rect');
    const left = Number(clip.getAttribute('x')), right = left + Number(clip.getAttribute('width'));
    return [...svg.querySelectorAll('[data-chan-zone]')].filter(rect => {
      const x = Number(rect.getAttribute('x')), width = Number(rect.getAttribute('width'));
      return x < right && x + width > left;
    }).map(rect => rect.getAttribute('data-chan-zone'));
  });
  await expect.poll(painted).toEqual([]);
  await range.selectOption('402');
  await expect(chart(page)).toHaveAttribute('data-kline-count', '402');
  await expect(legend).toContainText('当前时间窗口 2 个中枢 / 全部历史 2 个中枢');
  await expect(legend).toContainText('粗边框：尚未结束的中枢');
  await expect(chart(page).locator('[data-chan-zone][data-chan-zone-status="active"]')).toHaveAttribute('stroke-width', '2');
  await expect(chart(page).locator('[data-chan-zone][data-chan-zone-status="closed"]')).toHaveAttribute('stroke-width', '1');
  await expect(legend).not.toContainText('中枢位于当前窗口之外');
  await expect.poll(painted).toEqual(['zs-9-81', 'zs-297-369']);
});

test('FSL位于MACD下方，三市场切周期、缩放与全屏保留完整历史数值', async ({ page }, testInfo) => {
  await login(page);
  for (const market of ['A股', '港股', '美股']) {
    await marketButton(page, market).click();
    for (const period of ['101', '102', '103']) {
      await page.getByRole('combobox', { name: 'K线周期' }).selectOption(period);
      await chartReady(page);
      const svg = chart(page), panel = svg.locator('[data-fsl-panel]');
      const legend = svg.locator('[data-fsl-legend]');
      await expect(svg).toHaveAttribute('data-kline-period', period);
      // Display count persists across markets and periods. Restore a zoomable
      // window for each case instead of eventually clicking the 20-bar limit.
      const available = Number(await page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"] option').last().getAttribute('value'));
      const restoredCount = Math.min(80, available);
      await page.locator('button[title="恢复为近80根"]').click();
      await expect(svg).toHaveAttribute('data-kline-count', String(restoredCount));
      expect(restoredCount).toBeGreaterThan(20);
      await page.mouse.move(0, 0);
      const before = await legend.evaluate(element => ({ date: element.dataset.date, swl: element.dataset.swl, sws: element.dataset.sws }));
      const geometry = await svg.evaluate(element => ({
        fsl: Number(element.querySelector('[data-indicator-frame="fsl"]').dataset.panelTop),
        macd: Number(element.querySelector('[data-indicator-frame="macd"]').dataset.panelTop),
        bottom: element.querySelector('[data-fsl-panel]').getBBox().y + element.querySelector('[data-fsl-panel]').getBBox().height,
        height: element.viewBox.baseVal.height,
      }));
      expect(geometry.fsl).toBeGreaterThan(geometry.macd);
      expect(geometry.bottom).toBeLessThan(geometry.height);
      await marketButton(page, '放大，显示更少K线').click();
      await expect.poll(async () => Number(await svg.getAttribute('data-kline-count'))).toBeLessThan(restoredCount);
      await page.mouse.move(0, 0);
      await expect(legend).toHaveAttribute('data-swl', before.swl);
      await expect(legend).toHaveAttribute('data-sws', before.sws);
      await expect(legend).toHaveAttribute('data-date', before.date);
      await panel.locator('text').first().scrollIntoViewIfNeeded();
      await assertLayout(page);
    }
  }
  await page.locator('button[title="全屏查看图表"]').click();
  const fullscreen = page.locator('svg[data-kline-count]').last();
  await expect(fullscreen.locator('[data-fsl-line="sws"]')).toHaveAttribute('d', /^M.+L/);
  await fullscreen.locator('[data-fsl-legend]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('fsl-fullscreen.png') });
  await page.locator('button[title="退出全屏图表"]').last().click();
});

test('FSL悬浮数值跟随同一根K线，移出后回到最新值', async ({ page }) => {
  await login(page); await chartReady(page);
  const svg = chart(page), legend = svg.locator('[data-fsl-legend]');
  await page.mouse.move(0, 0);
  const latest = await legend.getAttribute('data-date');
  const candle = svg.locator('[data-kline-time]').nth(5);
  const date = await candle.getAttribute('data-kline-time');
  await candle.locator(':scope > rect').first().hover();
  await expect(legend).toHaveAttribute('data-date', date);
  expect(date).not.toBe(latest);
  await page.mouse.move(0, 0);
  await expect(legend).toHaveAttribute('data-date', latest);
});

test('FSL与MACD副图样式一致，金叉死叉在缩放、MACD开关与全屏下保持完整', async ({ page, request }, testInfo) => {
  const data = createFixtureData();
  // A flat 10-price history followed by 16,4,16 gives hand-verifiable
  // golden/death/golden crosses on precisely the final three bars.
  const klines = data.candles.slice(-33).map((row, index) => {
    const close = index < 30 ? 10 : [16, 4, 16][index - 30];
    return { ...row, open: close, close, high: close + 1, low: close - 1, volume: 100, turnover: .6 };
  });
  await control(request, { routeRules: [{ path: '/api/hk-kline', method: 'GET', search: { code: '09618' }, status: 200,
    body: { ok: true, code: '09618', name: '京东集团–SW', klines } }] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  const panel = chart(page).locator('[data-fsl-panel]');
  const expected = klines.slice(-3).map((row, index) => ({ date: row.date, type: index === 1 ? 'death' : 'golden' }));
  const signals = target => target.locator('[data-fsl-cross]').evaluateAll(elements =>
    elements.map(element => ({ date: element.dataset.date, type: element.dataset.fslCross })));
  await expect.poll(() => signals(panel)).toEqual(expected);
  await expect(panel.locator('[data-fsl-cross="golden"] text')).toHaveText(['金叉', '金叉']);
  await expect(panel.locator('[data-fsl-cross="death"] text')).toHaveText('死叉');
  await expect(panel).not.toContainText('换手率适配版');
  await expect(panel).toHaveAttribute('aria-label', 'FSL分水岭');
  const geometry = await chart(page).evaluate(svg => {
    const frame = svg.querySelector('[data-indicator-frame="fsl"]');
    const top = Number(frame.dataset.panelTop), height = Number(frame.dataset.panelHeight);
    const firstLine = frame.querySelector('line');
    const left = firstLine.x1.baseVal.value, right = firstLine.x2.baseVal.value;
    const macdFrame = svg.querySelector('[data-indicator-frame="macd"]');
    const macdTop = Number(macdFrame.dataset.panelTop);
    const macdBottom = macdTop + Number(macdFrame.dataset.panelHeight);
    const volBottom = svg.querySelector('[data-vol-bottom]').y1.baseVal.value;
    const dividerCount = (start, end) => [...svg.querySelectorAll('line')].filter(line =>
      line.x1.baseVal.value === left && line.x2.baseVal.value === right
      && line.y1.baseVal.value === line.y2.baseVal.value
      && !line.hasAttribute('stroke-dasharray')
      && line.y1.baseVal.value >= start && line.y1.baseVal.value <= end).length;
    const markerStyle = kind => {
      const marker = svg.querySelector(`[data-indicator-cross="${kind}"]`);
      return ['circle', 'rect', 'text'].map(tag => {
        const element = marker.querySelector(tag);
        return ['r', 'width', 'height', 'rx', 'font-size', 'font-weight', 'stroke-width'].map(name => element.getAttribute(name));
      });
    };
    return { height,
      gap: top - macdBottom,
      macdGap: macdTop - volBottom,
      dividerCounts: [dividerCount(volBottom, macdTop), dividerCount(macdBottom, top)],
      fullWidthDividers: dividerCount(0, svg.viewBox.baseVal.height),
      frameLines: frame.querySelectorAll('line').length,
      frameRectangles: frame.querySelectorAll('rect').length,
      headerStyles: ['macd', 'fsl'].map(kind => [...svg.querySelectorAll(`[data-indicator-header="${kind}"] text`)].slice(0, 3).map(element => ({
        x: element.x.baseVal[0].value, font: element.getAttribute('font-size'),
        offset: element.y.baseVal[0].value - Number(svg.querySelector(`[data-indicator-frame="${kind}"]`).dataset.panelTop),
      }))),
      markerStyles: ['macd', 'fsl'].map(markerStyle),
      toggleOffsets: ['macd', 'fsl'].map(kind => Number.parseFloat(svg.parentElement.querySelector(`[data-indicator-toggle="${kind}"]`).style.top)
        - Number(svg.querySelector(`[data-indicator-frame="${kind}"]`).dataset.panelTop)),
      baselines: [...new Set([...svg.querySelectorAll('[data-fsl-legend] text')].map(text => text.y.baseVal[0].value))],
      labelsInside: [...svg.querySelectorAll('[data-fsl-cross-label]')].every(text => {
        const box = text.getBBox();
        return box.x >= left && box.x + box.width <= right
          && box.y >= top + 24 && box.y + box.height <= top + height;
      }),
    };
  });
  expect(geometry.height).toBe(104);
  expect(geometry.gap).toBe(geometry.macdGap);
  expect(geometry.dividerCounts).toEqual([1, 1]);
  expect(geometry.fullWidthDividers).toBe(4);
  expect(geometry.frameLines).toBe(2);
  expect(geometry.frameRectangles).toBe(0);
  expect(geometry.headerStyles[0]).toEqual(geometry.headerStyles[1]);
  expect(geometry.markerStyles[0]).toEqual(geometry.markerStyles[1]);
  expect(geometry.toggleOffsets).toEqual([4, 4]);
  expect(geometry.baselines).toHaveLength(1);
  expect(geometry.labelsInside).toBe(true);
  await expect(chart(page)).toHaveAttribute('data-kline-count', '33');
  for (const count of [30, 20]) {
    await marketButton(page, '放大，显示更少K线').click();
    await expect(chart(page)).toHaveAttribute('data-kline-count', String(count));
    await expect.poll(() => signals(panel)).toEqual(expected);
  }
  await expect(marketButton(page, '放大，显示更少K线')).toBeDisabled();
  await expect.poll(() => signals(panel)).toEqual(expected);
  await marketButton(page, '隐藏MACD金叉和死叉标记').click();
  await expect.poll(() => signals(panel)).toEqual(expected);
  await marketButton(page, '隐藏FSL金叉和死叉标记').click();
  await expect(panel.locator('[data-fsl-cross]')).toHaveCount(0);
  await marketButton(page, '显示FSL金叉和死叉标记').click();
  await expect.poll(() => signals(panel)).toEqual(expected);
  await panel.locator('[data-fsl-cross="death"] text').scrollIntoViewIfNeeded();
  await assertLayout(page);
  const screenshot = testInfo.outputPath('fsl-compact-crosses.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('fsl-compact-crosses.png', { path: screenshot, contentType: 'image/png' });
  await page.locator('button[title="全屏查看图表"]').click();
  const fullscreen = page.locator('svg[data-kline-count]').last().locator('[data-fsl-panel]');
  await expect.poll(() => signals(fullscreen)).toEqual(expected);
  await fullscreen.locator('[data-fsl-cross="death"] text').scrollIntoViewIfNeeded();
  await assertLayout(page);
  await page.locator('button[title="退出全屏图表"]').last().click();
});

test('FSL缺少换手数据仍按已验证的DMA边界计算，不估算股本', async ({ page, request }) => {
  const data = createFixtureData();
  await control(request, { routeRules: [{ path: '/api/hk-kline', method: 'GET', search: { code: '09618' }, status: 200,
    body: { ok: true, code: '09618', name: '京东集团–SW', klines: data.candles.map(row => ({ ...row, turnover: null })) } }] });
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click();
  await expect(page.locator('.chart-panel-header').first()).toContainText('09618');
  const panel = chart(page).locator('[data-fsl-panel]');
  await expect(panel.locator('[data-fsl-line="swl"]')).toHaveAttribute('d', /^M.+L/);
  await chartReady(page);
  await expect(panel.locator('[data-fsl-line="sws"]')).toHaveAttribute('d', /^M.+L/);
  await expect(panel.locator('[data-fsl-legend]')).not.toContainText('估算');
  await control(request, { routeRules: [] });
  await marketButton(page, '查询').first().click();
  await chartReady(page);
});

test('完整App中的FSL逐根符合独立HQChart参考数值', async ({ page, request }) => {
  await login(page); await chartReady(page);
  await marketButton(page, '港股').click();
  await chartReady(page);
  for (const fixture of fslReference.cases) {
    const klines = fixture.rows.map(row => ({ ...row, open: row.close, high: row.close + .5, low: row.close - .5, turnover: null }));
    await control(request, { routeRules: [{ path: '/api/hk-kline', method: 'GET', search: { code: '09618' }, status: 200,
      body: { ok: true, code: '09618', name: '京东集团–SW', klines } }] });
    await marketButton(page, '查询').first().click();
    await chartReady(page);
    const legend = chart(page).locator('[data-fsl-legend]');
    await expect(chart(page)).toHaveAttribute('data-kline-count', String(klines.length));
    for (const [index, expected] of fixture.expected.entries()) {
      const candle = chart(page).locator('[data-kline-time]').nth(index);
      await expect(candle).toHaveAttribute('data-kline-time', expected.date);
      const body = candle.locator(':scope > rect').first();
      await body.scrollIntoViewIfNeeded();
      const bounds = await body.boundingBox();
      expect(bounds, '参考K线必须在实际图表中有可定位的实体').not.toBeNull();
      // The public SVG handles mouse movement by candle x-coordinate. A pen
      // endpoint may legitimately cover the 1px candle body, so move the real
      // pointer there and require the actual hover date before checking values.
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(legend).toHaveAttribute('data-date', expected.date);
      expect(Math.abs(Number(await legend.getAttribute('data-swl')) - expected.swl), fixture.name + ' SWL ' + expected.date).toBeLessThan(1e-10);
      expect(Math.abs(Number(await legend.getAttribute('data-sws')) - expected.sws), fixture.name + ' SWS ' + expected.date).toBeLessThan(1e-10);
    }
    await expect(legend).not.toContainText('估算');
  }
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
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
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
