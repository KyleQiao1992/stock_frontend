// 停牌预警 handler：对单只 A 股做「停牌风险」分级。
// 核心风险通道：异常波动 → 严重异常波动 → 强制停牌核查。
// 规则口径见 docs/suspension-alert-rules.md，阈值/对应指数配置见 server/suspensionRules.json。
//
// 前端用法：GET /api/suspension-alert?code=603678
// 全部同步现算（个股原始日K/除权参考价 + 对应指数日K + 东财停复牌feed），不落库，结果 Redis 短缓存。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRedisClient } from "./redisClient.js";
import { parseEastmoneyDailyKline, parseTencentDailyKline, cumDeviation, abnormalWindow, abnormalDirection, deviationWindow, severityReached, countSameDirAbnormal } from "./suspensionPrices.js";

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
const CACHE_WAIT_MS = 300; // 可选缓存不能让诊断等待连接/命令超时。

function withDeadline(operation, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("缓存等待超时")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function optionalCache(getRedis, waitMs) {
  return {
    async read(key) {
      try {
        const value = await withDeadline(async () => (await getRedis()).get(key), waitMs);
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    },
    write(key, value, ttl) {
      // 写缓存不属于诊断结果；故障时不能阻塞已经算好的响应。
      void withDeadline(async () => {
        const redis = await getRedis();
        await redis.set(key, JSON.stringify(value), { EX: ttl });
      }, waitMs).catch(() => {});
    },
  };
}

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

// ── 取数：日 K（不复权），腾讯主、东财 push2his 备选 ──────────────────────
// 保留原始收盘价、实际交易参考前收价；腾讯用同源除权事件恢复参考价。

async function fetchKlineEastmoney(secid, limit, isIndex, request) {
  for (const host of PUSH2HIS_HOSTS) {
    try {
      const url =
        `${host}/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&ut=${EM_UT}` +
        "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
        `&klt=101&fqt=0&beg=0&end=20500101&lmt=${limit}`;
      const r = await request(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      return parseEastmoneyDailyKline(j, { isIndex });
    } catch {
      /* 换下一个 host */
    }
  }
  return null;
}

async function fetchKlineTencent(code, isIndex, limit, request) {
  const sym = tencentSym(code, isIndex);
  try {
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/kline?param=${sym},day,,,${limit}`;
    const r = await request(url, {
      headers: { Referer: "https://gu.qq.com/", "User-Agent": EM_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // Scope action parsing to the requested recent history; older unsupported
    // allocation formats do not affect the current calculation windows.
    const source = j?.data?.[sym];
    if (Array.isArray(source?.day)) source.day = source.day.slice(-limit);
    return parseTencentDailyKline(j, sym, { isIndex });
  } catch (error) {
    throw new Error(`腾讯日K/除权参考价不可用：${error.message}`, { cause: error });
  }
}

export async function fetchDailyKline(code, { isIndex = false, limit = 60, request = fetch } = {}) {
  // 腾讯正常时立即使用，避免每次先等三个当前不可达的东财 host。
  let primaryError;
  try {
    return await fetchKlineTencent(code, isIndex, limit, request);
  } catch (error) {
    primaryError = error;
  }
  const viaEm = await fetchKlineEastmoney(isIndex ? indexSecid(code) : stockSecid(code), limit, isIndex, request);
  if (viaEm) return viaEm;
  throw primaryError;
}

// ── 取数：东财两市停复牌 feed（已公告停牌，前瞻） ─────────────────────────

export function createSuspendFeedLoader({ request = fetch, getRedis = getRedisClient, today = todayCST, cacheWaitMs = CACHE_WAIT_MS } = {}) {
  const cache = optionalCache(getRedis, cacheWaitMs);
  const inFlight = new Map();
  return function fetchSuspendFeed() {
    const date = today();
    if (inFlight.has(date)) return inFlight.get(date);
    const pending = (async () => {
      // 旧缓存可能将取数失败写成 {}；只读新版已验证、且对应当天的缓存。
      const cacheKey = `suspend-feed:verified-v1:${date}`;
      const cached = await cache.read(cacheKey);
      if (cached && typeof cached === "object" && !Array.isArray(cached)) return cached;

      const url =
        "https://datacenter-web.eastmoney.com/api/data/v1/get" +
        "?reportName=RPT_CUSTOM_SUSPEND_DATA_INTERFACE&columns=ALL&source=WEB&client=WEB" +
        "&sortColumns=SUSPEND_START_DATE&sortTypes=-1&pageNumber=1&pageSize=500" +
        `&filter=(MARKET="全部")(DATETIME='${date}')`;
      try {
        const r = await request(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (j?.success !== true || !Array.isArray(j?.result?.data)) {
          throw new Error("未返回有效的停复牌公告列表");
        }
        const map = {};
        for (const row of j.result.data) {
          if (!/^\d{6}$/.test(String(row.SECURITY_CODE))) throw new Error("停复牌公告股票代码异常");
          map[String(row.SECURITY_CODE)] = {
            reason: row.SUSPEND_REASON || "",
            start: (row.SUSPEND_START_DATE || "").slice(0, 10),
            resume: (row.PREDICT_RESUME_DATE || "").slice(0, 10) || null,
            expire: row.SUSPEND_EXPIRE || "",
          };
        }
        cache.write(cacheKey, map, FEED_TTL);
        return map;
      } catch (error) {
        throw new Error(`停复牌公告获取失败：${error.message}`, { cause: error });
      }
    })();
    inFlight.set(date, pending);
    void pending.finally(() => inFlight.delete(date)).catch(() => {});
    return pending;
  };
}

const fetchSuspendFeed = createSuspendFeedLoader();

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

export async function computeRisk(code, passedName = "", { loadDaily = fetchDailyKline, loadFeed = fetchSuspendFeed, today = todayCST() } = {}) {
  const boardKey = boardForCode(code);
  if (!boardKey) {
    return { code, level: "normal", levelLabel: "未知板块", reasons: ["无法识别板块（仅支持沪深 A 股）"], unsupported: true };
  }
  const board = RULES.boards[boardKey];
  if (board.status === "TODO_separate_ruleset") {
    return { code, board: board.label, level: "normal", levelLabel: board.label, reasons: ["北交所规则不同，暂未纳入沪深引擎"], unsupported: true };
  }

  const [stock, index, feed] = await Promise.all([
    loadDaily(code, { isIndex: false }),
    loadDaily(board.benchmarkIndex.code, { isIndex: true }),
    loadFeed(),
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
  const abnWindow = abnormalWindow(stock.rows, idxByDate);
  const s = board.serious;
  const seriousWindows = {
    dev10: deviationWindow(stock.rows, idxByDate, 10, s.dev10),
    dev30: deviationWindow(stock.rows, idxByDate, 30, s.dev30),
  };
  if (!abnWindow || !seriousWindows.dev10 || !seriousWindows.dev30
    || [dev3, dev10, dev30].some(value => !Number.isFinite(value))) {
    throw new Error("日K参考前收价或同期指数数据缺失，无法计算偏离值");
  }
  const reqCount = s.sameDirAbnormalCount.count;
  const eventCount = countSameDirAbnormal(stock.rows, idxByDate, abnThreshold, s.sameDirAbnormalCount.windowDays);

  const reasons = [];
  const fmt = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

  // 严重异常波动判定
  const seriousHits = [];
  if (severityReached(seriousWindows.dev10)) {
    seriousHits.push(`近${seriousWindows.dev10.days}日累计偏离${fmt(seriousWindows.dev10.deviation)}（10日内，阈值+${s.dev10.up}%/${s.dev10.down}%）`);
  }
  if (severityReached(seriousWindows.dev30)) {
    seriousHits.push(`近${seriousWindows.dev30.days}日累计偏离${fmt(seriousWindows.dev30.deviation)}（30日内，阈值+${s.dev30.up}%/${s.dev30.down}%）`);
  }
  if (eventCount >= reqCount) {
    seriousHits.push(`10日内同向异常波动${eventCount}次（达${reqCount}次）`);
  }

  const abnormalHit = abnormalDirection(abnWindow.deviation, abnThreshold) !== 0;
  const nearRatio = RULES.riskTiers.approachRatio;
  const nearSerious =
    severityReached(seriousWindows.dev10, nearRatio) ||
    severityReached(seriousWindows.dev30, nearRatio) ||
    eventCount === reqCount - 1;
  const nearAbnormal = abnormalDirection(abnWindow.deviation, abnThreshold * nearRatio) !== 0;

  const announced = feed[code] || null;

  let level;
  let levelLabel = null; // 橙色档按 abnormalHit/nearSerious 动态命名，其余走 LEVEL_META 默认
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
    levelLabel = abnormalHit ? "已触发异常波动" : "接近严重异常波动";
    if (abnormalHit) reasons.push(`已触发异常波动：近${abnWindow.days}日累计偏离${fmt(abnWindow.deviation)}（阈值±${abnThreshold}%）`);
    if (nearSerious) {
      const candidates = [];
      for (const [key, maxDays] of [["dev10", 10], ["dev30", 30]]) {
        const window = seriousWindows[key];
        if (severityReached(window, nearRatio)) candidates.push(`近${window.days}日偏离${fmt(window.deviation)}（${maxDays}日内）`);
      }
      if (eventCount === reqCount - 1) candidates.push(`同向异波${eventCount}次（估算）`);
      reasons.push(`接近严重异常波动：${candidates.join("；")}`);
    }
  } else if (nearAbnormal) {
    level = "near_abnormal";
    reasons.push(`接近异常波动：近${abnWindow.days}日累计偏离${fmt(abnWindow.deviation)}（阈值±${abnThreshold}%）`);
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
    levelLabel: levelLabel || meta.label,
    color: meta.color,
    rank: meta.rank,
    asOf: stock.rows[stock.rows.length - 1].date,
    benchmark: `${board.benchmarkIndex.name}(${board.benchmarkIndex.code})`,
    calculationBasis: "daily-trading-reference-close",
    eventCountApproximate: true,
    metrics: {
      dev3: dev3 == null ? null : Number(dev3.toFixed(2)),
      abnWindowDays: abnWindow.days,
      abnDeviation: Number(abnWindow.deviation.toFixed(2)),
      dev10: dev10 == null ? null : Number(dev10.toFixed(2)),
      dev30: dev30 == null ? null : Number(dev30.toFixed(2)),
      seriousWindows: Object.fromEntries(Object.entries(seriousWindows).map(([key, window]) => [key, {
        ...window, deviation: Number(window.deviation.toFixed(2)),
      }])),
      abnEventCount10: eventCount,
      reqCount,
      abnThreshold,
      serious: { dev10: s.dev10, dev30: s.dev30 },
    },
    announced,
    reasons,
  };
}

export function createSuspensionAlertHandler({ compute = computeRisk, getRedis = getRedisClient, cacheWaitMs = CACHE_WAIT_MS } = {}) {
  const cache = optionalCache(getRedis, cacheWaitMs);
  const inFlight = new Map();
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

    const name = requestUrl.searchParams.get("name") || "";
    // Exclude old engines and results which could ignore a failed announcement feed.
    // Name is part of the key because it can determine the ST threshold.
    const cacheKey = `suspend-alert:reference-v4:${code}:${encodeURIComponent(name)}`;
    try {
      let pending = inFlight.get(cacheKey);
      if (!pending) {
        pending = (async () => {
          const cached = await cache.read(cacheKey);
          if (cached) return cached;
          const result = await compute(code, name);
          cache.write(cacheKey, result, RESULT_TTL);
          return result;
        })();
        inFlight.set(cacheKey, pending);
        void pending.finally(() => inFlight.delete(cacheKey)).catch(() => {});
      }
      return reply(200, await pending);
    } catch (error) {
      return reply(502, { error: error?.message || String(error) });
    }
  };
}
