import { test, expect, control, login } from './support.mjs';
import { chartReady } from './pages.mjs';

test.beforeEach(async ({ request }) => control(request, { reset: true }));

// Upstream stroke and segment endpoints should fall on the corresponding
// candle's actual high or low. This checks the SVG mapping independently of
// the adapter's bar-index conversion, including a clipped history viewport.
async function checkVisibleGeometry(chart, candleSelector) {
  const geometry = await chart.evaluate((svg, selector) => {
    const wicks = [...svg.querySelectorAll(selector)].map(group => group.querySelector('line')).filter(Boolean)
      .map(line => ({ x: Number(line.getAttribute('x1')),
        high: Number(line.getAttribute('y1')), low: Number(line.getAttribute('y2')) }));
    const xs = wicks.map(wick => wick.x);
    const min = Math.min(...xs) - .01, max = Math.max(...xs) + .01;
    const records = [...svg.querySelectorAll('[data-chan-upstream-pen], [data-chan-upstream-segment]')];
    const points = records.flatMap(node => [...node.getAttribute('d').matchAll(/[ML]\s*([^,\s]+),([^\sML]+)/g)]
      .map(match => ({ x: Number(match[1]), y: Number(match[2]) })));
    const inView = points.filter(point => point.x >= min && point.x <= max);
    return { paths: records.length, checked: inView.length, bad: inView.filter(point => !wicks.some(wick =>
      Math.abs(point.x - wick.x) < .01 && Math.min(Math.abs(point.y - wick.high), Math.abs(point.y - wick.low)) < .02)) };
  }, candleSelector);
  expect(geometry.paths).toBeGreaterThan(0);
  expect(geometry.checked).toBeGreaterThan(0);
  expect(geometry.bad).toEqual([]);
}

for (const market of ['港股', '美股']) {
  test(`${market}开源对照在日K与周K均显示对应行情的原版结构`, async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: market, exact: true }).click();
    await chartReady(page);
    const chart = page.locator('svg[data-kline-count]').first();
    const engine = page.getByRole('combobox', { name: '缠论引擎' });
    const period = page.getByRole('combobox', { name: 'K线周期' });
    await engine.selectOption('upstream');
    const legend = page.getByLabel('缠论图例');
    await expect(legend).toContainText('开源原版对照');
    await expect(legend).toContainText('非递归');
    await expect(chart.locator('[data-chan-upstream-pen]')).not.toHaveCount(0);
    await expect(chart.locator('[data-chan-upstream-zone]')).not.toHaveCount(0);
    await checkVisibleGeometry(chart, 'g[data-kline-time]');
    await page.getByRole('tab', { name: '缠论研判' }).click();
    await expect(page.getByLabel('缠论结构研判', { exact: true })).toContainText('开源原版对照');
    await expect(page.getByLabel('缠论结构研判', { exact: true })).toContainText('不是递归走势中枢');
    await period.selectOption('102');
    await chartReady(page);
    await expect(chart).toHaveAttribute('data-kline-period', '102');
    await expect(engine).toHaveValue('upstream');
    await expect(chart.locator('[data-chan-upstream-pen]')).not.toHaveCount(0);
    await checkVisibleGeometry(chart, 'g[data-kline-time]');
  });
}

test('A股开源对照在5分、30分及4小时切换后保持对应周期的图形', async ({ page }) => {
  await login(page);
  await chartReady(page);
  const chart = page.locator('svg[data-kline-count]').first();
  const engine = page.getByRole('combobox', { name: '缠论引擎' });
  const period = page.getByRole('combobox', { name: 'K线周期' });
  await engine.selectOption('upstream');
  for (const value of ['5', '30', '240']) {
    await period.selectOption(value);
    await chartReady(page);
    await expect(chart).toHaveAttribute('data-kline-period', value);
    await expect(engine).toHaveValue('upstream');
    await expect(page.getByLabel('缠论图例')).toContainText('开源原版对照');
    await expect(chart.locator('[data-chan-upstream-pen]')).not.toHaveCount(0);
    // The synthetic 5m dataset can place its only pen entirely outside the
    // default 80-bar window; expose all loaded bars before checking geometry.
    const zoom = page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]');
    await zoom.selectOption(await zoom.locator('option').last().getAttribute('value'));
    await checkVisibleGeometry(chart, 'g[data-kline-time]');
  }
});

test('四大指数进入开源对照后分别绘制各自行情结构', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '趋势大盘', exact: true }).click();
  await page.getByRole('button', { name: '中长期多头趋势', exact: true }).click();
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('upstream');
  for (const code of ['000001', '000688', '399001', '399006']) {
    const card = page.locator(`[data-index-trend-card="${code}"]`);
    const chart = card.locator('svg[data-index-trend-chart]');
    await expect(chart).toBeVisible();
    await expect(card.getByLabel('指数缠论图例')).toContainText('开源原版对照');
    await expect(card.getByLabel('指数缠论图例')).toContainText('非递归');
    await expect(chart.locator('[data-chan-upstream-pen]')).not.toHaveCount(0);
    await checkVisibleGeometry(chart, 'g[data-index-candle]');
  }
});
