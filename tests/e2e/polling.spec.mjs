import { test, expect, control, login, requests } from './support.mjs';
import { chartReady } from './pages.mjs';
import { createFixtureData, FIXTURE_DAY } from './fixtures.mjs';

test('历史加载中的3秒自动轮询跨过4.2秒响应窗口，不重叠且最终发布日期记录', async ({ page, request }) => {
  test.setTimeout(35_000);
  const data = createFixtureData();
  const path = '/api/ashare-trade-side-history';
  const ready = {
    ok: true, code: '600851', rows: data.tradeRows, latest: data.tradeRows.at(-1),
    source: { key: 'fixture', name: '合成盘后历史' },
    realtimeSource: { key: 'fixture', name: '合成腾讯行情' },
    collection: { days: data.tradeRows.length },
    history: { status: 'ready', done: data.tradeRows.length, total: data.tradeRows.length },
  };
  const loading = {
    ...ready, rows: [], latest: null, collection: { days: 0 },
    history: { status: 'loading', done: 0, total: data.tradeRows.length },
  };
  await control(request, {
    reset: true,
    routeRules: [
      { path, method: 'GET', search: { code: '600851' }, times: 1, status: 200, body: loading },
      { path, method: 'GET', search: { code: '600851' }, delayMs: 4200, status: 200, body: ready },
    ],
  });
  // The data is deliberately fixed. Freeze the calendar only; normal interval
  // timers still run, so this exercises the real three-second polling path.
  await page.clock.setFixedTime(new Date(`${FIXTURE_DAY}T08:00:00Z`));
  await login(page);
  await page.getByRole('tab', { name: '内外盘历史', exact: true }).click();
  const panel = page.getByTestId('trade-side-history');
  await expect(panel.getByRole('status')).toContainText('正在读取官方历史文件');
  await chartReady(page);
  const historyRequests = async () => (await requests(request, path)).filter(item => item.query.code === '600851');

  // No refresh button is clicked: the second request must be the automatic
  // poll enabled by the first response's history.status === 'loading'.
  await expect.poll(async () => (await historyRequests()).length, { timeout: 10_000 }).toBe(2);
  const firstTwo = await historyRequests();
  expect(firstTwo[0].status).toBe(200);
  expect(firstTwo[0].completedAt).toBeTruthy();
  expect(firstTwo[1].delayMs).toBe(4200);
  expect(Date.parse(firstTwo[1].time) - Date.parse(firstTwo[0].completedAt)).toBeGreaterThanOrEqual(2900);

  // Check beyond the next 3s tick while the 4.2s response is pending. If the
  // runner wakes after completion, the final request log still proves that
  // no overlapping third request occurred during that entire window.
  await expect.poll(async () => {
    const seen = await historyRequests();
    if (seen.length > 2) return 'overlapping-request';
    if (seen.length !== 2 || Date.now() - Date.parse(seen[1].time) < 3300) return 'before-next-tick';
    return 'one-poll-across-next-tick';
  }, { timeout: 8000, intervals: [100, 200] }).toBe('one-poll-across-next-tick');

  await expect(panel.getByRole('cell', { name: FIXTURE_DAY, exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '刷新内外盘历史', exact: true })).toBeEnabled();
  const finished = await historyRequests();
  expect(finished, '只能有初次请求和一个自动轮询，不能出现重叠的第三次请求').toHaveLength(2);
  expect(finished[1].status).toBe(200);
  expect(finished[1].aborted).not.toBe(true);
  expect(Date.parse(finished[1].completedAt) - Date.parse(finished[1].time)).toBeGreaterThanOrEqual(4000);
});
