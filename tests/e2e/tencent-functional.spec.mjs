import { readFileSync } from 'node:fs';
import { test, expect, control, login, assertLayout, requests } from './support.mjs';
import { chartReady } from './pages.mjs';

// Public Tencent snapshot: exactly one monthly candle crosses zero after qfq.
// Keep the full response so a smaller retry must not hide the rejected history.
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/tencent-sh600851-qfqmonth.json', import.meta.url), 'utf8'));
const historicalDaily = JSON.parse(readFileSync(new URL('../../src/lib/chan/fixtures/600851-qfq-old-bi-2025.json', import.meta.url), 'utf8'));
const fullDaily = JSON.parse(readFileSync(new URL('../../src/lib/chan/fixtures/600851-qfq-2026-10-27.json', import.meta.url), 'utf8'));
const upstreamSnapshot = JSON.parse(readFileSync(new URL('../../src/lib/chan/fixtures/600851-external-upstream-274f7a2.json', import.meta.url), 'utf8'));

test('海欣笔参考区贯穿核心后仍延伸，形成和离开状态分别展示', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  const bars = fullDaily.map(row => [row.date, String(row.open), String(row.close),
    String(row.high), String(row.low), String(row.volume)]);
  const quote = [];
  quote[1] = '海欣股份';
  const body = { code: 0, data: { sh600851: { qfqday: bars, qt: { sh600851: quote } } } };
  await control(request, { routeRules:
    ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
      path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
      search: { param: 'sh600851,day,,,1000,qfq' }, body, scriptVariableParam: '_var',
    })) });
  await login(page);
  await chartReady(page);
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  const svg = page.locator('svg[data-kline-count]').first();
  await expect(svg.locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', '2026-10-27');
  const zone = svg.locator('[data-chan-zone][data-chan-engine="external"][data-chan-zone-zd="7.55"][data-chan-zone-zg="8.91"]');
  await expect(zone).toHaveCount(1);
  await expect(zone).toHaveAttribute('data-chan-zone-status', 'active');
  await expect(zone).toHaveAttribute('data-chan-zone-phase', 'leaving');
  await expect(zone).toHaveAttribute('data-chan-zone-confirmed-time', '490');
  await expect(zone).toHaveAttribute('data-chan-zone-end', '621');
  await expect(zone).toHaveAttribute('aria-label', /笔.*参考/);
  await expect(page.locator('[aria-label="缠论图例"]')).toContainText('非递归');
  await testInfo.attach('600851-center-lifecycle', { body: await svg.screenshot(), contentType: 'image/png' });
});

test('海欣日K动态笔只连接已知时序，并提示端点K线极值顺序不明', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  await login(page);
  await chartReady(page);
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  const setHistory = async date => {
    const bars = fullDaily.filter(row => row.date <= date)
      .map(row => [row.date, String(row.open), String(row.close), String(row.high), String(row.low), String(row.volume)]);
    const quote = [];
    quote[1] = '海欣股份';
    const body = { code: 0, data: { sh600851: { qfqday: bars, qt: { sh600851: quote } } } };
    await control(request, { routeRules:
      ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
        path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
        search: { param: 'sh600851,day,,,1000,qfq' }, body, scriptVariableParam: '_var',
      })) });
    await page.getByRole('button', { name: '查询', exact: true }).first().click();
    await chartReady(page);
    const svg = page.locator('svg[data-kline-count]').first();
    await expect(svg.locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', date);
    return svg;
  };
  const assertTail = async (svg, startDate, endDate) => {
    const result = await svg.evaluate((node, dates) => {
      const path = node.querySelector('g[data-chan-layer="lines"] path[data-chan-path="bi"]');
      const points = [...path.getAttribute('d').matchAll(/[ML]\s*([^,\s]+),([^\sML]+)/g)]
        .map(match => [+match[1], +match[2]]);
      const start = node.querySelector(`g[data-kline-time="${dates.start}"] > line`);
      const end = node.querySelector(`g[data-kline-time="${dates.end}"] > line`);
      return { points, start: [+start.getAttribute('x1'), +start.getAttribute('y2')],
        end: [+end.getAttribute('x1'), +end.getAttribute('y1')] };
    }, { start: startDate, end: endDate });
    expect(result.points.length).toBeGreaterThanOrEqual(2);
    const start = result.points.at(-2), end = result.points.at(-1);
    expect(start[0]).toBeCloseTo(result.start[0], 6);
    expect(start[1]).toBeCloseTo(result.start[1], 6);
    expect(end[0]).toBeCloseTo(result.end[0], 6);
    expect(end[1]).toBeCloseTo(result.end[1], 6);
    expect(end[0]).toBeGreaterThan(start[0]);
  };
  let svg = await setHistory('2024-06-27');
  await assertTail(svg, '2024-06-26', '2024-06-27');
  await expect(page.locator('[data-chan-pending-uncertainty]')).toHaveCount(0);
  await testInfo.attach('600851-tail-equal-high-next-day', { body: await svg.screenshot(), contentType: 'image/png' });
  svg = await setHistory('2024-12-27');
  await assertTail(svg, '2024-12-25', '2024-12-27');
  const notice = page.locator('[data-chan-pending-uncertainty="endpoint-order"]');
  await expect(notice).toContainText('2024-12-25');
  await expect(notice).toContainText('6.06');
  await expect(notice).toContainText('6.18');
  await expect(notice).toContainText('先后不明');
  await testInfo.attach('600851-tail-endpoint-order-unknown', { body: await svg.screenshot(), contentType: 'image/png' });
});

test('海欣股份日K使用参考引擎绘制笔中枢，切换引擎后结果更新', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  const bars = fullDaily.map(row => [row.date, String(row.open), String(row.close),
    String(row.high), String(row.low), String(row.volume)]);
  const quote = [];
  quote[1] = '海欣股份';
  const body = { code: 0, data: { sh600851: { qfqday: bars, qt: { sh600851: quote } } } };
  await control(request, { routeRules:
    ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
      path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
      search: { param: 'sh600851,day,,,1000,qfq' }, body, scriptVariableParam: '_var',
    })) });
  await login(page);
  await chartReady(page);
  const engine = page.getByRole('combobox', { name: '缠论引擎' });
  await expect(engine).toHaveValue('external');
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  const svg = page.locator('svg[data-kline-count]').first();
  await expect(svg.locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', '2026-10-27');
  const legend = page.locator('[aria-label="缠论图例"]');
  await expect(legend).toContainText('笔构造参考中枢');
  await expect(legend).toContainText('特征序列线段');
  await expect(legend).toContainText('非递归');
  const zone = svg.locator('[data-chan-zone][data-chan-engine="external"]');
  const latest = svg.locator('[data-chan-zone][data-chan-engine="external"][data-chan-zone-zd="7.55"][data-chan-zone-zg="8.91"]');
  await expect(zone).not.toHaveCount(0);
  await expect(latest).toHaveCount(1);
  // The box must intersect the chart's clip, not merely exist offscreen.
  await expect.poll(() => latest.evaluate(rect => {
    const bounds = rect.closest('svg').querySelector('clipPath rect');
    const left = Number(bounds.getAttribute('x'));
    const right = left + Number(bounds.getAttribute('width'));
    const x = Number(rect.getAttribute('x'));
    const width = Number(rect.getAttribute('width'));
    return width > 0 && x < right && x + width > left && Number(rect.getAttribute('height')) > 0;
  })).toBe(true);
  await svg.scrollIntoViewIfNeeded();
  await testInfo.attach('600851-external-center', { body: await svg.screenshot(), contentType: 'image/png' });
  // Expand to the entire supplied history: asserting only the 80-bar viewport
  // misses broken/off-screen line segments or permits hiding all of them.
  await page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]').selectOption(String(fullDaily.length));
  await expect(svg).toHaveAttribute('data-kline-count', String(fullDaily.length));
  const geometry = await svg.evaluate(node => {
    const lines = node.querySelector('g[data-chan-layer="lines"]');
    const parse = d => [...d.matchAll(/[ML]\s*([^,\s]+),([^\sML]+)/g)].map(match => [+match[1], +match[2]]);
    return {
      bi: parse(lines.querySelector('path[data-chan-path="bi"]').getAttribute('d')),
      segments: [...lines.querySelectorAll('path[data-chan-path="segment"]')].map(path => ({
        points: parse(path.getAttribute('d')), label: path.getAttribute('aria-label'),
      })),
      pending: [...lines.querySelectorAll('path[data-chan-path="pending-segment"]')].map(path => ({
        points: parse(path.getAttribute('d')), label: path.getAttribute('aria-label'),
        dash: path.getAttribute('stroke-dasharray'),
      })),
    };
  });
  const samePoint = (left, right) => left && right
    && Math.abs(left[0] - right[0]) < 0.001 && Math.abs(left[1] - right[1]) < 0.001;
  const penIndex = point => geometry.bi.findIndex(candidate => samePoint(point, candidate));
  expect(geometry.bi.length, 'the full history must contain real pen vertices').toBeGreaterThan(30);
  expect(geometry.segments.length, 'hiding broken lines is not a repair').toBeGreaterThanOrEqual(2);
  for (let i = 0; i < geometry.segments.length; i++) {
    const line = geometry.segments[i];
    expect(line.points).toHaveLength(2);
    const [start, end] = line.points;
    expect(end[0], `segment ${i} must go forward in time`).toBeGreaterThan(start[0]);
    const startPen = penIndex(start), endPen = penIndex(end);
    expect(startPen, `segment ${i} start must be a rendered pen endpoint`).toBeGreaterThanOrEqual(0);
    expect(endPen, `segment ${i} end must be a rendered pen endpoint`).toBeGreaterThan(startPen);
    const count = endPen - startPen;
    expect(count, `segment ${i} must contain at least three pens`).toBeGreaterThanOrEqual(3);
    expect(count % 2, `segment ${i} must contain an odd number of alternating pens`).toBe(1);
    expect(line.label).toContain(`${count} 笔`);
    const direction = line.label.includes('向上') ? 'up' : line.label.includes('向下') ? 'down' : null;
    expect(direction, `segment ${i} direction must be labeled`).not.toBeNull();
    if (direction === 'up') expect(end[1]).toBeLessThan(start[1]);
    else expect(end[1]).toBeGreaterThan(start[1]);
    if (i) {
      const previous = geometry.segments[i - 1];
      expect(samePoint(start, previous.points[1]), `segments ${i - 1} and ${i} must meet`).toBe(true);
      expect(direction === 'up' ? previous.label.includes('向下') : previous.label.includes('向上'),
        'successive confirmed segments must alternate direction').toBe(true);
    }
  }
  expect(geometry.pending, 'the developing candidate is shown separately').toHaveLength(1);
  expect(geometry.pending[0].label).toContain('未确认');
  expect(geometry.pending[0].dash).toBeTruthy();
  expect(samePoint(geometry.pending[0].points[0], geometry.segments.at(-1).points[1]),
    'the developing candidate starts at the last confirmed segment end').toBe(true);
  await testInfo.attach('600851-external-full-history', { body: await svg.screenshot(), contentType: 'image/png' });
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  const outlook = page.getByLabel('缠论结构研判', { exact: true });
  await expect(outlook).toContainText('修正结构参考');
  await expect(outlook).toContainText('不是递归走势中枢');
  const recursive = page.getByLabel('递归走势中枢状态', { exact: true });
  await expect(recursive).toHaveAttribute('data-chan-recursive-status', 'undetermined');
  await expect(recursive).toContainText('2 条已确认线段');
  await expect(recursive).toContainText('0 个已确定的线段构造中枢');
  await expect(recursive).toContainText('更高级别走势中枢尚未判定');
  await expect(outlook).toContainText('确认依据K');
  await expect(page.getByLabel('修正结构研判范围', { exact: true })).toContainText('不能作为当前图的信号');
  await engine.selectOption('upstream');
  await expect(legend).toContainText('开源原版对照');
  await expect(legend).toContainText('简化线段');
  await expect(legend).toContainText('非递归');
  await expect(legend).toContainText('最新K线未提供收盘状态');
  await expect(svg.locator('[data-chan-upstream-pen]')).toHaveCount(51);
  await expect(svg.locator('[data-chan-upstream-segment]')).toHaveCount(9);
  await expect(svg.locator('[data-chan-upstream-zone]')).toHaveCount(13);
  await expect(svg.locator('[data-chan-upstream-fractal]')).toHaveCount(upstreamSnapshot.fractals.length);
  await expect(svg.locator('[data-chan-upstream-endpoint]')).toHaveCount(52);
  await expect(svg.locator('[data-chan-zone][data-chan-engine="external"]')).toHaveCount(0);
  const upstreamZone = svg.locator('[data-chan-upstream-zone="12"]');
  await expect(upstreamZone).toHaveAttribute('data-chan-zone-zd', '8.13');
  await expect(upstreamZone).toHaveAttribute('data-chan-zone-zg', '9.4');
  await expect(upstreamZone).toHaveAttribute('aria-label', /GG 9.43 \/ DD 7.35/);
  const upstreamLines = await svg.locator('[data-chan-upstream-segment]').evaluateAll(lines => lines.map(line => ({
    path: line.getAttribute('d'), done: line.getAttribute('data-chan-upstream-done'), label: line.getAttribute('aria-label'),
  })));
  expect(upstreamLines.filter(line => line.done === 'true')).toHaveLength(8);
  expect(upstreamLines[0].label).toContain('2024-04-16 @ 4.815');
  expect(upstreamLines[0].label).toContain('2024-09-18 @ 4.5');
  expect(upstreamLines[1].label).toContain('2024-09-09 @ 5.01');
  expect(upstreamLines[0].label).toContain('未提供确认依据时刻');
  const coordinate = d => [...d.matchAll(/[ML]\s*([^,\s]+),([^\sML]+)/g)].map(match => [+match[1], +match[2]]);
  expect(coordinate(upstreamLines[0].path)[1]).not.toEqual(coordinate(upstreamLines[1].path)[0]);
  const mappedPaths = await svg.evaluate((node, expected) => {
    const bars = [...node.querySelectorAll('g[data-kline-time]')];
    const parse = d => [...d.matchAll(/[ML]\s*([^,\s]+),([^\sML]+)/g)].map(match => [+match[1], +match[2]]);
    const scaleBar = bars.findIndex((_, i) => expected.rows[i].high !== expected.rows[i].low);
    const scaleLine = bars[scaleBar].querySelector('line');
    const hi = +scaleLine.getAttribute('y1'), lo = +scaleLine.getAttribute('y2');
    const row = expected.rows[scaleBar];
    const y = value => hi + (row.high - value) * (lo - hi) / (row.high - row.low);
    const check = (selector, records) => [...node.querySelectorAll(selector)].map((line, i) => {
      const actual = parse(line.getAttribute('d'));
      const record = records[i];
      const x0 = +bars[record.i0].querySelector('line').getAttribute('x1');
      const x1 = +bars[record.i1].querySelector('line').getAttribute('x1');
      return Math.max(Math.abs(actual[0][0] - x0), Math.abs(actual[0][1] - y(record.p0)),
        Math.abs(actual[1][0] - x1), Math.abs(actual[1][1] - y(record.p1)));
    });
    return { pens: check('[data-chan-upstream-pen]', expected.pens),
      segments: check('[data-chan-upstream-segment]', expected.segments) };
  }, { rows: fullDaily, pens: upstreamSnapshot.bis, segments: upstreamSnapshot.segments });
  expect(mappedPaths.pens).toHaveLength(51);
  expect(mappedPaths.segments).toHaveLength(9);
  expect(Math.max(...mappedPaths.pens, ...mappedPaths.segments)).toBeLessThan(0.01);
  await expect(outlook).toContainText('开源原版对照');
  await expect(outlook).toContainText('51 笔');
  await expect(outlook).toContainText('13 个笔中枢');
  await expect(outlook).toContainText('不是递归走势中枢');
  await expect(page.getByLabel('递归走势中枢状态', { exact: true })).toHaveCount(0);
  await testInfo.attach('600851-upstream-full-history', { body: await svg.screenshot(), contentType: 'image/png' });
  await engine.selectOption('original');
  await expect(svg.locator('[data-chan-zone][data-chan-engine="external"]')).toHaveCount(0);
  await expect(legend).toContainText('线段中枢');
  await engine.selectOption('external');
  await expect(latest).toHaveCount(1);
  await page.getByRole('checkbox', { name: '中枢', exact: true }).uncheck();
  await expect(svg.locator('[data-chan-zone][data-chan-engine="external"]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '中枢', exact: true }).check();
  await expect(latest).toHaveCount(1);
});

test('海欣股份日K显示可单独关闭的笔构造参考中枢', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  await login(page);
  await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  const bars = fullDaily.map(row => [row.date, String(row.open), String(row.close),
    String(row.high), String(row.low), String(row.volume)]);
  const quote = [];
  quote[1] = '海欣股份';
  const body = { code: 0, data: { sh600851: { qfqday: bars, qt: { sh600851: quote } } } };
  await control(request, { routeRules:
    ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
      path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
      search: { param: 'sh600851,day,,,1000,qfq' }, body, scriptVariableParam: '_var',
    })) });
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  const svg = page.locator('svg[data-kline-count]').first();
  await expect(svg.locator('g[data-kline-time]').last()).toHaveAttribute('data-kline-time', '2026-10-27');
  const reference = svg.locator('[data-chan-pen-zone="pen-zs-446-487"]');
  await expect(reference).toHaveAttribute('data-chan-zone-zd', '7.55');
  await expect(reference).toHaveAttribute('data-chan-zone-zg', '8.91');
  await expect(reference).toHaveAttribute('aria-label', /笔构造参考中枢/);
  await expect(page.locator('[aria-label="缠论图例"]')).toContainText('非递归走势中枢');
  const toggle = page.getByRole('checkbox', { name: '笔构造参考', exact: true });
  await toggle.uncheck();
  await expect(svg.locator('[data-chan-pen-zone]')).toHaveCount(0);
  await toggle.check();
  await expect(reference).toBeAttached();
  await svg.screenshot({ path: testInfo.outputPath('600851-pen-center-reference.png') });
});

test('海欣股份日K短反转回退：新笔确认后旧起点撤回且更早笔保留', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  await login(page);
  await chartReady(page);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  const setHistory = async date => {
    const rows = historicalDaily.filter(row => row.date <= date)
      .map(row => [row.date, String(row.open), String(row.close), String(row.high), String(row.low), String(row.volume)]);
    const quote = [];
    quote[1] = '海欣股份';
    const body = { code: 0, data: { sh600851: { qfqday: rows, qt: { sh600851: quote } } } };
    await control(request, { routeRules:
      ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
        path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
        search: { param: 'sh600851,day,,,1000,qfq' }, body, scriptVariableParam: '_var',
      })) });
    await page.getByRole('button', { name: '查询', exact: true }).first().click();
    await chartReady(page);
    await expect(page.locator('svg[data-kline-count]').first().locator('g[data-kline-time]').last())
      .toHaveAttribute('data-kline-time', date);
  };
  await page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true }).fill('600851');
  await setHistory('2025-04-08');
  let svg = page.locator('svg[data-kline-count]').first();
  await expect(svg.locator('[data-chan-endpoint="255:5.9"]')).toBeAttached();
  await expect(svg.locator('[data-chan-endpoint="263:7.24"]')).toBeAttached();
  await setHistory('2025-06-13');
  svg = page.locator('svg[data-kline-count]').first();
  await expect(svg.locator('[data-chan-endpoint="193:8.49"]')).toBeAttached();
  await expect(svg.locator('[data-chan-endpoint="211:5.11"]')).toBeAttached();
  await expect(svg.locator('[data-chan-endpoint="305:7.47"]')).toBeAttached();
  await expect(svg.locator('[data-chan-endpoint="255:5.9"]')).toHaveCount(0);
  await expect(svg.locator('[data-chan-endpoint="263:7.24"]')).toHaveCount(0);
  await svg.screenshot({ path: testInfo.outputPath('600851-pen-recalculation.png') });
});

test('腾讯前复权月K保留负历史价格和完整历史，负价蜡烛仍在主图区内', async ({ page, request }, testInfo) => {
  await control(request, { reset: true });
  await login(page);
  await chartReady(page);
  const quote = [];
  quote[1] = '海欣股份';
  const body = { code: 0, data: { sh600851: { qfqmonth: snapshot.rows, qt: { sh600851: quote } } } };
  await control(request, { routeRules:
    ['proxy.finance.qq.com/ifzqgtimg', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'].map(host => ({
      path: `/__audit/remote/${host}/appstock/app/fqkline/get`,
      search: { param: 'sh600851,month,,,1000,qfq' },
      body, scriptVariableParam: '_var',
    })) });
  const search = page.getByPlaceholder('代码 / 简称 / 拼音首字母', { exact: true });
  await search.fill('600851');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await chartReady(page);
  await page.getByRole('combobox', { name: 'K线周期' }).selectOption('103');
  await chartReady(page);
  const svg = page.locator('svg[data-kline-period]').first();
  await expect(svg).toHaveAttribute('data-kline-period', '103');
  const legend = page.locator('[aria-label="缠论图例"]');
  await expect(legend).toContainText(`全部已加载 ${snapshot.rows.length} 根K线参与计算`);
  await expect(legend).not.toContainText('不支持非正价格');
  await page.locator('select[title="也可在 K 线图内滚动鼠标滚轮调整"]').selectOption(String(snapshot.rows.length));
  await expect(svg).toHaveAttribute('data-kline-count', String(snapshot.rows.length));
  const repairedPen = await svg.locator('path[data-chan-path="bi"]').getAttribute('d');
  expect(repairedPen, 'the external center mode must calculate pens across valid negative adjusted history').toBeTruthy();
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect(page.getByText(`全部已加载 ${snapshot.rows.length} 根K线参与计算`, { exact: false }).first()).toBeAttached();
  await expect(svg.locator('path[data-chan-path="bi"]')).toHaveAttribute('d', repairedPen);
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('upstream');
  await expect(legend).toContainText('收盘价不是正数');
  await expect(legend).toContainText('不能静默改变行情');
  await expect(svg.locator('[data-chan-upstream-pen]')).toHaveCount(0);
  await page.getByRole('tab', { name: '缠论研判', exact: true }).click();
  await expect(page.getByLabel('缠论结构研判', { exact: true })).toContainText('收盘价不是正数');
  await expect(page.getByLabel('个股分析', { exact: true })).toContainText('行情不满足当前引擎输入要求');
  await expect(page.getByLabel('个股分析', { exact: true })).not.toContainText('行情包含无效K线');
  await page.getByRole('combobox', { name: '缠论引擎' }).selectOption('original');
  await expect(svg.locator('path[data-chan-path="bi"]')).toHaveAttribute('d', repairedPen);
  const negative = svg.locator('g[data-kline-time="1994-07-29"]');
  await expect(negative).toHaveAttribute('data-kline-close', '-0.074');
  const geometry = await negative.evaluate(candle => {
    const bounds = candle.closest('svg').querySelector('clipPath > rect');
    const wick = candle.querySelector('line');
    return { top: bounds.y.baseVal.value, bottom: bounds.y.baseVal.value + bounds.height.baseVal.value,
      high: wick.y1.baseVal.value, low: wick.y2.baseVal.value };
  });
  expect(geometry.high).toBeGreaterThanOrEqual(geometry.top);
  expect(geometry.low).toBeLessThanOrEqual(geometry.bottom);
  expect(geometry.high).toBeLessThan(geometry.low);
  const sourceRequests = (await requests(request)).filter(item => item.path.endsWith('/fqkline/get')
    && item.query.param?.startsWith('sh600851,month,'));
  expect(sourceRequests.map(item => item.query.param)).toEqual(['sh600851,month,,,1000,qfq']);
  await assertLayout(page);
  await svg.screenshot({ path: testInfo.outputPath('tencent-qfq-negative-month.png') });
});
