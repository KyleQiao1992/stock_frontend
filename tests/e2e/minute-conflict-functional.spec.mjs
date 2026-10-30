import { test, expect, control, login } from './support.mjs';
import { chartReady } from './pages.mjs';

test('A股5分钟K线同时间价格冲突明确报错，修正后重新查询恢复', async ({ page, request }) => {
  await control(request, { reset: true });
  await login(page);
  await chartReady(page);
  const symbol = page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true });
  await symbol.fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  await page.getByRole('combobox', { name: '复权方式' }).selectOption('0');
  await chartReady(page);
  const previous = page.locator('svg[data-kline-period][data-kline-count]').first();
  await expect(previous).toHaveAttribute('data-kline-period', '101');
  await expect(previous.locator('g[data-kline-time]').first()).toBeVisible();

  const quote = [];
  quote[1] = '海欣股份';
  quote[30] = '20261021150000';
  const conflicting = [
    ['202610190935', '10', '10', '10', '10', '100'],
    ['202610190935', '20', '20', '20', '20', '100'],
    ['202610190940', '11', '11', '11', '11', '100'],
  ];
  const body = { code: 0, data: { sh600851: { m5: conflicting, qt: { sh600851: quote } } } };
  await control(request, { routeRules: [{
    path: '/__audit/remote/ifzq.gtimg.cn/appstock/app/kline/mkline',
    search: { param: 'sh600851,m5,,800' }, body, scriptVariableParam: '_var',
  }] });
  await page.getByRole('combobox', { name: 'K线周期' }).selectOption('5');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText(/重复.*冲突/);
  await expect(page.locator('svg[data-kline-period][data-kline-count]')).toHaveCount(0);
  await expect(page.locator('[data-chan-layer]')).toHaveCount(0);

  await control(request, { routeRules: [] });
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  const chart = page.locator('svg[data-kline-period][data-kline-count]').first();
  await expect(chart).toHaveAttribute('data-kline-period', '5');
  await expect(chart.locator('g[data-kline-time]').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
