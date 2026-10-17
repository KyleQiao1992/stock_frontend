import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { analyzeChan } from '../src/lib/chan/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CHAN_OUTLOOK_SCREENSHOTS || '/tmp/chan-outlook-2026-10-17';
const fixture = JSON.parse(await readFile(new URL('../src/lib/chan/fixtures/reference/sh603818-day.json', import.meta.url), 'utf8'));
const formatDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
// Read only saved raw candles. The fixture's old outlook is not the oracle.
const rows = fixture.candles.map(({ time, vol, ...candle }) => ({ ...candle,
  date: formatDate.format(new Date(time * 1000)), volume: vol }));
const cases = {};
for (let end = 7; end <= rows.length; end++) {
  const data = analyzeChan(rows.slice(0, end), 'day');
  if (data.outlook.ok && data.zs.length) cases[data.outlook.levels.vs_zs] = end;
}
assert.deepEqual(Object.keys(cases).sort(), ['above', 'below', 'inside'], 'saved 603818 candles must cover all three positions');

const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main id="root" style="width:100%;max-width:1100px;margin:20px auto;padding:12px"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import StockAnalysisPanel from '/src/components/StockAnalysisPanel.jsx';
import { analyzeChan } from '/src/lib/chan/index.js';
import fixture from '/src/lib/chan/fixtures/reference/sh603818-day.json';
import '/src/index.css';
const cases = ${JSON.stringify(cases)};
const position = new URLSearchParams(location.search).get('position') || 'above';
const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const rows = fixture.candles.slice(0,cases[position]).map(({time,vol,...candle})=>({...candle,
  date:date.format(new Date(time*1000)),volume:vol}));
const data = analyzeChan(rows,'day');
window.outlookTestData = data;
window.outlookTestRows = rows;
createRoot(document.getElementById('root')).render(React.createElement(StockAnalysisPanel,{
  data,enabled:true,tab:'outlook',onTabChange(){},code:'603818',name:'曲美家居',period:'day',
  showFinancial:false,showNews:false,showTradeSideHistory:false,
}));
</script></body></html>`;

const server = await createServer({ root, configFile: false, appType: 'custom',
  cacheDir: join(tmpdir(), 'chan-outlook-2026-10-17-vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [react(), tailwindcss(), { name: 'real-chan-outlook-qa', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__chan-outlook-qa')) return next();
      try {
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, html));
      } catch (error) { next(error); }
    });
  } }], server: { host: '127.0.0.1', port: 0, hmr: false },
});

const observations = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHAN_OUTLOOK_BROWSER || process.env.CHAN_DETAIL_BROWSER || (existsSync(chromium.executablePath())
      ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  for (const [name, viewport] of [['desktop', { width: 1280, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    for (const position of ['above', 'inside', 'below']) {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chan-outlook-qa?position=${position}`);
      const outlook = page.locator('[aria-label="缠论结构研判"]');
      await outlook.waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const watches = outlook.locator('[data-chan-signal-watch]');
      assert.equal(await watches.count(), 6, `${name}/${position}: six distinct B/S condition observations`);
      assert.equal(await outlook.locator('[data-chan-watch-intro]').count(), 1, `${name}/${position}: one shared introduction`);
      assert.equal(await outlook.locator('[data-chan-scenario]').count(), 3);
      const visibleText = await outlook.innerText();
      assert.doesNotMatch(visibleText, /待核验|verification|买卖点需另行核验|未执行一二三类买卖点识别/,
        `${name}/${position}: repeated verification placeholders must not replace observations`);
      assert.equal(await outlook.getByRole('heading', { name: '已确认信号', exact: true }).count(), 0);

      const actual = await page.evaluate(() => {
        const container = document.querySelector('[aria-label="缠论结构研判"]');
        const data = window.outlookTestData;
        const rows = window.outlookTestRows;
        const conditions = [...container.querySelectorAll('[data-chan-signal-watch]')].map((element) => ({
          kind: element.dataset.chanSignalWatch,
          title: element.querySelector('p').textContent,
          trigger: element.querySelectorAll('p')[1].textContent,
          action: element.querySelectorAll('p')[2].textContent,
        }));
        const grid = container.querySelector('[aria-label="结构事实"] .grid');
        const facts = [...grid.children].map((element) => ({ label: element.children[0].textContent,
          value: element.children[1].textContent, detail: element.children[2]?.textContent || '' }));
        const [a, b] = data.bi.slice(-2);
        const high = a.price > b.price ? a : b, low = a.price < b.price ? a : b;
        const zone = data.zs.reduce((latest, candidate) => !latest || candidate.edt > latest.edt ? candidate : latest, null);
        const inZone = data.analysisCandles.filter((candle) => candle.time >= zone.sdt && candle.time <= zone.edt);
        const highSource = inZone.find((candle) => candle.high === zone.zg);
        const lowSource = inZone.find((candle) => candle.low === zone.zd);
        const expected = {
          close: rows.at(-1).close.toFixed(2),
          high: high.price.toFixed(2), highTag: rows[high.time - 1].date + ' @ ' + high.price.toFixed(2),
          low: low.price.toFixed(2), lowTag: rows[low.time - 1].date + ' @ ' + low.price.toFixed(2),
          zg: zone.zg.toFixed(2), zgTag: (highSource?.date || rows[zone.zg_time - 1].date) + ' @ ' + zone.zg.toFixed(2),
          zd: zone.zd.toFixed(2), zdTag: (lowSource?.date || rows[zone.zd_time - 1].date) + ' @ ' + zone.zd.toFixed(2),
        };
        const panel = document.querySelector('[aria-label="个股分析"]').getBoundingClientRect();
        const overflow = [...container.querySelectorAll('[data-chan-scenario], [data-chan-signal-watch]')].map((element) => {
          const rect = element.getBoundingClientRect();
          return { kind: element.dataset.chanSignalWatch || element.dataset.chanScenario,
            left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        });
        const paired = [...container.querySelectorAll('[data-chan-scenario]')].map((scenario) => {
          const [left, right] = [...scenario.querySelectorAll('[data-chan-signal-watch]')].map((element) => element.getBoundingClientRect());
          return { sameRow: Math.abs(left.top - right.top) < 1, rightAfterLeft: right.left >= left.right - 1,
            secondBelow: right.top >= left.bottom - 1 };
        });
        return { conditions, facts, expected, conclusion: data.outlook.conclusion,
          position: data.outlook.levels.vs_zs, date: rows.at(-1).date, rows: rows.length,
          watchMetadata: data.outlook.scenarios.flatMap((scenario) => scenario.next_points).map((point) =>
            ({ kind: point.kind, hypothetical: point.hypothetical })),
          documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
          panel: { left: panel.left, right: panel.right }, overflow, paired };
      });
      assert.equal(actual.position, position);
      assert.equal(actual.rows, cases[position]);
      assert.equal(actual.conclusion.status, 'forming');
      assert.equal(actual.conclusion.kind, null);
      assert.equal(actual.conclusion.kind_hint, null);
      assert.equal(actual.conclusion.confirmed_signal, null);
      assert.equal(actual.conclusion.latest_signal, null);
      assert.deepEqual(actual.conditions.map((point) => point.kind).sort(), ['B1', 'B2', 'B3', 'S1', 'S2', 'S3']);
      assert.equal(new Set(actual.conditions.map((point) => point.trigger)).size, 6, 'all six conditions must differ');
      assert.ok(actual.watchMetadata.every((point) => point.hypothetical === true));
      const byKind = Object.fromEntries(actual.conditions.map((point) => [point.kind, point]));
      assert.match(byKind.B1.trigger, /下跌趋势.*底背驰/);
      assert.match(byKind.S1.trigger, /上涨趋势.*顶背驰/);
      assert.match(byKind.B2.trigger, /若已形成一买.*次级别.*再次.*结束/);
      assert.match(byKind.S2.trigger, /若已形成一卖.*次级别.*再次.*结束/);
      assert.match(byKind.B3.trigger, /向上离开同级别中枢.*首次次级别回试完成.*不跌破.*ZG/);
      assert.match(byKind.S3.trigger, /向下离开同级别中枢.*首次次级别回抽完成.*不升破.*ZD/);
      assert.ok(byKind.B1.action.includes(actual.expected.lowTag), 'B1 reference price/date comes from the actual pen low');
      assert.ok(byKind.S1.action.includes(actual.expected.highTag), 'S1 reference price/date comes from the actual pen high');
      const facts = Object.fromEntries(actual.facts.map((fact) => [fact.label, fact]));
      for (const [label, value, detail] of [
        ['现价', actual.expected.close], ['ZG 上沿', actual.expected.zg, actual.expected.zgTag],
        ['ZD 下沿', actual.expected.zd, actual.expected.zdTag],
        ['末笔高', actual.expected.high, actual.expected.highTag], ['末笔低', actual.expected.low, actual.expected.lowTag],
      ]) {
        assert.equal(facts[label].value, value, `${name}/${position}: ${label} price`);
        if (detail) assert.equal(facts[label].detail, detail, `${name}/${position}: ${label} source date`);
      }
      assert.ok(actual.documentWidth <= actual.viewportWidth + 1, `${name}/${position}: page must not overflow horizontally`);
      assert.ok(actual.panel.left >= -1 && actual.panel.right <= actual.viewportWidth + 1);
      for (const item of actual.overflow) {
        assert.ok(item.left >= actual.panel.left - 1 && item.right <= actual.panel.right + 1,
          `${name}/${position}: ${item.kind} stays within the panel`);
        assert.ok(item.scrollWidth <= item.clientWidth + 1, `${name}/${position}: ${item.kind} text does not overflow`);
      }
      assert.ok(actual.paired.every((pair) => name === 'desktop' ? pair.sameRow && pair.rightAfterLeft : pair.secondBelow),
        `${name}/${position}: watch cards follow desktop pairing / mobile stacking`);
      await page.screenshot({ path: join(output, `${name}-${position}.png`), fullPage: true });
      observations.push({ viewport: name, position, rows: actual.rows, date: actual.date,
        references: actual.expected, watchKinds: actual.conditions.map((point) => point.kind),
        triggers: actual.conditions.map((point) => point.trigger),
        documentWidth: actual.documentWidth, viewportWidth: actual.viewportWidth,
        screenshot: join(output, `${name}-${position}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks: observations.length, errors, observations }, null, 2));
  console.log(`Passed ${observations.length} real StockAnalysisPanel browser cases: three saved 603818 positions at desktop and 390px; screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
