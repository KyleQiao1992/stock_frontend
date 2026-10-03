import { getRedisClient } from "./redisClient.js";
import { EM_UT, EM_FETCH_HEADERS, fetchConceptBoardList, mapWithConcurrency } from "./boardTrend.js";
import { loadSinaDaySnapshot } from "./sinaBoardFundflowSnapshot.js";

// 维度 → 东财 fflow klt + 取多少根。
// day：klt=1 盘中分钟，f52 本身就是“自开盘累计主力净流入”，直接当曲线。
// week/month：klt=101 日度（f52=当日主力净流入），自己在窗口内做累加，得到“本周/本月以来累计”。
// lmt 取得比 window 大很多，是为了支持“选历史日期”——多拉些日度数据，好截取到任意结束日的窗口。
const DIM_CONFIG = {
  day: { klt: 1, lmt: 0, window: 0, label: "日" },
  week: { klt: 101, lmt: 80, window: 5, label: "周" }, // 近 5 个交易日累计
  month: { klt: 101, lmt: 160, window: 21, label: "月" }, // 近 21 个交易日累计
};

const YI = 1e8; // 1 亿

// 概念板块里混着一批“宽基/风格/聚合”板（融资融券、沪深股通、HS300、标普/富时/MSCI、大盘股、机构重仓…），
// 它们把几百只票打包、体量巨大，会霸占净流入两端，淹没真正的行业/题材板。这里按关键词剔除，只留题材板。
const AGGREGATE_BOARD_RE =
  /(风格|大盘|中盘|小盘|微盘|蓝筹|白马|绩优|高价股|低价股|百元股|融资融券|股通|沪深300|HS300|MSCI|明晟|标准普尔|标普|富时|罗素|成份|成分|上证|深成|深证|中证\d|国证|科创50|创业板指|新高|新低|多板|昨日|涨停|连板|触板|振幅|换手|重仓|持股|热股|证金|汇金|周期股|QFII|社保|险资|养老|外资|北向|央国企|国企改革|破净|预增|预减|预盈|预亏|送转|高送转|注册制|次新|可转债|转债|创投|举牌|增减持|增持|减持|回购|解禁|摘帽|参股|AH股|AB股|权重|指数|板块|股权激励|专精特新|资产重组|重组概念|整体上市|出口退税|独角兽|混改|分拆上市|股权转让|股票质押|含H股|含B股)/;

function isThemeBoard(name) {
  return !AGGREGATE_BOARD_RE.test(String(name || ""));
}

// 拉单个板块的资金流序列，返回 [{ t, v }]，v 单位“亿”，且为窗口内累计值。
// endDate（YYYY-MM-DD，可空）：窗口的结束日。
//  - day：盘中分钟仅最新交易日有；endDate 指定且与数据日期不符则返回 null（历史日内不可用）。
//  - week/month：从日度序列里截取“截至 endDate”的最后 window 根再累加。
async function fetchFflowSeries(code, dim, deadline, endDate) {
  const cfg = DIM_CONFIG[dim];
  const isIntraday = dim === "day";
  // 盘中分钟用 fflow/kline（push2delay 有当日）；日度历史用 fflow/daykline（push2his 有约 120 天历史，
  // push2delay 只留 1 天，所以两类用不同的 host 优先级）。
  const path = isIntraday ? "stock/fflow/kline" : "stock/fflow/daykline";
  const hosts = isIntraday
    ? ["https://push2delay.eastmoney.com", "https://push2his.eastmoney.com", "https://79.push2his.eastmoney.com"]
    : ["https://push2his.eastmoney.com", "https://79.push2his.eastmoney.com", "https://push2delay.eastmoney.com"];
  const url =
    `/api/qt/${path}/get?secid=90.${code}&ut=${EM_UT}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=${cfg.klt}&lmt=0`;

  for (const host of hosts) {
    const budget = deadline - Date.now();
    if (budget <= 0) break;
    try {
      const res = await fetch(`${host}${url}`, { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(Math.min(8000, budget)) });
      if (!res.ok) continue;
      const payload = await res.json();
      const klines = payload?.data?.klines;
      if (!Array.isArray(klines) || !klines.length) continue;

      const rows = klines
        .map((line) => {
          const p = String(line).split(",");
          return { t: p[0], main: Number(p[1]) };
        })
        .filter((r) => r.t && Number.isFinite(r.main));
      if (!rows.length) continue;

      if (dim === "day") {
        // f52 已是当日累计，直接换算成亿。盘中分钟仅当日：若指定了历史日期且对不上，视为无数据。
        if (endDate && !String(rows[0].t).startsWith(endDate)) return null;
        return rows.map((r) => ({ t: r.t, v: r.main / YI }));
      }
      // 周/月：先按 endDate 截断（取最后一根 <= endDate 的位置），再取窗口内日度净流入累加。
      let end = rows.length - 1;
      if (endDate) {
        end = -1;
        for (let i = 0; i < rows.length; i += 1) if (String(rows[i].t).slice(0, 10) <= endDate) end = i;
        if (end < 0) return null; // 该日期早于可得历史。
      }
      const windowed = rows.slice(Math.max(0, end - cfg.window + 1), end + 1);
      let acc = 0;
      return windowed.map((r) => {
        acc += r.main;
        return { t: r.t, v: acc / YI };
      });
    } catch {
      // try next host
    }
  }
  return null;
}

// ============ 新浪源（周/月日度历史用）============
// 东财日度历史 host（push2his）在部分网络连不上；新浪有板块逐日资金流且很稳，作为周/月的数据源。
// 新浪板块代码体系（gn_xxx 概念 / hangye_xxx 行业）与东财 BK 不通用，所以周/月整套走新浪。
const SINA_HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" };

// 新浪概念板块列表（GBK）：返回 [{ code: gn_xxx, name }]，已剔除聚合/风格板。
async function fetchSinaConceptBoards() {
  const res = await fetch("https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class", {
    headers: SINA_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`新浪板块列表 HTTP ${res.status}`);
  const text = new TextDecoder("gbk").decode(await res.arrayBuffer());
  const boards = [];
  for (const m of text.matchAll(/"(gn_[A-Za-z0-9]+)":"gn_[A-Za-z0-9]+,([^,]+),/g)) {
    const name = m[2].trim();
    if (name && isThemeBoard(name)) boards.push({ code: m[1], name });
  }
  return boards;
}

// 新浪单板块逐日资金流：返回 [{ t: 日期, main: 主力净额(元) }]，按日期升序。num 取最近多少天。
async function fetchSinaBoardDaily(code, num, deadline) {
  const budget = deadline - Date.now();
  if (budget <= 0) return null;
  const url =
    `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_zjlrqs` +
    `?page=1&num=${num}&sort=opendate&asc=0&bankuai=${code}`;
  try {
    const res = await fetch(url, { headers: SINA_HEADERS, signal: AbortSignal.timeout(Math.min(8000, budget)) });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    // 新浪返回降序（最新在前），反转成升序；r0_net = 主力净额。
    return arr
      .map((r) => ({ t: String(r.opendate || ""), main: Number(r.r0_net) }))
      .filter((r) => r.t && Number.isFinite(r.main))
      .reverse();
  } catch {
    return null;
  }
}

// 周/月：用新浪日度资金流，拉全部概念板块、窗口内累加，再按期末值取两端。
async function loadBoardFundflowFromSina({ dim, top, date }) {
  const cfg = DIM_CONFIG[dim];
  const t0 = Date.now();
  const boards = await fetchSinaConceptBoards();
  const listMs = Date.now() - t0;

  // 多拉一点缓冲，方便“选历史日期”时截到该日的窗口。
  const num = Math.min(120, cfg.window + (date ? 90 : 10));
  const deadline = Date.now() + 25000;
  const series = await mapWithConcurrency(boards, 10, async (board) => {
    if (Date.now() > deadline) return null;
    const rows = await fetchSinaBoardDaily(board.code, num, deadline);
    if (!rows || rows.length < 2) return null;

    let end = rows.length - 1;
    if (date) {
      end = -1;
      for (let i = 0; i < rows.length; i += 1) if (rows[i].t.slice(0, 10) <= date) end = i;
      if (end < 0) return null;
    }
    const windowed = rows.slice(Math.max(0, end - cfg.window + 1), end + 1);
    if (windowed.length < 2) return null;
    let acc = 0;
    const points = windowed.map((r) => {
      acc += r.main;
      return { t: r.t, v: acc / YI };
    });
    return { code: board.code, name: board.name, points, final: points[points.length - 1].v };
  });

  const sorted = series.filter(Boolean).sort((a, b) => b.final - a.final);
  const finalSeries = sorted.length > top * 2 ? [...sorted.slice(0, top), ...sorted.slice(-top)] : sorted;
  console.log(
    `[board-fundflow] src=sina dim=${dim} top=${top} date=${date || "latest"} boards=${boards.length} ` +
      `series=${finalSeries.length} listMs=${listMs} totalMs=${Date.now() - t0}`,
  );
  return { dim, top, date: date || null, source: "sina", count: finalSeries.length, series: finalSeries, updatedAt: new Date().toISOString() };
}

export async function loadBoardFundflow({ dim, top, date }) {
  // 周/月走新浪日度（东财历史 host 部分网络不可达）；日（盘中分钟）仍走东财 push2delay。
  if (dim !== "day") return loadBoardFundflowFromSina({ dim, top, date });

  const t0 = Date.now();
  // 日内主源的目录最多等待 8 秒，避免四个节点顺序超时使兜底迟迟无法启动。
  const boards = await fetchConceptBoardList({ signal: AbortSignal.timeout(8000) });
  const listMs = Date.now() - t0;

  // 候选池：剔除宽基/风格/聚合板，只留题材板，按“今日主力净流入 f62”取两端各 top 个。
  // 注意：日度历史 host（push2his）对突发并发很敏感，候选数和并发都要克制，否则会被限流封 IP。
  // 选历史日期时多取一点点（1.5*top），以便按所选窗口的累计值微调两端排名。
  const withInflow = boards.filter((b) => Number.isFinite(b.mainInflow) && isThemeBoard(b.name));
  withInflow.sort((a, b) => b.mainInflow - a.mainInflow);
  const pool = Math.min(date ? Math.round(top * 1.5) : top, Math.ceil(withInflow.length / 2));
  const pickedMap = new Map();
  for (const b of [...withInflow.slice(0, pool), ...withInflow.slice(-pool)]) pickedMap.set(b.code, b);
  const picked = [...pickedMap.values()];

  const deadline = Date.now() + 25000;
  // 盘中 day（push2delay）可以快一点；周/月走 push2his 历史 host，并发压到 6 以防被限流。
  const concurrency = dim === "day" ? 12 : 6;
  const series = await mapWithConcurrency(picked, concurrency, async (board) => {
    if (Date.now() > deadline) return null;
    const points = await fetchFflowSeries(board.code, dim, deadline, date);
    if (!points || points.length < 2) return null;
    return {
      code: board.code,
      name: board.name,
      points,
      final: points[points.length - 1].v, // 期末累计值（亿），用于排序和右侧标注。
    };
  });

  // 按所选窗口的期末累计值排序，从候选池里取真正的两端各 top 个。
  const sorted = series.filter(Boolean).sort((a, b) => b.final - a.final);
  const finalSeries =
    sorted.length > top * 2 ? [...sorted.slice(0, top), ...sorted.slice(-top)] : sorted;
  console.log(
    `[board-fundflow] dim=${dim} top=${top} date=${date || "latest"} picked=${picked.length} ` +
      `series=${finalSeries.length} listMs=${listMs} totalMs=${Date.now() - t0}`,
  );

  return { dim, top, date: date || null, source: "eastmoney", mode: "intraday", count: finalSeries.length, series: finalSeries, updatedAt: new Date().toISOString() };
}

const LAST_GOOD_MS = 7 * 24 * 60 * 60 * 1000;

function shanghaiDate(timestamp) {
  return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function normalizeFundflowPayload(body, query) {
  if (!body || !Array.isArray(body.series) || !body.series.length) return null;
  if (body.dim && body.dim !== query.dim) return null;
  if (body.date && body.date !== (query.date || null)) return null;
  const mode = body.mode || (query.dim === "day" ? "intraday" : "cumulative");
  if (!["intraday", "cumulative", "daily-snapshot"].includes(mode)) return null;
  if (mode === "daily-snapshot" && (query.dim !== "day" || body.source !== "sina")) return null;
  const minPoints = mode === "daily-snapshot" ? 1 : 2;
  const timestamps = [];
  for (const line of body.series) {
    if (!line?.code || !line.name || !Number.isFinite(line.final) || !Array.isArray(line.points) || line.points.length < minPoints) return null;
    if (mode === "daily-snapshot" && line.points.length !== 1) return null;
    for (const point of line.points) {
      const t = String(point?.t || "");
      if (!Number.isFinite(point?.v) || !validDate(t.slice(0, 10))) return null;
      if (query.dim === "day" && query.date && t.slice(0, 10) !== query.date) return null;
      timestamps.push(t);
    }
  }
  if (query.dim === "day" && new Set(timestamps.map((t) => t.slice(0, 10))).size !== 1) return null;
  const asOf = timestamps.sort().at(-1);
  return {
    ...body,
    dim: query.dim,
    top: query.top,
    date: query.date || null,
    source: body.source || (query.dim === "day" ? "eastmoney" : "sina"),
    mode,
    count: body.series.length,
    dataDate: asOf.slice(0, 10),
    asOf,
  };
}

export function createBoardFundflowHandler({
  load = loadBoardFundflow,
  loadSnapshot = loadSinaDaySnapshot,
  getRedis = getRedisClient,
  now = Date.now,
} = {}) {
  const freshCache = new Map();
  const lastGoodCache = new Map();
  const inflight = new Map();

  function ttlFor(query) {
    if (query.date && query.date < shanghaiDate(now())) return 86400;
    return query.dim === "day" ? 120 : 600;
  }

  function cacheEntry(body, query) {
    const payload = normalizeFundflowPayload(body, query);
    const at = Date.parse(payload?.updatedAt);
    if (!payload || payload.stale || !Number.isFinite(at) || at > now() || now() - at >= LAST_GOOD_MS) return null;
    return {payload, at};
  }

  function isFresh(entry, query) {
    if (!entry || now() - entry.at >= ttlFor(query) * 1000) return false;
    // 上海跨日后，不能把昨天缓存直接当成最新窗口。
    if (!query.date && shanghaiDate(entry.at) !== shanghaiDate(now())) return false;
    return true;
  }

  function stalePayload(entry) {
    return {
      ...entry.payload,
      stale: true,
      notice: "数据源刷新失败，正在显示最近一次有效缓存，暂非实时行情。",
    };
  }

  async function resolve(query, key, redis) {
    let previous = lastGoodCache.get(key);
    if (previous && now() - previous.at >= LAST_GOOD_MS) previous = null;
    if (!previous && redis) {
      try {
        const raw = await redis.get(`board-fundflow:lastgood:v2:${key}`);
        previous = raw ? cacheEntry(JSON.parse(raw), query) : null;
        if (previous) lastGoodCache.set(key, previous);
      } catch { /* 网络获取不依赖缓存服务可用。 */ }
    }
    let payload;
    let primaryError;
    try {
      payload = normalizeFundflowPayload(await load(query), query);
      if (!payload) throw new Error("未获取到有效资金流曲线");
      if (!cacheEntry(payload, query)) throw new Error("资金流数据的时间或格式异常");
    } catch (error) {
      primaryError = error;
      if (previous && previous.payload.mode !== "daily-snapshot") return stalePayload(previous);
      if (query.dim !== "day") throw error;
      try {
        payload = normalizeFundflowPayload(await loadSnapshot(query), query);
        if (!payload || payload.mode !== "daily-snapshot") throw new Error("暂无可用的单日资金流快照", {cause: error});
        if (!cacheEntry(payload, query)) throw new Error("单日资金流快照的时间或格式异常", {cause: error});
      } catch (snapshotError) {
        if (previous) return stalePayload(previous);
        const error = new Error("资金流数据源暂不可用，请稍后重试，或查看周、月维度。", {cause: snapshotError});
        error.details = [primaryError?.message, snapshotError?.message].filter(Boolean).join("；");
        throw error;
      }
    }
    const entry = cacheEntry(payload, query);
    if (!entry) throw new Error("资金流数据的时间或格式异常，请稍后重试。");
    freshCache.set(key, entry);
    lastGoodCache.set(key, entry);
    if (redis) {
      const body = JSON.stringify(payload);
      await Promise.allSettled([
        // 新格式有单日快照模式，旧版前端只认识分钟曲线，必须隔离写入。
        redis.set(`board-fundflow:v2:${key}`, body, {EX: ttlFor(query)}),
        redis.set(`board-fundflow:lastgood:v2:${key}`, body, {EX: LAST_GOOD_MS / 1000}),
      ]);
    }
    return payload;
  }

  return async function boardFundflowHandler(req, res) {
    function send(status, payload) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(payload));
    }
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const dimRaw = requestUrl.searchParams.get("dim") || "day";
      const dim = DIM_CONFIG[dimRaw] ? dimRaw : "day";
      const top = Math.min(25, Math.max(3, Math.floor(Number(requestUrl.searchParams.get("top")) || 12)));
      const date = requestUrl.searchParams.get("date") || "";
      if (date && (!validDate(date) || date > shanghaiDate(now()))) {
        send(400, {error: "请选择有效日期，不能晚于上海时区的今天。"});
        return;
      }
      const query = {dim, top, date};
      const key = `${dim}:${top}:${date || "latest"}`;
      const retry = requestUrl.searchParams.get("retry") === "1";
      let entry = freshCache.get(key);
      if (!retry && isFresh(entry, query)) { send(200, entry.payload); return; }
      let redis = null;
      try {
        redis = await getRedis();
        const raw = await redis.get(`board-fundflow:v2:${key}`) || await redis.get(`board-fundflow:${key}`);
        if (raw) {
          entry = cacheEntry(JSON.parse(raw), query);
          if (entry) {
            freshCache.set(key, entry);
            lastGoodCache.set(key, entry);
            if (!retry && isFresh(entry, query)) { send(200, entry.payload); return; }
          }
        }
      } catch { /* 缓存不可用时走网络和进程内的最后有效数据。 */ }
      if (!inflight.has(key)) {
        const task = resolve(query, key, redis).finally(() => inflight.delete(key));
        inflight.set(key, task);
      }
      send(200, await inflight.get(key));
    } catch (error) {
      send(502, {error: "资金流数据源暂不可用，请稍后重试，或查看周、月维度。", details: error?.details || error?.message || String(error)});
    }
  };
}
