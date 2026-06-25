// 停牌预警 handler：对单只 A 股做「停牌风险」分级。
// 核心风险通道：异常波动 → 严重异常波动 → 强制停牌核查。
// 规则口径见 docs/suspension-alert-rules.md，阈值/对应指数配置见 server/suspensionRules.json。
//
// 前端用法：GET /api/suspension-alert?code=603678
// 全部同步现算（个股不复权日K + 对应指数日K + 东财停复牌feed），不落库，结果 Redis 短缓存。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRedisClient } from "./redisClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(readFileSync(path.join(__dirname, "suspensionRules.json"), "utf-8"));

const EM_UT = "fa5fd1943c7b386f172d6893dbfba10b";
const EM_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://data.eastmoney.com/",
};
const PUSH2HIS_HOSTS = [
  "https://push2his.eastmoney.com",
  "https://79.push2his.eastmoney.com",
  "https://82.push2his.eastmoney.com",
];

const RESULT_TTL = 300; // 单票结果缓存 5 分钟
const FEED_TTL = 1800; // 停复牌 feed 缓存 30 分钟

// ── 工具：日期/secid/板块路由 ───────────────────────────────────────────

// 上海时区的今天 YYYY-MM-DD（A 股口径，避免服务器时区错位）。
function todayCST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isShStock(code) {
  return ["600", "601", "603", "605", "688", "689", "900"].some((p) => code.startsWith(p));
}
// 个股 secid：沪市 1.，深市 0.（与前端 toTencentSymbol 一致）。
function stockSecid(code) {
  return `${isShStock(code) ? "1" : "0"}.${code}`;
}
// 指数 secid：39 开头是深市指数（0.），00 开头是沪市指数（1.）。
function indexSecid(code) {
  return `${code.startsWith("39") ? "0" : "1"}.${code}`;
}
// 腾讯行情代码：个股按沪深前缀，指数 39 开头为深(sz)否则沪(sh)。
function tencentSym(code, isIndex) {
  if (isIndex) return `${code.startsWith("39") ? "sz" : "sh"}${code}`;
  return `${isShStock(code) ? "sh" : "sz"}${code}`;
}

function boardForCode(code) {
  for (const [key, b] of Object.entries(RULES.boards)) {
    if (Array.isArray(b.codePrefixes) && b.codePrefixes.some((p) => code.startsWith(p))) return key;
  }
  return null;
}

// ── 取数：日 K（不复权），东财 push2his 主、腾讯兜底 ──────────────────────
// 偏离值只用到收盘价；push2his 在部分服务器网络不可达，腾讯(web.ifzq.gtimg.cn)兜底。

async function fetchKlineEastmoney(secid, limit) {
  for (const host of PUSH2HIS_HOSTS) {
    try {
      const url =
        `${host}/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&ut=${EM_UT}` +
        "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
        `&klt=101&fqt=0&beg=0&end=20500101&lmt=${limit}`;
      const r = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const klines = j?.data?.klines;
      if (!Array.isArray(klines) || !klines.length) continue;
      // fields2: f51日期 f52开 f53收 f54高 f55低 f56量 f57额 f58振幅 f59涨跌幅 f60涨跌额 f61换手率
      const rows = klines
        .map((s) => {
          const a = String(s).split(",");
          return { date: a[0], close: Number(a[2]) };
        })
        .filter((row) => row.date && Number.isFinite(row.close));
      if (rows.length) return { name: j.data.name || "", rows };
    } catch {
      /* 换下一个 host */
    }
  }
  return null;
}

async function fetchKlineTencent(code, isIndex, limit) {
  const sym = tencentSym(code, isIndex);
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${limit},`;
    const r = await fetch(url, {
      headers: { Referer: "https://gu.qq.com/", "User-Agent": EM_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.data?.[sym];
    const arr = d?.day || d?.qfqday; // [date,open,close,high,low,volume,...]
    if (!Array.isArray(arr) || !arr.length) return null;
    const rows = arr
      .map((x) => ({ date: x[0], close: Number(x[2]) }))
      .filter((row) => row.date && Number.isFinite(row.close));
    if (!rows.length) return null;
    return { name: "", rows }; // 腾讯这条不带简称，ST 判定走前端传入的 name
  } catch {
    return null;
  }
}

async function fetchDailyKline(code, { isIndex = false, limit = 60 } = {}) {
  const viaEm = await fetchKlineEastmoney(isIndex ? indexSecid(code) : stockSecid(code), limit);
  if (viaEm) return viaEm;
  return fetchKlineTencent(code, isIndex, limit);
}

// ── 取数：东财两市停复牌 feed（已公告停牌，前瞻） ─────────────────────────

async function fetchSuspendFeed() {
  const date = todayCST();
  try {
    const redis = await getRedisClient();
    const cached = await redis.get("suspend-feed");
    if (cached) return JSON.parse(cached);
  } catch {
    /* Redis 不可用则直连 */
  }
  const map = {};
  try {
    const url =
      "https://datacenter-web.eastmoney.com/api/data/v1/get" +
      "?reportName=RPT_CUSTOM_SUSPEND_DATA_INTERFACE&columns=ALL&source=WEB&client=WEB" +
      "&sortColumns=SUSPEND_START_DATE&sortTypes=-1&pageNumber=1&pageSize=500" +
      `&filter=(MARKET="全部")(DATETIME='${date}')`;
    const r = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const j = await r.json();
      for (const row of j?.result?.data || []) {
        map[String(row.SECURITY_CODE)] = {
          reason: row.SUSPEND_REASON || "",
          start: (row.SUSPEND_START_DATE || "").slice(0, 10),
          resume: (row.PREDICT_RESUME_DATE || "").slice(0, 10) || null,
          expire: row.SUSPEND_EXPIRE || "",
        };
      }
    }
  } catch {
    /* feed 拿不到就当无已公告停牌 */
  }
  try {
    const redis = await getRedisClient();
    await redis.set("suspend-feed", JSON.stringify(map), { EX: FEED_TTL });
  } catch {
    /* 忽略缓存写入失败 */
  }
  return map;
}

// ── 计算：累计偏离值 + 同向异常波动次数 ─────────────────────────────────

// 整段窗口累计偏离值 = 个股区间涨跌幅 − 对应指数区间涨跌幅（用收盘价端点，不复权）。
// rows 升序；窗口为最后 n 个交易日，期初前收盘取 rows[len-n-1]。
function cumDeviation(rows, idxByDate, n) {
  const L = rows.length;
  if (L < n + 1) return null;
  const end = rows[L - 1];
  const startPrev = rows[L - n - 1];
  const idxEnd = idxByDate.get(end.date);
  const idxStartPrev = idxByDate.get(startPrev.date);
  if (!Number.isFinite(idxEnd) || !Number.isFinite(idxStartPrev) || !startPrev.close || !idxStartPrev) {
    return null;
  }
  const stockChg = (end.close / startPrev.close - 1) * 100;
  const idxChg = (idxEnd / idxStartPrev - 1) * 100;
  return stockChg - idxChg;
}

// 3 日累计偏离值结束于 rows 第 i 根（含），用于逐日判定异常波动。
function dev3At(rows, idxByDate, i) {
  if (i < 3) return null;
  const end = rows[i];
  const startPrev = rows[i - 3];
  const idxEnd = idxByDate.get(end.date);
  const idxStartPrev = idxByDate.get(startPrev.date);
  if (!Number.isFinite(idxEnd) || !Number.isFinite(idxStartPrev) || !startPrev.close || !idxStartPrev) {
    return null;
  }
  return (end.close / startPrev.close - 1) * 100 - (idxEnd / idxStartPrev - 1) * 100;
}

// 近 windowDays 个交易日内「同向异常波动」次数（近似：3 日偏离越过阈值的上升沿，按方向分别计）。
function countSameDirAbnormal(rows, idxByDate, threshold, windowDays) {
  const L = rows.length;
  let up = 0;
  let down = 0;
  let prevTriggered = 0; // 0 无 / 1 涨向 / -1 跌向
  const from = Math.max(3, L - windowDays);
  for (let i = from; i < L; i += 1) {
    const d = dev3At(rows, idxByDate, i);
    let cur = 0;
    if (Number.isFinite(d)) {
      if (d >= threshold) cur = 1;
      else if (d <= -threshold) cur = -1;
    }
    if (cur !== 0 && cur !== prevTriggered) {
      if (cur > 0) up += 1;
      else down += 1;
    }
    prevTriggered = cur;
  }
  return Math.max(up, down);
}

// ── 主流程 ───────────────────────────────────────────────────────────────

function effectiveStThreshold(stObj, todayStr) {
  if (!stObj) return null;
  if (stObj.effectiveDate && todayStr >= stObj.effectiveDate) return stObj.changesTo;
  return stObj.value;
}

const LEVEL_META = {
  normal: { label: "正常", color: "green", rank: 0 },
  near_abnormal: { label: "接近异常波动", color: "yellow", rank: 1 },
  abnormal_or_near_serious: { label: "已触发异常波动", color: "orange", rank: 2 },
  serious: { label: "高停牌核查风险", color: "red", rank: 3 },
  announced_suspend: { label: "已公告停牌", color: "rose", rank: 4 },
};

async function computeRisk(code, passedName = "") {
  const boardKey = boardForCode(code);
  if (!boardKey) {
    return { code, level: "normal", levelLabel: "未知板块", reasons: ["无法识别板块（仅支持沪深 A 股）"], unsupported: true };
  }
  const board = RULES.boards[boardKey];
  if (board.status === "TODO_separate_ruleset") {
    return { code, board: board.label, level: "normal", levelLabel: board.label, reasons: ["北交所规则不同，暂未纳入沪深引擎"], unsupported: true };
  }

  const today = todayCST();

  const [stock, index, feed] = await Promise.all([
    fetchDailyKline(code, { isIndex: false }),
    fetchDailyKline(board.benchmarkIndex.code, { isIndex: true }),
    fetchSuspendFeed(),
  ]);

  if (!stock || stock.rows.length < 31) {
    throw new Error("个股日K数据不足，无法计算");
  }
  if (!index) {
    throw new Error(`对应指数日K获取失败（${board.benchmarkIndex.name} ${board.benchmarkIndex.code}）`);
  }

  const idxByDate = new Map(index.rows.map((r) => [r.date, r.close]));
  const name = stock.name || passedName || "";
  const isST = /ST/i.test(name);
  const stThr = effectiveStThreshold(board.abnormal.stDeviationPct, today);
  const abnThreshold = isST && stThr ? stThr : board.abnormal.deviationPct;

  const dev3 = cumDeviation(stock.rows, idxByDate, 3);
  const dev10 = cumDeviation(stock.rows, idxByDate, 10);
  const dev30 = cumDeviation(stock.rows, idxByDate, 30);
  const s = board.serious;
  const reqCount = s.sameDirAbnormalCount.count;
  const eventCount = countSameDirAbnormal(stock.rows, idxByDate, abnThreshold, s.sameDirAbnormalCount.windowDays);

  const reasons = [];
  const fmt = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

  // 严重异常波动判定
  const seriousHits = [];
  if (dev10 != null && (dev10 >= s.dev10.up || dev10 <= s.dev10.down)) {
    seriousHits.push(`10日累计偏离${fmt(dev10)}（阈值+${s.dev10.up}%/${s.dev10.down}%）`);
  }
  if (dev30 != null && (dev30 >= s.dev30.up || dev30 <= s.dev30.down)) {
    seriousHits.push(`30日累计偏离${fmt(dev30)}（阈值+${s.dev30.up}%/${s.dev30.down}%）`);
  }
  if (eventCount >= reqCount) {
    seriousHits.push(`10日内同向异常波动${eventCount}次（达${reqCount}次）`);
  }

  const abnormalHit = dev3 != null && Math.abs(dev3) >= abnThreshold;
  const nearRatio = RULES.riskTiers.approachRatio;
  const nearSerious =
    (dev10 != null && (dev10 >= s.dev10.up * nearRatio || dev10 <= s.dev10.down * nearRatio)) ||
    (dev30 != null && (dev30 >= s.dev30.up * nearRatio || dev30 <= s.dev30.down * nearRatio)) ||
    eventCount === reqCount - 1;
  const nearAbnormal = dev3 != null && Math.abs(dev3) >= abnThreshold * nearRatio;

  const announced = feed[code] || null;

  let level;
  if (announced) {
    level = "announced_suspend";
    reasons.push(
      `已公告停牌：${announced.reason}${announced.start ? `，${announced.start}起` : ""}${
        announced.resume ? `，预计复牌${announced.resume}` : ""
      }`,
    );
  } else if (seriousHits.length) {
    level = "serious";
    reasons.push(`已达严重异常波动 → 高停牌核查风险：${seriousHits.join("；")}`);
  } else if (abnormalHit || nearSerious) {
    level = "abnormal_or_near_serious";
    if (abnormalHit) reasons.push(`已触发异常波动：近3日累计偏离${fmt(dev3)}（阈值±${abnThreshold}%）`);
    if (nearSerious) reasons.push(`接近严重异常波动（10日${fmt(dev10)} / 30日${fmt(dev30)} / 同向${eventCount}次）`);
  } else if (nearAbnormal) {
    level = "near_abnormal";
    reasons.push(`接近异常波动：近3日累计偏离${fmt(dev3)}（阈值±${abnThreshold}%）`);
  } else {
    level = "normal";
    reasons.push("近期偏离值离各档阈值都较远");
  }

  const meta = LEVEL_META[level];
  return {
    code,
    name,
    board: board.label,
    isST,
    level,
    levelLabel: meta.label,
    color: meta.color,
    rank: meta.rank,
    asOf: stock.rows[stock.rows.length - 1].date,
    benchmark: `${board.benchmarkIndex.name}(${board.benchmarkIndex.code})`,
    metrics: {
      dev3: dev3 == null ? null : Number(dev3.toFixed(2)),
      dev10: dev10 == null ? null : Number(dev10.toFixed(2)),
      dev30: dev30 == null ? null : Number(dev30.toFixed(2)),
      abnEventCount10: eventCount,
      reqCount,
      abnThreshold,
      serious: { dev10: s.dev10, dev30: s.dev30 },
    },
    announced,
    reasons,
  };
}

export function createSuspensionAlertHandler() {
  return async function suspensionAlertHandler(req, res) {
    const reply = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };

    // 用 req.url 解析 query，兼容 express(server/index.js) 与 vite connect 中间件两种挂载方式。
    const requestUrl = new URL(req.url || "", "http://localhost");
    const code = String(requestUrl.searchParams.get("code") || "").trim();
    if (!/^\d{6}$/.test(code)) {
      return reply(400, { error: "code 必须是 6 位 A 股代码" });
    }

    const cacheKey = `suspend-alert:${code}`;
    try {
      const redis = await getRedisClient();
      const cached = await redis.get(cacheKey);
      if (cached) return reply(200, JSON.parse(cached));
    } catch {
      /* Redis 不可用则直接现算 */
    }

    try {
      const result = await computeRisk(code, requestUrl.searchParams.get("name") || "");
      try {
        const redis = await getRedisClient();
        await redis.set(cacheKey, JSON.stringify(result), { EX: RESULT_TTL });
      } catch {
        /* 忽略缓存写入失败 */
      }
      return reply(200, result);
    } catch (error) {
      return reply(502, { error: error?.message || String(error) });
    }
  };
}
