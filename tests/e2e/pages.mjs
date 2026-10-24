import { expect } from 'playwright/test';

// These cases navigate the real App. API fixtures belong to the runner, so a
// successful readiness check must observe rendered data rather than a mock flag.
export async function workspaceReady(page) {
  await expect(page.getByRole('button', { name: '个人菜单', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'A股', exact: true })).toBeVisible();
  await expect(page.getByText('正在验证登录状态…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('正在加载行情工作台…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('页面遇到异常', { exact: true })).toHaveCount(0);
}

export async function chartReady(page) {
  await workspaceReady(page);
  await expect(page.locator('.market-query-controls input[maxlength="30"]')).not.toHaveValue('');
  const chart = page.locator('svg[data-kline-period][data-kline-count]').first();
  await expect(chart).toBeVisible();
  await expect.poll(async () => Number(await chart.getAttribute('data-kline-count'))).toBeGreaterThan(0);
  await expect(chart.locator('g[data-kline-time]').first()).toBeVisible();
  await expect.poll(async () => (await chart.getAttribute('data-kline-period'))
    === (await page.getByRole('combobox', { name: 'K线周期', exact: true }).inputValue())).toBe(true);
  await expect(page.locator('.market-query-controls').getByRole('button', { name: '查询', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function top(page, title) {
  await workspaceReady(page);
  await page.getByRole('button', { name: title, exact: true }).click();
}

async function stockOpen(page, title) {
  await top(page, title);
  // The A/US recommendation choice is shared. Each stock-page visual starts
  // from its self-selected list so entering HK is exercised independently.
  await page.getByRole('button', { name: '自选', exact: true }).click();
  const period = page.getByRole('combobox', { name: 'K线周期', exact: true });
  if (await period.inputValue() !== '101') await period.selectOption('101');
}

async function stockReady(page, market) {
  await chartReady(page);
  const placeholders = {
    ashare: '代码 / 简称 / 拼音首字母',
    hk: '代码 / 简称 / 拼音',
    us: '如 AAPL',
  };
  const patterns = { ashare: /^\d{6}$/, hk: /^\d{5}$/, us: /^[A-Z][A-Z0-9.-]*$/ };
  await expect(page.getByPlaceholder(placeholders[market], { exact: true })).toHaveValue(patterns[market]);
  await expect(page.locator('textarea')).not.toHaveValue('');
  await expect(page.getByText('正在生成自选列表…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成列表', exact: true })).toBeEnabled();
  const cards = page.locator('div[role="button"][tabindex="0"]').filter({ has: page.locator('div.font-mono') });
  await expect(cards.first()).toBeVisible();
  await expect(page.getByText(/请先输入至少一个/)).toHaveCount(0);
  const newsRefresh = page.getByRole('button', { name: '刷新资讯', exact: true });
  if (await newsRefresh.count()) await expect(newsRefresh).toBeEnabled();
}

const analysisPanel = page => page.locator('section[aria-label="个股分析"]');

async function analysisOpen(page, market, label) {
  await stockOpen(page, { ashare: 'A股', hk: '港股', us: '美股' }[market]);
  await stockReady(page, market);
  if (['缠论研判', '笔端参考'].includes(label)) {
    const chan = page.getByRole('button', { name: '缠论', exact: true });
    if (await chan.getAttribute('aria-pressed') !== 'true') await chan.click();
  }
  await analysisPanel(page).getByRole('tab', { name: label, exact: true }).click();
  if (label === '资讯') await page.getByRole('tab', { name: '新闻', exact: true }).click();
}

async function analysisReady(page, market, label) {
  await stockReady(page, market);
  await expect(analysisPanel(page).getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
}

async function chanOutlookReady(page, market) {
  await analysisReady(page, market, '缠论研判');
  const outlook = page.locator('[aria-label="缠论结构研判"]');
  await expect(outlook.getByRole('heading', { name: '结构研判', exact: true })).toBeVisible();
  const facts = outlook.locator('section[aria-label="结构事实"]');
  await expect(facts.locator('p').first()).toHaveText(/\S/);
  await expect(facts.getByText('现价', { exact: true }).locator('..').locator('.font-semibold')).toHaveText(/\d+\.\d{2}/);
  await expect(outlook.locator('section[aria-label="观察条件"] p')).toHaveText(/\S/);
  await expect(outlook.locator('section[aria-label="失效与操作参考"] p')).toHaveText(/\S/);
}

async function chanEndpointsReady(page, market) {
  await analysisReady(page, market, '笔端参考');
  const panel = analysisPanel(page);
  await expect(panel.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByText(/共 [1-9]\d* 个笔端参考/)).toBeVisible();
  const first = panel.locator('ol > li').first();
  await expect(first).toBeVisible();
  await expect(first.locator('time')).toHaveText(/\d{4}-\d{2}-\d{2}/);
  await expect(first.locator('.font-mono')).toHaveText(/\d+\.\d{2}/);
}

async function financialReady(page) {
  await analysisReady(page, 'ashare', '财报');
  const table = analysisPanel(page).getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await expect(table.getByRole('cell', { name: '收入', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '归母净利润', exact: true })).toBeVisible();
  await expect(table.locator('thead th').nth(1)).not.toHaveText(/^-?$/);
  await expect(table.locator('tbody tr').first().getByRole('cell').nth(1)).toHaveText(/\d/);
  await expect(page.getByText('财报数据加载中', { exact: true })).toHaveCount(0);
  const profile = page.getByText('公司基本介绍', { exact: true }).locator('..');
  await expect(profile.locator('.font-medium').first()).toHaveText(/\S/);
  await expect(profile.getByText('加载中', { exact: true })).toHaveCount(0);
  await expect(profile.getByText('暂无公司介绍。', { exact: true })).toHaveCount(0);
}

async function newsReady(page, market) {
  await analysisReady(page, market, '资讯');
  const news = page.locator('section[aria-label="个股资讯"]');
  await expect(news.getByRole('tab', { name: '新闻', exact: true })).toHaveAttribute('aria-selected', 'true');
  const panel = news.getByRole('tabpanel', { name: '新闻', exact: true });
  const article = panel.getByRole('link').first();
  await expect(article).toBeVisible();
  await expect(article).toHaveAttribute('href', /^https?:\/\//);
  await expect(panel.locator('li time').first()).toHaveText(/\d{4}-\d{2}-\d{2}/);
  await expect(panel.getByText('新闻加载中…', { exact: true })).toHaveCount(0);
  await expect(news.getByRole('button', { name: '刷新资讯', exact: true })).toBeEnabled();
}

async function trendOpen(page, title) {
  await top(page, '趋势大盘');
  await page.getByRole('button', { name: title, exact: true }).click();
}

export async function heatmapTilesReady(page) {
  const hint = page.getByText(/^(点击行业下钻成分股|点击个股查看 K 线|悬浮查看行业区间数据)$/);
  const tiles = hint.locator('..').locator('..').locator('div.absolute.cursor-pointer');
  await expect(tiles.first()).toBeVisible();
  // ResizeObserver updates the treemap asynchronously. Readiness requires the
  // rendered tiles to fill the new container, rather than an old nonempty map.
  await expect.poll(() => tiles.evaluateAll(elements => {
    if (!elements.length) return false;
    const frame = elements[0].parentElement.getBoundingClientRect();
    const boxes = elements.map(element => element.getBoundingClientRect());
    return boxes.every(box => box.left >= frame.left - 2 && box.right <= frame.right + 2
      && box.top >= frame.top - 2 && box.bottom <= frame.bottom + 2)
      && Math.abs(Math.min(...boxes.map(box => box.left)) - frame.left) <= 2
      && Math.abs(Math.max(...boxes.map(box => box.right)) - frame.right) <= 2;
  }), { message: '热力图须按当前容器尺寸完成重排' }).toBe(true);
}

export async function heatmapCaptionReady(page) {
  const hint = page.getByText(/^(点击行业下钻成分股|点击个股查看 K 线|悬浮查看行业区间数据)$/);
  const description = hint.locator('..').locator(':scope > span').first();
  await expect(description).toBeVisible();
  const [text, action, container] = await Promise.all([
    description.boundingBox(), hint.boundingBox(), hint.locator('..').boundingBox(),
  ]);
  expect(action.x - (text.x + text.width) >= 8 || action.y - (text.y + text.height) >= 3,
    '热力图说明和操作提示必须有可读间距，窄屏不能挤在一起').toBe(true);
  for (const box of [text, action]) {
    expect(box.x).toBeGreaterThanOrEqual(container.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(container.x + container.width + 1);
  }
}

async function trendChartsReady(page) {
  await workspaceReady(page);
  for (const code of ['000001', '000688', '399001', '399006']) {
    const card = page.locator(`[data-index-trend-card="${code}"]`);
    await expect(card.locator('svg[data-index-trend-chart]')).toBeVisible();
    await expect(card.locator('[data-index-candle]').first()).toBeVisible();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.getByText('加载中…', { exact: true })).toHaveCount(0);
  }
}

async function factorOpen(page, title) {
  await top(page, '因子研究');
  await page.getByRole('button', { name: title, exact: true }).click();
}

async function factorReturnsReady(page) {
  await workspaceReady(page);
  await expect(page.getByText('因子整体表现', { exact: true })).toBeVisible();
  await expect(page.getByText('因子详情查询', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '硬刷新因子', exact: true })).toBeEnabled();
  await expect(page.getByText('重新计算中…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('近1天收益率', { exact: true })).toBeVisible();
  // FactorBarChart prints a percentage only when at least one finite return
  // was received; headings alone also appear for a failed/empty response.
  await expect(page.getByText(/^[+-]?\d+\.\d{2}%$/).first()).toBeVisible();
  await expect(page.getByText('因子研究页面加载异常', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function factorCustomOpen(page, title) {
  await factorOpen(page, title);
  await page.getByRole('button', { name: '自选起始日', exact: true }).click();
}

async function factorCustomReady(page) {
  await workspaceReady(page);
  await expect(page.getByText('因子整体表现', { exact: true })).toBeVisible();
  await expect(page.getByText('因子详情查询', { exact: true })).toBeVisible();
  const dateInput = page.getByText('起始日期', { exact: true }).locator('..').locator('input[type="date"]');
  await expect(dateInput).toBeEditable();
  await expect(dateInput).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  const [, month, day] = (await dateInput.inputValue()).split('-');
  const firstPeriod = page.getByText(`${Number(month)}/${Number(day)} 起 · 第1天`, { exact: true });
  await expect(firstPeriod).toBeVisible();
  await expect(firstPeriod.locator('..').getByText(/^[+-]?\d+\.\d{2}%$/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '硬刷新因子', exact: true })).toBeEnabled();
  await expect(page.getByText('重新计算中…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('因子研究页面加载异常', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

export const PAGE_CASES = [
  {
    id: 'login', title: '登录',
    async open(page) { await page.goto('/'); },
    async ready(page) {
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
      await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
      await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    },
  },
  {
    id: 'register', title: '注册',
    async open(page) { await page.goto('/'); await page.getByRole('button', { name: '注册', exact: true }).click(); },
    async ready(page) {
      await expect(page.getByRole('heading', { name: '注册', exact: true })).toBeVisible();
      await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
      await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
      await expect(page.getByRole('button', { name: '注册', exact: true })).toBeEnabled();
    },
  },
  { id: 'ashare', title: 'A股', open: page => stockOpen(page, 'A股'), ready: page => stockReady(page, 'ashare') },
  { id: 'hk', title: '港股', open: page => stockOpen(page, '港股'), ready: page => stockReady(page, 'hk') },
  { id: 'us', title: '美股', open: page => stockOpen(page, '美股'), ready: page => stockReady(page, 'us') },
  {
    id: 'ashare-financial', title: 'A股 / 财报',
    open: page => analysisOpen(page, 'ashare', '财报'), ready: financialReady,
  },
  {
    id: 'ashare-outlook', title: 'A股 / 缠论研判', open: page => analysisOpen(page, 'ashare', '缠论研判'),
    async ready(page) {
      await analysisReady(page, 'ashare', '缠论研判');
      const outlook = page.locator('[aria-label="缠论结构研判"]');
      await expect(outlook.getByRole('heading', { name: '结构研判', exact: true })).toBeVisible();
      const facts = outlook.locator('section[aria-label="结构事实"]');
      await expect(facts.locator('p').first()).toHaveText(/\S/);
      await expect(facts.getByText('现价', { exact: true }).locator('..').locator('.font-semibold')).toHaveText(/\d+\.\d{2}/);
      await expect(outlook.locator('section[aria-label="观察条件"] p')).toHaveText(/\S/);
      await expect(outlook.locator('section[aria-label="失效与操作参考"] p')).toHaveText(/\S/);
    },
  },
  {
    id: 'ashare-endpoints', title: 'A股 / 笔端参考', open: page => analysisOpen(page, 'ashare', '笔端参考'),
    async ready(page) {
      await analysisReady(page, 'ashare', '笔端参考');
      const panel = analysisPanel(page);
      await expect(panel.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.getByText(/共 [1-9]\d* 个笔端参考/)).toBeVisible();
      const first = panel.locator('ol > li').first();
      await expect(first).toBeVisible();
      await expect(first.locator('time')).toHaveText(/\d{4}-\d{2}-\d{2}/);
      await expect(first.locator('.font-mono')).toHaveText(/\d+\.\d{2}/);
    },
  },
  { id: 'ashare-news', title: 'A股 / 资讯', open: page => analysisOpen(page, 'ashare', '资讯'), ready: page => newsReady(page, 'ashare') },
  {
    id: 'ashare-trade-history', title: 'A股 / 内外盘历史', open: page => analysisOpen(page, 'ashare', '内外盘历史'),
    async ready(page) {
      await analysisReady(page, 'ashare', '内外盘历史');
      const panel = page.getByTestId('trade-side-history');
      const table = panel.getByRole('table', { name: '内外盘历史列表', exact: true });
      const first = table.locator('tbody tr').first();
      await expect(first.getByRole('cell')).toHaveCount(7);
      await expect(first.getByRole('cell').first()).toHaveText(/\d{4}-\d{2}-\d{2}/);
      await expect(first.getByRole('cell').nth(1)).toHaveText(/\d/);
      await expect(first.getByRole('cell').nth(2)).toHaveText(/\d/);
      await expect(panel.getByRole('status')).toHaveCount(0);
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel.getByText('历史文件加载中', { exact: true })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: '刷新内外盘历史', exact: true })).toBeEnabled();
    },
  },
  { id: 'hk-news', title: '港股 / 资讯', open: page => analysisOpen(page, 'hk', '资讯'), ready: page => newsReady(page, 'hk') },
  ...[['hk', '港股'], ['us', '美股']].flatMap(([market, title]) => [
    {
      id: `${market}-outlook`, title: `${title} / 缠论研判`,
      open: page => analysisOpen(page, market, '缠论研判'), ready: page => chanOutlookReady(page, market),
    },
    {
      id: `${market}-endpoints`, title: `${title} / 笔端参考`,
      open: page => analysisOpen(page, market, '笔端参考'), ready: page => chanEndpointsReady(page, market),
    },
  ]),
  {
    id: 'trend-heatmap', title: '趋势大盘 / 热力图', open: page => trendOpen(page, '热力图'),
    async ready(page) {
      await workspaceReady(page);
      await expect(page.getByRole('combobox', { name: '热力图时间模式', exact: true })).toBeVisible();
      await expect(page.getByText(/热力图加载中/)).toHaveCount(0);
      const content = page.getByText('点击行业下钻成分股', { exact: true }).locator('..').locator('..');
      await expect(content.locator('div.absolute.cursor-pointer').first()).toBeVisible();
      await heatmapTilesReady(page);
      await heatmapCaptionReady(page);
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    },
  },
  {
    id: 'trend-today', title: '趋势大盘 / 今日盘面', open: page => trendOpen(page, '今日盘面'),
    async ready(page) {
      await workspaceReady(page);
      await expect(page.getByText(/盘面交易日 .*行情覆盖 \d+ 只/)).toBeVisible();
      await expect(page.getByText('市场真实热度', { exact: true })).toBeVisible();
      await expect(page.getByText(/总上涨比例/)).toBeVisible();
      await expect(page.getByText(/今日盘面加载中/)).toHaveCount(0);
      await expect(page.locator('svg').first()).toBeVisible();
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    },
  },
  { id: 'trend-long', title: '趋势大盘 / 中长期多头趋势', open: page => trendOpen(page, '中长期多头趋势'), ready: trendChartsReady },
  { id: 'trend-short', title: '趋势大盘 / 中短期多头趋势', open: page => trendOpen(page, '中短期多头趋势'), ready: trendChartsReady },
  {
    id: 'trend-fundflow', title: '趋势大盘 / 资金流分化', open: page => trendOpen(page, '资金流分化'),
    async ready(page) {
      await workspaceReady(page);
      await expect(page.getByText('资金流加载中…', { exact: true })).toHaveCount(0);
      const chart = page.getByRole('img', { name: '板块主力资金流曲线', exact: true });
      const snapshot = page.getByRole('table', { name: '新浪单日主力净流入快照', exact: true });
      await expect(chart.or(snapshot).first()).toBeVisible();
      await expect(page.getByText(/^来源：/)).toBeVisible();
      await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    },
  },
  {
    id: 'agent', title: 'Agent', open: page => top(page, 'Agent'),
    async ready(page) {
      await workspaceReady(page);
      await expect(page.getByText('股票研究 Agent', { exact: true })).toBeVisible();
      await expect(page.getByText(/可以开始问股票相关问题/)).toBeVisible();
      await expect(page.getByPlaceholder('输入股票、行业、策略或财报问题（Enter 发送，Shift+Enter 换行）')).toBeEditable();
      await expect(page.getByText('思考中…', { exact: true })).toHaveCount(0);
    },
  },
  { id: 'factor-mature', title: '因子研究 / 成熟因子', open: page => factorOpen(page, '成熟因子'), ready: factorReturnsReady },
  { id: 'factor-candidate', title: '因子研究 / 预备因子', open: page => factorOpen(page, '预备因子'), ready: factorReturnsReady },
  { id: 'factor-mature-custom', title: '因子研究 / 成熟因子 / 自选起始日', open: page => factorCustomOpen(page, '成熟因子'), ready: factorCustomReady },
  { id: 'factor-candidate-custom', title: '因子研究 / 预备因子 / 自选起始日', open: page => factorCustomOpen(page, '预备因子'), ready: factorCustomReady },
  {
    id: 'factor-manage', title: '因子研究 / 因子管理', open: page => factorOpen(page, '因子管理'),
    async ready(page) {
      await workspaceReady(page);
      const table = page.getByRole('table', { name: '因子管理列表', exact: true });
      await expect(table).toBeVisible();
      await expect(table.getByRole('switch').first()).toBeVisible();
      await expect(table.locator('tbody tr').first()).toContainText(/正式|预备/);
      await expect(page.getByText('加载中…', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^加载失败：/)).toHaveCount(0);
    },
  },
  {
    id: 'admin', title: '账号管理', open: page => top(page, '账号管理'),
    async ready(page) {
      await workspaceReady(page);
      const panel = page.getByRole('heading', { name: '账号管理', exact: true }).locator('..');
      await expect(panel.getByRole('textbox', { name: '搜索用户名', exact: true })).toBeEditable();
      await expect(panel.getByRole('table')).toBeVisible();
      await expect(panel.locator('tbody tr').first()).toContainText(/管理员|普通用户/);
      await expect(panel.getByText('正在加载账号…', { exact: true })).toHaveCount(0);
      await expect(panel.getByText(/第 \d+ 页 · 共 \d+ 个账号/)).toBeVisible();
      await expect(panel.getByRole('alert')).toHaveCount(0);
    },
  },
  {
    id: 'account', title: '账号设置',
    async open(page) {
      await workspaceReady(page);
      await page.getByRole('button', { name: '个人菜单', exact: true }).click();
      await page.getByRole('button', { name: '账号设置', exact: true }).click();
    },
    async ready(page) {
      await workspaceReady(page);
      const panel = page.getByRole('heading', { name: '账号设置', exact: true }).locator('..');
      for (const label of ['原密码', '新密码', '确认新密码']) await expect(panel.getByLabel(label, { exact: true })).toBeEditable();
      await expect(panel.locator('input[type="password"]')).toHaveCount(3);
      await expect(panel.getByRole('button', { name: '修改密码', exact: true })).toBeEnabled();
    },
  },
];
