import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Info,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
  Send,
  Star,
  Trash2,
  TrendingUp,
  UserRound,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function apiFetch(url, opts = {}) {
  const token = localStorage.getItem("token");
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

const PERIOD_OPTIONS = [
  { value: "101", label: "日K" },
  { value: "102", label: "周K" },
  { value: "103", label: "月K" },
];

const ADJUST_OPTIONS = [
  { value: "1", label: "前复权" },
  { value: "0", label: "不复权" },
  { value: "2", label: "后复权" },
];

const MARKET_TABS = [
  { value: "ashare", label: "A股" },
  { value: "us", label: "美股" },
  { value: "agent", label: "Agent" },
  { value: "factor-research", label: "因子研究" },
];

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

const RECOMMENDATION_TD_OPTIONS = [
  { value: "td1", label: "九转第一转" },
  { value: "td2", label: "九转第二转" },
  { value: "td3", label: "九转第三转" },
  { value: "td4", label: "九转第四转" },
];

const RECOMMENDATION_MACD_OPTIONS = [
  { value: "all", label: "ALL" },
  { value: "none", label: "无明显信号" },
  { value: "golden", label: "金叉" },
  { value: "near-golden", label: "即将金叉" },
];

const RECOMMENDATION_SAFETY_OPTIONS = [
  { value: "all", label: "ALL" },
  { value: "high", label: "高" },
  { value: "higher", label: "较高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const WAVE_SENSITIVITY_OPTIONS = [
  { value: "soft", label: "灵敏" },
  { value: "standard", label: "标准" },
  { value: "strict", label: "严格" },
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
  if (!Array.isArray(qt)) return { marketCap: null, floatMarketCap: null, peRatio: null, turnoverRate: null };

  // Tencent quote fields: 38 = turnover rate %, 39 = PE, 44 = float market cap in 100M CNY, 45 = total market cap in 100M CNY.
  const turnoverRate = Number(qt[38]);
  const peRatio = Number(qt[39]);
  const floatMarketCapYi = Number(qt[44]);
  const totalMarketCapYi = Number(qt[45]);
  return {
    marketCap: Number.isFinite(totalMarketCapYi) ? totalMarketCapYi * 100000000 : null,
    floatMarketCap: Number.isFinite(floatMarketCapYi) ? floatMarketCapYi * 100000000 : null,
    peRatio: Number.isFinite(peRatio) ? peRatio : null,
    turnoverRate: Number.isFinite(turnoverRate) ? turnoverRate : null,
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
      marketCap: null,
      floatMarketCap: null,
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

function movingAverage(rows, n) {
  return rows.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j += 1) sum += rows[j].close;
    return sum / n;
  });
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

function normalizeWatchlistCodes(input, market) {
  const parts = String(input || "")
    .split(/[,\n，\s、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set();
  const normalized = [];
  for (const part of parts) {
    const code = market === "ashare" ? onlyDigits(part) : normalizeUsSymbol(part);
    const valid = market === "ashare" ? isSixDigitCode(code) : isValidUsSymbol(code);
    if (!valid || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function normalizeCodeForMarket(value, market) {
  return market === "ashare" ? onlyDigits(value) : normalizeUsSymbol(value);
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
  return { ready: true, state, value: rsi, text: `RSI14 ${latestValid(rsi, 1)}，${label}` };
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

function calcATRPercent(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) return null;
  const trs = [];
  for (let i = rows.length - period; i < rows.length; i += 1) {
    const curr = rows[i];
    const prev = rows[i - 1];
    if (!curr || !prev) continue;
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (!trs.length) return null;
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const close = rows[rows.length - 1]?.close;
  if (!Number.isFinite(atr) || !Number.isFinite(close) || close === 0) return null;
  return atr / close;
}

function getWaveOptions(mode, rows) {
  const configs = {
    soft: { pivotSpan: 2, minMovePct: 0.04, maxPivots: 16 },
    standard: { pivotSpan: 3, minMovePct: 0.07, maxPivots: 14 },
    strict: { pivotSpan: 4, minMovePct: 0.1, maxPivots: 12 },
  };
  const base = configs[mode] || configs.standard;
  const atrPct = calcATRPercent(rows, 14);
  const adaptiveMinMovePct = Number.isFinite(atrPct)
    ? Math.max(base.minMovePct, Math.min(0.18, atrPct * 1.35))
    : base.minMovePct;
  return {
    ...base,
    minMovePct: adaptiveMinMovePct,
  };
}

function buildWavePivotCandidates(rows, pivotSpan) {
  const candidates = [];
  if (!Array.isArray(rows) || rows.length < pivotSpan * 2 + 1) return candidates;

  for (let i = pivotSpan; i < rows.length - pivotSpan; i += 1) {
    const curr = rows[i];
    if (!curr) continue;
    let isHigh = true;
    let isLow = true;
    let strongerHigh = false;
    let strongerLow = false;

    for (let offset = 1; offset <= pivotSpan; offset += 1) {
      const left = rows[i - offset];
      const right = rows[i + offset];
      if (!left || !right) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (curr.high < left.high || curr.high < right.high) isHigh = false;
      if (curr.low > left.low || curr.low > right.low) isLow = false;
      if (curr.high > left.high || curr.high > right.high) strongerHigh = true;
      if (curr.low < left.low || curr.low < right.low) strongerLow = true;
    }

    if (isHigh && strongerHigh) {
      candidates.push({ index: i, type: "high", price: curr.high, date: curr.date });
    }
    if (isLow && strongerLow) {
      candidates.push({ index: i, type: "low", price: curr.low, date: curr.date });
    }
  }

  return candidates.sort((a, b) => a.index - b.index || (a.type === "low" ? -1 : 1));
}

function compressWavePivots(candidates, minMovePct) {
  const pivots = [];
  for (const candidate of candidates) {
    const last = pivots[pivots.length - 1];
    if (!last) {
      pivots.push(candidate);
      continue;
    }

    if (candidate.type === last.type) {
      const replaceHigh = candidate.type === "high" && candidate.price >= last.price;
      const replaceLow = candidate.type === "low" && candidate.price <= last.price;
      if (replaceHigh || replaceLow) pivots[pivots.length - 1] = candidate;
      continue;
    }

    const movePct = last.price === 0 ? 0 : Math.abs(candidate.price - last.price) / Math.abs(last.price);
    if (movePct < minMovePct) continue;
    pivots.push(candidate);
  }
  return pivots;
}

function detectWavePivots(rows, mode = "standard") {
  const options = getWaveOptions(mode, rows);
  const candidates = buildWavePivotCandidates(rows, options.pivotSpan);
  const pivots = compressWavePivots(candidates, options.minMovePct);
  return {
    pivots: pivots.slice(-options.maxPivots),
    options,
  };
}

function describeWaveConfidence(score) {
  if (score >= 88) return "高";
  if (score >= 72) return "中";
  return "低";
}

function inFibNeighborhood(value, targets, tolerance = 0.06) {
  if (!Number.isFinite(value)) return false;
  return targets.some((target) => Math.abs(value - target) <= tolerance);
}

function buildImpulseWave(pivots, direction) {
  if (!Array.isArray(pivots) || pivots.length !== 6) return null;
  const expected = direction === "bull" ? ["low", "high", "low", "high", "low", "high"] : ["high", "low", "high", "low", "high", "low"];
  if (pivots.some((pivot, index) => pivot.type !== expected[index])) return null;

  const prices = pivots.map((item) => item.price);
  const len1 = Math.abs(prices[1] - prices[0]);
  const len3 = Math.abs(prices[3] - prices[2]);
  const len5 = Math.abs(prices[5] - prices[4]);
  const upward = direction === "bull";
  const retrace2 = len1 === 0 ? null : Math.abs(prices[1] - prices[2]) / len1;
  const retrace4 = len3 === 0 ? null : Math.abs(prices[3] - prices[4]) / len3;
  const ext3 = len1 === 0 ? null : len3 / len1;

  const rule2 = upward ? prices[2] > prices[0] : prices[2] < prices[0];
  const rule3 = len3 >= Math.min(len1, len5);
  const rule4 = upward ? prices[4] > prices[1] : prices[4] < prices[1];
  const extension = upward ? prices[3] > prices[1] && prices[5] > prices[3] : prices[3] < prices[1] && prices[5] < prices[3];
  const higherLow = upward ? prices[4] > prices[2] : prices[4] < prices[2];
  const fib2 = inFibNeighborhood(retrace2, [0.5, 0.618], 0.08);
  const fib3 = inFibNeighborhood(ext3, [1.618, 2.618], 0.2);
  const fib4 = inFibNeighborhood(retrace4, [0.236, 0.382], 0.08);

  const checks = [
    {
      key: "rule2",
      label: upward ? "2浪未跌破1浪起点" : "2浪未升破1浪起点",
      ok: rule2,
    },
    {
      key: "rule3",
      label: "3浪不是最短推动浪",
      ok: rule3,
    },
    {
      key: "rule4",
      label: upward ? "4浪未进入1浪价格区间" : "4浪未进入1浪价格区间",
      ok: rule4,
    },
    {
      key: "extension",
      label: upward ? "推动高点持续抬升" : "推动低点持续下移",
      ok: extension,
    },
    {
      key: "structure",
      label: upward ? "调整低点逐步抬高" : "反弹高点逐步降低",
      ok: higherLow,
    },
    {
      key: "fib2",
      label: "2浪回撤接近 50% / 61.8%",
      ok: fib2,
    },
    {
      key: "fib3",
      label: "3浪延展接近 161.8% / 261.8%",
      ok: fib3,
    },
    {
      key: "fib4",
      label: "4浪回撤接近 23.6% / 38.2%",
      ok: fib4,
    },
  ];

  const score = checks.reduce((acc, item) => acc + (item.ok ? (item.key.startsWith("fib") ? 10 : 14) : 0), 0);
  if (checks.filter((item) => item.ok).length < 4 || !rule2 || !rule3 || !rule4) return null;

  const labels = upward ? ["起", "1", "2", "3", "4", "5"] : ["起", "A", "B", "C", "D", "E"];
  return {
    kind: upward ? "bullImpulse" : "bearImpulse",
    family: "impulse",
    direction,
    title: upward ? "牛市推动浪" : "熊市推动浪",
    score,
    confidence: describeWaveConfidence(score),
    pivots,
    labels,
    invalidationPrice: upward ? prices[4] : prices[4],
    checks,
    metrics: { retrace2, retrace4, ext3 },
    summary: upward
      ? `疑似牛市 1-5 推动浪，2浪回撤 ${percentText(retrace2 || 0)}，3浪约为1浪的 ${latestValid(ext3, 2)} 倍。`
      : `疑似熊市 A-E 推动浪，B浪回撤 ${percentText(retrace2 || 0)}，C浪约为A浪的 ${latestValid(ext3, 2)} 倍。`,
  };
}

function buildCorrectiveWave(pivots, direction, style = direction === "down" ? "bullCorrection" : "bearRebound") {
  if (!Array.isArray(pivots) || pivots.length !== 4) return null;
  const expected = direction === "down" ? ["high", "low", "high", "low"] : ["low", "high", "low", "high"];
  if (pivots.some((pivot, index) => pivot.type !== expected[index])) return null;

  const prices = pivots.map((item) => item.price);
  const downward = direction === "down";
  const ruleA = downward ? prices[1] < prices[0] : prices[1] > prices[0];
  const ruleB = downward ? prices[2] < prices[0] : prices[2] > prices[0];
  const ruleC = downward ? prices[3] < prices[1] : prices[3] > prices[1];
  const retraceB = downward
    ? prices[0] - prices[2] < prices[0] - prices[1]
    : prices[2] - prices[0] < prices[1] - prices[0];
  const lenA = Math.abs(prices[1] - prices[0]);
  const lenC = Math.abs(prices[3] - prices[2]);
  const ratioCA = lenA === 0 ? null : lenC / lenA;
  const fibC = Number.isFinite(ratioCA) && ratioCA >= 0.618 && ratioCA <= 1.618;

  const checks = [
    { key: "ruleA", label: downward ? "A浪向下展开" : "A浪向上展开", ok: ruleA },
    { key: "ruleB", label: downward ? "B浪未突破起点" : "B浪未跌破起点", ok: ruleB },
    { key: "ruleC", label: downward ? "C浪跌破A浪低点" : "C浪突破A浪高点", ok: ruleC },
    { key: "retraceB", label: downward ? "B浪回撤幅度受控" : "2浪回撤幅度受控", ok: retraceB },
    { key: "fibC", label: downward ? "C浪长度落在 A浪 的 61.8%-161.8%" : "3浪长度落在 1浪 的 61.8%-161.8%", ok: fibC },
  ];
  const score = checks.reduce((acc, item) => acc + (item.ok ? (item.key === "fibC" ? 15 : 20) : 0), 0);
  if (checks.filter((item) => item.ok).length < 3 || !ruleA || !ruleB || !ruleC) return null;

  const labels = style === "bullCorrection" ? ["5", "a", "b", "c"] : ["E", "1", "2", "3"];
  return {
    kind: style === "bullCorrection" ? "abcDown" : "bearRebound",
    family: "correction",
    direction: downward ? "bear" : "bull",
    title: style === "bullCorrection" ? "牛市调整浪" : "熊市反弹浪",
    score,
    confidence: describeWaveConfidence(score),
    pivots,
    labels,
    invalidationPrice: downward ? prices[2] : prices[2],
    checks,
    metrics: { ratioCA },
    summary: downward
      ? `疑似牛市 a-b-c 调整，C/A 约 ${latestValid(ratioCA, 2)}，B 浪高点 ${latestValid(prices[2])} 为关键失效位。`
      : `疑似熊市 1-2-3 反弹，3/1 约 ${latestValid(ratioCA, 2)}，2 浪低点 ${latestValid(prices[2])}。`,
  };
}

function buildBullCycle(pivots) {
  if (!Array.isArray(pivots) || pivots.length !== 9) return null;
  const impulse = buildImpulseWave(pivots.slice(0, 6), "bull");
  const correction = buildCorrectiveWave(pivots.slice(5, 9), "down", "bullCorrection");
  if (!impulse || !correction) return null;

  const cAboveWave1Start = pivots[8].price > pivots[0].price;
  if (!cAboveWave1Start) return null;

  const checks = [
    ...impulse.checks,
    ...correction.checks,
    {
      key: "cAboveStart",
      label: "c浪终点高于1浪起点",
      ok: cAboveWave1Start,
    },
  ];

  const score = Math.min(100, impulse.score + correction.score + 8);
  return {
    kind: "bullCycle",
    family: "cycle",
    direction: "bull",
    title: "牛市 8 浪周期",
    score,
    confidence: describeWaveConfidence(score),
    pivots,
    labels: ["起", "1", "2", "3", "4", "5", "a", "b", "c"],
    invalidationPrice: pivots[8].price,
    checks,
    summary: `识别到牛市 1-5 + a-b-c 结构；c浪终点 ${latestValid(pivots[8].price)}，仍高于1浪起点 ${latestValid(pivots[0].price)}。`,
  };
}

function buildBearCycle(pivots) {
  if (!Array.isArray(pivots) || pivots.length !== 9) return null;
  const impulse = buildImpulseWave(pivots.slice(0, 6), "bear");
  const rebound = buildCorrectiveWave(pivots.slice(5, 9), "up", "bearRebound");
  if (!impulse || !rebound) return null;

  const checks = [...impulse.checks, ...rebound.checks];
  const score = Math.min(100, impulse.score + rebound.score + 5);
  return {
    kind: "bearCycle",
    family: "cycle",
    direction: "bear",
    title: "熊市 8 浪周期",
    score,
    confidence: describeWaveConfidence(score),
    pivots,
    labels: ["起", "A", "B", "C", "D", "E", "1", "2", "3"],
    invalidationPrice: pivots[8].price,
    checks,
    summary: `识别到熊市 A-E + 1-3 结构；当前为3浪反弹段，终点 ${latestValid(pivots[8].price)}。`,
  };
}

function detectElliottWave(rows, mode = "standard") {
  if (!Array.isArray(rows) || rows.length < 30) {
    return {
      ready: false,
      message: "当前显示区间太短，无法稳定识别波浪结构。",
      pivots: [],
      candidates: [],
      selected: null,
      options: getWaveOptions(mode, rows),
    };
  }

  const { pivots, options } = detectWavePivots(rows, mode);
  const candidates = [];

  for (let i = 0; i <= pivots.length - 9; i += 1) {
    const sample = pivots.slice(i, i + 9);
    const bullCycle = buildBullCycle(sample);
    const bearCycle = buildBearCycle(sample);
    if (bullCycle) candidates.push(bullCycle);
    if (bearCycle) candidates.push(bearCycle);
  }

  for (let i = 0; i <= pivots.length - 6; i += 1) {
    const sample = pivots.slice(i, i + 6);
    const bull = buildImpulseWave(sample, "bull");
    const bear = buildImpulseWave(sample, "bear");
    if (bull) candidates.push(bull);
    if (bear) candidates.push(bear);
  }

  for (let i = 0; i <= pivots.length - 4; i += 1) {
    const sample = pivots.slice(i, i + 4);
    const down = buildCorrectiveWave(sample, "down", "bullCorrection");
    const up = buildCorrectiveWave(sample, "up", "bearRebound");
    if (down) candidates.push(down);
    if (up) candidates.push(up);
  }

  candidates.sort((a, b) => {
    const familyPriority = { cycle: 2, impulse: 1, correction: 0 };
    const familyDiff = (familyPriority[b.family] || 0) - (familyPriority[a.family] || 0);
    if (familyDiff !== 0) return familyDiff;
    const endDiff = b.pivots[b.pivots.length - 1].index - a.pivots[a.pivots.length - 1].index;
    if (endDiff !== 0) return endDiff;
    return b.score - a.score;
  });

  const selected = candidates[0] || null;
  if (!selected) {
    return {
      ready: true,
      message: "当前区间没有识别出满足规则的高置信波浪，结构暂时不清晰。",
      pivots,
      candidates,
      selected: null,
      options,
    };
  }

  return {
    ready: true,
    message: selected.summary,
    pivots,
    candidates,
    selected,
    options,
  };
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

function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 hover:bg-slate-100"
        title="查看计算逻辑"
      >
        <Info className="h-3 w-3" />
      </button>
      {open && (
        <span className="absolute left-0 top-5 z-30 w-64 rounded-xl border bg-white p-3 text-xs leading-relaxed text-slate-600 shadow-lg">
          {text}
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

function FinancialReportPanel({ financialInfo, loading, error, market }) {
  if (market !== "ashare") {
    return (
      <div className="mt-4 rounded-2xl border bg-white p-4">
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
    <div className="mt-4 rounded-2xl border bg-white p-4">
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

function WaveStructurePanel({ analysis }) {
  if (!analysis?.ready) {
    return (
      <div className="rounded-2xl border bg-white p-3 text-xs">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-slate-700">波浪结构</span>
          <InfoTip text="波浪理论模块采用拐点识别 + 规则校验的保守实现。只在当前显示区间内寻找满足规则的候选浪型，识别不到时不会强行标注。" />
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-slate-500">{analysis?.message || "暂无数据"}</div>
      </div>
    );
  }

  const selected = analysis.selected;
  return (
    <div className="rounded-2xl border bg-white p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-700">波浪结构</span>
        <InfoTip text="先用分形高低点抽取拐点，再按推动浪和 ABC 调整浪的基础规则打分。这里显示的是当前显示区间内最新、分数最高的候选结构。" />
      </div>
      {!selected ? (
        <div className="rounded-xl bg-slate-50 p-3 text-slate-500">{analysis.message}</div>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">当前候选</span>
              <span className={`font-semibold ${selected.direction === "bull" ? "text-red-600" : "text-green-700"}`}>{selected.title}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-slate-500">置信度</span>
              <span className="font-semibold text-slate-800">{selected.confidence} / {selected.score} 分</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-slate-500">关键失效位</span>
              <span className="font-semibold text-slate-800">{latestValid(selected.invalidationPrice)}</span>
            </div>
            <div className="mt-2 leading-relaxed text-slate-600">{selected.summary}</div>
          </div>

          <div className="mt-3 rounded-xl bg-slate-50 p-2 text-slate-500">
            拐点数 {analysis.pivots.length}；最小摆动阈值约 {percentText(analysis.options.minMovePct)}；当前仅标注满足规则的候选浪型。
          </div>

          <div className="mt-3 space-y-1.5">
            {selected.checks.map((item) => (
              <div key={item.key} className="rounded-xl bg-slate-50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-700">{item.label}</span>
                  <span className={`font-semibold ${item.ok ? "text-red-600" : "text-green-700"}`}>{item.ok ? "满足" : "不满足"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChartToolbar({
  showWaves,
  onToggleWaves,
  drawingTool,
  onSelectDrawingTool,
  onUndoDrawing,
  onClearDrawings,
  hasDrawings,
  fullscreen,
  onToggleFullscreen,
  chartZoom,
  setChartZoom,
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggleWaves}
        className={`hidden items-center gap-2 rounded-full px-3 py-1 text-xs transition md:inline-flex ${
          showWaves
            ? "bg-violet-50 text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100"
            : "bg-slate-100 text-slate-500 ring-1 ring-slate-200 hover:bg-slate-200"
        }`}
        title={showWaves ? "点击关闭波浪叠加" : "点击开启波浪叠加"}
        aria-pressed={showWaves}
      >
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${showWaves ? "bg-violet-500" : "bg-slate-300"}`} />
        波浪叠加 {showWaves ? "开启" : "关闭"}
      </button>
      <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs text-slate-600">
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
      </div>
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
      <div className="flex items-center gap-1 rounded-xl border bg-white p-1 text-xs text-slate-600">
        <button type="button" className="rounded-lg px-2 py-1 hover:bg-slate-100" onClick={() => setChartZoom((z) => Math.max(0.8, Number((z - 0.1).toFixed(2))))}>缩小</button>
        <button type="button" className="rounded-lg px-2 py-1 font-semibold text-slate-800 hover:bg-slate-100" onClick={() => setChartZoom(1)}>{Math.round(chartZoom * 100)}%</button>
        <button type="button" className="rounded-lg px-2 py-1 hover:bg-slate-100" onClick={() => setChartZoom((z) => Math.min(2.4, Number((z + 0.1).toFixed(2))))}>放大</button>
      </div>
    </>
  );
}

function Chart({
  rows,
  fullRows = rows,
  visibleGaps,
  showGaps,
  zoom = 1,
  waveAnalysis = null,
  showWaveOverlay = true,
  expanded = false,
  drawingTool = "none",
  drawnLines = [],
  onDrawnLinesChange = null,
}) {
  const width = Math.round((expanded ? 1600 : 1100) * zoom);
  const height = Math.round((expanded ? 980 : 760) * zoom);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [showMacdSignals, setShowMacdSignals] = useState(true);
  const [pendingLineStart, setPendingLineStart] = useState(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [activeBrushPoints, setActiveBrushPoints] = useState([]);
  const scrollRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });
  const brushRef = useRef({ active: false });
  const drawingEnabled = drawingTool !== "none";

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

  const safeRows = useMemo(() => rows.filter((r) => [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite)), [rows]);
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
    const margin = { top: 40, right: 72, bottom: 36, left: 58 };
    const gap = 18;
    const mainH = Math.round(height * 0.55);
    const volH = 105;
    const macdH = Math.max(110, height - margin.top - margin.bottom - mainH - volH - gap * 2);
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
    const gaps = Array.isArray(visibleGaps) ? visibleGaps : [];
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
    return { margin, mainH, gap, volH, macdH, plotW, xStep, candleW, x, y, vy, volBase, macdTop, macdBase, macdY, macdAbsMax, yMax, yMin, maxVol, ma5, ma10, ma20, ma60, macdSeries, macdCrosses, zeroAxisCrosses, gaps, makePath };
  }, [safeRows, fullSafeRows, width, height, visibleGaps]);

  if (!chart || safeRows.length === 0) {
    return <div className="rounded-2xl bg-slate-100 p-12 text-center text-slate-500">暂无可绘制数据</div>;
  }

  const clampedHoverIndex = hoverIndex == null ? safeRows.length - 1 : Math.min(Math.max(hoverIndex, 0), safeRows.length - 1);
  const clampedSelectedIndex = selectedIndex == null ? null : Math.min(Math.max(selectedIndex, 0), safeRows.length - 1);
  const guideIndex = clampedSelectedIndex ?? (hoverIndex == null ? null : clampedHoverIndex);
  const guideRow = guideIndex == null ? null : safeRows[guideIndex];
  const hover = safeRows[clampedHoverIndex];
  const positive = hover.close >= hover.open;
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
      className={`w-full overflow-x-auto rounded-2xl border bg-white p-3 shadow-sm ${drawingEnabled ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
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
            if (point) setSelectedIndex(point.index);
          }}
        >
          <rect x="0" y="0" width={width} height={height} fill="#ffffff" />
          <text x="18" y="22" fontSize="13" fill="#333">
            {hover.date} 开 {hover.open.toFixed(2)} 高 {hover.high.toFixed(2)} 低 {hover.low.toFixed(2)} 收 {hover.close.toFixed(2)}
          </text>
          <text x="430" y="22" fontSize="13" fill={positive ? "#d50000" : "#008000"}>
            涨跌 {Number.isFinite(hover.change) ? hover.change.toFixed(2) : "-"} ({Number.isFinite(hover.pct) ? hover.pct.toFixed(2) : "-"}%)
          </text>
          <text x="650" y="22" fontSize="13" fill="#666">
            成交量 {formatNumber(hover.volume)} 换手 {Number.isFinite(hover.turnover) ? hover.turnover.toFixed(2) : "-"}%
          </text>
          {currentTD && (
            <g>
              <rect x={width - chart.margin.right - 150} y="8" width="140" height="22" rx="11" fill={currentTD.direction === "up" ? "rgba(213,0,0,0.08)" : "rgba(0,128,0,0.08)"} stroke={currentTD.direction === "up" ? "#d50000" : "#008000"} />
              <text x={width - chart.margin.right - 80} y="23" textAnchor="middle" fontSize="12" fontWeight="700" fill={currentTD.direction === "up" ? "#d50000" : "#008000"}>
                当前九转：{currentTD.text}
              </text>
            </g>
          )}

          {Array.from({ length: gridLines + 1 }).map((_, i) => {
            const yy = chart.margin.top + (chart.mainH / gridLines) * i;
            const price = chart.yMax - ((chart.yMax - chart.yMin) / gridLines) * i;
            return (
              <g key={`grid-${i}`}>
                <line x1={chart.margin.left} x2={width - chart.margin.right} y1={yy} y2={yy} stroke="#e7e7e7" strokeDasharray="4 4" />
                <text x={width - chart.margin.right + 8} y={yy + 4} fontSize="11" fill="#666">{price.toFixed(2)}</text>
              </g>
            );
          })}

        <line x1={chart.margin.left} x2={chart.margin.left} y1={chart.margin.top} y2={chart.margin.top + chart.mainH} stroke="#cccccc" />
        <line x1={width - chart.margin.right} x2={width - chart.margin.right} y1={chart.margin.top} y2={chart.margin.top + chart.mainH} stroke="#cccccc" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.margin.top + chart.mainH} y2={chart.margin.top + chart.mainH} stroke="#cccccc" />

        <path d={chart.makePath(chart.ma5)} fill="none" stroke="#ff9900" strokeWidth="1.4" />
        <path d={chart.makePath(chart.ma10)} fill="none" stroke="#3366cc" strokeWidth="1.4" />
        <path d={chart.makePath(chart.ma20)} fill="none" stroke="#9933cc" strokeWidth="1.4" />
        <path d={chart.makePath(chart.ma60)} fill="none" stroke="#009688" strokeWidth="1.4" />
        <text x="18" y="39" fontSize="12" fill="#ff9900">MA5</text>
        <text x="64" y="39" fontSize="12" fill="#3366cc">MA10</text>
        <text x="116" y="39" fontSize="12" fill="#9933cc">MA20</text>
        <text x="168" y="39" fontSize="12" fill="#009688">MA60</text>

        {showGaps &&
          chart.gaps.map((g, idx) => {
            const left = chart.x(g.startIndex) + chart.candleW / 2;
            const right = chart.x(g.endIndex) + chart.candleW / 2;
            const y1 = chart.y(g.top);
            const y2 = chart.y(g.bottom);
            const rectY = Math.min(y1, y2);
            const rectH = Math.max(2, Math.abs(y2 - y1));
            const stroke = g.type === "up" ? "#d50000" : "#008000";
            const fill = g.type === "up" ? "rgba(213, 0, 0, 0.10)" : "rgba(0, 128, 0, 0.10)";
            return (
              <g key={`gap-${idx}`}>
                <rect x={left} y={rectY} width={Math.max(2, right - left)} height={rectH} fill={fill} stroke={stroke} strokeWidth="1" strokeDasharray={g.filled ? "5 3" : "none"} />
                <text x={left + 4} y={rectY - 3} fontSize="10" fill={stroke}>{g.type === "up" ? "上缺口" : "下缺口"}</text>
              </g>
            );
          })}

        {safeRows.map((d, i) => {
          const up = d.close >= d.open;
          const color = up ? "#d50000" : "#008000";
          const cx = chart.x(i);
          const openY = chart.y(d.open);
          const closeY = chart.y(d.close);
          const highY = chart.y(d.high);
          const lowY = chart.y(d.low);
          const bodyTop = Math.min(openY, closeY);
          const bodyH = Math.max(1, Math.abs(closeY - openY));
          const volTop = chart.vy(d.volume);
          const volBarH = chart.volBase - volTop;
          return (
            <g key={`${d.date}-${i}`}>
              <line x1={cx} x2={cx} y1={highY} y2={lowY} stroke={color} strokeWidth="1" />
              <rect x={cx - chart.candleW / 2} y={bodyTop} width={chart.candleW} height={bodyH} fill={up ? color : "#ffffff"} stroke={color} strokeWidth="1" />
              <rect x={cx - chart.candleW / 2} y={volTop} width={chart.candleW} height={Math.max(1, volBarH)} fill={color} opacity="0.45" />
              {d.tdUp != null && (
                <g>
                  <text x={cx} y={highY - 6} textAnchor="middle" fontSize={d.tdUp === 9 ? 14 : 11} fontWeight={d.tdUp === 9 ? "700" : "500"} fill={d.tdStatus === "pending" ? "#666666" : "#008000"}>{d.tdUp}</text>
                  {i === safeRows.length - 1 && <text x={cx + 22} y={highY - 6} fontSize="10" fontWeight="700" fill="#008000">上涨</text>}
                </g>
              )}
              {d.tdDown != null && (
                <g>
                  <text x={cx} y={lowY + 16} textAnchor="middle" fontSize={d.tdDown === 9 ? 14 : 11} fontWeight={d.tdDown === 9 ? "700" : "500"} fill={d.tdStatus === "pending" ? "#666666" : "#d50000"}>{d.tdDown}</text>
                  {i === safeRows.length - 1 && <text x={cx + 22} y={lowY + 16} fontSize="10" fontWeight="700" fill="#d50000">下跌</text>}
                </g>
              )}
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
                stroke="#0f172a"
                strokeWidth="2"
                opacity="0.82"
              />
            ) : line.type === "brush" ? (
              <path d={makeOverlayPath(line.points)} fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.88" />
            ) : (
              <>
                <line
                  x1={line.start.x}
                  y1={line.start.y}
                  x2={line.end.x}
                  y2={line.end.y}
                  stroke="#0f172a"
                  strokeWidth="2"
                  opacity="0.85"
                />
                <circle cx={line.start.x} cy={line.start.y} r="3.5" fill="#0f172a" />
                <circle cx={line.end.x} cy={line.end.y} r="3.5" fill="#0f172a" />
              </>
            )}
          </g>
        ))}
        {drawingTool === "brush" && activeBrushPoints.length > 1 && (
          <g pointerEvents="none">
            <path d={makeOverlayPath(activeBrushPoints)} fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
          </g>
        )}
        {drawingTool === "trend" && pendingLineStart && hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={pendingLineStart.x}
              y1={pendingLineStart.y}
              x2={hoverPoint.x}
              y2={hoverPoint.y}
              stroke="#0f172a"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.45"
            />
            <circle cx={pendingLineStart.x} cy={pendingLineStart.y} r="4" fill="#0f172a" opacity="0.7" />
          </g>
        )}
        {drawingTool === "horizontal" && hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={0}
              y1={hoverPoint.y}
              x2={width}
              y2={hoverPoint.y}
              stroke="#0f172a"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.45"
            />
          </g>
        )}
        {drawingEnabled && (
          <g pointerEvents="none">
            <rect x={chart.margin.left} y={chart.margin.top + 6} width="156" height="22" rx="11" fill="rgba(15,23,42,0.06)" stroke="rgba(15,23,42,0.16)" />
            <text x={chart.margin.left + 78} y={chart.margin.top + 21} textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">
              {drawingTool === "brush" ? "画笔: 按住拖动画线" : drawingTool === "trend" ? "趋势线: 点两次完成" : "水平线: 点一次落线"}
            </text>
          </g>
        )}

        {showWaveOverlay &&
          waveAnalysis?.selected &&
          (() => {
            const wave = waveAnalysis.selected;
            const lineColor = wave.direction === "bull" ? "#7c3aed" : "#0f766e";
            const fillColor = wave.direction === "bull" ? "rgba(124,58,237,0.12)" : "rgba(15,118,110,0.12)";
            const path = wave.pivots
              .map((pivot, index) => `${index === 0 ? "M" : "L"}${chart.x(pivot.index)},${chart.y(pivot.price)}`)
              .join(" ");

            return (
              <g>
                <path d={path} fill="none" stroke={lineColor} strokeWidth="2.2" strokeDasharray={wave.family === "correction" ? "7 5" : "none"} />
                {wave.pivots.map((pivot, index) => {
                  const px = chart.x(pivot.index);
                  const py = chart.y(pivot.price);
                  const label = wave.labels[index] || `${index}`;
                  const labelOffsetY = pivot.type === "high" ? -14 : 18;
                  return (
                    <g key={`wave-${pivot.index}-${label}`}>
                      <circle cx={px} cy={py} r="5" fill="#ffffff" stroke={lineColor} strokeWidth="2" />
                      <rect x={px - 14} y={py + labelOffsetY - 11} width="28" height="16" rx="8" fill={fillColor} stroke={lineColor} strokeWidth="1" />
                      <text x={px} y={py + labelOffsetY + 1} textAnchor="middle" fontSize="10" fontWeight="700" fill={lineColor}>
                        {label}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })()}

        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.margin.top + chart.mainH + chart.gap} y2={chart.margin.top + chart.mainH + chart.gap} stroke="#cccccc" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.volBase} y2={chart.volBase} stroke="#cccccc" />
        <text x={width - chart.margin.right + 8} y={chart.margin.top + chart.mainH + chart.gap + 12} fontSize="11" fill="#666">{formatNumber(chart.maxVol)}</text>
        <text x="18" y={chart.margin.top + chart.mainH + chart.gap + 12} fontSize="12" fill="#666">VOL</text>

        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdTop} y2={chart.macdTop} stroke="#cccccc" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdBase} y2={chart.macdBase} stroke="#dddddd" strokeDasharray="4 4" />
        <line x1={chart.margin.left} x2={width - chart.margin.right} y1={chart.macdTop + chart.macdH} y2={chart.macdTop + chart.macdH} stroke="#cccccc" />
        <text x="18" y={chart.macdTop + 14} fontSize="12" fill="#666">MACD</text>
        <text x="64" y={chart.macdTop + 14} fontSize="12" fill="#111827">DIF</text>
        <text x="102" y={chart.macdTop + 14} fontSize="12" fill="#b59f00">DEA</text>
        <text x={width - chart.margin.right + 8} y={chart.macdTop + 12} fontSize="11" fill="#666">+{chart.macdAbsMax.toFixed(2)}</text>
        <text x={width - chart.margin.right + 8} y={chart.macdBase + 4} fontSize="11" fill="#666">0</text>
        <text x={width - chart.margin.right + 8} y={chart.macdTop + chart.macdH - 4} fontSize="11" fill="#666">-{chart.macdAbsMax.toFixed(2)}</text>

        {chart.macdSeries.map((m, i) => {
          if (!Number.isFinite(m.hist)) return null;
          const cx = chart.x(i);
          const y0 = chart.macdY(0);
          const yh = chart.macdY(m.hist);
          const barY = Math.min(y0, yh);
          const barH = Math.max(1, Math.abs(yh - y0));
          const color = m.hist >= 0 ? "#d50000" : "#008000";
          return <rect key={`macd-${i}`} x={cx - chart.candleW / 2} y={barY} width={chart.candleW} height={barH} fill={color} opacity="0.75" />;
        })}
        <path d={chart.makePath(chart.macdSeries.map((m) => m.dif), chart.macdY)} fill="none" stroke="#111827" strokeWidth="1.5" />
        <path d={chart.makePath(chart.macdSeries.map((m) => m.dea), chart.macdY)} fill="none" stroke="#b59f00" strokeWidth="1.3" />
        {showMacdSignals &&
          chart.macdCrosses.map((cross, idx) => {
            const cx = chart.x(cross.index);
            const cy = chart.macdY(cross.value);
            const isGolden = cross.type === "golden";
            const color = isGolden ? "#d50000" : "#008000";
            const labelY = isGolden ? cy - 12 : cy + 18;
            const labelBoxY = isGolden ? labelY - 11 : labelY - 10;
            return (
              <g key={`macd-cross-${idx}-${cross.index}`}>
                <circle cx={cx} cy={cy} r="6" fill="rgba(255,255,255,0.75)" stroke={color} strokeWidth="2" />
                <rect x={cx - 16} y={labelBoxY} width="32" height="16" rx="8" fill="rgba(255,255,255,0.9)" stroke={color} strokeWidth="1" />
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
                <rect x={cx - 19} y={labelY - 11} width="38" height="16" rx="8" fill="rgba(255,255,255,0.92)" stroke={color} strokeWidth="1" />
                <text x={cx} y={labelY + 1} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{cross.label}</text>
              </g>
            );
          })}

        {Array.from({ length: xLabels }).map((_, i) => {
          const idx = xLabels === 1 ? 0 : Math.min(safeRows.length - 1, Math.round((safeRows.length - 1) * (i / (xLabels - 1))));
          return <text key={`x-${i}`} x={chart.x(idx)} y={height - 10} textAnchor="middle" fontSize="11" fill="#666">{safeRows[idx].date.slice(5)}</text>;
        })}

        {guideIndex != null &&
          guideRow &&
          (() => {
            const gx = chart.x(guideIndex);
            const label = guideRow.date;
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
                <line x1={gx} x2={gx} y1={chart.margin.top} y2={chart.macdTop + chart.macdH} stroke={selected ? "#111827" : "#555"} strokeDasharray="3 3" opacity={selected ? "0.85" : "0.65"} />
                <circle cx={gx} cy={chart.y(guideRow.close)} r="3" fill={guidePositive ? "#d50000" : "#008000"} />
                <rect x={boxX} y={boxY} width={labelW} height={labelH} rx="6" fill="#ffffff" stroke={selected ? "#111827" : "#cbd5e1"} />
                <text x={boxX + labelW / 2} y={boxY + 14} textAnchor="middle" fontSize="11" fill="#334155">{label}</text>
              </g>
            );
          })()}
        </svg>
        <button
          type="button"
          className="absolute bottom-4 right-[-18px] z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/98 text-slate-500 shadow-sm backdrop-blur hover:border-slate-300 hover:bg-white hover:text-slate-700"
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

function buildAgentPreviewReply(text, context) {
  const query = String(text || "").trim();
  const aCode = context?.ashare || "600519";
  const usCode = context?.us || "AAPL";

  if (/选股|筛选|找.*股票|推荐/.test(query)) {
    return [
      "我会把这个问题拆成三个条件：趋势结构、成交量确认、风险过滤。",
      `当前可以先用 A股 ${aCode} 或美股 ${usCode} 做样例分析。`,
      "接入模型和 iFinD MCP 后，这里会返回候选标的、筛选原因、排除原因和需要复核的数据点。",
    ].join("\n");
  }

  if (/财报|ROE|利润|营收|现金流|基本面/.test(query)) {
    return [
      "这个问题需要财务和公告数据支持。",
      "后续接入 iFinD MCP 后，我会优先查询财务摘要、利润表、现金流、股东结构和重大公告，再给出结论。",
      "当前界面版先保留对话上下文，不直接生成未经数据校验的基本面判断。",
    ].join("\n");
  }

  if (/九转|MACD|金叉|死叉|趋势|K线|技术/.test(query)) {
    return [
      "技术面问题可以优先结合当前图表里的九转、均线、MACD、断层和量价关系。",
      "下一步接入后端后，我会读取当前页面的指标结果，并把它组织成偏强、偏弱、观察点和风险点。",
      "这类输出适合做复盘，不适合当成确定性买卖信号。",
    ].join("\n");
  }

  return [
    "我可以按股票研究的方式处理这个问题。",
    "第一步会识别标的和市场，第二步查询行情、公告、新闻或财务数据，第三步给出结构化分析。",
    "当前是 Agent 对话界面原型，后续接入模型和 iFinD MCP 后会返回真实数据驱动的结果。",
  ].join("\n");
}

function AgentChatPanel({ marketCodes }) {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "可以开始问股票相关问题。比如：分析一下贵州茅台最近的趋势，或者帮我筛选新能源里趋势转强的公司。",
    },
  ]);
  const [input, setInput] = useState("");

  const quickPrompts = [
    "分析一下 600519 最近的趋势",
    "帮我找短线转强的 A 股",
    "解释一下当前 MACD 和九转信号",
    "总结一下 MSFT 的技术面",
  ];

  function sendMessage(value = input) {
    const text = String(value || "").trim();
    if (!text) return;

    const userMessage = { role: "user", content: text };
    const assistantMessage = {
      role: "assistant",
      content: buildAgentPreviewReply(text, marketCodes),
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
  }

  return (
    <div className="grid min-h-[640px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold text-slate-700">研究上下文</div>
        <div className="mt-4 space-y-3 text-sm">
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs text-slate-500">A股代码</div>
            <div className="mt-1 font-semibold text-slate-800">{marketCodes?.ashare || "600519"}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs text-slate-500">美股代码</div>
            <div className="mt-1 font-semibold text-slate-800">{marketCodes?.us || "AAPL"}</div>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            iFinD MCP 需要后端密钥接入。当前先保留为对话界面，避免把凭证暴露到浏览器。
          </div>
        </div>
      </aside>

      <section className="flex min-h-[640px] flex-col rounded-2xl border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-slate-800">股票研究 Agent</div>
            <div className="text-xs text-slate-500">对话草稿会保留在当前页面，刷新后清空。</div>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1 text-xs text-slate-500">
            <Bot className="h-3.5 w-3.5" />
            Preview
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50/70 px-5 py-5">
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            return (
              <div key={`${message.role}-${index}`} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={`max-w-[760px] whitespace-pre-line rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                    isUser
                      ? "bg-slate-900 text-white"
                      : "border border-slate-100 bg-white text-slate-700"
                  }`}
                >
                  {message.content}
                </div>
                {isUser && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm">
                    <UserRound className="h-4 w-4" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t bg-white p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => sendMessage(prompt)}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:border-slate-300 hover:bg-white"
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
              placeholder="输入股票、行业、策略或财报问题"
              className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-slate-400"
            />
            <Button type="button" onClick={() => sendMessage()} disabled={!input.trim()} className="h-10 rounded-xl px-3">
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
    setFavoritesMode(false); // 「我的收藏夹」只在成熟因子提供，切换分类时复位
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
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const request = query.mode === "favorites"
      ? fetchFavoritesBacktest({ market: "ashare", page, groups: query.groups })
      : fetchFactorDetail({ factors: query.factors, startDate: query.startDate, endDate: query.endDate, page });
    request
      .then(setResult)
      .catch((e) => { if (e.name !== "AbortError") setError(e?.message || "加载失败"); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
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
        <div className={`flex items-center gap-2 ${favoritesMode ? "opacity-40" : ""}`}>
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
        <div className={`flex items-center gap-1.5 ${favoritesMode ? "opacity-40" : ""}`}>
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
        <span className="shrink-0">收益率 = ( 第 N 交易日收盘价 &minus; 信号日收盘价 ) &divide; 信号日收盘价 &times; 100%</span>
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
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.value)), 0.01);
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">{label}</div>
      <div className="space-y-2.5">
        {data.map((item) => {
          const isPos = item.value >= 0;
          const pct = (Math.abs(item.value) / maxAbs) * 100;
          return (
            <div
              key={item.factor}
              className="flex items-center gap-2 text-xs"
              title={item.sampleSize != null ? `非重叠独立样本 n=${item.sampleSize}` : undefined}
            >
              <div className="w-10 shrink-0 text-right text-slate-500">{item.factor}</div>
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
  return payload.data;
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
      {/* 左：成熟/预备 切换　右：因子管理（独立放置，便于后续按权限隐藏） */}
      <div className="flex items-center justify-between">
        <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm w-fit">
          {categoryTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFactorCategory(t.key)}
              className={`rounded-lg px-5 py-1.5 text-sm font-medium transition-colors ${
                factorCategory === t.key
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 权限上线后，把这个按钮包一层 role === 'admin' 判断即可整体隐藏 */}
        <button
          type="button"
          onClick={() => setFactorCategory("manage")}
          className={`rounded-xl border px-5 py-1.5 text-sm font-medium shadow-sm transition-colors ${
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
  return payload.data; // [{ name, label, formula, source, principle, whyEffective, evaluation, decision, status, enabled }]
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
    setLoading(true);
    setLoadError(null);
    fetchAdminFactors(ctrl.signal)
      .then((data) => setRows(data))
      .catch((e) => { if (e.name !== "AbortError") setLoadError(e?.message || "加载失败"); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
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
            <div className="font-mono text-xs whitespace-nowrap">{r.name}</div>
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
          <td className="px-3 py-3 align-top whitespace-nowrap">
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
          <td className="px-3 py-3 align-top whitespace-nowrap text-xs">{r.updatedBy || "-"}</td>
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
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-slate-700">因子管理</div>
        {rows && (
          <div className="flex gap-3 text-xs text-slate-500">
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
        <div className="mt-4">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="w-[11%] px-3 py-3 text-left font-medium">因子名</th>
                <th className="w-[18%] px-3 py-3 text-left font-medium">显示名</th>
                <th className="w-[36%] px-3 py-3 text-left font-medium">简介</th>
                <th className="w-[13%] px-3 py-3 text-left font-medium">状态</th>
                <th className="w-[7%] px-3 py-3 text-left font-medium">启用</th>
                <th className="w-[8%] px-3 py-3 text-left font-medium">更新时间</th>
                <th className="w-[7%] px-3 py-3 text-left font-medium">更新人</th>
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

  useEffect(() => {
    if (activeTab !== "trailing") return;
    if (trailingData) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    fetchFactorReturns("trailing", null, ctrl.signal, status)
      .then((data) => setTrailingData(data))
      .catch((e) => { if (e.name !== "AbortError") setLoadError(e?.message || "加载失败"); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [activeTab, status, trailingData]);

  useEffect(() => {
    if (activeTab !== "custom") return;
    if (customCache[startDate]) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    fetchFactorReturns("custom", startDate, ctrl.signal, status)
      .then((data) => setCustomCache((prev) => ({ ...prev, [startDate]: data })))
      .catch((e) => { if (e.name !== "AbortError") setLoadError(e?.message || "加载失败"); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [activeTab, startDate, status]);

  const currentData = activeTab === "trailing" ? trailingData : customCache[startDate];

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
    data: currentData?.[p.key] ?? [],
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
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
      <div className="flex items-center gap-4">
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
      <div className="grid grid-cols-3 gap-4">
        {periods.slice(0, 3).map((p) => (
          <FactorBarChart key={p.key} data={p.data} label={p.displayLabel} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
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
  recommendationTd = "td1",
  recommendationTdDate = "",
  recommendationMacd = "all",
  recommendationSafety = "all",
  favoriteCodeSet,
  favoritePendingCodeSet,
  onInputChange,
  onRefresh,
  onStyleChange,
  onRecommendationFactorChange,
  onRecommendationDateChange,
  onRecommendationTdChange,
  onRecommendationTdDateChange,
  onRecommendationMacdChange,
  onRecommendationSafetyChange,
  onPick,
  onToggleFavorite,
  preloadEnabled = false,
  onTogglePreload = null,
  preloadStatus = null,
  onClearPreloadCache = null,
}) {
  const isAshare = market === "ashare";
  const isUs = market === "us";
  const title = isAshare ? "A股自选" : "美股自选";
  const helper = isAshare
    ? "支持逗号、空格、换行分隔；一行一个 A 股代码也可以。"
    : "支持逗号、空格、换行分隔；一行一个美股代码也可以。";
  const placeholder = isAshare ? "例如 600519,000001\n000001\n300750" : "例如 MSFT,AAPL\nNVDA\nTSLA";
  const isRecommendationMode = style === "rows";
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
    <Card className="rounded-2xl border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.96))] shadow-sm xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)] xl:max-h-[1200px]">
      <CardContent className="flex h-full min-h-0 flex-col p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-900">{panelTitle}</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">{isRecommendationMode ? `共 ${items.length} 个标的` : helper}</div>
          </div>
          <div className="grid w-[132px] grid-cols-2 rounded-full border border-slate-200 bg-white p-1">
            {WATCHLIST_STYLE_OPTIONS.map((option) => {
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
          <div className="mt-3 flex items-center justify-between gap-2">
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
                    <button type="button" onClick={() => onPick(item.code)} className="block w-full p-4">
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
                    </button>
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
                  <button type="button" onClick={() => onPick(item.code)} className="block w-full p-4">
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
                  </button>
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
  const title = market === "us" ? "我的美股收藏夹" : "我的股票收藏夹";
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

export default function AShareTD9InteractiveChart({ onLogout }) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [market, setMarket] = useState("ashare");
  const [marketCodes, setMarketCodes] = useState({ ashare: "600519", us: "MSFT" });
  const [ashareSuggestions, setAshareSuggestions] = useState([]);
  const [ashareSuggestLoading, setAshareSuggestLoading] = useState(false);
  const [ashareSuggestOpen, setAshareSuggestOpen] = useState(false);
  const [ashareSuggestFocused, setAshareSuggestFocused] = useState(false);
  const [ashareSuggestIndex, setAshareSuggestIndex] = useState(0);
  const [watchlistInputMap, setWatchlistInputMap] = useState({
    ashare: "600519,000001,300750",
    us: "MSFT,AAPL,NVDA",
  });
  const [watchlistItemsMap, setWatchlistItemsMap] = useState({ ashare: [], us: [] });
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistError, setWatchlistError] = useState("");
  const [favoriteItemsMap, setFavoriteItemsMap] = useState({ ashare: [], us: [] });
  const [favoriteLoadingMap, setFavoriteLoadingMap] = useState({ ashare: false, us: false });
  const [favoriteErrorMap, setFavoriteErrorMap] = useState({ ashare: "", us: "" });
  const [favoritePendingMap, setFavoritePendingMap] = useState({ ashare: [], us: [] });
  const [favoriteGroupsMap, setFavoriteGroupsMap] = useState({ ashare: ["默认"], us: ["默认"] });
  const [activeFavoriteGroupMap, setActiveFavoriteGroupMap] = useState({ ashare: "默认", us: "默认" });
  const [favoritesPanelOpen, setFavoritesPanelOpen] = useState(false);
  const [recommendationItemsMap, setRecommendationItemsMap] = useState({ ashare: [], us: [] });
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [recommendationError, setRecommendationError] = useState("");
  const [recommendationFactorMap, setRecommendationFactorMap] = useState({ ashare: "factor1", us: "factor1" });
  const [recommendationTdMap, setRecommendationTdMap] = useState({ ashare: "td1", us: "td1" });
  const [recommendationDateMap, setRecommendationDateMap] = useState({
    ashare: getDefaultRecommendationDate(),
    us: getDefaultRecommendationDate(),
  });
  const [recommendationTdDateMap, setRecommendationTdDateMap] = useState({
    ashare: getDefaultRecommendationDate(),
    us: getDefaultRecommendationDate(),
  });
  const [recommendationMacdMap, setRecommendationMacdMap] = useState({ ashare: "all", us: "all" });
  const [recommendationSafetyMap, setRecommendationSafetyMap] = useState({ ashare: "all", us: "all" });
  const [watchlistStyle, setWatchlistStyle] = useState("cards");
  const [period, setPeriod] = useState("101");
  const [adjust, setAdjust] = useState("1");
  const [displayCount, setDisplayCount] = useState(240);
  const [tdMode, setTdMode] = useState("current");
  const [showGaps, setShowGaps] = useState(true);
  const [unfilledOnly, setUnfilledOnly] = useState(true);
  const [showWaves, setShowWaves] = useState(false);
  const [waveSensitivity, setWaveSensitivity] = useState("standard");
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
  const [profileInfo, setProfileInfo] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartZoom, setChartZoom] = useState(1);

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
  const prediction = useMemo(() => buildTrendPrediction(rawRows), [rawRows]);
  const waveAnalysis = useMemo(() => detectElliottWave(rows, waveSensitivity), [rows, waveSensitivity]);
  const currentCode = market === "us" ? marketCodes.us : marketCodes.ashare;
  const watchlistInput = market === "us" ? watchlistInputMap.us : watchlistInputMap.ashare;
  const favoriteItems = market === "us" ? favoriteItemsMap.us : favoriteItemsMap.ashare;
  const favoriteLoading = market === "us" ? favoriteLoadingMap.us : favoriteLoadingMap.ashare;
  const favoriteError = market === "us" ? favoriteErrorMap.us : favoriteErrorMap.ashare;
  const favoritePendingCodes = market === "us" ? favoritePendingMap.us : favoritePendingMap.ashare;
  const favoriteGroups = market === "us" ? favoriteGroupsMap.us : favoriteGroupsMap.ashare;
  const activeFavoriteGroup = market === "us" ? activeFavoriteGroupMap.us : activeFavoriteGroupMap.ashare;
  const favoriteCodeSet = useMemo(() => new Set(favoriteItems.map((item) => item.code)), [favoriteItems]);
  const favoritePendingCodeSet = useMemo(() => new Set(favoritePendingCodes), [favoritePendingCodes]);
  const activeMetaCode = normalizeCodeForMarket(meta.code || currentCode, market);
  const activeMetaFavoritePending = favoritePendingCodeSet.has(activeMetaCode);
  const activeMetaFavorited = favoriteCodeSet.has(activeMetaCode);
  const manualWatchlistItems = market === "us" ? watchlistItemsMap.us : watchlistItemsMap.ashare;
  const recommendationItems = market === "us" ? recommendationItemsMap.us : recommendationItemsMap.ashare;
  const watchlistItems = watchlistStyle === "rows" ? recommendationItems : manualWatchlistItems;
  const watchlistLoadingState = watchlistStyle === "rows" ? recommendationLoading : watchlistLoading;
  const watchlistErrorState = watchlistStyle === "rows" ? recommendationError : watchlistError;
  const recommendationFactor = market === "us" ? recommendationFactorMap.us : recommendationFactorMap.ashare;
  const recommendationTd = market === "us" ? recommendationTdMap.us : recommendationTdMap.ashare;
  const recommendationDate = market === "us" ? recommendationDateMap.us : recommendationDateMap.ashare;
  const recommendationTdDate = market === "us" ? recommendationTdDateMap.us : recommendationTdDateMap.ashare;
  const recommendationMacd = market === "us" ? recommendationMacdMap.us : recommendationMacdMap.ashare;
  const recommendationSafety = market === "us" ? recommendationSafetyMap.us : recommendationSafetyMap.ashare;
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
  const usKlineCacheRef = useRef(new Map());
  const usPreloadRunRef = useRef(0);

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
    if (!force && cached?.data) return cached.data;
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
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [market, currentCode, ashareSuggestFocused]);

  async function loadWatchlist(targetMarket = market) {
    const requestedMarket = targetMarket === "us" ? "us" : targetMarket === "ashare" ? "ashare" : market;
    if (requestedMarket === "agent") return;
    const rawInput = requestedMarket === "us" ? watchlistInputMap.us : watchlistInputMap.ashare;
    const codes = normalizeWatchlistCodes(rawInput, requestedMarket);

    if (!codes.length) {
      setWatchlistError(requestedMarket === "ashare" ? "请先输入至少一个 6 位 A 股代码。" : "请先输入至少一个有效的美股代码。");
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
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
    setFavoriteLoadingMap((prev) => ({ ...prev, [requestedMarket]: true }));
    setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: "" }));

    try {
      const payload = await fetchFavorites({ market: requestedMarket });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const groups = Array.isArray(payload?.groups) && payload.groups.length ? payload.groups : ["默认"];
      setFavoriteItemsMap((prev) => ({ ...prev, [requestedMarket]: items }));
      setFavoriteGroupsMap((prev) => ({ ...prev, [requestedMarket]: groups }));
      // active 夹若已不存在（被删），回落到默认夹。
      setActiveFavoriteGroupMap((prev) => (
        groups.includes(prev[requestedMarket]) ? prev : { ...prev, [requestedMarket]: "默认" }
      ));
    } catch (e) {
      setFavoriteErrorMap((prev) => ({ ...prev, [requestedMarket]: getErrorMessage(e, "收藏夹读取失败，请稍后重试。") }));
    } finally {
      setFavoriteLoadingMap((prev) => ({ ...prev, [requestedMarket]: false }));
    }
  }

  async function toggleFavorite(item, targetMarket = market) {
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
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
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
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
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
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
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
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
    const requestedMarket = targetMarket === "us" ? "us" : "ashare";
    setActiveFavoriteGroupMap((prev) => ({ ...prev, [requestedMarket]: name || "默认" }));
  }

  async function load(overrideCode) {
    if (market === "agent" || market === "factor-research") return;
    const rawTargetCode = typeof overrideCode === "string" ? overrideCode : currentCode;
    let targetCode = normalizeCodeForMarket(rawTargetCode, market);
    setLoading(true);
    setError("");
    setFinancialError("");
    setFinancialInfo(null);
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
      setRawRows(result.klines);
      setMeta({
        code: result.code,
        name: result.name,
        marketCap: result.marketCap || null,
        floatMarketCap: result.floatMarketCap || null,
        peRatio: Number.isFinite(result.peRatio) ? result.peRatio : null,
        turnoverRate: Number.isFinite(result.turnoverRate) ? result.turnoverRate : null,
      });

      if (market === "ashare") {
        setFinancialLoading(true);
        setProfileLoading(true);
        try {
          const target = result.code || currentCode;
          const [financeResult, profileResult] = await Promise.allSettled([
            apiFetch(`/api/ashare-finance?code=${encodeURIComponent(target)}`, {
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
          ]);

          if (financeResult.status === "fulfilled") {
            setFinancialInfo(financeResult.value);
          } else {
            setFinancialError(financeResult.reason instanceof Error ? financeResult.reason.message : "财报数据加载失败");
          }

          if (profileResult.status === "fulfilled") {
            setProfileInfo(profileResult.value);
          } else {
            setProfileError(profileResult.reason instanceof Error ? profileResult.reason.message : "公司概况数据加载失败");
          }
        } finally {
          setFinancialLoading(false);
          setProfileLoading(false);
        }
      } else {
        setFinancialLoading(false);
        setProfileLoading(false);
      }
    } catch (e) {
      setError(getErrorMessage(e, "行情加载失败，请稍后重试。"));
      setRawRows([]);
      setMeta({ code: targetCode, name: "" });
      setFinancialLoading(false);
      setProfileLoading(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (market === "agent" || market === "factor-research") return undefined;
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    if (market === "agent" || market === "factor-research") return undefined;
    const timer = window.setTimeout(() => {
      loadFavorites(market);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    if (market === "agent" || market === "factor-research" || watchlistItems.length > 0) return undefined;
    const timer = window.setTimeout(() => {
      if (watchlistStyle === "rows") {
        loadRecommendations(market);
      } else {
        loadWatchlist(market);
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, watchlistItems.length, watchlistStyle]);

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
        if (cached?.data) {
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
    <div className="min-h-screen bg-slate-50 p-4 text-slate-900">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
              {MARKET_TABS.map((tab) => {
                const active = market === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${active ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white hover:text-slate-900"}`}
                    onClick={() => {
                      setMarket(tab.value);
                      setError("");
                      setFinancialError("");
                      setFinancialInfo(null);
                      if (tab.value === "us") {
                        setMarketCodes((prev) => ({ ...prev, us: prev.us || "MSFT" }));
                        setRawRows([]);
                        setMeta({ code: marketCodes.us || "MSFT", name: "" });
                      } else if (tab.value === "agent" || tab.value === "factor-research") {
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
          <div className="flex items-center gap-2">
          {market !== "factor-research" && market !== "agent" && <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
            <div className="relative col-span-2 flex items-center gap-2 rounded-xl border bg-white px-3 py-2 md:w-56">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                value={currentCode}
                onChange={(e) => {
                  const value = market === "ashare" ? e.target.value.slice(0, 30) : normalizeCodeForMarket(e.target.value, market);
                  setMarketCodes((prev) => ({ ...prev, [market]: value }));
                  if (market === "ashare") setAshareSuggestOpen(Boolean(e.target.value.trim()));
                }}
                onFocus={() => {
                  if (market === "ashare") setAshareSuggestFocused(true);
                  if (market === "ashare" && ashareSuggestions.length) setAshareSuggestOpen(true);
                }}
                onBlur={() => {
                  if (market === "ashare") {
                    window.setTimeout(() => {
                      setAshareSuggestFocused(false);
                      setAshareSuggestOpen(false);
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
                  if (e.key === "Enter" && market !== "agent" && market !== "factor-research") {
                    load(e.currentTarget.value);
                  }
                }}
                placeholder={market === "ashare" ? "代码 / 简称 / 拼音首字母" : market === "us" ? "如 AAPL" : market === "agent" ? "Agent 功能待接入" : "因子研究页暂不支持代码查询"}
                disabled={market === "agent" || market === "factor-research"}
                className="w-full bg-transparent outline-none disabled:cursor-not-allowed disabled:text-slate-400"
              />
              {market === "ashare" && (ashareSuggestOpen || ashareSuggestLoading) && (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                  {ashareSuggestLoading && !ashareSuggestions.length ? (
                    <div className="px-3 py-2 text-sm text-slate-500">搜索中...</div>
                  ) : (
                    ashareSuggestions.map((item, index) => {
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
                    })
                  )}
                </div>
              )}
            </div>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} disabled={market === "agent" || market === "factor-research"} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              {PERIOD_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <select value={adjust} onChange={(e) => setAdjust(e.target.value)} disabled={market === "agent" || market === "factor-research"} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              {ADJUST_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <select value={displayCount} onChange={(e) => setDisplayCount(Number(e.target.value))} disabled={market === "agent" || market === "factor-research"} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              <option value={30}>近30根</option>
              <option value={45}>近45根</option>
              <option value={60}>近60根</option>
              <option value={80}>近80根</option>
              <option value={120}>近120根</option>
              <option value={180}>近180根</option>
              <option value={240}>近240根</option>
            </select>
            <select value={tdMode} onChange={(e) => setTdMode(e.target.value)} disabled={market === "agent" || market === "factor-research"} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              <option value="current">只显示当前九转</option>
              <option value="full">显示全部1~9转</option>
              <option value="ths">同花顺显示逻辑</option>
              <option value="simple">简化连续计数</option>
            </select>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={showGaps} disabled={market === "agent" || market === "factor-research"} onChange={(e) => setShowGaps(e.target.checked)} />
              断层
            </label>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={unfilledOnly} disabled={market === "agent" || market === "factor-research"} onChange={(e) => setUnfilledOnly(e.target.checked)} />
              未回补
            </label>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={showWaves} disabled={market === "agent" || market === "factor-research"} onChange={(e) => setShowWaves(e.target.checked)} />
              波浪
            </label>
            <select value={waveSensitivity} onChange={(e) => setWaveSensitivity(e.target.value)} disabled={market === "agent" || market === "factor-research"} className="rounded-xl border bg-white px-3 py-2 outline-none disabled:cursor-not-allowed disabled:text-slate-400">
              {WAVE_SENSITIVITY_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <Button onClick={() => load()} disabled={loading || market === "agent" || market === "factor-research"} className="rounded-xl">
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "加载中" : "查询"}
            </Button>
          </div>}
          {onLogout && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowProfileMenu((v) => !v)}
                onBlur={() => setTimeout(() => setShowProfileMenu(false), 150)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
              >
                <UserRound className="h-4 w-4" />
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 z-20 w-32 rounded-xl border border-slate-100 bg-white py-1 shadow-md">
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

        {market !== "agent" && market !== "factor-research" ? (
          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
            <Card className="rounded-2xl">
              <CardContent className="p-4">
                <div className="text-sm text-slate-500">当前标的</div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="text-2xl font-semibold">{meta.name || "-"}</div>
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
                <div className="text-sm text-slate-500">{meta.code || currentCode}</div>
                {latest && (
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span>日期</span>
                      <span>{latest.date}{latest.isIntradayEstimate ? " 盘中" : ""}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>收盘</span>
                      <span className={`font-semibold ${latestColor}`}>{latest.close.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>涨跌幅</span>
                      <span className={latest.pct >= 0 ? "text-red-600" : "text-green-700"}>
                        {Number.isFinite(latest.pct) ? latest.pct.toFixed(2) : "-"}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>成交量</span>
                      <span>{formatNumber(latest.volume)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>总市值</span>
                      <span>{formatNumber(meta.marketCap)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>流通市值</span>
                      <span>{formatNumber(meta.floatMarketCap)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>市盈</span>
                      <span>{Number.isFinite(meta.peRatio) ? meta.peRatio.toFixed(2) : "-"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>换手率</span>
                      <span>{Number.isFinite(meta.turnoverRate) ? `${meta.turnoverRate.toFixed(2)}%` : "-"}</span>
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
                  <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="text-lg font-semibold">{meta.code ? `${meta.code} ${meta.name}` : market === "us" ? "美股 K线图" : "K线图"}</div>
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
                      <div className="text-xs text-slate-500">
                        九转规则：上涨结构 close[i] &gt; close[i-4]；下跌结构 close[i] &lt; close[i-4]。当前默认只显示最新正在形成的九转；可切换为全部1~9转或同花顺显示逻辑。
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <div className="hidden items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 md:flex">
                        <TrendingUp className="h-3.5 w-3.5" />
                        绿字=上涨九结构；红字=下跌九结构
                      </div>
                      <ChartToolbar
                        showWaves={showWaves}
                        onToggleWaves={() => setShowWaves((value) => !value)}
                        drawingTool={drawingTool}
                        onSelectDrawingTool={handleSelectDrawingTool}
                        onUndoDrawing={undoLastDrawing}
                        onClearDrawings={clearDrawings}
                        hasDrawings={drawnLines.length > 0}
                        fullscreen={chartFullscreen}
                        onToggleFullscreen={() => setChartFullscreen((value) => !value)}
                        chartZoom={chartZoom}
                        setChartZoom={setChartZoom}
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
                      zoom={chartZoom}
                      waveAnalysis={waveAnalysis}
                      showWaveOverlay={showWaves}
                      drawingTool={drawingTool}
                      drawnLines={drawnLines}
                      onDrawnLinesChange={setDrawnLines}
                    />
                  ) : (
                    <div className="rounded-2xl bg-slate-100 p-12 text-center text-slate-500">暂无数据</div>
                  )}
                  </CardContent>
                </Card>
                <FinancialReportPanel
                  financialInfo={financialInfo}
                  loading={financialLoading}
                  error={financialError}
                  market={market}
                />
              </div>
            </div>
            <WatchlistPanel
              market={market}
              inputValue={watchlistInput}
              items={watchlistItems}
              activeCode={meta.code || currentCode}
              loading={watchlistLoadingState}
              error={watchlistErrorState}
              style={watchlistStyle}
              recommendationFactor={recommendationFactor}
              recommendationTd={recommendationTd}
              recommendationDate={recommendationDate}
              recommendationTdDate={recommendationTdDate}
              recommendationMacd={recommendationMacd}
              recommendationSafety={recommendationSafety}
              favoriteCodeSet={favoriteCodeSet}
              favoritePendingCodeSet={favoritePendingCodeSet}
              onInputChange={(value) => setWatchlistInputMap((prev) => ({ ...prev, [market]: value }))}
              onRefresh={() => (watchlistStyle === "rows" ? loadRecommendations() : loadWatchlist())}
              onStyleChange={setWatchlistStyle}
              onRecommendationFactorChange={(value) => {
                setRecommendationFactorMap((prev) => ({ ...prev, [market]: value }));
                setRecommendationItemsMap((prev) => ({ ...prev, [market]: [] }));
              }}
              onRecommendationTdChange={(value) => {
                setRecommendationTdMap((prev) => ({ ...prev, [market]: value }));
              }}
              onRecommendationTdDateChange={(value) => {
                setRecommendationTdDateMap((prev) => ({ ...prev, [market]: value }));
              }}
              onRecommendationMacdChange={(value) => {
                setRecommendationMacdMap((prev) => ({ ...prev, [market]: value }));
              }}
              onRecommendationSafetyChange={(value) => {
                setRecommendationSafetyMap((prev) => ({ ...prev, [market]: value }));
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
                  if (market !== "agent" && market !== "factor-research") load(code);
                }, 0);
              }}
              onToggleFavorite={(item) => {
                toggleFavorite(item, market);
              }}
            />
          </div>
        ) : market === "agent" ? (
          <AgentChatPanel marketCodes={marketCodes} />
        ) : (
          <FactorResearchPageLayout />
        )}
        {market !== "agent" && market !== "factor-research" && (
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
        {chartFullscreen && market !== "agent" && market !== "factor-research" && rows.length > 0 && (
          <div className="fixed inset-0 z-50 bg-slate-950/40 p-3 backdrop-blur-sm md:p-5">
            <div className="flex h-full flex-col rounded-2xl bg-white shadow-2xl">
              <div className="flex flex-col gap-3 border-b px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-xl font-semibold">{meta.code ? `${meta.code} ${meta.name}` : market === "us" ? "美股 K线图" : "K线图"}</div>
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
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ChartToolbar
                    showWaves={showWaves}
                    onToggleWaves={() => setShowWaves((value) => !value)}
                    drawingTool={drawingTool}
                    onSelectDrawingTool={handleSelectDrawingTool}
                    onUndoDrawing={undoLastDrawing}
                    onClearDrawings={clearDrawings}
                    hasDrawings={drawnLines.length > 0}
                    fullscreen={chartFullscreen}
                    onToggleFullscreen={() => setChartFullscreen(false)}
                    chartZoom={chartZoom}
                    setChartZoom={setChartZoom}
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
                  zoom={chartZoom}
                  waveAnalysis={waveAnalysis}
                  showWaveOverlay={showWaves}
                  expanded
                  drawingTool={drawingTool}
                  drawnLines={drawnLines}
                  onDrawnLinesChange={setDrawnLines}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
