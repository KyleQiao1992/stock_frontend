import { writeFile } from 'node:fs/promises';

// Read-only browser diagnostics shared by real-service acceptance and the
// isolated guard tests. This module never intercepts requests or reads storage,
// headers, request/response bodies, cookies, or browser authentication state.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError']);
const ABORT_CODES = new Set(['ERR_ABORTED', 'NS_BINDING_ABORTED']);
const NETWORK_CODES = new Set([
  ...ABORT_CODES, 'ERR_FAILED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED', 'ERR_EMPTY_RESPONSE', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_RESPONSE', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID',
  'ERR_SSL_PROTOCOL_ERROR', 'NS_ERROR_FAILURE', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_CONNECTION_REFUSED',
]);

export async function attachBrowserAudit(testInfo, report) {
  const path = testInfo.outputPath('browser-audit.json');
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach('browser-audit.json', { path, contentType: 'application/json' });
}

function safePath(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.pathname : '';
  } catch { return ''; }
}

function failureCode(value) {
  const code = String(value || '').match(/\b(?:ERR_[A-Z_]+|NS_[A-Z_]+)\b/)?.[0];
  return NETWORK_CODES.has(code) ? code : 'transport-failure';
}

function errorLocation(error) {
  // Do not retain the exception message/stack: either may embed credentials or
  // arbitrary application objects. Keep only its first source location.
  for (const line of String(error.stack || '').split('\n').slice(1)) {
    const match = line.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
    if (match) return { path: safePath(match[1]), line: Number(match[2]), column: Number(match[3]) };
  }
  return { path: '', line: null, column: null };
}

export function startBrowserAudit(page, { origin, readOnlyApi = true, scanIntervalMs = 200 } = {}) {
  const expectedOrigin = new URL(origin).origin;
  const started = performance.now();
  const requests = [];
  const active = new Map();
  const events = [];
  const alerts = new Map();
  const navigationEvidence = new Map();
  const transitions = [];
  let nextRequestId = 1;
  let lastNavigation = null;
  let stopped = false;
  let scanning;
  const elapsed = () => Math.round((performance.now() - started) * 10) / 10;

  function onRequest(request) {
    const record = {
      id: nextRequestId++, path: safePath(request.url()), method: request.method(),
      resourceType: request.resourceType(), startedMs: elapsed(), status: null,
      durationMs: null, outcome: 'pending',
    };
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      lastNavigation = record.id;
      navigationEvidence.set(record.id, { committed: false, request: record });
      // Only requests already pending when a real document navigation starts
      // can become normal navigation cancellations. Timeouts and SPA aborts
      // without that evidence remain failures.
      for (const pending of active.values()) pending.cancelledByNavigation = record.id;
    }
    if (readOnlyApi && new URL(request.url()).origin === expectedOrigin
      && record.path.startsWith('/api/') && !READ_METHODS.has(record.method)) {
      events.push({ type: 'forbidden-write', requestId: record.id, path: record.path, method: record.method, atMs: elapsed() });
    }
    requests.push(record);
    active.set(request, record);
  }

  function onResponse(response) {
    const record = active.get(response.request());
    if (!record) return;
    record.status = response.status();
    if (record.status >= 400) record.outcome = 'http-error';
  }

  function finishRequest(request, failed) {
    const record = active.get(request);
    if (!record) return;
    record.durationMs = Math.max(0, Math.round((elapsed() - record.startedMs) * 10) / 10);
    if (failed) {
      record.failureCode = failureCode(request.failure()?.errorText);
      record.outcome = 'transport-error';
    } else record.outcome = record.status >= 400 ? 'http-error' : 'completed';
    active.delete(request);
  }

  function onFrameNavigated(frame) {
    if (frame !== page.mainFrame()) return;
    const evidence = navigationEvidence.get(lastNavigation);
    if (evidence && evidence.request.path === safePath(frame.url())
      && evidence.request.status >= 200 && evidence.request.status < 400) evidence.committed = true;
  }

  function onConsole(message) {
    if (!['error', 'warning'].includes(message.type())) return;
    const location = message.location();
    const resourceFailure = message.text().startsWith('Failed to load resource:');
    const issue = {
      type: 'console', level: message.type(), category: resourceFailure ? 'resource-load-failure' : 'console-message',
      path: safePath(location.url), line: location.lineNumber, column: location.columnNumber, atMs: elapsed(),
    };
    if (resourceFailure) {
      const code = failureCode(message.text());
      if (code !== 'transport-failure') issue.failureCode = code;
      const status = message.text().match(/\b([45]\d{2})\b/);
      if (status) issue.status = Number(status[1]);
    }
    // Arbitrary console text/arguments are deliberately never retained.
    events.push(issue);
  }

  function onPageError(error) {
    events.push({ type: 'pageerror', name: ERROR_NAMES.has(error.name) ? error.name : 'Error', ...errorLocation(error), atMs: elapsed() });
  }

  async function scanVisibleAlerts() {
    if (page.isClosed()) return;
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        const counts = await page.evaluate(() => {
          const visible = element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const exactVisible = label => [...document.querySelectorAll('div,p,span')]
            .some(element => element.textContent?.trim() === label && visible(element));
          return {
            'role-alert': [...document.querySelectorAll('[role~="alert"]')].filter(visible).length,
            'app-render-error': Number(exactVisible('页面遇到异常')),
            'factor-render-error': Number(exactVisible('因子研究页面加载异常')),
          };
        });
        const path = safePath(page.url());
        for (const [kind, count] of Object.entries(counts)) {
          if (!count) continue;
          const key = `${path}:${kind}`;
          const previous = alerts.get(key);
          alerts.set(key, { type: 'visible-alert', kind, path, count: Math.max(count, previous?.count || 0), atMs: previous?.atMs ?? elapsed() });
        }
      } catch (error) {
        // A navigation can replace the execution context during a read-only
        // scan. Every other monitor failure is itself an acceptance failure.
        if (!page.isClosed() && !/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/.test(error.message)) {
          events.push({ type: 'monitor-error', category: 'alert-scan-failed', path: safePath(page.url()), atMs: elapsed() });
        }
      }
    })().finally(() => { scanning = undefined; });
    return scanning;
  }

  const onFinished = request => finishRequest(request, false);
  const onFailed = request => finishRequest(request, true);
  const listeners = { request: onRequest, response: onResponse, requestfinished: onFinished, requestfailed: onFailed, framenavigated: onFrameNavigated, console: onConsole, pageerror: onPageError };
  for (const [name, listener] of Object.entries(listeners)) page.on(name, listener);
  const timer = setInterval(() => { void scanVisibleAlerts(); }, scanIntervalMs);
  timer.unref();

  async function snapshot() {
    await scanVisibleAlerts();
    const network = requests.map(record => {
      const result = { ...record };
      if (result.durationMs === null) result.durationMs = Math.max(0, Math.round((elapsed() - result.startedMs) * 10) / 10);
      const evidence = navigationEvidence.get(result.cancelledByNavigation);
      if (result.outcome === 'transport-error' && ABORT_CODES.has(result.failureCode) && evidence?.committed) {
        result.outcome = 'navigation-cancelled';
      }
      if (result.outcome === 'transport-error' && ABORT_CODES.has(result.failureCode)) {
        const transition = transitions.find(item => item.confirmed && item.candidates.has(result.id) && item.successRequestIds.length);
        if (transition) {
          result.outcome = 'transition-cancelled';
          result.transition = transition.name;
          result.successRequestIds = transition.successRequestIds;
        }
      }
      return result;
    });
    const issues = [...events, ...alerts.values()];
    for (const record of network) {
      if (record.status >= 400) issues.push({ type: 'http-error', requestId: record.id, path: record.path, method: record.method, status: record.status, durationMs: record.durationMs });
      if (record.outcome === 'transport-error') issues.push({ type: 'requestfailed', requestId: record.id, path: record.path, method: record.method, failureCode: record.failureCode, durationMs: record.durationMs });
    }
    return { requests: network, issues, redaction: 'No headers, queries, bodies, storage, console arguments, alert text, exception messages or raw stacks are collected.' };
  }

  return {
    snapshot,
    async transition({ name, cancelPaths, successPaths }, action) {
      if (!/^[a-z0-9-]+$/.test(name) || !cancelPaths?.length || !successPaths?.length) throw new Error('A cancellation transition needs a static name and exact cancellation/success paths.');
      const firstId = nextRequestId;
      const earlierPending = [...active.values()].map(record => record.id);
      const transition = { name, confirmed: false, candidates: new Set(), successRequestIds: [] };
      transitions.push(transition);
      // The action must include the new result's UI readiness assertions. An
      // aborted/failed action never grants cancellation permission.
      const result = await action();
      for (const record of requests) {
        if (record.method !== 'GET') continue;
        if (cancelPaths.includes(record.path) && (record.id >= firstId || earlierPending.includes(record.id))) transition.candidates.add(record.id);
        if (record.id >= firstId && successPaths.includes(record.path) && record.outcome === 'completed'
          && record.status >= 200 && record.status < 300) transition.successRequestIds.push(record.id);
      }
      transition.confirmed = true;
      return result;
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      const report = await snapshot();
      for (const [name, listener] of Object.entries(listeners)) page.off(name, listener);
      return report;
    },
  };
}
