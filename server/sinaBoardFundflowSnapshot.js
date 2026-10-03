// 新浪官网资金流向页面使用的概念分类及逐日资金接口。
// r0_net 为新浪口径的单日主力净额（元），不是分钟累计曲线。
// 官方字段定义：https://finance.sina.com.cn/temp/guest4377.shtml
const SINA_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://money.finance.sina.com.cn/moneyflow/",
};
const LIST_URL = "https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class";
const DAILY_URL =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_zjlrqs";
const YI = 1e8;
const BUDGET_MS = 25000;

// 与 boardFundflow.js 的题材筛选保持一致，剔除宽基、风格与聚合概念。
const AGGREGATE_BOARD_RE =
  /(风格|大盘|中盘|小盘|微盘|蓝筹|白马|绩优|高价股|低价股|百元股|融资融券|股通|沪深300|HS300|MSCI|明晟|标准普尔|标普|富时|罗素|成份|成分|上证|深成|深证|中证\d|国证|科创50|创业板指|新高|新低|多板|昨日|涨停|连板|触板|振幅|换手|重仓|持股|热股|证金|汇金|周期股|QFII|社保|险资|养老|外资|北向|央国企|国企改革|破净|预增|预减|预盈|预亏|送转|高送转|注册制|次新|可转债|转债|创投|举牌|增减持|增持|减持|回购|解禁|摘帽|参股|AH股|AB股|权重|指数|板块|股权激励|专精特新|资产重组|重组概念|整体上市|出口退税|独角兽|混改|分拆上市|股权转让|股票质押|含H股|含B股)/;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function mainAmount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function timeout(deadline, now, maximum) {
  const budget = deadline - now();
  return budget > 0 ? AbortSignal.timeout(Math.max(1, Math.min(maximum, Math.floor(budget)))) : null;
}

async function conceptBoards(request, deadline, now) {
  const signal = timeout(deadline, now, 12000);
  if (!signal) throw new Error("新浪单日资金快照查询超时");
  const response = await request(LIST_URL, { headers: SINA_HEADERS, signal });
  if (!response.ok) throw new Error(`新浪概念列表 HTTP ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const boards = new Map();
  for (const match of text.matchAll(/"(gn_[A-Za-z0-9]+)":"gn_[A-Za-z0-9]+,([^,]+),/g)) {
    const name = match[2].trim();
    if (name && !AGGREGATE_BOARD_RE.test(name)) boards.set(match[1], { code: match[1], name });
  }
  if (!boards.size) throw new Error("新浪概念列表无有效题材数据");
  return [...boards.values()];
}

async function dailySnapshot(board, { date, request, deadline, now }) {
  const signal = timeout(deadline, now, 8000);
  if (!signal) return null;
  // 指定日期必须精确匹配；绝不把其他交易日替换成所选日期。
  const url = `${DAILY_URL}?page=1&num=${date ? 120 : 1}&sort=opendate&asc=0&bankuai=${encodeURIComponent(board.code)}`;
  try {
    const response = await request(url, { headers: SINA_HEADERS, signal });
    if (!response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows)) return null;
    const valid = rows
      .filter((row) => row && validDate(row.opendate) && (!date || row.opendate === date))
      .map((row) => ({ dataDate: row.opendate, amount: mainAmount(row.r0_net) }))
      .filter((row) => row.amount !== null)
      .sort((a, b) => b.dataDate.localeCompare(a.dataDate));
    if (!valid.length) return null;
    return { ...board, ...valid[0] };
  } catch {
    return null;
  }
}

export async function loadSinaDaySnapshot({ top = 12, date = "", request = fetch, now = Date.now } = {}) {
  if (date && !validDate(date)) throw new Error("新浪单日资金快照日期无效");
  top = Math.min(25, Math.max(3, Math.floor(Number(top) || 12)));
  const deadline = now() + BUDGET_MS;
  const boards = await conceptBoards(request, deadline, now);
  const results = new Array(boards.length);
  let cursor = 0;
  async function worker() {
    while (cursor < boards.length && now() < deadline) {
      const index = cursor;
      cursor += 1;
      results[index] = await dailySnapshot(boards[index], { date, request, deadline, now });
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, boards.length) }, worker));
  const available = results.filter(Boolean);
  if (!available.length) {
    throw new Error(date ? `${date} 无可用的新浪单日主力资金快照` : "新浪单日主力资金快照不可用");
  }
  const dataDate = date || available.reduce((latest, row) => (row.dataDate > latest ? row.dataDate : latest), "");
  // 各板块可能更新不同步，统一日期后再比较金额，避免混排不同交易日。
  const sorted = available
    .filter((row) => row.dataDate === dataDate)
    .map((row) => ({
      code: row.code,
      name: row.name,
      points: [{ t: dataDate, v: row.amount / YI }],
      final: row.amount / YI,
    }))
    .sort((a, b) => b.final - a.final || a.code.localeCompare(b.code));
  const series = sorted.length > top * 2 ? [...sorted.slice(0, top), ...sorted.slice(-top)] : sorted;
  return {
    dim: "day",
    top,
    date: date || null,
    source: "sina",
    mode: "daily-snapshot",
    dataDate,
    asOf: dataDate,
    coverage: { available: sorted.length, total: boards.length },
    count: series.length,
    series,
    updatedAt: new Date(now()).toISOString(),
    notice: "东方财富日内曲线暂不可用，显示新浪口径的单日主力净流入快照。",
  };
}
