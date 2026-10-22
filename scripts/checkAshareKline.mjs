import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Default runs use explicitly synthetic market responses. --live additionally
// exercises untouched external requests in a fresh, cookie-free browser context.
const liveEnabled = process.argv.includes('--live');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.ASHARE_KLINE_OUTPUT || '/tmp/ashare-kline-check';
const syntheticRows = Array.from({ length: 160 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  const price = 80 + i * 0.04 + Math.sin(i / 5) * 8;
  return [date, price - 0.3, price + 0.3, price + 1, price - 1, 100000 + i];
});
const html = `<!doctype html><html lang="zh-CN" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {fetchAshareKline, Chart} from '/src/components/AShareTD9InteractiveChart.jsx';
import {analyzeChan} from '/src/lib/chan/index.js';
import ChanControls from '/src/components/ChanControls.jsx';
import '/src/index.css';
const defaults={enabled:true,bi:true,segment:true,zs:true,fx:true};
function App(){
 const [state,setState]=useState({status:'ready',data:null,analysis:null,options:defaults,period:'101'});
 window.loadAshareDiagnostic=async (input={})=>{
  const request={code:'688610',period:'101',adjust:'1',limit:1000,...input};
  setState({status:'loading',data:null,analysis:null,options:defaults,period:request.period});
  let phase='fetch';
  try {
   const start=performance.now(),data=await fetchAshareKline(request),fetched=performance.now();
   phase='analysis'; const analysis=analyzeChan(data.klines,request.period),calculated=performance.now();
   setState({status:'loaded',data,analysis,options:defaults,period:request.period});
   for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(resolve));
   return {ok:true,request,name:data.name,sourceInfo:data.sourceInfo,rows:data.klines.length,
    first:data.klines[0].date,last:data.klines.at(-1).date,close:data.klines.at(-1).close,
    requestedBars:analysis.definition.requestedBars,analysisScope:analysis.definition.analysisScope,
    fetchMs:Math.round(fetched-start),analysisMs:Math.round(calculated-fetched)};
  } catch(error){
   setState({status:'error',data:null,analysis:null,options:defaults,period:request.period,error:error.message});
   return {ok:false,request,phase,message:error.message};
  }
 };
 return React.createElement('main',{style:{maxWidth:1150,margin:'20px auto',padding:12}},
  React.createElement('h1',null,'688610 K线加载与缠论诊断'),
  React.createElement('div',{'data-ashare-diagnostic-status':state.status},state.error||state.status),
  React.createElement(ChanControls,{options:state.options,onChange:options=>setState(previous=>({...previous,options}))}),
  state.data&&React.createElement('section',{'data-ashare-diagnostic-chart':state.period},
   React.createElement(Chart,{rows:state.data.klines.slice(-120),fullRows:state.data.klines,
    period:state.period,chanData:state.analysis,chanOptions:state.options})));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
const server = await createServer({ root, configFile: false, appType: 'custom',
  cacheDir: join(tmpdir(), 'ashare-kline-browser-vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [{ name: 'ashare-kline-actual-loader-harness', enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0].endsWith('/src/components/AShareTD9InteractiveChart.jsx')) {
        return `${source}\nexport { fetchAshareKline };\n`;
      }
      return null;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__ashare-kline-check')) return next();
        try {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml(req.url, html));
        } catch (error) { next(error); }
      });
    },
  }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
const report = { synthetic: [], live: [], liveNetwork: [], liveConsole: [], startedAt: new Date().toISOString() };
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.ASHARE_KLINE_BROWSER || (existsSync(chromium.executablePath())
      ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const syntheticContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const synthetic = await syntheticContext.newPage();
  const pageErrors = [];
  synthetic.on('pageerror', error => pageErrors.push(error.message));
  const requests = [];
  let healthyHost = 'proxy.finance.qq.com';
  await synthetic.route('**/*', async route => {
    const url = new URL(route.request().url());
    if ((url.hostname.endsWith('gtimg.cn') || url.hostname === 'proxy.finance.qq.com')
      && url.pathname.includes('/appstock/app/')) {
      requests.push({ host: url.hostname, path: url.pathname, param: url.searchParams.get('param'),
        type: route.request().resourceType() });
      if (url.hostname !== healthyHost) return route.fulfill({ status: 501,
        headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/html', body: 'Synthetic unavailable origin' });
      const [symbol, period, , , , adjust] = url.searchParams.get('param').split(',');
      const quote = []; quote[1] = '合成测试行情';
      const payload = { code: 0, data: { [symbol]: { [`${adjust || ''}${period}`]: syntheticRows,
        qt: { [symbol]: quote } } } };
      const variable = url.searchParams.get('_var');
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: `${variable}=${JSON.stringify(payload)};` });
    }
    if (url.hostname.endsWith('eastmoney.com')) return route.fulfill({ status: 503,
      headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{"error":"Synthetic unavailable backup"}' });
    if (url.hostname !== '127.0.0.1') return route.abort();
    return route.continue();
  });
  const visit = async page => {
    await page.goto(`${origin}/__ashare-kline-check`);
    await page.waitForFunction(() => typeof window.loadAshareDiagnostic === 'function');
  };
  const load = (page, options = {}) => page.evaluate(input => window.loadAshareDiagnostic(input), options);
  const checkRendered = async (page, result) => {
    assert.equal(result.ok, true, result.message);
    assert.equal(result.requestedBars, result.rows, 'all loaded bars must enter actual Chan analysis');
    assert.equal(result.analysisScope, 'all-loaded');
    assert.equal(await page.locator('[data-ashare-diagnostic-chart] [data-chan-layer]').count(), 2);
    assert.match(await page.getByLabel('缠论图例', { exact: true }).textContent(),
      new RegExp(`全部已加载 ${result.rows} 根K线参与计算`));
  };
  const checkSameParameters = (actual, expected) => {
    assert.ok(actual.length >= 3, 'one failed origin should attempt script/fetch before the second origin');
    assert.deepEqual([...new Set(actual.map(request => request.param))], [expected.param],
      'origin failover must preserve symbol, period, limit and adjustment exactly');
    assert.deepEqual([...new Set(actual.map(request => request.path.replace(/^\/ifzqgtimg/, '')))], [expected.path]);
  };
  await visit(synthetic);
  const day = { code: '688610', period: '101', adjust: '1', limit: 1000 };
  let start = requests.length;
  let result = await load(synthetic, day);
  await checkRendered(synthetic, result);
  assert.equal(result.name, '合成测试行情');
  assert.deepEqual(requests.slice(start), [{ host: 'proxy.finance.qq.com',
    path: '/ifzqgtimg/appstock/app/fqkline/get', param: 'sh688610,day,,,1000,qfq', type: 'script' }]);
  assert.ok(result.sourceInfo.includes('host=https://proxy.finance.qq.com/ifzqgtimg'));
  report.synthetic.push({ case: 'finance-proxy-adjusted-endpoint', result, requests: requests.slice(start) });

  healthyHost = 'web.ifzq.gtimg.cn';
  start = requests.length;
  result = await load(synthetic, day);
  await checkRendered(synthetic, result);
  let actual = requests.slice(start);
  checkSameParameters(actual, { param: 'sh688610,day,,,1000,qfq', path: '/appstock/app/fqkline/get' });
  assert.deepEqual(actual.map(request => request.host), ['proxy.finance.qq.com', 'proxy.finance.qq.com',
    'ifzq.gtimg.cn', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn']);
  assert.ok(result.sourceInfo.includes('host=https://web.ifzq.gtimg.cn'));
  report.synthetic.push({ case: 'ifzq-501-web-200', result, requests: actual });
  start = requests.length;
  await checkRendered(synthetic, await load(synthetic, day));
  assert.deepEqual(requests.slice(start).map(request => request.host), ['web.ifzq.gtimg.cn'],
    'the next request should prefer the origin that actually returned valid data');
  report.synthetic.push({ case: 'prefer-successful-web-origin', requests: requests.slice(start) });

  healthyHost = 'ifzq.gtimg.cn';
  const week = { code: '688610', period: '102', adjust: '2', limit: 600 };
  start = requests.length;
  result = await load(synthetic, week);
  await checkRendered(synthetic, result);
  actual = requests.slice(start);
  checkSameParameters(actual, { param: 'sh688610,week,,,600,hfq', path: '/appstock/app/fqkline/get' });
  assert.deepEqual(actual.map(request => request.host), ['web.ifzq.gtimg.cn', 'web.ifzq.gtimg.cn',
    'proxy.finance.qq.com', 'proxy.finance.qq.com', 'ifzq.gtimg.cn']);
  assert.ok(result.sourceInfo.includes('host=https://ifzq.gtimg.cn'));
  report.synthetic.push({ case: 'reversed-web-501-ifzq-200', result, requests: actual });
  start = requests.length;
  await checkRendered(synthetic, await load(synthetic, week));
  assert.deepEqual(requests.slice(start).map(request => request.host), ['ifzq.gtimg.cn']);
  report.synthetic.push({ case: 'prefer-new-successful-ifzq-origin', requests: requests.slice(start) });

  const month = { code: '688610', period: '103', adjust: '0', limit: 320 };
  start = requests.length;
  result = await load(synthetic, month);
  await checkRendered(synthetic, result);
  assert.deepEqual(requests.slice(start).map(request => request.param), ['sh688610,month,,,320']);
  assert.equal(requests[start].path, '/appstock/app/kline/kline', 'unadjusted data must retain its original raw-price endpoint');
  report.synthetic.push({ case: 'raw-month-endpoint-preserved', result, requests: requests.slice(start) });

  healthyHost = '';
  start = requests.length;
  result = await load(synthetic, day);
  assert.equal(result.ok, false, 'all unavailable market origins must produce an explicit load failure');
  assert.equal(result.phase, 'fetch');
  assert.match(result.message, /ifzq\.gtimg\.cn/);
  assert.match(result.message, /web\.ifzq\.gtimg\.cn/);
  assert.match(result.message, /proxy\.finance\.qq\.com/);
  assert.equal(await synthetic.locator('[data-ashare-diagnostic-status="error"]').count(), 1);
  assert.equal(await synthetic.locator('[data-ashare-diagnostic-chart]').count(), 0,
    'a failed load must not render a fabricated chart');
  report.synthetic.push({ case: 'both-tencent-and-eastmoney-unavailable-explicit-error', result, requests: requests.slice(start) });
  assert.deepEqual(pageErrors, []);
  await syntheticContext.close();

  if (liveEnabled) {
    // This context has no routing, persistent profile or imported user cookies.
    const liveContext = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const live = await liveContext.newPage();
    const livePageErrors = [];
    live.on('pageerror', error => livePageErrors.push(error.message));
    live.on('response', response => {
      if (response.url().includes('gtimg.cn') || response.url().includes('proxy.finance.qq.com')
        || response.url().includes('eastmoney.com')) {
        report.liveNetwork.push({ url: response.url(), status: response.status(), type: response.request().resourceType() });
      }
    });
    live.on('requestfailed', request => report.liveNetwork.push({ url: request.url(), failure: request.failure()?.errorText,
      type: request.resourceType() }));
    live.on('console', message => {
      if (['error', 'warning'].includes(message.type())) report.liveConsole.push({ type: message.type(), text: message.text() });
    });
    await visit(live);
    for (const [period, label] of [['101', 'day'], ['102', 'week'], ['103', 'month']]) {
      const loaded = await load(live, { code: '688610', period, adjust: '1', limit: 1000 });
      report.live.push({ label, ...loaded });
      await checkRendered(live, loaded);
      const mainSwitch = live.getByRole('button', { name: '缠论', exact: true });
      await mainSwitch.click();
      assert.equal(await live.locator('[data-chan-layer]').count(), 0);
      await mainSwitch.click();
      assert.equal(await live.locator('[data-chan-layer]').count(), 2);
      await live.screenshot({ path: join(output, `live-688610-${label}.png`), fullPage: true });
      console.log(`Live 688610 ${label}: ${loaded.rows} bars, ${loaded.last}, close ${loaded.close}, ${loaded.sourceInfo}`);
    }
    assert.deepEqual(livePageErrors, []);
    await liveContext.close();
  }
  report.finishedAt = new Date().toISOString();
  console.log(`Actual fetchAshareKline browser checks passed: ${report.synthetic.length} synthetic cases${liveEnabled
    ? ', plus 3 untouched live 688610 day/week/month requests rendered with actual Chan analysis and chart' : '; live requests not run (use --live)'}. Report: ${output}/report.json`);
} finally {
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
}
