import { getRedisClient } from "./redisClient.js";
import { EM_UT, EM_FETCH_HEADERS, mapWithConcurrency } from "./boardTrend.js";

// 涨停/跌停/炸板池接口用的是另一套 ut 令牌（push2ex），和行情 clist 的 EM_UT 不同。
const ZT_UT = "7eea3edcaed734bea9cbfc24409ed989";

// 全 A 股 clist 的市场过滤串：沪深主板 + 创业板 + 科创板 + 北交所，剔除 B 股/退市。
const ALL_A_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";

// 多日历史回看的交易日数（情绪周期/连板数/打板次日成功率）。
const HISTORY_DAYS = 20;

// 市值分档（总市值，单位：元）。从大到小，和截图一致。
const CAP_TIERS = [
  { key: "gt1000", label: "千亿以上", min: 1e11, max: Infinity },
  { key: "500_1000", label: "500-1千亿", min: 5e10, max: 1e11 },
  { key: "200_500", label: "200-500亿", min: 2e10, max: 5e10 },
  { key: "100_200", label: "100-200亿", min: 1e10, max: 2e10 },
  { key: "50_100", label: "50-100亿", min: 5e9, max: 1e10 },
  { key: "0_50", label: "0-50亿", min: 0, max: 5e9 },
];

// 昨日涨停股今日表现的分布色条分桶（和截图 >=7% / 3-7% / 0-3% / -3-0 / <=-3% 一致）。
const PREMIUM_BUCKETS = [
  { key: "ge7", label: ">=7%", test: (v) => v >= 7 },
  { key: "3_7", label: "3%-7%", test: (v) => v >= 3 && v < 7 },
  { key: "0_3", label: "0-3%", test: (v) => v >= 0 && v < 3 },
  { key: "neg3_0", label: "-3%-0", test: (v) => v < 0 && v > -3 },
  { key: "le_neg3", label: "<=-3%", test: (v) => v <= -3 },
];

const PUSH2_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
  "https://1.push2.eastmoney.com",
  "https://82.push2.eastmoney.com",
];

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// 拉全 A 股快照（clist 分页）。每只返回涨跌幅/开/收/总市值/所属市场。多 host 兜底。
async function fetchAllStocksSnapshot() {
  const PAGE = 100;
  function pageUrl(host, pn) {
    return (
      `${host}/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&ut=${EM_UT}` +
      `&fid=f3&fs=${ALL_A_FS}&fields=f12,f13,f14,f2,f3,f17,f20`
    );
  }
  function parse(payload) {
    const list = payload?.data?.diff;
    const arr = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
    return arr
      .map((d) => ({
        code: String(d.f12 || ""),
        market: Number(d.f13), // 0=深 1=沪
        name: String(d.f14 || "").trim(),
        close: Number(d.f2),
        pct: Number(d.f3),
        open: Number(d.f17),
        mktcap: Number(d.f20),
      }))
      .filter((s) => s.code && Number.isFinite(s.pct));
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
      const pages = Math.min(80, Math.ceil(total / PAGE));
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
      return rows.filter((s) => (seen.has(s.code) ? false : seen.add(s.code)));
    } catch (e) {
      errors.push(`${host}: ${e?.message || e}`);
    }
  }
  throw new Error(`全A快照不可用：${errors.slice(-4).join("；")}`);
}

// 拉某个池（涨停 zt / 跌停 dt / 炸板 zb）某天的列表。date=YYYYMMDD。
async function fetchPool(kind, date) {
  const ep = kind === "zt" ? "getTopicZTPool" : kind === "dt" ? "getTopicDTPool" : "getTopicZBPool";
  const sort = kind === "dt" ? "fund:asc" : "fbt:asc";
  const url =
    `https://push2ex.eastmoney.com/${ep}?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=600` +
    `&sort=${sort}&date=${date}`;
  try {
    const res = await fetch(url, {
      headers: { ...EM_FETCH_HEADERS, Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const data = payload?.data;
    if (!data) return null;
    const pool = Array.isArray(data.pool) ? data.pool : [];
    return { tc: Number(data.tc) || pool.length, pool };
  } catch {
    return null;
  }
}

// 生成最近 n 个工作日（YYYYMMDD，升序）。周末/节假日由调用方用涨停池 tc=0 进一步过滤。
// 不依赖 K 线接口（指数/个股 K 线在部分网络不可达），仅靠各处都通的涨停池判定交易日。
function recentWeekdays(n) {
  const days = [];
  const d = new Date();
  while (days.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(yyyymmdd(d));
    d.setDate(d.getDate() - 1);
  }
  return days.reverse(); // 升序
}

// 拉单只股票最近 N 根日线（用于打板次日成功率：判断涨停后次日是否红盘）。
async function fetchStockDailyPct(market, code, lmt, deadline) {
  const url =
    `/api/qt/stock/kline/get?secid=${market}.${code}&ut=${EM_UT}` +
    `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59&klt=101&fqt=0&beg=0&end=20500101&lmt=${lmt}`;
  for (const host of ["https://push2delay.eastmoney.com", "https://push2his.eastmoney.com"]) {
    if (deadline - Date.now() <= 0) break;
    try {
      const res = await fetch(`${host}${url}`, {
        headers: EM_FETCH_HEADERS,
        signal: AbortSignal.timeout(Math.min(8000, deadline - Date.now())),
      });
      if (!res.ok) continue;
      const klines = (await res.json())?.data?.klines;
      if (!Array.isArray(klines) || !klines.length) continue;
      const map = {};
      for (const line of klines) {
        const p = String(line).split(",");
        map[p[0].replace(/-/g, "")] = Number(p[8]); // f59 涨跌幅
      }
      return map;
    } catch {
      // try next host
    }
  }
  return null;
}

// 是否一字板：开盘价≈收盘价（开盘即封板，全天没打开）。用快照的开/收近似判断。
function isOneWord(snap) {
  if (!snap || !Number.isFinite(snap.open) || !Number.isFinite(snap.close) || snap.close <= 0) return false;
  return Math.abs(snap.open - snap.close) / snap.close < 0.003;
}

// ===== 单日快照面板：涨跌统计 / 市值分档 / 强弱 / 真实热度 / 昨日涨停今日表现 =====
function buildSnapshotPanels(stocks, ztTodayPool, dtTodayCount, zbTodayCount, prevZtPool, snapByCode) {
  let up = 0;
  let down = 0;
  let flat = 0;
  let yang = 0;
  let yin = 0;

  // 涨跌幅分布直方图：停+ , 9..1 , 0 , -1..-9 , 停-（共 21 桶）。
  const histLabels = ["停+", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0", "-1", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9", "停-"];
  const hist = Object.fromEntries(histLabels.map((l) => [l, 0]));

  // 市值分档累加。
  const tierAgg = CAP_TIERS.map((t) => ({ ...t, sum: 0, n: 0 }));

  for (const s of stocks) {
    const v = s.pct;
    if (v > 0) up += 1;
    else if (v < 0) down += 1;
    else flat += 1;
    if (Number.isFinite(s.open) && Number.isFinite(s.close)) {
      if (s.close > s.open) yang += 1;
      else if (s.close < s.open) yin += 1;
    }
    // 直方图分桶
    let label;
    if (v >= 9.5) label = "停+";
    else if (v <= -9.5) label = "停-";
    else if (v > -0.5 && v < 0.5) label = "0";
    else if (v > 0) label = String(Math.min(9, Math.round(v)));
    else label = String(-Math.min(9, Math.round(-v)));
    hist[label] += 1;
    // 市值分档
    if (Number.isFinite(s.mktcap) && s.mktcap > 0) {
      const tier = tierAgg.find((t) => s.mktcap >= t.min && s.mktcap < t.max);
      if (tier) {
        tier.sum += v;
        tier.n += 1;
      }
    }
  }

  const ztCount = ztTodayPool?.tc ?? 0;
  const fbSuccess = ztCount + zbTodayCount > 0 ? ztCount / (ztCount + zbTodayCount) : null; // 封板成功率
  const zbRate = ztCount + zbTodayCount > 0 ? zbTodayCount / (ztCount + zbTodayCount) : null; // 炸板率

  // 连板（lbc>=2）与一字过滤。
  let lbCount = 0;
  let nonOneWordLb = 0;
  let maxLb = 0;
  for (const p of ztTodayPool?.pool || []) {
    const lbc = Number(p.lbc) || 0;
    if (lbc > maxLb) maxLb = lbc;
    if (lbc >= 2) {
      lbCount += 1;
      if (!isOneWord(snapByCode.get(String(p.c)))) nonOneWordLb += 1;
    }
  }

  // 市场真实热度（0-100 合成指标）。口径：以市场宽度为主、涨停强度为辅。
  // 透明可解释：60% 看上涨占比，40% 看“涨停 vs 跌停”的强弱。无统一行业公式，这是我们自定义口径。
  const breadth = up + down > 0 ? up / (up + down) : 0.5;
  const ztStrength = ztCount + dtTodayCount > 0 ? ztCount / (ztCount + dtTodayCount) : 0.5;
  const heat = Math.round(100 * (0.6 * breadth + 0.4 * ztStrength));

  // 昨日涨停股今日表现（⑤的快照版：均涨幅 + 分布 + 红盘率）。
  let premium = null;
  if (prevZtPool?.pool?.length) {
    const perf = [];
    for (const p of prevZtPool.pool) {
      const snap = snapByCode.get(String(p.c));
      if (snap && Number.isFinite(snap.pct)) perf.push(snap.pct);
    }
    if (perf.length) {
      const avg = perf.reduce((a, b) => a + b, 0) / perf.length;
      const dist = PREMIUM_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: perf.filter((v) => b.test(v)).length }));
      const redRate = perf.filter((v) => v > 0).length / perf.length; // 打板次日成功率（当前值）
      premium = { count: perf.length, avg, dist, redRate };
    }
  }

  return {
    breadth: { up, down, flat, total: up + down + flat, upRatio: up + down > 0 ? up / (up + down) : null },
    yangYin: { yang, yin },
    hist: histLabels.map((l) => ({ label: l, count: hist[l] })),
    capTiers: tierAgg.map((t) => ({ key: t.key, label: t.label, avg: t.n ? t.sum / t.n : null, n: t.n })),
    strong: { ztCount, zbCount: zbTodayCount, dtCount: dtTodayCount, fbSuccess, zbRate },
    consecutive: { lbCount, nonOneWordLb, maxLb },
    heat: { value: heat, breadth: Math.round(breadth * 100), ztStrength: Math.round(ztStrength * 100) },
    premium,
  };
}

// 给一组日期并发拉某种池，返回 Map<date, {tc, pool}>（拉不到的 date 不入表）。
async function fetchPoolsForDates(kind, dates, conc) {
  const map = new Map();
  await mapWithConcurrency(dates, conc, async (date) => {
    const r = await fetchPool(kind, date);
    if (r) map.set(date, r);
  });
  return map;
}

// ===== 多日历史：连板数 / 涨停跌停家数 / 最高连板 / 炸板率 / 打板次日成功率 =====
// 入参已是确定的交易日（升序）+ 预拉好的三池 Map。次日成功率需个股日线，best-effort。
async function buildHistory(days, ztMap, dtMap, zbMap, deadline) {
  const perDay = days.map((date) => {
    const ztPool = ztMap.get(date)?.pool || [];
    let lbCount = 0;
    let maxLb = 0;
    for (const p of ztPool) {
      const lbc = Number(p.lbc) || 0;
      if (lbc > maxLb) maxLb = lbc;
      if (lbc >= 2) lbCount += 1;
    }
    const ztCount = ztMap.get(date)?.tc ?? ztPool.length;
    const zbCount = zbMap.get(date)?.tc ?? 0;
    return {
      date,
      ztCount,
      dtCount: dtMap.get(date)?.tc ?? 0,
      zbCount,
      lbCount,
      maxLb,
      zbRate: ztCount + zbCount > 0 ? zbCount / (ztCount + zbCount) : null,
      ztCodes: ztPool.map((p) => ({ code: String(p.c), market: Number(p.m) })),
    };
  });

  // 打板次日成功率：第 d 天涨停的票，在第 d+1 天是否红盘（pct>0）的比例。
  // 需要逐只票的日线（个股 K 线在部分网络不可达，拉不到则该指标留 null，不阻塞其余面板）。
  const codeSet = new Map(); // code -> market
  for (const day of perDay) for (const c of day.ztCodes) if (!codeSet.has(c.code)) codeSet.set(c.code, c.market);

  // 个股日线另设较短子预算：能取到时几秒就够；取不到（K 线 host 不可达）时最多浪费这么久，
  // 不拖到总预算，保证其余 8 个面板尽快返回，次日成功率留 null。
  const klineDeadline = Math.min(deadline, Date.now() + 12000);
  const klineMap = new Map(); // code -> {YYYYMMDD: pct}
  await mapWithConcurrency([...codeSet.keys()], 16, async (code) => {
    if (Date.now() > klineDeadline) return;
    const km = await fetchStockDailyPct(codeSet.get(code), code, HISTORY_DAYS + 5, klineDeadline);
    if (km) klineMap.set(code, km);
  });

  // 逐天算次日成功率（最后一天没有“次日”，留 null）。
  for (let i = 0; i < perDay.length; i += 1) {
    const nextDate = perDay[i + 1]?.date;
    let red = 0;
    let tot = 0;
    if (nextDate) {
      for (const c of perDay[i].ztCodes) {
        const v = klineMap.get(c.code)?.[nextDate];
        if (Number.isFinite(v)) {
          tot += 1;
          if (v > 0) red += 1;
        }
      }
    }
    perDay[i].nextDaySuccess = tot > 0 ? red / tot : null;
  }

  // 精简返回（不带 ztCodes，避免 payload 过大）。
  return perDay.map((d) => ({
    date: `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`,
    ztCount: d.ztCount,
    dtCount: d.dtCount,
    zbCount: d.zbCount,
    lbCount: d.lbCount,
    maxLb: d.maxLb,
    zbRate: d.zbRate,
    nextDaySuccess: d.nextDaySuccess,
  }));
}

async function computeTodayMarket() {
  const t0 = Date.now();
  const deadline = Date.now() + 45000;

  // 交易日历完全靠涨停池判定（各处网络都通）：先对最近若干工作日拉涨停池，tc>0 才是交易日。
  // 注意：push2ex 涨停池历史只保留约 15 个交易日，更早的日期会返回 tc=0，自然被过滤掉，
  // 所以多日面板实际约 3 周窗口（要更长需自行落库累积，超出当前范围）。
  const candidates = recentWeekdays(HISTORY_DAYS + 6);
  const [stocks, ztMap] = await Promise.all([
    fetchAllStocksSnapshot(),
    fetchPoolsForDates("zt", candidates, 8),
  ]);

  const tradingDays = candidates.filter((d) => (ztMap.get(d)?.tc ?? 0) > 0); // 升序
  if (!tradingDays.length) throw new Error("未取到任何交易日的涨停池数据");
  const todayDate = tradingDays[tradingDays.length - 1];
  const prevDate = tradingDays[tradingDays.length - 2] || null;
  const windowDays = tradingDays.slice(-HISTORY_DAYS);

  // 历史窗口内每天补拉跌停/炸板池（涨停池已在上面拉好）。
  const [dtMap, zbMap] = await Promise.all([
    fetchPoolsForDates("dt", windowDays, 8),
    fetchPoolsForDates("zb", windowDays, 8),
  ]);

  const snapByCode = new Map(stocks.map((s) => [s.code, s]));
  const panels = buildSnapshotPanels(
    stocks,
    ztMap.get(todayDate),
    dtMap.get(todayDate)?.tc ?? 0,
    zbMap.get(todayDate)?.tc ?? 0,
    prevDate ? ztMap.get(prevDate) : null,
    snapByCode,
  );

  const history = await buildHistory(windowDays, ztMap, dtMap, zbMap, deadline);

  const date = `${todayDate.slice(0, 4)}-${todayDate.slice(4, 6)}-${todayDate.slice(6, 8)}`;
  console.log(
    `[today-market] date=${date} stocks=${stocks.length} zt=${ztMap.get(todayDate)?.tc} ` +
      `dt=${dtMap.get(todayDate)?.tc} zb=${zbMap.get(todayDate)?.tc} histDays=${history.length} totalMs=${Date.now() - t0}`,
  );

  return { date, ...panels, history, updatedAt: new Date().toISOString() };
}

// ===== 盘面快照缓存（stale-while-revalidate）=====
// 全市场快照重算要 10~45s，纯靠 TTL 缓存的话每次过期都会有人吃满这段慢加载。
// 这里改成「新鲜期内直接给缓存，过了新鲜期仍先给旧数据、后台静默重算」，
// 配一层进程内内存兜底（Redis 不可用时也能快）+ 单飞锁（并发只触发一次重算）。
const CACHE_KEY = "today-market:v1";
const CACHE_TS_KEY = "today-market:v1:ts"; // 缓存写入时刻（ms），用于判断新鲜/陈旧。
const FRESH_MS = 10 * 60 * 1000; // 10 分钟内直接返回缓存，不重算。
const STALE_MS = 30 * 60 * 1000; // 10~30 分钟返回旧数据并后台刷新；超过则当作冷启动同步重算。
const REDIS_TTL_SEC = Math.round(STALE_MS / 1000);

let memEntry = null; // { body, cachedAt } —— 进程内缓存，Redis 不可用时兜底。
let refreshing = null; // 单飞：进行中的重算 Promise，避免并发重复打外部接口。

// 读缓存：先看进程内，再回落 Redis（顺带把 Redis 命中回填到内存，缩短后续判断）。
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

// 重算并写两级缓存。单飞：已有重算在跑就复用同一个 Promise。
function refreshCache(redis) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const payload = await computeTodayMarket();
    const body = JSON.stringify(payload);
    memEntry = { body, cachedAt: Date.now() };
    if (redis) {
      try {
        await Promise.all([
          redis.set(CACHE_KEY, body, { EX: REDIS_TTL_SEC }),
          redis.set(CACHE_TS_KEY, String(memEntry.cachedAt), { EX: REDIS_TTL_SEC }),
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

export function createTodayMarketHandler() {
  return async function todayMarketHandler(req, res) {
    const sendJson = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(body);
    };

    let redis = null;
    try {
      redis = await getRedisClient();
    } catch {
      // Redis 不可用则只走进程内内存缓存兜底。
    }

    const entry = await readCache(redis);
    if (entry) {
      const age = Date.now() - entry.cachedAt;
      if (age < STALE_MS) {
        // 还在陈旧窗口内：直接返回（可能略旧）。超过新鲜期则后台静默刷新，下次就是新数据。
        if (age >= FRESH_MS) refreshCache(redis).catch(() => {});
        sendJson(200, entry.body);
        return;
      }
    }

    // 冷启动或缓存已彻底过期：只能同步等这次重算（单飞复用）。
    try {
      sendJson(200, await refreshCache(redis));
    } catch (error) {
      // 重算失败时，若还有可用的旧缓存，宁可返回旧数据也别报错。
      if (entry) sendJson(200, entry.body);
      else sendJson(502, JSON.stringify({ error: error?.message || String(error) }));
    }
  };
}
