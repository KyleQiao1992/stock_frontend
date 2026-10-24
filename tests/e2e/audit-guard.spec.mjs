import { test as base, expect } from 'playwright/test';
import { attachBrowserAudit, startBrowserAudit } from './browserAudit.mjs';
import { control, login } from './support.mjs';
import { chartReady } from './pages.mjs';
import { FIXTURE_DAY } from './fixtures.mjs';

// Deliberately use our own fixture, rather than support.mjs's audit exemptions:
// these tests must prove the shared real-service monitor detects each fault.
const test = base.extend({
  browserAudit: [async ({ page, context, request, baseURL }, use, testInfo) => {
    await control(request, { reset: true });
    await page.clock.setFixedTime(new Date(`${FIXTURE_DAY}T08:00:00Z`));
    const origin = new URL(baseURL).origin;
    const external = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      external.push({ method: route.request().method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });
    // Only the isolated login writes fixture state. The shared monitor itself
    // stays read-only, and live.spec always retains its read-only API guard.
    const monitor = startBrowserAudit(page, { origin, readOnlyApi: false });
    const audit = { monitor, expected: [] };
    await use(audit);
    const report = await monitor.stop();
    await attachBrowserAudit(testInfo, report);
    expect(external, 'Guard tests must remain isolated from real services').toEqual([]);
    const remaining = audit.expected.map(item => ({ ...item, remaining: item.count }));
    const unexpected = report.issues.filter(issue => {
      const allowance = remaining.find(item => item.remaining > 0
        && Object.entries(item.match).every(([key, value]) => issue[key] === value));
      if (!allowance) return true;
      allowance.remaining -= 1;
      return false;
    });
    expect(unexpected, 'Only this test’s exact fault category/path/method/status and count are permitted').toEqual([]);
    expect(remaining.filter(item => item.remaining !== 0), 'Every expected fault must actually be detected').toEqual([]);
  }, { auto: true }],
});

const button = (page, name) => page.getByRole('button', { name, exact: true });
const adminPath = '/api/admin/users';
const ashareKlinePath = '/__audit/remote/proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get';
const expectIssue = (audit, match, count = 1) => audit.expected.push({ match, count });

async function enterApp(page, audit) {
  await audit.monitor.transition({
    name: 'initial-authentication', cancelPaths: ['/api/auth/me'], successPaths: ['/api/auth/me'],
  }, () => audit.monitor.transition({ name: 'initial-factors', cancelPaths: ['/api/factors'], successPaths: ['/api/factors'] }, async () => {
    await login(page);
    await chartReady(page);
  }));
}

async function adminReady(page, audit) {
  await enterApp(page, audit);
  await audit.monitor.transition({ name: 'admin-open', cancelPaths: [adminPath], successPaths: [adminPath] }, async () => {
    await button(page, '账号管理').click();
    await expect(page.getByText('audit_member_with_long_name', { exact: true })).toBeVisible();
  });
  expect((await audit.monitor.snapshot()).issues).toEqual([]);
}

test('浏览器监控正向守卫：完整 App 冷启动、三市场、搜索与周期切换成功，合法取消有成功证据', async ({ page, request, browserAudit: audit }) => {
  await enterApp(page, audit);
  // Hold a real suggestion request. Editing the query intentionally cancels
  // that old request; only the completed, asserted stock transition permits it.
  await control(request, { routeRules: [{ path: '/api/ashare-search', method: 'GET', search: { q: '600' }, hold: 'old-suggestion' }] });
  const input = page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true });
  await input.fill('600');
  await expect.poll(async () => {
    const response = await request.get('/__audit/requests');
    return (await response.json()).requests.some(item => item.path === '/api/ashare-search' && item.query.q === '600' && item.held === 'old-suggestion');
  }).toBe(true);
  await audit.monitor.transition({ name: 'stock-search', cancelPaths: ['/api/ashare-search'], successPaths: [ashareKlinePath] }, async () => {
    const fresh = page.waitForResponse(response => new URL(response.url()).pathname === ashareKlinePath && response.status() === 200);
    await input.fill('600851');
    await input.press('Enter');
    await fresh;
    await chartReady(page);
    await expect(input).toHaveValue('600851');
    await expect(page.locator('.chart-panel-header').first()).toContainText('海欣股份');
  });
  await control(request, { routeRules: [], release: 'old-suggestion' });
  const cancelled = (await audit.monitor.snapshot()).requests.filter(item => item.path === '/api/ashare-search' && item.outcome === 'transition-cancelled');
  expect(cancelled, 'The monitor must retain the actual cancellation and successful replacement evidence').toHaveLength(1);
  expect(cancelled[0].successRequestIds.length).toBeGreaterThan(0);
  for (const [title, placeholder, code, name, path] of [
    ['港股', '代码 / 简称 / 拼音', '00700', '腾讯控股', '/api/hk-kline'],
    ['美股', '如 AAPL', 'AAPL', 'Apple', '/api/us-kline'],
  ]) {
    await audit.monitor.transition({ name: 'market-switch', cancelPaths: ['/api/ashare-search', '/api/hk-search'], successPaths: [path] }, async () => {
      await button(page, title).click();
      await chartReady(page);
    });
    await audit.monitor.transition({ name: 'stock-search', cancelPaths: ['/api/ashare-search', '/api/hk-search'], successPaths: [path] }, async () => {
      // US stocks can legitimately come from the App's completed preload
      // cache. A changed identity with matching rendered data proves search;
      // HK has no such cache and must complete its newly issued request.
      const fresh = title === '港股' ? page.waitForResponse(response => new URL(response.url()).pathname === path
        && new URL(response.url()).searchParams.get('code') === code && response.status() === 200) : null;
      await page.getByPlaceholder(placeholder, { exact: true }).fill(code);
      await page.getByPlaceholder(placeholder, { exact: true }).press('Enter');
      if (fresh) await fresh;
      await chartReady(page);
      await expect(page.locator('.chart-panel-header').first()).toContainText(name);
      await expect(page.getByPlaceholder(placeholder, { exact: true })).toHaveValue(code);
    });
    const period = title === '港股' ? '102' : '103';
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === path
      && new URL(response.url()).searchParams.get('period') === period && response.status() === 200);
    await page.getByRole('combobox', { name: 'K线周期', exact: true }).selectOption(period);
    await updated;
    await chartReady(page);
    await expect(page.locator('svg[data-kline-period]').first()).toHaveAttribute('data-kline-period', period);
  }
  expect((await audit.monitor.snapshot()).issues).toEqual([]);
});

test('浏览器监控能抓到前端已捕获的 HTTP 503 和可见 alert，恢复成功仍保留失败证据', async ({ page, request, browserAudit: audit }) => {
  await adminReady(page, audit);
  expectIssue(audit, { type: 'http-error', path: adminPath, method: 'GET', status: 503 });
  expectIssue(audit, { type: 'console', level: 'error', category: 'resource-load-failure', path: adminPath, status: 503 });
  expectIssue(audit, { type: 'visible-alert', kind: 'role-alert', path: '/', count: 1 });
  await control(request, { routeRules: [{ path: adminPath, method: 'GET', search: { page: '2' }, status: 503, body: { ok: false, error: '隔离守卫：第二页 HTTP 503' } }] });
  await button(page, '下一页').click();
  await expect(page.getByRole('alert')).toHaveText('隔离守卫：第二页 HTTP 503');
  const report = await audit.monitor.snapshot();
  expect(report.issues).toContainEqual(expect.objectContaining({ type: 'http-error', path: adminPath, method: 'GET', status: 503, durationMs: expect.any(Number) }));
  expect(report.issues.some(issue => issue.type === 'pageerror')).toBe(false);
  expect(report.issues.some(issue => issue.type === 'visible-alert')).toBe(true);
  await control(request, { routeRules: [] });
  await button(page, '重新加载列表').click();
  await expect(page.getByText('audit_member_02', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await audit.monitor.snapshot()).issues.some(issue => issue.type === 'http-error')).toBe(true);
});

test('浏览器监控能抓到前端已捕获的真实传输失败，不把 ERR_FAILED 当导航取消', async ({ page, browserAudit: audit }) => {
  await adminReady(page, audit);
  expectIssue(audit, { type: 'requestfailed', path: adminPath, method: 'GET', failureCode: 'ERR_FAILED' });
  expectIssue(audit, { type: 'console', level: 'error', category: 'resource-load-failure', path: adminPath, failureCode: 'ERR_FAILED' });
  expectIssue(audit, { type: 'visible-alert', kind: 'role-alert', path: '/', count: 1 });
  const failSecondPage = route => {
    const request = route.request();
    const url = new URL(request.url());
    return request.method() === 'GET' && url.searchParams.get('page') === '2' ? route.abort('failed') : route.fallback();
  };
  await page.route(`**${adminPath}?*`, failSecondPage);
  await button(page, '下一页').click();
  await expect(page.getByRole('alert')).toContainText('Failed to fetch');
  const report = await audit.monitor.snapshot();
  expect(report.requests).toContainEqual(expect.objectContaining({ path: adminPath, method: 'GET', status: null, outcome: 'transport-error', failureCode: 'ERR_FAILED', durationMs: expect.any(Number) }));
  expect(report.issues.some(issue => issue.type === 'requestfailed')).toBe(true);
  expect(report.issues.some(issue => issue.type === 'pageerror')).toBe(false);
  await page.unroute(`**${adminPath}?*`, failSecondPage);
  await button(page, '重新加载列表').click();
  await expect(page.getByText('audit_member_02', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('浏览器监控捕获 console warning/error 和异步 JS 异常，报告不含敏感查询、header 或任意消息', async ({ page, browserAudit: audit }) => {
  await enterApp(page, audit);
  expectIssue(audit, { type: 'console', level: 'warning', category: 'console-message', path: '/@vite/client' });
  expectIssue(audit, { type: 'console', level: 'error', category: 'console-message', path: '/@vite/client' });
  expectIssue(audit, { type: 'pageerror', name: 'TypeError', path: '' });
  await page.evaluate(async () => {
    await fetch('/__audit/manifest?secret=guard-private-query', { headers: { 'X-Audit-Probe': 'guard-private-header' } });
    console.warn('guard-private-warning', { token: 'guard-private-console-state' });
    console.error('guard-private-console-error');
    void Promise.reject(new TypeError('guard-private-exception-message'));
  });
  await expect.poll(async () => (await audit.monitor.snapshot()).issues.filter(issue => issue.type === 'pageerror').length).toBe(1);
  const report = await audit.monitor.snapshot();
  expect(report.issues.filter(issue => issue.type === 'console')).toHaveLength(2);
  expect(report.requests).toContainEqual(expect.objectContaining({ path: '/__audit/manifest', method: 'GET', status: 200, durationMs: expect.any(Number) }));
  expect(JSON.stringify(report)).not.toContain('guard-private');
  await chartReady(page);
});
