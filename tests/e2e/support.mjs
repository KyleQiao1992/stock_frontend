import { test as base, expect } from 'playwright/test';
import { FIXTURE_DAY } from './fixtures.mjs';

export const test = base.extend({
  audit: [async ({ page, context, baseURL }, use, testInfo) => {
    const audit = { errors: [], network: [], requests: [], allowedHttp: [], allowedAlerts: false };
    const pending = new Map();
    page.on('request', request => {
      const record = { path: new URL(request.url()).pathname, method: request.method(),
        started: performance.now(), status: null, durationMs: null, outcome: 'pending' };
      audit.requests.push(record); pending.set(request, record);
    });
    const finish = (request, outcome) => {
      const record = pending.get(request);
      if (!record) return;
      record.durationMs = Math.round((performance.now() - record.started) * 10) / 10;
      record.outcome = outcome;
      pending.delete(request);
    };
    // Keep date-range fixtures stable next month/year while preserving real
    // elapsed timers, including the production 3s poll and 30s deadline.
    await page.clock.setFixedTime(new Date(`${FIXTURE_DAY}T08:00:00Z`));
    const origin = new URL(baseURL).origin;
    // Isolated regression tests must never call a real data provider.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      audit.errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    });
    page.on('pageerror', error => audit.errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      audit.errors.push({ type: message.type(), message: message.text(), url: message.location().url });
    });
    page.on('response', response => {
      const record = pending.get(response.request());
      if (record) record.status = response.status();
      if (response.status() >= 400) audit.network.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    page.on('requestfinished', request => finish(request, 'completed'));
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText || '';
      finish(request, /ERR_ABORTED|NS_BINDING_ABORTED/.test(error) ? 'cancelled' : 'transport-error');
      // Navigation/unmount intentionally cancels requests. Every other transport failure fails.
      if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(error)) audit.errors.push(`requestfailed ${new URL(request.url()).pathname}: ${error}`);
    });
    await use(audit);
    const allowed = (path, status) => audit.allowedHttp.some(item => item.path === path && item.status === status);
    const failures = audit.network.filter(item => !allowed(item.path, item.status));
    const errors = audit.errors.filter(item => {
      if (typeof item === 'string') return true;
      if (!/Failed to load resource/.test(item.message)) return true;
      const path = item.url ? new URL(item.url).pathname : '';
      return !audit.network.some(item => item.path === path && allowed(item.path, item.status));
    });
    const network = audit.requests.map(({ started, ...record }) => ({ ...record,
      durationMs: record.durationMs ?? Math.round((performance.now() - started) * 10) / 10 }));
    await testInfo.attach('browser-audit.json', { body: JSON.stringify({ errors: audit.errors, responses: audit.network, requests: network }, null, 2), contentType: 'application/json' });
    expect(failures, 'Unexpected HTTP failures').toEqual([]);
    expect(errors, 'Browser errors/warnings').toEqual([]);
    if (!audit.allowedAlerts && !page.isClosed()) {
      await expect(page.getByRole('alert'), 'Unexpected visible alert').toHaveCount(0);
      await expect(page.getByText('页面遇到异常', { exact: true })).toHaveCount(0);
    }
  }, { auto: true }],
});

export { expect };
export async function control(request, patch) {
  const response = await request.post('/__audit/control', { data: patch });
  expect(response.ok()).toBeTruthy();
}
export async function login(page) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('test_audit');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人菜单' })).toBeVisible();
}
export async function requests(request, path) {
  const response = await request.get('/__audit/requests');
  const data = await response.json();
  return data.requests.filter(item => !path || item.path === path);
}

// Check rendered text geometry, including metric labels/values. Scrolling tables
// are intentional; page-level overflow and clipped text outside them are failures.
export async function assertLayout(page) {
  await page.evaluate(() => document.fonts.ready);
  const issues = await page.evaluate(() => {
    const issues = [];
    const visible = element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) issues.push('document horizontal overflow');
    const ranges = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!node.textContent.trim() || !parent || !visible(parent) || parent.closest('svg,script,style,option,textarea')) continue;
      // Chromium can return Range rectangles for children of a closed details.
      // Those nodes are not painted; its summary remains visible and is checked.
      let hiddenDetails = false;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(parent)) {
          hiddenDetails = true; break;
        }
      }
      if (hiddenDetails) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const layer = parent.closest('[role="dialog"],dialog,[role="tooltip"]') || document.body;
      for (const rect of range.getClientRects()) {
        if (rect.width < 3 || rect.height < 3) continue;
        const painted = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        for (let ancestor = parent; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
          const ellipsis = style.textOverflow === 'ellipsis';
          const lineClamp = Number.parseInt(style.webkitLineClamp, 10) > 0;
          for (const [axis, start, end, overflow, intentional] of [
            ['x', 'left', 'right', style.overflowX, ellipsis],
            ['y', 'top', 'bottom', style.overflowY, lineClamp],
          ]) {
            if (!/^(auto|scroll|hidden|clip)$/.test(overflow)) continue;
            const clipped = painted[start] < bounds[start] - 2 || painted[end] > bounds[end] + 2;
            if (clipped && !/^(auto|scroll)$/.test(overflow) && !intentional) {
              issues.push(`clipped ${axis} text: ${node.textContent.trim().slice(0, 55)}`);
            }
            painted[start] = Math.max(painted[start], bounds[start]);
            painted[end] = Math.min(painted[end], bounds[end]);
          }
          if (painted.right <= painted.left || painted.bottom <= painted.top) break;
        }
        if (painted.right - painted.left > 2 && painted.bottom - painted.top > 2) {
          ranges.push({ layer, node, rect: { ...painted, height: painted.bottom - painted.top }, text: node.textContent.trim().slice(0, 55) });
        }
      }
    }
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      // Chromium emits both the full and displayed fragment for an ellipsized
      // text node. They are one piece of text, not two overlapping labels.
      if (a.layer !== b.layer || a.node === b.node) continue;
      const overlapX = Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left);
      const overlapY = Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top);
      if (overlapX > 2 && overlapY > Math.min(a.rect.height,b.rect.height) * .55) issues.push(`text overlap: ${a.text} / ${b.text} (${a.node === b.node ? 'same text node' : 'different text nodes'}; ${JSON.stringify([a.rect, b.rect])})`);
      if (issues.length >= 15) return issues;
    }
    return issues;
  });
  expect(issues, 'Layout geometry').toEqual([]);
  const svgIssues = await page.evaluate(() => {
    const issues = [];
    for (const svg of document.querySelectorAll('svg[data-kline-period],svg[data-index-trend-chart]')) {
      const candidates = [...svg.querySelectorAll('text')].filter(text =>
        /^(?:MA\d+|BBI|(?:本根)?涨跌|成交量|当前九转|(?:5分钟|30分钟|4小时|日K|周K|月K) ·)/.test(text.textContent.trim())
        || text.querySelector('tspan'));
      const labels = candidates.map(element => ({ label: element.textContent.trim(), rect: element.getBoundingClientRect(), box: element.getBBox() }));
      for (const item of labels) {
        if (item.box.x < -1 || item.box.x + item.box.width > svg.viewBox.baseVal.width + 1) issues.push(`chart label clipped: ${item.label}`);
      }
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (x > 2 && y > Math.min(a.rect.height, b.rect.height) * .55) issues.push(`chart label overlap: ${a.label} / ${b.label}`);
      }
    }
    return issues;
  });
  expect(svgIssues, 'Chart OHLC, MA and indicator header geometry').toEqual([]);
}
