// Synthetic, deterministic data only. Do not import production server modules here.
export const FIXTURE_DAY = '2026-10-21';
export const FIXTURE_TIMESTAMP = `${FIXTURE_DAY}T07:00:00Z`;
export const FIXTURE_TOKEN = 'e2e-fixture-session-token';
export const FIXTURE_USERNAME = 'test_audit';

export const STOCK_NAMES = Object.freeze({
  '600851': '海欣股份', '300364': '中文在线', '002307': '北新路桥',
  '603103': '横店影视', '002594': '比亚迪', '600519': '贵州茅台',
  '09618': '京东集团–SW', '00700': '腾讯控股',
  MSFT: 'Microsoft Corporation', AAPL: 'Apple Inc.',
});

const PICKS = { ashare: ['600851', '300364', '002307', '603103', '002594', '600519'], hk: ['09618', '00700'], us: ['MSFT', 'AAPL'] };
const INDEX_NAMES = { sh000001: '上证指数', sh000688: '科创50', sz399001: '深证成指', sz399006: '创业板指' };
const clone = value => structuredClone(value);
const ok = body => ({ status: 200, body });
const failure = (status, error) => ({ status, body: { ok: false, error } });
const number = (value, fallback = 1) => Math.max(1, Number.parseInt(value, 10) || fallback);

export function createFixtureData() {
  const dates = [];
  for (let date = new Date('2024-01-02T00:00:00Z'); date <= new Date(`${FIXTURE_DAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  const candles = dates.map((date, index) => {
    const close = 85 + index * .035 + Math.sin(index * .17) * 9 + Math.sin(index * .05) * 5;
    const open = close + Math.cos(index * .91) * .8;
    return {
      date, open: +open.toFixed(2), close: +close.toFixed(2),
      high: +(Math.max(open, close) + 1.1).toFixed(2), low: +(Math.min(open, close) - 1.3).toFixed(2),
      volume: 750000 + index * 913, amount: (750000 + index * 913) * close * 100,
      change: .83, pct: 1.27, turnover: .62,
    };
  });
  const user = { id: 1, username: FIXTURE_USERNAME, role: 'admin', status: 'active', createdAt: '2026-01-02T03:04:05Z' };
  const users = [user, ...['audit_member_with_long_name', 'audit_member_02', 'audit_disabled'].map((username, index) => ({
    id: index + 2, username, role: 'user', status: index === 2 ? 'disabled' : 'active', createdAt: '2026-10-12T07:08:09Z',
  }))];
  const favorites = Object.fromEntries(Object.entries(PICKS).map(([market, codes]) => [market, codes.map((code, index) => ({
    code, name: STOCK_NAMES[code], rank: index + 1, group: index === 1 ? '长期观察收藏夹' : '默认', createdAt: Date.parse('2026-10-12T12:00:00Z'),
  }))]));
  const groups = Object.fromEntries(Object.keys(PICKS).map(market => [market, ['默认', '长期观察收藏夹']]));
  const stockRows = PICKS.ashare.map((code, index) => ({
    code, name: STOCK_NAMES[code], cap: 2e11 / (index + 1), floatCap: 1.8e11 / (index + 1),
    amount: 9e9 / (index + 1), pct: 3.1 - index, mainInflow: 3e8 / (index + 1),
  }));
  const industries = ['半导体', '新能源汽车与高端制造', '银行', '医药制造'].map((name, index) => ({
    code: `BK${100 + index}`, name, cap: 6e11 / (index + 1), floatCap: 5e11 / (index + 1),
    amount: 2e10 / (index + 1), pct: 2 - index, pctEqual: 1.8 - index,
    mainInflow: 6e8 / (index + 1), count: stockRows.length, up: 3, down: 3, flat: 0, stocks: stockRows,
  }));
  const factors = [['factor1', '因子1', 'production'], ['amihud_20', '流动性因子', 'production'], ['new_momentum_20', '预备动量因子', 'preliminary']].map(([name, label, status], index) => ({
    name, label, displayName: label, status, enabled: true,
    summary: '界面测试使用的合成因子，包含较长中文说明和英文标识。', formula: 'SCORE = MA(CLOSE, 20) / CLOSE',
    source: { title: '合成研究资料', ref: 'e2e-fixture', url: '/__audit/source' },
    principle: '合成均线与动量说明。', whyEffective: '仅供测试界面，不代表真实策略收益。',
    evaluation: { sampleSize: 200 + index, winRate: .56 }, decision: 'keep', decisionReason: '界面检查',
    updatedAt: FIXTURE_TIMESTAMP, updatedBy: FIXTURE_USERNAME,
  }));
  const returns = Object.fromEntries(['1d', '3d', '1w', '2w', '1m', '3m'].map((period, index) => [period, factors.map((factor, factorIndex) => ({
    factor: factor.name, value: (factorIndex % 2 ? -1 : 1) * (index + 1) * 2.3, sampleSize: 100 + index * 20,
  }))]));
  const tradeRows = candles.slice(-125).map((row, index) => {
    const innerVol = 100000 + index * 310, outerVol = 130000 + index * 210;
    return {
      date: row.date, quoteTime: `${row.date}T07:00:00Z`, complete: true, innerVol, outerVol, unknownVol: 0,
      netVol: outerVol - innerVol, netRatio: (outerVol - innerVol) / (outerVol + innerVol) * 100,
      outerRatio: outerVol / (outerVol + innerVol) * 100, totalVol: outerVol + innerVol,
    };
  });
  return { dates, candles, user, users, favorites, groups, stockRows, industries, factors, returns, tradeRows, recommendations: clone(favorites), heatmapHistoryJobs: {} };
}

const base = () => ({
  ok: true, live: true, source: 'eastmoney', date: FIXTURE_DAY, dataDate: FIXTURE_DAY,
  quoteTime: FIXTURE_TIMESTAMP, updatedAt: FIXTURE_TIMESTAMP, stale: false, partial: false,
});

function quote(data, market, url) {
  const code = url.searchParams.get(market === 'us' ? 'symbol' : 'code') || PICKS[market][0];
  const period = url.searchParams.get('period') || '101';
  const klines = period === '102' ? data.candles.filter((_, index) => index % 5 === 0)
    : period === '103' ? data.candles.filter((_, index) => index % 20 === 0) : data.candles;
  return {
    ...base(), code, name: STOCK_NAMES[code] || `测试标的 ${code}`, currency: market === 'hk' ? 'HKD' : market === 'us' ? 'USD' : 'CNY',
    boardLot: market === 'hk' ? 50 : 100, klines, marketCap: 276595000000, floatMarketCap: 243485000000,
    turnoverRate: .31, peRatio: 12.73, volumeRatio: 1.31, volumeRatioSource: 'tencent',
    latestPrice: data.candles.at(-1).close, pct: 1.27, innerVol: 150000, outerVol: 180000,
    tradeSideVolumeSource: 'tencent', indicatorsQuoteTime: FIXTURE_TIMESTAMP, sourceInfo: '隔离端到端测试行情',
  };
}

function todayMarket(data) {
  return {
    ...base(), previousDate: '2026-10-20', poolDate: FIXTURE_DAY,
    breadth: { up: 2800, down: 2400, flat: 100, total: 5300, upRatio: 2800 / 5300 },
    yangYin: { yang: 3000, yin: 2300 }, heat: { value: 62, breadth: 53, ztStrength: 68 },
    strong: { ztCount: 80, dtCount: 6, zbCount: 24, fbSuccess: .8, zbRate: .2 },
    hist: ['-5', '-3', '-1', '0', '1', '3', '5'].map((label, index) => ({ label, count: 100 + index * 100 })),
    capTiers: [{ key: 'small', label: '100亿以下', avg: 1.8, count: 2400 }, { key: 'mid', label: '100至500亿', avg: .3, count: 1800 }, { key: 'large', label: '500亿以上', avg: -.5, count: 1100 }],
    premium: { avg: 1.3, count: 80, redRate: .75, dist: [{ key: '0_3', label: '0至3%', count: 60 }, { key: 'neg3_0', label: '-3至0%', count: 20 }] },
    consecutive: { lbCount: 20, maxLb: 6, nonOneWordLb: 15 },
    history: data.candles.slice(-15).map((row, index) => ({ date: row.date, lbCount: 10 + index % 4, ztCount: 60 + index, dtCount: 3 + index % 5, nextDaySuccess: .6 + index * .01, zbRate: .2 + index * .002 })),
  };
}

// Production /api/market-heatmap?start=... uses an asynchronous THS history
// job, not the latest snapshot contract. Keep its first loading response and
// the subsequent complete response separate so App polling is exercised.
function heatmapHistory(data, params) {
  const start = params.get('start') || '', end = params.get('end') || start, board = params.get('board') || '';
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || start > end) return failure(400, '请选择有效的起止日期');
  if (end > FIXTURE_DAY) return failure(400, '结束日期不能晚于北京时间今天');
  if (Date.parse(end) - Date.parse(start) > 366 * 86400000) return failure(400, '单次区间最多366天');
  if (board && !/^BK\d{4,6}$/.test(board)) return failure(400, '行业代码无效');
  const key = JSON.stringify({ start, end, board });
  const job = data.heatmapHistoryJobs[key] ||= { startedAt: Date.now() };
  // StrictMode's initial cancelled request can reach the server. Repeated
  // requests share a running job instead of advancing it by request count.
  const complete = Date.now() - job.startedAt >= 600;
  const selected = data.candles.filter(row => row.date >= start && row.date <= end);
  const industries = selected.length && !board ? data.industries.map((industry, index) => ({
    code: `THS${881000 + index}`, name: industry.name,
    pct: +((selected.at(-1).close / (selected[0].close / (1 + selected[0].pct / 100)) - 1) * 100).toFixed(2),
    amount: selected.reduce((sum, row) => sum + row.amount, 0) / 1e8 / (index + 1),
    firstDate: selected[0].date, lastDate: selected.at(-1).date, days: selected.length,
    historical: true, stocks: [],
  })) : [];
  return ok({ historical: true, start, end, status: complete ? 'complete' : 'loading',
    done: complete ? data.industries.length : 0, total: data.industries.length,
    failed: [], failureReasons: {}, empty: complete && !selected.length ? data.industries.length : 0,
    industries: complete ? industries : [], stocks: [], partial: false,
    source: '同花顺行业历史日线', supportsDrilldown: false,
    ...(complete ? { finishedAt: job.startedAt + 600, ...(board ? { error: '当前历史数据源暂不支持成分股下钻' } : {}) } : {}),
  });
}

/** Return null for an unsupported route or HTTP method; the server then returns 404. */
export function apiFixture({ data, url, method = 'GET', body = {}, headers = {}, state = {} }) {
  const path = url.pathname;
  const market = body.market || url.searchParams.get('market') || 'ashare';
  const authorized = headers.authorization === `Bearer ${FIXTURE_TOKEN}`;
  if (path === '/api/auth/login' && method === 'POST') {
    if (body.username !== FIXTURE_USERNAME || !body.password) return failure(400, `仅允许测试账号 ${FIXTURE_USERNAME} 和非真实测试密码。`);
    return ok({ ok: true, id: data.user.id, username: data.user.username, token: FIXTURE_TOKEN });
  }
  if (path === '/api/auth/register' && method === 'POST') return failure(403, '隔离测试服务不开放注册。');
  if (path === '/api/auth/me' && method === 'GET') return authorized ? ok({ ok: true, user: data.user }) : failure(401, '请先登录测试账号。');
  if (path === '/api/auth/change-password' && method === 'POST') return authorized ? ok({ ok: true }) : failure(401, '请先登录测试账号。');
  // Unknown routes still return 404, including when no token is present.
  const restricted = path.startsWith('/api/admin/') || ['/api/factor-returns', '/api/factor-detail'].includes(path);
  const permitted = authorized && (!restricted || data.user.role === 'admin');
  const reply = authenticatedApiFixture({ data: permitted ? data : clone(data), url, method, body, market, state });
  if (!reply) return null;
  if (!authorized) return failure(401, '请先登录测试账号。');
  return permitted ? reply : failure(403, '没有操作权限。');
}

function authenticatedApiFixture({ data, url, method, body, market, state }) {
  const path = url.pathname;
  if (path === '/api/admin/users' && method === 'GET') {
    const page = number(url.searchParams.get('page'));
    if (state.failUsersPage2 && page === 2) return failure(503, '模拟第二页加载失败');
    const matches = data.users.filter(user => user.username.includes(url.searchParams.get('q') || ''));
    return ok({ ok: true, data: matches.slice((page - 1) * 2, page * 2), total: matches.length, pageSize: 2, page });
  }
  const userRoute = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/(reset-password|revoke-sessions))?$/);
  if (userRoute && ((!userRoute[2] && method === 'PATCH') || (userRoute[2] && method === 'POST'))) {
    const target = data.users.find(user => user.username === decodeURIComponent(userRoute[1]));
    if (!target) return failure(404, '测试用户不存在');
    if (method === 'PATCH') for (const key of ['role', 'status']) if (body[key]) target[key] = body[key];
    // Passwords and sessions are never persisted, even inside fixture data.
    return ok({ ok: true });
  }
  if (path === '/api/favorites' && Object.hasOwn(data.favorites, market)) {
    if (method === 'POST') {
      const existing = data.favorites[market].find(item => item.code === body.code);
      if (existing) existing.group = body.group || existing.group;
      else data.favorites[market].push({ code: body.code, name: body.name || STOCK_NAMES[body.code] || `测试标的 ${body.code}`, group: body.group || '默认', createdAt: Date.parse(FIXTURE_TIMESTAMP) });
    } else if (method === 'PATCH') {
      const target = data.favorites[market].find(item => item.code === body.code);
      if (!target) return failure(404, '测试收藏不存在');
      target.group = body.group || '默认';
    } else if (method === 'DELETE') data.favorites[market] = data.favorites[market].filter(item => item.code !== url.searchParams.get('code'));
    else if (method !== 'GET') return null;
    return ok({ ...base(), items: data.favorites[market], groups: data.groups[market] });
  }
  if (path === '/api/recommendations' && method === 'GET' && Object.hasOwn(data.recommendations, market)) return ok({
    ...base(), items: data.recommendations[market], exists: true, type: 'string', key: 'fixture_factor1_cn_20261021', ttl: 1000,
  });
  if (path === '/api/favorite-groups' && Object.hasOwn(data.groups, market)) {
    if (method === 'POST') {
      if (body.name && !data.groups[market].includes(body.name)) data.groups[market].push(body.name);
    } else if (method === 'DELETE') {
      const name = url.searchParams.get('name');
      data.groups[market] = data.groups[market].filter(group => group !== name);
      data.favorites[market] = data.favorites[market].filter(item => item.group !== name);
    } else if (method !== 'GET') return null;
    return ok({ ok: true, groups: data.groups[market] });
  }
  if ((path === '/api/ashare-search' || path === '/api/hk-search') && method === 'GET') {
    const searchMarket = path.includes('/hk') ? 'hk' : 'ashare', query = (url.searchParams.get('q') || '').toLowerCase();
    const items = PICKS[searchMarket].map(code => ({ code, name: STOCK_NAMES[code], market: '测试市场', pinyin: code === '002594' ? 'BYD' : 'UI' }))
      .filter(item => `${item.code} ${item.name} ${item.pinyin}`.toLowerCase().includes(query));
    return ok({ ok: true, items });
  }
  if (path === '/api/us-kline' && method === 'GET') return ok(quote(data, 'us', url));
  if (path === '/api/hk-kline' && method === 'GET') return ok(quote(data, 'hk', url));
  if (path === '/api/market-indices' && method === 'GET') return ok({
    ...base(), indices: [['000001', 'sh000001', '上证指数', 3901.23], ['000688', 'sh000688', '科创50', 1432.76], ['399001', 'sz399001', '深证成指', 12789.12], ['399006', 'sz399006', '创业板指', 2890.13]]
      .map(([code, tencentSymbol, name, price], index) => ({ code, tencentSymbol, name, price, pct: 1.2 - index * .6, available: true, quoteTime: FIXTURE_TIMESTAMP })),
  });
  if (path === '/api/market-heatmap' && method === 'GET' && url.searchParams.has('start')) return heatmapHistory(data, url.searchParams);
  if (path === '/api/market-heatmap' && method === 'GET') return ok({
    ...base(), totalStocks: 24, up: 12, down: 12, flat: 0, industries: data.industries,
    industry: url.searchParams.get('industry') || '', stocks: data.stockRows, supportsDrilldown: true,
  });
  if (path === '/api/today-market' && method === 'GET') return ok(todayMarket(data));
  if (path === '/api/board-fundflow' && method === 'GET') return ok({
    ...base(), mode: 'intraday', asOf: FIXTURE_TIMESTAMP, coverage: { available: 4, total: 4 },
    series: data.industries.map((industry, index) => ({ code: industry.code, name: industry.name, final: (index % 2 ? -1 : 1) * 32.5,
      points: data.candles.slice(-30).map((row, pointIndex) => ({ t: row.date, v: (index % 2 ? -1 : 1) * (pointIndex + 1) * (index + 1) * 1.25 })) })),
  });
  if ((path === '/api/factors' || path === '/api/admin/factors') && method === 'GET') return ok({
    ok: true, data: (path === '/api/factors' ? data.factors.filter(factor => factor.status === (url.searchParams.get('status') || 'production')) : data.factors)
      .map(factor => ({ ...factor, source: { ...factor.source, url: new URL(factor.source.url, url.origin).href } })),
  });
  const factorRoute = path.match(/^\/api\/admin\/factors\/([^/]+)$/);
  if (factorRoute && method === 'PATCH') {
    const factor = data.factors.find(item => item.name === decodeURIComponent(factorRoute[1]));
    if (!factor) return failure(404, '测试因子不存在');
    Object.assign(factor, body);
    return ok({ ok: true, data: factor });
  }
  if (path === '/api/factor-returns' && method === 'GET') return ok({ ok: true, data: data.returns });
  if ((path === '/api/factor-detail' || path === '/api/favorites-backtest') && method === 'GET') {
    const page = number(url.searchParams.get('page')), pageSize = 2;
    if (state.failFactorPage2 && page === 2) return failure(503, '模拟因子第二页加载失败');
    const allRows = PICKS.ashare.map((stockCode, index) => ({
      signalDate: '2026-10-12', factorName: 'factor1', stockCode, stockName: STOCK_NAMES[stockCode],
      returns: { t1: 1.2 + index, t3: 2.2, t5: -1.5, t10: 4.2, t20: 8.4, t40: 10.2, t60: 13.1 },
    }));
    return ok({ ok: true, rows: allRows.slice((page - 1) * pageSize, page * pageSize), total: allRows.length, page, pageSize, startDate: url.searchParams.get('startDate') || '2026-09-21', endDate: url.searchParams.get('endDate') || FIXTURE_DAY });
  }
  if (path === '/api/ashare-finance' && method === 'GET') return ok({
    ...base(), reports: [3, 2, 1].map(quarter => ({ reportDate: `2026-${String(quarter * 3).padStart(2, '0')}-${quarter === 1 ? '31' : '30'}`, reportName: `2026年第${quarter}季度`, revenue: 7.5e10, revenueGrowth: 12.8, parentNetProfit: 5.3e9, parentNetProfitGrowth: 23, grossMargin: 21, netMargin: 8 })),
  });
  if (path === '/api/ashare-profile' && method === 'GET') return ok({
    ...base(), company: { orgName: '模拟股份有限公司', industry: '高端制造与新能源汽车', market: '上海证券交易所', businessScope: '本公司主营业务为研发、生产与销售。较长的合成经营范围用于检查窄屏换行和展开收起。'.repeat(4) },
    themes: { sources: [{ key: 'eastmoney', name: '东方财富 F10', concepts: ['新能源汽车', '机器人概念', '高端制造'] }], concepts: ['高端制造'] },
  });
  if (path === '/api/us-profile' && method === 'GET') return ok({
    ...base(), company: { orgName: '微软公司', orgEnName: 'Microsoft Corporation', industry: '软件与云计算服务', market: '纳斯达克', businessScope: 'Microsoft Corporation develops software, cloud platforms and AI services. This synthetic description checks line wrapping. '.repeat(4) },
    themes: { sources: [{ key: 'business', name: '主营产品构成', concepts: ['云计算与企业服务 45%', '生产力和业务流程 35%', '个人计算 20%'], highlights: [{ keyword: '机构评级共识', content: '合成评级：买入18家，持有6家，卖出2家。仅用于界面检查。' }] }] },
  });
  if (path === '/api/ashare-trade-side-history' && method === 'GET') return ok({
    ...base(), code: url.searchParams.get('code'), rows: data.tradeRows, latest: data.tradeRows.at(-1),
    source: { name: '合成盘后历史', key: 'fixture' }, realtimeSource: { name: '合成腾讯行情' },
    collection: { days: data.tradeRows.length }, history: { status: 'ready', done: data.tradeRows.length, total: data.tradeRows.length },
  });
  if (path === '/api/suspension-alert' && method === 'GET') return ok({
    ...base(), level: 'normal', levelLabel: '正常', board: '主板', benchmark: '沪深300', asOf: FIXTURE_DAY, reasons: ['合成数据：未触发异常波动条件。'],
  });
  if (path === '/api/agent/chat' && method === 'POST') return ok({
    ok: true, reply: '## 模拟研究结果\n\n内容仅用于布局检查，较长段落随着屏幕宽度换行。\n\n|标的|说明|收益率|\n|---|---|---|\n|600851|较长的测试说明文字|1.20%|\n\n```js\nconst longText = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";\n```', steps: [{ tool: 'get_quote', code: '600851', name: '海欣股份' }],
  });
  return null;
}

function tencentFixture(data, url) {
  const parts = (url.searchParams.get('param') || '').split(','), [symbol, period = 'day', end] = parts;
  if (!symbol || !['day', 'week', 'month', 'm5', 'm30', 'm60'].includes(period)) return null;
  const minute = /^m\d+$/.test(period), limit = Math.min(10000, number(parts[minute ? 3 : 4], 640));
  let bars;
  if (minute) {
    const minutes = Number(period.slice(1));
    bars = data.dates.flatMap((date, dayIndex) => {
      const dayBars = [], daily = data.candles[dayIndex];
      for (const [start, finish] of [[570, 690], [780, 900]]) for (let time = start + minutes; time <= finish; time += minutes) {
        const hh = String(Math.floor(time / 60)).padStart(2, '0'), mm = String(time % 60).padStart(2, '0');
        const close = daily.close + Math.sin(time / 30) * .2;
        dayBars.push([`${date.replaceAll('-', '')}${hh}${mm}`, String(daily.open), close.toFixed(2), String(daily.high), String(daily.low), '100000']);
      }
      return dayBars;
    }).filter(row => !end || row[0] < end).slice(-limit);
  } else {
    const source = period === 'week' ? data.candles.filter((_, index) => index % 5 === 0) : period === 'month' ? data.candles.filter((_, index) => index % 20 === 0) : data.candles;
    bars = source.filter(row => !end || row.date < end).slice(-limit).map(row => [row.date, String(row.open), String(row.close), String(row.high), String(row.low), String(row.volume)]);
  }
  const qt = Array(60).fill('0');
  Object.assign(qt, { 1: STOCK_NAMES[symbol.slice(2)] || INDEX_NAMES[symbol] || `测试标的 ${symbol}`, 3: String(data.candles.at(-1).close), 4: String(data.candles.at(-1).close - .83), 6: '1800000', 7: '1000000', 8: '800000', 30: '20261021150000', 31: '.83', 32: '1.27', 38: '.62', 39: '12.73', 44: '2434.85', 45: '2765.95', 49: '1.31' });
  const key = minute ? period : parts.includes('qfq') ? `qfq${period}` : parts.includes('hfq') ? `hfq${period}` : period;
  const payload = { code: 0, data: { [symbol]: { [key]: bars, qt: { [symbol]: qt } } } };
  const variable = url.searchParams.get('_var');
  return variable ? { status: 200, body: `window[${JSON.stringify(variable)}]=${JSON.stringify(payload)};`, contentType: 'application/javascript; charset=utf-8' } : ok(payload);
}

/** External provider requests are rewritten to these local, explicitly supported paths. */
export function remoteFixture({ data, url, method = 'GET' }) {
  if (method !== 'GET') return null;
  const match = url.pathname.match(/^\/__audit\/remote\/([^/]+)(\/.*)$/);
  if (!match) return null;
  const [, host, path] = match;
  if (host === 'proxy.finance.qq.com' && path === '/ifzqgtimg/appstock/news/info/search') return ok({
    code: 0, data: { data: Array.from({ length: 5 }, (_, index) => ({ id: String(index), title: `合成新闻：产业研究与公司经营业绩分析，较长标题用于检查换行 ${index + 1}`, src: '测试资讯', time: '2026-10-21 15:00:00', url: new URL('/__audit/source', url.origin).href })) },
  });
  if (['ifzq.gtimg.cn', 'web.ifzq.gtimg.cn', 'proxy.finance.qq.com'].includes(host)
      && /^\/(?:ifzqgtimg\/)?appstock\/app\/(?:fqkline\/get|kline\/(?:kline|mkline))$/.test(path)) return tencentFixture(data, url);
  if (['push2his.eastmoney.com', '79.push2his.eastmoney.com', '82.push2his.eastmoney.com', 'push2delay.eastmoney.com'].includes(host) && path === '/api/qt/stock/kline/get') {
    const code = (url.searchParams.get('secid') || '1.600851').split('.').at(-1);
    const payload = { data: { code, name: STOCK_NAMES[code] || '测试指数', klines: data.candles.map(row => [row.date, row.open, row.close, row.high, row.low, row.volume, row.amount, 2, row.pct, row.change, row.turnover].join(',')) } };
    const callback = url.searchParams.get('cb');
    if (callback && !/^[A-Za-z_$][\w$]*$/.test(callback)) return failure(400, 'Invalid JSONP callback');
    return callback ? { status: 200, body: `${callback}(${JSON.stringify(payload)});`, contentType: 'application/javascript; charset=utf-8' } : ok(payload);
  }
  return null;
}
