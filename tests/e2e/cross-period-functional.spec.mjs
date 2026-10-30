import { test, expect, control, login, requests } from './support.mjs';
import { chartReady } from './pages.mjs';

const buildRules = ({ conflict = true, failFive = false, holdThirty = false } = {}) => {
  const quote = []; quote[1] = '海欣股份'; quote[30] = '20261020110000';
  const fives = [];
  for (let minutes = 9 * 60 + 35; minutes <= 11 * 60 + 30; minutes += 5) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    if (`${hh}${mm}` === '1050') continue;
    fives.push([`20261020${hh}${mm}`, '10', '11', '12', '9', '100']);
  }
  const thirties = ['1000', '1030', '1100', '1130'].map(time => [
    `20261020${time}`, '10', '11', conflict && time === '1030' ? '13' : '12', '9', '600',
  ]);
  const node = rows => ({ code: 0, data: { sh600851: { ...rows, qt: { sh600851: quote } } } });
  const day = [['2026-10-20', '10', '11', '13', '9', '10000']];
  return [
    { path: '/__audit/remote/ifzq.gtimg.cn/appstock/app/kline/mkline', search: { param: 'sh600851,m5,,800' },
      body: failFive ? { code: 1, msg: '模拟5分钟行情不可用' } : node({ m5: fives }), scriptVariableParam: '_var' },
    { path: '/__audit/remote/ifzq.gtimg.cn/appstock/app/kline/mkline', search: { param: 'sh600851,m30,,800' },
      body: node({ m30: thirties }), scriptVariableParam: '_var', ...(holdThirty ? { hold: 'cross-thirty' } : {}) },
    { path: '/__audit/remote/ifzq.gtimg.cn/appstock/app/kline/kline', search: { param: 'sh600851,day,,,1000' },
      body: node({ day }), scriptVariableParam: '_var' },
    { path: '/__audit/remote/ifzq.gtimg.cn/appstock/app/fqkline/get', search: { param: 'sh600851,day,,,640,qfq' },
      body: node({ qfqday: day }), scriptVariableParam: '_var' },
  ];
};

async function openCrossCheck(page) {
  await login(page);
  await chartReady(page);
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  return page.getByRole('button', { name: '核对5分钟与30分钟', exact: true });
}

test('同标的5分钟与30分钟核对显示匹配、缺失、冲突与未确认', async ({ page, request }) => {
  await control(request, { reset: true, routeRules: buildRules() });
  const button = await openCrossCheck(page);
  await expect(button).toBeEnabled();
  await button.click();
  const panel = page.getByLabel('5分钟与30分钟行情核对', { exact: true });
  await expect(panel).toContainText(/匹配\s*1/);
  await expect(panel).toContainText(/冲突\s*1/);
  await expect(panel).toContainText(/缺失\s*1/);
  await expect(panel).toContainText(/未确认\s*1/);
  await expect(panel).toContainText(/1\s*个窗口在覆盖范围内缺K/);
  await expect(panel).toContainText('2026-10-20 10:30');
  await expect(panel).toContainText('最高价');
  await expect(panel).toContainText('不是走势中枢');
  await expect(panel).toContainText('600851');
});

test('周期核对显示数据源错误，恢复后可重新核对', async ({ page, request }) => {
  await control(request, { reset: true, routeRules: buildRules({ failFive: true }) });
  const button = await openCrossCheck(page);
  await button.click();
  const panel = page.getByLabel('5分钟与30分钟行情核对', { exact: true });
  await expect(panel).toContainText('模拟5分钟行情不可用');
  await expect(panel).not.toContainText(/匹配\s*1/);
  await control(request, { routeRules: buildRules() });
  await button.click();
  await expect(panel).toContainText(/匹配\s*1/);
  await expect(panel).toContainText(/冲突\s*1/);
});

test('慢周期核对切换复权后旧响应不能覆盖新选择', async ({ page, request }) => {
  await control(request, { reset: true, routeRules: buildRules({ holdThirty: true }) });
  const button = await openCrossCheck(page);
  await button.click();
  await expect.poll(async () => (await requests(request)).some(item =>
    item.path.endsWith('/kline/mkline') && item.query.param === 'sh600851,m30,,800')).toBe(true);
  const delayedResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/kline/mkline') && url.searchParams.get('param') === 'sh600851,m30,,800';
  });
  await page.getByRole('combobox', { name: '复权方式' }).selectOption('0');
  await chartReady(page);
  await control(request, { routeRules: [], release: 'cross-thirty' });
  const response = await delayedResponse;
  await response.finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('combobox', { name: '复权方式' })).toHaveValue('0');
  const panel = page.getByLabel('5分钟与30分钟行情核对', { exact: true });
  await expect(panel).not.toContainText(/匹配\s*1/);
  await expect(panel).not.toContainText(/冲突\s*1/);
  await expect(page.getByRole('button', { name: '核对5分钟与30分钟', exact: true })).toBeEnabled();
});

for (const change of ['标的', '周期']) {
  test(`慢周期核对切换${change}后旧响应不能覆盖新图，核对按钮恢复可用`, async ({ page, request }) => {
    await control(request, { reset: true, routeRules: buildRules({ holdThirty: true }) });
    const button = await openCrossCheck(page);
    await button.click();
    await expect.poll(async () => (await requests(request)).some(item =>
      item.path.endsWith('/kline/mkline') && item.query.param === 'sh600851,m30,,800')).toBe(true);
    const delayedResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/kline/mkline') && url.searchParams.get('param') === 'sh600851,m30,,800';
    });
    if (change === '标的') {
      await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('300364');
      await page.getByRole('button', { name: '查询', exact: true }).first().click();
    } else {
      await page.getByRole('combobox', { name: 'K线周期' }).selectOption('5');
    }
    await chartReady(page);
    await control(request, { routeRules: [], release: 'cross-thirty' });
    const response = await delayedResponse;
    await response.finished();
    // Allow the completed script's promise handlers and the next React paint
    // to run before asserting that the old result cannot reappear.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (change === '标的') {
      await expect(page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true })).toHaveValue('300364');
    } else {
      await expect(page.getByRole('combobox', { name: 'K线周期' })).toHaveValue('5');
      await expect(page.locator('svg[data-kline-period]').first()).toHaveAttribute('data-kline-period', '5');
    }
    await expect(page.locator('[data-cross-period-result]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '核对5分钟与30分钟', exact: true })).toBeEnabled();
  });
}
