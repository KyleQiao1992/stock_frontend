import { writeFile } from 'node:fs/promises';
import { test, expect, assertLayout } from './support.mjs';

// These are self-tests of the geometry detector, not business-page coverage.
// Load the actual App, then add a bounded dialog whose geometry is deliberate.
async function addDialog(page, markup) {
  await page.evaluate((content) => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', '布局探测器自测');
    dialog.style.cssText = 'position:fixed;left:24px;top:24px;width:320px;height:160px;padding:16px;box-sizing:border-box;background:white;color:black;z-index:1000;font:16px/24px monospace;';
    dialog.innerHTML = content;
    document.body.append(dialog);
  }, markup);
  await expect(page.getByRole('dialog', { name: '布局探测器自测', exact: true })).toBeVisible();
}

async function saveGeometry(page, testInfo) {
  const path = testInfo.outputPath('layout-guard.png');
  await page.screenshot({ path });
  await testInfo.attach('layout-guard.png', { path, contentType: 'image/png' });
}

async function expectGeometryFailure(page, testInfo, expected) {
  let detected;
  try {
    await assertLayout(page);
  } catch (error) {
    detected = error;
  }
  expect(detected, '布局探测器必须拒绝刻意制造的错误').toBeTruthy();
  expect(detected.message).toContain(expected);
  const path = testInfo.outputPath('expected-layout-rejection.txt');
  await writeFile(path, detected.message);
  await testInfo.attach('expected-layout-rejection.txt', { path, contentType: 'text/plain' });
  await saveGeometry(page, testInfo);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
});

test('布局探测器拒绝同父元素的 absolute span 文字重叠', async ({ page }, testInfo) => {
  await addDialog(page, '<div style="position:relative;height:60px"><span style="position:absolute;left:0;top:0">absolute span one</span><span style="position:absolute;left:0;top:0">absolute span two</span></div>');
  await expectGeometryFailure(page, testInfo, 'text overlap: absolute span one / absolute span two');
});

test('布局探测器拒绝 dialog 内无省略规则的 overflow hidden 裁字', async ({ page }, testInfo) => {
  await addDialog(page, '<div style="width:72px;height:24px;overflow:hidden;white-space:nowrap">clipped dialog content must be detected</div>');
  await expectGeometryFailure(page, testInfo, 'clipped x text: clipped dialog content must be detected');
});

test('布局探测器允许明确 ellipsis 的单行省略', async ({ page }, testInfo) => {
  await addDialog(page, '<div data-layout-ellipsis style="width:120px;height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">intentional ellipsis is allowed</div>');
  const ellipsis = page.locator('[data-layout-ellipsis]');
  expect(await ellipsis.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(ellipsis).toHaveCSS('text-overflow', 'ellipsis');
  await assertLayout(page);
  await saveGeometry(page, testInfo);
});

test('布局探测器允许可操作的内部横向和纵向滚动', async ({ page }, testInfo) => {
  await addDialog(page, '<div data-layout-scroll style="width:180px;height:48px;overflow:auto;white-space:nowrap"><div>scrollable row one has a deliberately long value</div><div>scrollable row two has a deliberately long value</div><div>scrollable row three has a deliberately long value</div><div>scrollable row four has a deliberately long value</div></div>');
  const scrolling = page.locator('[data-layout-scroll]');
  expect(await scrolling.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight)).toBe(true);
  await assertLayout(page);
  await scrolling.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.scrollTop = element.scrollHeight;
  });
  expect(await scrolling.evaluate(element => element.scrollLeft > 0 && element.scrollTop > 0)).toBe(true);
  await assertLayout(page);
  await saveGeometry(page, testInfo);
});
