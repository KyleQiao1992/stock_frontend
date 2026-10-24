import { test, expect, control, login, assertLayout } from './support.mjs';
import { PAGE_CASES } from './pages.mjs';

const widths = [320, 390, 768, 1280, 1440, 1920];
const analysisCases = new Set([
  'ashare-financial', 'ashare-outlook', 'ashare-endpoints', 'ashare-news', 'ashare-trade-history',
  'hk-news', 'hk-outlook', 'hk-endpoints', 'us-outlook', 'us-endpoints',
]);

function analysisTargets(page, id) {
  const panel = page.getByRole('region', { name: '个股分析', exact: true });
  if (id.endsWith('-outlook')) {
    const outlook = panel.locator('[aria-label="缠论结构研判"]');
    return [outlook.locator('section[aria-label="结构事实"] p').first(), outlook.locator(':scope > p').last()];
  }
  if (id.endsWith('-endpoints')) {
    const items = panel.locator('ol > li');
    return [items.first(), items.last()];
  }
  if (id.endsWith('-news')) {
    const items = panel.getByRole('tabpanel', { name: '新闻', exact: true }).locator('ol > li');
    return [items.first(), items.last()];
  }
  if (id.endsWith('-financial')) {
    const rows = panel.getByRole('table').locator('tbody tr');
    return [rows.first().getByRole('cell').nth(1), rows.last().getByRole('cell').last()];
  }
  const history = panel.getByTestId('trade-side-history');
  return [history.getByText('当前内盘 S', { exact: true }), history.locator(':scope > p').last()];
}

async function scrollGeometry(target) {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const window = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const positions = [{ left: scrollX, top: scrollY }];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      const left = bounds.left + ancestor.clientLeft, top = bounds.top + ancestor.clientTop;
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        window.left = Math.max(window.left, left);
        window.right = Math.min(window.right, left + ancestor.clientWidth);
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        window.top = Math.max(window.top, top);
        window.bottom = Math.min(window.bottom, top + ancestor.clientHeight);
      }
      positions.push({ left: ancestor.scrollLeft, top: ancestor.scrollTop });
    }
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, window, positions,
      inside: box.width > 0 && box.height > 0 && box.left >= window.left - 1 && box.right <= window.right + 1
        && box.top >= window.top - 1 && box.bottom <= window.bottom + 1,
    };
  });
}

async function captureAnalysisScroll(page, item, theme, width, testInfo) {
  // Keep native scroll containers intact. fullPage cannot expose their hidden
  // contents; scroll real content into their painted window instead.
  const initialScroll = await page.evaluateHandle(() => ({
    left: scrollX, top: scrollY,
    containers: [...document.querySelectorAll('*')].filter(element => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowX + style.overflowY)
        && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
    }).map(element => ({ element, left: element.scrollLeft, top: element.scrollTop })),
  }));
  try {
    for (const [index, target] of analysisTargets(page, item.id).entries()) {
      const position = index === 0 ? 'start' : 'end';
      await expect(target).toBeVisible();
      const before = await scrollGeometry(target);
      await target.scrollIntoViewIfNeeded();
      const after = await scrollGeometry(target);
      expect(after.inside, `${item.id} ${position} 内容必须完整进入所有滚动窗口：${JSON.stringify(after)}`).toBe(true);
      if (!before.inside) expect(after.positions, '原先被裁切的内容必须通过实际滚动进入窗口').not.toEqual(before.positions);
      await assertLayout(page);
      const filename = `${item.id}-${theme}-${width}-analysis-${position}.png`;
      await page.screenshot({ path: testInfo.outputPath(filename), animations: 'disabled' });
      await testInfo.attach(filename, { path: testInfo.outputPath(filename), contentType: 'image/png' });
      await testInfo.attach(`${filename}.geometry.json`, {
        body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json',
      });
    }
  } finally {
    await initialScroll.evaluate((saved) => {
      for (const { element, left, top } of saved.containers) {
        element.scrollLeft = left; element.scrollTop = top;
      }
      window.scrollTo(saved.left, saved.top);
    });
    await initialScroll.dispose();
  }
}

for (const item of PAGE_CASES) {
  test(`页面覆盖与布局：${item.id} ${item.title}`, async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    await control(request, { reset: true });
    if (!['login', 'register'].includes(item.id)) await login(page);
    await item.open(page);
    await item.ready(page);
    for (const theme of ['dark', 'light']) {
      await test.step(`${item.title} ${theme}`, async () => {
        // Exercise the real theme menu. Login uses the system theme preference.
        if (!['login', 'register'].includes(item.id)) {
          await page.getByRole('button', { name: '个人菜单' }).click();
          await page.getByRole('button', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click();
          await page.getByRole('button', { name: '个人菜单' }).click();
        } else await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const color = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
        const channels = color.match(/\d+/g).slice(0, 3).map(Number);
        if (theme === 'dark') expect(Math.max(...channels)).toBeLessThan(100);
        else expect(Math.min(...channels)).toBeGreaterThan(200);
        for (const width of widths) await test.step(`${width}px`, async () => {
          await page.setViewportSize({ width, height: 1000 });
          await item.ready(page);
          await assertLayout(page);
          const filename = `${item.id}-${theme}-${width}.png`;
          await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true, animations: 'disabled' });
          await testInfo.attach(filename, { path: testInfo.outputPath(filename), contentType: 'image/png' });
          if (analysisCases.has(item.id)) await captureAnalysisScroll(page, item, theme, width, testInfo);
          if (item.id === 'ashare' && width === 390) {
            await page.screenshot({ path: testInfo.outputPath(`ashare-${theme}-390-viewport.png`), animations: 'disabled' });
          }
        });
      });
    }
    await expect(page.locator('#root')).not.toBeEmpty();
  });
}
