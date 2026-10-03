import { handleHeatmapHistory } from "./heatmapHistory.js";
import { getRedisClient } from "./redisClient.js";
import { EM_UT, EM_FETCH_HEADERS, mapWithConcurrency } from "./boardTrend.js";
import { createMarketSnapshotCache } from "./marketSnapshotCache.js";
import { hasSameDayMarketCapital } from "./eastmoneyMarketCapital.js";

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
export async function fetchAllStocks({request = fetch, now = Date.now} = {}) {
  const deadline = now() + 15000;
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - now())));
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
  let lastCause;
  for (const host of PUSH2_HOSTS) {
    if (now() >= deadline) break;
    try {
      const first = await request(pageUrl(host, 1), { headers: EM_FETCH_HEADERS, signal: signal() });
      if (!first.ok) {
        errors.push(`${host}: HTTP ${first.status}`);
        continue;
      }
      const firstPayload = await first.json();
      const total = Number(firstPayload?.data?.total) || 0;
      if (!Number.isInteger(total) || total <= 0) throw new Error("全A快照总数无效");
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
            if (now() >= deadline) return [];
            try {
              const r = await request(pageUrl(host, pn), { headers: EM_FETCH_HEADERS, signal: signal() });
              if (!r.ok) return [];
              return parse(await r.json());
            } catch (error) {
              lastCause = error;
              return [];
            }
          },
        );
        if (rest.some((page) => !page.length)) throw new Error("全A快照分页不完整");
        rows = rows.concat(...rest);
      }
      const seen = new Set();
      const stocks = rows.filter((s) => (seen.has(s.code) ? false : seen.add(s.code)));
      if (stocks.length < total) throw new Error("全A快照数量不完整");
      return { stocks, live: true };
    } catch (e) {
      if (!lastCause || e?.cause || e?.code) lastCause = e;
      errors.push(`${host}: ${e?.message || e}`);
    }
  }
  throw new Error(`全A快照不可用：${errors.slice(-4).join("；")}`, {cause: lastCause});
}

// 按行业聚合。面积口径（流通市值/成交额）由前端切换，这里两个都算好；
// 行业涨跌幅用流通市值加权，和「板块涨跌幅」的口径一致（停牌股 f21 为 0，自然不参与）。
export function aggregateHeatmapStocks(stocks) {
  const map = new Map();
  for (const s of stocks) {
    const key = s.industry || "其他";
    let row = map.get(key);
    if (!row) {
      row = { name: key, count: 0, quoted: 0, up: 0, down: 0, cap: 0, floatCap: 0, amount: 0, mainInflow: 0,
        capKnown: 0, floatCapKnown: 0, amountKnown: 0, mainInflowKnown: 0, weighted: 0, weight: 0, pctSum: 0, members: [] };
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
    if (Number.isFinite(s.cap)) { row.cap += s.cap; row.capKnown += 1; }
    if (Number.isFinite(s.floatCap)) row.floatCapKnown += 1;
    if (Number.isFinite(s.amount)) { row.amount += s.amount; row.amountKnown += 1; }
    if (Number.isFinite(s.mainInflow)) { row.mainInflow += s.mainInflow; row.mainInflowKnown += 1; }
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
        cap: Number.isFinite(s.cap) ? round2(s.cap / YI) : null,
        floatCap: Number.isFinite(s.floatCap) ? round2(s.floatCap / YI) : null,
        amount: Number.isFinite(s.amount) ? round2(s.amount / YI) : null,
        mainInflow: Number.isFinite(s.mainInflow) ? round2(s.mainInflow / YI) : null,
      }));
    return {
      name: row.name,
      count: row.count,
      up: row.up,
      down: row.down,
      cap: row.capKnown ? round2(row.cap / YI) : null,
      floatCap: row.floatCapKnown ? round2(row.floatCap / YI) : null,
      amount: row.amountKnown ? round2(row.amount / YI) : null,
      mainInflow: row.mainInflowKnown ? round2(row.mainInflow / YI) : null,
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
async function computeHeatmap() {
  const t0 = Date.now();
  const fetched = await fetchAllStocks();
  if (!fetched.live) {
    console.log("[market-heatmap] 非交易时段：东财当日行情字段为 \"-\"，回落到最近一次有效快照");
    return { live: false };
  }
  const stocks = fetched.stocks;
  const industries = aggregateHeatmapStocks(stocks);
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
  const payload = {
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
  return {payload, snapshot: {stocks, at: Date.now()}};
}

// Full aggregates keep the established cache format; raw members use a private key.
const SNAPSHOT_KEY = "market-heatmap:v2:stocks:lastgood";
const FALLBACK_SNAPSHOT_KEY = "market-heatmap:v3:stocks:lastgood";
const MAX_CACHE_AGE = 7 * 86400000;
export { aggregateHeatmapStocks as aggregate };

function validHeatmap(payload) {
  if (["sina", "sina-tencent"].includes(payload?.source)) return false;
  const finiteOrNull = (value) => value == null || Number.isFinite(value);
  const counts = [payload?.up, payload?.down, payload?.flat, payload?.suspended ?? 0];
  const valid = payload?.live === true && Number.isInteger(payload.totalStocks) && payload.totalStocks > 0
    && counts.every((count) => Number.isInteger(count) && count >= 0) && counts.reduce((sum, count) => sum + count, 0) === payload.totalStocks
    && Array.isArray(payload.industries) && payload.industries.length > 0
    && payload.industries.every((row) => row && typeof row.name === "string" && row.name
      && Number.isInteger(row.count) && row.count > 0 && Array.isArray(row.stocks) && row.stocks.length <= row.count
      && [row.cap, row.floatCap, row.amount, row.mainInflow, row.pct, row.pctEqual].every(finiteOrNull)
      && row.stocks.every((stock) => stock && typeof stock.code === "string" && stock.code && typeof stock.name === "string" && stock.name
        && [stock.cap, stock.floatCap, stock.amount, stock.mainInflow, stock.pct].every(finiteOrNull)));
  if (!valid) return false;
  const alternate = ["eastmoney-tencent", "eastmoney-sina"].includes(payload.source);
  if (!alternate && !payload.partial && payload.mode !== "snapshot") return !payload.source || payload.source === "eastmoney";
  const coverage = payload.classificationCoverage;
  const quotes = payload.quoteCoverage;
  return payload.partial === true && payload.mode === "snapshot"
    && payload.snapshotSchemaVersion === 3 && payload.universePolicy === "listed-ashare-with-cdr"
    && payload.classificationSource === "eastmoney"
    && payload.industryLevel === 2 && payload.classification === "东方财富行业"
    && ["eastmoney-tencent", "eastmoney-sina"].includes(payload.source)
    && hasSameDayMarketCapital(payload, payload.totalStocks)
    && coverage?.total === payload.totalStocks && coverage.classified === payload.totalStocks
    && coverage.unclassified === 0 && coverage.conflicts === 0
    && quotes?.total === payload.totalStocks && Number.isSafeInteger(quotes.quoted) && quotes.quoted >= 0
    && Number.isSafeInteger(quotes.unavailable) && quotes.unavailable >= 0
    && quotes.quoted === payload.up + payload.down + payload.flat && quotes.unavailable === (payload.suspended ?? 0)
    && quotes.quoted + quotes.unavailable === quotes.total
    && payload.industries.every((row) => row.name.trim() && !["未分类", "其他", "-"].includes(row.name.trim()))
    && payload.industries.reduce((sum, row) => sum + row.count, 0) === payload.totalStocks;
}

function stockDetail(stocks, name) {
  return stocks.filter((stock) => (stock.industry || "其他") === name)
    .sort((a, b) => (b.floatCap || 0) - (a.floatCap || 0))
    .map((stock) => ({
      code: stock.code, name: stock.name, market: stock.market, pct: round2(stock.pct),
      cap: Number.isFinite(stock.cap) ? round2(stock.cap / YI) : null,
      floatCap: Number.isFinite(stock.floatCap) ? round2(stock.floatCap / YI) : null,
      amount: Number.isFinite(stock.amount) ? round2(stock.amount / YI) : null,
      mainInflow: Number.isFinite(stock.mainInflow) ? round2(stock.mainInflow / YI) : null,
    }));
}

export function createMarketHeatmapHandler({ load = computeHeatmap, loadFallback = null, getRedis = getRedisClient, now = Date.now, historyHandler = handleHeatmapHistory } = {}) {
  let snapshot = null;
  const sourceOf = (payload) => payload?.source || "eastmoney";
  const snapshotKeyFor = (payload) => sourceOf(payload) === "eastmoney" ? SNAPSHOT_KEY : FALLBACK_SNAPSHOT_KEY;
  const validSnapshot = (candidate, payload) => candidate && Array.isArray(candidate.stocks) && candidate.stocks.length > 0
    && candidate.stocks.length === payload.totalStocks
    && candidate.stocks.every((stock) => stock && typeof stock.code === "string" && stock.code && typeof stock.name === "string" && stock.name)
    && Number.isFinite(candidate.at) && candidate.at <= now() && now() - candidate.at < MAX_CACHE_AGE
    && candidate.updatedAt === payload.updatedAt && candidate.source === sourceOf(payload);
  const cache = createMarketSnapshotCache({
    key: "market-heatmap:v1", freshMs: 60000, staleMs: 15 * 60000, load, loadFallback, fallbackVersion: 3, validate: validHeatmap, now,
    emptyClosed: (at) => ({live: false, marketClosed: true, scope: "ashare", totalStocks: 0, up: 0, down: 0, flat: 0, industries: [], quoteTime: null,
      updatedAt: new Date(at).toISOString(), notice: "当前数据源未提供当日行情，且没有可用的历史快照。"}),
    onFull: async (result, redis) => {
      const candidate = result.snapshot ? {...result.snapshot, at: Date.parse(result.payload.updatedAt), updatedAt: result.payload.updatedAt, source: sourceOf(result.payload)} : null;
      if (!validSnapshot(candidate, result.payload)) return;
      snapshot = candidate;
      if (redis) { try { await redis.set(snapshotKeyFor(result.payload), JSON.stringify(candidate), {EX: MAX_CACHE_AGE / 1000}); } catch { /* Aggregate remains available. */ } }
    },
  });

  async function readSnapshot(redis, payload) {
    if (validSnapshot(snapshot, payload)) return snapshot;
    if (!redis) return null;
    try {
      const raw = await redis.get(snapshotKeyFor(payload));
      const candidate = raw ? JSON.parse(raw) : null;
      if (validSnapshot(candidate, payload)) { snapshot = candidate; return candidate; }
    } catch { /* Cropped same-source members remain usable. */ }
    return null;
  }

  return async function marketHeatmapHandler(req, res) {
    if (historyHandler(req, res)) return;
    function send(status, payload) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(payload));
    }
    let redis = null;
    try { redis = await getRedis(); } catch { /* Valid process memory works without Redis. */ }
    try {
      const query = new URL(req.url || "", "http://localhost").searchParams;
      let payload = await cache.get(redis, {retry: query.get("retry") === "1"});
      const industry = query.get("industry");
      if (!industry) { send(200, payload); return; }
      const requestedSource = query.get("source");
      if (requestedSource && requestedSource !== sourceOf(payload)) {
        const candidates = [await cache.lastGood(redis), await cache.lastFallback(redis)];
        const hit = candidates.find((candidate) => candidate && sourceOf(candidate.payload) === requestedSource);
        if (!hit) throw new Error("行业缓存与当前行情来源不一致，请刷新热力图后重试。");
        payload = {...hit.payload, stale: true, staleReason: "source-changed"};
      }
      const raw = await readSnapshot(redis, payload);
      const aggregate = payload.industries?.find((row) => row.name === industry);
      if (!raw && !aggregate) throw new Error("暂无该行业的同来源缓存，请刷新热力图后重试。");
      const stocks = raw ? stockDetail(raw.stocks, industry) : aggregate.stocks;
      const partial = !raw;
      send(200, {
        industry, stocks, count: stocks.length, returnedCount: stocks.length,
        totalCount: aggregate?.count ?? stocks.length, partial, providerPartial: Boolean(payload.partial),
        source: sourceOf(payload), classification: payload.classification, coverage: payload.coverage,
        quoteTime: payload.quoteTime, updatedAt: payload.updatedAt,
        stale: Boolean(payload.stale), staleReason: payload.staleReason, marketClosed: payload.marketClosed,
        notice: partial ? "缓存仅包含该行业的部分成分股，不能视为完整行业列表。" : payload.notice,
      });
    } catch {
      send(502, {error: "行情数据源暂不可用，且没有匹配的有效缓存，请稍后重试。"});
    }
  };
}
