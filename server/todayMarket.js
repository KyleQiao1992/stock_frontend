import { getRedisClient } from "./redisClient.js";
import { EM_UT, EM_FETCH_HEADERS, mapWithConcurrency } from "./boardTrend.js";
import { createMarketSnapshotCache } from "./marketSnapshotCache.js";
import { hasSameDayMarketCapital } from "./eastmoneyMarketCapital.js";

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
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// 拉全 A 股快照（clist 分页）。每只返回涨跌幅/开/收/总市值/所属市场。多 host 兜底。
export async function fetchAllStocksSnapshot({request = fetch, now = Date.now} = {}) {
  const PAGE = 100;
  const deadline = now() + 15000;
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - now())));
  const numeric = (value) => value == null || value === "" || value === "-" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const rawRows = (payload) => Array.isArray(payload?.data?.diff) ? payload.data.diff
    : payload?.data?.diff && typeof payload.data.diff === "object" ? Object.values(payload.data.diff) : [];
  const pageUrl = (host, pn) => `${host}/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&ut=${EM_UT}`
    + `&fid=f3&fs=${ALL_A_FS}&fields=f12,f13,f14,f2,f3,f17,f20,f124`;
  function parse(rows) {
    return rows.map((row) => ({code: String(row.f12 || ""), market: numeric(row.f13), name: String(row.f14 || "").trim(),
      close: numeric(row.f2), pct: numeric(row.f3), open: numeric(row.f17), mktcap: numeric(row.f20), quoteAt: numeric(row.f124)}))
      .filter((stock) => stock.code && stock.name && Number.isFinite(stock.pct));
  }
  let lastCause;
  for (const host of PUSH2_HOSTS) {
    if (now() >= deadline) break;
    try {
      const response = await request(pageUrl(host, 1), {headers: EM_FETCH_HEADERS, signal: signal()});
      if (!response.ok) continue;
      const payload = await response.json();
      const total = Number(payload?.data?.total);
      let raw = rawRows(payload);
      if (!Number.isInteger(total) || total <= 0 || !raw.length) continue;
      if (!raw.some((row) => Number.isFinite(numeric(row.f3)))) return {stocks: [], live: false};
      const pages = Math.min(80, Math.ceil(total / PAGE));
      const rest = await mapWithConcurrency(Array.from({length: pages - 1}, (_, i) => i + 2), 12, async (pn) => {
        if (now() >= deadline) return null;
        try {
          const result = await request(pageUrl(host, pn), {headers: EM_FETCH_HEADERS, signal: signal()});
          if (!result.ok) return null;
          const rows = rawRows(await result.json());
          return rows.length ? rows : null;
        } catch (error) { lastCause = error; return null; }
      });
      if (rest.some((rows) => !rows)) continue;
      raw = raw.concat(...rest);
      const allCodes = new Set(raw.map((row) => String(row.f12 || "")).filter(Boolean));
      if (allCodes.size < total) continue;
      const seen = new Set();
      const stocks = parse(raw).filter((stock) => seen.has(stock.code) ? false : seen.add(stock.code));
      if (!stocks.length) continue;
      const quoteAt = stocks.reduce((max, stock) => Math.max(max, stock.quoteAt || 0), 0);
      return {stocks, live: true, quoteTime: quoteAt > 0 ? new Date(quoteAt * 1000).toISOString() : null};
    } catch (error) { lastCause = error; /* Try another fixed upstream within the shared budget. */ }
  }
  throw new Error("全A行情快照暂不可用或分页不完整", {cause: lastCause});
}

// 拉某个池（涨停 zt / 跌停 dt / 炸板 zb）某天的列表。date=YYYYMMDD。
async function fetchPool(kind, date, deadline = Date.now() + 12000) {
  if (Date.now() >= deadline) return null;
  const ep = kind === "zt" ? "getTopicZTPool" : kind === "dt" ? "getTopicDTPool" : "getTopicZBPool";
  const sort = kind === "dt" ? "fund:asc" : "fbt:asc";
  const url =
    `https://push2ex.eastmoney.com/${ep}?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=600` +
    `&sort=${sort}&date=${date}`;
  try {
    const res = await fetch(url, {
      headers: { ...EM_FETCH_HEADERS, Referer: "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - Date.now()))),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const data = payload?.data;
    if (!data || !Array.isArray(data.pool)) return null;
    const pool = data.pool;
    const count = Number(data.tc);
    if (data.tc == null || data.tc === "" || !Number.isInteger(count) || count < 0) return null;
    return { tc: count, pool };
  } catch {
    return null;
  }
}

// 生成最近 n 个工作日（YYYYMMDD，升序）。周末/节假日由调用方用涨停池 tc=0 进一步过滤。
// 不依赖 K 线接口（指数/个股 K 线在部分网络不可达），仅靠各处都通的涨停池判定交易日。
function recentWeekdays(n) {
  const days = [];
  const d = new Date(Date.now() + 8 * 3600000);
  while (days.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(yyyymmdd(d));
    d.setUTCDate(d.getUTCDate() - 1);
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
export function buildSnapshotPanels(stocks, ztTodayPool, dtTodayCount, zbTodayCount, prevZtPool, snapByCode) {
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
    if (!Number.isFinite(v)) continue;
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
async function fetchPoolsForDates(kind, dates, conc, deadline) {
  const map = new Map();
  await mapWithConcurrency(dates, conc, async (date) => {
    const r = await fetchPool(kind, date, deadline);
    if (r) map.set(date, r);
  });
  return map;
}

// ===== 多日历史：连板数 / 涨停跌停家数 / 最高连板 / 炸板率 / 打板次日成功率 =====
// 入参已是确定的交易日（升序）+ 预拉好的三池 Map。次日成功率需个股日线，best-effort。
export async function buildHistory(days, ztMap, dtMap, zbMap, deadline) {
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
    const zbCount = zbMap.get(date)?.tc ?? null;
    return {
      date,
      ztCount,
      dtCount: dtMap.get(date)?.tc ?? null,
      zbCount,
      lbCount,
      maxLb,
      zbRate: Number.isFinite(zbCount) && ztCount + zbCount > 0 ? zbCount / (ztCount + zbCount) : null,
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

  // 先确认全市场行情可用，再启动历史池批量请求；源故障时不留下无用的后台网络任务。
  const snap = await fetchAllStocksSnapshot();
  if (!snap.live) {
    console.log("[today-market] 非交易时段：东财当日行情字段为 dash，回落到最近一次有效快照");
    return { live: false };
  }
  const stocks = snap.stocks;
  const quoteTimestamp = Date.parse(snap.quoteTime);
  if (!Number.isFinite(quoteTimestamp)) throw new Error("行情快照缺少可信的数据日期");
  const quoteDate = new Date(quoteTimestamp + 8 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");

  // 历史交易日用涨停池判定；最新交易日由真实行情时间确定，允许该日没有涨停。
  // 注意：push2ex 涨停池历史只保留约 15 个交易日，更早的日期会返回 tc=0，自然被过滤掉，
  // 所以多日面板实际约 3 周窗口（要更长需自行落库累积，超出当前范围）。
  const candidates = recentWeekdays(HISTORY_DAYS + 6);
  const ztMap = await fetchPoolsForDates("zt", candidates, 8, deadline);
  if (!ztMap.has(quoteDate)) throw new Error("当日涨停池未完整获取，不能计算完整盘面");
  // A real quote date establishes a trading session even when that session has zero limit-ups.
  const tradingDays = candidates.filter((d) => d <= quoteDate && ((ztMap.get(d)?.tc ?? 0) > 0 || d === quoteDate));
  if (!tradingDays.length) throw new Error("未取到任何交易日的涨停池数据");
  const todayDate = tradingDays[tradingDays.length - 1];
  const prevDate = tradingDays[tradingDays.length - 2] || null;
  const windowDays = tradingDays.slice(-HISTORY_DAYS);

  // 历史窗口内每天补拉跌停/炸板池（涨停池已在上面拉好）。
  const [dtMap, zbMap] = await Promise.all([
    fetchPoolsForDates("dt", windowDays, 8, deadline),
    fetchPoolsForDates("zb", windowDays, 8, deadline),
  ]);

  if (!dtMap.has(todayDate) || !zbMap.has(todayDate)) throw new Error("当日跌停或炸板池未完整获取，不能计算完整盘面");
  const snapByCode = new Map(stocks.map((s) => [s.code, s]));
  const panels = buildSnapshotPanels(
    stocks,
    ztMap.get(todayDate),
    dtMap.get(todayDate).tc,
    zbMap.get(todayDate).tc,
    prevDate ? ztMap.get(prevDate) : null,
    snapByCode,
  );

  const history = await buildHistory(windowDays, ztMap, dtMap, zbMap, deadline);

  const date = `${todayDate.slice(0, 4)}-${todayDate.slice(4, 6)}-${todayDate.slice(6, 8)}`;
  console.log(
    `[today-market] date=${date} stocks=${stocks.length} zt=${ztMap.get(todayDate)?.tc} ` +
      `dt=${dtMap.get(todayDate)?.tc} zb=${zbMap.get(todayDate)?.tc} histDays=${history.length} totalMs=${Date.now() - t0}`,
  );

  return { live: true, date, quoteTime: snap.quoteTime, ...panels, history, updatedAt: new Date().toISOString() };
}

function validTodayMarket(payload) {
  if (["sina", "sina-tencent"].includes(payload?.source)) return false;
  const nonnegativeInt = (value) => Number.isInteger(value) && value >= 0;
  const countOrUnknown = (value) => value == null || nonnegativeInt(value);
  const ratioOrUnknown = (value) => value == null || (Number.isFinite(value) && value >= 0 && value <= 1);
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const at = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
  };
  const counts = payload?.breadth;
  if (!validDate(payload?.date)) return false;
  if (payload?.live !== true || !counts || !Number.isInteger(counts.total) || counts.total <= 0
    || ![counts.up, counts.down, counts.flat].every((count) => Number.isInteger(count) && count >= 0)
    || counts.up + counts.down + counts.flat !== counts.total
    || !payload.yangYin || ![payload.yangYin.yang, payload.yangYin.yin].every((count) => Number.isInteger(count) && count >= 0)
    || payload.yangYin.yang + payload.yangYin.yin > counts.total
    || !Array.isArray(payload.hist) || !payload.hist.every((row) => row && typeof row.label === "string" && Number.isInteger(row.count) && row.count >= 0)
    || !Array.isArray(payload.capTiers) || !payload.capTiers.every((row) => row && typeof row.key === "string" && typeof row.label === "string"
      && Number.isInteger(row.n) && row.n >= 0 && (row.avg == null || Number.isFinite(row.avg)))
    || !Array.isArray(payload.history) || !payload.history.every((row) => row && validDate(row.date)
      && [row.ztCount, row.lbCount, row.maxLb].every(nonnegativeInt)
      && [row.dtCount, row.zbCount].every(countOrUnknown)
      && [row.zbRate, row.nextDaySuccess].every(ratioOrUnknown))) return false;
  if (payload.strong != null && (![payload.strong.ztCount, payload.strong.dtCount, payload.strong.zbCount].every(nonnegativeInt)
    || ![payload.strong.fbSuccess, payload.strong.zbRate].every(ratioOrUnknown))) return false;
  if (payload.consecutive != null && ![payload.consecutive.lbCount, payload.consecutive.nonOneWordLb, payload.consecutive.maxLb].every(nonnegativeInt)) return false;
  if (payload.heat != null && ![payload.heat.value, payload.heat.breadth, payload.heat.ztStrength].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) return false;
  if (payload.premium != null && (!nonnegativeInt(payload.premium.count) || !Number.isFinite(payload.premium.avg)
    || !ratioOrUnknown(payload.premium.redRate) || !Array.isArray(payload.premium.dist)
    || !payload.premium.dist.every((row) => row && typeof row.key === "string" && typeof row.label === "string" && nonnegativeInt(row.count)))) return false;
  if (payload.partial || payload.mode === "snapshot" || ["eastmoney-tencent", "eastmoney-sina"].includes(payload.source)) {
    const coverage = payload.classificationCoverage;
    const quotes = payload.quoteCoverage;
    return payload.partial === true && payload.mode === "snapshot" && payload.snapshotSchemaVersion === 3
    && payload.universePolicy === "listed-ashare-with-cdr"
    && payload.classificationSource === "eastmoney" && payload.classification === "东方财富行业" && payload.industryLevel === 2
    && nonnegativeInt(coverage?.total) && coverage.total > 0 && coverage.classified === coverage.total
    && coverage.unclassified === 0 && coverage.conflicts === 0
    && quotes?.total === coverage.total && nonnegativeInt(quotes.quoted) && nonnegativeInt(quotes.unavailable)
    && quotes.quoted + quotes.unavailable === quotes.total && quotes.quoted === counts.total
    && hasSameDayMarketCapital(payload, coverage.total)
    && ["eastmoney-tencent", "eastmoney-sina"].includes(payload.source);
  }
  return (!payload.source || payload.source === "eastmoney") && Boolean(payload.strong && payload.consecutive && payload.heat && payload.yangYin);
}

export function createTodayMarketHandler({load = computeTodayMarket, loadFallback = null, getRedis = getRedisClient, now = Date.now} = {}) {
  const cache = createMarketSnapshotCache({
    key: "today-market:v1", freshMs: 10 * 60000, staleMs: 30 * 60000, load, loadFallback, fallbackVersion: 3, validate: validTodayMarket, now,
    emptyClosed: (at) => ({live: false, marketClosed: true, history: [], updatedAt: new Date(at).toISOString(),
      notice: "当前数据源未提供当日行情，且没有可用的历史快照。"}),
  });
  return async function todayMarketHandler(req, res) {
    function send(status, payload) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(payload));
    }
    let redis = null;
    try { redis = await getRedis(); } catch { /* Use validated process memory. */ }
    try {
      const query = new URL(req.url || "", "http://localhost").searchParams;
      send(200, await cache.get(redis, {retry: query.get("retry") === "1"}));
    } catch {
      send(502, {error: "行情数据源暂不可用，且没有可用的历史快照，请稍后重试。"});
    }
  };
}
