import { authFetch as apiFetch } from "../lib/authClient.js";
import UserAdminPanel from "./UserAdminPanel";
import AccountPanel from "./AccountPanel";
import StockAnalysisPanel from "./StockAnalysisPanel";
import ChanOverlay from "./ChanOverlay";
import ChanControls from "./ChanControls";
import { analyzeChan } from "../lib/chan/index.js";
import { isCurrentMarketSnapshot, marketSnapshotSourceLabel, formatMarketSnapshotTime } from "../lib/marketSnapshotQuality.js";
import { todayMarketPresentation } from "../lib/todayMarketPresentation.js";
import { Component, Fragment, lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sun,
  X,
  Send,
  Star,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { THEME_OPTIONS } from "@/theme";

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor };
const AgentMarkdownMessage = lazy(() => import("./AgentMarkdownMessage"));

const PERIOD_OPTIONS = [
  { value: "101", label: "日K" },
  { value: "102", label: "周K" },
  { value: "103", label: "月K" },
];
const EMPTY_LIST = Object.freeze([]);

const DISPLAY_COUNT_OPTIONS = [20, 30, 45, 60, 80, 120, 180, 240, 360, 500];

function stepDisplayCount(current, direction, maxCount = 500) {
  const availableMax = Math.max(20, Math.min(500, Number(maxCount) || 500));
  const options = DISPLAY_COUNT_OPTIONS.filter((count) => count <= availableMax);
  if (!options.includes(availableMax)) options.push(availableMax);
  options.sort((a, b) => a - b);
  const value = Number(current) || 80;
  if (direction < 0) {
    return [...options].reverse().find((count) => count < value) ?? options[0];
  }
  return options.find((count) => count > value) ?? options[options.length - 1];
}


const MARKET_TABS = [
  { value: "market-trend", label: "趋势大盘" },
  { value: "ashare", label: "A股" },
  { value: "hk", label: "港股" },
  { value: "us", label: "美股" },
  { value: "agent", label: "Agent" },
  { value: "factor-research", label: "因子研究", adminOnly: true },
  { value: "user-admin", label: "账号管理", adminOnly: true },
  { value: "account", label: "账号设置" },
];

// 趋势大盘要展示的四大指数。secid 用于东方财富，tencentSymbol 用于腾讯兜底。
const TREND_INDICES = [
  { code: "000001", name: "上证指数", secid: "1.000001", tencentSymbol: "sh000001" },
  { code: "000688", name: "科创50", secid: "1.000688", tencentSymbol: "sh000688" },
  { code: "399001", name: "深证成指", secid: "0.399001", tencentSymbol: "sz399001" },
  { code: "399006", name: "创业板指", secid: "0.399006", tencentSymbol: "sz399006" },
];

// 两个子 tab：中长期看 MA60，中短期看 MA20。多头趋势的三个判断条件除均线周期外完全一致。
const TREND_TABS = [
  // 热力图：全 A 按细分行业铺成树图，面积＝流通市值/成交额，颜色＝涨跌幅。放首位，进页面先看它。
  { value: "heatmap", label: "热力图", isHeatmap: true },
  { value: "today", label: "今日盘面", isToday: true },
  { value: "long", label: "中长期多头趋势", term: "中长期", ma: 60 },
  { value: "short", label: "中短期多头趋势", term: "中短期", ma: 20 },
  // 资金流分化：板块主力净流入累计曲线（净流入排名两端），按 日/周/月 切换。
  { value: "fundflow", label: "资金流分化", isFundflow: true },
];

// 资金流分化图的时间维度。
const FUNDFLOW_DIMS = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
];

// 趋势大盘可按年份回看。"latest" 为最新窗口，其余为具体年份（含该年全部交易日）。
const TREND_MIN_YEAR = 2015;
const TREND_YEAR_OPTIONS = (() => {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear; y >= TREND_MIN_YEAR; y -= 1) {
    years.push({ value: String(y), label: `${y} 年` });
  }
  return [{ value: "latest", label: "最新" }, ...years];
})();

// 判断某根（默认最后一根）是否处于多头趋势：CLOSE>MAn、MAn 向上、DIF>0 三者同时成立。
function evalTrend(rows, maPeriod) {
  const safe = Array.isArray(rows) ? rows.filter((r) => r && Number.isFinite(r.close)) : [];
  if (safe.length < maPeriod + 2) return null;
  const ma = movingAverage(safe, maPeriod);
  const macd = calcMACDSeries(safe);
  const i = safe.length - 1;
  const close = safe[i].close;
  const maNow = ma[i];
  const maPrev = ma[i - 1];
  const dif = macd[i]?.dif;
  if (![close, maNow, maPrev, dif].every(Number.isFinite)) return null;
  const c1 = close > maNow; // 收盘价在均线之上
  const c2 = maNow > maPrev; // 均线向上
  const c3 = dif > 0; // DIF 在 0 轴之上
  return { c1, c2, c3, isBull: c1 && c2 && c3, close, maNow, maPrev, dif };
}

const WATCHLIST_STYLE_OPTIONS = [
  { value: "cards", label: "自选" },
  { value: "rows", label: "推荐" },
];

const RECOMMENDATION_FACTOR_OPTIONS = [
  { value: "factor1", label: "因子1" },
  { value: "factor2", label: "因子2" },
  { value: "factor3", label: "因子3" },
  { value: "factor4", label: "因子4" },
  { value: "factor5", label: "因子5" },
  { value: "factor6", label: "因子6" },
];

function isSixDigitCode(value) {
  const s = String(value || "").trim();
  return s.length === 6 && Array.from(s).every((ch) => ch >= "0" && ch <= "9");
}

function onlyDigits(value) {
  return String(value || "")
    .split("")
    .filter((ch) => ch >= "0" && ch <= "9")
    .join("")
    .slice(0, 6);
}

function normalizeUsSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .split("")
    .filter((ch) => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "-")
    .join("")
    .slice(0, 12);
}

function isValidUsSymbol(value) {
  const s = String(value || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,11}$/.test(s);
}

// The preload cache keeps US klines "秒开", but the last bar goes stale intraday.
// Reuse cached data only for a short window so an open session refreshes to today's price;
// preload's own 0.5s throttle is unaffected since this only refetches on user action.
const US_KLINE_CACHE_TTL_MS = 60_000;

function isUsKlineCacheFresh(cached) {
  return Boolean(cached?.data) && Date.now() - (cached.ts || 0) < US_KLINE_CACHE_TTL_MS;
}

function guessSecid(code) {
  const c = String(code || "").trim();
  if (!isSixDigitCode(c)) return null;
  const shPrefixes = ["600", "601", "603", "605", "688", "689", "900"];
  if (shPrefixes.some((p) => c.startsWith(p))) return `1.${c}`;
  return `0.${c}`;
}

function loadJsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("当前环境暂时不能请求行情数据。"));
      return;
    }

    const callbackName = `em_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const fullUrl = `${url}${url.includes("?") ? "&" : "?"}cb=${callbackName}`;
    let finished = false;

    function cleanup() {
      try {
        delete window[callbackName];
      } catch {
        window[callbackName] = undefined;
      }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    const timer = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error("JSONP 行情请求超时"));
    }, timeout);

    window[callbackName] = (data) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      cleanup();
      reject(new Error("JSONP 行情接口请求失败"));
    };

    script.src = fullUrl;
    document.body.appendChild(script);
  });
}

async function loadJsonDirect(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const fullUrl = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
    const res = await fetch(fullUrl, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadMarketJson(url) {
  const errors = [];

  try {
    return await loadJsonDirect(url);
  } catch (e) {
    errors.push(`fetch: ${e?.message || e}`);
  }

  try {
    return await loadJsonp(url);
  } catch (e) {
    errors.push(`jsonp: ${e?.message || e}`);
  }

  throw new Error(`行情接口请求失败：${errors.join("；")}`);
}

function buildEastmoneyKlineUrl({ host, secid, period, adjust, limit }) {
  return (
    `${host}/api/qt/stock/kline/get?` +
    `secid=${encodeURIComponent(secid)}` +
    "&ut=fa5fd1943c7b386f172d6893dbfba10b" +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    `&klt=${encodeURIComponent(period)}` +
    `&fqt=${encodeURIComponent(adjust)}` +
    "&beg=0" +
    "&end=20500101" +
    `&lmt=${encodeURIComponent(String(limit))}`
  );
}

function toTencentSymbol(code) {
  const c = String(code || "").trim();
  const shPrefixes = ["600", "601", "603", "605", "688", "689", "900"];
  return `${shPrefixes.some((p) => c.startsWith(p)) ? "sh" : "sz"}${c}`;
}

function periodToTencent(period) {
  if (period === "102") return "week";
  if (period === "103") return "month";
  return "day";
}

function adjustToTencent(adjust) {
  if (adjust === "1") return "qfq";
  if (adjust === "2") return "hfq";
  return "";
}

function loadScriptVariable(url, varName, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("当前环境暂时不能请求行情数据。"));
      return;
    }

    const script = document.createElement("script");
    let finished = false;

    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    const timer = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error("脚本变量行情请求超时"));
    }, timeout);

    script.onload = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      const value = window[varName];
      try {
        delete window[varName];
      } catch {
        window[varName] = undefined;
      }
      cleanup();
      if (value) resolve(value);
      else reject(new Error("脚本已加载但没有返回行情变量"));
    };

    script.onerror = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      cleanup();
      reject(new Error("脚本变量行情接口请求失败"));
    };

    script.src = url;
    document.body.appendChild(script);
  });
}

async function loadTencentText(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("腾讯行情文本格式异常");
    return JSON.parse(text.slice(start, end + 1));
  } finally {
    window.clearTimeout(timer);
  }
}

function buildTencentKlineUrl({ code, period, adjust, limit, varName }) {
  const symbol = toTencentSymbol(code);
  const ktype = periodToTencent(period);
  const adj = adjustToTencent(adjust);
  const param = `${symbol},${ktype},,,${limit}${adj ? `,${adj}` : ""}`;
  return `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=${encodeURIComponent(varName)}&param=${encodeURIComponent(param)}`;
}

function parseTencentKlineResponse(res, { code, period, adjust }) {
  const symbol = toTencentSymbol(code);
  const ktype = periodToTencent(period);
  const adj = adjustToTencent(adjust);
  const node = res?.data?.[symbol] || res?.data?.[code] || res?.[symbol] || res?.[code];
  if (!node) throw new Error("腾讯行情返回中未找到该股票数据");

  const keyCandidates = [];
  if (adj === "qfq") keyCandidates.push(`qfq${ktype}`, `${ktype}qfq`, "qfqday", "qfqweek", "qfqmonth");
  if (adj === "hfq") keyCandidates.push(`hfq${ktype}`, `${ktype}hfq`, "hfqday", "hfqweek", "hfqmonth");
  keyCandidates.push(ktype, "day", "week", "month");

  let arr = null;
  for (const key of keyCandidates) {
    if (Array.isArray(node[key])) {
      arr = node[key];
      break;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("腾讯行情 K 线为空");

  let prevClose = null;
  const parsed = arr
    .map((item) => {
      const date = item[0];
      const open = Number(item[1]);
      const close = Number(item[2]);
      const high = Number(item[3]);
      const low = Number(item[4]);
      const volume = Number(item[5]);
      const change = Number.isFinite(prevClose) ? close - prevClose : 0;
      const pct = Number.isFinite(prevClose) && prevClose !== 0 ? (change / prevClose) * 100 : 0;
      prevClose = close;
      return { date, open, close, high, low, volume, amount: 0, amplitude: 0, pct, change, turnover: 0 };
    })
    .filter((r) => r.date && [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite));

  if (!parsed.length) throw new Error("腾讯行情数据格式异常");
  return parsed;
}

async function fetchTencentKline({ code, period, adjust, limit }) {
  const limits = Array.from(
    new Set([Math.min(Number(limit) || 600, 1000), 600, 320, 120].filter((v) => Number(v) > 0)),
  );
  const errors = [];

  for (const currentLimit of limits) {
    const varName = `tencent_kline_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = buildTencentKlineUrl({ code, period, adjust, limit: currentLimit, varName });

    try {
      const res = await loadScriptVariable(url, varName);
      const klines = parseTencentKlineResponse(res, { code, period, adjust });
      return {
        code,
        name: extractTencentName(res, code),
        ...extractTencentQuoteMeta(res, code),
        klines,
        sourceInfo: `Tencent script, lmt=${currentLimit}`,
      };
    } catch (e) {
      errors.push(`script lmt=${currentLimit}: ${e?.message || e}`);
    }

    try {
      const res = await loadTencentText(url);
      const klines = parseTencentKlineResponse(res, { code, period, adjust });
      return {
        code,
        name: extractTencentName(res, code),
        ...extractTencentQuoteMeta(res, code),
        klines,
        sourceInfo: `Tencent fetch, lmt=${currentLimit}`,
      };
    } catch (e) {
      errors.push(`fetch lmt=${currentLimit}: ${e?.message || e}`);
    }
  }

  throw new Error(`腾讯行情也失败：${errors.slice(-2).join("；")}`);
}

function extractTencentQuoteMeta(res, code) {
  const symbol = toTencentSymbol(code);
  const node = res?.data?.[symbol] || res?.data?.[code] || res?.[symbol] || res?.[code];
  const qt = node?.qt?.[symbol] || node?.qt?.[code];
  if (!Array.isArray(qt)) return { marketCap: null, floatMarketCap: null, peRatio: null, turnoverRate: null, volumeRatio: null, outerVol: null, innerVol: null };

  // Tencent quote fields: 7 = 外盘 (主动买，手), 8 = 内盘 (主动卖，手), 38 = turnover rate %, 39 = PE, 44 = float market cap in 100M CNY, 45 = total market cap in 100M CNY, 49 = volume ratio.
  const outerVol = Number(qt[7]);
  const innerVol = Number(qt[8]);
  const turnoverRate = Number(qt[38]);
  const peRatio = Number(qt[39]);
  const floatMarketCapYi = Number(qt[44]);
  const totalMarketCapYi = Number(qt[45]);
  const volumeRatio = Number(qt[49]);
  return {
    marketCap: Number.isFinite(totalMarketCapYi) ? totalMarketCapYi * 100000000 : null,
    floatMarketCap: Number.isFinite(floatMarketCapYi) ? floatMarketCapYi * 100000000 : null,
    peRatio: Number.isFinite(peRatio) ? peRatio : null,
    turnoverRate: Number.isFinite(turnoverRate) ? turnoverRate : null,
    volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : null,
    outerVol: Number.isFinite(outerVol) ? outerVol : null,
    innerVol: Number.isFinite(innerVol) ? innerVol : null,
  };
}

function extractTencentName(res, code) {
  const symbol = toTencentSymbol(code);
  const node = res?.data?.[symbol] || res?.data?.[code] || res?.[symbol] || res?.[code];
  const qt = node?.qt?.[symbol] || node?.qt?.[code];
  if (Array.isArray(qt) && qt[1]) return qt[1];
  return code;
}

async function fetchAshareKline({ code, period, adjust, limit }) {
  const secid = guessSecid(code);
  if (!secid) throw new Error("请输入 6 位 A 股代码，例如 600519、000001、300750。");

  const errors = [];

  try {
    return await fetchTencentKline({ code, period, adjust, limit });
  } catch (e) {
    errors.push(`Tencent primary: ${e?.message || e}`);
  }

  const hosts = [
    "https://push2his.eastmoney.com",
    "https://79.push2his.eastmoney.com",
    "https://82.push2his.eastmoney.com",
  ];
  const limits = Array.from(new Set([1200, 600].filter((v) => Number(v) > 0)));

  for (const currentLimit of limits) {
    for (const host of hosts) {
      const url = buildEastmoneyKlineUrl({ host, secid, period, adjust, limit: currentLimit });
      try {
        const res = await loadMarketJson(url);
        const data = res && res.data ? res.data : null;
        const klines = data && Array.isArray(data.klines) ? data.klines : [];
        if (!data || klines.length === 0) {
          errors.push(`${host} lmt=${currentLimit}: 空数据`);
          continue;
        }

        const parsed = klines
          .map((line) => {
            const parts = String(line).split(",");
            return {
              date: parts[0],
              open: Number(parts[1]),
              close: Number(parts[2]),
              high: Number(parts[3]),
              low: Number(parts[4]),
              volume: Number(parts[5]),
              amount: Number(parts[6]),
              amplitude: Number(parts[7]),
              pct: Number(parts[8]),
              change: Number(parts[9]),
              turnover: Number(parts[10]),
            };
          })
          .filter((r) => r.date && [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite));

        if (parsed.length === 0) {
          errors.push(`${host} lmt=${currentLimit}: 数据格式异常`);
          continue;
        }

        return {
          code: data.code || code,
          name: data.name || code,
          klines: parsed,
          sourceInfo: `${host}, lmt=${currentLimit}`,
        };
      } catch (e) {
        errors.push(`${host} lmt=${currentLimit}: ${e?.message || e}`);
      }
    }
  }

  throw new Error(
    `行情数据暂时不可用。已优先尝试腾讯行情，并用东方财富兜底，但都失败了。请稍后重试，或换一只股票代码。最后错误：${errors
      .slice(-3)
      .join("；")}`,
  );
}

// 指数日线取数。腾讯 kline/kline 为主（不复权，显式 symbol，_var 脚本方式绕过跨域，最稳），东方财富兜底。
// 注意：指数不能用 fqkline/get（需复权参数，否则返回 bad params），也不能用 guessSecid/toTencentSymbol（会把上证/科创判成深市）。
async function fetchIndexKline({ secid, tencentSymbol, name, limit = 500 }) {
  const errors = [];

  // 腾讯不复权日线。注意 kline/kline 的 count 过大（>1000）会 param error，故仅适合较小窗口。
  async function tryTencent() {
    if (!tencentSymbol) return null; // 板块（90.BKxxxx）等无腾讯代码的标的直接走东方财富。
    const varName = `tencent_index_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const param = `${tencentSymbol},day,,,${Math.min(limit, 1000)}`;
    const tencentUrl = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?_var=${encodeURIComponent(varName)}&param=${encodeURIComponent(param)}`;
    for (const loader of [() => loadScriptVariable(tencentUrl, varName), () => loadTencentText(tencentUrl)]) {
      try {
        const res = await loader();
        const node = res?.data?.[tencentSymbol] || res?.data?.[tencentSymbol?.toUpperCase?.()];
        const arr = Array.isArray(node?.day) ? node.day : Array.isArray(node?.qfqday) ? node.qfqday : null;
        if (!arr || !arr.length) throw new Error("腾讯指数 K 线为空");
        let prevClose = null;
        const parsed = arr
          .map((item) => {
            const close = Number(item[2]);
            const pct = Number.isFinite(prevClose) && prevClose !== 0 ? ((close - prevClose) / prevClose) * 100 : 0;
            prevClose = close;
            return {
              date: item[0],
              open: Number(item[1]),
              close,
              high: Number(item[3]),
              low: Number(item[4]),
              volume: Number(item[5]),
              pct,
            };
          })
          .filter((r) => r.date && [r.open, r.close, r.high, r.low].every(Number.isFinite));
        if (parsed.length) return { code: tencentSymbol, name, klines: parsed };
      } catch (e) {
        errors.push(`tencent: ${e?.message || e}`);
      }
    }
    return null;
  }

  // 东方财富，支持较深历史（回看早年时用它）。push2delay 延时 host 在实时 push2 被墙时仍可达，放最前兜底。
  async function tryEastmoney() {
    const hosts = [
      "https://push2delay.eastmoney.com",
      "https://push2his.eastmoney.com",
      "https://79.push2his.eastmoney.com",
      "https://82.push2his.eastmoney.com",
    ];
    for (const host of hosts) {
      const url = buildEastmoneyKlineUrl({ host, secid, period: "101", adjust: "0", limit });
      try {
        const res = await loadMarketJson(url);
        const data = res && res.data ? res.data : null;
        const klines = data && Array.isArray(data.klines) ? data.klines : [];
        if (!data || klines.length === 0) {
          errors.push(`${host}: 空数据`);
          continue;
        }
        const parsed = klines
          .map((line) => {
            const parts = String(line).split(",");
            return {
              date: parts[0],
              open: Number(parts[1]),
              close: Number(parts[2]),
              high: Number(parts[3]),
              low: Number(parts[4]),
              volume: Number(parts[5]),
              pct: Number(parts[8]),
            };
          })
          .filter((r) => r.date && [r.open, r.close, r.high, r.low].every(Number.isFinite));
        if (parsed.length) {
          return { code: data.code || secid, name: data.name || name, klines: parsed };
        }
        errors.push(`${host}: 数据格式异常`);
      } catch (e) {
        errors.push(`${host}: ${e?.message || e}`);
      }
    }
    return null;
  }

  // 深度历史（回看早年）腾讯 count 受限，优先东方财富；最新窗口仍以腾讯为主（最稳）。
  const order = limit > 1000 ? [tryEastmoney, tryTencent] : [tryTencent, tryEastmoney];
  for (const fn of order) {
    const res = await fn();
    if (res) return res;
  }

  throw new Error(`指数行情暂时不可用。最后错误：${errors.slice(-3).join("；")}`);
}

async function fetchUsKline({ symbol, period, adjust, limit }) {
  const normalized = normalizeUsSymbol(symbol);
  if (!isValidUsSymbol(normalized)) {
    throw new Error("请输入有效的美股代码，例如 AAPL、MSFT、NVDA、BRK.B。");
  }

  const errors = [];

  try {
    const params = new URLSearchParams({
      symbol: normalized,
      period,
      adjust,
      limit: String(limit || 600),
    });
    const res = await apiFetch(`/api/us-kline?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
    const klines = Array.isArray(payload?.klines) ? payload.klines : [];
    if (!klines.length) throw new Error("本地美股代理返回空数据");
    return {
      code: payload.code || normalized,
      name: payload.name || normalized,
      marketCap: Number.isFinite(payload.marketCap) ? payload.marketCap : null,
      floatMarketCap: Number.isFinite(payload.floatMarketCap) ? payload.floatMarketCap : null,
      peRatio: Number.isFinite(payload.peRatio) ? payload.peRatio : null,
      turnoverRate: Number.isFinite(payload.turnoverRate) ? payload.turnoverRate : null,
      volumeRatio: payload.volumeRatioSource === "calculated" ? null : Number.isFinite(payload.volumeRatio) ? payload.volumeRatio : null,
      volumeRatioSource: payload.volumeRatioSource || "unavailable",
      sessionVwap: Number.isFinite(payload.sessionVwap) ? payload.sessionVwap : null,
      sessionVwapPremium: Number.isFinite(payload.sessionVwapPremium) ? payload.sessionVwapPremium : null,
      sessionVwapSource: payload.sessionVwapSource || "unavailable",
      innerVol: Number.isFinite(payload.innerVol) ? payload.innerVol : null,
      outerVol: Number.isFinite(payload.outerVol) ? payload.outerVol : null,
      tradeSideVolumeSource: payload.tradeSideVolumeSource || "unavailable",
      indicatorsQuoteTime: payload.indicatorsQuoteTime || "",
      quoteTime: payload.quoteTime || "",
      klines,
      sourceInfo: payload.sourceInfo || "Nasdaq local proxy",
    };
  } catch (e) {
    errors.push(`Nasdaq local proxy: ${e?.message || e}`);
  }

  const hosts = [
    "https://push2his.eastmoney.com",
    "https://79.push2his.eastmoney.com",
    "https://82.push2his.eastmoney.com",
  ];
  const secids = [`105.${normalized}`, `106.${normalized}`];
  const limits = Array.from(new Set([Math.max(300, Number(limit) || 600), 1200, 600].filter((v) => Number(v) > 0)));

  for (const currentLimit of limits) {
    for (const secid of secids) {
      for (const host of hosts) {
        const url = buildEastmoneyKlineUrl({ host, secid, period, adjust, limit: currentLimit });
        try {
          const res = await loadMarketJson(url);
          const data = res?.data || null;
          const klines = Array.isArray(data?.klines) ? data.klines : [];
          if (!data || klines.length === 0) {
            errors.push(`${host} ${secid} lmt=${currentLimit}: 空数据`);
            continue;
          }

          const parsed = klines
            .map((line) => {
              const parts = String(line).split(",");
              return {
                date: parts[0],
                open: Number(parts[1]),
                close: Number(parts[2]),
                high: Number(parts[3]),
                low: Number(parts[4]),
                volume: Number(parts[5]),
                amount: Number(parts[6]),
                amplitude: Number(parts[7]),
                pct: Number(parts[8]),
                change: Number(parts[9]),
                turnover: Number(parts[10]),
              };
            })
            .filter((r) => r.date && [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite));

          if (!parsed.length) {
            errors.push(`${host} ${secid} lmt=${currentLimit}: 数据格式异常`);
            continue;
          }

          return {
            code: data.code || normalized,
            name: data.name || normalized,
            marketCap: null,
            floatMarketCap: null,
            klines: parsed,
            sourceInfo: `${host}, ${secid}, lmt=${currentLimit}`,
          };
        } catch (e) {
          errors.push(`${host} ${secid} lmt=${currentLimit}: ${e?.message || e}`);
        }
      }
    }
  }

  throw new Error(`美股行情暂时不可用。已尝试无 key 历史行情源，但都失败了。最后错误：${errors.slice(-3).join("；")}`);
}

async function fetchHkKline({ code, period, adjust, limit }) {
  const normalized = normalizeHkCode(code);
  if (!isValidHkCode(normalized)) throw new Error("请输入有效的港股代码，例如 00700、09988。");
  const params = new URLSearchParams({
    code: normalized,
    period,
    adjust,
    limit: String(limit || 600),
  });
  const res = await apiFetch(`/api/hk-kline?${params.toString()}`, { method: "GET", cache: "no-store" });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  if (!Array.isArray(payload?.klines) || !payload.klines.length) throw new Error("腾讯港股行情返回空数据。");
  return payload;
}

function calcSimpleTD9(rows) {
  let up = 0;
  let down = 0;
  return rows.map((r, i) => {
    let tdUp = null;
    let tdDown = null;
    let tdStatus = null;
    if (i >= 4) {
      up = r.close > rows[i - 4].close ? up + 1 : 0;
      down = r.close < rows[i - 4].close ? down + 1 : 0;
      if (up > 0) {
        tdUp = Math.min(up, 9);
        tdStatus = up >= 9 ? "confirmed" : "simple";
      }
      if (down > 0) {
        tdDown = Math.min(down, 9);
        tdStatus = down >= 9 ? "confirmed" : "simple";
      }
      if (up >= 9) up = 0;
      if (down >= 9) down = 0;
    }
    return { ...r, tdUp, tdDown, tdStatus };
  });
}

function calcTonghuashunTD9(rows) {
  const out = rows.map((r) => ({ ...r, tdUp: null, tdDown: null, tdStatus: null }));

  function mark(isUp) {
    let start = -1;
    let len = 0;

    function flush(isCurrentRun) {
      if (start < 0 || len <= 0) return;
      const shouldShow = len >= 9 || (isCurrentRun && len >= 6);
      if (!shouldShow) return;
      const showLen = Math.min(len, 9);
      for (let n = 1; n <= showLen; n += 1) {
        const idx = start + n - 1;
        if (!out[idx]) continue;
        if (isUp) out[idx].tdUp = n;
        else out[idx].tdDown = n;
        out[idx].tdStatus = len >= 9 ? "confirmed" : "pending";
      }
    }

    for (let i = 0; i < rows.length; i += 1) {
      const ok = i >= 4 && (isUp ? rows[i].close > rows[i - 4].close : rows[i].close < rows[i - 4].close);
      if (ok) {
        if (len === 0) start = i;
        len += 1;
      } else {
        flush(false);
        start = -1;
        len = 0;
      }
    }
    flush(true);
  }

  mark(true);
  mark(false);
  return out;
}

function calcCurrentTD9(rows) {
  const base = calcSimpleTD9(rows);
  const out = base.map((r) => ({ ...r, tdUp: null, tdDown: null, tdStatus: null }));
  if (!base.length) return out;

  const lastIndex = base.length - 1;
  const latest = base[lastIndex];
  const isUp = latest.tdUp != null;
  const isDown = latest.tdDown != null;
  if (!isUp && !isDown) return out;

  const count = isUp ? latest.tdUp : latest.tdDown;
  for (let n = 0; n < count; n += 1) {
    const idx = lastIndex - n;
    if (idx < 0) break;
    const turn = count - n;
    if (isUp) out[idx].tdUp = turn;
    if (isDown) out[idx].tdDown = turn;
    out[idx].tdStatus = turn === 9 ? "confirmed" : "current";
  }
  return out;
}

function calcTD9(rows, mode) {
  if (mode === "current") return calcCurrentTD9(rows);
  if (mode === "full" || mode === "simple") return calcSimpleTD9(rows);
  return calcTonghuashunTD9(rows);
}

function getCurrentTDLabel(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = rows[rows.length - 1];
  if (latest?.tdUp != null) {
    return {
      direction: "up",
      count: latest.tdUp,
      text: `上涨第${latest.tdUp}转`,
      shortText: `上涨${latest.tdUp}`,
    };
  }
  if (latest?.tdDown != null) {
    return {
      direction: "down",
      count: latest.tdDown,
      text: `下跌第${latest.tdDown}转`,
      shortText: `下跌${latest.tdDown}`,
    };
  }
  return null;
}

function movingAverage(rows, n, pick = (r) => r.close) {
  return rows.map((_, i) => {
    // 不够 n 根时用「已有的全部 K 线」算平均，让均线从第一根开始连续，不留左侧空缺。
    const start = Math.max(0, i - n + 1);
    const count = i - start + 1;
    let sum = 0;
    for (let j = start; j <= i; j += 1) sum += pick(rows[j]);
    return sum / count;
  });
}

// K线形态识别：扫描整段 OHLC，标出经典反转形态。形状相同的形态（锤子线/上吊线、
// 看涨/看跌吞没）靠「前置趋势」区分多空，避免误标。返回 [{index, name, abbr, dir}]，
// dir: "bear" 顶部看跌 / "bull" 底部看涨。
function detectKlinePatterns(rows) {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (n < 3) return [];
  // 单根K线的几何特征：实体、振幅、上影、下影、阴阳。
  const feat = (d) => {
    const body = Math.abs(d.close - d.open);
    const range = d.high - d.low;
    const upper = d.high - Math.max(d.open, d.close);
    const lower = Math.min(d.open, d.close) - d.low;
    return { body, range, upper, lower, up: d.close > d.open, down: d.close < d.open };
  };
  // 前置趋势：比较 endIdx 与往前 lookback 根的收盘，涨跌幅 >1% 记为上行，<-1% 记为下行。
  const trend = (endIdx, lookback = 4) => {
    const from = rows[Math.max(0, endIdx - lookback)];
    const to = rows[endIdx];
    if (!from || !to) return 0;
    const chg = (to.close - from.close) / Math.max(Math.abs(from.close), 1e-6);
    if (chg > 0.01) return 1;
    if (chg < -0.01) return -1;
    return 0;
  };
  const out = [];
  // priority 越小越「强/具体」，同一根K线只保留优先级最高的一个标记。
  const push = (index, name, abbr, dir, priority) => out.push({ index, name, abbr, dir, priority });

  for (let i = 0; i < n; i += 1) {
    const c = rows[i];
    if (![c.open, c.close, c.high, c.low].every(Number.isFinite)) continue;
    const f = feat(c);
    if (f.range <= 0) continue;

    // 单根：长下影 + 小实体 + 无/极短上影，同一形状靠趋势/开盘位置区分上吊线与锤子线。
    // 共同形状（书面特征②③）：下影≥实体2倍、无/很短上影（≤振幅15%）。body>0排除十字。
    // ①b 开盘位置（镜像）：上吊线开在前一根「最高价附近」、锤子线开在前一根「最低价附近」，量化为「前一根振幅的上/下 30%」。
    // ④小实体：上吊线书面把它列为独立识别标志，故加 body≤振幅20%；锤子线书面特征列表未列「小实体」，沿用②③隐含的≤振幅1/3。
    if (f.body > 0 && f.lower >= f.body * 2 && f.upper <= f.range * 0.15 && i >= 1) {
      const pHigh = rows[i - 1].high;
      const pLow = rows[i - 1].low;
      const pRange = pHigh - pLow;
      // 上吊线（顶部反转）：①a 上升波段顶部 + ①b 开盘在前一根最高价附近（前一根振幅上30%，含跳空高开）+ ④小实体。
      if (
        trend(i - 1) > 0 &&
        f.body <= f.range * 0.2 &&
        c.open >= pHigh - pRange * 0.3
      ) {
        push(i, "上吊线 · 看跌", "吊", "bear", 30);
      } else if (
        // 锤子线（底部反转）：①a 下跌波段底部 + ①b 开盘在前一根最低价附近（前一根振幅下30%，含跳空低开）。
        trend(i - 1) < 0 &&
        c.open <= pLow + pRange * 0.3
      ) {
        push(i, "锤子线 · 看涨", "锤", "bull", 30);
      }
    }
    // 单根：射击之星（顶部反转）。书面特征：①a上升波段顶部、①b开盘价在前一根最高价附近
    // 「附近」量化为「开在前一根振幅的上 30% 区间」：open ≥ prev.high − prev.range×0.3（或更高/跳空），
    // 与绝对价位无关，对各种前一根形态（大阳线/带上影）都稳；仍是单侧下限，高开越多越看跌不排除。
    // ②上影线≥实体2倍 ③无下影或下影很短（≤振幅15%）。颜色不限、实体越短越看跌，故不设实体下限（body>0排除十字）。
    if (
      i >= 1 && f.body > 0 &&
      f.upper >= f.body * 2 &&
      f.lower <= f.range * 0.15 &&
      c.open >= rows[i - 1].high - (rows[i - 1].high - rows[i - 1].low) * 0.3 &&
      trend(i - 1) > 0
    ) {
      push(i, "射击之星 · 看跌", "射", "bear", 30);
    }

    // 单根：黄昏之星（顶部反转）。书面把它定义为「上升波段顶部、小实体、基本等长的小影线」的单根K线。
    // 书面特征：①上升波段顶部、开盘通常在前日收盘价之上；②上下影线较短且长度相差不大；③实体很小或开收相等；④颜色不重要。
    // 按书：②③判「星本身」——③实体、②对称性都自参照（书里只有①引用前一根，且用其收盘价，不是实体大小）；
    // ②「较短」是相对尺度（短/长相对趋势K线而言），锚前一根振幅 pRange。④不要求阴阳。
    // 短影↔长影边界已与长腿车夫统一：短影(≤pRange×0.4)→昏、长腿(≥pRange×0.5)→车，中间为模糊带，二者不重叠。
    if (i >= 1) {
      const p = rows[i - 1];
      const pRange = p.high - p.low;
      const shadowDiff = Math.abs(f.upper - f.lower);
      if (
        trend(i - 1) > 0 &&
        c.open >= p.close &&            // ①b 开盘在前日收盘价之上
        f.body <= f.range * 0.3 &&      // ③ 实体很小（允许 body=0，即开收相等）
        f.upper <= pRange * 0.4 &&      // ② 上影较短（相对前一根振幅）
        f.lower <= pRange * 0.4 &&      // ② 下影较短
        shadowDiff <= f.range * 0.2     // ② 上下影基本等长（相差 ≤ 自身振幅20%）
      ) {
        push(i, "黄昏之星", "昏", "bear", 30);
      }
    }

    // 单根：早晨之星（启明星，底部反转）。书面明说它是「与黄昏之星相对应的底部形态」：
    // 除趋势(下跌底部)与开盘方向(低开)外，形状条件与黄昏之星完全相同（小实体、上下影较短且基本等长）。
    // 书面特征：①下降波段底部、开盘在前日收盘价之下；②上下影线较短且相差不大；③实体很小或开收相等；④颜色不重要。
    if (i >= 1) {
      const p = rows[i - 1];
      const pRange = p.high - p.low;
      const shadowDiff = Math.abs(f.upper - f.lower);
      if (
        trend(i - 1) < 0 &&
        c.open <= p.close &&            // ①b 开盘在前日收盘价之下（低开，黄昏之星的镜像）
        f.body <= f.range * 0.3 &&      // ③ 实体很小（允许 body=0，即开收相等）
        f.upper <= pRange * 0.4 &&      // ② 上影较短（相对前一根振幅）
        f.lower <= pRange * 0.4 &&      // ② 下影较短
        shadowDiff <= f.range * 0.2     // ② 上下影基本等长（相差 ≤ 自身振幅20%）
      ) {
        push(i, "早晨之星 · 看涨", "晨", "bull", 30);
      }
    }

    // 单根：长腿车夫（顶部反转）。书面特征：①上升波段顶部；②上下影线都很长，均长于实体2倍；③小实体，颜色不重要。
    // 书还强调「当日震荡幅度相当大」——「长腿」是绝对尺度，不能只按"占自身振幅比例"判（否则迷你十字也被当长腿，
    // 还会把纯十字黄昏之星抢过来）。故长腿门槛锚前一根振幅 pRange：影线要同时 ≥2倍实体（书面数值）且 ≥ pRange×0.5。
    // 与黄昏之星「较短」(≤pRange×0.4) 形成统一的短/长尺度：短影→昏、长腿→车，二者不再重叠。
    if (i >= 1) {
      const pRange = rows[i - 1].high - rows[i - 1].low;
      if (
        trend(i - 1) > 0 &&
        pRange > 0 &&                       // 「长腿」相对前一根振幅判定；前一根一字板(pRange=0)无法判定，不标
        f.body <= f.range * 0.15 &&
        f.upper >= Math.max(f.body * 2, pRange * 0.5) &&
        f.lower >= Math.max(f.body * 2, pRange * 0.5)
      ) {
        push(i, "长腿车夫 · 看跌", "车", "bear", 25);
      }
    }

    // 单根：长腿十字线（底部反转）。书面明说它是「与顶部长腿车夫相对应」的底部形态——长腿车夫的镜像。
    // 书面特征：①下降波段底部、开盘在前日收盘价之下；②上下影线都很长且长度相差不大；③实体非常小或开收相等。
    // 「长腿」同长腿车夫锚 pRange×0.5；与早晨之星「较短」(≤pRange×0.4) 形成统一短/长尺度：短影→晨、长腿→腿，二者不重叠（镜像顶部 昏/车 边界）。
    // 注：长腿车夫书面列表未列「相差不大」，而长腿十字线列表明确写了，故此处加对称门槛（与上吊线/锤子线的「小实体」异同同理）。
    if (i >= 1) {
      const pRange = rows[i - 1].high - rows[i - 1].low;
      const shadowDiff = Math.abs(f.upper - f.lower);
      if (
        trend(i - 1) < 0 &&
        pRange > 0 &&                                   // 「长腿」相对前一根振幅判定；前一根一字板(pRange=0)无法判定，不标
        c.open <= rows[i - 1].close &&                 // ① 开盘在前日收盘价之下（低开）
        f.body <= f.range * 0.15 &&                    // ③ 实体非常小
        f.upper >= Math.max(f.body * 2, pRange * 0.5) && // ② 上影长（锚前一根振幅）
        f.lower >= Math.max(f.body * 2, pRange * 0.5) && // ② 下影长
        shadowDiff <= f.range * 0.2                     // ② 上下影长度相差不大（对称）
      ) {
        push(i, "长腿十字线 · 看涨", "腿", "bull", 25);
      }
    }

    // 单根：墓碑线（顶部反转）。高位大幅高开后形成长黑实体，上下影都很短。
    if (i >= 1) {
      const p = rows[i - 1];
      const gapPct = (c.open - p.close) / Math.max(Math.abs(p.close), 1e-6);
      const rangePct = f.range / Math.max(Math.abs(p.close), 1e-6);
      if (
        trend(i - 1) > 0 &&
        f.down &&
        gapPct >= 0.07 &&
        rangePct >= 0.07 &&
        f.body >= f.range * 0.75 &&
        f.upper <= f.range * 0.1 &&
        f.lower <= f.range * 0.1
      ) {
        push(i, "墓碑线 · 看跌", "墓", "bear", 15);
      }
    }

    // 两根：吞没 / 乌云盖顶 / 曙光初现。
    if (i >= 1) {
      const p = rows[i - 1];
      const pf = feat(p);
      if (f.body > 0 && pf.body > 0) {
        // 刺透形态（底部反转，看跌吞没的镜像）：中/长阴 → 低开长阳，阳线收在高位并升破前一根开盘价（完全收复整根阴线实体）。
        // 书面特征：①下降波段底部；②第一根中/长阴；③第二根低开、收在最高价附近的长阳；④第二根收盘在第一根开盘价之上。
        // 注：本书把底部「完全收复」叫刺透形态（即看跌吞没的镜像），书面底部并无单列「看涨吞没」，故此处用刺透形态。
        if (
          pf.down &&
          pf.body >= pf.range * 0.4 &&
          f.up &&
          f.body >= f.range * 0.4 &&
          f.upper <= f.range * 0.15 &&
          c.open < p.close &&
          c.close > p.open &&
          trend(i - 1) < 0
        ) {
          push(i, "刺透形态 · 看涨", "刺", "bull", 20);
        }
        // 看跌吞没：中/长阳 → 高开长阴，阴线收在低位并跌破前一根开盘价，处上涨末端。
        if (
          pf.up &&
          pf.body >= pf.range * 0.4 &&
          f.down &&
          f.body >= f.range * 0.4 &&
          f.lower <= f.range * 0.15 &&
          c.open > p.close &&
          c.close < p.open &&
          trend(i - 1) > 0
        ) {
          push(i, "看跌吞没", "吞", "bear", 20);
        }
      }
      // 乌云盖顶：中/长阳 → 高开中/长阴，阴线收在低位并跌破前一根实体半分位，处上涨末端。
      if (
        pf.up &&
        pf.body >= pf.range * 0.4 &&
        f.down &&
        f.body >= f.range * 0.4 &&
        f.lower <= f.range * 0.15 &&
        trend(i - 1) > 0
      ) {
        const midP = (p.open + p.close) / 2;
        if (c.open > p.close && c.close < midP && c.close > p.open) {
          push(i, "乌云盖顶", "乌", "bear", 20);
        }
      }
      // 曙光初现（底部反转，乌云盖顶的镜像）：中/长阴 → 低开中/长阳，阳线收在高位并升破前一根实体半分位，处下跌末端。
      // 书面特征：①下降波段底部；②第一根中/长阴；③第二根低开、收在最高价附近的中/长阳；④第二根收盘在第一根实体半分位之上。
      // close > p.open 即完全吃掉前一根 → 归「刺透形态」（下一形态），此处保留 close < p.open（不完全），与乌云/吞没的切分对称。
      if (
        pf.down &&
        pf.body >= pf.range * 0.4 &&
        f.up &&
        f.body >= f.range * 0.4 &&
        f.upper <= f.range * 0.15 &&
        trend(i - 1) < 0
      ) {
        const midP = (p.open + p.close) / 2;
        if (c.open < p.close && c.close > midP && c.close < p.open) {
          push(i, "曙光初现", "曙", "bull", 20);
        }
      }
    }

    // 三根：三只乌鸦（顶部反转）。书面特征：①上升波段顶部；
    // ②第一根为高开的中小阴线；③三根均为收盘价依次降低的中小阴线。
    if (i >= 3) {
      const a = rows[i - 2];
      const b = rows[i - 1];
      const af = feat(a);
      const bf = feat(b);
      const smallMediumDown = (item) => item.down && item.body >= item.range * 0.25 && item.body <= item.range * 0.75;
      if (
        trend(i - 3) > 0 &&
        smallMediumDown(af) &&
        smallMediumDown(bf) &&
        smallMediumDown(f) &&
        a.open > rows[i - 3].close &&
        b.close < a.close &&
        c.close < b.close
      ) {
        push(i, "三只乌鸦 · 看跌", "鸦", "bear", 12);
      }
    }

    // 三根：红三兵（底部反转，三只乌鸦的镜像）。书面特征：①下降波段底部；
    // ②第一根为低开的中小阳线；③三根均为收盘价依次提高的中小阳线。
    if (i >= 3) {
      const a = rows[i - 2];
      const b = rows[i - 1];
      const af = feat(a);
      const bf = feat(b);
      const smallMediumUp = (item) => item.up && item.body >= item.range * 0.25 && item.body <= item.range * 0.75;
      if (
        trend(i - 3) < 0 &&
        smallMediumUp(af) &&
        smallMediumUp(bf) &&
        smallMediumUp(f) &&
        a.open < rows[i - 3].close &&
        b.close > a.close &&
        c.close > b.close
      ) {
        push(i, "红三兵 · 看涨", "兵", "bull", 12);
      }
    }

  }

  // 同一根K线去重，保留 priority 最小者。
  const byIndex = new Map();
  for (const p of out) {
    const ex = byIndex.get(p.index);
    if (!ex || p.priority < ex.priority) byIndex.set(p.index, p);
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

const KLINE_PATTERN_DETAILS = {
  "射击之星": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "shootingStar",
    definition: "上涨波段末端出现的小实体、长上影 K 线，说明盘中冲高后被卖压打回，顶部抛压开始增强。",
    conditions: [
      "位于上升波段顶部",
      "开盘价在前一根 K 线最高价附近",
      "上影线长度至少为实体的 2 倍",
      "没有下影线或只有很短的下影线",
    ],
    note: "颜色不是硬条件；阴线、实体更短或放量时，见顶含义通常更强。",
  },
  "上吊线": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "hangingMan",
    definition: "上涨波段末端出现长下影、小实体 K 线，表示盘中曾遭遇明显抛售，即使收回也提示买盘承接开始不稳。",
    conditions: [
      "位于上升波段顶部",
      "开盘价在前一根 K 线最高价附近",
      "下影线长度至少为实体的 2 倍",
      "没有上影线或只有很短的上影线",
    ],
    note: "收阴线时风险提示更强；当前实现把“小实体”通过长下影和短上影条件隐式约束。",
  },
  "锤子线": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段末端出现长下影、小实体 K 线，表示空方盘中继续打压后被买盘拉回，底部承接可能增强。",
    conditions: [
      "位于下降波段底部",
      "开盘价在前一根 K 线最低价附近",
      "下影线长度至少为实体的 2 倍",
      "没有上影线或只有很短的上影线",
    ],
    note: "颜色不是硬条件（红色阳线的锤头更有效）；书面锤头未把“小实体”单列，实体小由长下影和短上影隐式约束。",
  },
  "黄昏之星": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "eveningStar",
    definition: "上涨波段顶部出现向上跳开的极小实体或近似十字星，代表上涨动能停顿，后续若转弱容易形成顶部反转。",
    conditions: [
      "位于上升波段顶部",
      "开盘通常在前一日收盘价之上",
      "实体很小或开盘价等于收盘价",
      "上下影线较短且长度相差不大",
    ],
    note: "当前标在小星本身，不要求第三根确认阴线；确认阴线可作为更严格的后续过滤。",
  },
  "早晨之星": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段底部出现向下跳开的极小实体或近似十字星（启明星），代表下跌动能趋于完结，后续若转强容易形成底部反转。是黄昏之星的镜像。",
    conditions: [
      "位于下降波段底部",
      "开盘通常在前一日收盘价之下",
      "实体很小或开盘价等于收盘价",
      "上下影线较短且长度相差不大",
    ],
    note: "与黄昏之星形状完全相同，仅趋势(下跌底部)与开盘方向(低开)相反；标在小星本身，不要求次日确认阳线。",
  },
  "长腿车夫": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "longLeggedRickshaw",
    definition: "上涨波段顶部出现小实体、上下长影的单根 K 线，说明盘中多空分歧剧烈，冲高和杀跌都被反复拉扯，顶部不稳定性上升。",
    conditions: [
      "位于上升波段顶部",
      "上影线和下影线都很长，均至少为实体的 2 倍",
      "上下长影是「当日震荡幅度相当大」的表现",
      "实体较小，实体颜色不是硬条件",
    ],
    note: "当前实现要求实体不超过整根振幅 15%，上下影线各自至少为前一根振幅的一半（pRange×0.5），以排除绝对很小的迷你十字。",
  },
  "长腿十字线": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段底部出现实体极小、上下影都很长且相近的单根 K 线，盘中多空反复拉扯后收回原位，底部多空分歧剧烈、止跌迹象增强。是长腿车夫的镜像。",
    conditions: [
      "位于下降波段底部",
      "开盘价在前一日收盘价之下",
      "上影线与下影线都很长，且长度相差不大",
      "实体非常小或开盘价等于收盘价",
    ],
    note: "长腿车夫的底部镜像；长腿门槛与长腿车夫一致（≥前一根振幅一半），并按书面要求加「上下影相差不大」的对称条件。与早晨之星按短/长影互斥。",
  },
  "墓碑线": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "gravestoneDoji",
    definition: "上涨波段顶部以接近涨停价大幅高开，随后一路回落形成长黑实体，说明利好刺激后的追买迅速衰竭，顶部抛压集中释放。",
    conditions: [
      "位于上升波段顶部",
      "以接近涨停的价格大幅高开",
      "没有上下影线或上下影线都很短",
      "很长的黑色实体，振幅通常在 7% 以上",
    ],
    note: "当前实现把“大幅高开/振幅通常 7% 以上”量化为相对前收盘价均不低于 7%，并要求阴线实体至少占整根振幅 75%。",
  },
  "乌云盖顶": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    definition: "上涨波段顶部由中长阳线和高开的中长阴线组成，第二根阴线像乌云一样盖住前一根，表示高位追买失败，空方开始夺回主动。",
    conditions: [
      "位于上升波段顶部",
      "第一根 K 线为中阳或长阳线",
      "第二根 K 线为高开，并收盘在最低价附近的中阴或长阴线",
      "第二根 K 线收盘价低于第一根实体半分位",
    ],
    note: "当前实现要求第一根和第二根实体均至少占各自振幅 40%，第二根下影线不超过振幅 15%；若第二根完全吞没第一根，会由看跌吞没优先标记。",
  },
  "曙光初现": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段底部由中长阴线和低开的中长阳线组成，第二根阳线收复前一根阴线实体的一半以上，表示空头打压失败、多方开始反击。是乌云盖顶的镜像。",
    conditions: [
      "位于下降波段底部",
      "第一根 K 线为中阴或长阴线",
      "第二根 K 线为低开，并收盘在最高价附近的中阳或长阳线",
      "第二根 K 线收盘价高于第一根实体半分位",
    ],
    note: "乌云盖顶的底部镜像；要求两根实体均至少占各自振幅 40%，第二根上影线不超过振幅 15%；若第二根完全收复（收在前一根阴线开盘价之上）则归刺透形态（更强）。",
  },
  "看跌吞没": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    exampleKey: "bearishEngulfing",
    definition: "上涨波段顶部由中长阳线和高开的长阴线组成，第二根阴线收盘跌破前一根开盘价，说明前一日涨幅被完全吞没，顶部抛压更强。",
    conditions: [
      "位于上升波段顶部",
      "第一根 K 线为中阳或长阳线",
      "第二根 K 线为高开，并收盘在最低价附近的长阴线",
      "第二根 K 线收盘价低于第一根 K 线开盘价",
    ],
    note: "当前实现要求第一根和第二根实体均至少占各自振幅 40%，第二根下影线不超过振幅 15%。",
  },
  "三只乌鸦": {
    bias: "看跌",
    type: "顶部反转",
    status: "已核对",
    definition: "上涨波段顶部连续出现三根中小阴线，且收盘价逐根降低，说明短线杀跌连续展开，顶部卖压持续增强。",
    conditions: [
      "位于上升波段顶部",
      "第一根 K 线为高开的中小阴线",
      "三根 K 线均为中小阴线",
      "三根 K 线收盘价依次降低",
    ],
    note: "当前实现把中小阴线量化为实体占自身振幅 25%-75%；第一根高开按第一根开盘价高于前一根收盘价判断。",
  },
  "红三兵": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段底部连续出现三根中小阳线，且收盘价逐根提高，说明多方力量不断加入、空头动能减弱，底部抬升迹象增强。是三只乌鸦的镜像。",
    conditions: [
      "位于下降波段底部",
      "第一根 K 线为低开的中小阳线",
      "三根 K 线均为中小阳线",
      "三根 K 线收盘价依次提高",
    ],
    note: "三只乌鸦的镜像；中小阳线量化为实体占自身振幅 25%-75%；第一根低开按第一根开盘价低于前一根收盘价判断。书中提到第三根常放量、实体更大，与三只乌鸦第三根常为大阴同理，目前上限仍按 75%。",
  },
  "刺透形态": {
    bias: "看涨",
    type: "底部反转",
    status: "已核对",
    definition: "下跌波段底部由中长阴线和低开长阳线组成，第二根阳线一举收复并升破前一根阴线的开盘价（穿头破脚），是比曙光初现更强的多头反击。是看跌吞没的镜像。",
    conditions: [
      "位于下降波段底部",
      "第一根 K 线为中阴或长阴线",
      "第二根 K 线为低开，并收盘在最高价附近的长阳线",
      "第二根 K 线收盘价在第一根 K 线开盘价之上",
    ],
    note: "看跌吞没的底部镜像；要求两根实体均至少占各自振幅 40%，第二根上影线不超过振幅 15%。与曙光初现以「收盘是否越过第一根开盘价」切分：未越过→曙光初现，越过→刺透形态。",
  },
};

function getKlinePatternDetail(pattern) {
  const rawName = String(pattern?.name || "");
  const baseName = rawName.split(" · ")[0];
  return KLINE_PATTERN_DETAILS[baseName] || null;
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}万`;
  return v.toFixed(2);
}

function formatMillionValue(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value / 1000000).toFixed(2)}百万`;
}

function formatPercentValue(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function fundFlowColor(value) {
  if (!Number.isFinite(value) || value === 0) return "text-slate-700";
  return value > 0 ? "text-red-600" : "text-green-700";
}

function formatFundFlowAmount(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

// 收藏夹为空时的默认随机池（大盘流动性较好的标的）。
const ASHARE_FALLBACK_WATCHLIST = [
  "600519", "000001", "300750", "600036", "000858",
  "601318", "300059", "002594", "600276", "601012",
  "000333", "600900", "601899", "002475", "300760",
];
const US_FALLBACK_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL",
  "META", "TSLA", "AMD", "NFLX", "AVGO",
];
const HK_FALLBACK_WATCHLIST = [
  "00700", "09988", "03690", "00005", "00941",
  "02318", "01299", "01810", "09888", "09618",
];

function pickRandomCodes(pool, count) {
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

function normalizeWatchlistCodes(input, market) {
  const parts = String(input || "")
    .split(/[,\n，\s、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set();
  const normalized = [];
  for (const part of parts) {
    const code = normalizeCodeForMarket(part, market);
    const valid = market === "ashare" ? isSixDigitCode(code) : market === "hk" ? isValidHkCode(code) : isValidUsSymbol(code);
    if (!valid || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function normalizeCodeForMarket(value, market) {
  if (market === "ashare") return onlyDigits(value);
  if (market === "hk") return normalizeHkCode(value);
  return normalizeUsSymbol(value);
}

function normalizeHkCode(value) {
  let raw = String(value || "").trim().toUpperCase();
  raw = raw.replace(/^HK/, "").replace(/\.HK$/, "");
  if (!/^\d{1,5}$/.test(raw)) return "";
  return raw.padStart(5, "0");
}

function isValidHkCode(value) {
  return /^\d{5}$/.test(String(value || ""));
}

function normalizeEquityMarket(value, fallback = "ashare") {
  return ["ashare", "hk", "us"].includes(value) ? value : fallback;
}

function getErrorMessage(error, fallback = "操作失败，请稍后重试。") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function formatRecommendationDateInput(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function shiftDateToPreviousTradingDay(date) {
  const next = new Date(date);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() - 1);
  }
  return next;
}

function parseRecommendationDate(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(year, month - 1, day);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function toRecommendationDateDigits(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function normalizeRecommendationDate(value) {
  const parsed = parseRecommendationDate(value);
  if (!parsed) return "";
  return toRecommendationDateDigits(shiftDateToPreviousTradingDay(parsed));
}

function getDefaultRecommendationDate() {
  return toRecommendationDateDigits(shiftDateToPreviousTradingDay(new Date()));
}

async function fetchRecommendationList({ market, factor, date }) {
  const params = new URLSearchParams({ market, factor, date });
  const res = await apiFetch(`/api/recommendations?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

async function fetchAshareSuggestions(query, options = {}) {
  const keyword = String(query || "").trim();
  if (!keyword) return [];
  const params = new URLSearchParams({ q: keyword });
  const res = await apiFetch(`/api/ashare-search?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function fetchHkSuggestions(query, options = {}) {
  const keyword = String(query || "").trim();
  if (!keyword) return [];
  const params = new URLSearchParams({ q: keyword });
  const res = await apiFetch(`/api/hk-search?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return Array.isArray(payload?.items) ? payload.items : [];
}

async function fetchFavorites({ market }) {
  const params = new URLSearchParams({ market });
  const res = await apiFetch(`/api/favorites?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

async function addFavorite({ market, code, name, group }) {
  const res = await apiFetch("/api/favorites", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ market, code, name, group }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

async function removeFavorite({ market, code }) {
  const params = new URLSearchParams({ market, code });
  const res = await apiFetch(`/api/favorites?${params.toString()}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

// 把某只票移动到另一个收藏夹（单归属）。
async function moveFavorite({ market, code, group }) {
  const res = await apiFetch("/api/favorites", {
    method: "PATCH",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market, code, group }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

async function createFavoriteGroup({ market, name }) {
  const res = await apiFetch("/api/favorite-groups", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market, name }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

// 删除收藏夹（连同其下所有票）。
async function deleteFavoriteGroup({ market, name }) {
  const params = new URLSearchParams({ market, name });
  const res = await apiFetch(`/api/favorite-groups?${params.toString()}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  return payload;
}

function formatFavoriteTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function calcGaps(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (!prev || !curr) continue;

    if (curr.low > prev.high) {
      let endIndex = rows.length - 1;
      let filled = false;
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[j].low <= prev.high) {
          endIndex = j;
          filled = true;
          break;
        }
      }
      gaps.push({
        type: "up",
        label: "向上断层",
        date: curr.date,
        startIndex: i - 1,
        gapIndex: i,
        endIndex,
        top: curr.low,
        bottom: prev.high,
        filled,
      });
    } else if (curr.high < prev.low) {
      let endIndex = rows.length - 1;
      let filled = false;
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[j].high >= prev.low) {
          endIndex = j;
          filled = true;
          break;
        }
      }
      gaps.push({
        type: "down",
        label: "向下断层",
        date: curr.date,
        startIndex: i - 1,
        gapIndex: i,
        endIndex,
        top: prev.low,
        bottom: curr.high,
        filled,
      });
    }
  }
  return gaps;
}

function percentText(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

function latestValid(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function calcMAValue(rows, index, n) {
  if (index < n - 1) return null;
  let sum = 0;
  for (let i = index - n + 1; i <= index; i += 1) sum += rows[i].close;
  return sum / n;
}

function classifyTrendForIndex(rows, index) {
  const ma5 = calcMAValue(rows, index, 5);
  const ma10 = calcMAValue(rows, index, 10);
  const ma20 = calcMAValue(rows, index, 20);
  const ma60 = calcMAValue(rows, index, 60);
  const close = rows[index]?.close;
  if (![ma5, ma10, ma20, ma60, close].every(Number.isFinite)) return "unknown";
  if (close > ma20 && ma5 > ma10 && ma10 > ma20 && ma20 > ma60) return "strong";
  if (close > ma20 && ma5 > ma10) return "up";
  if (close < ma20 && ma5 < ma10) return "down";
  return "sideways";
}

function getTDStateAt(rowsWithTD, index) {
  const row = rowsWithTD[index];
  if (!row) return { direction: "none", count: 0, text: "无明显九转" };
  if (row.tdUp) return { direction: "up", count: row.tdUp, text: `上涨第${row.tdUp}转` };
  if (row.tdDown) return { direction: "down", count: row.tdDown, text: `下跌第${row.tdDown}转` };
  return { direction: "none", count: 0, text: "无明显九转" };
}

function futureStatsBySimilarState(rawRows, horizon, currentTrend, currentTD) {
  if (!Array.isArray(rawRows) || rawRows.length < 90) return null;
  const rowsWithTD = calcSimpleTD9(rawRows);
  const returns = [];
  const currentCountBucket = currentTD.count >= 6 ? "late" : currentTD.count >= 1 ? "early" : "none";

  for (let i = 60; i < rawRows.length - horizon; i += 1) {
    const trend = classifyTrendForIndex(rawRows, i);
    const td = getTDStateAt(rowsWithTD, i);
    const bucket = td.count >= 6 ? "late" : td.count >= 1 ? "early" : "none";

    if (trend !== currentTrend) continue;
    if (td.direction !== currentTD.direction) continue;
    if (bucket !== currentCountBucket) continue;

    const ret = rawRows[i + horizon].close / rawRows[i].close - 1;
    if (Number.isFinite(ret)) returns.push(ret);
  }

  if (!returns.length) return null;
  const wins = returns.filter((r) => r > 0).length;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { sample: returns.length, probability: wins / returns.length, avgReturn: avg, medianReturn: median };
}

function emaFromValues(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v) => {
    if (!Number.isFinite(v)) return null;
    if (prev == null) prev = v;
    else prev = v * k + prev * (1 - k);
    return prev;
  });
}

function calcMACDState(rows) {
  if (!Array.isArray(rows) || rows.length < 35) {
    return { ready: false, text: "样本不足", state: "neutral", pattern: "样本不足" };
  }
  const closes = rows.map((r) => r.close);
  const ema12 = emaFromValues(closes, 12);
  const ema26 = emaFromValues(closes, 26);
  const dif = closes.map((_, i) => (Number.isFinite(ema12[i]) && Number.isFinite(ema26[i]) ? ema12[i] - ema26[i] : null));
  const dea = emaFromValues(dif, 9);
  const i = rows.length - 1;
  const latestDif = dif[i];
  const latestDea = dea[i];
  const prevDif = dif[i - 1];
  const prevDea = dea[i - 1];
  const hist = Number.isFinite(latestDif) && Number.isFinite(latestDea) ? 2 * (latestDif - latestDea) : null;
  const prevHist = Number.isFinite(prevDif) && Number.isFinite(prevDea) ? 2 * (prevDif - prevDea) : hist;

  if (![latestDif, latestDea, hist].every(Number.isFinite)) {
    return { ready: false, text: "样本不足", state: "neutral", pattern: "样本不足" };
  }

  const goldenCross = Number.isFinite(prevDif) && Number.isFinite(prevDea) && prevDif <= prevDea && latestDif > latestDea;
  const deathCross = Number.isFinite(prevDif) && Number.isFinite(prevDea) && prevDif >= prevDea && latestDif < latestDea;
  const lineGap = latestDif - latestDea;
  const prevLineGap = Number.isFinite(prevDif) && Number.isFinite(prevDea) ? prevDif - prevDea : lineGap;
  const nearGapThreshold = Math.max(0.03, Math.abs(latestDea) * 0.08, Math.abs(hist) * 0.25);
  const nearGolden = !goldenCross && lineGap < 0 && lineGap > prevLineGap && Math.abs(lineGap) <= nearGapThreshold;
  const nearDeath = !deathCross && lineGap > 0 && lineGap < prevLineGap && Math.abs(lineGap) <= nearGapThreshold;
  const crossProximity = Math.max(0, Math.min(1, 1 - Math.abs(lineGap) / Math.max(nearGapThreshold, 0.0001)));
  const underZero = latestDif < 0 && latestDea < 0;
  const aboveZero = latestDif > 0 && latestDea > 0;
  const nearZero = Math.abs(latestDif) < 0.03 || Math.abs(latestDea) < 0.03 || (!underZero && !aboveZero);

  let state = "neutral";
  let label = "中性";
  let pattern = "无明显交叉";

  if (goldenCross) {
    state = underZero ? "weakBull" : "bull";
    if (underZero) pattern = "水下金叉";
    else if (aboveZero) pattern = "水上金叉";
    else pattern = "零轴附近金叉";
    label = underZero ? "弱势反弹信号" : aboveZero ? "强势偏多信号" : "转强观察信号";
  } else if (deathCross) {
    state = aboveZero ? "weakBear" : "bear";
    if (underZero) pattern = "水下死叉";
    else if (aboveZero) pattern = "水上死叉";
    else pattern = "零轴附近死叉";
    label = underZero ? "弱势延续信号" : aboveZero ? "强势转弱信号" : "转弱观察信号";
  } else if (nearGolden) {
    state = "nearGolden";
    if (underZero) pattern = "水下临近金叉";
    else if (aboveZero) pattern = "水上临近金叉";
    else pattern = "零轴附近临近金叉";
    label = "DIF仍低于DEA，但差距快速收窄";
  } else if (nearDeath) {
    state = "nearDeath";
    if (underZero) pattern = "水下临近死叉";
    else if (aboveZero) pattern = "水上临近死叉";
    else pattern = "零轴附近临近死叉";
    label = "DIF仍高于DEA，但差距快速收窄";
  } else if (latestDif > latestDea && hist > 0 && hist >= prevHist) {
    state = "bull";
    pattern = aboveZero ? "水上偏多" : underZero ? "水下偏多" : "零轴附近偏多";
    label = "偏多，红柱扩大";
  } else if (latestDif > latestDea && hist > 0) {
    state = "weakBull";
    pattern = aboveZero ? "水上偏多" : underZero ? "水下偏多" : "零轴附近偏多";
    label = "偏多，但动能放缓";
  } else if (latestDif < latestDea && hist < 0 && hist <= prevHist) {
    state = "bear";
    pattern = aboveZero ? "水上偏空" : underZero ? "水下偏空" : "零轴附近偏空";
    label = "偏空，绿柱扩大";
  } else if (latestDif < latestDea && hist < 0) {
    state = "weakBear";
    pattern = aboveZero ? "水上偏空" : underZero ? "水下偏空" : "零轴附近偏空";
    label = "偏空，但空头放缓";
  }

  const zone = underZero ? "0轴下方" : aboveZero ? "0轴上方" : nearZero ? "零轴附近" : "零轴附近";
  return {
    ready: true,
    state,
    pattern,
    zone,
    text: `${pattern}，${label}；DIF ${latestValid(latestDif, 3)} / DEA ${latestValid(latestDea, 3)} / 差值 ${latestValid(lineGap, 3)} / 柱 ${latestValid(hist, 3)}，${zone}${nearGolden || nearDeath ? `，交叉接近度 ${(crossProximity * 100).toFixed(0)}%` : ""}`,
  };
}

function calcMACDSeries(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const closes = rows.map((r) => r.close);
  const ema12 = emaFromValues(closes, 12);
  const ema26 = emaFromValues(closes, 26);
  const dif = closes.map((_, i) => (Number.isFinite(ema12[i]) && Number.isFinite(ema26[i]) ? ema12[i] - ema26[i] : null));
  const dea = emaFromValues(dif, 9);
  return rows.map((r, i) => {
    const d = dif[i];
    const e = dea[i];
    const hist = Number.isFinite(d) && Number.isFinite(e) ? 2 * (d - e) : null;
    return { date: r.date, dif: d, dea: e, hist };
  });
}

function calcRSIState(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) return { ready: false, text: "样本不足", state: "neutral" };
  let gain = 0;
  let loss = 0;
  for (let i = rows.length - period; i < rows.length; i += 1) {
    const diff = rows[i].close - rows[i - 1].close;
    if (diff > 0) gain += diff;
    else loss += Math.abs(diff);
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  let state = "neutral";
  let label = "中性";
  if (rsi >= 75) {
    state = "overbought";
    label = "高位过热";
  } else if (rsi >= 60) {
    state = "strong";
    label = "强势区";
  } else if (rsi <= 30) {
    state = "oversold";
    label = "低位超跌";
  } else if (rsi <= 40) {
    state = "weak";
    label = "弱势区";
  }
  return { ready: true, state, label, value: rsi, text: `RSI14 ${latestValid(rsi, 1)}，${label}` };
}

// 单日成交均价。有成交额时用 成交额 ÷ 成交量（各数据源成交量单位有股/手之分，用当日高低价校准），
// 否则退化为典型价 (高+低+收)/3。
function dailyAvgPrice(row) {
  const vol = Number(row.volume);
  const amount = Number(row.amount);
  if (Number.isFinite(amount) && amount > 0 && Number.isFinite(vol) && vol > 0) {
    for (const scale of [1, 0.01]) {
      const price = (amount / vol) * scale;
      if (price >= row.low * 0.99 && price <= row.high * 1.01) return price;
    }
  }
  return (row.high + row.low + row.close) / 3;
}

// VWAP：成交量加权平均价，近似窗口内买方的平均成本。日线无分笔数据，按「单日均价 × 当日成交量」加权。
function calcVWAPState(rows, days = 20) {
  if (!Array.isArray(rows) || rows.length === 0) return { ready: false, state: "neutral" };
  const recent = rows.slice(-days);
  let weighted = 0;
  let totalVol = 0;
  for (const r of recent) {
    const vol = Number(r.volume);
    if (!Number.isFinite(vol) || vol <= 0) continue;
    if (![r.high, r.low, r.close].every(Number.isFinite)) continue;
    weighted += dailyAvgPrice(r) * vol;
    totalVol += vol;
  }
  if (totalVol <= 0 || !Number.isFinite(weighted)) return { ready: false, state: "neutral" };
  const vwap = weighted / totalVol;
  const close = Number(rows[rows.length - 1]?.close);
  const premium = Number.isFinite(close) && vwap > 0 ? (close / vwap - 1) * 100 : null;
  let state = "neutral";
  let label = "贴近成本";
  if (Number.isFinite(premium)) {
    if (premium >= 10) {
      state = "hot";
      label = "明显溢价";
    } else if (premium >= 2) {
      state = "above";
      label = "站上成本";
    } else if (premium <= -10) {
      state = "cold";
      label = "明显折价";
    } else if (premium <= -2) {
      state = "below";
      label = "跌破成本";
    }
  }
  return { ready: true, state, label, value: vwap, premium, days: recent.length };
}

function calcKDJState(rows, period = 9) {
  if (!Array.isArray(rows) || rows.length < period + 2) return { ready: false, text: "样本不足", state: "neutral" };

  let k = 50;
  let d = 50;
  let prevK = 50;
  let prevD = 50;

  for (let i = period - 1; i < rows.length; i += 1) {
    const windowRows = rows.slice(i - period + 1, i + 1);
    const highN = Math.max(...windowRows.map((r) => r.high));
    const lowN = Math.min(...windowRows.map((r) => r.low));
    const close = rows[i].close;
    const rsv = highN === lowN ? 50 : ((close - lowN) / (highN - lowN)) * 100;
    prevK = k;
    prevD = d;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }

  const j = 3 * k - 2 * d;
  const goldenCross = prevK <= prevD && k > d;
  const deathCross = prevK >= prevD && k < d;

  let state = "neutral";
  let label = "中性";
  if (goldenCross && k < 80) {
    state = "golden";
    label = "金叉，短线偏多";
  } else if (deathCross && k > 20) {
    state = "death";
    label = "死叉，短线偏空";
  } else if (k >= 80 && d >= 80) {
    state = "overbought";
    label = "高位过热";
  } else if (k <= 20 && d <= 20) {
    state = "oversold";
    label = "低位超跌";
  } else if (k > d && j > k) {
    state = "bull";
    label = "K>D，动能偏多";
  } else if (k < d && j < k) {
    state = "bear";
    label = "K<D，动能偏空";
  }

  return {
    ready: true,
    state,
    k,
    d,
    j,
    text: `KDJ9 ${label}，K ${latestValid(k, 1)} / D ${latestValid(d, 1)} / J ${latestValid(j, 1)}`,
  };
}

function calcBollState(rows, period = 20) {
  if (!Array.isArray(rows) || rows.length < period) return { ready: false, text: "样本不足", state: "middle" };
  const slice = rows.slice(-period);
  const ma = slice.reduce((a, r) => a + r.close, 0) / period;
  const variance = slice.reduce((a, r) => a + Math.pow(r.close - ma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = ma + 2 * std;
  const lower = ma - 2 * std;
  const close = rows[rows.length - 1].close;
  const width = ma === 0 ? 0 : (upper - lower) / ma;
  let state;
  let label;
  if (close > upper) {
    state = "aboveUpper";
    label = "突破上轨，短线偏强但可能过热";
  } else if (close < lower) {
    state = "belowLower";
    label = "跌破下轨，短线超跌";
  } else if (close > ma) {
    state = "upperHalf";
    label = "位于中轨上方";
  } else {
    state = "lowerHalf";
    label = "位于中轨下方";
  }
  return { ready: true, state, width, text: `BOLL20 ${label}；上轨 ${latestValid(upper)} / 中轨 ${latestValid(ma)} / 下轨 ${latestValid(lower)}` };
}

function calcATRState(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) return { ready: false, text: "样本不足", state: "normal" };
  const trs = [];
  for (let i = rows.length - period; i < rows.length; i += 1) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const close = rows[rows.length - 1].close;
  const atrPct = close === 0 ? 0 : atr / close;
  let state = "normal";
  let label = "正常波动";
  if (atrPct >= 0.06) {
    state = "high";
    label = "高波动，风险较高";
  } else if (atrPct <= 0.02) {
    state = "low";
    label = "低波动，可能蓄势";
  }
  return { ready: true, state, atr, atrPct, text: `ATR14 ${latestValid(atr)}，约 ${percentText(atrPct)}，${label}` };
}

function calcVolumePriceState(rows) {
  if (!Array.isArray(rows) || rows.length < 25) return { ready: false, text: "样本不足", state: "neutral" };
  const latest = rows[rows.length - 1];
  const close5Ago = rows[rows.length - 6]?.close;
  const avgVol5 = rows.slice(-5).reduce((a, r) => a + r.volume, 0) / 5;
  const avgVol20 = rows.slice(-20).reduce((a, r) => a + r.volume, 0) / 20;
  const priceChange5 = Number.isFinite(close5Ago) && close5Ago !== 0 ? latest.close / close5Ago - 1 : 0;
  const volRatio = avgVol20 === 0 ? 1 : avgVol5 / avgVol20;
  let state = "neutral";
  let label = "量价中性";
  if (priceChange5 > 0.03 && volRatio >= 1.2) {
    state = "confirmUp";
    label = "上涨放量，趋势确认度较高";
  } else if (priceChange5 > 0.03 && volRatio < 0.9) {
    state = "weakUp";
    label = "上涨缩量，需警惕量价背离";
  } else if (priceChange5 < -0.03 && volRatio >= 1.2) {
    state = "confirmDown";
    label = "下跌放量，抛压偏强";
  } else if (priceChange5 < -0.03 && volRatio < 0.9) {
    state = "weakDown";
    label = "下跌缩量，抛压可能减弱";
  }
  return { ready: true, state, text: `${label}；近5日涨跌 ${percentText(priceChange5)}，量能比 ${latestValid(volRatio, 2)}` };
}

function buildTrendPrediction(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 90) {
    return {
      ready: false,
      message: "历史数据不足，暂时无法生成趋势预测面板。",
    };
  }

  const latestIndex = rawRows.length - 1;
  const latest = rawRows[latestIndex];
  const ma5 = calcMAValue(rawRows, latestIndex, 5);
  const ma10 = calcMAValue(rawRows, latestIndex, 10);
  const ma20 = calcMAValue(rawRows, latestIndex, 20);
  const ma60 = calcMAValue(rawRows, latestIndex, 60);
  const rowsWithTD = calcSimpleTD9(rawRows);
  const td = getTDStateAt(rowsWithTD, latestIndex);
  const trendKey = classifyTrendForIndex(rawRows, latestIndex);
  const macd = calcMACDState(rawRows);
  const rsi = calcRSIState(rawRows);
  const kdj = calcKDJState(rawRows);
  const boll = calcBollState(rawRows);
  const atr = calcATRState(rawRows);
  const volumePrice = calcVolumePriceState(rawRows);

  const gaps = calcGaps(rawRows);
  const unfilled = gaps.filter((g) => !g.filled);
  const latestGap = unfilled[unfilled.length - 1];

  let score = 50;
  if (latest.close > ma20) score += 12;
  else score -= 12;
  if (ma5 > ma10 && ma10 > ma20) score += 18;
  if (ma5 < ma10 && ma10 < ma20) score -= 18;
  if (ma20 > ma60) score += 12;
  else score -= 8;
  if (td.direction === "down" && td.count >= 6) score += 8;
  if (td.direction === "up" && td.count >= 6) score -= 8;
  if (latestGap?.type === "up") score += 8;
  if (latestGap?.type === "down") score -= 8;
  if (latest.pct > 8) score -= 6;
  if (latest.pct < -8) score += 4;
  if (macd.state === "bull") score += 8;
  if (macd.state === "bear") score -= 8;
  if (rsi.state === "strong") score += 4;
  if (rsi.state === "overbought") score -= 6;
  if (rsi.state === "oversold") score += 6;
  if (kdj.state === "golden" || kdj.state === "bull") score += 4;
  if (kdj.state === "death" || kdj.state === "bear") score -= 4;
  if (kdj.state === "overbought") score -= 3;
  if (kdj.state === "oversold") score += 3;
  if (boll.state === "upperHalf") score += 4;
  if (boll.state === "aboveUpper") score -= 3;
  if (boll.state === "belowLower") score += 4;
  if (volumePrice.state === "confirmUp") score += 7;
  if (volumePrice.state === "weakUp") score -= 5;
  if (volumePrice.state === "confirmDown") score -= 7;
  if (volumePrice.state === "weakDown") score += 3;
  if (atr.state === "high") score -= 4;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let label = "中性震荡";
  if (score >= 70) label = "偏强";
  else if (score >= 56) label = "略偏强";
  else if (score <= 30) label = "偏弱";
  else if (score <= 44) label = "略偏弱";

  const stats5 = futureStatsBySimilarState(rawRows, 5, trendKey, td);
  const stats10 = futureStatsBySimilarState(rawRows, 10, trendKey, td);
  const stats20 = futureStatsBySimilarState(rawRows, 20, trendKey, td);

  const notes = [];
  if (latest.close > ma20) notes.push("收盘价站上 MA20");
  else notes.push("收盘价低于 MA20");
  if (ma5 > ma10 && ma10 > ma20) notes.push("短中期均线偏多头");
  if (td.direction === "up" && td.count >= 6) notes.push("上涨九转后段，短线注意过热");
  if (td.direction === "down" && td.count >= 6) notes.push("下跌九转后段，关注反弹概率");
  if (latestGap) notes.push(`${latestGap.label}未回补`);
  if (macd.ready) notes.push(`MACD ${macd.text}`);
  if (rsi.ready) notes.push(rsi.text);
  if (kdj.ready) notes.push(kdj.text);
  if (volumePrice.ready) notes.push(volumePrice.text);

  return {
    ready: true,
    label,
    score,
    tdText: td.text,
    gapText: latestGap ? `${latestGap.label}未回补：${latestGap.bottom.toFixed(2)}-${latestGap.top.toFixed(2)}` : "暂无未回补断层",
    maText: `MA5 ${latestValid(ma5)} / MA10 ${latestValid(ma10)} / MA20 ${latestValid(ma20)} / MA60 ${latestValid(ma60)}`,
    macdText: macd.text,
    rsiText: rsi.text,
    kdjText: kdj.text,
    bollText: boll.text,
    atrText: atr.text,
    volumePriceText: volumePrice.text,
    stats5,
    stats10,
    stats20,
    notes,
  };
}

function popoverLeft(element, width) {
  const left = element?.getBoundingClientRect().left || 0;
  return Math.min(0, window.innerWidth - 16 - left - Math.min(width, window.innerWidth - 32));
}

function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  const [popupLeft, setPopupLeft] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const handleResize = () => setPopupLeft(popoverLeft(ref.current, 256));
    window.addEventListener("resize", handleResize);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPopupLeft(popoverLeft(ref.current, 256));
          setOpen((v) => !v);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-100"
        title="查看计算逻辑"
      >
        <Info className="h-3 w-3" />
      </button>
      {open && (
        <span style={{ left: popupLeft }} className="absolute top-5 z-30 w-64 max-w-[calc(100vw-2rem)] whitespace-pre-line rounded-xl border bg-white p-3 text-xs leading-relaxed text-slate-600 shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}

// 近期换手率走势小图：腾讯日K不返回单日换手率，这里用 当日成交量 / 最新成交量 × 当前换手率
// 反推（短期内流通股本近似不变），故最后一个点恰好等于面板显示的换手率。
function TurnoverSparkline({ rows, currentRate, days = 30 }) {
  const [open, setOpen] = useState(false);
  const [popupLeft, setPopupLeft] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(null);
  const ref = useRef(null);
  const svgRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const handleResize = () => setPopupLeft(popoverLeft(ref.current, 240));
    window.addEventListener("resize", handleResize);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  const series = useMemo(() => {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const recent = rows.slice(-days);
    const latestVol = Number(rows[rows.length - 1]?.volume);
    const calibratable =
      Number.isFinite(currentRate) && currentRate > 0 && Number.isFinite(latestVol) && latestVol > 0;
    return recent
      .map((r) => {
        let value = null;
        if (Number.isFinite(r.turnover) && r.turnover > 0) value = r.turnover;
        else if (calibratable && Number.isFinite(r.volume)) value = (r.volume / latestVol) * currentRate;
        return value == null ? null : { date: r.date, value };
      })
      .filter(Boolean);
  }, [rows, currentRate, days]);

  const W = 200;
  const H = 56;
  const PAD = 5;
  const hasSeries = series.length >= 2;
  const values = series.map((d) => d.value);
  const min = hasSeries ? Math.min(...values) : 0;
  const max = hasSeries ? Math.max(...values) : 0;
  const span = max - min || 1;
  const stepX = hasSeries ? (W - PAD * 2) / (series.length - 1) : 0;
  const points = series.map((d, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (H - PAD * 2) * (1 - (d.value - min) / span);
    return [x, y];
  });
  const polyline = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const activeIdx = hasSeries ? (hoverIdx == null ? series.length - 1 : Math.min(hoverIdx, series.length - 1)) : 0;
  const active = hasSeries ? series[activeIdx] : null;
  const activePt = hasSeries ? points[activeIdx] : null;

  const handleMove = (e) => {
    if (!hasSeries || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round((svgX - PAD) / stepX);
    setHoverIdx(Math.max(0, Math.min(series.length - 1, idx)));
  };

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setHoverIdx(null);
          setPopupLeft(popoverLeft(ref.current, 240));
          setOpen((v) => !v);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-100"
        title="近期换手率走势"
      >
        <Activity className="h-3 w-3" />
      </button>
      {open && (
        <span style={{ left: popupLeft }} className="absolute top-5 z-30 w-60 max-w-[calc(100vw-2rem)] rounded-xl border bg-white p-3 shadow-lg">
          {hasSeries ? (
            <>
              <span className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-slate-500">{hoverIdx == null ? `近${series.length}日换手率` : active.date}</span>
                <span className="font-medium text-slate-700">{active.value.toFixed(2)}%</span>
              </span>
              <svg
                ref={svgRef}
                width={W}
                height={H}
                viewBox={`0 0 ${W} ${H}`}
                className="block"
                onMouseMove={handleMove}
                onMouseLeave={() => setHoverIdx(null)}
              >
                <polyline
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={polyline}
                />
                <line
                  x1={activePt[0]}
                  y1={PAD}
                  x2={activePt[0]}
                  y2={H - PAD}
                  stroke="var(--chart-grid)"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
                <circle cx={activePt[0]} cy={activePt[1]} r="2.5" fill="#2563eb" />
              </svg>
              <span className="mt-1 flex justify-between text-[11px] text-slate-400">
                <span>低 {min.toFixed(2)}%</span>
                <span>高 {max.toFixed(2)}%</span>
              </span>
            </>
          ) : (
            <span className="block text-[11px] leading-5 text-slate-500">
              当前仅取得 {series.length} 个交易日的换手率数据，至少需要 2 日才能绘制趋势线。
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function ProbabilityLine({ label, stat, info }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2 text-xs">
      <div className="flex justify-between gap-2">
        <span className="inline-flex items-center">
          {label}
          <InfoTip text={info} />
        </span>
        <span>{stat ? `样本 ${stat.sample}` : "样本不足"}</span>
      </div>
      <div className="mt-1 text-slate-500">
        上涨概率 {stat ? percentText(stat.probability) : "-"} / 平均收益 {stat ? percentText(stat.avgReturn) : "-"}
      </div>
    </div>
  );
}

function CollapsibleDetailBlock({ title = "查看明细", defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-medium text-slate-500 transition hover:text-slate-700"
        aria-expanded={open}
      >
        <span>{title}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

function TrendPredictionPanel({ prediction }) {
  if (!prediction?.ready) {
    return (
      <div className="mt-5 border-t pt-4">
        <div className="mb-2 flex items-center text-sm font-semibold text-slate-700">
          趋势预测面板
          <InfoTip text="趋势预测面板基于历史 K 线、均线、九转、断层和相似状态回测生成。它只是概率统计，不是确定性预测，也不构成投资建议。" />
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">{prediction?.message || "暂无数据"}</div>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t pt-4">
      <div className="mb-2 flex items-center text-sm font-semibold text-slate-700">
        趋势预测面板
        <InfoTip text="面板由规则评分和历史相似状态统计组成：先计算趋势分，再统计历史上类似趋势/九转状态后未来 5/10/20 日的表现。" />
      </div>
      <div className="rounded-2xl bg-slate-50 p-3">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center text-sm text-slate-500">
            综合判断
            <InfoTip text="综合判断来自趋势分：初始 50 分；收盘价高于/低于 MA20、均线多空排列、MA20 与 MA60 关系、当前九转阶段、未回补断层方向、当日涨跌幅过大等因素共同加减分。分数越高表示历史规则下偏强，越低表示偏弱。" />
          </span>
          <span
            className={
              prediction.score >= 56
                ? "font-semibold text-red-600"
                : prediction.score <= 44
                  ? "font-semibold text-green-700"
                  : "font-semibold text-slate-700"
            }
          >
            {prediction.label}
          </span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-200">
          <div className="h-2 rounded-full bg-slate-700" style={{ width: `${prediction.score}%` }} />
        </div>
        <div className="mt-1 text-right text-xs text-slate-500">趋势分 {prediction.score}/100</div>
      </div>

      <CollapsibleDetailBlock title="查看趋势明细">
        <div className="space-y-2 text-xs">
          <div className="flex justify-between rounded-xl bg-slate-50 p-2">
            <span className="inline-flex items-center">
              当前九转
              <InfoTip text="九转方向按当前收盘价与 4 根 K 线前收盘价比较：close[i] > close[i-4] 记为上涨九转计数；close[i] < close[i-4] 记为下跌九转计数。这里显示当前正在形成或已经确认的计数。" />
            </span>
            <span>{prediction.tdText}</span>
          </div>
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="inline-flex items-center">
              均线结构
              <InfoTip text="均线使用收盘价简单移动平均：MA5/MA10/MA20/MA60。若短期均线在中长期均线上方，且价格站上 MA20，会给趋势评分加分；反之会扣分。" />
            </div>
            <div className="mt-1 text-slate-500">{prediction.maText}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="inline-flex items-center">
              断层状态
              <InfoTip text="断层按相邻 K 线判断：向上断层为当日最低价高于前一根最高价；向下断层为当日最高价低于前一根最低价。若后续价格完全回到缺口边界，则视为已回补；未回补向上断层偏强，未回补向下断层偏弱。" />
            </div>
            <div className="mt-1 text-slate-500">{prediction.gapText}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="inline-flex items-center">
              量价关系
              <InfoTip text="量价关系比较近 5 日价格涨跌与近 5 日/20 日平均成交量。上涨放量偏确认趋势，上涨缩量可能是量价背离；下跌放量说明抛压偏强，下跌缩量说明抛压可能减弱。" />
            </div>
            <div className="mt-1 text-slate-500">{prediction.volumePriceText}</div>
          </div>
          <ProbabilityLine
            label="未来5日历史上涨概率"
            stat={prediction.stats5}
            info="计算历史上与当前状态相似的样本：趋势分类相同、九转方向相同、九转阶段桶相同（早期 1-5、后期 6-9、或无九转），然后统计这些样本 5 个交易日后收盘价高于当前收盘价的比例，以及平均收益。"
          />
          <ProbabilityLine
            label="未来10日历史上涨概率"
            stat={prediction.stats10}
            info="计算逻辑同未来 5 日，但观察窗口改为 10 个交易日后。上涨概率=历史相似样本中 10 日后收益为正的比例；平均收益=这些样本的 10 日收益均值。"
          />
          <ProbabilityLine
            label="未来20日历史上涨概率"
            stat={prediction.stats20}
            info="计算逻辑同未来 5/10 日，但观察窗口改为 20 个交易日后。该指标更偏中短期，不适合解释为短线明日涨跌预测。"
          />
          <div className="rounded-xl bg-slate-50 p-2">
            <div className="inline-flex items-center">
              提示
              <InfoTip text="提示文字是对主要加减分原因的摘要，例如是否站上 MA20、均线是否偏多、九转是否进入后段、是否存在未回补断层。它用于解释趋势分来源。" />
            </div>
            <div className="mt-1 text-slate-500">{prediction.notes.slice(0, 3).join("；")}</div>
          </div>
        </div>
      </CollapsibleDetailBlock>
    </div>
  );
}

function FinancialReportPanel({ financialInfo, loading, error, market, embedded = false }) {
  if (market !== "ashare") {
    return (
      <div className={embedded ? "min-w-0" : "mt-4 rounded-2xl border bg-white p-4"}>
        <div className="mb-2 flex items-center text-sm font-semibold text-slate-700">
          财报信息
          <InfoTip text="当前只接入 A 股财报摘要。后续如果需要，可以再扩展到美股或 Agent 统一财务数据层。" />
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">当前市场暂未接入财报摘要。</div>
      </div>
    );
  }

  const reports = Array.isArray(financialInfo?.reports) ? [...financialInfo.reports].slice(0, 3).reverse() : [];
  const metricRows = [
    { label: "收入", key: "revenue", formatter: formatMillionValue },
    { label: "收入增速", key: "revenueGrowth", formatter: formatPercentValue, trend: true },
    { label: "归母净利润", key: "parentNetProfit", formatter: formatMillionValue },
    { label: "归母净利润增速", key: "parentNetProfitGrowth", formatter: formatPercentValue, trend: true },
    { label: "毛利率", key: "grossMargin", formatter: formatPercentValue },
    { label: "净利率", key: "netMargin", formatter: formatPercentValue },
  ];

  return (
    <div className={embedded ? "min-w-0" : "mt-4 rounded-2xl border bg-white p-4"}>
      <div className="mb-3 flex items-center text-base font-semibold text-slate-700">
        财报信息
        <InfoTip text="数据来自东方财富 F10 财务分析页的主要指标接口。这里展示最近报告期的营业收入、收入增速、归母净利润、归母净利润增速、毛利率和净利率，金额统一换算为百万。" />
      </div>
      {loading ? (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">财报数据加载中</div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{error}</div>
      ) : reports.length ? (
        <div className="rounded-2xl bg-slate-50 p-3">
          <div className="mb-3 px-1 text-xs text-slate-500">始终展示最近 3 期，按时间从旧到新排列。</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="w-[160px] px-3 py-2 font-medium">指标</th>
                  {reports.map((report, index) => (
                    <th key={`${report.reportDate}-${index}`} className="px-3 py-2 font-medium">
                      {report.reportName || "-"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metricRows.map((row) => (
                  <tr key={row.key} className="border-b last:border-b-0">
                    <td className="px-3 py-3 text-slate-700">{row.label}</td>
                    {reports.map((report, index) => {
                      const rawValue = report[row.key];
                      const formattedValue = row.formatter(rawValue);
                      const colorClass = row.trend
                        ? Number(rawValue) >= 0
                          ? "text-red-600"
                          : "text-green-700"
                        : "text-slate-800";
                      return (
                        <td key={`${report.reportDate}-${row.key}-${index}`} className={`px-3 py-3 font-semibold ${colorClass}`}>
                          {formattedValue}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">暂无财报数据。</div>
      )}
    </div>
  );
}

function FundFlowTrendChart({ rows, isDdxFallback }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const svgRef = useRef(null);
  const series = (Array.isArray(rows) ? rows : [])
    .slice(-30)
    .map((row) => ({
      date: row.date,
      value: Number.isFinite(row.retailIndex)
        ? row.retailIndex
        : Number.isFinite(row.dde?.retailCount)
          ? row.dde.retailCount
          : isDdxFallback
            ? null
            : row.smallNetRatio,
      exact: Number.isFinite(row.retailIndex) || Number.isFinite(row.dde?.retailCount),
    }))
    .filter((row) => row.date && Number.isFinite(row.value));

  if (series.length < 2) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
        <div className="text-xs font-medium text-slate-600">散户数量趋势</div>
        <div className="mt-2 text-[11px] leading-5 text-slate-400">
          {isDdxFallback
            ? "备用源没有返回可比的散户数量序列。"
            : `当前仅取得 ${series.length} 个交易日的数据，至少需要 2 日才能绘制柱状图。`}
        </div>
      </div>
    );
  }

  const width = 760;
  const height = 230;
  const margin = { top: 18, right: 48, bottom: 32, left: 18 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rawMax = Math.max(...series.map((row) => Math.abs(row.value)), 0.1);
  const scaleMagnitude = 10 ** Math.floor(Math.log10(rawMax));
  const maxAbs = Math.ceil(rawMax / scaleMagnitude) * scaleMagnitude;
  const bandWidth = plotWidth / series.length;
  const barWidth = Math.max(3, Math.min(18, bandWidth * 0.62));
  const xAt = (index) => margin.left + bandWidth * (index + 0.5);
  const yAt = (value) => margin.top + ((maxAbs - value) / (maxAbs * 2)) * plotHeight;
  const zeroY = yAt(0);
  const activeIndex = hoverIndex == null ? series.length - 1 : Math.min(hoverIndex, series.length - 1);
  const active = series[activeIndex];
  const hasExactDde = series.every((row) => row.exact);
  const metricLabel = hasExactDde ? "DDE 散户指数" : "小单净占比（散户代理）";
  const unit = hasExactDde ? "" : "%";

  function handlePointerMove(event) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
    const index = Math.floor((svgX - margin.left) / bandWidth);
    setHoverIndex(Math.max(0, Math.min(series.length - 1, index)));
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">散户数量趋势</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{active.date}</div>
        </div>
        <div className="text-right">
          <div className={`text-base font-semibold ${fundFlowColor(active.value)}`}>
            {metricLabel}：{active.value.toFixed(2)}{unit}
          </div>
          <div className="mt-1 flex items-center justify-end gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-red-500" />
              流入
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-green-600" />
              流出
            </span>
          </div>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full touch-none"
        role="img"
        aria-label={`${metricLabel}近${series.length}个交易日柱状图`}
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHoverIndex(null)}
        onTouchMove={(event) => {
          const touch = event.touches?.[0];
          if (touch) handlePointerMove(touch);
        }}
      >
        {[maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs].map((value) => {
          const y = yAt(value);
          return (
            <g key={value}>
              <line
                x1={margin.left}
                y1={y}
                x2={width - margin.right}
                y2={y}
                stroke={value === 0 ? "var(--chart-muted)" : "var(--chart-grid)"}
                strokeWidth={value === 0 ? 1.2 : 1}
              />
              <text x={width - margin.right + 7} y={y + 4} textAnchor="start" fontSize="10" fill="var(--chart-muted)">
                {value.toFixed(1)}{unit}
              </text>
            </g>
          );
        })}
        {series.map((row, index) => {
          const valueY = yAt(row.value);
          const top = Math.min(valueY, zeroY);
          const barHeight = Math.max(1.5, Math.abs(valueY - zeroY));
          return (
            <rect
              key={row.date}
              x={xAt(index) - barWidth / 2}
              y={top}
              width={barWidth}
              height={barHeight}
              rx="1.5"
              fill={row.value >= 0 ? "#ef4444" : "#16a34a"}
              opacity={hoverIndex == null || index === activeIndex ? 0.95 : 0.55}
            >
              <title>{`${row.date} · ${row.value.toFixed(2)}${unit}`}</title>
            </rect>
          );
        })}
        <line
          x1={xAt(activeIndex)}
          y1={margin.top}
          x2={xAt(activeIndex)}
          y2={margin.top + plotHeight}
          stroke="var(--chart-muted)"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.65"
        />
        <text x={margin.left} y={height - 7} textAnchor="start" fontSize="10" fill="var(--chart-muted)">
          {series[0].date.slice(5)}
        </text>
        <text x={margin.left + plotWidth / 2} y={height - 7} textAnchor="middle" fontSize="10" fill="var(--chart-muted)">
          {series[Math.floor(series.length / 2)].date.slice(5)}
        </text>
        <text x={width - margin.right} y={height - 7} textAnchor="end" fontSize="10" fill="var(--chart-muted)">
          {series.at(-1).date.slice(5)}
        </text>
        <title>
          {`${active.date} · ${metricLabel} ${active.value.toFixed(2)}${unit}`}
        </title>
      </svg>
      <div className="mt-1 text-[11px] text-slate-400">
        {hasExactDde
          ? "负值表示散户参与度下降、筹码可能向大资金集中；该指标不代表真实账户人数变化。"
          : "红柱表示小单净流入，绿柱表示小单净流出；当前为免费资金流代理，并非同花顺 DDE 原值。"}
      </div>
    </div>
  );
}

function FundFlowPanel({ fundFlowInfo, loading, error, market, embedded = false }) {
  if (market !== "ashare") return null;

  const rows = Array.isArray(fundFlowInfo?.rows) ? fundFlowInfo.rows.slice(-10).reverse() : [];
  const latest = fundFlowInfo?.latest || rows[0] || null;
  const fiveDay = fundFlowInfo?.summary?.fiveDay;
  const isDdxFallback = fundFlowInfo?.source?.key === "stockddx";
  const trendLabel = {
    inflow: "小单净流入",
    outflow: "小单净流出",
    flat: "小单流向平衡",
  }[fundFlowInfo?.summary?.retailTrend] || "暂无判断";

  return (
    <div className={embedded ? "min-w-0" : "rounded-2xl border bg-white p-4"}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center text-base font-semibold text-slate-700">
          资金动向
          <InfoTip text="主数据按 AKShare stock_individual_fund_flow 的东方财富资金流口径获取。小单资金流只能作为散户资金倾向的代理指标，不等于真实散户账户数量。主数据失败时会尝试 DDX 查询网备用源。" />
        </div>
        {fundFlowInfo?.source ? (
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className={`rounded-full px-2 py-1 ${fundFlowInfo.fallbackUsed ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>
              {fundFlowInfo.source.name}
            </span>
            {fundFlowInfo.stale ? <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-500">缓存</span> : null}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">资金动向加载中</div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{error}</div>
      ) : !latest ? (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">暂无资金动向数据。</div>
      ) : (
        <>
          {fundFlowInfo?.warning ? (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              {fundFlowInfo.warning}
            </div>
          ) : null}

          {isDdxFallback ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["DDX", latest.dde?.ddx],
                ["DDY", latest.dde?.ddy],
                ["DDZ", latest.dde?.ddz],
                ["BBD", latest.dde?.bbd],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-slate-50 p-3">
                  <div className="text-xs text-slate-500">{label}</div>
                  <div className={`mt-1 font-semibold ${fundFlowColor(value)}`}>
                    {Number.isFinite(value) ? value.toFixed(2) : "-"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">近 5 日散户代理</div>
                <div className={`mt-1 text-sm font-semibold ${fundFlowColor(fiveDay?.smallNetAmount)}`}>{trendLabel}</div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">5 日小单净额</div>
                <div className={`mt-1 font-semibold ${fundFlowColor(fiveDay?.smallNetAmount)}`}>
                  {formatFundFlowAmount(fiveDay?.smallNetAmount)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">5 日主力净额</div>
                <div className={`mt-1 font-semibold ${fundFlowColor(fiveDay?.mainNetAmount)}`}>
                  {formatFundFlowAmount(fiveDay?.mainNetAmount)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">最新小单占比</div>
                <div className={`mt-1 font-semibold ${fundFlowColor(latest.smallNetRatio)}`}>
                  {formatPercentValue(latest.smallNetRatio)}
                </div>
              </div>
            </div>
          )}

          <FundFlowTrendChart rows={fundFlowInfo.rows} isDdxFallback={isDdxFallback} />

          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[600px] text-xs">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">日期</th>
                  {isDdxFallback ? (
                    <>
                      <th className="px-3 py-2 text-right font-medium">DDX</th>
                      <th className="px-3 py-2 text-right font-medium">DDY</th>
                      <th className="px-3 py-2 text-right font-medium">DDZ</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-right font-medium">主力净额</th>
                      <th className="px-3 py-2 text-right font-medium">大单净额</th>
                      <th className="px-3 py-2 text-right font-medium">小单净额</th>
                      <th className="px-3 py-2 text-right font-medium">小单占比</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.date} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">{row.date}</td>
                    {isDdxFallback ? (
                      <>
                        {[row.dde?.ddx, row.dde?.ddy, row.dde?.ddz].map((value, index) => (
                          <td key={index} className={`px-3 py-2 text-right font-medium ${fundFlowColor(value)}`}>
                            {Number.isFinite(value) ? value.toFixed(2) : "-"}
                          </td>
                        ))}
                      </>
                    ) : (
                      <>
                        {[row.mainNetAmount, row.largeNetAmount, row.smallNetAmount].map((value, index) => (
                          <td key={index} className={`px-3 py-2 text-right font-medium ${fundFlowColor(value)}`}>
                            {formatFundFlowAmount(value)}
                          </td>
                        ))}
                        <td className={`px-3 py-2 text-right font-medium ${fundFlowColor(row.smallNetRatio)}`}>
                          {formatPercentValue(row.smallNetRatio)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 text-[11px] leading-5 text-slate-400">
            {fundFlowInfo.proxyDescription}
          </div>
        </>
      )}
    </div>
  );
}

function normalizeCollapsedText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text;
}

function ExpandableText({ value, maxLength = 90, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const text = normalizeCollapsedText(value);

  if (!text) return null;

  const collapsible = text.length > maxLength;
  const displayText = collapsible && !expanded ? `${text.slice(0, maxLength)}...` : text;

  return (
    <div className={className}>
      <div>{displayText}</div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-[11px] font-medium text-slate-500 transition hover:text-slate-800"
        >
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </div>
  );
}

function AshareProfileSection({ title, loading, error, children, info }) {
  return (
    <div className="mt-4 rounded-xl bg-slate-50 p-3">
      <div className="mb-2 inline-flex items-center text-sm font-semibold text-slate-700">
        {title}
        {info ? <InfoTip text={info} /> : null}
      </div>
      {loading ? (
        <div className="text-xs text-slate-500">加载中</div>
      ) : error ? (
        <div className="text-xs text-amber-700">{error}</div>
      ) : (
        children
      )}
    </div>
  );
}

function ThemeSourceBlock({ source }) {
  const concepts = Array.isArray(source?.concepts) ? source.concepts.filter(Boolean) : [];
  const supplemental = Array.isArray(source?.supplemental) ? source.supplemental.filter(Boolean) : [];
  const details = Array.isArray(source?.details) ? source.details.filter((item) => item?.name || item?.detail) : [];
  const highlights = Array.isArray(source?.highlights) ? source.highlights.filter((item) => item?.keyword || item?.title || item?.content) : [];
  const hasData = concepts.length > 0 || details.length > 0 || highlights.length > 0;

  return (
    <div className="rounded-lg bg-white px-2.5 py-2 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-800">{source?.name || "数据源"}</span>
        {source?.status === "error" ? <span className="text-[11px] text-amber-700">暂不可用</span> : null}
      </div>
      {concepts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {concepts.slice(0, 10).map((item) => (
            <span key={`${source?.key || "source"}-${item}`} className="rounded-full bg-slate-50 px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-200">
              {item}
            </span>
          ))}
        </div>
      ) : null}
      {supplemental.length > 0 ? (
        <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
          补充标签：{supplemental.slice(0, 6).join(" / ")}
        </div>
      ) : null}
      {details.length > 0 ? (
        <div className="mt-2 space-y-1.5 text-xs text-slate-600">
          {details.slice(0, 2).map((item, index) => (
            <div key={`${source?.key || "source"}-detail-${item.name || index}`} className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="font-medium text-slate-800">{item.name || `概念 ${index + 1}`}</div>
              <ExpandableText value={item.detail} maxLength={72} className="mt-1" />
            </div>
          ))}
        </div>
      ) : null}
      {highlights.length > 0 ? (
        <div className="mt-2 space-y-1.5 text-xs text-slate-600">
          {highlights.slice(0, 2).map((item, index) => (
            <div key={`${source?.key || "source"}-highlight-${item.keyword || index}`} className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="font-medium text-slate-800">
                {item.keyword || item.title || `题材 ${index + 1}`}
              </div>
              <ExpandableText value={item.content || item.title} maxLength={72} className="mt-1" />
            </div>
          ))}
        </div>
      ) : null}
      {!hasData ? (
        <div className="text-xs text-slate-500">{source?.status === "error" ? source.error || "该来源暂时无法获取。" : "暂无题材概念。"}</div>
      ) : null}
    </div>
  );
}

function buildTrendChecklist(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 80) {
    return { ready: false, summary: "历史数据不足", tradeAction: null, items: [] };
  }

  const i = rawRows.length - 1;
  const latest = rawRows[i];
  const ma5 = calcMAValue(rawRows, i, 5);
  const ma10 = calcMAValue(rawRows, i, 10);
  const ma20 = calcMAValue(rawRows, i, 20);
  const ma60 = calcMAValue(rawRows, i, 60);
  const ma20Prev = calcMAValue(rawRows, Math.max(0, i - 5), 20);
  const ma60Prev = calcMAValue(rawRows, Math.max(0, i - 5), 60);
  const maUp = ma20 > ma20Prev && ma60 > ma60Prev;
  const maBull = ma5 > ma10 && ma10 > ma20 && ma20 > ma60;

  const prev20High = Math.max(...rawRows.slice(Math.max(0, i - 20), i).map((r) => r.high));
  const prev60High = Math.max(...rawRows.slice(Math.max(0, i - 60), i).map((r) => r.high));
  const isNew20High = latest.high >= prev20High || latest.close >= prev20High;

  const macd = calcMACDState(rawRows);
  const macdBull = macd.state === "bull" || macd.state === "weakBull" || macd.state === "nearGolden";
  const kdj = calcKDJState(rawRows);
  const kdjBull = kdj.state === "golden" || kdj.state === "bull" || kdj.state === "oversold";
  const volumePrice = calcVolumePriceState(rawRows);
  const volumeSupport = volumePrice.state === "confirmUp" || volumePrice.state === "weakDown";
  const gaps = calcGaps(rawRows).filter((g) => !g.filled);
  const latestGap = gaps[gaps.length - 1];

  const items = [
    {
      key: "maSlope",
      title: "MA20 / MA60 是否向上",
      ok: maUp,
      status: maUp ? "是" : "否",
      detail: `MA20 ${latestValid(ma20)} vs 5日前 ${latestValid(ma20Prev)}；MA60 ${latestValid(ma60)} vs 5日前 ${latestValid(ma60Prev)}`,
    },
    {
      key: "maBull",
      title: "MA5 > MA10 > MA20 > MA60 是否多头排列",
      ok: maBull,
      status: maBull ? "是" : "否",
      detail: `MA5 ${latestValid(ma5)} / MA10 ${latestValid(ma10)} / MA20 ${latestValid(ma20)} / MA60 ${latestValid(ma60)}`,
    },
    {
      key: "newHigh",
      title: "价格是否持续创新高",
      ok: isNew20High,
      status: isNew20High ? "是" : "否",
      detail: `当前收盘 ${latestValid(latest.close)}；近20日前高 ${latestValid(prev20High)}；近60日前高 ${latestValid(prev60High)}`,
    },
    {
      key: "macd",
      title: "MACD 是否偏多",
      ok: macdBull,
      neutral: macd.state === "neutral",
      status: macdBull ? "是" : macd.state === "neutral" ? "中性" : "否",
      detail: macd.text,
    },
    {
      key: "kdj",
      title: "KDJ 是否偏多",
      ok: kdjBull,
      neutral: kdj.state === "neutral",
      status: kdjBull ? "是" : kdj.state === "neutral" ? "中性" : "否",
      detail: kdj.text,
    },
    {
      key: "volume",
      title: "成交量是否支持上涨",
      ok: volumeSupport,
      neutral: volumePrice.state === "neutral",
      status: volumeSupport ? "是" : volumePrice.state === "neutral" ? "中性" : "否",
      detail: volumePrice.text,
    },
    {
      key: "gap",
      title: "断层是否未回补",
      ok: latestGap?.type === "up",
      neutral: !latestGap,
      status: latestGap ? (latestGap.type === "up" ? "是" : "否") : "暂无",
      detail: latestGap ? `${latestGap.label}：${latestGap.bottom.toFixed(2)}-${latestGap.top.toFixed(2)}` : "当前历史区间内没有未回补断层。",
    },
  ];

  const positive = items.filter((item) => item.ok).length;
  const negative = items.filter((item) => !item.ok && !item.neutral).length;

  let summary = "趋势信号偏中性";
  if (positive >= 4 && negative <= 1) summary = "多数趋势条件偏强";
  else if (negative >= 4) summary = "多数趋势条件偏弱";
  else if (positive >= 3) summary = "趋势条件略偏强";
  else if (negative >= 3) summary = "趋势条件略偏弱";

  let tradeAction = {
    label: "建议继续持有",
    colorClass: "text-blue-700",
    bgClass: "bg-blue-50 border-blue-100",
    reason: "趋势条件没有明显单边倾向，适合继续观察或持有，等待更明确的方向。",
  };

  if (positive >= 4 && negative <= 1) {
    tradeAction = {
      label: "建议买入",
      colorClass: "text-red-600",
      bgClass: "bg-red-50 border-red-100",
      reason: "多数趋势条件偏强，均线、动能和量价信号更支持上涨方向。",
    };
  } else if (negative >= 4) {
    tradeAction = {
      label: "建议卖出",
      colorClass: "text-green-700",
      bgClass: "bg-green-50 border-green-100",
      reason: "多数趋势条件偏弱，趋势结构和动能信号更偏向下行风险。",
    };
  } else if (positive >= 3 && negative <= 2) {
    tradeAction = {
      label: "建议继续持有",
      colorClass: "text-blue-700",
      bgClass: "bg-blue-50 border-blue-100",
      reason: "趋势略偏强但不够一致，更适合持有观察，不宜盲目追高。",
    };
  } else if (negative >= 3) {
    tradeAction = {
      label: "建议继续持有",
      colorClass: "text-blue-700",
      bgClass: "bg-blue-50 border-blue-100",
      reason: "趋势略偏弱但未形成强卖出条件，适合降低预期并继续观察。",
    };
  }

  return { ready: true, summary, tradeAction, positive, negative, items };
}

function TradeConclusionPanel({ rawRows }) {
  const checklist = useMemo(() => buildTrendChecklist(rawRows), [rawRows]);

  if (!checklist.ready || !checklist.tradeAction) {
    return (
      <div className="rounded-2xl border bg-white p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-slate-700">交易结论</span>
          <InfoTip text="这里只保留最终交易结论，不显示上面的 AI Forecast 和趋势状态细项。" />
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-slate-500">{checklist.summary}</div>
      </div>
    );
  }

  const action = checklist.tradeAction;
  const summaryClass = checklist.summary.includes("偏强")
    ? "text-red-600"
    : checklist.summary.includes("偏弱")
      ? "text-green-700"
      : "text-slate-700";

  return (
    <div className="rounded-2xl border bg-white p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-700">交易结论</span>
        <InfoTip text="根据均线、动能、量价和断层等条件给出简化交易建议，只保留最终结果卡片。" />
      </div>
      <div className={`rounded-xl border p-3 ${action.bgClass}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600">结论</span>
          <span className={`font-bold ${action.colorClass}`}>{action.label}</span>
        </div>
        <div className={`mt-2 font-semibold ${summaryClass}`}>{checklist.summary}</div>
        <div className="mt-2 leading-relaxed text-slate-600">{action.reason}</div>
      </div>

      <CollapsibleDetailBlock title="查看结论明细">
        <div className={`rounded-xl bg-slate-50 p-2 font-semibold ${summaryClass}`}>{checklist.summary}</div>
        <div className="mt-3 space-y-1.5">
          {checklist.items.map((item) => {
            const color = item.ok ? "text-red-600" : item.neutral ? "text-slate-600" : "text-green-700";
            const badge = item.ok ? "是" : item.neutral ? item.status : "否";
            return (
              <div key={item.key} className="rounded-xl bg-slate-50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-700">{item.title}</span>
                  <span className={`shrink-0 font-semibold ${color}`}>{badge}</span>
                </div>
                <div className="mt-1 leading-relaxed text-slate-500">{item.detail}</div>
              </div>
            );
          })}
        </div>
      </CollapsibleDetailBlock>
    </div>
  );
}

// 停牌风险徽章配色（绿/黄/橙/红/已停牌），与后端 LEVEL_META.color 对应。
const SUSPENSION_RISK_STYLE = {
  green: "border-slate-200 bg-white text-slate-500",
  yellow: "border-amber-300 bg-amber-50 text-amber-700",
  orange: "border-orange-300 bg-orange-50 text-orange-700",
  red: "border-red-300 bg-red-50 text-red-700",
  rose: "border-rose-300 bg-rose-100 text-rose-700",
};

function fmtSignedPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v}%`;
}

// 个股工具栏的「停牌风险」徽章 + 点击展开的诊断面板。数据来自 /api/suspension-alert。
function SuspensionRiskBadge({ risk }) {
  const [open, setOpen] = useState(false);
  if (!risk) return null; // 非 A 股或尚未加载

  if (risk.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 停牌风险
      </span>
    );
  }
  if (risk.error || risk.unsupported) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-400"
        title={risk.error || risk.reasons?.[0] || ""}
      >
        <AlertTriangle className="h-3.5 w-3.5" /> 停牌风险 {risk.unsupported ? "N/A" : "—"}
      </span>
    );
  }

  const style = SUSPENSION_RISK_STYLE[risk.color] || SUSPENSION_RISK_STYLE.green;
  const m = risk.metrics || {};
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="停牌风险诊断"
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition hover:brightness-95 ${style}`}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        停牌风险·{risk.levelLabel}
        <ChevronDown className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭停牌风险诊断"
            className="fixed inset-0 z-30 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-40 mt-1 w-80 max-w-[calc(100vw-6rem)] rounded-xl border border-slate-200 bg-white p-3 text-left text-xs shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-semibold text-slate-800">
                停牌风险诊断 · {risk.board}
                {risk.isST ? " · ST" : ""}
              </div>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${style}`}>{risk.levelLabel}</span>
            </div>
            <ul className="space-y-1 text-slate-600">
              {(risk.reasons || []).map((r, i) => (
                <li key={i} className="leading-snug">· {r}</li>
              ))}
            </ul>
            {risk.metrics ? (
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                <div>近3日偏离：<b className="text-slate-700">{fmtSignedPct(m.dev3)}</b>（异波±{m.abnThreshold}%）</div>
                <div>同向异波：<b className="text-slate-700">{m.abnEventCount10}/{m.reqCount}次</b></div>
                <div>10日偏离：<b className="text-slate-700">{fmtSignedPct(m.dev10)}</b>（严重+{m.serious?.dev10?.up}%）</div>
                <div>30日偏离：<b className="text-slate-700">{fmtSignedPct(m.dev30)}</b>（严重+{m.serious?.dev30?.up}%）</div>
              </div>
            ) : null}
            <div className="mt-2 text-[10px] text-slate-400">
              基准：{risk.benchmark} · 截至 {risk.asOf} · 仅供参考，非投资建议
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ChartToolbar({
  drawingTool,
  onSelectDrawingTool,
  onUndoDrawing,
  onClearDrawings,
  hasDrawings,
  fullscreen,
  onToggleFullscreen,
  displayCount,
  onDisplayCountChange,
  maxDisplayCount,
  showPatterns,
  onTogglePatterns,
  suspensionRisk,
  chanOptions,
  onChanOptionsChange,
}) {
  const [drawOpen, setDrawOpen] = useState(false);
  return (
    <>
      <SuspensionRiskBadge risk={suspensionRisk} />
      <ChanControls options={chanOptions} onChange={onChanOptionsChange} />
      <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs text-slate-600">
        <button
          type="button"
          onClick={() => setDrawOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition hover:bg-slate-100 ${
            drawingTool !== "none" || hasDrawings ? "text-emerald-700" : ""
          }`}
          title={drawOpen ? "收起画线工具" : "展开画线工具"}
          aria-expanded={drawOpen}
        >
          <Pencil className="h-3.5 w-3.5" />
          画线
          <ChevronDown className={`h-3.5 w-3.5 transition ${drawOpen ? "rotate-180" : ""}`} />
        </button>
        {drawOpen && (
          <>
            <button
              type="button"
              onClick={() => onSelectDrawingTool(drawingTool === "brush" ? "none" : "brush")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition ${
                drawingTool === "brush" ? "bg-emerald-50 text-emerald-700" : "hover:bg-slate-100"
              }`}
              title={drawingTool === "brush" ? "关闭自由画笔并清空已画线" : "开启自由画笔"}
              aria-pressed={drawingTool === "brush"}
            >
              <Pencil className="h-3.5 w-3.5" />
              画笔
            </button>
            <button
              type="button"
              onClick={() => onSelectDrawingTool(drawingTool === "trend" ? "none" : "trend")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition ${
                drawingTool === "trend" ? "bg-emerald-50 text-emerald-700" : "hover:bg-slate-100"
              }`}
              title={drawingTool === "trend" ? "关闭趋势线并清空已画线" : "开启趋势线工具"}
              aria-pressed={drawingTool === "trend"}
            >
              <Pencil className="h-3.5 w-3.5" />
              趋势线
            </button>
            <button
              type="button"
              onClick={() => onSelectDrawingTool(drawingTool === "horizontal" ? "none" : "horizontal")}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition ${
                drawingTool === "horizontal" ? "bg-emerald-50 text-emerald-700" : "hover:bg-slate-100"
              }`}
              title={drawingTool === "horizontal" ? "关闭水平线并清空已画线" : "开启水平线工具"}
              aria-pressed={drawingTool === "horizontal"}
            >
              <Minus className="h-3.5 w-3.5" />
              水平线
            </button>
            <button
              type="button"
              onClick={onUndoDrawing}
              disabled={!hasDrawings}
              className="rounded-lg px-2 py-1.5 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              title="撤销上一条线"
            >
              撤销
            </button>
            <button
              type="button"
              onClick={onClearDrawings}
              disabled={!hasDrawings && drawingTool === "none"}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
              title="清空已画线并退出画线模式"
            >
              <Trash2 className="h-3.5 w-3.5" />
              清空
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onTogglePatterns}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition ${
          showPatterns
            ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
        }`}
        title={showPatterns ? "隐藏K线形态标记" : "标注经典K线形态：射击之星 / 上吊线 / 黄昏之星 / 长腿车夫 / 墓碑线 / 乌云盖顶 / 吞没 / 三只乌鸦 / 锤子线"}
        aria-pressed={!!showPatterns}
      >
        {showPatterns ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        K线形态
      </button>
      <button
        type="button"
        onClick={onToggleFullscreen}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100"
        title={fullscreen ? "退出全屏图表" : "全屏查看图表"}
        aria-pressed={fullscreen}
      >
        {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {fullscreen ? "退出全屏" : "全屏"}
      </button>
      <div className="flex items-center gap-1 rounded-xl border bg-white p-1 text-xs text-slate-600" title="也可将鼠标移入图表后滚动滚轮缩放 K 线">
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => onDisplayCountChange(stepDisplayCount(displayCount, 1, maxDisplayCount))}
          disabled={displayCount >= Math.min(500, maxDisplayCount || 500)}
          title="缩小：显示更多 K 线"
          aria-label="缩小，显示更多K线"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="min-w-12 rounded-lg px-2 py-1 font-semibold text-slate-800 hover:bg-slate-100"
          onClick={() => onDisplayCountChange(Math.min(80, maxDisplayCount || 80))}
          title="恢复为近80根"
        >
          {displayCount}根
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
          onClick={() => onDisplayCountChange(stepDisplayCount(displayCount, -1, maxDisplayCount))}
          disabled={displayCount <= DISPLAY_COUNT_OPTIONS[0]}
          title="放大：显示更少 K 线"
          aria-label="放大，显示更少K线"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </>
  );
}

// 主图均线配置：period 对应 chart 里的 maN 序列，可在图例上点击切换显示。
const MA_LINES = [
  { period: 5, key: "ma5", color: "#ff9900" },
  { period: 10, key: "ma10", color: "#3366cc", shadow: true, shadowFill: "rgba(96,96,96,0.16)" },
  { period: 20, key: "ma20", color: "#9933cc" },
  { period: 60, key: "ma60", color: "#009688" },
  { period: 120, key: "ma120", color: "#e91e63" },
  // BBI 多空线：非固定周期，用字符串 key 标识，图例名直接显示 "BBI"；青色冷调，和暖色 MA5 分开，并支持阴影循环。
  { period: "BBI", key: "bbi", color: "#06b6d4", name: "BBI", shadow: true, shadowFill: "rgba(6,182,212,0.15)" },
];

// 成交量均量线配置：颜色沿用价格 MA5/MA10，图例同样支持点击显隐。
const VOL_MA_LINES = [
  { period: 5, key: "volMa5", color: "#ff9900" },
  { period: 10, key: "volMa10", color: "#3366cc" },
];

const KLINE_PATTERN_EXAMPLES = {
  shootingStar: {
    title: "顶部反转K线形态",
    subtitle: "射击之星",
    candles: [
      { x: 48, y: 132, h: 30, bodyTop: 118, bodyH: 15, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 82, y: 112, h: 32, bodyTop: 101, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 116, y: 92, h: 28, bodyTop: 82, bodyH: 15, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 156, y: 66, h: 66, bodyTop: 56, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c", focus: true },
      { x: 198, y: 44, h: 56, bodyTop: 46, bodyH: 20, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 232, y: 70, h: 52, bodyTop: 64, bodyH: 44, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  eveningStar: {
    title: "顶部反转K线形态",
    subtitle: "黄昏之星",
    candles: [
      { x: 42, y: 130, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 72, y: 110, h: 30, bodyTop: 98, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 102, y: 90, h: 29, bodyTop: 80, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 134, y: 58, h: 62, bodyTop: 56, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c", focus: true },
      { x: 166, y: 30, h: 28, bodyTop: 40, bodyH: 4, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 202, y: 48, h: 62, bodyTop: 54, bodyH: 42, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 232, y: 88, h: 30, bodyTop: 80, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 252, y: 108, h: 30, bodyTop: 100, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 266, y: 128, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  hangingMan: {
    title: "顶部反转K线形态",
    subtitle: "上吊线",
    candles: [
      { x: 48, y: 132, h: 34, bodyTop: 116, bodyH: 18, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 82, y: 108, h: 34, bodyTop: 94, bodyH: 18, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 116, y: 84, h: 30, bodyTop: 75, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 156, y: 48, h: 64, bodyTop: 48, bodyH: 42, fill: "var(--chart-muted)", stroke: "#b91c1c" },
      { x: 198, y: 28, h: 78, bodyTop: 30, bodyH: 18, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 232, y: 50, h: 72, bodyTop: 58, bodyH: 42, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  longLeggedRickshaw: {
    title: "顶部反转K线形态",
    subtitle: "长腿车夫",
    candles: [
      { x: 42, y: 130, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 72, y: 110, h: 30, bodyTop: 98, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 102, y: 88, h: 30, bodyTop: 80, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 134, y: 58, h: 64, bodyTop: 56, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c" },
      { x: 168, y: 22, h: 82, bodyTop: 58, bodyH: 4, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 202, y: 48, h: 68, bodyTop: 56, bodyH: 42, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 236, y: 88, h: 30, bodyTop: 80, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 258, y: 108, h: 30, bodyTop: 100, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  gravestoneDoji: {
    title: "顶部反转K线形态",
    subtitle: "墓碑线",
    candles: [
      { x: 42, y: 130, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 72, y: 110, h: 30, bodyTop: 98, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 102, y: 90, h: 29, bodyTop: 80, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 134, y: 58, h: 62, bodyTop: 56, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c" },
      { x: 166, y: 26, h: 68, bodyTop: 28, bodyH: 66, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 202, y: 68, h: 52, bodyTop: 66, bodyH: 36, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 236, y: 92, h: 30, bodyTop: 84, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 258, y: 112, h: 30, bodyTop: 104, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  bearishEngulfing: {
    title: "顶部反转K线形态",
    subtitle: "吞没形态",
    candles: [
      { x: 42, y: 130, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 72, y: 108, h: 30, bodyTop: 96, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 102, y: 86, h: 30, bodyTop: 78, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 134, y: 52, h: 64, bodyTop: 50, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c" },
      { x: 168, y: 24, h: 70, bodyTop: 28, bodyH: 68, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 202, y: 90, h: 30, bodyTop: 82, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 236, y: 110, h: 30, bodyTop: 102, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 258, y: 130, h: 28, bodyTop: 118, bodyH: 16, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
  threeBlackCrows: {
    title: "顶部反转K线形态",
    subtitle: "三只乌鸦",
    candles: [
      { x: 42, y: 126, h: 30, bodyTop: 112, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 72, y: 104, h: 30, bodyTop: 92, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 102, y: 82, h: 30, bodyTop: 72, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
      { x: 134, y: 52, h: 62, bodyTop: 50, bodyH: 44, fill: "var(--chart-muted)", stroke: "#b91c1c" },
      { x: 168, y: 28, h: 50, bodyTop: 34, bodyH: 34, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 198, y: 46, h: 46, bodyTop: 54, bodyH: 30, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 228, y: 62, h: 44, bodyTop: 72, bodyH: 28, fill: "var(--chart-ink)", stroke: "var(--chart-ink)", focus: true },
      { x: 258, y: 96, h: 30, bodyTop: 88, bodyH: 17, fill: "var(--chart-ink)", stroke: "var(--chart-ink)" },
    ],
  },
};

function KlinePatternExample({ detail }) {
  const example = detail?.exampleKey ? KLINE_PATTERN_EXAMPLES[detail.exampleKey] : null;
  if (!example) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-900">
      <svg viewBox="0 0 280 178" className="block w-full" role="img" aria-label={`${example.subtitle} 实例图`}>
        <rect x="0" y="0" width="280" height="154" fill="var(--chart-muted)" />
        <text x="10" y="24" fontSize="15" fontWeight="700" fill="var(--chart-ink)">{example.title}</text>
        <text x="62" y="48" fontSize="16" fontWeight="700" fill="var(--chart-ink)">-- “{example.subtitle}”</text>
        {example.candles.map((candle, index) => {
          const wickTop = candle.y;
          const wickBottom = candle.y + candle.h;
          return (
            <g key={`${detail.exampleKey}-${index}`}>
              <line x1={candle.x} x2={candle.x} y1={wickTop} y2={wickBottom} stroke={candle.stroke} strokeWidth={candle.focus ? "2.2" : "2"} />
              <rect
                x={candle.x - 7}
                y={candle.bodyTop}
                width="14"
                height={Math.max(3, candle.bodyH)}
                fill={candle.fill}
                stroke={candle.stroke}
                strokeWidth={candle.focus ? "1.6" : "1.2"}
              />
            </g>
          );
        })}
        <rect x="0" y="154" width="280" height="24" fill="#111111" />
        <text x="140" y="171" textAnchor="middle" fontSize="13" fill="#d1d5db">{example.subtitle}</text>
      </svg>
    </div>
  );
}

function KlinePatternPopover({ selected, onClose }) {
  if (!selected?.pattern || !selected?.row) return null;

  const detail = getKlinePatternDetail(selected.pattern);
  const bear = selected.pattern.dir === "bear";
  const signalClass = bear ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-600";
  const borderClass = bear ? "border-green-200" : "border-red-200";
  const left = Math.max(12, selected.x - 140);
  const top = Math.max(12, selected.y + (bear ? 18 : -360));

  return (
    <div
      className={`absolute z-20 w-[280px] rounded-xl border bg-white p-3 text-xs text-slate-600 shadow-xl ${borderClass}`}
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{selected.pattern.name}</span>
            <span className={`rounded-full border px-2 py-0.5 font-semibold ${signalClass}`}>
              {detail?.bias || (bear ? "看跌" : "看涨")}
            </span>
          </div>
          <div className="mt-1 text-slate-500">
            {selected.row.date} · {detail?.type || "K线反转形态"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="关闭"
          aria-label="关闭K线形态详情"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 leading-relaxed text-slate-700">
        {detail?.definition || "该形态提示当前 K 线结构可能出现方向切换，需要结合趋势、成交量和后续确认信号观察。"}
      </div>
      <KlinePatternExample detail={detail} />
      {detail?.conditions?.length ? (
        <div className="mt-3 rounded-lg bg-slate-50 p-2">
          <div className="mb-1 font-semibold text-slate-700">判定要点</div>
          <ul className="space-y-1">
            {detail.conditions.map((item) => (
              <li key={item} className="flex gap-1.5">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-slate-500">开 / 收</div>
          <div className="mt-1 font-semibold text-slate-800">{selected.row.open.toFixed(2)} / {selected.row.close.toFixed(2)}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-slate-500">高 / 低</div>
          <div className="mt-1 font-semibold text-slate-800">{selected.row.high.toFixed(2)} / {selected.row.low.toFixed(2)}</div>
        </div>
      </div>
      {detail?.status || detail?.note ? (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-2 leading-relaxed text-amber-800">
          {detail?.status ? <div className="font-semibold">状态：{detail.status}</div> : null}
          {detail?.note ? <div className={detail?.status ? "mt-1" : ""}>{detail.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Chart({
  rows,
  fullRows = rows,
  visibleGaps,
  showGaps,
  expanded = false,
  displayCount = 80,
  onDisplayCountChange = null,
  drawingTool = "none",
  drawnLines = [],
  onDrawnLinesChange = null,
  showPatterns = false,
  chanData,
  chanOptions,
}) {
  const priceClipId = useId();
  const [viewportWidth, setViewportWidth] = useState(expanded ? 1600 : 1100);
  // 1440px 左右的三栏布局里，中间栏通常只有 640~680px。旧的 720px 下限会让
  // 图表即使已经自适应容器，仍多出一小段横向滚动；640px 仍足够容纳价格轴与指标。
  const width = Math.max(600, Math.round(viewportWidth - 24));
  const height = Math.round(Math.max(600, Math.min(expanded ? 920 : 760, width * 0.72)));
  const compactHeader = width < 820;
  const [hoverIndex, setHoverIndex] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [showMacdSignals, setShowMacdSignals] = useState(true);
  const [klineFaded, setKlineFaded] = useState(false);
  const [showMaCrosses, setShowMaCrosses] = useState(false);
  const [showVolMaCrosses, setShowVolMaCrosses] = useState(true);
  const [visibleMAs, setVisibleMAs] = useState(() => new Set([5, 10, 20, 60, "BBI"]));
  const [visibleVolMAs, setVisibleVolMAs] = useState(() => new Set([5, 10]));
  const [selectedPattern, setSelectedPattern] = useState(null);
  // 阴影填充：把某条均线（MA10「黑马线」/ BBI）以下的区域填色，默认都关闭。用 Set 记录当前开启阴影的均线。
  const [shadowMAs, setShadowMAs] = useState(() => new Set());
  const toggleMA = (period) =>
    setVisibleMAs((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });
  const toggleVolMA = (period) =>
    setVisibleVolMAs((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });
  // 支持阴影的均线（MA10、BBI）图例点击循环：隐藏 → 仅显示线 → 显示线+阴影 → 隐藏
  const cycleMA = (period) => {
    const on = visibleMAs.has(period);
    const shaded = shadowMAs.has(period);
    const dropShadow = (prev) => {
      const next = new Set(prev);
      next.delete(period);
      return next;
    };
    if (!on) {
      setVisibleMAs((prev) => new Set(prev).add(period));
      setShadowMAs(dropShadow);
    } else if (!shaded) {
      setShadowMAs((prev) => new Set(prev).add(period));
    } else {
      setVisibleMAs((prev) => {
        const next = new Set(prev);
        next.delete(period);
        return next;
      });
      setShadowMAs(dropShadow);
    }
  };
  const [pendingLineStart, setPendingLineStart] = useState(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [activeBrushPoints, setActiveBrushPoints] = useState([]);
  const scrollRef = useRef(null);
  const wheelDeltaRef = useRef(0);
  const wheelFeedbackTimerRef = useRef(null);
  const [wheelFeedbackVisible, setWheelFeedbackVisible] = useState(false);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });
  const brushRef = useRef({ active: false });
  const drawingEnabled = drawingTool !== "none";

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    const updateWidth = () => setViewportWidth(container.clientWidth || (expanded ? 1600 : 1100));
    updateWidth();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateWidth);
    observer?.observe(container);
    window.addEventListener("resize", updateWidth);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [expanded]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof onDisplayCountChange !== "function") return undefined;
    const handleWheel = (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      wheelDeltaRef.current += event.deltaY;
      const threshold = event.deltaMode === 1 ? 3 : 48;
      if (Math.abs(wheelDeltaRef.current) < threshold) return;
      const direction = wheelDeltaRef.current > 0 ? 1 : -1;
      wheelDeltaRef.current = 0;
      onDisplayCountChange((current) => stepDisplayCount(current, direction, fullRows.length));
      setWheelFeedbackVisible(true);
      window.clearTimeout(wheelFeedbackTimerRef.current);
      wheelFeedbackTimerRef.current = window.setTimeout(() => setWheelFeedbackVisible(false), 900);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      window.clearTimeout(wheelFeedbackTimerRef.current);
    };
  }, [fullRows.length, onDisplayCountChange]);

  function beginDrag(clientX) {
    if (!scrollRef.current) return;
    dragRef.current = {
      active: true,
      startX: clientX,
      startScrollLeft: scrollRef.current.scrollLeft,
      moved: false,
    };
  }

  function moveDrag(clientX) {
    if (!dragRef.current.active || !scrollRef.current) return;
    const dx = clientX - dragRef.current.startX;
    if (Math.abs(dx) > 4) dragRef.current.moved = true;
    scrollRef.current.scrollLeft = dragRef.current.startScrollLeft - dx;
  }

  function endDrag() {
    dragRef.current.active = false;
  }

  function appendBrushPoint(point) {
    if (!point) return;
    setActiveBrushPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) return prev;
      return [...prev, point];
    });
  }

  function finishBrushStroke() {
    if (!brushRef.current.active) return;
    brushRef.current.active = false;
    setActiveBrushPoints((prev) => {
      if (prev.length > 1 && typeof onDrawnLinesChange === "function") {
        onDrawnLinesChange([
          ...drawnLines,
          {
            type: "brush",
            points: prev,
          },
        ]);
      }
      return [];
    });
  }

  const safeRows = useMemo(
    () => rows.filter((r) => [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite)),
    [rows],
  );
  const fullSafeRows = useMemo(
    () => fullRows.filter((r) => [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite)),
    [fullRows],
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    const container = scrollRef.current;
    container.scrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  }, [width, safeRows.length]);

  const chart = useMemo(() => {
    if (safeRows.length === 0) return null;
    // 窄图将九转和均线分行，给顶部文字预留独立空间。
    const margin = { top: compactHeader ? 106 : 66, right: 72, bottom: 36, left: 58 };
    const gap = 18;
    // 三个绘图区必须严格落在 SVG 的可用高度内。旧算法分别设置最小高度，
    // 在响应式窄图（高度约 600px）中总和会超过画布，导致 MACD 底部被裁切。
    const contentH = height - margin.top - margin.bottom - gap * 2;
    const volH = Math.max(80, Math.round(contentH * 0.16));
    const macdH = Math.max(110, Math.round(contentH * 0.22));
    const mainH = contentH - volH - macdH;
    const plotW = width - margin.left - margin.right;
    const priceMax = Math.max(...safeRows.map((d) => d.high));
    const priceMin = Math.min(...safeRows.map((d) => d.low));
    const rawRange = Math.max(priceMax - priceMin, priceMax * 0.01, 1);
    const yMax = priceMax + rawRange * 0.08;
    const yMin = Math.max(0, priceMin - rawRange * 0.08);
    const maxVol = Math.max(...safeRows.map((d) => d.volume), 1);
    // Calculate MACD from the complete history, then project it onto the visible
    // window. Changing "近N根" must not change DIF/DEA or their zero-axis position.
    const fullMacdByDate = new Map(calcMACDSeries(fullSafeRows).map((item) => [item.date, item]));
    const macdSeries = safeRows.map((row) => fullMacdByDate.get(row.date) || {
      date: row.date,
      dif: null,
      dea: null,
      hist: null,
    });
    const macdValues = macdSeries.flatMap((m) => [m.dif, m.dea, m.hist]).filter(Number.isFinite);
    const macdAbsMax = Math.max(...macdValues.map((v) => Math.abs(v)), 0.01);
    const macdCrosses = [];
    const zeroAxisCrosses = [];
    for (let i = 1; i < macdSeries.length; i += 1) {
      const prev = macdSeries[i - 1];
      const curr = macdSeries[i];
      if (![prev?.dif, prev?.dea, curr?.dif, curr?.dea, curr?.hist].every(Number.isFinite)) continue;
      const prevDiff = prev.dif - prev.dea;
      const currDiff = curr.dif - curr.dea;
      if (prevDiff <= 0 && currDiff > 0) {
        macdCrosses.push({
          index: i,
          type: "golden",
          label: "金叉",
          value: (curr.dif + curr.dea) / 2,
          zone: curr.dif > 0 && curr.dea > 0 ? "water" : curr.dif < 0 && curr.dea < 0 ? "under" : "near",
        });
      } else if (prevDiff >= 0 && currDiff < 0) {
        macdCrosses.push({
          index: i,
          type: "death",
          label: "死叉",
          value: (curr.dif + curr.dea) / 2,
          zone: curr.dif > 0 && curr.dea > 0 ? "water" : curr.dif < 0 && curr.dea < 0 ? "under" : "near",
        });
      }
      if (prev.dif <= 0 && curr.dif > 0) {
        zeroAxisCrosses.push({ index: i, type: "zeroUp", label: "上0轴", value: curr.dif });
      } else if (prev.dif >= 0 && curr.dif < 0) {
        zeroAxisCrosses.push({ index: i, type: "zeroDown", label: "下0轴", value: curr.dif });
      }
    }
    const xStep = plotW / Math.max(safeRows.length, 1);
    const candleW = Math.max(3, Math.min(13, xStep * 0.58));
    const x = (i) => margin.left + i * xStep + xStep / 2;
    const y = (price) => margin.top + ((yMax - price) / Math.max(yMax - yMin, 1)) * mainH;
    const vy = (vol) => margin.top + mainH + gap + (1 - vol / maxVol) * volH;
    const volBase = margin.top + mainH + gap + volH;
    const macdTop = volBase + gap;
    const macdBase = macdTop + macdH / 2;
    const macdY = (value) => macdBase - (value / macdAbsMax) * (macdH * 0.46);
    const ma5 = movingAverage(safeRows, 5);
    const ma10 = movingAverage(safeRows, 10);
    const ma20 = movingAverage(safeRows, 20);
    const ma60 = movingAverage(safeRows, 60);
    const ma120 = movingAverage(safeRows, 120);
    // BBI 多空指标 = (MA3 + MA6 + MA12 + MA24) / 4，一条兼顾快慢的平均线，常作多空分界。
    const bbiMa3 = movingAverage(safeRows, 3);
    const bbiMa6 = movingAverage(safeRows, 6);
    const bbiMa12 = movingAverage(safeRows, 12);
    const bbiMa24 = movingAverage(safeRows, 24);
    const bbi = safeRows.map((_, i) => {
      const parts = [bbiMa3[i], bbiMa6[i], bbiMa12[i], bbiMa24[i]];
      if (!parts.every(Number.isFinite)) return null;
      return (parts[0] + parts[1] + parts[2] + parts[3]) / 4;
    });
    // 成交量均量线（与价格均线同算法，取 volume）：MA5/MA10 均量。
    const volMa5 = movingAverage(safeRows, 5, (r) => r.volume);
    const volMa10 = movingAverage(safeRows, 10, (r) => r.volume);
    // 均量线金叉/死叉：MA5均量 上穿 MA10均量 记为金叉(golden)，下穿记为死叉(death)。
    const volMaCrosses = [];
    for (let i = 1; i < safeRows.length; i += 1) {
      const pf = volMa5[i - 1];
      const ps = volMa10[i - 1];
      const cf = volMa5[i];
      const cs = volMa10[i];
      if (![pf, ps, cf, cs].every(Number.isFinite)) continue;
      const wasAbove = pf > ps;
      const isAbove = cf > cs;
      if (wasAbove !== isAbove) {
        volMaCrosses.push({ index: i, type: isAbove ? "golden" : "death", value: (cf + cs) / 2 });
      }
    }
    // 任意两条均线的交汇点：快线上穿慢线记为 up（金叉），下穿记为 down（死叉）。
    // 计算全部组合，渲染时再按当前选中的均线过滤，便于查看所选均线的交叉。
    const maByPeriod = { 5: ma5, 10: ma10, 20: ma20, 60: ma60, 120: ma120 };
    const maPeriods = [5, 10, 20, 60, 120];
    const maCrosses = [];
    for (let p = 0; p < maPeriods.length; p += 1) {
      for (let q = p + 1; q < maPeriods.length; q += 1) {
        const fast = maPeriods[p];
        const slow = maPeriods[q];
        const fastArr = maByPeriod[fast];
        const slowArr = maByPeriod[slow];
        for (let i = 1; i < safeRows.length; i += 1) {
          const pf = fastArr[i - 1];
          const ps = slowArr[i - 1];
          const cf = fastArr[i];
          const cs = slowArr[i];
          if (![pf, ps, cf, cs].every(Number.isFinite)) continue;
          const wasAbove = pf > ps;
          const isAbove = cf > cs;
          if (wasAbove !== isAbove) {
            maCrosses.push({ index: i, type: isAbove ? "up" : "down", value: (cf + cs) / 2, fast, slow });
          }
        }
      }
    }
    const gaps = Array.isArray(visibleGaps) ? visibleGaps : [];
    const klinePatterns = detectKlinePatterns(safeRows);
    const makePath = (arr, yMapper = y) => {
      let started = false;
      return arr
        .map((v, i) => {
          if (v == null || !Number.isFinite(v)) return null;
          const cmd = started ? "L" : "M";
          started = true;
          return `${cmd}${x(i)},${yMapper(v)}`;
        })
        .filter(Boolean)
        .join(" ");
    };
    return { margin, mainH, gap, volH, macdH, plotW, xStep, candleW, x, y, vy, volBase, macdTop, macdBase, macdY, macdAbsMax, yMax, yMin, maxVol, ma5, ma10, ma20, ma60, ma120, bbi, volMa5, volMa10, volMaCrosses, maCrosses, macdSeries, macdCrosses, zeroAxisCrosses, gaps, klinePatterns, makePath };
  }, [safeRows, fullSafeRows, width, height, compactHeader, visibleGaps]);

  if (!chart || safeRows.length === 0) {
    return <div className="rounded-2xl bg-slate-100 p-12 text-center text-slate-500">暂无可绘制数据</div>;
  }

  const clampedHoverIndex = hoverIndex == null ? safeRows.length - 1 : Math.min(Math.max(hoverIndex, 0), safeRows.length - 1);
  const clampedSelectedIndex = selectedIndex == null ? null : Math.min(Math.max(selectedIndex, 0), safeRows.length - 1);
  const guideIndex = clampedSelectedIndex ?? (hoverIndex == null ? null : clampedHoverIndex);
  const guideRow = guideIndex == null ? null : safeRows[guideIndex];
  const hover = safeRows[clampedHoverIndex];
  const positive = hover.close >= hover.open;
  const priceGuide = hoverPoint && hoverPoint.y >= chart.margin.top && hoverPoint.y <= chart.margin.top + chart.mainH
    ? (() => {
        const price = chart.yMax - ((hoverPoint.y - chart.margin.top) / chart.mainH) * (chart.yMax - chart.yMin);
        const first = safeRows[0];
        // Follow moomoo's dual-axis convention: 0% is the close of the first
        // candle in the displayed range, so price and percentage share one scale.
        const base = first.close;
        return { y: hoverPoint.y, price, pct: base > 0 ? ((price / base) - 1) * 100 : null };
      })()
    : null;
  const currentTD = getCurrentTDLabel(safeRows);
  const gridLines = 5;
  const xLabels = Math.min(6, safeRows.length);

  function pointFromEvent(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = width / Math.max(rect.width, 1);
    const scaleY = height / Math.max(rect.height, 1);
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    const clampedX = Math.max(0, Math.min(width, mouseX));
    const clampedY = Math.max(0, Math.min(height, mouseY));
    return { x: clampedX, y: clampedY };
  }

  function indexFromX(xValue) {
    if (!chart) return null;
    const idx = Math.floor((xValue - chart.margin.left) / chart.xStep);
    if (idx < 0 || idx >= safeRows.length) return null;
    return idx;
  }

  function makeOverlayPath(points) {
    let started = false;
    return points
      .map((point) => {
        if (!point) return null;
        const cmd = started ? "L" : "M";
        started = true;
        return `${cmd}${point.x},${point.y}`;
      })
      .filter(Boolean)
      .join(" ");
  }

  return (
    <div
      ref={scrollRef}
      className={`relative w-full overscroll-contain overflow-x-auto rounded-2xl border bg-white p-3 shadow-sm ${drawingEnabled ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      onMouseDown={(e) => {
        if (drawingTool === "brush") return;
        if (drawingEnabled) return;
        if (e.button !== 0) return;
        beginDrag(e.clientX);
      }}
      onMouseMove={(e) => {
        if (drawingTool === "brush") return;
        if (drawingEnabled) return;
        moveDrag(e.clientX);
      }}
      onMouseUp={() => {
        endDrag();
        finishBrushStroke();
      }}
      onMouseLeave={() => {
        endDrag();
        finishBrushStroke();
      }}
      onTouchStart={(e) => {
        if (drawingTool === "brush") return;
        if (drawingEnabled) return;
        beginDrag(e.touches[0]?.clientX || 0);
      }}
      onTouchMove={(e) => {
        if (drawingTool === "brush") return;
        if (drawingEnabled) return;
        moveDrag(e.touches[0]?.clientX || 0);
      }}
      onTouchEnd={() => {
        endDrag();
        finishBrushStroke();
      }}
    >
      {wheelFeedbackVisible && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
          已显示近 {displayCount} 根
        </div>
      )}
      <div className="relative" style={{ width: `${width}px` }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: `${width}px`, height: `${height}px` }}
          className="cursor-pointer select-none"
          onMouseLeave={() => {
            setHoverIndex(null);
            setHoverPoint(null);
          }}
          onMouseMove={(e) => {
            const point = pointFromEvent(e);
            const rect = e.currentTarget.getBoundingClientRect();
            const scaleX = width / Math.max(rect.width, 1);
            const mouseX = (e.clientX - rect.left) * scaleX;
            const idx = Math.floor((mouseX - chart.margin.left) / chart.xStep);
            if (idx >= 0 && idx < safeRows.length) setHoverIndex(idx);
            setHoverPoint(point);
            if (drawingTool === "brush" && brushRef.current.active) appendBrushPoint(point);
          }}
          onMouseDown={(e) => {
            if (drawingTool !== "brush") return;
            const point = pointFromEvent(e);
            if (!point) return;
            brushRef.current.active = true;
            setActiveBrushPoints([point]);
            setHoverPoint(point);
          }}
          onMouseUp={() => {
            if (drawingTool !== "brush") return;
            finishBrushStroke();
          }}
          onClick={(e) => {
            if (dragRef.current.moved) return;
            if (drawingEnabled) {
              if (drawingTool === "brush") return;
              const point = pointFromEvent(e);
              if (!point) return;
              if (drawingTool === "horizontal") {
                if (typeof onDrawnLinesChange === "function") {
                  onDrawnLinesChange([
                    ...drawnLines,
                    {
                      type: "horizontal",
                      y: point.y,
                    },
                  ]);
                }
                return;
              }
              if (!pendingLineStart) {
                setPendingLineStart(point);
                return;
              }
              if (typeof onDrawnLinesChange === "function") {
                onDrawnLinesChange([
                  ...drawnLines,
                  {
                    type: "trend",
                    start: pendingLineStart,
                    end: point,
                  },
                ]);
              }
              setPendingLineStart(null);
              return;
            }
            const point = pointFromEvent(e);
            const idx = point ? indexFromX(point.x) : null;
            setSelectedPattern(null);
            if (idx != null) setSelectedIndex(idx);
          }}
        >
          <rect x="0" y="0" width={width} height={height} fill="var(--chart-surface)" />
          <defs>
            <clipPath id={priceClipId}>
              <rect x={chart.margin.left} y={chart.margin.top} width={chart.plotW} height={chart.mainH} />
            </clipPath>
          </defs>
          {/* 顶部信息在窄图中分行；价格覆盖层不得进入文字区域。 */}
          <text x={width - chart.margin.right - 6} y={compactHeader ? 98 : 58} textAnchor="end" fontSize="13" fill="var(--chart-ink-3)">
            {hover.date} 开 {hover.open.toFixed(2)} 高 {hover.high.toFixed(2)} 低 {hover.low.toFixed(2)} 收 {hover.close.toFixed(2)}
          </text>
          <text x={chart.margin.left} y="19" fontSize="13" fill={positive ? "var(--chart-up)" : "var(--chart-down)"}>
            涨跌 {Number.isFinite(hover.change) ? hover.change.toFixed(2) : "-"} ({Number.isFinite(hover.pct) ? hover.pct.toFixed(2) : "-"}%)
          </text>
          <text x={chart.margin.left + 190} y="19" fontSize="13" fill="var(--chart-ink-3)">
            成交量 {formatNumber(hover.volume)} 换手 {Number.isFinite(hover.turnover) ? hover.turnover.toFixed(2) : "-"}%
          </text>
          {currentTD && (
            <g>
              <rect x={width - chart.margin.right - 150} y={compactHeader ? 26 : 6} width="140" height="18" rx="9" fill={currentTD.direction === "up" ? "rgba(213,0,0,0.08)" : "rgba(0,128,0,0.08)"} stroke={currentTD.direction === "up" ? "var(--chart-up)" : "var(--chart-down)"} />
              <text x={width - chart.margin.right - 80} y={compactHeader ? 39 : 19} textAnchor="middle" fontSize="12" fontWeight="700" fill={currentTD.direction === "up" ? "var(--chart-up)" : "var(--chart-down)"}>
                当前九转：{currentTD.text}
              </text>
            </g>
          )}

          {Array.from({ length: gridLines + 1 }).map((_, i) => {
            const yy = chart.margin.top + (chart.mainH / gridLines) * i;
            const price = chart.yMax - ((chart.yMax - chart.yMin) / gridLines) * i;
            return (
              <g key={`grid-${i}`}>
                <line x1={chart.margin.left} x2={width - chart.margin.right} y1={yy} y2={yy} stroke="var(--chart-grid-soft)" strokeDasharray="4 4" />
                <text x={width - chart.margin.right + 8} y={yy + 4} fontSize="11" fill="var(--chart-ink-3)">{price.toFixed(2)}</text>
              </g>
            );
          })}

        <line x1={chart.margin.left} x2={chart.margin.left} y1={chart.margin.top} y2={chart.margin.top + chart.mainH} stroke="var(--chart-grid)" />
        <line x1={width - chart.margin.right} x2={width - chart.margin.right} y1={chart.margin.top} y2={chart.margin.top + chart.mainH} stroke="var(--chart-grid)" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.margin.top + chart.mainH} y2={chart.margin.top + chart.mainH} stroke="var(--chart-grid)" />

        <ChanOverlay layer="zones" data={chanData} options={chanOptions} rows={safeRows} chart={chart} />

        {/* 均线阴影：把开启阴影的均线（MA10「黑马线」/ BBI）到主图底部之间的区域填色（在K线下方绘制，K线叠加其上） */}
        {MA_LINES.filter((m) => m.shadow).map((m) => {
          if (!visibleMAs.has(m.period) || !shadowMAs.has(m.period)) return null;
          const arr = chart[m.key];
          if (!arr) return null;
          const valid = [];
          for (let i = 0; i < arr.length; i += 1) {
            if (Number.isFinite(arr[i])) valid.push(i);
          }
          if (valid.length < 2) return null;
          const baseY = chart.margin.top + chart.mainH;
          const firstX = chart.x(valid[0]);
          const lastX = chart.x(valid[valid.length - 1]);
          const d = `${chart.makePath(arr)} L${lastX},${baseY} L${firstX},${baseY} Z`;
          return <path key={`ma-shadow-${m.period}`} d={d} fill={m.shadowFill ?? "rgba(96,96,96,0.16)"} stroke="none" />;
        })}

        {MA_LINES.map((m) =>
          visibleMAs.has(m.period) ? (
            <path key={`ma-line-${m.period}`} d={chart.makePath(chart[m.key])} fill="none" stroke={m.color} strokeWidth={klineFaded ? "2" : "1.4"} />
          ) : null
        )}
        {/* K线透明时，沿每条均线按间隔标出方向（局部斜率）：红色▲向上，绿色▼向下；末端再放一个稍大的箭头。 */}
        {klineFaded &&
          MA_LINES.map((m) => {
            if (!visibleMAs.has(m.period)) return null;
            const arr = chart[m.key];
            // 收集所有有效点的下标
            const valid = [];
            for (let i = 0; i < arr.length; i += 1) {
              if (Number.isFinite(arr[i])) valid.push(i);
            }
            if (valid.length < 2) return null;
            const last = valid[valid.length - 1];
            // 沿线均匀取约 10 个采样点，避免箭头过密
            const step = Math.max(4, Math.floor((last - valid[0]) / 10));
            const markers = [];
            for (let i = valid[0] + step; i <= last; i += step) {
              if (!Number.isFinite(arr[i]) || !Number.isFinite(arr[i - step])) continue;
              markers.push({ index: i, rising: arr[i] >= arr[i - step], end: false });
            }
            // 末端方向（最近 5 根斜率）
            let prev = -1;
            for (let i = last - 1; i >= 0 && last - i <= 5; i -= 1) {
              if (Number.isFinite(arr[i])) { prev = i; break; }
            }
            if (prev >= 0) markers.push({ index: last, rising: arr[last] >= arr[prev], end: true });
            return (
              <g key={`ma-dir-${m.period}`}>
                {markers.map((mk) => {
                  const dirColor = mk.rising ? "var(--chart-up)" : "var(--chart-down)";
                  const ex = mk.end ? chart.x(mk.index) + 4 : chart.x(mk.index);
                  const ey = chart.y(arr[mk.index]) + (mk.end ? 4 : 3);
                  return (
                    <text
                      key={`ma-dir-${m.period}-${mk.index}-${mk.end ? "end" : "mid"}`}
                      x={ex}
                      y={ey}
                      textAnchor={mk.end ? "start" : "middle"}
                      fontSize={mk.end ? 11 : 9}
                      fontWeight="700"
                      fill={dirColor}
                      stroke="var(--chart-surface)"
                      strokeWidth="0.6"
                      paintOrder="stroke"
                    >
                      {mk.rising ? "▲" : "▼"}
                    </text>
                  );
                })}
              </g>
            );
          })}
        {(() => {
          // 均线图例显示当前数值：跟随光标所在 K 线（未悬停时取最新一根），与顶部 OHLC 行一致。
          // 先算出每个标签的宽度，再整块靠右对齐（右边缘锚定在右边距内侧、向左排布），
          // 避免不同位数的数值相互重叠，也让右边缘随数值变化保持稳定。
          const items = MA_LINES.map((m) => {
            const val = chart[m.key] ? chart[m.key][clampedHoverIndex] : undefined;
            const name = m.name ?? `MA${m.period}`;
            const label = `${name} ${Number.isFinite(val) ? val.toFixed(2) : "-"}`;
            return { m, label, advance: label.length * 7 + 14 };
          });
          return items.map(({ m, label }, idx) => {
            const rowStart = compactHeader ? Math.floor(idx / 3) * 3 : 0;
            const rowItems = compactHeader ? items.slice(rowStart, rowStart + 3) : items;
            const total = rowItems.reduce((sum, it) => sum + it.advance, 0);
            const startX = width - chart.margin.right - total + 8;
            const legendY = compactHeader ? 59 + Math.floor(idx / 3) * 20 : 39;
            const on = visibleMAs.has(m.period);
            const x0 = startX + items.slice(rowStart, idx).reduce((sum, it) => sum + it.advance, 0);
            const canShadow = !!m.shadow;
            const shadowOn = canShadow && on && shadowMAs.has(m.period);
            return (
              <g key={`ma-legend-${m.period}`}>
                {shadowOn && (
                  <rect x={x0 - 3} y={legendY - 9} width={label.length * 7 + 4} height="12" rx="2" fill={m.shadowFill ?? "rgba(96,96,96,0.16)"} />
                )}
                {canShadow && <title>点击切换：隐藏 → 显示线 → 显示线+阴影</title>}
                <text
                  x={x0}
                  y={legendY}
                  fontSize="12"
                  fill={m.color}
                  opacity={on ? 1 : 0.35}
                  fontWeight={on ? 700 : 400}
                  textDecoration={on ? "none" : "line-through"}
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canShadow) cycleMA(m.period);
                    else toggleMA(m.period);
                  }}
                >
                  {label}
                </text>
              </g>
            );
          });
        })()}

        <g clipPath={`url(#${priceClipId})`} data-chart-layer="gaps">
          {showGaps &&
            chart.gaps.map((g, idx) => {
              const left = chart.x(g.startIndex) + chart.candleW / 2;
              const right = chart.x(g.endIndex) + chart.candleW / 2;
              const y1 = chart.y(g.top);
              const y2 = chart.y(g.bottom);
              const rectY = Math.min(y1, y2);
              const rectH = Math.max(2, Math.abs(y2 - y1));
              const stroke = g.type === "up" ? "var(--chart-up)" : "var(--chart-down)";
              const fill = g.type === "up" ? "rgba(213, 0, 0, 0.10)" : "rgba(0, 128, 0, 0.10)";
              return (
                <g key={`gap-${idx}`}>
                  <rect x={left} y={rectY} width={Math.max(2, right - left)} height={rectH} fill={fill} stroke={stroke} strokeWidth="1" strokeDasharray={g.filled ? "5 3" : "none"} />
                  <text x={left + 4} y={rectY - 3} fontSize="10" fill={stroke}>{g.type === "up" ? "上缺口" : "下缺口"}</text>
              </g>
            );
          })}
        </g>

        {safeRows.map((d, i) => {
          const up = d.close >= d.open;
          const color = up ? "var(--chart-up)" : "var(--chart-down)";
          const cx = chart.x(i);
          const openY = chart.y(d.open);
          const closeY = chart.y(d.close);
          const highY = chart.y(d.high);
          const lowY = chart.y(d.low);
          const bodyTop = Math.min(openY, closeY);
          const bodyH = Math.max(1, Math.abs(closeY - openY));
          const volTop = chart.vy(d.volume);
          const volBarH = chart.volBase - volTop;
          const baseOpacity = klineFaded ? 0.07 : 1;
          return (
            <g key={`${d.date}-${i}`}>
              <line x1={cx} x2={cx} y1={highY} y2={lowY} stroke={color} strokeWidth="1" opacity={baseOpacity} />
              <rect x={cx - chart.candleW / 2} y={bodyTop} width={chart.candleW} height={bodyH} fill={up ? color : "var(--chart-surface)"} stroke={color} strokeWidth="1" opacity={baseOpacity} />
              <rect x={cx - chart.candleW / 2} y={volTop} width={chart.candleW} height={Math.max(1, volBarH)} fill={color} opacity={0.45} />
              {d.tdUp != null && (
                <g>
                  <text x={cx} y={highY - 6} textAnchor="middle" fontSize={d.tdUp === 9 ? 14 : 11} fontWeight={d.tdUp === 9 ? "700" : "500"} fill={d.tdStatus === "pending" ? "var(--chart-ink-3)" : "var(--chart-down)"}>{d.tdUp}</text>
                  {i === safeRows.length - 1 && <text x={cx + 22} y={highY - 6} fontSize="10" fontWeight="700" fill="var(--chart-down)">上涨</text>}
                </g>
              )}
              {d.tdDown != null && (
                <g>
                  <text x={cx} y={lowY + 16} textAnchor="middle" fontSize={d.tdDown === 9 ? 14 : 11} fontWeight={d.tdDown === 9 ? "700" : "500"} fill={d.tdStatus === "pending" ? "var(--chart-ink-3)" : "var(--chart-up)"}>{d.tdDown}</text>
                  {i === safeRows.length - 1 && <text x={cx + 22} y={lowY + 16} fontSize="10" fontWeight="700" fill="var(--chart-up)">下跌</text>}
                </g>
              )}
            </g>
          );
        })}

        <ChanOverlay layer="lines" data={chanData} options={chanOptions} rows={safeRows} chart={chart} />

        {/* 成交量均量线 MA5 / MA10，叠加在量柱之上（颜色与价格均线一致），可在 VOL 图例上点击显隐。 */}
        {VOL_MA_LINES.map((m) =>
          visibleVolMAs.has(m.period) ? (
            <path key={`vol-ma-${m.period}`} d={chart.makePath(chart[m.key], chart.vy)} fill="none" stroke={m.color} strokeWidth="1.2" />
          ) : null,
        )}
        {/* 均量线金叉/死叉标记，由 VOL 区右侧小眼睛开关控制；两条均量线都显示时才有意义。 */}
        {showVolMaCrosses &&
          VOL_MA_LINES.every((m) => visibleVolMAs.has(m.period)) &&
          chart.volMaCrosses.map((cross, idx) => {
            const cx = chart.x(cross.index);
            const cy = chart.vy(cross.value);
            const isGolden = cross.type === "golden";
            const color = isGolden ? "var(--chart-up)" : "var(--chart-down)";
            const labelY = isGolden ? cy - 12 : cy + 18;
            const labelBoxY = isGolden ? labelY - 11 : labelY - 10;
            return (
              <g key={`vol-cross-${idx}-${cross.index}`}>
                <circle cx={cx} cy={cy} r="5" fill="var(--chart-chip-soft)" stroke={color} strokeWidth="2" />
                <rect x={cx - 16} y={labelBoxY} width="32" height="16" rx="8" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="1" />
                <text x={cx} y={labelY + 1} textAnchor="middle" fontSize="10" fontWeight="700" fill={color}>{isGolden ? "金叉" : "死叉"}</text>
              </g>
            );
          })}

        {/* 所选均线之间的交叉点画圈。仅在 K 线透明且开启「显示交叉」小眼睛时显示，避免遮挡视图。 */}
        {showPatterns &&
          chart.klinePatterns.map((pat, idx) => {
            const row = safeRows[pat.index];
            if (!row) return null;
            const cx = chart.x(pat.index);
            const bear = pat.dir === "bear";
            // A股配色：顶部看跌用绿、标在最高价上方；底部看涨用红、标在最低价下方。
            const color = bear ? "var(--chart-down)" : "var(--chart-up)";
            const cy = bear ? chart.y(row.high) - 16 : chart.y(row.low) + 16;
            return (
              <g
                key={`kp-${idx}-${pat.index}`}
                className="opacity-60 transition-opacity duration-150 hover:opacity-100"
                style={{ cursor: drawingEnabled ? "crosshair" : "pointer" }}
                role="button"
                tabIndex={drawingEnabled ? -1 : 0}
                aria-label={`${pat.name} ${row.date} 查看定义`}
                onClick={(e) => {
                  if (drawingEnabled) return;
                  e.stopPropagation();
                  setSelectedIndex(pat.index);
                  setSelectedPattern((current) =>
                    current?.pattern?.index === pat.index && current?.pattern?.name === pat.name
                      ? null
                      : { pattern: pat, row, x: cx, y: cy },
                  );
                }}
                onKeyDown={(e) => {
                  if (drawingEnabled) return;
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedIndex(pat.index);
                  setSelectedPattern((current) =>
                    current?.pattern?.index === pat.index && current?.pattern?.name === pat.name
                      ? null
                      : { pattern: pat, row, x: cx, y: cy },
                  );
                }}
              >
                <title>{`${pat.name}（${row.date}）`}</title>
                <rect x={cx - 8} y={cy - 8} width="16" height="16" rx="4" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="1" />
                <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill={color}>{pat.abbr}</text>
              </g>
            );
          })}

        {klineFaded && showMaCrosses &&
          chart.maCrosses
            .filter((cross) => visibleMAs.has(cross.fast) && visibleMAs.has(cross.slow))
            .map((cross, idx) => {
            const cx = chart.x(cross.index);
            const cy = chart.y(cross.value);
            const isUp = cross.type === "up";
            const color = isUp ? "var(--chart-up)" : "var(--chart-down)";
            const label = `${cross.fast}×${cross.slow}`;
            const labelW = label.length * 6 + 8;
            const labelY = isUp ? cy - 12 : cy + 18;
            const labelBoxY = isUp ? labelY - 11 : labelY - 10;
            return (
              <g
                key={`ma-cross-${idx}-${cross.index}-${cross.fast}-${cross.slow}`}
                className="opacity-40 transition-opacity duration-150 hover:opacity-100"
                style={{ cursor: "default" }}
              >
                <circle cx={cx} cy={cy} r="4" fill="var(--chart-chip-soft)" stroke={color} strokeWidth="1.4" />
                <rect x={cx - labelW / 2} y={labelBoxY} width={labelW} height="14" rx="7" fill="var(--chart-chip)" stroke={color} strokeWidth="0.8" />
                <text x={cx} y={labelY} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{label}</text>
              </g>
            );
          })}

        {drawnLines.map((line, idx) => (
          <g key={`drawn-line-${idx}`}>
            {line.type === "horizontal" ? (
              <line
                x1={0}
                y1={line.y}
                x2={width}
                y2={line.y}
                stroke="var(--chart-ink)"
                strokeWidth="2"
                opacity="0.82"
              />
            ) : line.type === "brush" ? (
              <path d={makeOverlayPath(line.points)} fill="none" stroke="var(--chart-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.88" />
            ) : (
              <>
                <line
                  x1={line.start.x}
                  y1={line.start.y}
                  x2={line.end.x}
                  y2={line.end.y}
                  stroke="var(--chart-ink)"
                  strokeWidth="2"
                  opacity="0.85"
                />
                <circle cx={line.start.x} cy={line.start.y} r="3.5" fill="var(--chart-ink)" />
                <circle cx={line.end.x} cy={line.end.y} r="3.5" fill="var(--chart-ink)" />
              </>
            )}
          </g>
        ))}
        {drawingTool === "brush" && activeBrushPoints.length > 1 && (
          <g pointerEvents="none">
            <path d={makeOverlayPath(activeBrushPoints)} fill="none" stroke="var(--chart-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
          </g>
        )}
        {drawingTool === "trend" && pendingLineStart && hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={pendingLineStart.x}
              y1={pendingLineStart.y}
              x2={hoverPoint.x}
              y2={hoverPoint.y}
              stroke="var(--chart-ink)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.45"
            />
            <circle cx={pendingLineStart.x} cy={pendingLineStart.y} r="4" fill="var(--chart-ink)" opacity="0.7" />
          </g>
        )}
        {drawingTool === "horizontal" && hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={0}
              y1={hoverPoint.y}
              x2={width}
              y2={hoverPoint.y}
              stroke="var(--chart-ink)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.45"
            />
          </g>
        )}
        {drawingEnabled && (
          <g pointerEvents="none">
            <rect x={chart.margin.left} y={chart.margin.top + 6} width="156" height="22" rx="11" fill="var(--chart-chip-neutral)" stroke="var(--chart-chip-neutral-line)" />
            <text x={chart.margin.left + 78} y={chart.margin.top + 21} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--chart-ink-2)">
              {drawingTool === "brush" ? "画笔: 按住拖动画线" : drawingTool === "trend" ? "趋势线: 点两次完成" : "水平线: 点一次落线"}
            </text>
          </g>
        )}

        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.margin.top + chart.mainH + chart.gap} y2={chart.margin.top + chart.mainH + chart.gap} stroke="var(--chart-grid)" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.volBase} y2={chart.volBase} stroke="var(--chart-grid)" />
        <text x={width - chart.margin.right + 8} y={chart.margin.top + chart.mainH + chart.gap + 12} fontSize="11" fill="var(--chart-ink-3)">{formatNumber(chart.maxVol)}</text>
        <text x="18" y={chart.margin.top + chart.mainH + chart.gap + 12} fontSize="12" fill="var(--chart-ink-3)">VOL</text>
        {(() => {
          // 均量线图例：与主图 MA 图例一致——整块靠右对齐、点击切换显隐，数值跟随光标所在 K 线。
          // 数值带「万/亿」等中文单位，按中英文分别估宽，避免不同位数时相互重叠。
          const labelY = chart.margin.top + chart.mainH + chart.gap + 12;
          const items = VOL_MA_LINES.map((m) => {
            const val = chart[m.key] ? chart[m.key][clampedHoverIndex] : undefined;
            const label = `MA${m.period} ${Number.isFinite(val) ? formatNumber(val) : "-"}`;
            const textW = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 11 : 6.5), 0);
            return { m, label, advance: textW + 14 };
          });
          const total = items.reduce((sum, it) => sum + it.advance, 0);
          const startX = width - chart.margin.right - total + 8;
          return items.map(({ m, label }, idx) => {
            const on = visibleVolMAs.has(m.period);
            const x0 = startX + items.slice(0, idx).reduce((sum, it) => sum + it.advance, 0);
            return (
              <text
                key={`vol-ma-legend-${m.period}`}
                x={x0}
                y={labelY}
                fontSize="11"
                fill={m.color}
                opacity={on ? 1 : 0.35}
                fontWeight={on ? 700 : 400}
                textDecoration={on ? "none" : "line-through"}
                style={{ cursor: "pointer", userSelect: "none" }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVolMA(m.period);
                }}
              >
                {label}
              </text>
            );
          });
        })()}

        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdTop} y2={chart.macdTop} stroke="var(--chart-grid)" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdBase} y2={chart.macdBase} stroke="var(--chart-grid-soft)" strokeDasharray="4 4" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdTop + chart.macdH} y2={chart.macdTop + chart.macdH} stroke="var(--chart-grid)" />
        <text x="18" y={chart.macdTop + 14} fontSize="12" fill="var(--chart-ink-3)">MACD</text>
        <text x="64" y={chart.macdTop + 14} fontSize="12" fill="var(--chart-ink)">DIF</text>
        <text x="102" y={chart.macdTop + 14} fontSize="12" fill="#b59f00">DEA</text>
        <text x={width - chart.margin.right + 8} y={chart.macdTop + 12} fontSize="11" fill="var(--chart-ink-3)">+{chart.macdAbsMax.toFixed(2)}</text>
        <text x={width - chart.margin.right + 8} y={chart.macdBase + 4} fontSize="11" fill="var(--chart-ink-3)">0</text>
        <text x={width - chart.margin.right + 8} y={chart.macdTop + chart.macdH - 4} fontSize="11" fill="var(--chart-ink-3)">-{chart.macdAbsMax.toFixed(2)}</text>

        {chart.macdSeries.map((m, i) => {
          if (!Number.isFinite(m.hist)) return null;
          const cx = chart.x(i);
          const y0 = chart.macdY(0);
          const yh = chart.macdY(m.hist);
          const barY = Math.min(y0, yh);
          const barH = Math.max(1, Math.abs(yh - y0));
          const color = m.hist >= 0 ? "var(--chart-up)" : "var(--chart-down)";
          return <rect key={`macd-${i}`} x={cx - chart.candleW / 2} y={barY} width={chart.candleW} height={barH} fill={color} opacity="0.75" />;
        })}
        <path d={chart.makePath(chart.macdSeries.map((m) => m.dif), chart.macdY)} fill="none" stroke="var(--chart-ink)" strokeWidth="1.5" />
        <path d={chart.makePath(chart.macdSeries.map((m) => m.dea), chart.macdY)} fill="none" stroke="#b59f00" strokeWidth="1.3" />
        {showMacdSignals &&
          chart.macdCrosses.map((cross, idx) => {
            const cx = chart.x(cross.index);
            const cy = chart.macdY(cross.value);
            const isGolden = cross.type === "golden";
            const color = isGolden ? "var(--chart-up)" : "var(--chart-down)";
            const labelY = isGolden ? cy - 12 : cy + 18;
            const labelBoxY = isGolden ? labelY - 11 : labelY - 10;
            return (
              <g key={`macd-cross-${idx}-${cross.index}`}>
                <circle cx={cx} cy={cy} r="6" fill="var(--chart-chip-soft)" stroke={color} strokeWidth="2" />
                <rect x={cx - 16} y={labelBoxY} width="32" height="16" rx="8" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="1" />
                <text x={cx} y={labelY + 1} textAnchor="middle" fontSize="10" fontWeight="700" fill={color}>{cross.label}</text>
              </g>
            );
          })}
        {showMacdSignals &&
          chart.zeroAxisCrosses.map((cross, idx) => {
            const cx = chart.x(cross.index);
            const cy = chart.macdY(0);
            const isUp = cross.type === "zeroUp";
            const color = isUp ? "#2563eb" : "#7c3aed";
            const labelY = isUp ? cy - 28 : cy + 32;
            return (
              <g key={`macd-zero-cross-${idx}-${cross.index}`}>
                <line x1={cx} x2={cx} y1={cy - 7} y2={cy + 7} stroke={color} strokeWidth="2" />
                <rect x={cx - 19} y={labelY - 11} width="38" height="16" rx="8" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="1" />
                <text x={cx} y={labelY + 1} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{cross.label}</text>
              </g>
            );
          })}

        {Array.from({ length: xLabels }).map((_, i) => {
          const idx = xLabels === 1 ? 0 : Math.min(safeRows.length - 1, Math.round((safeRows.length - 1) * (i / (xLabels - 1))));
          return <text key={`x-${i}`} x={chart.x(idx)} y={height - 10} textAnchor="middle" fontSize="11" fill="var(--chart-ink-3)">{safeRows[idx].date.slice(5)}</text>;
        })}

        {guideIndex != null &&
          guideRow &&
          (() => {
            const gx = chart.x(guideIndex);
            const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${guideRow.date}T00:00:00Z`).getUTCDay()];
            const label = `${guideRow.date.split('-').join('/')} 周${weekday}`;
            const labelW = Math.max(76, label.length * 7 + 16);
            const labelH = 20;
            const minX = chart.margin.left;
            const maxX = width - chart.margin.right - labelW;
            const boxX = Math.max(minX, Math.min(gx - labelW / 2, maxX));
            const boxY = chart.macdTop + chart.macdH - labelH - 4;
            const selected = clampedSelectedIndex === guideIndex;
            const guidePositive = guideRow.close >= guideRow.open;
            return (
              <g>
                <line x1={gx} x2={gx} y1={chart.margin.top} y2={chart.macdTop + chart.macdH} stroke={selected ? "var(--chart-ink)" : "var(--chart-ink-3)"} strokeDasharray="3 3" opacity={selected ? "0.85" : "0.65"} />
                <circle cx={gx} cy={chart.y(guideRow.close)} r="3" fill={guidePositive ? "var(--chart-up)" : "var(--chart-down)"} />
                <rect x={boxX} y={boxY} width={labelW} height={labelH} rx="6" fill="var(--chart-surface)" stroke={selected ? "var(--chart-ink)" : "var(--chart-grid)"} />
                <text x={boxX + labelW / 2} y={boxY + 14} textAnchor="middle" fontSize="11" fill="var(--chart-ink-2)">{label}</text>
              </g>
            );
          })()}
        {priceGuide && (() => {
          const directionColor = priceGuide.pct > 0
            ? 'var(--chart-up)'
            : priceGuide.pct < 0
              ? 'var(--chart-down)'
              : 'var(--chart-ink-3)';
          const plotRight = width - chart.margin.right;
          const priceText = priceGuide.price.toFixed(2);
          const pctText = Number.isFinite(priceGuide.pct) ? `${priceGuide.pct >= 0 ? '+' : ''}${priceGuide.pct.toFixed(2)}%` : '—';
          return <g pointerEvents="none">
            <line
              x1={chart.margin.left}
              x2={plotRight}
              y1={priceGuide.y}
              y2={priceGuide.y}
              stroke="var(--chart-ink-3)"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.8"
            />
            <rect x="2" y={priceGuide.y - 10} width={chart.margin.left - 5} height="20" rx="2" fill={directionColor} />
            <text x={(chart.margin.left - 3) / 2} y={priceGuide.y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{priceText}</text>
            <rect x={plotRight + 3} y={priceGuide.y - 16} width={chart.margin.right - 6} height="32" rx="3" fill={directionColor} />
            <text x={plotRight + chart.margin.right / 2} y={priceGuide.y - 2} textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{priceText}</text>
            <text x={plotRight + chart.margin.right / 2} y={priceGuide.y + 11} textAnchor="middle" fontSize="10" fill="white">{pctText}</text>
          </g>;
        })()}
        </svg>
        <KlinePatternPopover selected={showPatterns ? selectedPattern : null} onClose={() => setSelectedPattern(null)} />
        <button
          type="button"
          className={`absolute right-2 top-4 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm backdrop-blur ${klineFaded ? "border-sky-300 bg-sky-50 text-sky-600 hover:bg-sky-100" : "border-slate-200 bg-white/98 text-slate-500 hover:border-slate-300 hover:bg-white hover:text-slate-700"}`}
          onClick={(e) => {
            e.stopPropagation();
            setKlineFaded((value) => !value);
          }}
          title={klineFaded ? "恢复K线显示" : "K线变透明，方便查看均线交叉"}
          aria-label={klineFaded ? "恢复K线显示" : "让K线变透明以查看均线交叉"}
        >
          {klineFaded ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        {klineFaded && (
          <button
            type="button"
            className={`absolute right-2 top-[52px] z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm backdrop-blur ${showMaCrosses ? "border-sky-300 bg-sky-50 text-sky-600 hover:bg-sky-100" : "border-slate-200 bg-white/98 text-slate-500 hover:border-slate-300 hover:bg-white hover:text-slate-700"}`}
            onClick={(e) => {
              e.stopPropagation();
              setShowMaCrosses((value) => !value);
            }}
            title={showMaCrosses ? "隐藏均线交叉标记" : "显示均线交叉标记"}
            aria-label={showMaCrosses ? "隐藏均线交叉标记" : "显示均线交叉标记"}
          >
            {showMaCrosses ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          className="absolute right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/98 text-slate-500 shadow-sm backdrop-blur hover:border-slate-300 hover:bg-white hover:text-slate-700"
          style={{ top: chart.margin.top + chart.mainH + chart.gap + 4 }}
          onClick={(e) => {
            e.stopPropagation();
            setShowVolMaCrosses((value) => !value);
          }}
          title={showVolMaCrosses ? "隐藏均量线金叉/死叉标记" : "显示均量线金叉/死叉标记"}
          aria-label={showVolMaCrosses ? "隐藏均量线金叉和死叉标记" : "显示均量线金叉和死叉标记"}
        >
          {showVolMaCrosses ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="absolute bottom-4 right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/98 text-slate-500 shadow-sm backdrop-blur hover:border-slate-300 hover:bg-white hover:text-slate-700"
          onClick={(e) => {
            e.stopPropagation();
            setShowMacdSignals((value) => !value);
          }}
          title={showMacdSignals ? "隐藏金叉/死叉标记" : "显示金叉/死叉标记"}
          aria-label={showMacdSignals ? "隐藏金叉和死叉标记" : "显示金叉和死叉标记"}
        >
          {showMacdSignals ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function MarkdownMessage({ children }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap">{children}</div>}>
      <AgentMarkdownMessage>{children}</AgentMarkdownMessage>
    </Suspense>
  );
}

const AGENT_WELCOME = {
  role: "assistant",
  content:
    "可以开始问股票相关问题。比如：**分析一下贵州茅台最近的趋势**，或者**帮我筛选新能源里趋势转强的公司**。",
};

function AgentChatPanel({ marketCodes }) {
  const [messages, setMessages] = useState([AGENT_WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  const quickPrompts = [
    "分析一下 600519 最近的趋势",
    "帮我找短线转强的 A 股",
    "解释一下当前 MACD 和九转信号",
    "总结一下 MSFT 的技术面",
  ];

  // 新消息或加载状态变化时，自动滚动到底部。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // 从对话里 Agent 实际调用过的工具，提取本次讨论过的标的与用过的工具。
  const { tickers, tools } = useMemo(() => {
    const tickerMap = new Map(); // code -> { code, name, market }
    const toolCount = new Map();
    for (const msg of messages) {
      for (const step of msg.steps || []) {
        toolCount.set(step.tool, (toolCount.get(step.tool) || 0) + 1);
        const code = step.code || step.args?.code || step.args?.symbol || "";
        if (!code) continue;
        const market = /^\d{6}$/.test(code) ? "A" : "US";
        const prev = tickerMap.get(code);
        tickerMap.set(code, { code, market, name: step.name || prev?.name || "" });
      }
    }
    return {
      tickers: [...tickerMap.values()].reverse(), // 最近讨论的排前面
      tools: [...toolCount.entries()].map(([name, count]) => ({ name, count })),
    };
  }, [messages]);

  async function sendMessage(value = input) {
    const text = String(value || "").trim();
    if (!text || loading) return;

    const userMessage = { role: "user", content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setLoading(true);

    try {
      // 只把 role/content 传给后端；同时把当前选中的标的作为上下文一起带上。
      const payload = history.map((m) => ({ role: m.role, content: m.content }));
      const res = await apiFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: payload,
          context: { ashare: marketCodes?.ashare || "", us: marketCodes?.us || "" },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `请求失败 (${res.status})`);
      }
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply, steps: data.steps }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `出错了：${error?.message || String(error)}`, isError: true },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function insertCode(code) {
    if (!code) return;
    setInput((v) => (v.trim() ? `${v.trim()} ${code}` : `分析一下 ${code} 最近的走势`));
  }

  const hasConversation = messages.length > 1;

  return (
    <div className="grid gap-4 lg:h-[calc(100vh-150px)] lg:min-h-[520px] lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex max-h-[360px] flex-col overflow-hidden rounded-2xl border bg-white p-4 shadow-sm lg:h-full lg:max-h-none">
        <div className="text-sm font-semibold text-slate-700">研究上下文</div>
        <div className="mt-4 flex-1 space-y-5 overflow-y-auto text-sm">
          {/* 本次对话讨论过的标的 */}
          <div>
            <div className="mb-2 text-xs font-medium text-slate-400">本次讨论的标的</div>
            {tickers.length === 0 ? (
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-400">
                还没有。提问后这里会列出 Agent 查过的股票。
              </div>
            ) : (
              <div className="space-y-2">
                {tickers.map((t) => (
                  <button
                    key={t.code}
                    type="button"
                    onClick={() => insertCode(t.code)}
                    title="点击插入到提问框"
                    className="flex w-full items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-left transition hover:bg-slate-100"
                  >
                    <span className="min-w-0">
                      <span className="font-semibold text-slate-800">{t.code}</span>
                      {t.name && <span className="ml-2 truncate text-xs text-slate-500">{t.name}</span>}
                    </span>
                    <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] text-slate-400">
                      {t.market === "A" ? "A股" : "美股"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 当前在 A股/美股 页选中的标的 */}
          {(marketCodes?.ashare || marketCodes?.us) && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-400">页面当前选中</div>
              <div className="flex flex-wrap gap-2">
                {marketCodes?.ashare && (
                  <button
                    type="button"
                    onClick={() => insertCode(marketCodes.ashare)}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    A股 {marketCodes.ashare}
                  </button>
                )}
                {marketCodes?.us && (
                  <button
                    type="button"
                    onClick={() => insertCode(marketCodes.us)}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    美股 {marketCodes.us}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 已调用的工具 */}
          {tools.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-400">已调用的工具</div>
              <div className="flex flex-wrap gap-1.5">
                {tools.map((t) => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500"
                  >
                    <Wrench className="h-3 w-3" />
                    {t.name}
                    {t.count > 1 && <span className="text-slate-400">×{t.count}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 shrink-0 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] leading-relaxed text-emerald-800">
          已接入后端 Agent，可调用行情、财务、因子、推荐与自选股回测等工具。模型由服务端密钥配置，不会暴露到浏览器。
        </div>
      </aside>

      <section className="flex h-[calc(100dvh-2rem)] min-h-[640px] flex-col overflow-hidden rounded-2xl border bg-white shadow-sm lg:h-full lg:min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-800">股票研究 Agent</div>
            <div className="text-xs text-slate-500">对话保留在当前页面，刷新后清空。</div>
          </div>
          <div className="flex items-center gap-2">
            {hasConversation && (
              <button
                type="button"
                onClick={() => setMessages([AGENT_WELCOME])}
                disabled={loading}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </button>
            )}
            <div className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-600">
              <Bot className="h-3.5 w-3.5" />
              已接入
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-slate-50/70 px-5 py-5">
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div key={`${message.role}-${index}`} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div className="flex min-w-0 max-w-[760px] flex-col gap-1">
                  {message.steps?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {message.steps.map((step, stepIndex) => (
                        <span
                          key={stepIndex}
                          className="inline-flex items-center gap-1 rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] text-slate-500"
                        >
                          <Wrench className="h-3 w-3" />
                          {step.tool}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    className={`min-w-0 break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                      isUser
                        ? "bg-slate-900 text-white"
                        : message.isError
                          ? "border border-red-200 bg-red-50 text-red-700"
                          : "border border-slate-100 bg-white text-slate-700"
                    }`}
                  >
                    {isUser ? (
                      <span className="whitespace-pre-line">{message.content}</span>
                    ) : (
                      <MarkdownMessage>{message.content}</MarkdownMessage>
                    )}
                  </div>
                </div>
                {isUser && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm">
                    <UserRound className="h-4 w-4" />
                  </div>
                )}
              </div>
            );
          })}
          {loading && (
            <div className="flex items-center gap-3">
              <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-4 py-3 text-sm text-slate-400 shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                思考中…
              </div>
            </div>
          )}
        </div>

        <div className="border-t bg-white p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => sendMessage(prompt)}
                disabled={loading}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:border-slate-300 hover:bg-white disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2 rounded-2xl border bg-slate-50 p-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              rows={2}
              placeholder="输入股票、行业、策略或财报问题（Enter 发送，Shift+Enter 换行）"
              className="max-h-40 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-slate-400"
            />
            <Button type="button" onClick={() => sendMessage()} disabled={!input.trim() || loading} className="h-10 rounded-xl px-3">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

const FACTOR_DETAIL_PERIODS = [
  { key: "t1",  label: "第1交易日收益" },
  { key: "t3",  label: "第3交易日收益" },
  { key: "t5",  label: "第5交易日收益" },
  { key: "t10", label: "第2周收益" },
  { key: "t20", label: "一月收益" },
  { key: "t40", label: "二月收益" },
  { key: "t60", label: "三月收益" },
];

async function fetchFactorDetail({ factors, startDate, endDate, page }) {
  const params = new URLSearchParams({ factor: factors.join(","), startDate, endDate, page: String(page) });
  const res = await apiFetch(`/api/factor-detail?${params}`, { cache: "no-store" });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

// 收藏夹回测：以每只票自己的收藏日为信号日，返回结构对齐 factor-detail。
async function fetchFavoritesBacktest({ market = "ashare", page, groups }) {
  const params = new URLSearchParams({ market, page: String(page) });
  // groups 为空数组 → 不传，后端按全部收藏夹处理。
  if (Array.isArray(groups) && groups.length) params.set("groups", groups.join(","));
  const res = await apiFetch(`/api/favorites-backtest?${params}`, { cache: "no-store" });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

// Derive a display label from a factor name, e.g. "factor7" -> "因子7".
function factorLabelFromName(name) {
  const m = /^factor(\d+)$/.exec(String(name));
  return m ? `因子${m[1]}` : String(name);
}

// Fetch the factor list for a status ("production" | "preliminary") from factor_dim.
async function fetchFactors(status, signal) {
  const params = new URLSearchParams({ status });
  const res = await apiFetch(`/api/factors?${params}`, { cache: "no-store", signal });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload.data; // [{ name, status, label }]
}

function ReturnCell({ value }) {
  if (value === null || value === undefined) {
    return <td className="px-3 py-2 text-center text-slate-300 text-xs">-</td>;
  }
  const isPos = value >= 0;
  return (
    <td className={`px-3 py-2 text-center font-mono text-xs ${isPos ? "text-red-500" : "text-emerald-600"}`}>
      {isPos ? "+" : ""}{value.toFixed(2)}%
    </td>
  );
}

const STATS_PERIODS = [
  { key: "t1",  label: "1日" },
  { key: "t3",  label: "3日" },
  { key: "t5",  label: "5日" },
  { key: "t10", label: "2周" },
  { key: "t20", label: "1月" },
  { key: "t60", label: "3月" },
];

function FactorStatsSummary({ stats, startDate, endDate, total }) {
  const parts = STATS_PERIODS
    .map(({ key, label }) => {
      const s = stats[key];
      if (!s || s.avg === null) return null;
      const avgSign = s.avg >= 0 ? "+" : "";
      const avgColor = s.avg >= 0 ? "text-red-500" : "text-emerald-600";
      return (
        <span key={key} className="inline-flex items-center gap-0.5">
          {label}&nbsp;<span className={`font-medium ${avgColor}`}>{avgSign}{s.avg.toFixed(2)}%</span>
          {s.winRate !== null && (
            <span className="text-slate-400">（胜率&nbsp;<span className="font-medium text-slate-600">{s.winRate.toFixed(1)}%</span>
              {s.n != null && <>&nbsp;·&nbsp;n={s.n}</>}）</span>
          )}
        </span>
      );
    })
    .filter(Boolean);

  if (parts.length === 0) return null;

  return (
    <span className="text-slate-500">
      {startDate} 至 {endDate}，共 {total} 条信号（非重叠口径，n=各持有期内同股去重后的独立样本数）&mdash;&nbsp;
      {parts.reduce((acc, el, i) => (i === 0 ? [el] : [...acc, <span key={`sep-${i}`} className="mx-1 text-slate-300">|</span>, el]), [])}
    </span>
  );
}

function FactorDetailPanel({ status = "production" }) {
  const [factorOptions, setFactorOptions] = useState([]); // [{ value, label }]
  const [factors, setFactors] = useState([]);
  const [favoritesMode, setFavoritesMode] = useState(false); // 选中「我的收藏夹」时为 true，与因子互斥
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(todayStr);
  const [query, setQuery] = useState(null); // {factors, startDate, endDate} — set on button click
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [favoriteCodeSet, setFavoriteCodeSet] = useState(() => new Set()); // 用于在因子结果里标记「已收藏」
  const [favoriteGroups, setFavoriteGroups] = useState(["默认"]); // 收藏夹列表（含默认）
  const [selectedFavGroups, setSelectedFavGroups] = useState([]); // 回测时选中的收藏夹（默认全选）
  const dropdownRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetchFavorites({ market: "ashare" })
      .then((payload) => {
        if (!alive) return;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setFavoriteCodeSet(new Set(items.map((it) => it.code)));
        const groups = Array.isArray(payload?.groups) && payload.groups.length ? payload.groups : ["默认"];
        setFavoriteGroups(groups);
      })
      .catch(() => { /* 拉取失败则不展示标记 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchFactors(status, ctrl.signal)
      .then((list) => {
        const options = list.map((f) => ({ value: f.name, label: f.label ?? factorLabelFromName(f.name) }));
        setFactorOptions(options);
        if (options.length) setFactors([options[0].value]);
      })
      .catch(() => { /* keep dropdown empty on failure */ });
    return () => ctrl.abort();
  }, [status]);

  useEffect(() => {
    if (!query) return;
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setError(null);
      try {
        const resultPayload = query.mode === "favorites"
          ? await fetchFavoritesBacktest({ market: "ashare", page, groups: query.groups })
          : await fetchFactorDetail({ factors: query.factors, startDate: query.startDate, endDate: query.endDate, page });
        if (active) setResult(resultPayload);
      } catch (e) {
        if (active && e.name !== "AbortError") setError(e?.message || "加载失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [query, page]);

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  function toggleFactor(value) {
    if (favoritesMode) {
      // 从收藏夹切回因子：退出收藏夹模式并只选中该因子
      setFavoritesMode(false);
      setFactors([value]);
      return;
    }
    setFactors((prev) =>
      prev.includes(value)
        ? prev.length > 1 ? prev.filter((f) => f !== value) : prev
        : [...prev, value],
    );
  }

  function selectFavorites() {
    setFavoritesMode(true); // 与因子互斥，仅切换模式（保留因子选择，下次点因子时恢复）
    setSelectedFavGroups(favoriteGroups); // 进入收藏夹模式默认全选所有夹
  }

  function toggleFavGroup(name) {
    setSelectedFavGroups((prev) =>
      prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name],
    );
  }

  function handleQuery() {
    setDropdownOpen(false);
    setPage(1);
    setResult(null);
    if (favoritesMode) {
      if (selectedFavGroups.length === 0) return; // 一个夹都没选，不查询
      // 全选时传空数组 → 后端按全部收藏夹回测。
      const groups = selectedFavGroups.length === favoriteGroups.length ? [] : selectedFavGroups;
      setQuery({ mode: "favorites", groups });
      return;
    }
    if (factors.length === 0) return;
    setQuery({ mode: "factors", factors, startDate, endDate });
  }

  const totalPages = result ? Math.ceil(result.total / result.pageSize) : 0;
  const showFactorCol = query && query.mode !== "favorites" && query.factors.length > 1;
  const isFavoritesResult = query && query.mode === "favorites";

  const factorLabelMap = useMemo(
    () => Object.fromEntries(factorOptions.map((o) => [o.value, o.label])),
    [factorOptions],
  );
  const factorLabel = favoritesMode
    ? "我的收藏夹"
    : factors.length === 0
      ? "选择因子"
      : factors.length === 1
        ? (factorLabelMap[factors[0]] ?? factors[0])
        : `已选 ${factors.length} 个因子`;

  return (
    <div className="space-y-4">
      <div className="text-base font-semibold text-slate-700">因子详情查询</div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none hover:border-slate-400"
          >
            <span>{factorLabel}</span>
            <svg className={`h-4 w-4 text-slate-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          {dropdownOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 min-w-[8rem] rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              {status === "production" && (
                <>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={favoritesMode}
                      onChange={selectFavorites}
                      className="h-4 w-4 accent-slate-800"
                    />
                    <span className="font-medium text-slate-800">我的收藏夹</span>
                  </label>
                  {favoritesMode && (
                    <div className="border-t border-slate-100 py-1">
                      <div className="px-3 pb-1 pt-1.5 text-[11px] text-slate-400">选择回测的收藏夹</div>
                      {favoriteGroups.map((g) => (
                        <label key={g} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 pl-6 text-sm hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={selectedFavGroups.includes(g)}
                            onChange={() => toggleFavGroup(g)}
                            className="h-4 w-4 accent-slate-800"
                          />
                          <span className="truncate text-slate-700">{g}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="my-1 border-t border-slate-100" />
                </>
              )}
              {factorOptions.map((o) => (
                <label key={o.value} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={!favoritesMode && factors.includes(o.value)}
                    onChange={() => toggleFactor(o.value)}
                    className="h-4 w-4 accent-slate-800"
                  />
                  <span className="text-slate-700">{o.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className={`flex min-w-0 flex-wrap items-center gap-2 ${favoritesMode ? "opacity-40" : ""}`}>
          <input
            type="date"
            value={startDate}
            max={endDate || todayStr()}
            disabled={favoritesMode}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 disabled:cursor-not-allowed"
          />
          <span className="text-slate-400 text-sm">至</span>
          <input
            type="date"
            value={endDate}
            min={startDate}
            max={todayStr()}
            disabled={favoritesMode}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 disabled:cursor-not-allowed"
          />
        </div>
        <div className={`flex flex-wrap items-center gap-1.5 ${favoritesMode ? "opacity-40" : ""}`}>
          {[
            { label: "近7天", days: 7 },
            { label: "近1个月", months: 1 },
            { label: "近2个月", months: 2 },
            { label: "近3个月", months: 3 },
          ].map((preset) => {
            const today = todayStr();
            const d = new Date();
            if (preset.days) d.setDate(d.getDate() - preset.days);
            else d.setMonth(d.getMonth() - preset.months);
            const from = d.toISOString().slice(0, 10);
            const active = !favoritesMode && startDate === from && endDate === today;
            return (
              <button
                key={preset.label}
                type="button"
                disabled={favoritesMode}
                onClick={() => { setStartDate(from); setEndDate(today); }}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed ${active ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900"}`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={handleQuery}
          disabled={loading || (favoritesMode ? selectedFavGroups.length === 0 : (!startDate || !endDate || factors.length === 0))}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "查询中…" : "查询"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-slate-50 px-4 py-2.5 text-xs text-slate-400 leading-5">
        <span className="min-w-0 break-words">收益率 = ( 第 N 交易日收盘价 &minus; 信号日收盘价 ) &divide; 信号日收盘价 &times; 100%</span>
        {result && result.stats && (
          <FactorStatsSummary stats={result.stats} startDate={result.startDate} endDate={result.endDate} total={result.total} />
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {result && (
        <>
          <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-500">
                  <th className="px-3 py-3 text-left font-medium whitespace-nowrap">{isFavoritesResult ? "收藏日" : "日期"}</th>
                  {showFactorCol && <th className="px-3 py-3 text-left font-medium whitespace-nowrap">因子</th>}
                  <th className="px-3 py-3 text-left font-medium whitespace-nowrap">代码</th>
                  <th className="px-3 py-3 text-left font-medium whitespace-nowrap">名称</th>
                  {FACTOR_DETAIL_PERIODS.map((p) => (
                    <th key={p.key} className="px-3 py-3 text-center font-medium whitespace-nowrap">{p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td colSpan={showFactorCol ? 11 : 10} className="py-12 text-center text-sm text-slate-400">
                      {isFavoritesResult ? "收藏夹为空，先去收藏一些股票吧" : "该时间段暂无信号数据"}
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row, i) => (
                    <tr key={`${row.signalDate}-${row.factorName}-${row.stockCode}-${i}`} className={`border-b border-slate-50 transition-colors hover:bg-slate-100/60 ${i % 2 === 0 ? "bg-white" : "bg-slate-50"}`}>
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{row.signalDate}</td>
                      {showFactorCol && (
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {factorLabelMap[row.factorName] ?? row.factorName}
                        </td>
                      )}
                      <td className="px-3 py-2 font-mono text-slate-700 whitespace-nowrap">{row.stockCode}</td>
                      <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {row.stockName}
                          {!isFavoritesResult && favoriteCodeSet.has(row.stockCode) && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-600" title="已收藏">
                              <Star className="h-2.5 w-2.5" fill="currentColor" />已收藏
                            </span>
                          )}
                        </span>
                      </td>
                      {FACTOR_DETAIL_PERIODS.map((p) => (
                        <ReturnCell key={p.key} value={row.returns[p.key]} />
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>共 {result.total} 条</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 hover:bg-slate-50"
                >
                  上一页
                </button>
                <span>{page} / {totalPages}</span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 hover:bg-slate-50"
                >
                  下一页
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const FACTOR_RETURN_PERIODS = [
  { key: "1d",  label: "近1天收益率",  forwardLabel: "第1天",  days: 1  },
  { key: "3d",  label: "近3天收益率",  forwardLabel: "前3天",  days: 3  },
  { key: "1w",  label: "近1周收益率",  forwardLabel: "前1周",  days: 7  },
  { key: "2w",  label: "近2周收益率",  forwardLabel: "前2周",  days: 14 },
  { key: "1m",  label: "近1月收益率",  forwardLabel: "前1月",  days: 30 },
  { key: "3m",  label: "近3月收益率",  forwardLabel: "前3月",  days: 90 },
];

function FactorBarChart({ data, label }) {
  const safeData = (Array.isArray(data) ? data : []).flatMap((item) => {
    const value = Number(item?.value);
    if (!item || !Number.isFinite(value)) return [];
    return [{ ...item, factor: String(item.factor || "-"), value }];
  });
  const maxAbs = Math.max(...safeData.map((d) => Math.abs(d.value)), 0.01);
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">{label}</div>
      <div className="space-y-2.5">
        {safeData.map((item) => {
          const isPos = item.value >= 0;
          const pct = (Math.abs(item.value) / maxAbs) * 100;
          return (
            <div
              key={item.factor}
              className="flex items-center gap-2 text-xs"
              title={item.sampleSize != null ? `非重叠独立样本 n=${item.sampleSize}` : undefined}
            >
              <div className="w-16 shrink-0 truncate text-right text-slate-500" title={item.factor}>{item.factor}</div>
              <div className="flex flex-1 items-center">
                <div className="flex flex-1 justify-end pr-px">
                  {!isPos && (
                    <div
                      className="h-5 rounded-l-sm bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>
                <div className="h-4 w-px shrink-0 bg-slate-300" />
                <div className="flex flex-1 pl-px">
                  {isPos && (
                    <div
                      className="h-5 rounded-r-sm bg-red-500"
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>
              </div>
              <div
                className={`w-16 shrink-0 text-right font-mono ${isPos ? "text-red-500" : "text-emerald-600"}`}
              >
                {isPos ? "+" : ""}{item.value.toFixed(2)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}

async function fetchFactorReturns(mode, startDate, signal, status = "production", force = false) {
  const params = new URLSearchParams({ mode, status });
  if (mode === "custom" && startDate) params.set("startDate", startDate);
  if (force) params.set("force", "1");
  const res = await apiFetch(`/api/factor-returns?${params}`, { cache: "no-store", signal });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("因子收益接口返回格式异常");
  }
  return Object.fromEntries(
    FACTOR_RETURN_PERIODS.map(({ key }) => [key, Array.isArray(payload.data[key]) ? payload.data[key] : []]),
  );
}

// 通达信「多空分野」风格的指数趋势图：粉色山形 K 线 + 一根 MA 线（价格低于 MA 的区段加深阴影）+ 下方 MACD 副图（0 轴下方阴影）。
// 视觉尽量还原效果图：viewBox 固定，外层用百分比定位叠加文字框。
const TREND_W = 1000;
const TREND_MARGIN = { top: 8, right: 56, bottom: 22, left: 10 };
const TREND_MAIN_H = 300;
const TREND_GAP = 30;
const TREND_MACD_H = 150;
const TREND_H = TREND_MARGIN.top + TREND_MAIN_H + TREND_GAP + TREND_MACD_H + TREND_MARGIN.bottom;

function IndexTrendChart({ rows, maPeriod, displayCount, name }) {
  const chart = useMemo(() => {
    const full = Array.isArray(rows) ? rows.filter((r) => r && Number.isFinite(r.close)) : [];
    if (full.length < 2) return null;
    // 先用完整数据算指标，再截取展示窗口，确保可见区第一根就有 MA/MACD 值（MA60 需 60 根预热，MACD 约 34 根）。
    const maFull = movingAverage(full, maPeriod);
    const ma120Full = movingAverage(full, 120);
    const macdFull = calcMACDSeries(full);
    const start = Math.max(0, full.length - (displayCount || full.length));
    const safe = full.slice(start);
    const ma = maFull.slice(start);
    const ma120 = ma120Full.slice(start);
    const macd = macdFull.slice(start);
    if (safe.length < 2) return null;

    const plotW = TREND_W - TREND_MARGIN.left - TREND_MARGIN.right;
    const mainTop = TREND_MARGIN.top;
    const mainBottom = mainTop + TREND_MAIN_H;
    const macdTop = mainBottom + TREND_GAP;
    const macdBottom = macdTop + TREND_MACD_H;

    let yMin = Infinity;
    let yMax = -Infinity;
    safe.forEach((r) => {
      yMin = Math.min(yMin, r.low);
      yMax = Math.max(yMax, r.high);
    });
    [...ma, ...ma120].forEach((v) => {
      if (Number.isFinite(v)) {
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    });
    const pad = (yMax - yMin) * 0.06 || 1;
    yMin -= pad;
    yMax += pad;

    const xStep = plotW / safe.length;
    const candleW = Math.max(1.4, Math.min(7, xStep * 0.62));
    const x = (i) => TREND_MARGIN.left + i * xStep + xStep / 2;
    const y = (price) => mainTop + ((yMax - price) / Math.max(yMax - yMin, 1e-6)) * TREND_MAIN_H;

    const maPath = ma
      .map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(ma[i - 1]) ? "L" : "M"}${x(i)},${y(v)}` : null))
      .filter(Boolean)
      .join(" ");
    const ma120Path = ma120
      .map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(ma120[i - 1]) ? "L" : "M"}${x(i)},${y(v)}` : null))
      .filter(Boolean)
      .join(" ");

    // MA(maPeriod) 与 MA120 的交汇点：上穿/下穿都标为「交叉」，醒目提示均线缠绕。
    const maCrosses = [];
    for (let i = 1; i < safe.length; i += 1) {
      const prevA = ma[i - 1];
      const prevB = ma120[i - 1];
      const currA = ma[i];
      const currB = ma120[i];
      if (![prevA, prevB, currA, currB].every(Number.isFinite)) continue;
      const wasAbove = prevA > prevB;
      const isAbove = currA > currB;
      if (wasAbove !== isAbove) {
        maCrosses.push({ index: i, type: isAbove ? "up" : "down", value: currA });
      }
    }

    // 阴影：收盘价低于 MA 的区段（多空分野里“MA 线下方”）。
    const belowSegs = [];
    let seg = null;
    ma.forEach((v, i) => {
      const c = safe[i]?.close;
      const below = Number.isFinite(v) && Number.isFinite(c) && c < v;
      if (below) {
        if (!seg) seg = [];
        seg.push(i);
      } else if (seg) {
        belowSegs.push(seg);
        seg = null;
      }
    });
    if (seg) belowSegs.push(seg);
    const belowPaths = belowSegs
      .filter((s) => s.length > 1)
      .map((s) => {
        const top = s.map((i) => `${x(i)},${y(ma[i])}`).join(" L");
        const bottom = s.slice().reverse().map((i) => `${x(i)},${y(safe[i].close)}`).join(" L");
        return `M${top} L${bottom} Z`;
      });

    // 中长期多头阴影：MA(短) 由下向上穿 MA120（金叉）到由上向下穿 MA120（死叉）的区段，
    // 即 MA(短) 持续在 MA120 之上的区间，用红色填充两线之间，对应“宜做多”的区域。
    const bullishPaths = [];
    if (maPeriod === 60) {
      const above = ma.map((v, i) =>
        Number.isFinite(v) && Number.isFinite(ma120[i]) ? v > ma120[i] : null,
      );
      // 两线在 i-1 与 i 之间的相交点（金叉/死叉处），让阴影在交叉点收口。
      const crossPoint = (i) => {
        const dPrev = ma[i - 1] - ma120[i - 1];
        const dCurr = ma[i] - ma120[i];
        const denom = dPrev - dCurr;
        const t = denom === 0 ? 0 : dPrev / denom;
        const vx = x(i - 1) + t * (x(i) - x(i - 1));
        const vy = y(ma[i - 1] + t * (ma[i] - ma[i - 1]));
        return { x: vx, y: vy };
      };
      const bullSegs = [];
      let bseg = null;
      above.forEach((flag, i) => {
        if (flag === true) {
          if (!bseg) bseg = [];
          bseg.push(i);
        } else if (bseg) {
          bullSegs.push(bseg);
          bseg = null;
        }
      });
      if (bseg) bullSegs.push(bseg);
      bullSegs.forEach((s) => {
        const first = s[0];
        const last = s[s.length - 1];
        const pts = [];
        // 左边界：金叉相交点（仅当前一根确实在下方时才插值，避免数据开头误判）。
        if (first > 0 && above[first - 1] === false) pts.push(crossPoint(first));
        // 上沿：沿 MA(短)。
        s.forEach((i) => pts.push({ x: x(i), y: y(ma[i]) }));
        // 右边界：死叉相交点。
        if (last < ma.length - 1 && above[last + 1] === false) pts.push(crossPoint(last + 1));
        // 下沿：沿 MA120 反向回到起点。
        s.slice()
          .reverse()
          .forEach((i) => pts.push({ x: x(i), y: y(ma120[i]) }));
        if (pts.length < 3) return;
        bullishPaths.push(pts.map((p, idx) => `${idx ? "L" : "M"}${p.x},${p.y}`).join(" ") + " Z");
      });
    }

    // 价格轴刻度。
    const priceTicks = Array.from({ length: 5 }, (_, k) => {
      const v = yMin + ((yMax - yMin) * k) / 4;
      return { v, y: y(v) };
    });

    // 日期轴刻度。
    const dateTicks = [];
    const dateCount = 6;
    for (let k = 0; k < dateCount; k += 1) {
      const i = Math.round((safe.length - 1) * (k / (dateCount - 1)));
      dateTicks.push({ x: x(i), label: (safe[i]?.date || "").slice(2) });
    }

    // MACD 面板。
    let mMin = 0;
    let mMax = 0;
    macd.forEach((m) => {
      [m.dif, m.dea, m.hist].forEach((v) => {
        if (Number.isFinite(v)) {
          mMin = Math.min(mMin, v);
          mMax = Math.max(mMax, v);
        }
      });
    });
    const mPad = (mMax - mMin) * 0.1 || 1;
    mMin -= mPad;
    mMax += mPad;
    const my = (v) => macdTop + ((mMax - v) / Math.max(mMax - mMin, 1e-6)) * TREND_MACD_H;
    const zeroY = my(0);
    const difPath = macd
      .map((m, i) => (Number.isFinite(m.dif) ? `${i && Number.isFinite(macd[i - 1]?.dif) ? "L" : "M"}${x(i)},${my(m.dif)}` : null))
      .filter(Boolean)
      .join(" ");
    const deaPath = macd
      .map((m, i) => (Number.isFinite(m.dea) ? `${i && Number.isFinite(macd[i - 1]?.dea) ? "L" : "M"}${x(i)},${my(m.dea)}` : null))
      .filter(Boolean)
      .join(" ");
    // 0 轴下方阴影：DIF 低于 0 的区段填充到 0 轴。
    const difBelowSegs = [];
    let dseg = null;
    macd.forEach((m, i) => {
      if (Number.isFinite(m.dif) && m.dif < 0) {
        if (!dseg) dseg = [];
        dseg.push(i);
      } else if (dseg) {
        difBelowSegs.push(dseg);
        dseg = null;
      }
    });
    if (dseg) difBelowSegs.push(dseg);
    const difBelowPaths = difBelowSegs
      .filter((s) => s.length > 1)
      .map((s) => {
        const top = s.map((i) => `${x(i)},${my(macd[i].dif)}`).join(" L");
        return `M${x(s[0])},${zeroY} L${top} L${x(s[s.length - 1])},${zeroY} Z`;
      });

    const lastMa = [...ma].reverse().find(Number.isFinite) ?? null;
    const lastMa120 = [...ma120].reverse().find(Number.isFinite) ?? null;
    const lastMacd = [...macd].reverse().find((m) => Number.isFinite(m?.dif) && Number.isFinite(m?.dea)) ?? null;

    return {
      safe, ma, macd, x, y, my, zeroY, candleW, mainBottom, macdTop, macdBottom,
      maPath, ma120Path, maCrosses, belowPaths, bullishPaths, difPath, deaPath, difBelowPaths, priceTicks, dateTicks,
      lastMa, lastMa120, lastMacd,
    };
  }, [rows, maPeriod, displayCount]);

  if (!chart) {
    return <div className="flex h-[360px] items-center justify-center text-sm text-slate-400">暂无数据</div>;
  }

  return (
    <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} className="block w-full">
      {/* 面板边框 */}
      <rect x={TREND_MARGIN.left} y={TREND_MARGIN.top} width={TREND_W - TREND_MARGIN.left - TREND_MARGIN.right} height={TREND_MAIN_H} fill="none" stroke="var(--chart-grid)" />
      <rect x={TREND_MARGIN.left} y={chart.macdTop} width={TREND_W - TREND_MARGIN.left - TREND_MARGIN.right} height={TREND_MACD_H} fill="none" stroke="var(--chart-grid)" />

      {/* 中长期多头阴影：MA(短) 在 MA120 之上（金叉到死叉）的区间，红色填充两线之间“宜做多”。 */}
      {chart.bullishPaths.map((d, i) => (
        <path key={`bull-${i}`} d={d} fill="var(--chart-up)" opacity="0.18" />
      ))}

      {/* 主图：收盘价跌破 MA 的弱势区间阴影（沿用 app 绿色弱势语义） */}
      {chart.belowPaths.map((d, i) => (
        <path key={`below-${i}`} d={d} fill="var(--chart-down)" opacity="0.10" />
      ))}

      {/* 价格刻度线 + 标签 */}
      {chart.priceTicks.map((t, i) => (
        <g key={`pt-${i}`}>
          <line x1={TREND_MARGIN.left} x2={TREND_W - TREND_MARGIN.right} y1={t.y} y2={t.y} stroke="var(--chart-grid-soft)" />
          <text x={TREND_W - TREND_MARGIN.right + 4} y={t.y + 3} fontSize="11" fill="var(--chart-muted)">{t.v.toFixed(0)}</text>
        </g>
      ))}

      {/* K 线：红涨（实心）/ 绿跌（空心），与主图保持一致 */}
      {chart.safe.map((r, i) => {
        const up = r.close >= r.open;
        const color = up ? "var(--chart-up)" : "var(--chart-down)";
        const yHigh = chart.y(r.high);
        const yLow = chart.y(r.low);
        const yOpen = chart.y(r.open);
        const yClose = chart.y(r.close);
        const top = Math.min(yOpen, yClose);
        const bodyH = Math.max(0.8, Math.abs(yClose - yOpen));
        return (
          <g key={r.date}>
            <line x1={chart.x(i)} x2={chart.x(i)} y1={yHigh} y2={yLow} stroke={color} strokeWidth="0.7" />
            <rect
              x={chart.x(i) - chart.candleW / 2}
              y={top}
              width={chart.candleW}
              height={bodyH}
              fill={up ? color : "var(--chart-surface)"}
              stroke={color}
              strokeWidth="0.7"
            />
          </g>
        );
      })}

      {/* MA 线（与主图 MA60 同色） */}
      <path d={chart.maPath} fill="none" stroke="#009688" strokeWidth="1.4" />
      {/* MA120 线（仅中长期展示，与主图 MA120 同色） */}
      {maPeriod === 60 && <path d={chart.ma120Path} fill="none" stroke="#e91e63" strokeWidth="1.4" />}
      {/* MA60 与 MA120 交叉标记（仅中长期展示） */}
      {maPeriod === 60 &&
        chart.maCrosses.map((cross, idx) => {
        const cx = chart.x(cross.index);
        const cy = chart.y(cross.value);
        // up = 短期均线上穿 MA120（金叉，偏多，红）；down = 下穿（死叉，偏空，绿）。
        const isUp = cross.type === "up";
        const color = isUp ? "var(--chart-up)" : "var(--chart-down)";
        const label = isUp ? "金叉" : "死叉";
        const labelY = isUp ? cy - 11 : cy + 16;
        const labelBoxY = isUp ? labelY - 10 : labelY - 9;
        return (
          <g key={`trend-ma-cross-${idx}-${cross.index}`}>
            <circle cx={cx} cy={cy} r="5" fill="var(--chart-chip)" stroke={color} strokeWidth="1.6" />
            <rect x={cx - 14} y={labelBoxY} width="28" height="14" rx="7" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="0.8" />
            <text x={cx} y={labelY + 1} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{label}</text>
          </g>
        );
      })}

      {/* 日期标签 */}
      {chart.dateTicks.map((t, i) => (
        <text key={`dt-${i}`} x={t.x} y={TREND_H - 6} fontSize="11" fill="var(--chart-muted)" textAnchor="middle">{t.label}</text>
      ))}

      {/* MACD：0 轴下方阴影 + 柱 + DIF/DEA */}
      {chart.difBelowPaths.map((d, i) => (
        <path key={`mb-${i}`} d={d} fill="var(--chart-down)" opacity="0.10" />
      ))}
      <line x1={TREND_MARGIN.left} x2={TREND_W - TREND_MARGIN.right} y1={chart.zeroY} y2={chart.zeroY} stroke="var(--chart-grid-soft)" strokeDasharray="4 4" />
      {chart.macd.map((m, i) =>
        Number.isFinite(m.hist) ? (
          <line
            key={`h-${i}`}
            x1={chart.x(i)}
            x2={chart.x(i)}
            y1={chart.zeroY}
            y2={chart.my(m.hist)}
            stroke={m.hist >= 0 ? "var(--chart-up)" : "var(--chart-down)"}
            strokeWidth={Math.max(0.8, chart.candleW * 0.5)}
            opacity="0.75"
          />
        ) : null,
      )}
      <path d={chart.difPath} fill="none" stroke="var(--chart-ink)" strokeWidth="1.2" />
      <path d={chart.deaPath} fill="none" stroke="#b59f00" strokeWidth="1.1" />

      {/* 主图图例：指数名（日线）+ 当前 MA 值。白色描边做底，保证压在 K 线上也清晰。 */}
      <text
        x={TREND_MARGIN.left + 4}
        y={TREND_MARGIN.top + 15}
        fontSize="14"
        fontWeight="600"
        stroke="var(--chart-surface)"
        strokeWidth="3"
        paintOrder="stroke"
        fill="var(--chart-ink-2)"
      >
        <tspan fill="var(--chart-ink-2)">{`${name || ""}（日线）  `}</tspan>
        <tspan fill="#009688">{`MA${maPeriod}：${chart.lastMa != null ? chart.lastMa.toFixed(2) : "--"}${maPeriod === 60 ? "  " : ""}`}</tspan>
        {maPeriod === 60 && (
          <tspan fill="#e91e63">{`MA120：${chart.lastMa120 != null ? chart.lastMa120.toFixed(2) : "--"}`}</tspan>
        )}
      </text>

      {/* MACD 副图图例：参数 + 当前 DIF / DEA / MACD（柱）值。 */}
      <text x={TREND_MARGIN.left + 4} y={chart.macdTop + 15} fontSize="13" stroke="var(--chart-surface)" strokeWidth="3" paintOrder="stroke">
        <tspan fill="var(--chart-ink-2)">MACD(12,26,9)  </tspan>
        <tspan fill="var(--chart-ink)">DIF：{chart.lastMacd?.dif != null ? chart.lastMacd.dif.toFixed(2) : "--"}  </tspan>
        <tspan fill="#b59f00">DEA：{chart.lastMacd?.dea != null ? chart.lastMacd.dea.toFixed(2) : "--"}  </tspan>
        <tspan fill="var(--chart-up)">MACD：{chart.lastMacd?.hist != null ? chart.lastMacd.hist.toFixed(2) : "--"}</tspan>
      </text>
    </svg>
  );
}

function IndexTrendCard({ index, tab, year = "latest" }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 回看历史年份时要取到足够早的数据：从该年到今年的交易日 + 预热缓冲。
  const fetchLimit = useMemo(() => {
    if (year === "latest") return 500;
    const span = new Date().getFullYear() - Number(year) + 2;
    return Math.min(6000, Math.max(500, span * 260));
  }, [year]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetchIndexKline({ secid: index.secid, tencentSymbol: index.tencentSymbol, name: index.name, limit: fetchLimit });
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setError(e?.message || "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index.secid, index.tencentSymbol, index.name, fetchLimit]);

  // 展示窗口 + 预热缓冲：图表内部只渲染最后 displayCount 根，但喂入的数据多带 MA+MACD 预热，
  // 这样可见区第一根就有 MA/MACD 值，均线从最左边开始。
  const warmup = tab.ma + 40;
  const { feedRows, displayCount, hasYearData } = useMemo(() => {
    const all = data?.klines || [];
    if (!all.length) return { feedRows: [], displayCount: 0, hasYearData: true };

    if (year === "latest") {
      const disp = tab.ma >= 60 ? 250 : 140;
      return { feedRows: all.slice(-(disp + warmup)), displayCount: Math.min(disp, all.length), hasYearData: true };
    }

    // 指定年份：取该年全部交易日，前面再补一段预热。
    const prefix = String(year);
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < all.length; i += 1) {
      if (String(all[i].date).startsWith(prefix)) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1) return { feedRows: [], displayCount: 0, hasYearData: false };
    return {
      feedRows: all.slice(Math.max(0, firstIdx - warmup), lastIdx + 1),
      displayCount: lastIdx - firstIdx + 1,
      hasYearData: true,
    };
  }, [data, tab.ma, warmup, year]);

  const latest = feedRows[feedRows.length - 1];

  // 结论按窗口最后一根（最新年份为今天，历史年份为该年最后一个交易日）判定多头三条件。
  const trend = useMemo(() => evalTrend(feedRows, tab.ma), [feedRows, tab.ma]);

  return (
    <Card className="rounded-2xl border-slate-200">
      <CardContent className="p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-slate-800">{index.name}</span>
            <span className="text-xs text-slate-400">{index.code}</span>
            {trend ? (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  trend.isBull ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"
                }`}
                title={`CLOSE>MA${tab.ma}：${trend.c1 ? "✓" : "✗"}  MA${tab.ma} 向上：${trend.c2 ? "✓" : "✗"}  DIF>0：${trend.c3 ? "✓" : "✗"}`}
              >
                {trend.isBull ? `${tab.term}多头趋势` : `非${tab.term}多头趋势`}
              </span>
            ) : null}
          </div>
          {latest ? (
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold text-slate-800">{latest.close.toFixed(2)}</span>
              <span className={`text-xs ${latest.pct >= 0 ? "text-red-600" : "text-green-700"}`}>
                {Number.isFinite(latest.pct) ? `${latest.pct >= 0 ? "+" : ""}${latest.pct.toFixed(2)}%` : "-"}
              </span>
            </div>
          ) : null}
        </div>

        {/* 三个条件逐项命中情况 */}
        {trend ? (
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className={trend.c1 ? "text-red-600" : ""}>{trend.c1 ? "✓" : "✗"} CLOSE &gt; MA{tab.ma}</span>
            <span className={trend.c2 ? "text-red-600" : ""}>{trend.c2 ? "✓" : "✗"} MA{tab.ma} &gt; MA{tab.ma}[1]</span>
            <span className={trend.c3 ? "text-red-600" : ""}>{trend.c3 ? "✓" : "✗"} DIF &gt; 0</span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-[360px] items-center justify-center text-sm text-slate-400">加载中…</div>
        ) : error ? (
          <div className="flex h-[360px] items-center justify-center px-4 text-center text-sm text-rose-500">{error}</div>
        ) : !hasYearData ? (
          <div className="flex h-[360px] items-center justify-center px-4 text-center text-sm text-slate-400">{year} 年暂无该指数数据</div>
        ) : (
          <IndexTrendChart rows={feedRows} maPeriod={tab.ma} displayCount={displayCount} name={index.name} />
        )}
      </CardContent>
    </Card>
  );
}

// 多板块主力净流入累计曲线（仿截图）：左侧 Y 轴(亿)，右侧每条线在末端标注名称+数值，0 轴高亮。
function FundflowChart({ series }) {
  const width = 1000;
  const height = 560;
  const margin = { top: 20, right: 132, bottom: 28, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const layout = useMemo(() => {
    const lines = (series || []).filter((s) => Array.isArray(s.points) && s.points.length >= 2);
    if (!lines.length) return null;

    const maxLen = Math.max(...lines.map((s) => s.points.length));
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const s of lines) {
      for (const p of s.points) {
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return null;
    if (vMin > 0) vMin = 0;
    if (vMax < 0) vMax = 0;
    const pad = (vMax - vMin) * 0.05 || 1;
    vMin -= pad;
    vMax += pad;

    const x = (i, len) => margin.left + (len <= 1 ? 0 : (i / (len - 1)) * plotW);
    const y = (v) => margin.top + (1 - (v - vMin) / (vMax - vMin)) * plotH;

    // 颜色：按排序后位置在色相环上均匀取色，红涨绿跌的直觉这里不强求（多条线靠色相区分）。
    const palette = lines.map((_, i) => `hsl(${Math.round((i * 360) / lines.length)}, 70%, 55%)`);

    const drawn = lines.map((s, idx) => {
      const len = s.points.length;
      // 先映射成像素坐标，再用平滑样条连线：周/月只有 5/21 个日度点，直接连直线会很折，平滑后顺滑。
      const pts = s.points.map((p, i) => ({ x: x(i, len), y: y(p.v) }));
      const d = smoothLinePath(pts);
      return { ...s, color: palette[idx], d, endY: pts[len - 1].y, endX: pts[len - 1].x };
    });

    // 右侧标签防重叠：按末值从高到低，自上而下贪心下推，至少间隔 15px。
    const labels = drawn
      .map((s) => ({ name: s.name, final: s.final, color: s.color, y: s.endY }))
      .sort((a, b) => a.y - b.y);
    const minGap = 15;
    for (let i = 1; i < labels.length; i += 1) {
      if (labels[i].y - labels[i - 1].y < minGap) labels[i].y = labels[i - 1].y + minGap;
    }
    // 若整体被推出底部，再整体上移。
    const overflow = labels.length ? labels[labels.length - 1].y - (margin.top + plotH) : 0;
    if (overflow > 0) for (const l of labels) l.y -= overflow;

    // Y 轴刻度（含 0）。
    const ticks = [];
    const step = niceStep((vMax - vMin) / 5);
    const start = Math.ceil(vMin / step) * step;
    for (let v = start; v <= vMax; v += step) ticks.push(v);

    // X 轴时间刻度：均匀取 5 个点的 t（取 HH:MM 或日期尾段）。
    const ref = lines.reduce((a, b) => (b.points.length > a.points.length ? b : a), lines[0]);
    const xticks = [];
    const n = ref.points.length;
    for (let k = 0; k < 5; k += 1) {
      const i = Math.round((k / 4) * (n - 1));
      const raw = String(ref.points[i].t);
      const t = raw.includes(" ") ? raw.split(" ")[1]?.slice(0, 5) : raw.slice(5); // 盘中显示 HH:MM，日线显示 MM-DD
      xticks.push({ x: x(i, n), label: t || raw });
    }

    return { drawn, labels, ticks, xticks, y, vMin, vMax, maxLen };
  }, [series, plotW, plotH, margin.left, margin.top]);

  if (!layout) {
    return <div className="flex h-64 items-center justify-center text-sm text-slate-400">暂无资金流数据</div>;
  }

  const zeroY = layout.y(0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 620 }}>
      {/* Y 轴刻度线 + 标签 */}
      {layout.ticks.map((v) => {
        const yy = layout.y(v);
        return (
          <g key={`yt-${v}`}>
            <line x1={margin.left} x2={width - margin.right} y1={yy} y2={yy} stroke="var(--chart-grid-soft)" strokeWidth="1" />
            <text x={margin.left - 6} y={yy + 3} textAnchor="end" fontSize="11" fill="var(--chart-muted)">
              {v.toFixed(0)}亿
            </text>
          </g>
        );
      })}
      {/* 0 轴 */}
      <line x1={margin.left} x2={width - margin.right} y1={zeroY} y2={zeroY} stroke="var(--chart-grid)" strokeWidth="1.5" />
      {/* X 轴时间刻度 */}
      {layout.xticks.map((t, i) => (
        <text key={`xt-${i}`} x={t.x} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--chart-muted)">
          {t.label}
        </text>
      ))}
      {/* 折线 */}
      {layout.drawn.map((s) => (
        <path key={s.code} d={s.d} fill="none" stroke={s.color} strokeWidth="1.6" opacity="0.9" />
      ))}
      {/* 右侧名称 + 数值标签 */}
      {layout.labels.map((l, i) => (
        <text key={`lb-${i}`} x={width - margin.right + 6} y={l.y + 3} fontSize="11" fill={l.color}>
          {l.name} {l.final >= 0 ? "+" : ""}
          {l.final.toFixed(1)}
        </text>
      ))}
    </svg>
  );
}

// 用 Catmull-Rom 样条把离散点连成平滑曲线（转成三次贝塞尔）。点少（周 5 个 / 月 21 个）时尤其有用。
function smoothLinePath(pts) {
  if (!pts || !pts.length) return "";
  if (pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * pow;
}

const FUNDFLOW_CLIENT_CACHE_PREFIX = "board-fundflow:query:v2:";
const fundflowClientCache = new Map();

function fundflowShanghaiToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function fundflowCacheKey(dim, date) {
  return `${dim}:${date || "latest"}`;
}

function readFundflowClientCache(dim, date) {
  const key = fundflowCacheKey(dim, date);
  const maxAge = date && date < fundflowShanghaiToday() ? 24 * 60 * 60 * 1000 : dim === "day" ? 2 * 60 * 1000 : 10 * 60 * 1000;
  const usable = (entry) => entry && Date.now() >= entry.at && Date.now() - entry.at < maxAge
    && (!date ? new Date(entry.at + 8 * 3600000).toISOString().slice(0, 10) === fundflowShanghaiToday() : true)
    && !entry.body?.stale && Array.isArray(entry.body?.series) && entry.body.series.length > 0;
  const memory = fundflowClientCache.get(key);
  if (usable(memory)) return memory.body;
  try {
    const cached = JSON.parse(sessionStorage.getItem(`${FUNDFLOW_CLIENT_CACHE_PREFIX}${key}`) || "null");
    if (usable(cached)) {
      fundflowClientCache.set(key, cached);
      return cached.body;
    }
  } catch {
    // 隐私模式或存储空间不足时继续使用网络请求。
  }
  return null;
}

function writeFundflowClientCache(dim, date, body) {
  if (body?.stale || !Array.isArray(body?.series) || !body.series.length) return;
  const key = fundflowCacheKey(dim, date);
  const cached = { body, at: Date.now() };
  fundflowClientCache.set(key, cached);
  try {
    sessionStorage.setItem(`${FUNDFLOW_CLIENT_CACHE_PREFIX}${key}`, JSON.stringify(cached));
  } catch {
    // 内存缓存仍然可用。
  }
}

function FundflowDivergencePanel() {
  const [dim, setDim] = useState("day");
  const [date, setDate] = useState(""); // 空 = 最新交易日
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const displayedPayloadRef = useRef(null);

  const todayStr = fundflowShanghaiToday();

  useEffect(() => {
    let cancelled = false;
    const cached = reloadKey === 0 ? readFundflowClientCache(dim, date) : null;
    const queryKey = fundflowCacheKey(dim, date);
    const previous = displayedPayloadRef.current?.key === queryKey ? displayedPayloadRef.current.body : null;
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (cached) {
        setPayload(cached);
        displayedPayloadRef.current = {key: queryKey, body: cached};
        setLoading(false);
        setError("");
        return;
      }
      setPayload(previous);
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({dim, top: "12"});
        if (date) params.set("date", date);
        if (reloadKey > 0) params.set("retry", "1");
        const res = await apiFetch(`/api/board-fundflow?${params}`);
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `加载失败（${res.status}）`);
        if (!cancelled) {
          writeFundflowClientCache(dim, date, body);
          setPayload(body);
          displayedPayloadRef.current = {key: queryKey, body};
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || "加载失败");
          if (previous?.series?.length) setPayload({...previous, stale: true});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dim, date, reloadKey]);

  const dimLabel = FUNDFLOW_DIMS.find((d) => d.value === dim)?.label || "日";
  // 日维度选了历史日期，但盘中分钟仅当日可用 → 给出明确提示。
  const dayHistoryUnsupported = dim === "day" && date && date !== todayStr && !payload?.series?.length;
  const hasData = Boolean(payload?.series?.length);
  const snapshot = payload?.mode === "daily-snapshot";
  const sourceLabel = payload?.source === "sina" ? "新浪" : "东方财富";
  const dataAsOf = payload?.asOf || payload?.dataDate || payload?.series?.[0]?.points?.at(-1)?.t;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
            {FUNDFLOW_DIMS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => { if (dim !== d.value) { setDim(d.value); setReloadKey(0); } }}
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  dim === d.value ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-900"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>日期</span>
            <input
              type="date"
              value={date}
              max={todayStr}
              onChange={(e) => { setDate(e.target.value); setReloadKey(0); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 outline-none"
            />
            {date ? (
              <button
                type="button"
                onClick={() => { setDate(""); setReloadKey(0); }}
                className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                title="回到最新交易日"
              >
                最新
              </button>
            ) : null}
          </label>
          <button
            type="button"
            disabled={loading}
            onClick={() => setReloadKey((value) => value + 1)}
            className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-600 disabled:opacity-50"
          >
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
        <div className="text-xs text-slate-400">
          {snapshot ? "概念板块单日主力净流入快照（亿）" : `概念板块${dimLabel}内主力资金净流入累计（亿）`}，取净流入排名两端各 12 个板块。
        </div>
      </div>

      <Card className="rounded-2xl border-slate-200">
        <CardContent className="p-4">
          {hasData && <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>来源：{sourceLabel}{snapshot ? " · 新浪统计口径" : ""}</span>
            {dataAsOf && <span>数据截至 {dataAsOf}</span>}
            {payload.coverage && payload.coverage.available < payload.coverage.total && <span>有效板块 {payload.coverage.available}/{payload.coverage.total}</span>}
          </div>}
          {hasData && (snapshot || payload.stale || error) && <div role="status" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
            {payload.stale ? "数据源刷新失败，当前显示最近一次有效缓存，暂非实时行情。" : payload.notice || "日内曲线暂不可用，当前展示新浪单日主力净流入快照。"}
            {payload.stale && snapshot && " 缓存为新浪单日快照。"}
          </div>}
          {loading && !hasData ? (
            <div className="flex h-64 items-center justify-center text-sm text-slate-400">资金流加载中…</div>
          ) : error && !hasData ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-rose-500">
              <div>资金流数据源暂不可用，请稍后重试，或查看周、月维度。</div>
              <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="rounded-lg border px-3 py-1.5 text-slate-600">重试</button>
            </div>
          ) : dayHistoryUnsupported ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-400">
              <div>东方财富的「日内分钟」资金流只保留当天，历史日期没有盘中曲线。</div>
              <div>查看 {date} 的资金流分化，请切换到「周」或「月」维度。</div>
            </div>
          ) : !payload?.series?.length ? (
            <div className="flex h-64 items-center justify-center px-4 text-center text-sm text-slate-400">
              暂无可用资金流数据，可重试或查看周、月维度。
            </div>
          ) : snapshot ? (
            <FundflowSnapshot series={payload.series} />
          ) : (
            <FundflowChart series={payload.series} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FundflowSnapshot({series}) {
  const max = Math.max(...series.map((line) => Math.abs(line.final)), 1);
  return <div className="overflow-x-auto">
    <table aria-label="新浪单日主力净流入快照" className="w-full text-sm">
      <thead><tr className="border-b text-left text-xs text-slate-500">
        <th className="py-2 font-medium">概念板块</th>
        <th className="py-2 text-right font-medium">主力净流入（亿）</th>
        <th className="w-1/3 py-2 pl-4 font-medium">金额对比</th>
      </tr></thead>
      <tbody>{series.map((line) => <tr key={line.code} className="border-b border-slate-100 last:border-0">
        <td className="py-2 pr-3">{line.name}</td>
        <td className={`whitespace-nowrap py-2 text-right tabular-nums ${line.final >= 0 ? "text-red-500" : "text-green-600"}`}>{line.final > 0 ? "+" : ""}{line.final.toFixed(2)}</td>
        <td className="py-2 pl-4"><div className="h-2 rounded-full bg-slate-100"><div className={`h-2 rounded-full ${line.final >= 0 ? "bg-red-400" : "bg-green-500"}`} style={{width: `${Math.abs(line.final) / max * 100}%`}} /></div></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

// 今日盘面配色：A 股口径红涨绿跌。
const TM_UP = "#ef4444";
const TM_DOWN = "#10b981";
const TM_MUTED = "var(--chart-muted)";
const TM_AMBER = "#f59e0b";

function tmPct(v, digits = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function tmColor(v) {
  return v > 0 ? TM_UP : v < 0 ? TM_DOWN : TM_MUTED;
}

// 今日盘面单卡片外壳：标题 + 右上角小字 + 内容。
function TMCard({ title, extra, children }) {
  return (
    <Card className="rounded-2xl border-slate-200">
      <CardContent className="p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-slate-800">{title}</div>
          <div className="text-xs text-slate-500">{extra}</div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function tmPolar(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}
// 半圆仪表盘：value 0-100，左 0% → 右 100%（角度 180°→0°）。
function TMGauge({ value }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const cx = 110;
  const cy = 110;
  const r = 88;
  // 5 段彩色轨道：绿→浅绿→黄→橙→红。
  const segs = [
    { from: 0, to: 20, color: "#16a34a" },
    { from: 20, to: 40, color: "#84cc16" },
    { from: 40, to: 60, color: "#eab308" },
    { from: 60, to: 80, color: "#f97316" },
    { from: 80, to: 100, color: "#dc2626" },
  ];
  const ang = (p) => 180 - (p / 100) * 180;
  const arc = (from, to) => {
    const s = tmPolar(cx, cy, r, ang(from));
    const e = tmPolar(cx, cy, r, ang(to));
    return `M${s.x.toFixed(1)},${s.y.toFixed(1)} A${r},${r} 0 0 1 ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
  };
  const needle = tmPolar(cx, cy, r - 16, ang(v));
  const heatColor = v >= 80 ? "#dc2626" : v >= 60 ? "#f97316" : v >= 40 ? "#eab308" : v >= 20 ? "#84cc16" : "#16a34a";
  return (
    <svg viewBox="0 0 220 150" className="w-full" style={{ maxHeight: 170 }}>
      {segs.map((s) => (
        <path key={s.from} d={arc(s.from, s.to)} fill="none" stroke={s.color} strokeWidth="14" strokeLinecap="butt" />
      ))}
      {[0, 20, 40, 60, 80, 100].map((p) => {
        const t = tmPolar(cx, cy, r + 14, ang(p));
        return (
          <text key={p} x={t.x} y={t.y} textAnchor="middle" fontSize="10" fill="var(--chart-muted)">
            {p}%
          </text>
        );
      })}
      <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke="var(--chart-ink-2)" strokeWidth="2.5" />
      <circle cx={cx} cy={cy} r="5" fill="var(--chart-ink-2)" />
      <text x={cx} y={cy + 32} textAnchor="middle" fontSize="26" fontWeight="700" fill={heatColor}>
        {v}%
      </text>
    </svg>
  );
}

// 涨跌对比：上涨/下跌占比横条。
function TMBreadthBar({ up, down }) {
  const tot = up + down || 1;
  const upPct = (up / tot) * 100;
  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded-md">
        <div style={{ width: `${upPct}%`, background: TM_UP }} />
        <div style={{ width: `${100 - upPct}%`, background: TM_DOWN }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-sm">
        <span style={{ color: TM_UP }}>上涨 {up}</span>
        <span className="text-slate-500">上涨占比 {upPct.toFixed(0)}%</span>
        <span style={{ color: TM_DOWN }}>下跌 {down}</span>
      </div>
    </div>
  );
}

// 涨跌统计直方图（竖条）。
function TMHistogram({ data }) {
  const width = 360;
  const height = 150;
  const m = { top: 8, right: 6, bottom: 18, left: 6 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const max = Math.max(1, ...data.map((d) => d.count));
  const bw = plotW / data.length;
  const upSet = new Set(["停+", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 170 }}>
      {data.map((d, i) => {
        const h = (d.count / max) * plotH;
        const x = m.left + i * bw;
        const color = d.label === "0" ? TM_MUTED : upSet.has(d.label) ? TM_UP : TM_DOWN;
        return (
          <g key={d.label}>
            <rect x={x + 1} y={m.top + plotH - h} width={bw - 2} height={h} fill={color} rx="1" />
            <text x={x + bw / 2} y={height - 6} textAnchor="middle" fontSize="8" fill="var(--chart-muted)">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// 市值分档涨幅：每档一行，以 0 为中心的横向条。
function TMCapTiers({ tiers }) {
  const max = Math.max(0.5, ...tiers.map((t) => Math.abs(t.avg || 0)));
  return (
    <div className="space-y-1.5">
      {tiers.map((t) => {
        const v = Number.isFinite(t.avg) ? t.avg : null;
        const w = v === null ? 0 : (Math.abs(v) / max) * 50; // 半幅 50%
        return (
          <div key={t.key} className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-slate-500">{t.label}</span>
            <div className="relative h-3.5 flex-1">
              <div className="absolute left-1/2 top-0 h-full w-px bg-slate-200" />
              <div
                className="absolute top-0 h-full rounded-sm"
                style={{
                  background: tmColor(v),
                  width: `${w}%`,
                  left: v >= 0 ? "50%" : `${50 - w}%`,
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-right font-medium" style={{ color: tmColor(v) }}>
              {tmPct(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// 前一交易日涨停股在盘面交易日的表现分布色条。
function TMPremiumBar({ premium }) {
  if (!premium) return null;
  const colors = { ge7: "#dc2626", "3_7": "#f97316", "0_3": "#fca5a5", neg3_0: "#86efac", le_neg3: "#16a34a" };
  const tot = premium.dist.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <span className="text-2xl font-bold" style={{ color: tmColor(premium.avg) }}>
            {tmPct(premium.avg)}
          </span>
          <span className="ml-2 text-xs text-slate-500">平均涨幅（{premium.count} 只）</span>
        </div>
        <span className="text-xs text-slate-500">次日红盘率 {(premium.redRate * 100).toFixed(0)}%</span>
      </div>
      <div className="mt-2 flex h-5 w-full overflow-hidden rounded-md">
        {premium.dist.map((b) => (
          <div key={b.key} style={{ width: `${(b.count / tot) * 100}%`, background: colors[b.key] }} title={`${b.label} ${b.count}`} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
        {premium.dist.map((b) => (
          <span key={b.key} className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: colors[b.key] }} />
            {b.label} {b.count}
          </span>
        ))}
      </div>
    </div>
  );
}

// 多日折线（复用 smoothLinePath/niceStep）。series=[{name,color,points:[{t,v}]}]。
function TMMultiLine({ series, height = 170, suffix = "" }) {
  const width = 380;
  const m = { top: 10, right: 70, bottom: 20, left: 30 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const lines = (series || []).filter((s) => s.points?.some((p) => Number.isFinite(p.v)));
  if (!lines.length) return <div className="py-8 text-center text-sm text-slate-400">暂无数据</div>;
  const n = Math.max(...lines.map((s) => s.points.length));
  const values = lines.flatMap((s) => s.points.map((p) => p.v).filter(Number.isFinite));
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin > 0) vMin = 0;
  const pad = (vMax - vMin) * 0.08 || 1;
  vMax += pad;
  const x = (i) => m.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => m.top + (1 - (v - vMin) / (vMax - vMin || 1)) * plotH;
  const ref = lines.reduce((a, b) => (b.points.length > a.points.length ? b : a), lines[0]);
  const xticks = [0, Math.floor((n - 1) / 2), n - 1].filter((i, idx, arr) => arr.indexOf(i) === idx);
  const ticks = [];
  const step = niceStep((vMax - vMin) / 4);
  for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) ticks.push(v);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height + 10 }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke="var(--chart-grid-soft)" />
          <text x={m.left - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--chart-muted)">
            {v.toFixed(0)}
          </text>
        </g>
      ))}
      {xticks.map((i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="9" fill="var(--chart-muted)">
          {String(ref.points[i]?.t || "").slice(5)}
        </text>
      ))}
      {lines.map((s) => {
        // 缺失日期保留横轴位置并断开折线，不能被当成 0 或跨过去连接。
        const segments = [];
        let segment = [];
        s.points.forEach((p, i) => {
          if (Number.isFinite(p.v)) segment.push({ x: x(i), y: y(p.v) });
          else if (segment.length) { segments.push(segment); segment = []; }
        });
        if (segment.length) segments.push(segment);
        const last = segments.at(-1)?.at(-1);
        const lastValue = [...s.points].reverse().find((p) => Number.isFinite(p.v))?.v;
        return (
          <g key={s.name}>
            {segments.map((pts, index) => <path key={index} d={smoothLinePath(pts)} fill="none" stroke={s.color} strokeWidth="1.6" />)}
            <text x={width - m.right + 4} y={last.y + 3} fontSize="9.5" fill={s.color}>
              {s.name} {lastValue}
              {suffix}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// 打板次日成功率：日柱（成功率）+ 折线（炸板率）。两者都是 0-1。
function TMDailyCombo({ history }) {
  const width = 380;
  const height = 170;
  const m = { top: 10, right: 10, bottom: 20, left: 28 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const rows = history;
  if (!rows.some((d) => Number.isFinite(d.zbRate) || Number.isFinite(d.nextDaySuccess))) return <div className="py-8 text-center text-sm text-slate-400">暂无数据</div>;
  const bw = plotW / rows.length;
  const y = (v) => m.top + (1 - v) * plotH; // 0-1
  const lineSegments = [];
  let linePts = [];
  rows.forEach((d, i) => {
    if (Number.isFinite(d.zbRate)) linePts.push({ x: m.left + i * bw + bw / 2, y: y(d.zbRate) });
    else if (linePts.length) { lineSegments.push(linePts); linePts = []; }
  });
  if (linePts.length) lineSegments.push(linePts);
  const hasSuccess = rows.some((d) => Number.isFinite(d.nextDaySuccess));
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 180 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke="var(--chart-grid-soft)" />
            <text x={m.left - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--chart-muted)">
              {v * 100}
            </text>
          </g>
        ))}
        {rows.map((d, i) => {
          if (!Number.isFinite(d.nextDaySuccess)) return null;
          const h = d.nextDaySuccess * plotH;
          return (
            <rect
              key={d.date}
              x={m.left + i * bw + 2}
              y={m.top + plotH - h}
              width={bw - 4}
              height={h}
              fill={d.nextDaySuccess >= 0.5 ? TM_UP : TM_DOWN}
              opacity="0.7"
              rx="1"
            />
          );
        })}
        {lineSegments.map((pts, index) => <path key={index} d={smoothLinePath(pts)} fill="none" stroke={TM_AMBER} strokeWidth="1.8" />)}
        {rows
          .filter((_, i) => i === 0 || i === rows.length - 1 || i === Math.floor(rows.length / 2))
          .map((d) => (
            <text key={d.date} x={m.left + rows.indexOf(d) * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="var(--chart-muted)">
              {d.date.slice(5)}
            </text>
          ))}
      </svg>
      {!hasSuccess ? (
        <div className="mt-1 text-[11px] text-slate-400">次日成功率需个股日线，本环境暂不可用，仅显示炸板率曲线。</div>
      ) : null}
    </div>
  );
}

// ===== 今日盘面：跨 tab 的内存缓存 + 预取 =====
// 今日盘面要跑全市场快照 + 十几天的涨停/跌停/炸板池，冷启动 20~45s。
// 面板是条件渲染的，切走就卸载，所以缓存必须放在模块级 —— 组件 state 留不住。
// 配合 MarketHeatmapPanel 里的预取：用户在看热力图时它已经在后台拉好了。
const TODAY_MARKET_TTL_MS = 5 * 60 * 1000;
const TODAY_MARKET_SESSION_KEY = "today-market:query:v1";
let todayMarketCache = null; // { body, at }
let todayMarketInflight = null; // 单飞：预取与用户主动打开合并成一次请求

function readTodayMarketCache() {
  if (todayMarketCache && !isCurrentMarketSnapshot(todayMarketCache.body, "today")) todayMarketCache = null;
  if (todayMarketCache && !todayMarketCache.body?.stale && Date.now() >= todayMarketCache.at && Date.now() - todayMarketCache.at < TODAY_MARKET_TTL_MS) return todayMarketCache.body;
  try {
    const cached = JSON.parse(sessionStorage.getItem(TODAY_MARKET_SESSION_KEY) || "null");
    if (cached && !isCurrentMarketSnapshot(cached.body, "today")) {
      sessionStorage.removeItem(TODAY_MARKET_SESSION_KEY);
      return null;
    }
    if (cached && !cached.body?.stale && Date.now() >= Number(cached.at) && Date.now() - Number(cached.at) < TODAY_MARKET_TTL_MS && cached.body?.breadth && Array.isArray(cached.body?.hist)) {
      todayMarketCache = cached;
      return cached.body;
    }
  } catch {
    // 隐私模式或存储空间不足时继续使用网络请求。
  }
  return null;
}

function writeTodayMarketCache(body) {
  if (body?.stale || !isCurrentMarketSnapshot(body, "today") || !body?.breadth || !Array.isArray(body?.hist)) return;
  const cached = { body, at: Date.now() };
  todayMarketCache = cached;
  try {
    sessionStorage.setItem(TODAY_MARKET_SESSION_KEY, JSON.stringify(cached));
  } catch {
    // 内存缓存仍然可用。
  }
}

function fetchTodayMarket({ force = false, refresh = false } = {}) {
  if (!force && !refresh) {
    const hit = readTodayMarketCache();
    if (hit) return Promise.resolve(hit);
  }
  // Polling bypasses the client cache but still shares an in-flight request.
  if (!force && todayMarketInflight) return todayMarketInflight;
  const req = apiFetch(`/api/today-market${force ? "?retry=1" : ""}`)
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `加载失败（${res.status}）`);
      if (!isCurrentMarketSnapshot(body, "today")) throw new Error("盘面快照口径不完整，请刷新后重试。");
      return body;
    })
    .then((body) => {
      writeTodayMarketCache(body);
      return body;
    })
    .finally(() => {
      if (todayMarketInflight === req) todayMarketInflight = null;
    });
  todayMarketInflight = req;
  return req;
}

// 预取：失败了不打扰用户，真正切过去时会重新请求并正常报错。
function prefetchTodayMarket() {
  if (readTodayMarketCache() || todayMarketInflight) return;
  fetchTodayMarket().catch(() => {});
}

function TodayMarketPanel() {
  // 命中缓存就直接以数据开局，不闪 loading —— 这正是预取要换来的体验。
  const [payload, setPayload] = useState(readTodayMarketCache);
  const [loading, setLoading] = useState(() => !readTodayMarketCache());
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer;
    let polls = 0;
    const force = reloadKey > 0; // 只有点「刷新」才绕过缓存
    // 缓存命中的情况 useState 的初始值已经处理好了，而这个分支只可能在挂载时走到
    // （点「刷新」走的是 force 路径），所以直接返回，不必再 setState 触发一轮多余渲染。
    if (!force && readTodayMarketCache()) return undefined;
    async function load() {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError("");
      try {
        const body = await fetchTodayMarket({ force: force && polls === 0, refresh: polls > 0 });
        if (!cancelled) {
          setPayload(body);
          if (body.stale && body.refreshing && polls < 10) {
            polls += 1;
            timer = setTimeout(load, 5000);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  if (loading && !payload) {
    return <div className="flex h-64 items-center justify-center text-sm text-slate-400">今日盘面加载中…（全市场快照较慢，请稍候）</div>;
  }
  if (error && !payload) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-rose-500">
        <div>{error}</div>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="rounded-lg border border-slate-200 px-3 py-1 text-slate-600">
          重试
        </button>
      </div>
    );
  }
  if (!payload) return null;
  // 非交易时段且服务端还没有任何历史快照：payload 里没有 breadth/history，
  // 往下直接读会抛 TypeError。给一个和热力图一致的中性提示。
  if (payload.marketClosed && !payload.breadth) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-1.5 text-center text-sm text-slate-400">
        <span>{payload.notice || "当前非交易时段，暂无行情数据。"}</span>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="rounded-lg border px-3 py-1">重新查询</button>
      </div>
    );
  }

  const p = payload;
  const presentation = todayMarketPresentation(p);
  const ratioStr = `${p.breadth.up}:${p.breadth.down}`;
  const history = Array.isArray(p.history) ? p.history : [];
  const lbSeries = [{ name: "连板数", color: TM_AMBER, points: history.map((d) => ({ t: d.date, v: d.lbCount })) }];
  const cycleSeries = [
    { name: "涨停", color: TM_UP, points: history.map((d) => ({ t: d.date, v: d.ztCount })) },
    { name: "跌停", color: TM_DOWN, points: history.map((d) => ({ t: d.date, v: d.dtCount })) },
    { name: "连板", color: TM_AMBER, points: history.map((d) => ({ t: d.date, v: d.lbCount })) },
  ];
  const latestSuccess = [...history].reverse().find((d) => Number.isFinite(d.nextDaySuccess));
  const lastZbRate = history.at(-1)?.zbRate;
  const unavailable = <div className="flex h-32 items-center justify-center text-center text-xs text-slate-400">{presentation.unavailableMessage}</div>;
  const historyUnavailable = <div className="flex h-32 items-center justify-center text-center text-xs text-slate-400">{presentation.historyUnavailableMessage}</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          盘面交易日 {presentation.date} · 行情覆盖 {p.breadth.total} 只 · {marketSnapshotSourceLabel(p)}
          {presentation.previousDate && <div className="mt-1">前一交易日 {presentation.previousDate}</div>}
          <div className="mt-1">行情 {formatMarketSnapshotTime(p.quoteTime)} · 获取 {formatMarketSnapshotTime(p.updatedAt)}（北京时间）</div>
        </div>
        <button type="button" disabled={loading} onClick={() => setReloadKey((k) => k + 1)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-50">
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      {presentation.sessionNotice && <div role="status" className="text-xs text-slate-500">{presentation.sessionNotice}</div>}
      {(p.stale || p.classificationStale || error) && <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        {error ? "刷新失败，继续展示已有快照；数据日期见上方。" : p.stale ? p.notice || "当前展示缓存快照，请留意数据日期。" : `行业归属暂未更新，沿用 ${formatMarketSnapshotTime(p.classificationUpdatedAt)} 的已验证分类；报价时间见上方。`}
      </div>}
      {p.notice && !p.stale && !p.classificationStale && !error && <div className="text-xs text-slate-500">{p.notice}</div>}
      {p.quoteCoverage && <div className="text-xs text-slate-500">{presentation.date} 有效报价 {p.quoteCoverage.quoted} / {p.quoteCoverage.total} 只；{p.quoteCoverage.unavailable} 只停牌、旧日期或缺失报价未计入统计。</div>}

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ① 市场真实热度 */}
        <TMCard title="市场真实热度" extra={p.heat ? `宽度 ${p.heat.breadth}% · 强弱 ${p.heat.ztStrength}%` : "—"}>
          {p.heat ? <TMGauge value={p.heat.value} /> : unavailable}
        </TMCard>

        {/* ② 涨跌对比 */}
        <TMCard title="涨跌对比" extra={`涨跌比 ${ratioStr}`}>
          <div className="pt-6">
            <TMBreadthBar up={p.breadth.up} down={p.breadth.down} />
          </div>
        </TMCard>

        {/* ③ 强弱对比 */}
        <TMCard title="强弱对比" extra={`封板成功率 ${p.strong?.fbSuccess != null ? (p.strong.fbSuccess * 100).toFixed(0) + "%" : "—"}`}>
          {p.strong ? <>
          <div className="grid grid-cols-3 gap-2 pt-4 text-center">
            <div>
              <div className="text-2xl font-bold" style={{ color: TM_UP }}>{p.strong.ztCount}</div>
              <div className="text-xs text-slate-500">涨停</div>
            </div>
            <div>
              <div className="text-2xl font-bold" style={{ color: TM_AMBER }}>{p.strong.zbCount}</div>
              <div className="text-xs text-slate-500">炸板</div>
            </div>
            <div>
              <div className="text-2xl font-bold" style={{ color: TM_DOWN }}>{p.strong.dtCount}</div>
              <div className="text-xs text-slate-500">跌停</div>
            </div>
          </div>
          <div className="mt-3 text-center text-xs text-slate-500">
            炸板率 {p.strong.zbRate != null ? (p.strong.zbRate * 100).toFixed(1) + "%" : "—"}
          </div>
          </> : unavailable}
        </TMCard>

        {/* ④ 涨跌统计 */}
        <TMCard title="涨跌统计" extra={<span><span style={{ color: TM_UP }}>涨{p.breadth.up}</span> 平{p.breadth.flat} <span style={{ color: TM_DOWN }}>跌{p.breadth.down}</span></span>}>
          <TMHistogram data={p.hist} />
          <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
            <span>总上涨比例 {p.breadth.upRatio != null ? (p.breadth.upRatio * 100).toFixed(0) + "%" : "—"}</span>
            <span><span style={{ color: TM_UP }}>阳 {p.yangYin.yang}</span>  <span style={{ color: TM_DOWN }}>阴 {p.yangYin.yin}</span></span>
          </div>
        </TMCard>

        {/* ⑤ 前一交易日涨停股在盘面交易日的平均涨幅 */}
        <TMCard title="前一交易日涨停股表现" extra={presentation.premiumExtra}>
          <div className="pt-1">
            {p.premium ? <TMPremiumBar premium={p.premium} /> : <div className="flex h-32 items-center justify-center text-center text-xs text-slate-400">{presentation.premiumUnavailableMessage}</div>}
          </div>
        </TMCard>

        {/* ⑥ 市值分档涨幅 */}
        <TMCard title="市值分档涨幅" extra="各档平均涨幅">
          <div className="pt-1">
            <TMCapTiers tiers={p.capTiers} />
          </div>
        </TMCard>

        {/* ⑦ 连板数 */}
        <TMCard title="连板数" extra={p.consecutive ? `连板 ${p.consecutive.lbCount} · 非一字 ${p.consecutive.nonOneWordLb} · 最高 ${p.consecutive.maxLb} 板` : "—"}>
          {history.length ? <TMMultiLine series={lbSeries} /> : p.consecutive ? <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-xs text-slate-400">
            <span>{presentation.date} 连板 {p.consecutive.lbCount} 只 · 最高 {p.consecutive.maxLb} 板</span>
            <span>{presentation.historyUnavailableMessage}</span>
          </div> : unavailable}
        </TMCard>

        {/* ⑧ 打板次日成功率 */}
        <TMCard title="打板次日成功率" extra={`成功率 ${latestSuccess ? (latestSuccess.nextDaySuccess * 100).toFixed(1) + "%" : "—"} · 炸板率 ${Number.isFinite(lastZbRate) ? (lastZbRate * 100).toFixed(1) + "%" : "—"}`}>
          {history.length ? <TMDailyCombo history={history} /> : historyUnavailable}
        </TMCard>

        {/* ⑨ 情绪周期监控 */}
        <TMCard title="情绪周期监控" extra="涨停/跌停/连板">
          {history.length ? <TMMultiLine series={cycleSeries} /> : historyUnavailable}
        </TMCard>
      </div>
    </div>
  );
}

// ===== 市场热力图 =====
// 面积＝流通市值 / 成交额，颜色＝涨跌幅（A 股口径红涨绿跌）。
// 行业视图铺细分行业，个股视图在每个行业块里再铺成分股，两者同源同口径。
const HEATMAP_VIEWS = [
  { value: "industry", label: "行业" },
  { value: "stock", label: "个股" },
];

const HEATMAP_METRICS = [
  { value: "amount", label: "成交额" },
  { value: "floatCap", label: "流通市值" },
];

// 行业视图最多铺多少个行业；个股视图要留出位置塞成分股，块数少一些。
const HEATMAP_INDUSTRY_LIMIT = 42;
const HEATMAP_GROUP_LIMIT = 24;
// 小于这个面积（px²）的成分股不画，免得铺出一堆读不出字的碎片。
const HEATMAP_MIN_STOCK_AREA = 300;

// |涨跌幅| 越大：越饱和 + 越深，4% 封顶（A 股日内绝大多数落在这个区间内）；
// 接近 0 用中性灰。亮度锁在 36%~58%，保证白字在任何格子上都清晰。
function heatmapColor(pct) {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.05) return "hsl(215 12% 64%)";
  const t = Math.min(1, Math.abs(pct) / 4);
  return pct > 0
    ? `hsl(4 ${30 + 45 * t}% ${58 - 20 * t}%)`
    : `hsl(152 ${28 + 40 * t}% ${54 - 18 * t}%)`;
}

// 一行内最差的长宽比，squarify 用它决定“再塞一个还是另起一行”。
function heatmapWorstAspect(values, short, rowValue, scale) {
  const rowArea = rowValue * scale;
  if (!(rowArea > 0)) return Infinity;
  let worst = 0;
  for (const value of values) {
    const area = value * scale;
    if (!(area > 0)) return Infinity;
    const ratio = Math.max((short * short * area) / (rowArea * rowArea), (rowArea * rowArea) / (short * short * area));
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

// 经典 squarified treemap：按 value 把方块铺进 (x0,y0,w0,h0)，尽量接近正方形。
// 返回带像素坐标 x/y/w/h 的新对象数组，原字段透传。
function heatmapSquarify(items, x0, y0, w0, h0) {
  const list = items.filter((it) => Number.isFinite(it.value) && it.value > 0).sort((a, b) => b.value - a.value);
  const out = [];
  let x = x0;
  let y = y0;
  let w = w0;
  let h = h0;
  let remaining = list.reduce((sum, it) => sum + it.value, 0);
  let i = 0;

  while (i < list.length && w > 1 && h > 1 && remaining > 0) {
    const short = Math.min(w, h);
    const scale = (w * h) / remaining; // value → 面积
    const row = [];
    let rowValue = 0;
    let bestAspect = Infinity;

    while (i + row.length < list.length) {
      const next = list[i + row.length];
      const nextValue = rowValue + next.value;
      const aspect = heatmapWorstAspect([...row.map((r) => r.value), next.value], short, nextValue, scale);
      if (!row.length || aspect <= bestAspect) {
        row.push(next);
        rowValue = nextValue;
        bestAspect = aspect;
      } else break;
    }

    const horizontal = w >= h; // 长边在横向 → 这一行竖着码，占据左侧一条
    const thickness = Math.min(horizontal ? w : h, (rowValue * scale) / short);
    let offset = 0;
    for (const it of row) {
      const length = Math.min(short - offset, (it.value * scale) / thickness);
      if (horizontal) out.push({ ...it, x, y: y + offset, w: thickness, h: length });
      else out.push({ ...it, x: x + offset, y, w: length, h: thickness });
      offset += length;
    }

    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    remaining -= rowValue;
    i += row.length;
  }
  return out;
}

function heatmapPct(v, digits = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

// 亿为单位的数值：过万亿改用「万亿」，免得标签太长。
function heatmapYi(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)} 万亿`;
  if (Math.abs(v) >= 100) return `${Math.round(v)} 亿`;
  return `${v.toFixed(1)} 亿`;
}

// 方块内字号随面积走，太小的块只留色不写字。
function heatmapFontSize(w, h, max) {
  return Math.max(10, Math.min(max, Math.round(Math.sqrt(w * h) / 6)));
}

const HEATMAP_DATE_PRESETS = [
  { value: "3d", label: "近3天", days: 3 },
  { value: "1w", label: "近一周", days: 7 },
  { value: "1m", label: "近一月", days: 30 },
  { value: "3m", label: "近三月", days: 90 },
  { value: "6m", label: "近半年", days: 180 },
  { value: "ytd", label: "今年以来", yearToDate: true },
];

const HEATMAP_CLIENT_CACHE_PREFIX = "market-heatmap:query:v1:";
const HEATMAP_LATEST_CACHE_MS = 2 * 60 * 1000;
const HEATMAP_HISTORY_CACHE_MS = 30 * 60 * 1000;
const heatmapClientCache = new Map();

function readHeatmapClientCache(query) {
  const key = query || "latest";
  const maxAge = query ? HEATMAP_HISTORY_CACHE_MS : HEATMAP_LATEST_CACHE_MS;
  let memory = heatmapClientCache.get(key);
  if (!query && memory && !isCurrentMarketSnapshot(memory.body, "heatmap")) {
    heatmapClientCache.delete(key);
    memory = null;
  }
  if (memory && !memory.body?.stale && Date.now() >= memory.at && Date.now() - memory.at < maxAge) return memory.body;
  try {
    const cached = JSON.parse(sessionStorage.getItem(`${HEATMAP_CLIENT_CACHE_PREFIX}${key}`) || "null");
    if (!query && cached && !isCurrentMarketSnapshot(cached.body, "heatmap")) {
      sessionStorage.removeItem(`${HEATMAP_CLIENT_CACHE_PREFIX}${key}`);
      return null;
    }
    if (cached && !cached.body?.stale && Date.now() >= Number(cached.at) && Date.now() - Number(cached.at) < maxAge && Array.isArray(cached.body?.industries) && cached.body.industries.length) {
      heatmapClientCache.set(key, cached);
      return cached.body;
    }
  } catch {
    // 隐私模式或存储空间不足时继续使用网络请求。
  }
  return null;
}

function writeHeatmapClientCache(query, body) {
  if (body?.stale || !query && !isCurrentMarketSnapshot(body, "heatmap") || !Array.isArray(body?.industries) || !body.industries.length) return;
  const key = query || "latest";
  const cached = { body, at: Date.now() };
  heatmapClientCache.set(key, cached);
  try {
    sessionStorage.setItem(`${HEATMAP_CLIENT_CACHE_PREFIX}${key}`, JSON.stringify(cached));
  } catch {
    // 内存缓存仍然可用。
  }
}

function heatmapPresetStart(today, preset) {
  if (preset.yearToDate) return `${today.slice(0, 4)}-01-01`;
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (preset.days - 1));
  return date.toISOString().slice(0, 10);
}

function MarketHeatmapPanel({ onOpenStock }) {
  const [today] = useState(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  const [mode, setMode] = useState("latest");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [activePreset, setActivePreset] = useState("");
  const [selection, setSelection] = useState({ query: "", version: 0 });
  const [validation, setValidation] = useState("");
  function submit(event) {
    event.preventDefault();
    const finish = mode === "day" ? start : end;
    if (mode !== "latest" && (!start || !finish || start > finish || finish > today || Date.parse(finish) - Date.parse(start) > 366 * 86400000)) {
      setValidation("请选择有效日期，结束不晚于今天，区间不超过366天。"); return;
    }
    setValidation("");
    const query = mode === "latest" ? "" : new URLSearchParams({ start, end: finish }).toString();
    setSelection((prev) => ({ query, version: prev.version + 1 }));
  }
  function applyPreset(preset) {
    const presetStart = heatmapPresetStart(today, preset);
    setMode("range");
    setStart(presetStart);
    setEnd(today);
    setActivePreset(preset.value);
    setValidation("");
    const query = new URLSearchParams({ start: presetStart, end: today }).toString();
    setSelection((prev) => ({ query, version: prev.version + 1 }));
  }
  return <div className="space-y-3">
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-sm">
      <select aria-label="热力图时间模式" value={mode} onChange={(e) => { setMode(e.target.value); setActivePreset(""); }} className="rounded-xl border bg-white px-3 py-2">
        <option value="latest">最新行情</option><option value="day">指定日期</option><option value="range">日期区间</option>
      </select>
      {mode !== "latest" && <input aria-label="开始日期" type="date" value={start} max={today} required onChange={(e) => { setStart(e.target.value); setActivePreset(""); }} className="rounded-xl border bg-white px-3 py-2" />}
      {mode === "range" && <><span>至</span><input aria-label="结束日期" type="date" value={end} max={today} min={start} required onChange={(e) => { setEnd(e.target.value); setActivePreset(""); }} className="rounded-xl border bg-white px-3 py-2" /></>}
      <button type="submit" className="rounded-xl bg-slate-900 px-4 py-2 text-white">查询</button>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="常用日期">
        {HEATMAP_DATE_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => applyPreset(preset)}
            aria-pressed={activePreset === preset.value}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              activePreset === preset.value
                ? "border-slate-900 bg-slate-900 text-white shadow-sm"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {validation && <span className="text-rose-500">{validation}</span>}
    </form>
    <MarketHeatmapContent key={`${selection.query}:${selection.version}`} historyQuery={selection.query} onOpenStock={onOpenStock} />
  </div>;
}

function MarketHeatmapContent({ onOpenStock, historyQuery }) {
  const historical = !!historyQuery;
  const [initialPayload] = useState(() => readHeatmapClientCache(historyQuery));
  const [progress, setProgress] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [payload, setPayload] = useState(initialPayload);
  const [loading, setLoading] = useState(() => !initialPayload);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState("industry");
  const [metric, setMetric] = useState("amount"); // 默认按成交额铺面积：当天资金去了哪儿更直观
  const [focus, setFocus] = useState(""); // 下钻到的行业名，空＝全市场
  const [detail, setDetail] = useState(null); // 下钻行业的全部成分股
  const [detailLoading, setDetailLoading] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null); // { tile, x, y }
  const boxRef = useRef(null);
  const payloadRef = useRef(initialPayload);

  useEffect(() => {
    // Query selection remounts this panel; polling is cancelled when selection changes.
    let cancelled = false;
    let timer;
    let firstRequest = true;
    let latestPolls = 0;
    const controller = new AbortController();
    function load() {
    const retry = firstRequest ? "&retry=1" : "";
    firstRequest = false;
    apiFetch(`/api/market-heatmap${historical ? `?${historyQuery}${retry}` : reloadKey > 0 ? "?retry=1" : ""}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `加载失败（${res.status}）`);
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setProgress(body);
        if (body.status === "busy" || body.status === "loading") {
          timer = setTimeout(load, 1200);
          return;
        }
        if (body.error) throw new Error(body.error);
        if (!historical && !isCurrentMarketSnapshot(body, "heatmap")) throw new Error("行业快照口径不完整，请刷新后重试。");
        writeHeatmapClientCache(historyQuery, body);
        if (payloadRef.current && payloadRef.current.source !== body.source) {
          setFocus("");
          setDetail(null);
          setDetailError("");
        }
        payloadRef.current = body;
        setPayload(body);
        setError("");
        setLoading(false);
        // The first response can be immediate last-good while the server checks
        // an alternate source. Pick up that result without requiring a click.
        if (!historical && body.stale && body.refreshing && latestPolls < 10) {
          latestPolls += 1;
          timer = setTimeout(load, 5000);
        }
        if (!historical && !body.stale && body.industries?.length) prefetchTodayMarket();
      })
      .catch((e) => {
        if (!cancelled) {
          // 已有快照时继续展示；网络刷新失败不应把可用页面替换成整屏错误。
          setError(e?.message || "加载失败");
          setLoading(false);
        }
      })
      .finally(() => {
        if (!cancelled && !historical) setLoading(false);
      });
    }
    load();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [historical, historyQuery, reloadKey]);

  // 下钻：列表接口只带了每个行业的前几大成分股（够铺树图），进到单行业要看全部，单独拉一次。
  // loading 由点击那一刻置位，这里不做同步 setState。
  useEffect(() => {
    if (!focus) return undefined;
    let cancelled = false;
    let timer;
    let firstRequest = true;
    function loadDetail() {
    const retry = firstRequest ? "&retry=1" : "";
    firstRequest = false;
    const board = payload?.industries?.find((row) => row.name === focus)?.code;
    apiFetch(`/api/market-heatmap?${historical ? `${historyQuery}&board=${encodeURIComponent(board || "")}${retry}` : `industry=${encodeURIComponent(focus)}&source=${encodeURIComponent(payload?.source || "eastmoney")}`}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `加载失败（${res.status}）`);
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        if (body.status === "busy" || body.status === "loading") {
          setProgress(body);
          timer = setTimeout(loadDetail, 1200);
          return;
        }
        if (body.error) throw new Error(body.error);
        setDetail({ ...body, industry: focus });
        setDetailLoading(false);
      })
      .catch((e) => {
        if (!cancelled) { setDetail(null); setDetailError(e.message); setDetailLoading(false); }
      })
      .finally(() => {
        if (!cancelled && !historical) setDetailLoading(false);
      });
    }
    loadDetail();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [focus, historical, historyQuery, payload]);

  // 容器尺寸变化（窗口缩放/侧栏展开）时重铺树图。
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setBox({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, error]);

  const industries = useMemo(() => {
    const list = Array.isArray(payload?.industries) ? payload.industries : [];
    return list.filter((it) => Number(it?.[metric]) > 0).sort((a, b) => Number(b[metric]) - Number(a[metric]));
  }, [payload, metric]);

  const focusIndustry = useMemo(
    () => (focus ? industries.find((it) => it.name === focus) || null : null),
    [industries, focus],
  );

  const tiles = useMemo(() => {
    const { w, h } = box;
    if (!(w > 20 && h > 20) || !industries.length) return [];
    const valueOf = (row) => Math.max(0, Number(row?.[metric]) || 0);

    // 下钻：整块面板只铺这个行业的成分股（拿到完整列表前先用列表里的前几大顶上）。
    if (focusIndustry) {
      const members = detail?.industry === focusIndustry.name && detail?.stocks?.length ? detail.stocks : focusIndustry.stocks || [];
      const items = members.map((s) => ({
        kind: "stock",
        key: s.code,
        stock: s,
        industry: focusIndustry,
        value: valueOf(s),
      }));
      // 成分股多的行业（如半导体 180+）尾部会碎成看不清的条，按面积门槛截断。
      const total = items.reduce((sum, it) => sum + it.value, 0);
      const minShare = total > 0 ? HEATMAP_MIN_STOCK_AREA / (w * h) : 0;
      const shown = items.filter((it) => it.value / total >= minShare);
      return heatmapSquarify(shown.length ? shown : items, 0, 0, w, h);
    }

    const limit = view === "stock" ? HEATMAP_GROUP_LIMIT : HEATMAP_INDUSTRY_LIMIT;
    const groups = heatmapSquarify(
      industries.slice(0, limit).map((it) => ({ kind: "industry", key: it.name, industry: it, value: valueOf(it) })),
      0,
      0,
      w,
      h,
    );
    if (view === "industry") return groups;

    // 个股视图：行业块顶部留一条标题带，剩下的空间铺成分股。
    const out = [];
    for (const group of groups) {
      const headH = Math.min(22, Math.max(0, group.h * 0.2));
      out.push({ ...group, kind: "group", headH });
      const innerX = group.x + 1;
      const innerY = group.y + headH;
      const innerW = group.w - 2;
      const innerH = group.h - headH - 1;
      if (innerW < 26 || innerH < 20) continue;

      const items = (group.industry.stocks || []).map((s) => ({
        kind: "stock",
        key: s.code,
        stock: s,
        industry: group.industry,
        value: valueOf(s),
      }));
      const total = items.reduce((sum, it) => sum + it.value, 0);
      if (!(total > 0)) continue;
      // 面积不够一个可读格子的票直接不画；全都太小时至少保留最大的一只。
      const minShare = HEATMAP_MIN_STOCK_AREA / (innerW * innerH);
      const shown = items.filter((it) => it.value / total >= minShare);
      out.push(...heatmapSquarify(shown.length ? shown : items.slice(0, 1), innerX, innerY, innerW, innerH));
    }
    return out;
  }, [box, industries, view, metric, focusIndustry, detail]);

  const metricLabel = HEATMAP_METRICS.find((m) => m.value === metric)?.label || "成交额";
  // 东财这几个 host 是延时行情，显示行情截止时刻（而不是抓取时刻），数据有多旧一眼可见。
  // 固定按北京时间渲染：A 股的行情时刻只在这个时区里有意义，浏览器在别的时区也不该被换算。
  const quoteText = payload?.quoteTime
    ? new Date(payload.quoteTime).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "";

  function handleTileClick(tile) {
    if (tile.kind === "stock") {
      if (onOpenStock) onOpenStock(tile.stock.code);
      return;
    }
    if (historical && payload?.supportsDrilldown === false) return;
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setFocus(tile.industry.name);
  }

  function handleTileHover(tile, event) {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ tile, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
            {HEATMAP_VIEWS.filter((v) => !historical || v.value === "industry").map((v) => (
              <button
                key={v.value}
                type="button"
                onClick={() => {
                  setView(v.value);
                  setFocus("");
                  setDetail(null);
                }}
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  view === v.value ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-900"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
            {HEATMAP_METRICS.filter((m) => !historical || m.value === "amount").map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMetric(m.value)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  metric === m.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {focusIndustry ? (
            <button
              type="button"
              onClick={() => {
                setFocus("");
                setDetail(null);
              }}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              ← 返回全市场
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          {historical ? <span>{payload?.source || "行业指数口径"} · {payload?.industries?.length || 0} 个行业</span> : payload ? (
            <span>
              <span className="text-rose-500">{payload.up} 涨</span> / <span className="text-emerald-600">{payload.down} 跌</span>
              <span className="ml-1">共 {payload.totalStocks} 只</span>
              {quoteText ? <span className="ml-1" title="行情截止时刻（北京时间），不是本次加载时间">行情 {quoteText}</span> : null}
            </span>
          ) : null}
          <HeatmapLegend />
          {!historical && <button type="button" disabled={loading} onClick={() => { setLoading(true); setReloadKey((k) => k + 1); }} className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50">{loading ? "刷新中…" : "刷新"}</button>}
        </div>
      </div>

      {!historical && payload && (payload.stale || payload.classificationStale || error) && <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        {error ? "刷新失败，继续展示已有快照；行情时间见上方。" : payload.stale ? payload.notice || "当前展示缓存快照，请留意行情时间。" : `行业归属暂未更新，沿用 ${formatMarketSnapshotTime(payload.classificationUpdatedAt)} 的已验证分类；报价时间见上方。`}
      </div>}
      {!historical && payload && <div className="text-xs text-slate-500">
        {marketSnapshotSourceLabel(payload)} · 获取 {formatMarketSnapshotTime(payload.updatedAt)}（北京时间）。
        {payload.quoteCoverage && <> 当前交易日有效报价 {payload.quoteCoverage.quoted} / {payload.quoteCoverage.total} 只。</>}
      </div>}
      {!historical && payload?.notice && !payload.stale && !payload.classificationStale && !error && <div className="text-xs text-slate-500">{payload.notice}</div>}
      {!historical && focus && (detail?.partial || detailError) && <div className="text-xs text-amber-600" role="status">
        {detail?.partial ? `当前仅展示缓存中的 ${detail.returnedCount ?? detail.stocks?.length ?? 0} / ${detail.totalCount ?? focusIndustry?.count ?? "—"} 只成分股。` : "完整成分股加载失败，当前仅展示行业快照中的部分股票。"}
      </div>}

      {historical && <div className="text-xs text-slate-500">
        {new URLSearchParams(historyQuery).get("start")} 至 {new URLSearchParams(historyQuery).get("end")} · 面积为累计成交额，颜色为区间涨跌幅。休市日不补行情。{payload?.supportsDrilldown === false ? "当前采用同花顺行业分类，与最新行情分类不同；暂不支持成分股下钻。" : "下钻采用当前成分股，非历史成分股还原。"}
        {payload?.partial && Array.isArray(payload.failed) && <div className="mt-1 text-amber-600">部分数据：{payload.failed.length} 个行业失败；仅展示成功结果。失败：{payload.failed.slice(0, 10).join("、")}{payload.failed.length > 10 ? "等" : ""}</div>}
        {!!payload?.empty && <div>{payload.empty} 个行业在所选区间无日线。</div>}
        {detail?.partial && Array.isArray(detail.failed) && <div className="text-amber-600">{detail.failed.length} 只成分股加载失败，当前为部分结果。</div>}
        {detailError && <div className="text-rose-500">成分股加载失败：{detailError}</div>}
      </div>}
      <Card className="rounded-2xl border-slate-200">
        <CardContent className="p-3">
          <div className="mb-2 flex items-center justify-between px-1 text-xs text-slate-400">
            <span>
              {focusIndustry
                ? `${focusIndustry.name} · ${historical ? (detail?.stocks?.length ?? "—") : focusIndustry.count} 只 · ${heatmapPct(focusIndustry.pct)}${detailLoading ? " · 成分股加载中…" : ""}`
                : `方块面积＝${metricLabel}，颜色＝${historical ? "行业指数区间涨跌幅" : view === "industry" ? "行业流通市值加权涨跌幅" : "涨跌幅"}`}
            </span>
            <span>{historical && payload?.supportsDrilldown === false ? "悬浮查看行业区间数据" : focusIndustry ? "点击个股查看 K 线" : view === "industry" ? "点击行业下钻成分股" : "点击个股查看 K 线"}</span>
          </div>

          {loading && !payload ? (
            <div className="flex h-[620px] items-center justify-center text-sm text-slate-400">热力图加载中…{historical && <span className="ml-2">{progress?.notice || `已处理 ${progress?.done || 0} / ${progress?.total || "待获取"}，首次加载需请求外部接口`}</span>}</div>
          ) : error && !industries.length ? (
            <div className="flex h-[620px] flex-col items-center justify-center gap-3 px-4 text-center text-sm text-rose-500"><span>{error}</span><button type="button" onClick={() => { setLoading(true); setReloadKey((k) => k + 1); }} className="rounded-lg border px-3 py-1 text-slate-500">重试</button></div>
          ) : payload?.marketClosed && !industries.length ? (
            <div className="flex h-[620px] flex-col items-center justify-center gap-1.5 px-4 text-center text-sm text-slate-400">
              <span>{payload.notice || "当前非交易时段，暂无行情数据。"}</span>
              <span className="text-xs text-slate-500">可稍后点击刷新重新查询。</span>
            </div>
          ) : !industries.length ? (
            <div className="flex h-[620px] items-center justify-center px-4 text-center text-sm text-slate-400">
              {historical ? "所选区间没有可展示的历史行情（休市、尚未上市或数据缺失），请更换日期。" : "暂无可用行情快照，请稍后刷新重试。"}
            </div>
          ) : (
            <div
              ref={boxRef}
              className="relative h-[620px] w-full overflow-hidden rounded-xl bg-slate-100"
              onMouseLeave={() => setHover(null)}
            >
              {historical && focus && !tiles.length && <div className="flex h-full items-center justify-center text-sm text-slate-500">
                {detailLoading ? `成分股历史加载中… ${progress?.done || 0} / ${progress?.total || "—"}` : detailError || "该行业在区间内没有可展示的成分股行情"}
              </div>}
              {tiles.map((tile) => {
                if (tile.kind === "group") {
                  const fs = heatmapFontSize(tile.w, tile.headH * 6, 13);
                  return (
                    <div
                      key={`g-${tile.key}`}
                      className="absolute cursor-pointer rounded-[3px] bg-slate-200/70 ring-1 ring-inset ring-white/70"
                      style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
                      onClick={() => handleTileClick(tile)}
                      title={`${tile.industry.name} ${heatmapPct(tile.industry.pct)}`}
                    >
                      {tile.w >= 52 && tile.headH >= 12 ? (
                        <div
                          className="flex h-0 items-center gap-1 overflow-hidden whitespace-nowrap px-1 font-medium text-slate-700"
                          style={{ height: tile.headH, fontSize: fs }}
                        >
                          <span className="truncate">{tile.industry.name}</span>
                          <span className={tile.industry.pct >= 0 ? "text-rose-600" : "text-emerald-700"}>
                            {heatmapPct(tile.industry.pct, 2)}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                }

                const isStock = tile.kind === "stock";
                const row = isStock ? tile.stock : tile.industry;
                const label = isStock ? tile.stock.name : tile.industry.name;
                const fs = heatmapFontSize(tile.w, tile.h, isStock ? 16 : 22);
                const showLabel = tile.w >= 40 && tile.h >= 22;
                const showPct = tile.w >= 44 && tile.h >= 34;
                return (
                  <div
                    key={`${isStock ? "s" : "i"}-${tile.key}`}
                    className="absolute cursor-pointer overflow-hidden rounded-[3px] ring-1 ring-inset ring-white/60 transition-[filter] hover:brightness-110"
                    style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h, background: heatmapColor(row.pct) }}
                    onClick={() => handleTileClick(tile)}
                    onMouseMove={(e) => handleTileHover(tile, e)}
                    onMouseEnter={(e) => handleTileHover(tile, e)}
                  >
                    {showLabel ? (
                      <div className="flex h-full flex-col items-center justify-center px-1 text-center leading-tight text-white">
                        <div className="max-w-full truncate font-medium" style={{ fontSize: fs }}>
                          {label}
                        </div>
                        {showPct ? (
                          <div style={{ fontSize: Math.max(9, fs - 2) }} className="opacity-95">
                            {heatmapPct(row.pct)}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {hover ? <HeatmapTooltip hover={hover} box={box} metricLabel={metricLabel} /> : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// 图例：-5% ~ +5% 的色带，超出部分同色封顶。
function HeatmapLegend() {
  const steps = [-5, -3, -1.5, -0.5, 0, 0.5, 1.5, 3, 5];
  return (
    <span className="inline-flex items-center gap-1">
      <span>-5%</span>
      <span className="inline-flex overflow-hidden rounded-sm">
        {steps.map((s) => (
          <span key={s} className="h-3 w-3" style={{ background: heatmapColor(s) }} />
        ))}
      </span>
      <span>+5%</span>
    </span>
  );
}

// 跟随鼠标的详情卡：小方块上写不下的数字都在这里。
function HeatmapTooltip({ hover, box, metricLabel }) {
  const { tile, x, y } = hover;
  const isStock = tile.kind === "stock";
  const row = isStock ? tile.stock : tile.industry;
  const W = 200;
  const H = isStock ? 128 : 142;
  const left = Math.min(Math.max(0, x + 14), Math.max(0, box.w - W - 4));
  const top = y + H + 16 > box.h ? Math.max(0, y - H - 12) : y + 14;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-xl border border-slate-200 bg-white/95 p-2.5 text-xs shadow-lg backdrop-blur"
      style={{ left, top, width: W }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-slate-800">{isStock ? tile.stock.name : tile.industry.name}</span>
        <span className={row.pct >= 0 ? "font-semibold text-rose-600" : "font-semibold text-emerald-600"}>
          {heatmapPct(row.pct)}
        </span>
      </div>
      {isStock ? <div className="mt-0.5 text-[11px] text-slate-400">{tile.stock.code} · {tile.industry.name}</div> : null}
      <div className="mt-1.5 space-y-1 text-slate-500">
        {row.historical && <div>{row.firstDate} 至 {row.lastDate} · {row.days} 个交易日</div>}
        <div className="flex justify-between">
          <span>{metricLabel === "成交额" ? "成交额" : "流通市值"}</span>
          <span className="text-slate-700">{heatmapYi(metricLabel === "成交额" ? row.amount : row.floatCap)}</span>
        </div>
        {!row.historical && <div className="flex justify-between">
          <span>主力净流入</span>
          <span className={row.mainInflow >= 0 ? "text-rose-600" : "text-emerald-600"}>{heatmapYi(row.mainInflow)}</span>
        </div>}
        {isStock || row.historical ? null : (
          <div className="flex justify-between">
            <span title="成分股简单平均；行情软件的板块涨跌幅基本是这个口径，可用它对照">等权涨跌</span>
            <span className={tile.industry.pctEqual >= 0 ? "text-rose-600" : "text-emerald-600"}>
              {heatmapPct(tile.industry.pctEqual)}
            </span>
          </div>
        )}
        {isStock || row.historical ? null : (
          <div className="flex justify-between">
            <span>涨跌家数</span>
            <span className="text-slate-700">
              <span className="text-rose-600">{tile.industry.up}</span> / <span className="text-emerald-600">{tile.industry.down}</span>
              <span className="ml-1">共 {tile.industry.count}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function MarketTrendPageLayout({ onOpenStock }) {
  const [trendTab, setTrendTab] = useState("heatmap");
  const [trendYear, setTrendYear] = useState("latest");
  const activeTab = TREND_TABS.find((t) => t.value === trendTab) || TREND_TABS[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex max-w-full flex-wrap rounded-2xl border border-slate-200 bg-slate-50 p-1 sm:rounded-full">
          {TREND_TABS.map((tab) => {
            const active = tab.value === trendTab;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => setTrendTab(tab.value)}
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  active ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-900"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 只有均线趋势子 tab 需要年份回看；今日盘面/资金流分化/热力图都是当下快照。 */}
        {activeTab.ma ? (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>年份</span>
            <select
              value={trendYear}
              onChange={(e) => setTrendYear(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 outline-none"
            >
              {TREND_YEAR_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {/* 判断条件说明：随子 tab 切换 MA 周期，其余不变。只有均线趋势子 tab 展示。 */}
      {activeTab.ma ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-600">
          <div className="mb-1 font-medium text-slate-800">
            当市场同时满足以下三个条件时，我们认为市场处于{activeTab.term}多头趋势中：
          </div>
          <div>1. CLOSE &gt; MA{activeTab.ma}：收盘价在 {activeTab.ma} 日移动平均线之上</div>
          <div>2. MA{activeTab.ma} &gt; MA{activeTab.ma}[1]：{activeTab.ma} 日均线高于前一天的数值，即向上移动</div>
          <div>3. DIF &gt; 0：DIF 线在 0 轴之上</div>
          <div className="mt-1 text-xs text-slate-400">下方每个指数会按上述条件给出当前是否处于{activeTab.term}多头趋势的结论。</div>
        </div>
      ) : null}

      {activeTab.isToday ? (
        <TodayMarketPanel />
      ) : activeTab.isFundflow ? (
        <FundflowDivergencePanel />
      ) : activeTab.isHeatmap ? (
        <MarketHeatmapPanel onOpenStock={onOpenStock} />
      ) : (
        <div className="grid gap-4 2xl:grid-cols-2">
          {TREND_INDICES.map((index) => (
            <IndexTrendCard key={index.code} index={index} tab={activeTab} year={trendYear} />
          ))}
        </div>
      )}
    </div>
  );
}

class FactorResearchErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("Factor research render error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">
        <div className="font-semibold">因子研究页面加载异常</div>
        <div className="mt-2 text-sm">因子数据格式异常或页面状态已过期，请刷新后重试。</div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          重新加载因子页
        </button>
      </div>
    );
  }
}

function FactorResearchPageLayout() {
  const [factorCategory, setFactorCategory] = useState("mature");

  const categoryTabs = [
    { key: "mature", label: "成熟因子" },
    { key: "candidate", label: "预备因子" },
  ];

  const status = factorCategory === "mature" ? "production" : "preliminary";

  return (
    <div className="space-y-6">
      {/* 此页面整体仅管理员可访问。 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm w-fit">
          {categoryTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFactorCategory(t.key)}
              className={`whitespace-nowrap rounded-lg px-5 py-1.5 text-sm font-medium transition-colors ${
                factorCategory === t.key
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setFactorCategory("manage")}
          className={`whitespace-nowrap rounded-xl border px-5 py-1.5 text-sm font-medium shadow-sm transition-colors ${
            factorCategory === "manage"
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-500 hover:text-slate-800"
          }`}
        >
          因子管理
        </button>
      </div>

      {factorCategory === "manage" ? (
        <FactorAdminPanel />
      ) : (
        <div key={status} className="space-y-10">
          <FactorResearchPanel status={status} />
          <FactorDetailPanel status={status} />
        </div>
      )}
    </div>
  );
}

// Fetch every factor (including disabled) for the management table.
async function fetchAdminFactors(signal) {
  const res = await apiFetch(`/api/admin/factors`, { cache: "no-store", signal });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  if (!Array.isArray(payload.data)) throw new Error("因子管理接口返回格式异常");
  return payload.data.filter((item) => item && typeof item === "object");
}

async function patchAdminFactor(name, patch) {
  const res = await apiFetch(`/api/admin/factors/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return true;
}

function formatUpdatedAt(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function safeExternalUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

const EVALUATION_LABELS = {
  freq: "频率",
  engine: "验证引擎",
  window: "验证区间",
  universe: "股票池",
  universe_size: "股票池数量",
  hold_days: "持有天数",
  rebalance_days: "调仓天数",
  n_periods: "样本期数",
  ic_mean: "IC 均值",
  icir: "ICIR",
  icir_ann: "年化 ICIR",
  icir_ann_nonoverlap: "非重叠年化 ICIR",
  ic_pos_ratio: "IC 正向占比",
  ls_winrate: "多空胜率",
  ls_monthly_pct: "月度多空收益",
  ls_net_pct: "净多空收益",
  monotonic: "分组单调",
};

function formatEvaluationValue(key, value) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "number") return String(value);
  if (key === "ic_pos_ratio" || key === "ls_winrate") return `${(value * 100).toFixed(1)}%`;
  if (key === "ls_monthly_pct" || key === "ls_net_pct") return `${value.toFixed(3).replace(/\.?0+$/, "")}%`;
  return String(value);
}

function decisionMeta(value) {
  if (value === "keep") return { label: "保留", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
  if (value === "watch") return { label: "观察", className: "bg-amber-50 text-amber-700 ring-amber-200" };
  if (value === "drop") return { label: "淘汰", className: "bg-red-50 text-red-700 ring-red-200" };
  return { label: value || "未填写", className: "bg-slate-50 text-slate-500 ring-slate-200" };
}

function FactorAdminPanel() {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [savingName, setSavingName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [rowError, setRowError] = useState(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const [expandedNames, setExpandedNames] = useState(() => new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchAdminFactors(ctrl.signal);
        if (active) setRows(data);
      } catch (e) {
        if (active && e.name !== "AbortError") setLoadError(e?.message || "加载失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; ctrl.abort(); };
  }, []);

  // Optimistic immediate-save: apply the patch locally, PATCH, roll back on error.
  async function applyPatch(name, patch) {
    setRowError(null);
    const prev = rows;
    setRows((list) => list.map((r) => (r.name === name ? { ...r, ...patch } : r)));
    setSavingName(name);
    try {
      await patchAdminFactor(name, patch);
      // Reflect server-side audit fields without a refetch.
      setRows((list) =>
        list.map((r) =>
          r.name === name
            ? { ...r, updatedAt: new Date().toISOString(), updatedBy: localStorage.getItem("username") || r.updatedBy }
            : r,
        ),
      );
      setSavedName(name);
      setTimeout(() => setSavedName((cur) => (cur === name ? "" : cur)), 1500);
    } catch (e) {
      setRows(prev); // roll back
      setRowError(`${name}：${e?.message || "保存失败"}`);
    } finally {
      setSavingName((cur) => (cur === name ? "" : cur));
    }
  }

  const total = rows?.length || 0;
  const productionCount = rows?.filter((r) => r.status === "production").length || 0;
  const preliminaryCount = rows?.filter((r) => r.status === "preliminary").length || 0;
  const enabledRows = rows?.filter((r) => r.enabled) || [];
  const disabledRows = rows?.filter((r) => !r.enabled) || [];
  const disabledCount = disabledRows.length;

  const renderRow = (r) => {
    const busy = savingName === r.name;
    const dim = !r.enabled;
    const source = r.source && typeof r.source === "object"
      ? r.source
      : {};
    const sourceUrl = safeExternalUrl(source.url);
    const evaluation = r.evaluation && typeof r.evaluation === "object"
      ? Object.entries(r.evaluation).filter(([, value]) => value !== null && value !== undefined)
      : [];
    const decision = decisionMeta(r.decision);
    const hasDetails = Boolean(
      r.formula || source.ref || source.title || sourceUrl || r.principle
      || r.whyEffective || evaluation.length || r.decision || r.decisionReason
    );
    const expanded = expandedNames.has(r.name);
    return (
      <Fragment key={r.name}>
        <tr
          className={`border-b border-slate-100 ${expanded ? "bg-slate-50/60" : ""} ${dim ? "text-slate-400" : "text-slate-700"}`}
        >
          <td className="px-3 py-3 align-top">
            <div className="truncate font-mono text-xs" title={r.name}>{r.name}</div>
            <button
              type="button"
              disabled={!hasDetails}
              onClick={() =>
                setExpandedNames((current) => {
                  const next = new Set(current);
                  if (next.has(r.name)) next.delete(r.name);
                  else next.add(r.name);
                  return next;
                })
              }
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:text-sky-900 disabled:cursor-default disabled:text-slate-300"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {hasDetails ? (expanded ? "收起资料" : "查看资料") : "暂无资料"}
            </button>
          </td>
          <td className="break-words px-3 py-3 align-top">
            {r.displayName || r.label}
          </td>
          <td className="px-3 py-3 align-top">
            <div className="text-sm leading-relaxed whitespace-pre-wrap">
              {r.summary || <span className="text-slate-300">（未填写）</span>}
            </div>
          </td>
          <td className="px-3 py-3 align-top">
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {[
                { key: "production", label: "正式" },
                { key: "preliminary", label: "预备" },
              ].map((s) => (
                <button
                  key={s.key}
                  type="button"
                  disabled={busy}
                  onClick={() => r.status !== s.key && applyPatch(r.name, { status: s.key })}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    r.status === s.key
                      ? "bg-slate-900 text-white"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </td>
          <td className="px-3 py-3 align-top">
            <button
              type="button"
              role="switch"
              aria-checked={r.enabled}
              disabled={busy}
              onClick={() => applyPatch(r.name, { enabled: !r.enabled })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                r.enabled ? "bg-emerald-500" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  r.enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </td>
          <td className="px-3 py-3 align-top whitespace-nowrap text-xs">
            {savedName === r.name ? (
              <span className="text-emerald-600">✓ 已保存</span>
            ) : (
              formatUpdatedAt(r.updatedAt)
            )}
          </td>
          <td className="break-all px-3 py-3 align-top text-xs">{r.updatedBy || "-"}</td>
        </tr>
        {expanded && (
          <tr className={`border-b border-slate-100 ${dim ? "text-slate-400" : "text-slate-700"}`}>
            <td colSpan={7} className="px-3 pb-4 pt-1">
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 md:grid-cols-2">
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100">
                  <div className="mb-2 text-xs font-semibold text-slate-500">因子原理</div>
                  <div className="text-xs leading-relaxed text-slate-700">
                    {r.principle || <span className="text-slate-300">未填写</span>}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100">
                  <div className="mb-2 text-xs font-semibold text-slate-500">为何有效</div>
                  <div className="text-xs leading-relaxed text-slate-700">
                    {r.whyEffective || <span className="text-slate-300">未填写</span>}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100">
                  <div className="mb-2 text-xs font-semibold text-slate-500">计算公式</div>
                  {r.formula ? (
                    <code className="block whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                      {r.formula}
                    </code>
                  ) : (
                    <span className="text-xs text-slate-300">未填写</span>
                  )}
                </div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100">
                  <div className="mb-2 text-xs font-semibold text-slate-500">来源 / 文章</div>
                  {source.ref || source.title || sourceUrl ? (
                    <div className="space-y-1.5 text-xs leading-relaxed">
                      {source.ref && <div className="font-medium text-slate-700">{source.ref}</div>}
                      {source.title && (
                        sourceUrl ? (
                          <a
                            href={sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block text-sky-700 hover:underline"
                          >
                            {source.title}
                          </a>
                        ) : (
                          <div className="text-slate-600">{source.title}</div>
                        )
                      )}
                      {sourceUrl && !source.title && (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-sky-700 hover:underline"
                        >
                          查看相关文章
                        </a>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-300">未填写</span>
                  )}
                </div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100 md:col-span-2">
                  <div className="mb-2 text-xs font-semibold text-slate-500">评估结果</div>
                  {evaluation.length ? (
                    <div className="flex flex-wrap gap-2">
                      {evaluation.map(([key, value]) => (
                        <div
                          key={key}
                          className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-slate-100"
                        >
                          <span className="text-slate-400">{EVALUATION_LABELS[key] || key}</span>
                          <span className="ml-1.5 font-medium text-slate-700">
                            {formatEvaluationValue(key, value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-300">未填写</span>
                  )}
                </div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-100 md:col-span-2">
                  <div className="mb-2 text-xs font-semibold text-slate-500">研究结论</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${decision.className}`}>
                      {decision.label}
                    </span>
                    {r.decisionReason ? (
                      <span className="leading-relaxed text-slate-700">{r.decisionReason}</span>
                    ) : (
                      <span className="text-slate-300">未填写结论理由</span>
                    )}
                  </div>
                </div>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-base font-semibold text-slate-700">因子管理</div>
        {rows && (
          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            <span>共 {total} 个</span>
            <span>正式 {productionCount} · 预备 {preliminaryCount}</span>
            <span>已停用 {disabledCount}</span>
          </div>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-400">
        点击因子名下方的“查看资料”可展开计算公式与来源文章。正式/预备决定因子归属，启用决定是否在全站展示。修改即时保存。
      </div>

      {rowError && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {rowError}
        </div>
      )}

      {loading && <div className="mt-4 text-sm text-slate-400">加载中…</div>}
      {loadError && <div className="mt-4 text-sm text-red-600">加载失败：{loadError}</div>}

      {rows && (
        <div className="mt-4 overflow-x-auto">
          <table aria-label="因子管理列表" className="w-full min-w-[1200px] table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="w-[160px] px-3 py-3 text-left font-medium">因子名</th>
                <th className="w-[180px] px-3 py-3 text-left font-medium">显示名</th>
                <th className="w-[360px] px-3 py-3 text-left font-medium">简介</th>
                <th className="w-[160px] px-3 py-3 text-left font-medium">状态</th>
                <th className="w-[80px] px-3 py-3 text-left font-medium">启用</th>
                <th className="w-[140px] px-3 py-3 text-left font-medium">更新时间</th>
                <th className="w-[120px] px-3 py-3 text-left font-medium">更新人</th>
              </tr>
            </thead>
            <tbody>
              {enabledRows.map((r) => renderRow(r))}
              {disabledCount > 0 && (
                <tr className="border-b border-slate-100">
                  <td colSpan={7} className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setShowDisabled((v) => !v)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                    >
                      <span
                        className={`inline-block transition-transform ${showDisabled ? "rotate-90" : ""}`}
                      >
                        ▶
                      </span>
                      已停用 {disabledCount} 个
                    </button>
                  </td>
                </tr>
              )}
              {showDisabled && disabledRows.map((r) => renderRow(r))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FactorResearchPanel({ status = "production" }) {
  const [activeTab, setActiveTab] = useState("trailing");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [trailingData, setTrailingData] = useState(null);
  const [customCache, setCustomCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [refreshMessage, setRefreshMessage] = useState("");

  const tabs = [
    { key: "trailing", label: "滚动区间" },
    { key: "custom",   label: "自选起始日" },
  ];
  const customData = customCache[startDate];

  useEffect(() => {
    if (activeTab !== "trailing") return;
    if (trailingData) return;
    const ctrl = new AbortController();
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchFactorReturns("trailing", null, ctrl.signal, status);
        if (active) setTrailingData(data);
      } catch (e) {
        if (active && e.name !== "AbortError") setLoadError(e?.message || "加载失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; ctrl.abort(); };
  }, [activeTab, status, trailingData]);

  useEffect(() => {
    if (activeTab !== "custom") return;
    if (customData) return;
    const ctrl = new AbortController();
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchFactorReturns("custom", startDate, ctrl.signal, status);
        if (active) setCustomCache((prev) => ({ ...prev, [startDate]: data }));
      } catch (e) {
        if (active && e.name !== "AbortError") setLoadError(e?.message || "加载失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; ctrl.abort(); };
  }, [activeTab, startDate, status, customData]);

  const currentData = activeTab === "trailing" ? trailingData : customData;

  async function forceRefresh() {
    setLoading(true);
    setLoadError(null);
    setRefreshMessage("");
    try {
      const data = await fetchFactorReturns(activeTab, startDate, undefined, status, true);
      if (activeTab === "trailing") {
        setTrailingData(data);
        setCustomCache({});
      } else {
        setCustomCache({ [startDate]: data });
        setTrailingData(null);
      }
      setRefreshMessage(`已硬刷新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
    } catch (e) {
      setLoadError(e?.message || "硬刷新失败");
    } finally {
      setLoading(false);
    }
  }

  const periods = FACTOR_RETURN_PERIODS.map((p) => ({
    ...p,
    displayLabel:
      activeTab === "trailing"
        ? p.label
        : `${formatDateLabel(startDate)} 起 · ${p.forwardLabel}`,
    data: Array.isArray(currentData?.[p.key]) ? currentData[p.key] : [],
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-slate-700">因子整体表现</div>
          <div className="mt-1 text-xs text-slate-400">硬刷新会清空所有因子收益缓存，并基于最新历史信号与 K 线重新计算。</div>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={forceRefresh}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          硬刷新因子
        </button>
      </div>
      {/* Tab 切换 + 日期选择器 */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === t.key
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === "custom" && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="shrink-0">起始日期</span>
            <input
              type="date"
              value={startDate}
              max={todayStr()}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 shadow-sm outline-none focus:border-slate-400"
            />
          </div>
        )}

        {loading && <span className="text-xs text-slate-400">重新计算中…</span>}
        {!loading && refreshMessage && <span className="text-xs text-emerald-600">{refreshMessage}</span>}
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {loadError}
        </div>
      )}

      <div className="rounded-xl bg-slate-50 px-4 py-2.5 text-xs text-slate-400 leading-5">
        收益率 = ( 第 N 交易日收盘价 &minus; 信号日收盘价 ) &divide; 信号日收盘价 &times; 100%
        <br />均值按「非重叠持有期」统计：同一只票在一个持有窗口内只计一次，避免慢变量因子（如 amihud_20）因每日重复入选而高估。悬停可看各因子的独立样本数 n。
      </div>

      {/* 图表网格 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {periods.slice(0, 3).map((p) => (
          <FactorBarChart key={p.key} data={p.data} label={p.displayLabel} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {periods.slice(3).map((p) => (
          <FactorBarChart key={p.key} data={p.data} label={p.displayLabel} />
        ))}
      </div>
    </div>
  );
}

function WatchlistPanel({
  market,
  inputValue,
  items,
  activeCode,
  loading,
  error,
  style,
  recommendationFactor = "factor1",
  recommendationDate = "",
  favoriteCodeSet,
  favoritePendingCodeSet,
  onInputChange,
  onRefresh,
  onStyleChange,
  onRecommendationFactorChange,
  onRecommendationDateChange,
  onPick,
  onToggleFavorite,
  preloadEnabled = false,
  onTogglePreload = null,
  preloadStatus = null,
  onClearPreloadCache = null,
}) {
  const isAshare = market === "ashare";
  const isHk = market === "hk";
  const isUs = market === "us";
  const title = isAshare ? "A股自选" : isHk ? "港股自选" : "美股自选";
  const helper = isAshare
    ? "支持逗号、空格、换行分隔；一行一个 A 股代码也可以。"
    : isHk
      ? "支持 1 至 5 位港股代码，会自动补足前导零。"
      : "支持逗号、空格、换行分隔；一行一个美股代码也可以。";
  const placeholder = isAshare ? "例如 600519,000001\n000001\n300750" : isHk ? "例如 00700,09988\n3690\n00005" : "例如 MSFT,AAPL\nNVDA\nTSLA";
  const isRecommendationMode = !isHk && style === "rows";
  const panelTitle = isRecommendationMode ? `${isAshare ? "A股" : "美股"}推荐列表` : title;
  const recommendationMaxDate = formatRecommendationDateInput(getDefaultRecommendationDate());

  // Recommendation factor dropdown — load正式因子 from factor_dim so newly
  // promoted factors show up. Falls back to the static list if the API fails.
  const [factorOptions, setFactorOptions] = useState(RECOMMENDATION_FACTOR_OPTIONS);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchFactors("production", ctrl.signal)
      .then((list) => {
        if (list?.length) {
          setFactorOptions(list.map((f) => ({ value: f.name, label: f.label ?? factorLabelFromName(f.name) })));
        }
      })
      .catch(() => { /* keep fallback options */ });
    return () => ctrl.abort();
  }, []);

  function renderFavoriteButton(item) {
    const favorited = favoriteCodeSet?.has(item.code);
    const pending = favoritePendingCodeSet?.has(item.code);

    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite?.(item);
        }}
        disabled={pending}
        className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
          favorited
            ? "bg-amber-50 text-amber-500 ring-1 ring-amber-200 hover:bg-amber-100"
            : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
        } disabled:cursor-not-allowed disabled:opacity-60`}
        title={favorited ? "取消收藏" : "加入收藏"}
        aria-label={favorited ? `取消收藏 ${item.code}` : `加入收藏 ${item.code}`}
      >
        <Star className="h-3 w-3" fill={favorited ? "currentColor" : "none"} />
        <span>#{item.rankLabel}</span>
      </button>
    );
  }

  return (
    <Card className="rounded-2xl border-slate-200 bg-[image:var(--panel-gradient)] shadow-sm xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)] xl:max-h-[1200px]">
      <CardContent className="flex h-full min-h-0 flex-col p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-900">{panelTitle}</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">{isRecommendationMode ? `共 ${items.length} 个标的` : helper}</div>
          </div>
          <div className="grid w-[132px] shrink-0 grid-cols-2 rounded-full border border-slate-200 bg-white p-1">
            {WATCHLIST_STYLE_OPTIONS.filter((option) => !isHk || option.value === "cards").map((option) => {
              const active = style === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`whitespace-nowrap rounded-full px-0 py-1 text-center text-xs transition ${active ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"}`}
                  onClick={() => onStyleChange(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {isRecommendationMode ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">因子</div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={recommendationFactor}
                  onChange={(e) => onRecommendationFactorChange?.(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none"
                >
                  {factorOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <div className="relative">
                  <input
                    type="date"
                    value={formatRecommendationDateInput(recommendationDate)}
                    max={recommendationMaxDate}
                    onChange={(e) => onRecommendationDateChange?.(normalizeRecommendationDate(e.target.value))}
                    className="absolute inset-0 z-10 cursor-pointer opacity-0"
                    onFocus={(e) => e.target.showPicker()}
                    onClick={(e) => e.target.showPicker()}
                  />
                  <input
                    type="text"
                    readOnly
                    value={formatRecommendationDateInput(recommendationDate)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none"
                    placeholder="YYYY-MM-DD"
                  />
                </div>
                <div className="col-span-2 flex justify-end">
                  <Button onClick={onRefresh} disabled={loading} className="rounded-xl px-3">
                    <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    {loading ? "读取中" : "查询"}
                  </Button>
                </div>
              </div>
            </div>

          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
          <textarea
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={placeholder}
            className="min-h-20 w-full resize-none bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-slate-400">支持逗号、空格、换行分隔，也支持一行一个代码</div>
            <Button onClick={onRefresh} disabled={loading} className="rounded-xl">
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "生成中" : "生成列表"}
            </Button>
          </div>
        </div>
        )}

        {error && (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {error}
          </div>
        )}

        {isUs && (
          <div className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-900">预加载</div>
                <div className="mt-1 pr-2 text-[11px] leading-5 text-slate-500">
                  默认开启。后台按顺序缓存当前列表里的美股数据，请求间隔至少 0.5s，点击时优先使用缓存。
                </div>
              </div>
              <button
                type="button"
                onClick={onTogglePreload}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                  preloadEnabled ? "bg-emerald-500" : "bg-slate-300"
                }`}
                aria-pressed={preloadEnabled}
                title={preloadEnabled ? "关闭美股预加载" : "开启美股预加载"}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition ${
                    preloadEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span className="min-w-0 flex-1">
                {preloadStatus?.running
                  ? `后台预加载中 ${preloadStatus.done}/${preloadStatus.total}`
                  : preloadStatus?.total
                    ? `已缓存 ${preloadStatus.done}/${preloadStatus.total}`
                    : "等待当前列表生成后开始预加载"}
              </span>
              {preloadStatus?.current && <span className="shrink-0 font-mono text-slate-700">{preloadStatus.current}</span>}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onClearPreloadCache}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                清空缓存
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
          {items.length > 0 ? (
            items.map((item, index) => {
              const active = item.code === activeCode;
              const rankLabel = String(index + 1).padStart(2, "0");
              const cardStyle = style === "cards";
              if (cardStyle) {
                return (
                  <div
                    key={item.code}
                    className={`overflow-hidden rounded-2xl border text-left transition ${active
                      ? "border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-200"
                      : "border-slate-200 bg-white/95 text-slate-900 shadow-sm hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"}`}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onPick(item.code)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        onPick(item.code);
                      }}
                      className="block w-full cursor-pointer p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          {renderFavoriteButton({ ...item, rankLabel })}
                          <div className={`mt-3 font-mono text-lg font-semibold ${active ? "text-white" : "text-slate-900"}`}>
                            {item.code}
                          </div>
                          {!isRecommendationMode && (
                            <div className={`mt-1 text-sm ${active ? "text-slate-200" : "text-slate-500"}`}>
                              {item.name || "名称加载中"}
                            </div>
                          )}
                        </div>
                        {active && (
                          <div className="rounded-full bg-emerald-400/20 px-2.5 py-1 text-[11px] font-medium text-emerald-100 ring-1 ring-emerald-300/30">
                            当前查看
                          </div>
                        )}
                      </div>
                    </div>
                    {!isRecommendationMode ? <div className="pb-4" /> : null}
                  </div>
                );
              }
              return (
                <div
                  key={item.code}
                  className={`overflow-hidden rounded-2xl border text-left transition ${
                    active
                      ? "border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-200"
                      : "border-slate-200 bg-white/95 text-slate-900 shadow-sm hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                  }`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onPick(item.code)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      onPick(item.code);
                    }}
                    className="block w-full cursor-pointer p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        {renderFavoriteButton({ ...item, rankLabel })}
                        <div className={`mt-3 font-mono text-lg font-semibold ${active ? "text-white" : "text-slate-900"}`}>
                          {item.code}
                        </div>
                        {item.name && item.name !== item.code && (
                          <div className={`mt-1 text-sm ${active ? "text-slate-200" : "text-slate-500"}`}>
                            {item.name}
                          </div>
                        )}
                      </div>
                      {active && (
                        <div className="rounded-full bg-emerald-400/20 px-2.5 py-1 text-[11px] font-medium text-emerald-100 ring-1 ring-emerald-300/30">
                          当前查看
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              {isRecommendationMode ? `今天没有符合要求的${factorLabelFromName(recommendationFactor)}。` : "输入股票代码后，这里会生成收藏卡片。"}
            </div>
          )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FavoritesToolbar({
  market,
  items,
  open,
  loading,
  error,
  pendingCodeSet,
  groups,
  activeGroup,
  onToggleOpen,
  onRefresh,
  onPick,
  onRemove,
  onSelectGroup,
  onCreateGroup,
  onDeleteGroup,
  onMoveItem,
}) {
  const title = market === "us" ? "我的美股收藏夹" : market === "hk" ? "我的港股收藏夹" : "我的股票收藏夹";
  const groupList = groups && groups.length ? groups : ["默认"];
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // 每个收藏夹的票数，用于 chip 上的角标。
  const countByGroup = useMemo(() => {
    const map = {};
    for (const it of items) {
      const g = it.group || "默认";
      map[g] = (map[g] || 0) + 1;
    }
    return map;
  }, [items]);

  // 仅展示当前选中收藏夹里的票。
  const visibleItems = useMemo(
    () => items.filter((it) => (it.group || "默认") === activeGroup),
    [items, activeGroup],
  );

  function submitNewGroup() {
    const name = newName.trim();
    if (name) onCreateGroup?.(name);
    setNewName("");
    setCreating(false);
  }

  return (
    <>
      {open && <button type="button" aria-label="关闭收藏夹" className="fixed inset-0 z-30 cursor-default bg-transparent" onClick={onToggleOpen} />}

      <div className="fixed bottom-4 right-3 z-40 flex flex-col gap-3 md:bottom-auto md:top-1/2 md:-translate-y-1/2">
        <button
          type="button"
          onClick={onToggleOpen}
          className={`group flex min-h-16 w-14 flex-col items-center justify-center rounded-2xl border px-2 py-3 text-xs shadow-lg backdrop-blur transition ${
            open
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white/92 text-slate-600 hover:border-slate-300 hover:text-slate-900"
          }`}
          title={title}
        >
          <Star className="h-4 w-4" fill={open ? "currentColor" : "none"} />
          <span className="mt-2 leading-4">收藏夹</span>
          <span className={`mt-1 rounded-full px-1.5 py-0.5 text-[10px] ${open ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"}`}>
            {items.length}
          </span>
        </button>
      </div>

      {open && (
        <div className="fixed bottom-24 right-3 z-40 w-[320px] max-w-[calc(100vw-1.5rem)] md:bottom-auto md:top-1/2 md:right-20 md:max-h-[70vh] md:-translate-y-1/2">
          <Card className="overflow-hidden rounded-[28px] border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">{title}</div>
                  <div className="mt-1 text-xs text-slate-500">分收藏夹管理，新收藏将加入当前夹</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                    title="刷新收藏夹"
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    type="button"
                    onClick={onToggleOpen}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                    title="收起收藏夹"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* 收藏夹切换 chips + 新建 */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-4 py-3">
                {groupList.map((g) => {
                  const active = g === activeGroup;
                  const isDefault = g === "默认";
                  return (
                    <span
                      key={g}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
                        active
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      <button type="button" onClick={() => onSelectGroup?.(g)} className="inline-flex max-w-[10rem] items-center gap-1">
                        <span className="truncate">{g}</span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 ${active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}
                          title={`${countByGroup[g] || 0} 只股票`}
                        >
                          {countByGroup[g] || 0}
                        </span>
                      </button>
                      {!isDefault && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`删除收藏夹「${g}」会同时删除其中的 ${countByGroup[g] || 0} 只股票，确定吗？`)) {
                              onDeleteGroup?.(g);
                            }
                          }}
                          className={`-mr-0.5 rounded-full p-0.5 ${active ? "text-white/70 hover:text-white" : "text-slate-300 hover:text-red-500"}`}
                          title={`删除收藏夹「${g}」`}
                          aria-label={`删除收藏夹 ${g}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  );
                })}

                {creating ? (
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onBlur={submitNewGroup}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitNewGroup();
                      else if (e.key === "Escape") { setNewName(""); setCreating(false); }
                    }}
                    maxLength={30}
                    placeholder="收藏夹名称"
                    className="w-28 rounded-full border border-slate-300 px-2.5 py-1 text-xs outline-none focus:border-slate-500"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 transition hover:border-slate-400 hover:text-slate-900"
                    title="新建收藏夹"
                  >
                    <Plus className="h-3 w-3" />新建
                  </button>
                )}
              </div>

              {error ? (
                <div className="border-b border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-700">{error}</div>
              ) : null}

              <div className="max-h-[48vh] space-y-3 overflow-y-auto p-4">
                {visibleItems.length ? (
                  visibleItems.map((item, index) => {
                    const pending = pendingCodeSet?.has(item.code);

                    return (
                      <div
                        key={`${item.code}-${item.createdAt || index}`}
                        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button type="button" onClick={() => onPick(item.code)} className="min-w-0 flex-1 text-left">
                            <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-500">
                              <Star className="h-3 w-3" fill="currentColor" />
                              #{String(index + 1).padStart(2, "0")}
                            </div>
                            <div className="mt-3 font-mono text-lg font-semibold text-slate-900">{item.code}</div>
                            <div className="mt-1 truncate text-sm text-slate-500">{item.name || item.code}</div>
                            <div className="mt-3 text-[11px] text-slate-400">
                              收藏于 {formatFavoriteTime(item.createdAt)}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemove(item)}
                            disabled={pending}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                            title="删除收藏"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        {groupList.length > 1 && (
                          <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
                            移动到
                            <select
                              value={item.group || "默认"}
                              disabled={pending}
                              onChange={(e) => onMoveItem?.(item, e.target.value)}
                              className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-slate-400 disabled:opacity-60"
                            >
                              {groupList.map((g) => (
                                <option key={g} value={g}>{g}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                    「{activeGroup}」还没有收藏股票，点击列表里的星星即可加入此夹。
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

export default function AShareTD9InteractiveChart({ onLogout, user, themePreference = "system", onThemeChange }) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [market, setMarket] = useState("ashare");
  // 初始为空：挂载后默认选中自选/收藏夹里的第一只，不再写死茅台/MSFT。
  const [marketCodes, setMarketCodes] = useState({ ashare: "", hk: "", us: "" });
  const [ashareSuggestions, setAshareSuggestions] = useState([]);
  const [ashareSuggestLoading, setAshareSuggestLoading] = useState(false);
  const [ashareSuggestOpen, setAshareSuggestOpen] = useState(false);
  const [ashareSuggestFocused, setAshareSuggestFocused] = useState(false);
  const [ashareSuggestIndex, setAshareSuggestIndex] = useState(0);
  const [hkSuggestions, setHkSuggestions] = useState([]);
  const [hkSuggestLoading, setHkSuggestLoading] = useState(false);
  const [hkSuggestOpen, setHkSuggestOpen] = useState(false);
  const [hkSuggestFocused, setHkSuggestFocused] = useState(false);
  const [hkSuggestIndex, setHkSuggestIndex] = useState(0);
  // 初始为空：挂载后 loadDefaultWatchlist 会用收藏夹最新 10 只（或随机 5 只）填充。
  const [watchlistInputMap, setWatchlistInputMap] = useState({
    ashare: "",
    hk: "",
    us: "",
  });
  const [watchlistItemsMap, setWatchlistItemsMap] = useState({ ashare: [], hk: [], us: [] });
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistError, setWatchlistError] = useState("");
  const [favoriteItemsMap, setFavoriteItemsMap] = useState({ ashare: [], hk: [], us: [] });
  const [favoriteLoadingMap, setFavoriteLoadingMap] = useState({ ashare: false, hk: false, us: false });
  const [favoriteErrorMap, setFavoriteErrorMap] = useState({ ashare: "", hk: "", us: "" });
  const [favoritePendingMap, setFavoritePendingMap] = useState({ ashare: [], hk: [], us: [] });
  const [favoriteGroupsMap, setFavoriteGroupsMap] = useState({ ashare: ["默认"], hk: ["默认"], us: ["默认"] });
  const [activeFavoriteGroupMap, setActiveFavoriteGroupMap] = useState({ ashare: "默认", hk: "默认", us: "默认" });
  const [favoritesPanelOpen, setFavoritesPanelOpen] = useState(false);
  const [recommendationItemsMap, setRecommendationItemsMap] = useState({ ashare: [], us: [] });
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [recommendationError, setRecommendationError] = useState("");
  const [recommendationFactorMap, setRecommendationFactorMap] = useState({ ashare: "factor1", us: "factor1" });
  const [recommendationDateMap, setRecommendationDateMap] = useState({
    ashare: getDefaultRecommendationDate(),
    us: getDefaultRecommendationDate(),
  });
  const [watchlistStyle, setWatchlistStyle] = useState("cards");
  const [period, setPeriod] = useState("101");
  const adjust = "1";
  const [displayCount, setDisplayCount] = useState(80);
  const [tdMode, setTdMode] = useState("current");
  const [showGaps, setShowGaps] = useState(true);
  const [unfilledOnly, setUnfilledOnly] = useState(true);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [drawingTool, setDrawingTool] = useState("none");
  const [drawnLines, setDrawnLines] = useState([]);
  const [usPreloadEnabled, setUsPreloadEnabled] = useState(true);
  const [usPreloadStatus, setUsPreloadStatus] = useState({ running: false, total: 0, done: 0, current: "" });
  const [rawRows, setRawRows] = useState([]);
  const [meta, setMeta] = useState({ code: "", name: "" });
  const [financialInfo, setFinancialInfo] = useState(null);
  const [financialLoading, setFinancialLoading] = useState(false);
  const [financialError, setFinancialError] = useState("");
  const [fundFlowInfo, setFundFlowInfo] = useState(null);
  const [fundFlowLoading, setFundFlowLoading] = useState(false);
  const [fundFlowError, setFundFlowError] = useState("");
  const [profileInfo, setProfileInfo] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [suspensionRisk, setSuspensionRisk] = useState(null); // 停牌风险（仅 A 股），来自 /api/suspension-alert
  const [profileError, setProfileError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPatterns, setShowPatterns] = useState(false);
  const [chanOptions, setChanOptions] = useState({ enabled: true, bi: true, zs: true, fx: true });
  const [analysisTab, setAnalysisTab] = useState("financial");
  const chanData = useMemo(() => analyzeChan(rawRows, period), [rawRows, period]);

  function handleChanOptionsChange(next) {
    // Only entering Chan mode selects 80 bars; later viewport changes stay independent.
    if (!chanOptions.enabled && next.enabled) {
      setDisplayCount(80);
      setAnalysisTab("outlook");
    }
    if (chanOptions.enabled && !next.enabled) {
      setDisplayCount(240);
      setAnalysisTab("news");
    }
    setChanOptions(next);
  }

  const fullRowsWithTD = useMemo(() => calcTD9(rawRows, tdMode), [rawRows, tdMode]);
  const displayStartIndex = Math.max(0, fullRowsWithTD.length - displayCount);
  const rows = useMemo(() => fullRowsWithTD.slice(displayStartIndex), [fullRowsWithTD, displayStartIndex]);
  const visibleGaps = useMemo(() => {
    const displayEndIndex = fullRowsWithTD.length - 1;
    const all = calcGaps(rawRows);
    const filtered = unfilledOnly ? all.filter((g) => !g.filled) : all;
    return filtered
      .filter((g) => g.endIndex >= displayStartIndex && g.startIndex <= displayEndIndex)
      .map((g) => ({
        ...g,
        startIndex: Math.max(g.startIndex, displayStartIndex) - displayStartIndex,
        endIndex: Math.min(g.endIndex, displayEndIndex) - displayStartIndex,
      }));
  }, [rawRows, fullRowsWithTD.length, displayStartIndex, unfilledOnly]);
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  const latestColor = latest && latest.close >= latest.open ? "text-red-600" : "text-green-700";
  const displayedPrice = market === "hk" && Number.isFinite(meta.latestPrice) ? meta.latestPrice : latest?.close;
  const displayedPct = market === "hk" && Number.isFinite(meta.quotePct) ? meta.quotePct : latest?.pct;
  const prediction = useMemo(() => buildTrendPrediction(rawRows), [rawRows]);
  const rsiInfo = useMemo(() => calcRSIState(rawRows), [rawRows]);
  const vwapInfo = useMemo(() => market === "ashare" ? calcVWAPState(rawRows) : {
    ready: meta.sessionVwapSource === "tencent" && Number.isFinite(meta.sessionVwap) && meta.sessionVwap > 0,
    value: meta.sessionVwap,
    premium: meta.sessionVwapPremium,
  }, [rawRows, market, meta.sessionVwap, meta.sessionVwapPremium, meta.sessionVwapSource]);

  // 这些 tab 是独立页面，没有个股的代码搜索/周期/复权等控件，也不触发自动取数。
  const isStandaloneMarket = market === "agent" || market === "factor-research" || market === "market-trend" || market === "user-admin" || market === "account";
  const currentCode = marketCodes[market] || "";

  const watchlistInput = watchlistInputMap[market] || "";
  const favoriteItems = favoriteItemsMap[market] || EMPTY_LIST;
  const favoriteLoading = favoriteLoadingMap[market] || false;
  const favoriteError = favoriteErrorMap[market] || "";
  const favoritePendingCodes = favoritePendingMap[market] || EMPTY_LIST;
  const favoriteGroups = favoriteGroupsMap[market] || ["默认"];
  const activeFavoriteGroup = activeFavoriteGroupMap[market] || "默认";
  const favoriteCodeSet = useMemo(() => new Set(favoriteItems.map((item) => item.code)), [favoriteItems]);
  const favoritePendingCodeSet = useMemo(() => new Set(favoritePendingCodes), [favoritePendingCodes]);
  const activeMetaCode = normalizeCodeForMarket(meta.code || currentCode, market);
  const activeMetaFavoritePending = favoritePendingCodeSet.has(activeMetaCode);
  const activeMetaFavorited = favoriteCodeSet.has(activeMetaCode);
  const manualWatchlistItems = watchlistItemsMap[market] || EMPTY_LIST;
  const recommendationItems = recommendationItemsMap[market] || EMPTY_LIST;
  const effectiveWatchlistStyle = market === "hk" ? "cards" : watchlistStyle;
  const watchlistItems = effectiveWatchlistStyle === "rows" ? recommendationItems : manualWatchlistItems;
  const watchlistLoadingState = effectiveWatchlistStyle === "rows" ? recommendationLoading : watchlistLoading;
  const watchlistErrorState = effectiveWatchlistStyle === "rows" ? recommendationError : watchlistError;
  const recommendationFactor = market === "us" ? recommendationFactorMap.us : recommendationFactorMap.ashare;
  const recommendationDate = market === "us" ? recommendationDateMap.us : recommendationDateMap.ashare;
  const usPreloadCodes = useMemo(() => {
    if (market !== "us") return [];

    const seen = new Set();
    const codes = [];
    for (const item of watchlistItems) {
      const code = normalizeUsSymbol(item?.code);
      if (!isValidUsSymbol(code) || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
    return codes;
  }, [market, watchlistItems]);
  // 用户是否手动选过收藏夹（按市场）。未手动选过时，默认选中最新建的收藏夹。
  const favoriteGroupTouchedRef = useRef({ ashare: false, hk: false, us: false });
  const marketRef = useRef(market);
  const marketCodesRef = useRef(marketCodes);
  const loadRunRef = useRef(0);
  const usKlineCacheRef = useRef(new Map());
  const usPreloadRunRef = useRef(0);

  useEffect(() => {
    marketRef.current = market;
    marketCodesRef.current = marketCodes;
  }, [market, marketCodes]);

  function setFavoritePending(marketKey, code, active) {
    setFavoritePendingMap((prev) => {
      const current = new Set(prev[marketKey] || []);
      if (active) current.add(code);
      else current.delete(code);
      return { ...prev, [marketKey]: Array.from(current) };
    });
  }

  async function fetchUsKlineCached({ symbol, period: targetPeriod, adjust: targetAdjust, limit, force = false }) {
    const normalized = normalizeUsSymbol(symbol);
    const cacheKey = `${normalized}|${targetPeriod}|${targetAdjust}|${limit}`;
    const cached = usKlineCacheRef.current.get(cacheKey);
    if (!force && isUsKlineCacheFresh(cached)) return cached.data;
    if (!force && cached?.promise) return cached.promise;

    const promise = fetchUsKline({
      symbol: normalized,
      period: targetPeriod,
      adjust: targetAdjust,
      limit,
    }).then((data) => {
      usKlineCacheRef.current.set(cacheKey, { data, ts: Date.now() });
      return data;
    }).catch((error) => {
      usKlineCacheRef.current.delete(cacheKey);
      throw error;
    });

    usKlineCacheRef.current.set(cacheKey, { promise, ts: Date.now() });
    return promise;
  }

  function handleSelectDrawingTool(nextTool) {
    setDrawingTool(nextTool);
    if (nextTool === "none") setDrawnLines([]);
  }

  function clearDrawings() {
    setDrawnLines([]);
    setDrawingTool("none");
  }

  function undoLastDrawing() {
    setDrawnLines((prev) => prev.slice(0, -1));
  }

  function clearUsPreloadCache() {
    const nextCache = new Map();
    for (const [key, value] of usKlineCacheRef.current.entries()) {
      if (!String(key).includes("|")) {
        nextCache.set(key, value);
        continue;
      }
      const [symbol] = String(key).split("|");
      if (!isValidUsSymbol(symbol)) nextCache.set(key, value);
    }
    usKlineCacheRef.current = nextCache;
    setUsPreloadStatus((prev) => ({
      ...prev,
      done: 0,
      current: "",
    }));
  }

  function selectAshareSuggestion(item) {
    const code = onlyDigits(item?.code);
    if (!isSixDigitCode(code)) return;
    setMarketCodes((prev) => ({ ...prev, ashare: code }));
    setAshareSuggestions([]);
    setAshareSuggestOpen(false);
    setAshareSuggestIndex(0);
    load(code);
  }

  function selectHkSuggestion(item) {
    const code = normalizeHkCode(item?.code);
    if (!isValidHkCode(code)) return;
    setMarketCodes((prev) => ({ ...prev, hk: code }));
    setHkSuggestions([]);
    setHkSuggestOpen(false);
    setHkSuggestIndex(0);
    load(code);
  }

  useEffect(() => {
    if (!chartFullscreen) return undefined;
    function handleKeydown(event) {
      if (event.key === "Escape") setChartFullscreen(false);
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [chartFullscreen]);

  useEffect(() => {
    if (market !== "ashare" || !ashareSuggestFocused) {
      setAshareSuggestions([]);
      setAshareSuggestOpen(false);
      setAshareSuggestLoading(false);
      return undefined;
    }

    const query = String(currentCode || "").trim();
    if (!query) {
      setAshareSuggestions([]);
      setAshareSuggestOpen(false);
      setAshareSuggestLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAshareSuggestLoading(true);
      try {
        const items = await fetchAshareSuggestions(query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAshareSuggestions(items);
        setAshareSuggestIndex(0);
        setAshareSuggestOpen(items.length > 0 && ashareSuggestFocused);
      } catch {
        if (!controller.signal.aborted) {
          setAshareSuggestions([]);
          setAshareSuggestOpen(false);
        }
      } finally {
        if (!controller.signal.aborted) setAshareSuggestLoading(false);
      }
    }, 320);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [market, currentCode, ashareSuggestFocused]);

  useEffect(() => {
    if (market !== "hk" || !hkSuggestFocused) {
      setHkSuggestions([]);
      setHkSuggestOpen(false);
      setHkSuggestLoading(false);
      return undefined;
    }

    const query = String(currentCode || "").trim();
    if (!query) {
      setHkSuggestions([]);
      setHkSuggestOpen(false);
      setHkSuggestLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setHkSuggestLoading(true);
      try {
        const items = await fetchHkSuggestions(query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setHkSuggestions(items);
        setHkSuggestIndex(0);
        setHkSuggestOpen(items.length > 0 && hkSuggestFocused);
      } catch {
        if (!controller.signal.aborted) {
          setHkSuggestions([]);
          setHkSuggestOpen(false);
        }
      } finally {
        if (!controller.signal.aborted) setHkSuggestLoading(false);
      }
    }, 320);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [market, currentCode, hkSuggestFocused]);

  // 默认自选填充：优先展示收藏夹最新 10 只，收藏夹为空则从备选池随机取 5 只。
  async function loadDefaultWatchlist(targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));

    let codes = [];
    try {
      const payload = await fetchFavorites({ market: requestedMarket });
      const favItems = Array.isArray(payload?.items) ? payload.items : [];
      codes = [...favItems]
        .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0))
        .map((item) => item?.code)
        .filter(Boolean)
        .slice(0, 10);
    } catch {
      // 收藏夹读取失败时回落到随机池。
    }

    if (!codes.length) {
      const pool = requestedMarket === "us" ? US_FALLBACK_WATCHLIST : requestedMarket === "hk" ? HK_FALLBACK_WATCHLIST : ASHARE_FALLBACK_WATCHLIST;
      codes = pickRandomCodes(pool, 5);
    }

    // 同步输入框，保证「生成列表」复现一致。
    setWatchlistInputMap((prev) => ({ ...prev, [requestedMarket]: codes.join(",") }));

    // 该市场还没有选中标的时，默认选中并加载第一只（首屏不再写死茅台）。
    const alreadySelected = marketCodesRef.current[requestedMarket];
    if (!alreadySelected && codes.length) {
      marketCodesRef.current = { ...marketCodesRef.current, [requestedMarket]: codes[0] };
      setMarketCodes((prev) => ({ ...prev, [requestedMarket]: codes[0] }));
      if (requestedMarket === marketRef.current) load(codes[0]);
    }

    await loadWatchlist(requestedMarket, codes);
  }

  async function loadWatchlist(targetMarket = market, codesOverride = null) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    const rawInput = codesOverride != null
      ? (Array.isArray(codesOverride) ? codesOverride.join(",") : codesOverride)
      : (watchlistInputMap[requestedMarket] || "");
    const codes = normalizeWatchlistCodes(rawInput, requestedMarket);

    if (!codes.length) {
      setWatchlistError(requestedMarket === "ashare" ? "请先输入至少一个 6 位 A 股代码。" : requestedMarket === "hk" ? "请先输入至少一个有效的港股代码。" : "请先输入至少一个有效的美股代码。");
      setWatchlistItemsMap((prev) => ({ ...prev, [requestedMarket]: [] }));
      return;
    }

    setWatchlistLoading(true);
    setWatchlistError("");
    try {
      const activeMeta = requestedMarket === market ? meta : null;
      const results = await Promise.allSettled(
        codes.map(async (code) => {
          if (activeMeta?.code === code && activeMeta?.name) {
            return { code, name: activeMeta.name };
          }
          const detail = requestedMarket === "ashare"
            ? await fetchAshareKline({ code, period, adjust, limit: 60 })
            : requestedMarket === "hk"
              ? await fetchHkKline({ code, period, adjust, limit: 60 })
              : await fetchUsKlineCached({ symbol: code, period, adjust, limit: 60 });
          return {
            code: detail.code || code,
            name: detail.name || code,
          };
        }),
      );

      const nextItems = results
        .filter((item) => item.status === "fulfilled")
        .map((item) => item.value);
      const failedCodes = results
        .map((item, index) => ({ item, code: codes[index] }))
        .filter(({ item }) => item.status === "rejected")
        .map(({ code }) => code);

      setWatchlistItemsMap((prev) => ({ ...prev, [requestedMarket]: nextItems }));
      setWatchlistError(failedCodes.length ? `以下代码暂时未能加载名称：${failedCodes.join("、")}` : "");
    } catch (e) {
      setWatchlistError(getErrorMessage(e, "自选列表生成失败，请检查代码后重试。"));
    } finally {
      setWatchlistLoading(false);
    }
  }

  async function loadRecommendations(targetMarket = market) {
    if (targetMarket === "hk") return;
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
    const factor = requestedMarket === "us" ? recommendationFactorMap.us : recommendationFactorMap.ashare;
    const date = requestedMarket === "us" ? recommendationDateMap.us : recommendationDateMap.ashare;
    setRecommendationLoading(true);
    setRecommendationError("");

    try {
      const payload = await fetchRecommendationList({ market: requestedMarket, factor, date });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setRecommendationItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      // Empty isn't an error — the factor just has no qualifying picks today.
      // The friendly "今天没有符合要求的因子X" placeholder covers this case.
    } catch (e) {
      setRecommendationError(getErrorMessage(e, "推荐列表读取失败，请检查 Redis key 或数据格式。"));
      setRecommendationItemsMap((prev) => ({ ...prev, [requestedMarket]: [] }));
    } finally {
      setRecommendationLoading(false);
    }
  }

  async function loadFavorites(targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    setFavoriteLoadingMap((prev) => ({ ...prev, [requestedMarket]: true }));
    setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));

    try {
      const payload = await fetchFavorites({ market: requestedMarket });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const groups = Array.isArray(payload?.groups) && payload.groups.length ? payload.groups : ["默认"];
      setFavoriteItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      setFavoriteGroupsMap((prev) => ({ ...prev, [requestedMarket]: groups }));
      setActiveFavoriteGroupMap((prev) => {
        // 用户没手动选过：默认选中最新建的收藏夹（列表最后一个），新收藏即落入此夹。
        if (!favoriteGroupTouchedRef.current[requestedMarket]) {
          return { ...prev, [requestedMarket]: groups[groups.length - 1] || "默认" };
        }
        // 已手动选过：保留选择，除非该夹已被删，回落默认夹。
        return groups.includes(prev[requestedMarket]) ? prev : { ...prev, [requestedMarket]: "默认" };
      });
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "收藏夹读取失败，请稍后重试。") }));
    } finally {
      setFavoriteLoadingMap((prev) => ({ ...prev, [requestedMarket]: false }));
    }
  }

  async function toggleFavorite(item, targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    const code = normalizeCodeForMarket(item?.code, requestedMarket);
    if (!code) return;

    setFavoritePending(requestedMarket, code, true);

    try {
      const payload = favoriteCodeSet.has(code)
        ? await removeFavorite({ market: requestedMarket, code })
        : await addFavorite({
          market: requestedMarket,
          code,
          name: item?.name || (meta.code === code ? meta.name : "") || code,
          // 新收藏落入当前选中的收藏夹。
          group: activeFavoriteGroupMap[requestedMarket] || "默认",
        });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setFavoriteItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "收藏操作失败，请稍后重试。") }));
    } finally {
      setFavoritePending(requestedMarket, code, false);
    }
  }

  // 新建收藏夹，成功后切到该夹（成为 active，后续收藏落入此夹）。
  async function handleCreateFavoriteGroup(rawName, targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    const name = String(rawName || "").trim().slice(0, 30);
    if (!name || name === "默认") return;
    try {
      const payload = await createFavoriteGroup({ market: requestedMarket, name });
      const groups = Array.isArray(payload?.groups) && payload.groups.length ? payload.groups : ["默认"];
      setFavoriteGroupsMap((prev) => ({ ...prev, [requestedMarket]: groups }));
      setActiveFavoriteGroupMap((prev) => ({ ...prev, [requestedMarket]: name }));
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "新建收藏夹失败，请稍后重试。") }));
    }
  }

  // 删除收藏夹（连票一起删）；若删的是当前 active 夹，回落默认夹。
  async function handleDeleteFavoriteGroup(name, targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    if (!name || name === "默认") return;
    try {
      const payload = await deleteFavoriteGroup({ market: requestedMarket, name });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const groups = Array.isArray(payload?.groups) && payload.groups.length ? payload.groups : ["默认"];
      setFavoriteItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      setFavoriteGroupsMap((prev) => ({ ...prev, [requestedMarket]: groups }));
      setActiveFavoriteGroupMap((prev) => (
        prev[requestedMarket] === name ? { ...prev, [requestedMarket]: "默认" } : prev
      ));
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "删除收藏夹失败，请稍后重试。") }));
    }
  }

  // 把某只票移动到另一个收藏夹。
  async function handleMoveFavorite(item, group, targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    const code = normalizeCodeForMarket(item?.code, requestedMarket);
    if (!code || !group) return;
    setFavoritePending(requestedMarket, code, true);
    try {
      const payload = await moveFavorite({ market: requestedMarket, code, group });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setFavoriteItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "移动收藏失败，请稍后重试。") }));
    } finally {
      setFavoritePending(requestedMarket, code, false);
    }
  }

  function handleSelectFavoriteGroup(name, targetMarket = market) {
    const requestedMarket = normalizeEquityMarket(targetMarket, normalizeEquityMarket(market));
    favoriteGroupTouchedRef.current[requestedMarket] = true;
    setActiveFavoriteGroupMap((prev) => ({ ...prev, [requestedMarket]: name || "默认" }));
  }

  async function load(overrideCode) {
    if (isStandaloneMarket) return;
    const runId = ++loadRunRef.current;
    const rawTargetCode = typeof overrideCode === "string" ? overrideCode : currentCode;
    let targetCode = normalizeCodeForMarket(rawTargetCode, market);
    setLoading(true);
    setError("");
    setFinancialError("");
    setFinancialInfo(null);
    setFundFlowError("");
    setFundFlowInfo(null);
    setProfileError("");
    setProfileInfo(null);
    try {
      const result = market === "ashare"
        ? await (async () => {
          let normalized = onlyDigits(rawTargetCode);
          if (!isSixDigitCode(normalized)) {
            const matches = await fetchAshareSuggestions(rawTargetCode);
            normalized = onlyDigits(matches[0]?.code);
            if (isSixDigitCode(normalized)) {
              setMarketCodes((prev) => ({ ...prev, ashare: normalized }));
              setAshareSuggestions([]);
              setAshareSuggestOpen(false);
              setAshareSuggestIndex(0);
              targetCode = normalized;
            }
          }
          if (!isSixDigitCode(normalized)) {
            throw new Error("请输入 6 位 A 股代码，或输入股票简称 / 拼音首字母后从联想结果中选择。");
          }
          return fetchAshareKline({
            code: normalized,
            period,
            adjust,
            limit: Math.max(5000, Number(displayCount) + 120),
          });
        })()
        : market === "hk"
          ? await (async () => {
            let normalized = normalizeHkCode(rawTargetCode);
            if (!isValidHkCode(normalized)) {
              const matches = await fetchHkSuggestions(rawTargetCode);
              normalized = normalizeHkCode(matches[0]?.code);
              if (isValidHkCode(normalized)) {
                setMarketCodes((prev) => ({ ...prev, hk: normalized }));
                setHkSuggestions([]);
                setHkSuggestOpen(false);
                setHkSuggestIndex(0);
                targetCode = normalized;
              }
            }
            if (!isValidHkCode(normalized)) {
              throw new Error("请输入港股代码，或输入股票简称 / 拼音后从联想结果中选择。");
            }
            return fetchHkKline({
              code: normalized,
              period,
              adjust,
              limit: Math.min(1000, Math.max(600, Number(displayCount) + 120)),
            });
          })()
          : await (() => {
          const normalized = targetCode;
          if (!isValidUsSymbol(normalized)) {
            throw new Error("请输入有效的美股代码，例如 AAPL、MSFT、NVDA、BRK.B。");
          }
          return fetchUsKlineCached({
            symbol: normalized,
            period,
            adjust,
            limit: Math.max(5000, Number(displayCount) + 120),
          });
        })();
      if (runId !== loadRunRef.current) return;
      setRawRows(result.klines);
      setMeta({
        code: result.code,
        name: result.name,
        marketCap: result.marketCap || null,
        floatMarketCap: result.floatMarketCap || null,
        peRatio: Number.isFinite(result.peRatio) ? result.peRatio : null,
        turnoverRate: Number.isFinite(result.turnoverRate) ? result.turnoverRate : null,
        volumeRatio: result.volumeRatioSource === "calculated" ? null : Number.isFinite(result.volumeRatio) ? result.volumeRatio : null,
        volumeRatioSource: result.volumeRatioSource || "",
        sessionVwap: Number.isFinite(result.sessionVwap) ? result.sessionVwap : null,
        sessionVwapPremium: Number.isFinite(result.sessionVwapPremium) ? result.sessionVwapPremium : null,
        sessionVwapSource: result.sessionVwapSource || "unavailable",
        tradeSideVolumeSource: result.tradeSideVolumeSource || "",
        indicatorsQuoteTime: result.indicatorsQuoteTime || "",
        outerVol: Number.isFinite(result.outerVol) ? result.outerVol : null,
        innerVol: Number.isFinite(result.innerVol) ? result.innerVol : null,
        quoteTime: result.quoteTime || "",
        currency: result.currency || "",
        boardLot: Number.isFinite(result.boardLot) ? result.boardLot : null,
        latestPrice: Number.isFinite(result.latestPrice) ? result.latestPrice : null,
        quotePct: Number.isFinite(result.pct) ? result.pct : null,
        sourceInfo: result.sourceInfo || "",
      });

      if (market === "ashare") {
        setFinancialLoading(true);
        setFundFlowLoading(true);
        setProfileLoading(true);
        setSuspensionRisk({ loading: true });
        try {
          const target = result.code || currentCode;
          const [financeResult, fundFlowResult, profileResult, suspensionResult] = await Promise.allSettled([
            apiFetch(`/api/ashare-finance?code=${encodeURIComponent(target)}`, {
              method: "GET",
              cache: "no-store",
            }).then(async (res) => {
              const payload = await res.json().catch(() => null);
              if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
              return payload;
            }),
            apiFetch(`/api/ashare-fund-flow?code=${encodeURIComponent(target)}&limit=30`, {
              method: "GET",
              cache: "no-store",
            }).then(async (res) => {
              const payload = await res.json().catch(() => null);
              if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
              return payload;
            }),
            apiFetch(`/api/ashare-profile?code=${encodeURIComponent(target)}`, {
              method: "GET",
              cache: "no-store",
            }).then(async (res) => {
              const payload = await res.json().catch(() => null);
              if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
              return payload;
            }),
            apiFetch(`/api/suspension-alert?code=${encodeURIComponent(target)}&name=${encodeURIComponent(result.name || "")}`, {
              method: "GET",
              cache: "no-store",
            }).then(async (res) => {
              const payload = await res.json().catch(() => null);
              if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
              return payload;
            }),
          ]);

          if (runId !== loadRunRef.current) return;

          if (financeResult.status === "fulfilled") {
            setFinancialInfo(financeResult.value);
          } else {
            setFinancialError(financeResult.reason instanceof Error ? financeResult.reason.message : "财报数据加载失败");
          }

          if (fundFlowResult.status === "fulfilled") {
            setFundFlowInfo(fundFlowResult.value);
          } else {
            setFundFlowError(fundFlowResult.reason instanceof Error ? fundFlowResult.reason.message : "资金动向加载失败");
          }

          if (profileResult.status === "fulfilled") {
            setProfileInfo(profileResult.value);
          } else {
            setProfileError(profileResult.reason instanceof Error ? profileResult.reason.message : "公司概况数据加载失败");
          }

          if (suspensionResult.status === "fulfilled" && suspensionResult.value?.level) {
            setSuspensionRisk(suspensionResult.value);
          } else {
            setSuspensionRisk({
              error:
                suspensionResult.status === "rejected" && suspensionResult.reason instanceof Error
                  ? suspensionResult.reason.message
                  : "停牌风险接口未返回有效数据（后端是否已重启并注册 /api/suspension-alert？）",
            });
          }
        } finally {
          if (runId === loadRunRef.current) {
            setFinancialLoading(false);
            setFundFlowLoading(false);
            setProfileLoading(false);
          }
        }
      } else if (market === "us") {
        setFinancialLoading(false);
        setFundFlowLoading(false);
        setSuspensionRisk(null);
        setProfileLoading(true);
        try {
          const target = result.code || currentCode;
          const res = await apiFetch(`/api/us-profile?symbol=${encodeURIComponent(target)}`, {
            method: "GET",
            cache: "no-store",
          });
          const payload = await res.json().catch(() => null);
          if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
          if (runId !== loadRunRef.current) return;
          setProfileInfo(payload);
        } catch (profileErr) {
          if (runId === loadRunRef.current) {
            setProfileError(profileErr instanceof Error ? profileErr.message : "美股公司资料加载失败");
          }
        } finally {
          if (runId === loadRunRef.current) setProfileLoading(false);
        }
      } else {
        setFinancialLoading(false);
        setFundFlowLoading(false);
        setProfileLoading(false);
        setSuspensionRisk(null);
      }
    } catch (e) {
      if (runId !== loadRunRef.current) return;
      setError(getErrorMessage(e, "行情加载失败，请稍后重试。"));
      setRawRows([]);
      setMeta({ code: targetCode, name: "" });
      setSuspensionRisk(null);
      setFinancialLoading(false);
      setFundFlowLoading(false);
      setProfileLoading(false);
    } finally {
      if (runId === loadRunRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    // 当前市场还没有选中标的时（首屏 / 首次进入该市场），交给 loadDefaultWatchlist 选第一只；
    // 这里只负责在已有选中代码时重新拉取。
    if (isStandaloneMarket || !currentCode) return undefined;
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    if (isStandaloneMarket) return undefined;
    const timer = window.setTimeout(() => {
      loadFavorites(market);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    if (isStandaloneMarket || watchlistItems.length > 0) return undefined;
    const timer = window.setTimeout(() => {
      if (effectiveWatchlistStyle === "rows") {
        loadRecommendations(market);
      } else {
        loadDefaultWatchlist(market);
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, watchlistItems.length, effectiveWatchlistStyle]);

  useEffect(() => {
    if (market !== "us" || !usPreloadEnabled) {
      Promise.resolve().then(() => {
        setUsPreloadStatus((prev) => ({ ...prev, running: false, current: "" }));
      });
      return undefined;
    }

    if (!usPreloadCodes.length) {
      Promise.resolve().then(() => {
        setUsPreloadStatus({ running: false, total: 0, done: 0, current: "" });
      });
      return undefined;
    }

    const limit = Math.max(5000, Number(displayCount) + 120);
    const runId = usPreloadRunRef.current + 1;
    usPreloadRunRef.current = runId;
    let cancelled = false;

    (async () => {
      await Promise.resolve();
      if (cancelled || usPreloadRunRef.current !== runId) return;
      setUsPreloadStatus({ running: true, total: usPreloadCodes.length, done: 0, current: "" });

      let done = 0;
      for (const code of usPreloadCodes) {
        if (cancelled || usPreloadRunRef.current !== runId) return;
        const cacheKey = `${normalizeUsSymbol(code)}|${period}|${adjust}|${limit}`;
        const cached = usKlineCacheRef.current.get(cacheKey);
        if (isUsKlineCacheFresh(cached)) {
          done += 1;
          setUsPreloadStatus({ running: true, total: usPreloadCodes.length, done, current: code });
          continue;
        }

        setUsPreloadStatus({ running: true, total: usPreloadCodes.length, done, current: code });
        try {
          await fetchUsKlineCached({
            symbol: code,
            period,
            adjust,
            limit,
          });
        } catch {
          // Ignore individual preload failures and keep the queue moving.
        }
        done += 1;
        setUsPreloadStatus({ running: true, total: usPreloadCodes.length, done, current: code });
        if (done < usPreloadCodes.length) await delay(600);
      }

      if (!cancelled && usPreloadRunRef.current === runId) {
        setUsPreloadStatus({ running: false, total: usPreloadCodes.length, done: usPreloadCodes.length, current: "" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [market, usPreloadEnabled, usPreloadCodes, period, adjust, displayCount]);

  return (
    <div className="min-h-screen bg-canvas p-4 text-slate-900">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div>
            <div className="mb-3 inline-flex max-w-full flex-wrap rounded-2xl border border-slate-200 bg-slate-50 p-1 sm:rounded-full">
              {MARKET_TABS.filter((tab) => !tab.adminOnly || user?.role === "admin").map((tab) => {
                const active = market === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition ${active ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-900"}`}
                    onClick={() => {
                      if (active) return;
                      marketRef.current = tab.value;
                      loadRunRef.current += 1;
                      setMarket(tab.value);
                      setError("");
                      setFinancialError("");
                      setFinancialInfo(null);
                      if (tab.value === "us") {
                        setMarketCodes((prev) => ({ ...prev, us: prev.us || "MSFT" }));
                        setRawRows([]);
                        setMeta({ code: marketCodes.us || "MSFT", name: "" });
                      } else if (tab.value === "hk") {
                        setRawRows([]);
                        setMeta({ code: marketCodes.hk || "", name: "" });
                      } else if (tab.value === "ashare") {
                        setRawRows([]);
                        setMeta({ code: marketCodes.ashare || "", name: "" });
                      } else if (tab.value === "agent" || tab.value === "factor-research" || tab.value === "market-trend" || tab.value === "user-admin" || tab.value === "account") {
                        setRawRows([]);
                        setMeta({ code: "", name: "" });
                      }
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!isStandaloneMarket && <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
            <div className="relative col-span-2 flex items-center gap-2 rounded-xl border bg-white px-3 py-2 md:w-56">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                value={currentCode}
                onChange={(e) => {
                  const value = market === "ashare" || market === "hk" ? e.target.value.slice(0, 30) : normalizeCodeForMarket(e.target.value, market);
                  setMarketCodes((prev) => ({ ...prev, [market]: value }));
                  if (market === "ashare") setAshareSuggestOpen(Boolean(e.target.value.trim()));
                  if (market === "hk") setHkSuggestOpen(Boolean(e.target.value.trim()));
                }}
                onFocus={() => {
                  if (market === "ashare") setAshareSuggestFocused(true);
                  if (market === "ashare" && ashareSuggestions.length) setAshareSuggestOpen(true);
                  if (market === "hk") setHkSuggestFocused(true);
                  if (market === "hk" && hkSuggestions.length) setHkSuggestOpen(true);
                }}
                onBlur={() => {
                  if (market === "ashare") {
                    window.setTimeout(() => {
                      setAshareSuggestFocused(false);
                      setAshareSuggestOpen(false);
                    }, 120);
                  }
                  if (market === "hk") {
                    window.setTimeout(() => {
                      setHkSuggestFocused(false);
                      setHkSuggestOpen(false);
                    }, 120);
                  }
                }}
                onKeyDown={(e) => {
                  if (market === "ashare" && ashareSuggestOpen && ashareSuggestions.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setAshareSuggestIndex((prev) => Math.min(prev + 1, ashareSuggestions.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setAshareSuggestIndex((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setAshareSuggestOpen(false);
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      selectAshareSuggestion(ashareSuggestions[ashareSuggestIndex] || ashareSuggestions[0]);
                      return;
                    }
                  }
                  if (market === "hk" && hkSuggestOpen && hkSuggestions.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHkSuggestIndex((prev) => Math.min(prev + 1, hkSuggestions.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHkSuggestIndex((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setHkSuggestOpen(false);
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      selectHkSuggestion(hkSuggestions[hkSuggestIndex] || hkSuggestions[0]);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !isStandaloneMarket) {
                    load(e.currentTarget.value);
                  }
                }}
                placeholder={market === "ashare" ? "代码 / 简称 / 拼音首字母" : market === "hk" ? "代码 / 简称 / 拼音" : market === "us" ? "如 AAPL" : market === "agent" ? "Agent 功能待接入" : "因子研究页暂不支持代码查询"}
                disabled={isStandaloneMarket}
                className="w-full bg-transparent outline-none disabled:cursor-not-allowed disabled:text-slate-400"
              />
              {market === "ashare" && (ashareSuggestOpen || ashareSuggestLoading) && (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                  {ashareSuggestLoading && !ashareSuggestions.length ? (
                    <div className="px-3 py-2 text-sm text-slate-500">搜索中...</div>
                  ) : (
                    <>
                    {ashareSuggestions.map((item, index) => {
                      const active = index === ashareSuggestIndex;
                      return (
                        <button
                          key={`${item.code}-${item.quoteId || index}`}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setAshareSuggestIndex(index)}
                          onClick={() => selectAshareSuggestion(item)}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition ${active ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{item.name}</span>
                            <span className={`block text-xs ${active ? "text-slate-200" : "text-slate-400"}`}>{item.market || "A股"} · {item.pinyin || "-"}</span>
                          </span>
                          <span className="shrink-0 font-mono text-sm">{item.code}</span>
                        </button>
                      );
                    })}
                    {ashareSuggestLoading && (
                      <div className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400">搜索中...</div>
                    )}
                    </>
                  )}
                </div>
              )}
              {market === "hk" && (hkSuggestOpen || hkSuggestLoading) && (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                  {hkSuggestLoading && !hkSuggestions.length ? (
                    <div className="px-3 py-2 text-sm text-slate-500">搜索中...</div>
                  ) : (
                    <>
                    {hkSuggestions.map((item, index) => {
                      const active = index === hkSuggestIndex;
                      return (
                        <button
                          key={`${item.code}-${index}`}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setHkSuggestIndex(index)}
                          onClick={() => selectHkSuggestion(item)}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition ${active ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{item.name}</span>
                            <span className={`block text-xs ${active ? "text-slate-200" : "text-slate-400"}`}>港股 · {item.pinyin || "-"}</span>
                          </span>
                          <span className="shrink-0 font-mono text-sm">{item.code}</span>
                        </button>
                      );
                    })}
                    {hkSuggestLoading && <div className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400">搜索中...</div>}
                    </>
                  )}
                </div>
              )}
            </div>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} disabled={isStandaloneMarket} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              {PERIOD_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <select value={displayCount} onChange={(e) => setDisplayCount(Number(e.target.value))} disabled={isStandaloneMarket} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400" title="也可在 K 线图内滚动鼠标滚轮调整">
              {DISPLAY_COUNT_OPTIONS.map((count) => <option key={count} value={count}>近{count}根</option>)}
            </select>
            <select value={tdMode} onChange={(e) => setTdMode(e.target.value)} disabled={isStandaloneMarket} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              <option value="current">只显示当前九转</option>
              <option value="full">显示全部1~9转</option>
              <option value="ths">同花顺显示逻辑</option>
              <option value="simple">简化连续计数</option>
            </select>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={showGaps} disabled={isStandaloneMarket} onChange={(e) => setShowGaps(e.target.checked)} />
              断层
            </label>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={unfilledOnly} disabled={isStandaloneMarket} onChange={(e) => setUnfilledOnly(e.target.checked)} />
              未回补
            </label>
            <Button onClick={() => load()} disabled={loading || isStandaloneMarket} className="rounded-xl">
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "加载中" : "查询"}
            </Button>
          </div>}
          {onLogout && (
            <div className="relative ml-auto shrink-0">
              <button
                type="button"
                onClick={() => setShowProfileMenu((v) => !v)}
                onBlur={() => setTimeout(() => setShowProfileMenu(false), 150)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
              >
                <UserRound className="h-4 w-4" />
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 z-20 w-40 rounded-xl border border-slate-100 bg-white py-1 shadow-md">
                  {onThemeChange && (
                    <>
                      <div className="px-4 pb-1.5 pt-1.5 text-[11px] font-medium text-slate-400">外观</div>
                      <div className="px-4 pb-2">
                        <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
                          {THEME_OPTIONS.map((option) => {
                            const ThemeIcon = THEME_ICONS[option.value];
                            const active = themePreference === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                title={option.label}
                                aria-label={option.label}
                                aria-pressed={active}
                                // preventDefault 保住触发按钮的焦点，否则它的 onBlur 会立刻收起菜单
                                onMouseDown={(e) => { e.preventDefault(); onThemeChange(option.value); }}
                                className={`flex h-6 w-6 items-center justify-center rounded-full transition ${active ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:bg-white hover:text-slate-900"}`}
                              >
                                <ThemeIcon className="h-3.5 w-3.5" />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="my-1 border-t border-slate-100" />
                    </>
                  )}
                  <button
                    type="button"
                    onMouseDown={onLogout}
                    className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    退出登录
                  </button>
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        )}

        {!isStandaloneMarket ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 [&>*]:min-w-0 xl:grid-cols-[260px_minmax(0,1fr)_260px] 2xl:grid-cols-[320px_minmax(0,1fr)_320px]">
            <Card className="rounded-2xl">
              <CardContent className="p-4">
                <div className="text-sm text-slate-500">当前标的</div>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <div className="min-w-0 break-words text-2xl font-semibold">{meta.name || "-"}</div>
                  {activeMetaCode ? (
                    <button
                      type="button"
                      onClick={() => toggleFavorite({ code: activeMetaCode, name: meta.name || activeMetaCode }, market)}
                      disabled={activeMetaFavoritePending}
                      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition ${
                        activeMetaFavorited
                          ? "border-amber-200 bg-amber-50 text-amber-500 hover:bg-amber-100"
                          : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                      title={activeMetaFavorited ? "取消收藏" : "加入收藏"}
                      aria-label={activeMetaFavorited ? `取消收藏 ${activeMetaCode}` : `加入收藏 ${activeMetaCode}`}
                    >
                      <Star className="h-4 w-4" fill={activeMetaFavorited ? "currentColor" : "none"} />
                    </button>
                  ) : null}
                </div>
                <div className="text-sm text-slate-500">{meta.code || currentCode}</div>
                {latest && (
                  <div className="quote-metrics mt-4 grid gap-x-4 gap-y-2 text-sm">
                    <div className="quote-metric quote-metric-wide flex justify-between">
                      <span>日期</span>
                      <span>{latest.date}{latest.isIntradayEstimate ? " 盘中" : ""}</span>
                    </div>
                    {market === "hk" && meta.quoteTime ? (
                      <div className="quote-metric quote-metric-wide quote-snapshot flex justify-between gap-3">
                        <span>腾讯快照</span>
                        <span className="text-right">{meta.quoteTime} · {meta.currency || "HKD"}</span>
                      </div>
                    ) : null}
                    <div className="quote-metric flex justify-between">
                      <span>{market === "hk" ? "最新" : "收盘"}</span>
                      <span className={`font-semibold ${latestColor}`}>{displayedPrice.toFixed(2)}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span>涨跌幅</span>
                      <span className={displayedPct >= 0 ? "text-red-600" : "text-green-700"}>
                        {Number.isFinite(displayedPct) ? displayedPct.toFixed(2) : "-"}%
                      </span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span>成交量</span>
                      <span>{formatNumber(latest.volume)}</span>
                    </div>
                    {market === "hk" && Number.isFinite(meta.boardLot) ? (
                      <div className="quote-metric flex justify-between">
                        <span>每手股数</span>
                        <span>{meta.boardLot}</span>
                      </div>
                    ) : null}
                    <div className="quote-metric flex justify-between">
                      <span className="inline-flex items-center">
                        换手率
                        <InfoTip text={"换手率 = 某段时期成交量 ÷ 流通总股数 × 100%，反映流通性与活跃度。\n\n<3%  多数股票常态，3% 是活跃分界线\n3%～7%  相对活跃，较适合波段操作\n7%～10%  强势股，高度活跃\n10%～15%  顶部上升浪，大股本超10%多已临近见顶\n>15%  中小盘疯狂冲顶、分歧加大、上行空间有限，连续高换手后见大阴线宜减仓\n>20%  极少见，多为疯狂炒作的题材股\n\n高于10% 即属异常活跃，可结合顶部反转K线（吞没/乌云盖顶等）判断见顶。"} />
                        <TurnoverSparkline rows={rawRows} currentRate={meta.turnoverRate} />
                      </span>
                      <span>{Number.isFinite(meta.turnoverRate) ? `${meta.turnoverRate.toFixed(2)}%` : "-"}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span>总市值{market === "hk" && meta.currency ? `（${meta.currency}）` : ""}</span>
                      <span>{formatNumber(meta.marketCap)}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span>流通市值{market === "hk" && meta.currency ? `（${meta.currency}）` : ""}</span>
                      <span>{formatNumber(meta.floatMarketCap)}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span>市盈</span>
                      <span>{Number.isFinite(meta.peRatio) ? meta.peRatio.toFixed(2) : "-"}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span className="inline-flex items-center">
                        量比
                        <InfoTip text={(market === "ashare" ? "" : "港美股量比直接取腾讯行情字段，不使用本地估算。港股与美股字段位置不同，已通过股票样本交叉核对；接口没有公开字段文档。数据时间见下方腾讯快照时间，缺失时不填零。\n\n") + "量比 = 当日每分钟均量 ÷ 过去5日每分钟均量，衡量成交活跃度。\n\n<0.8  缩量\n0.8～1.5  正常\n1.5～2.5  温和放量，配合股价缓升较健康\n2.5～5  明显放量，突破支撑/阻力时有效性更高\n5～10  剧烈放量，低位突破后空间大、高位则警惕见顶\n>10  极端放量，涨势中多预示见顶、可考虑反向\n\n涨停时量比偏小（<1）次日续涨概率高。"} />
                      </span>
                      <span className="inline-flex items-baseline gap-1">
                        {Number.isFinite(meta.volumeRatio) ? meta.volumeRatio.toFixed(2) : market === "ashare" ? "-" : "源未提供"}
                      </span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span className="inline-flex items-center">
                        内盘
                        <span className="ml-1 font-semibold text-green-700">S</span>
                        <InfoTip text={market !== "ashare" ? "当前腾讯港美股接口的内外盘字段没有有效数据，暂不展示。不会用占位零或本地估算补齐；港美股成交量以股计。" : "内盘 = 以买入价（买一及以下）成交的量，多为主动卖出（S）；外盘 = 以卖出价（卖一及以上）成交的量，多为主动买入（B）。\n\n外盘 > 内盘  买盘较主动，偏多\n内盘 > 外盘  卖盘较主动，偏空\n\n单位：手（1 手 = 100 股），为当日累计，需结合价格、量比综合判断，单看强弱意义有限。"} />
                      </span>
                      <span className="text-green-700">{Number.isFinite(meta.innerVol) ? formatNumber(meta.innerVol) : market === "ashare" ? "-" : <span className="text-xs text-slate-400">源未提供</span>}</span>
                    </div>
                    <div className="quote-metric flex justify-between">
                      <span className="inline-flex items-center">
                        外盘
                        <span className="ml-1 font-semibold text-red-600">B</span>
                      </span>
                      <span className="text-red-600">{Number.isFinite(meta.outerVol) ? formatNumber(meta.outerVol) : market === "ashare" ? "-" : <span className="text-xs text-slate-400">源未提供</span>}</span>
                    </div>
                    {market !== "ashare" && (meta.volumeRatioSource === "tencent" || meta.sessionVwapSource === "tencent") ? (
                      <div className="quote-metric-wide text-xs text-slate-400">
                        腾讯快照 · {meta.indicatorsQuoteTime || meta.quoteTime}
                        {market === "hk" ? " 香港时间" : " 美东时间"}
                      </div>
                    ) : null}
                    <div className="quote-metric quote-metric-wide flex justify-between">
                      <span className="inline-flex items-center">
                        RSI14
                        <InfoTip text={"RSI = 100 − 100 ÷ (1 + 近14日平均涨幅 ÷ 近14日平均跌幅)，衡量涨跌动能强弱，取值 0～100。\n\n>75  高位过热，追高风险大，常见滞涨/回调\n60～75  强势区，多头动能占优\n40～60  中性震荡，方向不明\n30～40  弱势区，空头动能占优\n<30  低位超跌，易出现反弹，但下跌趋势中可长期钝化\n\n单看数值意义有限：强趋势中 RSI 会长时间贴在高位或低位（钝化），更实用的是「价格创新高而 RSI 未创新高」的顶背离，以及反向的底背离。"} />
                      </span>
                      <span className="inline-flex items-baseline gap-1">
                        <span
                          className={
                            rsiInfo.state === "overbought"
                              ? "text-red-600"
                              : rsiInfo.state === "oversold"
                                ? "text-green-700"
                                : ""
                          }
                        >
                          {rsiInfo.ready ? latestValid(rsiInfo.value, 1) : "-"}
                        </span>
                        {rsiInfo.ready ? <span className="text-xs text-slate-400">{rsiInfo.label}</span> : null}
                      </span>
                    </div>
                    <div className="quote-metric quote-metric-wide flex justify-between">
                      <span className="inline-flex items-center">
                        {market === "ashare" ? "VWAP20" : "VWAP"}
                        {market !== "ashare" ? <span className="ml-1 text-xs text-slate-400">当日</span> : null}
                        <InfoTip text={market !== "ashare" ? "当日 VWAP = 腾讯快照当日累计成交额 ÷ 累计成交股数，使用原始价格口径，不使用典型价近似。数据日期和时间见腾讯快照；非交易日显示最近交易日。切换日/周/月K不改变这个当日指标。\n\n右侧百分比是同一快照最新价相对当日 VWAP 的偏离。交易范围遵循腾讯行情源，不能保证与其他平台是否纳入竞价、盘前盘后等成交的口径一致。成交额或成交量缺失时不显示数值。" : "VWAP = Σ(单日均价 × 当日成交量) ÷ Σ成交量，即当前周期最近 20 根 K 线的成交量加权平均价（日K对应20个交易日，周K对应20周，月K对应20个月）；不足20根时用已有样本。这里是滚动指标，和美股常见的当日 VWAP 口径不同。\n\n股价 > VWAP  多数持仓浮盈，回踩 VWAP 常成支撑\n股价 < VWAP  多数持仓套牢，反弹到 VWAP 常遇解套抛压\n偏离 ±10% 以上  乖离偏大，有向均价回归的需求\n\n右侧百分比为收盘价相对 VWAP 的溢价（+）或折价（−）。日线数据没有分笔明细，单日均价优先用 成交额 ÷ 成交量；数据源未提供成交额时用 (最高+最低+收盘)/3 近似，近似结果与真实成交均价可能有差异，不能当作精确成本。"} />
                      </span>
                      <span className="inline-flex items-baseline gap-1">
                        <span>{vwapInfo.ready ? latestValid(vwapInfo.value) : market === "ashare" ? "-" : "数据不足"}</span>
                        {vwapInfo.ready && Number.isFinite(vwapInfo.premium) ? (
                          <span className={`text-xs ${vwapInfo.premium >= 0 ? "text-red-600" : "text-green-700"}`}>
                            {vwapInfo.premium >= 0 ? "+" : ""}
                            {vwapInfo.premium.toFixed(2)}%
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                )}
                {market === "ashare" && (
                  <>
                    <AshareProfileSection
                      title="公司基本介绍"
                      loading={profileLoading}
                      error={profileError}
                      info="数据来自东方财富 F10 公司概况与经营分析页。这里优先展示公司全称、行业、市场、经营范围和经营评述摘要。"
                    >
                      <div className="space-y-2 text-xs text-slate-600">
                        {profileInfo?.company?.orgName ? (
                          <div className="font-medium text-slate-800">{profileInfo.company.orgName}</div>
                        ) : null}
                        {(profileInfo?.company?.industry || profileInfo?.company?.market) ? (
                          <div>{[profileInfo?.company?.industry, profileInfo?.company?.market].filter(Boolean).join(" / ")}</div>
                        ) : null}
                        {profileInfo?.company?.businessScope ? (
                          <ExpandableText value={profileInfo.company.businessScope} maxLength={90} />
                        ) : profileInfo?.company?.businessReview ? (
                          <ExpandableText value={profileInfo.company.businessReview} maxLength={90} />
                        ) : (
                          <div className="text-slate-500">暂无公司介绍。</div>
                        )}
                      </div>
                    </AshareProfileSection>
                    <AshareProfileSection
                      title="目前炒作主题概念"
                      loading={profileLoading}
                      error={profileError}
                      info="综合展示东方财富 F10 和同花顺 F10 的概念题材。东财优先展示精确概念，同花顺补充概念题材解析，便于交叉核对当前市场交易标签。"
                    >
                      <div className="space-y-2">
                        {(Array.isArray(profileInfo?.themes?.sources) && profileInfo.themes.sources.length > 0
                          ? profileInfo.themes.sources
                          : [
                              {
                                key: "eastmoney",
                                name: "东方财富 F10",
                                status: "ok",
                                concepts: profileInfo?.themes?.preciseConcepts || profileInfo?.themes?.boards || [],
                                supplemental: profileInfo?.themes?.supplementalBoards || [],
                                highlights: profileInfo?.themes?.highlights || [],
                              },
                            ]
                        ).map((source) => (
                          <ThemeSourceBlock key={source.key || source.name} source={source} />
                        ))}
                        {(!profileInfo?.themes ||
                          ((!Array.isArray(profileInfo.themes.sources) || profileInfo.themes.sources.length === 0) &&
                            (!Array.isArray(profileInfo.themes.boards) || profileInfo.themes.boards.length === 0) &&
                            (!Array.isArray(profileInfo.themes.highlights) || profileInfo.themes.highlights.length === 0))) ? (
                          <div className="text-xs text-slate-500">暂无题材概念。</div>
                        ) : null}
                      </div>
                    </AshareProfileSection>
                  </>
                )}
                {market === "us" && (
                  <>
                    <AshareProfileSection
                      title="公司基本介绍"
                      loading={profileLoading}
                      error={profileError}
                      info="数据来自东方财富美股 F10 公司资料页（中文）。优先展示公司全称、行业、上市市场与公司简介。"
                    >
                      <div className="space-y-2 text-xs text-slate-600">
                        {profileInfo?.company?.orgName || profileInfo?.company?.orgEnName ? (
                          <div className="font-medium text-slate-800">
                            {[profileInfo?.company?.orgName, profileInfo?.company?.orgEnName].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                        {(profileInfo?.company?.industry || profileInfo?.company?.market) ? (
                          <div>{[profileInfo?.company?.industry, profileInfo?.company?.market].filter(Boolean).join(" / ")}</div>
                        ) : null}
                        {profileInfo?.company?.businessScope ? (
                          <ExpandableText value={profileInfo.company.businessScope} maxLength={90} />
                        ) : (
                          <div className="text-slate-500">暂无公司介绍。</div>
                        )}
                      </div>
                    </AshareProfileSection>
                    <AshareProfileSection
                      title="主营构成与机构评级"
                      loading={profileLoading}
                      error={profileError}
                      info="美股没有 A 股那套概念板块标签，这里改用东财美股 F10 的行业、主营产品营收占比与机构评级共识，作为题材/看点参考。"
                    >
                      <div className="space-y-2">
                        {(Array.isArray(profileInfo?.themes?.sources) ? profileInfo.themes.sources : []).map((source) => (
                          <ThemeSourceBlock key={source.key || source.name} source={source} />
                        ))}
                        {(!Array.isArray(profileInfo?.themes?.sources) || profileInfo.themes.sources.length === 0) ? (
                          <div className="text-xs text-slate-500">暂无主营构成与评级数据。</div>
                        ) : null}
                      </div>
                    </AshareProfileSection>
                  </>
                )}
                <TrendPredictionPanel prediction={prediction} />
                <div className="mt-4">
                  <TradeConclusionPanel rawRows={rawRows} />
                </div>
              </CardContent>
            </Card>
            <div className="xl:min-w-0">
              <div className="space-y-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-1">
                <Card className="self-start rounded-2xl">
                  <CardContent className="p-4">
                  <div className="chart-panel-header mb-3 flex min-w-0 flex-col gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-base font-semibold lg:text-lg">{meta.code ? `${meta.code} ${meta.name}` : market === "us" ? "美股 K线图" : market === "hk" ? "港股 K线图" : "K线图"}</div>
                        {activeMetaCode ? (
                          <button
                            type="button"
                            onClick={() => toggleFavorite({ code: activeMetaCode, name: meta.name || activeMetaCode }, market)}
                            disabled={activeMetaFavoritePending}
                            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition ${
                              activeMetaFavorited
                                ? "border-amber-200 bg-amber-50 text-amber-500 hover:bg-amber-100"
                                : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600"
                            } disabled:cursor-not-allowed disabled:opacity-60`}
                            title={activeMetaFavorited ? "取消收藏" : "加入收藏"}
                            aria-label={activeMetaFavorited ? `取消收藏 ${activeMetaCode}` : `加入收藏 ${activeMetaCode}`}
                          >
                            <Star className="h-4 w-4" fill={activeMetaFavorited ? "currentColor" : "none"} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="chart-panel-tools flex min-w-0 flex-wrap items-center gap-2">
                      <ChartToolbar
                        drawingTool={drawingTool}
                        onSelectDrawingTool={handleSelectDrawingTool}
                        onUndoDrawing={undoLastDrawing}
                        onClearDrawings={clearDrawings}
                        hasDrawings={drawnLines.length > 0}
                        fullscreen={chartFullscreen}
                        onToggleFullscreen={() => setChartFullscreen((value) => !value)}
                        suspensionRisk={suspensionRisk}
                        displayCount={displayCount}
                        onDisplayCountChange={setDisplayCount}
                        maxDisplayCount={fullRowsWithTD.length}
                        chanOptions={chanOptions}
                        onChanOptionsChange={handleChanOptionsChange}
                        showPatterns={showPatterns}
                        onTogglePatterns={() => setShowPatterns((v) => !v)}
                      />
                    </div>
                  </div>
                  {rows.length > 0 ? (
                    <Chart
                      key={`inline-chart-${drawingTool}`}
                      rows={rows}
                      fullRows={fullRowsWithTD}
                      visibleGaps={visibleGaps}
                      showGaps={showGaps}
                      displayCount={displayCount}
                      onDisplayCountChange={setDisplayCount}
                      drawingTool={drawingTool}
                      drawnLines={drawnLines}
                      onDrawnLinesChange={setDrawnLines}
                      showPatterns={showPatterns}
                  chanOptions={chanOptions}
                  chanData={chanData}
                    />
                  ) : (
                    <div className="rounded-2xl bg-slate-100 p-12 text-center text-slate-500">暂无数据</div>
                  )}
                  </CardContent>
                </Card>
                {(market === "ashare" || market === "hk" || chanOptions.enabled) && <StockAnalysisPanel
                  data={chanData} enabled={chanOptions.enabled} tab={analysisTab} onTabChange={setAnalysisTab}
                  code={meta.code || currentCode} name={meta.name} period={period}
                  market={market}
                  showFinancial={market === "ashare"}
                  financialReportContent={<FinancialReportPanel
                    financialInfo={financialInfo}
                    loading={financialLoading}
                    error={financialError}
                    market={market}
                    embedded
                  />}
                  showNews={market === "ashare" || market === "hk"}
                  showFundFlow={market === "ashare"}
                  fundFlowContent={<FundFlowPanel
                    fundFlowInfo={fundFlowInfo}
                    loading={fundFlowLoading}
                    error={fundFlowError}
                    market={market}
                    embedded
                  />}
                />}
              </div>
            </div>
            <WatchlistPanel
              market={market}
              inputValue={watchlistInput}
              items={watchlistItems}
              activeCode={meta.code || currentCode}
              loading={watchlistLoadingState}
              error={watchlistErrorState}
              style={effectiveWatchlistStyle}
              recommendationFactor={recommendationFactor}
              recommendationDate={recommendationDate}
              favoriteCodeSet={favoriteCodeSet}
              favoritePendingCodeSet={favoritePendingCodeSet}
              onInputChange={(value) => setWatchlistInputMap((prev) => ({ ...prev, [market]: value }))}
              onRefresh={() => (effectiveWatchlistStyle === "rows" ? loadRecommendations() : loadWatchlist())}
              onStyleChange={setWatchlistStyle}
              onRecommendationFactorChange={(value) => {
                setRecommendationFactorMap((prev) => ({ ...prev, [market]: value }));
                setRecommendationItemsMap((prev) => ({ ...prev, [market]: [] }));
              }}
              onRecommendationDateChange={(value) => {
                setRecommendationDateMap((prev) => ({ ...prev, [market]: value }));
                setRecommendationItemsMap((prev) => ({ ...prev, [market]: [] }));
              }}
              preloadEnabled={usPreloadEnabled}
              onTogglePreload={() => setUsPreloadEnabled((value) => !value)}
              preloadStatus={usPreloadStatus}
              onClearPreloadCache={clearUsPreloadCache}
              onPick={(code) => {
                setMarketCodes((prev) => ({ ...prev, [market]: code }));
                setError("");
                window.setTimeout(() => {
                  if (!isStandaloneMarket) load(code);
                }, 0);
              }}
              onToggleFavorite={(item) => {
                toggleFavorite(item, market);
              }}
            />
          </div>
        ) : market === "agent" ? (
          <AgentChatPanel marketCodes={marketCodes} />
        ) : market === "market-trend" ? (
          <MarketTrendPageLayout
            onOpenStock={(code) => {
              // 热力图点个股：切到 A 股页并带上代码，[market] 的 effect 会自动拉 K 线。
              const normalized = onlyDigits(code);
              if (!isSixDigitCode(normalized)) return;
              setMarketCodes((prev) => ({ ...prev, ashare: normalized }));
              setError("");
              setMarket("ashare");
            }}
          />
        ) : market === "account" ? (
          <AccountPanel user={user} onLogout={onLogout} />
        ) : user?.role !== "admin" ? (
          <div role="alert" className="rounded-2xl bg-white p-6 text-sm text-slate-600">没有访问权限，仅管理员可访问此页面。</div>
        ) : market === "user-admin" ? (
          <UserAdminPanel user={user} />
        ) : (
          <FactorResearchErrorBoundary>
            <FactorResearchPageLayout />
          </FactorResearchErrorBoundary>
        )}
        {!isStandaloneMarket && (
          <FavoritesToolbar
            market={market}
            items={favoriteItems}
            open={favoritesPanelOpen}
            loading={favoriteLoading}
            error={favoriteError}
            pendingCodeSet={favoritePendingCodeSet}
            groups={favoriteGroups}
            activeGroup={activeFavoriteGroup}
            onToggleOpen={() => setFavoritesPanelOpen((value) => !value)}
            onRefresh={() => loadFavorites(market)}
            onPick={(code) => {
              setMarketCodes((prev) => ({ ...prev, [market]: code }));
              setError("");
              window.setTimeout(() => {
                if (market !== "factor-research") load(code);
              }, 0);
            }}
            onRemove={(item) => {
              toggleFavorite(item, market);
            }}
            onSelectGroup={(name) => handleSelectFavoriteGroup(name, market)}
            onCreateGroup={(name) => handleCreateFavoriteGroup(name, market)}
            onDeleteGroup={(name) => handleDeleteFavoriteGroup(name, market)}
            onMoveItem={(item, group) => handleMoveFavorite(item, group, market)}
          />
        )}
        {chartFullscreen && !isStandaloneMarket && rows.length > 0 && (
          <div className="fixed inset-0 z-50 bg-slate-950/40 p-3 backdrop-blur-sm md:p-5">
            <div className="flex h-full flex-col rounded-2xl bg-white shadow-2xl">
              <div className="chart-panel-header flex min-w-0 flex-col gap-3 border-b px-4 py-4 md:px-5">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-xl font-semibold">{meta.code ? `${meta.code} ${meta.name}` : market === "us" ? "美股 K线图" : market === "hk" ? "港股 K线图" : "K线图"}</div>
                    {activeMetaCode ? (
                      <button
                        type="button"
                        onClick={() => toggleFavorite({ code: activeMetaCode, name: meta.name || activeMetaCode }, market)}
                        disabled={activeMetaFavoritePending}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-full border transition ${
                          activeMetaFavorited
                            ? "border-amber-200 bg-amber-50 text-amber-500 hover:bg-amber-100"
                            : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600"
                        } disabled:cursor-not-allowed disabled:opacity-60`}
                        title={activeMetaFavorited ? "取消收藏" : "加入收藏"}
                        aria-label={activeMetaFavorited ? `取消收藏 ${activeMetaCode}` : `加入收藏 ${activeMetaCode}`}
                      >
                        <Star className="h-4 w-4" fill={activeMetaFavorited ? "currentColor" : "none"} />
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    全屏模式下可查看更多图表细节；按 `Esc` 也可以退出全屏。
                  </div>
                </div>
                <div className="chart-panel-tools flex min-w-0 flex-wrap items-center gap-2">
                  <ChartToolbar
                    drawingTool={drawingTool}
                    onSelectDrawingTool={handleSelectDrawingTool}
                    onUndoDrawing={undoLastDrawing}
                    onClearDrawings={clearDrawings}
                    hasDrawings={drawnLines.length > 0}
                    fullscreen={chartFullscreen}
                    onToggleFullscreen={() => setChartFullscreen(false)}
                    suspensionRisk={suspensionRisk}
                    displayCount={displayCount}
                    onDisplayCountChange={setDisplayCount}
                    maxDisplayCount={fullRowsWithTD.length}
                    showPatterns={showPatterns}
                    onTogglePatterns={() => setShowPatterns((v) => !v)}
                    chanOptions={chanOptions}
                    onChanOptionsChange={handleChanOptionsChange}
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4 md:p-5">
                <Chart
                  key={`fullscreen-chart-${drawingTool}`}
                  rows={rows}
                  fullRows={fullRowsWithTD}
                  visibleGaps={visibleGaps}
                  showGaps={showGaps}
                  expanded
                  displayCount={displayCount}
                  onDisplayCountChange={setDisplayCount}
                  drawingTool={drawingTool}
                  drawnLines={drawnLines}
                  onDrawnLinesChange={setDrawnLines}
                  showPatterns={showPatterns}
                  chanOptions={chanOptions}
                  chanData={chanData}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
