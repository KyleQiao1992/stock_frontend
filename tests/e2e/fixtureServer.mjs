import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiFixture, createFixtureData, FIXTURE_DAY, remoteFixture } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(root, 'src') + path.sep;
const HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stock isolated E2E</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>';
const CSP = "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'";
const defaultState = () => ({ mode: 'ok', role: 'admin', failUsersPage2: false, failFactorPage2: false, delayPaths: {}, failPaths: {}, overrides: {}, routeRules: [] });
const clone = value => structuredClone(value);
const errorResponse = (status, error) => ({ status, body: { ok: false, error } });

function send(res, response) {
  if (res.destroyed || res.writableEnded) return;
  const { status = 200, body, contentType = 'application/json; charset=utf-8', headers = {} } = response;
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw Object.assign(new Error('Fixture request body exceeds 1MB'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Fixture request body must be valid JSON'), { status: 400 }); }
}

// Request logs deliberately omit credentials, including synthetic passwords/tokens.
function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|token|authorization|secret/i.test(key) ? '[redacted]' : sanitized(item)]));
}

function responseOverride(value, fallbackStatus = 200) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'body')) return { status: fallbackStatus, ...clone(value) };
  return { status: fallbackStatus, body: clone(value) };
}

function ruleMatches(rule, url, method) {
  if (!rule || (rule.path || rule.pathname) !== url.pathname || (rule.method && rule.method.toUpperCase() !== method)) return false;
  if (rule.times !== undefined && rule.times <= 0) return false;
  const query = rule.search || rule.query;
  if (typeof query === 'string' && query.replace(/^\?/, '') !== url.search.slice(1)) return false;
  if (query && typeof query === 'object' && Object.entries(query).some(([key, value]) => url.searchParams.get(key) !== String(value))) return false;
  return true;
}

/**
 * Serve the complete production App with synthetic HTTP fixtures only.
 *
 * const server = await startFixtureServer({ port: 0 });
 * await server.control({ delayPaths: { '/api/hk-kline': 100 } });
 * server.requests; // [{id, path, search, query, method, body, status, ...}]
 * await server.close();
 *
 * control({reset:true,...patch}) resets fixture data, control state and requests.
 * failPaths maps exact paths to true, a status number, an error string, or
 * {status, body}; overrides maps exact paths to a body or {status, body}.
 * routeRules are first-match rules with path, optional method, search object,
 * delayMs, hold name, times and optional status/body/headers/contentType.
 * A request snapshots its response before a delay, so later state changes
 * cannot turn an older request into a newer response during a race test.
 * release(name) or control({release:name}) settles named held requests.
 * mode:'loading' holds non-auth requests until mode changes; error => 503.
 * Explicit failPaths/rules also apply to auth endpoints.
 */
export async function startFixtureServer({ port = 0, initialState = {} } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw new TypeError('Fixture port must be an integer between 0 and 65535');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'stock-e2e-vite-'));
  let data = createFixtureData(), state = defaultState(), origin = '', closed = false, nextId = 1;
  const requests = [], pending = new Set();
  let vite, http;

  function release(name) {
    for (const waiting of [...pending]) if (name === undefined || waiting.name === name) waiting.finish();
  }

  function resetRequests() { requests.splice(0); nextId = 1; }

  function control(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Control patch must be an object');
    if (patch.mode !== undefined && !['ok', 'error', 'loading'].includes(patch.mode)) throw new TypeError('Invalid fixture mode');
    if (patch.role !== undefined && !['admin', 'user'].includes(patch.role)) throw new TypeError('Invalid fixture role');
    for (const key of ['delayPaths', 'failPaths', 'overrides']) if (patch[key] !== undefined && (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key]))) throw new TypeError(`${key} must be an object`);
    if (patch.routeRules !== undefined && !Array.isArray(patch.routeRules)) throw new TypeError('routeRules must be an array');
    if (patch.reset) {
      release(); data = createFixtureData(); state = defaultState(); resetRequests();
    }
    const { release: releaseNames, clearRequests, ...changes } = patch;
    delete changes.reset;
    Object.assign(state, clone(changes));
    data.user.role = state.role;
    if (state.mode !== 'loading') release('__mode_loading__');
    if (releaseNames !== undefined) for (const name of Array.isArray(releaseNames) ? releaseNames : [releaseNames]) release(name);
    if (clearRequests) resetRequests();
    return { ok: true, ...clone(state) };
  }

  function wait(res, record, { delayMs = 0, name } = {}) {
    if (closed || res.destroyed) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const waiting = {
        name,
        finish() {
          clearTimeout(timer); pending.delete(waiting); res.off('close', waiting.finish); resolve();
        },
      };
      pending.add(waiting);
      record.held = name || null;
      res.once('close', waiting.finish);
      if (!name) timer = setTimeout(waiting.finish, delayMs);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    try {
      if (url.pathname === '/__audit/control') {
        if (req.method === 'POST') return send(res, { body: control(await readBody(req)) });
        if (req.method === 'GET') return send(res, { body: { ok: true, ...clone(state) } });
        return send(res, errorResponse(404, 'Unsupported control method'));
      }
      if (url.pathname === '/__audit/requests' && req.method === 'GET') return send(res, { body: { requests } });
      if (url.pathname === '/__audit/manifest' && req.method === 'GET') return send(res, { body: {
        fixture: true, day: FIXTURE_DAY, state, candleCount: data.candles.length,
        sample: { user: data.user, favorite: data.favorites.ashare[0], candle: data.candles.at(-1), industry: data.industries[0], factor: data.factors[0], tradeSide: data.tradeRows.at(-1) },
      } });
      if (url.pathname === '/__audit/source' && req.method === 'GET') return send(res, { body: '<!doctype html><title>Synthetic source</title><p>仅用于端到端测试的合成研究资料。</p>', contentType: 'text/html; charset=utf-8' });
      if (url.pathname === '/' && req.method === 'GET') {
        res.setHeader('Content-Security-Policy', CSP);
        const html = (await vite.transformIndexHtml('/', HTML)).replace(/<script\b[^>]*\bsrc=["']\/@vite\/client["'][^>]*>\s*<\/script>/g, '');
        return send(res, { body: html, contentType: 'text/html; charset=utf-8' });
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__audit/remote/')) {
        const body = await readBody(req);
        const record = { id: nextId++, time: new Date().toISOString(), path: url.pathname, search: url.search,
          query: sanitized(Object.fromEntries(url.searchParams)), method: req.method, body: sanitized(body), mode: state.mode };
        requests.push(record);
        const auth = url.pathname.startsWith('/api/auth/');
        const rule = state.routeRules.find(candidate => ruleMatches(candidate, url, req.method));
        if (rule?.times !== undefined) rule.times -= 1;
        const delayMs = Math.max(0, Number(rule?.delayMs ?? state.delayPaths[url.pathname] ?? 0) || 0);
        const mode = state.mode;
        const fixtureResponse = fixtureData => url.pathname.startsWith('/api/')
          ? apiFixture({ data: fixtureData, url, body, method: req.method, headers: req.headers, state })
          : remoteFixture({ data: fixtureData, url, method: req.method });
        let response;
        if (rule && (Object.hasOwn(rule, 'body') || rule.status !== undefined)) response = responseOverride({
          status: rule.status || 200, body: Object.hasOwn(rule, 'body') ? rule.body : { ok: false, error: '模拟接口失败' },
          ...(rule.contentType ? { contentType: rule.contentType } : {}), ...(rule.headers ? { headers: rule.headers } : {}),
        });
        else if (Object.hasOwn(state.failPaths, url.pathname) && state.failPaths[url.pathname]) {
          const failure = state.failPaths[url.pathname];
          response = typeof failure === 'object' ? responseOverride(failure, 503) : errorResponse(typeof failure === 'number' ? failure : 503, typeof failure === 'string' ? failure : '模拟数据源请求失败（隔离测试）');
        } else if (Object.hasOwn(state.overrides, url.pathname)) response = responseOverride(state.overrides[url.pathname]);
        else if (mode === 'error' && !auth) response = fixtureResponse(clone(data)) ? errorResponse(503, '模拟数据源请求失败（隔离测试）') : null;
        else response = fixtureResponse(data);
        // An unsupported route must never silently look like a working empty API.
        const unimplemented = response === null;
        response = clone(response || errorResponse(404, `Unimplemented fixture: ${req.method} ${url.pathname}`));
        record.delayMs = delayMs;
        res.once('close', () => {
          if (!res.writableFinished) { record.aborted = true; record.completedAt = new Date().toISOString(); }
        });
        if (delayMs) await wait(res, record, { delayMs });
        if (rule?.hold) await wait(res, record, { name: String(rule.hold) });
        if (mode === 'loading' && !auth && !unimplemented && state.mode === 'loading') await wait(res, record, { name: '__mode_loading__' });
        if (closed || res.destroyed) return;
        record.status = response.status || 200;
        record.completedAt = new Date().toISOString();
        send(res, response);
        return;
      }
      if (url.pathname.startsWith('/__audit/') || url.pathname.startsWith('/server/') || /(?:^|\/)\.env(?:\.|$)/.test(url.pathname)) return send(res, errorResponse(404, 'Not served by fixture server'));
      vite.middlewares(req, res, () => send(res, errorResponse(404, `Not found: ${url.pathname}`)));
    } catch (error) {
      send(res, errorResponse(error.status || 500, error.message));
    }
  }

  try {
    control(initialState);
    vite = await createViteServer({
      root, configFile: false, envFile: false, envDir: false, envPrefix: '__E2E_SYNTHETIC_PUBLIC_',
      cacheDir, mode: 'test', appType: 'custom', logLevel: 'error',
      resolve: { alias: { '@': path.join(root, 'src') } },
      plugins: [{
        name: 'e2e-isolated-provider-urls', enforce: 'pre',
        transform(source, id) {
          // Vite's CSS runtime imports its client even with hmr:false/ws:false.
          // Retain the actual CSS runtime but disable its unused HMR connection.
          // Never suppress application console errors or broaden the CSP.
          if (id.replaceAll('\\', '/').split('?')[0].endsWith('/vite/dist/client/client.mjs')) {
            const connect = 'transport.connect(createHMRHandler(handleMessage));';
            if (!source.includes(connect)) throw new Error('Vite client changed: review the E2E HMR disable transform');
            return source.replace(connect, '// HMR transport is intentionally disabled in isolated E2E.');
          }
          if (!id.startsWith(sourceRoot) || !/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return null;
          return source.replace(/https?:\/\/([A-Za-z0-9._-]+)(?::\d+)?/g, (_url, host) => `${origin}/__audit/remote/${host}`);
        },
      }, react(), tailwindcss()],
      server: { middlewareMode: true, hmr: false, ws: false, host: '127.0.0.1', fs: { strict: true, allow: [root] } },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react', 'react-markdown', 'remark-gfm'] },
    });
    http = createHttpServer((req, res) => { void handle(req, res); });
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(Number(port), '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
    origin = `http://127.0.0.1:${http.address().port}`;
    return {
      origin, requests, control, resetRequests, release,
      async close() {
        if (closed) return;
        closed = true; release();
        const stopping = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        http.closeAllConnections();
        await Promise.all([stopping, vite.close()]);
        await rm(cacheDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closed = true; release();
    await vite?.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await startFixtureServer({ port: Number(process.env.E2E_PORT || 5198) });
  console.log(`E2E_FIXTURE_READY ${server.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
}
