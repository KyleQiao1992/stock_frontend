import { handleHeatmapHistory } from "./heatmapHistory.js";
import { getRedisClient } from "./redisClient.js";
import { EM_UT, EM_FETCH_HEADERS, mapWithConcurrency } from "./boardTrend.js";

// 市场热力图：一次全 A 快照，按东财细分行业（f100，如「半导体」「银行Ⅱ」）聚合成树图数据。
// 行业视图和个股视图共用同一份数据，保证两边的面积/涨跌完全自洽。

// 全 A 股 clist 的市场过滤串：沪深主板 + 创业板 + 科创板 + 北交所，剔除 B 股/退市。
const ALL_A_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";

const PUSH2_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
  "https://1.push2.eastmoney.com",
  "https://82.push2.eastmoney.com",
];

const YI = 1e8; // 1 亿

// 每个行业返回多少只成分股。排名靠前的行业方块大、塞得下更多票，多给一些；
// 靠后的行业在树图里只是小格子，给少量即可，避免响应体无谓膨胀。
// 面积口径可以是流通市值或成交额，两种口径的头部票并不一样（如高换手小盘股），
// 所以两边各取一批再合并，切换口径时不会出现「大票缺席」。
const RICH_INDUSTRY_COUNT = 40;
const RICH_BY_CAP = 14;
const RICH_BY_AMOUNT = 10;
const LEAN_BY_CAP = 6;
const LEAN_BY_AMOUNT = 4;

function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

// 东财在非交易时段（约 21:00 到次日集合竞价）把当日行情字段整体重置成字符串 "-"，
// 而静态字段（代码/名称/行业/市值/昨收）照常有值。所以 "-" 必须解析成 null，
// 不能走 Number() 变 NaN —— 否则下面的过滤会把 5899 只票一条不剩地丢掉，
// 表现出来就像接口挂了（empty(total=5899)）。
function num(v) {
  if (v === "-" || v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 拉全 A 股快照（clist 分页，单页固定 100 条）。字段：
// f12 代码 / f13 市场(0深 1沪) / f14 名称 / f3 涨跌幅 / f6 成交额 / f20 总市值 / f21 流通市值 /
// f62 主力净流入 / f100 所属细分行业 / f124 该股行情时间戳（秒）。多 host 兜底。
// f124 很关键：东财这几个 host 给的是延时行情，拿它当「行情时间」透给前端，
// 用户能直接看到数据截止到几点，而不是把抓取时间误当成行情时间。
async function fetchAllStocks() {
  const PAGE = 100;
  function pageUrl(host, pn) {
    return (
      `${host}/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&ut=${EM_UT}` +
      `&fid=f20&fs=${ALL_A_FS}&fields=f12,f13,f14,f3,f6,f20,f21,f62,f100,f124`
    );
  }
  function parse(payload) {
    const list = payload?.data?.diff;
    const arr = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
    return arr
      .map((d) => ({
        code: String(d.f12 || ""),
        market: num(d.f13),
        name: String(d.f14 || "").trim(),
        pct: num(d.f3),
        amount: num(d.f6),
        cap: num(d.f20),
        floatCap: num(d.f21),
        mainInflow: num(d.f62),
        industry: String(d.f100 || "").trim(),
        quoteAt: num(d.f124),
      }))
      // 只要有代码和名称就保留：行情字段缺失是"还没开盘"，不是"这一行无效"。
      .filter((s) => s.code && s.name);
  }

  const errors = [];
  for (const host of PUSH2_HOSTS) {
    try {
      const first = await fetch(pageUrl(host, 1), { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!first.ok) {
        errors.push(`${host}: HTTP ${first.status}`);
        continue;
      }
      const firstPayload = await first.json();
      const total = Number(firstPayload?.data?.total) || 0;
      let rows = parse(firstPayload);
      if (!rows.length) {
        errors.push(`${host}: empty(total=${total})`);
        continue;
      }
      // 首页（按总市值排前 100 的大票）一条实时行情都没有 ⇒ 当前是非交易时段。
      // 这是东财全网统一的状态，再换 host 也是同样结果，直接告诉上层去用历史快照。
      if (!rows.some((s) => Number.isFinite(s.pct))) {
        return { stocks: [], live: false };
      }
      const pages = Math.min(80, Math.ceil(total / PAGE)); // 上限 80 页防御异常 total。
      if (pages > 1) {
        const rest = await mapWithConcurrency(
          Array.from({ length: pages - 1 }, (_, i) => i + 2),
          12,
          async (pn) => {
            try {
              const r = await fetch(pageUrl(host, pn), { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
              if (!r.ok) return [];
              return parse(await r.json());
            } catch {
              return [];
            }
          },
        );
        rows = rows.concat(...rest);
      }
      const seen = new Set();
      return { stocks: rows.filter((s) => (seen.has(s.code) ? false : seen.add(s.code))), live: true };
    } catch (e) {
      errors.push(`${host}: ${e?.message || e}`);
    }
  }
  throw new Error(`全A快照不可用：${errors.slice(-4).join("；")}`);
}

// 按行业聚合。面积口径（流通市值/成交额）由前端切换，这里两个都算好；
// 行业涨跌幅用流通市值加权，和「板块涨跌幅」的口径一致（停牌股 f21 为 0，自然不参与）。
function aggregate(stocks) {
  const map = new Map();
  for (const s of stocks) {
    const key = s.industry || "其他";
    let row = map.get(key);
    if (!row) {
      row = { name: key, count: 0, quoted: 0, up: 0, down: 0, cap: 0, floatCap: 0, amount: 0, mainInflow: 0, weighted: 0, weight: 0, pctSum: 0, members: [] };
      map.set(key, row);
    }
    row.count += 1;
    // 停牌股（以及非交易时段的全部个股）pct 为 null，不计入涨跌统计，
    // 否则会被当成 0 稀释掉行业涨跌幅。
    if (Number.isFinite(s.pct)) {
      row.quoted += 1;
      row.pctSum += s.pct;
      if (s.pct > 0) row.up += 1;
      else if (s.pct < 0) row.down += 1;
    }
    if (Number.isFinite(s.cap)) row.cap += s.cap;
    if (Number.isFinite(s.amount)) row.amount += s.amount;
    if (Number.isFinite(s.mainInflow)) row.mainInflow += s.mainInflow;
    if (Number.isFinite(s.floatCap) && s.floatCap > 0) {
      row.floatCap += s.floatCap;
      if (Number.isFinite(s.pct)) {
        row.weighted += s.floatCap * s.pct;
        row.weight += s.floatCap;
      }
    }
    row.members.push(s);
  }

  const industries = [...map.values()].sort((a, b) => b.floatCap - a.floatCap);
  // 「头部行业」按两种面积口径分别排名后取并集：默认口径是成交额，而像电子化学品Ⅱ这种
  // 成交额第 9、流通市值第 41 的行业，只按市值排会被划进精简档、成分股不够铺满它的大方块。
  const amountRank = new Map(
    [...industries].sort((a, b) => b.amount - a.amount).map((row, i) => [row.name, i]),
  );
  return industries.map((row, idx) => {
    const rich = idx < RICH_INDUSTRY_COUNT || (amountRank.get(row.name) ?? Infinity) < RICH_INDUSTRY_COUNT;
    const byCap = row.members.slice().sort((a, b) => (b.floatCap || 0) - (a.floatCap || 0));
    const byAmount = row.members.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const picked = new Map();
    for (const s of byCap.slice(0, rich ? RICH_BY_CAP : LEAN_BY_CAP)) picked.set(s.code, s);
    for (const s of byAmount.slice(0, rich ? RICH_BY_AMOUNT : LEAN_BY_AMOUNT)) picked.set(s.code, s);
    const members = [...picked.values()]
      .sort((a, b) => (b.floatCap || 0) - (a.floatCap || 0))
      .map((s) => ({
        code: s.code,
        name: s.name,
        market: s.market,
        pct: round2(s.pct),
        cap: round2(s.cap / YI),
        floatCap: round2(s.floatCap / YI),
        amount: round2(s.amount / YI),
        mainInflow: round2(s.mainInflow / YI),
      }));
    return {
      name: row.name,
      count: row.count,
      up: row.up,
      down: row.down,
      cap: round2(row.cap / YI),
      floatCap: round2(row.floatCap / YI),
      amount: round2(row.amount / YI),
      mainInflow: round2(row.mainInflow / YI),
      // pct：流通市值加权，和「方块面积＝流通市值」同口径，大票主导大方块的颜色。
      // pctEqual：成分股等权平均，用于和行情软件的「板块涨跌幅」对照——东财板块列表基本就是这个口径
      // （128 个可对照行业里中位偏差 0.004pp），少数行业例外（如光学光电子，东财板块指数本身
      // 就和它自己的成分股对不上）。加权与等权在个股分化大的行业能差几个百分点，都不是错，是口径不同。
      pct: row.weight > 0 ? round2(row.weighted / row.weight) : null,
      pctEqual: row.quoted > 0 ? round2(row.pctSum / row.quoted) : null,
      stocks: members,
    };
  });
}

// 最近一次全量快照。列表接口返回的是裁剪过的成分股（够铺树图就行），
// 行业下钻要看全部成分股时从这里取，避免为此把响应体撑到几百 KB。
let snapshot = null; // { stocks, at }

async function computeHeatmap() {
  const t0 = Date.now();
  const fetched = await fetchAllStocks();
  if (!fetched.live) {
    console.log("[market-heatmap] 非交易时段：东财当日行情字段为 \"-\"，回落到最近一次有效快照");
    return { live: false };
  }
  const stocks = fetched.stocks;
  snapshot = { stocks, at: Date.now() };
  const industries = aggregate(stocks);
  // 停牌股 pct 为 null，不再像过去那样被整行丢弃（丢弃会让它连方块都没有），
  // 但涨跌家数只按有行情的票统计，否则停牌股会被算进"平盘"，把口径撑大。
  const quoted = stocks.filter((s) => Number.isFinite(s.pct));
  const up = quoted.filter((s) => s.pct > 0).length;
  const down = quoted.filter((s) => s.pct < 0).length;
  // 行情时间取全市场最新的一条：延时源里各股推送时刻略有先后。
  const quoteAt = stocks.reduce((max, s) => (Number.isFinite(s.quoteAt) && s.quoteAt > max ? s.quoteAt : max), 0);
  console.log(
    `[market-heatmap] stocks=${stocks.length} industries=${industries.length} up=${up} down=${down} totalMs=${Date.now() - t0}`,
  );
  return {
    live: true,
    scope: "ashare",
    totalStocks: stocks.length,
    up,
    down,
    flat: quoted.length - up - down,
    suspended: stocks.length - quoted.length, // 停牌/无行情

    industries,
    quoteTime: quoteAt > 0 ? new Date(quoteAt * 1000).toISOString() : null, // 行情截止时刻（延时源）
    updatedAt: new Date().toISOString(), // 本次抓取时刻
  };
}

// ===== 缓存（stale-while-revalidate）=====
// 全量快照要 6~15s，纯 TTL 缓存会让过期后的第一个人吃满慢加载。
// 新鲜期内直接给缓存；过了新鲜期先给旧数据、后台静默重算；彻底过期才同步等。
// 与 todayMarket 同构，只是热力图刷新更快、窗口更短。
const CACHE_KEY = "market-heatmap:v1";
const CACHE_TS_KEY = "market-heatmap:v1:ts";
const FRESH_MS = 60 * 1000; // 1 分钟内直接返回缓存。
const STALE_MS = 15 * 60 * 1000; // 1~15 分钟返回旧数据并后台刷新；超过则同步重算。
const REDIS_TTL_SEC = Math.round(STALE_MS / 1000);

// 最近一次「拿到真实行情」的快照，TTL 给到 7 天，足够跨过周末和小长假。
// 非交易时段（每天约 21:00 至次日 09:30、以及整个周末）东财不推当日行情，
// 这时热力图展示的就是它 —— 上一个交易日的收盘全景，并标注数据截止时间。
const LAST_GOOD_KEY = "market-heatmap:v1:lastgood";
const LAST_GOOD_TTL_SEC = 7 * 24 * 60 * 60;

let memEntry = null; // { body, cachedAt } —— Redis 不可用时的进程内兜底。
let memLastGood = null; // 最近一次有效快照的进程内副本。
let refreshing = null; // 单飞：进行中的重算 Promise。

async function readLastGood(redis) {
  if (memLastGood) return memLastGood;
  if (!redis) return null;
  try {
    const v = await redis.get(LAST_GOOD_KEY);
    if (v) memLastGood = v;
    return v;
  } catch {
    return null;
  }
}

async function readCache(redis) {
  if (memEntry) return memEntry;
  if (!redis) return null;
  try {
    const [body, ts] = await Promise.all([redis.get(CACHE_KEY), redis.get(CACHE_TS_KEY)]);
    if (!body) return null;
    memEntry = { body, cachedAt: Number(ts) || 0 };
    return memEntry;
  } catch {
    return null;
  }
}

function refreshCache(redis) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const payload = await computeHeatmap();

    // 非交易时段：不要用这份没有行情的空快照覆盖缓存，改为回放最近一次有效快照。
    if (!payload.live) {
      const last = await readLastGood(redis);
      if (last) {
        const body = JSON.stringify({ ...JSON.parse(last), stale: true, marketClosed: true });
        memEntry = { body, cachedAt: Date.now() };
        return body;
      }
      // 冷启动恰好撞上非交易时段：确实一份历史数据都没有，给前端一个明确的状态，
      // 而不是抛错让页面显示红字。开盘后第一次刷新就会自动补上。
      const body = JSON.stringify({
        live: false,
        marketClosed: true,
        scope: "ashare",
        totalStocks: 0,
        up: 0,
        down: 0,
        flat: 0,
        industries: [],
        quoteTime: null,
        updatedAt: new Date().toISOString(),
        notice: "当前非交易时段，东方财富暂未推送行情数据。开盘（09:30）后自动恢复。",
      });
      memEntry = { body, cachedAt: Date.now() };
      return body;
    }

    const body = JSON.stringify(payload);
    memEntry = { body, cachedAt: Date.now() };
    memLastGood = body;
    if (redis) {
      try {
        await Promise.all([
          redis.set(CACHE_KEY, body, { EX: REDIS_TTL_SEC }),
          redis.set(CACHE_TS_KEY, String(memEntry.cachedAt), { EX: REDIS_TTL_SEC }),
          redis.set(LAST_GOOD_KEY, body, { EX: LAST_GOOD_TTL_SEC }),
        ]);
      } catch {
        // 缓存写失败不影响返回。
      }
    }
    return body;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// 单个行业的全部成分股，按流通市值降序。
function industryDetail(name) {
  const stocks = (snapshot?.stocks || [])
    .filter((s) => (s.industry || "其他") === name)
    .sort((a, b) => (b.floatCap || 0) - (a.floatCap || 0))
    .map((s) => ({
      code: s.code,
      name: s.name,
      market: s.market,
      pct: round2(s.pct),
      cap: round2(s.cap / YI),
      floatCap: round2(s.floatCap / YI),
      amount: round2(s.amount / YI),
      mainInflow: round2(s.mainInflow / YI),
    }));
  return { industry: name, count: stocks.length, stocks, updatedAt: new Date(snapshot?.at || Date.now()).toISOString() };
}

export function createMarketHeatmapHandler() {
  // 服务启动时后台预热 Redis 快照，避免首位用户等待远端缓存建连和读取。
  getRedisClient()
    .then((redis) => Promise.all([readCache(redis), readLastGood(redis)]))
    .catch(() => {});

  return async function marketHeatmapHandler(req, res) {
    if (handleHeatmapHistory(req, res)) return;
    const sendJson = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(body);
    };

    let redis = null;
    try {
      redis = await getRedisClient();
    } catch {
      // Redis 不可用则只走进程内缓存兜底。
    }

    // 行业下钻：要的是该行业全部成分股，走进程内全量快照（必要时先刷一次）。
    const industry = new URL(req.url || "", "http://localhost").searchParams.get("industry");
    if (industry) {
      try {
        if (!snapshot || Date.now() - snapshot.at > STALE_MS) await refreshCache(redis);
        // 非交易时段 snapshot 为空，退回最近一次有效快照里该行业的成分股。
        if (!snapshot?.stocks?.length) {
          const last = await readLastGood(redis);
          const prev = last ? JSON.parse(last) : null;
          const hit = (prev?.industries || []).find((x) => x.name === industry);
          sendJson(
            200,
            JSON.stringify({
              industry,
              count: hit?.stocks?.length || 0,
              stocks: hit?.stocks || [],
              updatedAt: prev?.updatedAt || new Date().toISOString(),
              stale: true,
            }),
          );
          return;
        }
        sendJson(200, JSON.stringify(industryDetail(industry)));
      } catch (error) {
        sendJson(502, JSON.stringify({ error: error?.message || String(error) }));
      }
      return;
    }

    const entry = await readCache(redis);
    if (entry) {
      const age = Date.now() - entry.cachedAt;
      if (age < STALE_MS) {
        if (age >= FRESH_MS) refreshCache(redis).catch(() => {});
        sendJson(200, entry.body);
        return;
      }
    }

    try {
      sendJson(200, await refreshCache(redis));
    } catch (error) {
      // 重算失败时宁可返回旧数据也别报错。
      if (entry) sendJson(200, entry.body);
      else sendJson(502, JSON.stringify({ error: error?.message || String(error) }));
    }
  };
}
