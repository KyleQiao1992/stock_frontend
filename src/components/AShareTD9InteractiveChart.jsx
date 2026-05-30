import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Info,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
        marketCap: extractTencentMarketCap(res, code),
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
        marketCap: extractTencentMarketCap(res, code),
        klines,
        sourceInfo: `Tencent fetch, lmt=${currentLimit}`,
      };
    } catch (e) {
      errors.push(`fetch lmt=${currentLimit}: ${e?.message || e}`);
    }
  }

  throw new Error(`腾讯行情也失败：${errors.slice(-2).join("；")}`);
}

function extractTencentMarketCap(res, code) {
  const symbol = toTencentSymbol(code);
  const node = res?.data?.[symbol] || res?.data?.[code] || res?.[symbol] || res?.[code];
  const qt = node?.qt?.[symbol] || node?.qt?.[code];
  if (!Array.isArray(qt)) return null;

  const numeric = qt.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 1);
  const possibleYi = numeric.filter((v) => v > 10 && v < 1000000);
  if (!possibleYi.length) return null;
  const candidate = possibleYi[possibleYi.length - 1];
  return candidate * 100000000;
}

function normalizeRowsForKronos(rows, maxBars = 512) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(-maxBars)
    .map((r) => ({
      date: r.date,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume || 0),
      amount: Number(r.amount || 0),
    }))
    .filter((r) => r.date && [r.open, r.high, r.low, r.close].every(Number.isFinite));
}

function buildKronosPreviewForecast({ code, name, rows, model = "Kronos-base", prediction }) {
  const latest = rows?.[rows.length - 1];
  const close = latest?.close || 0;
  const score = prediction?.ready ? prediction.score : 50;
  const bias = (score - 50) / 100;
  const volatility = (() => {
    if (!Array.isArray(rows) || rows.length < 20) return 0.03;
    const recent = rows.slice(-20);
    const rets = [];
    for (let i = 1; i < recent.length; i += 1) {
      rets.push(recent[i].close / recent[i - 1].close - 1);
    }
    const avg = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
    const variance = rets.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / Math.max(1, rets.length);
    return Math.sqrt(variance);
  })();

  const return5d = bias * 0.06 + volatility * 0.3;
  const return10d = bias * 0.1 + volatility * 0.45;
  const return20d = bias * 0.16 + volatility * 0.65;
  const direction = return20d > 0.015 ? "bullish" : return20d < -0.015 ? "bearish" : "neutral";
  const confidence = Math.max(0.35, Math.min(0.78, 0.5 + Math.abs(score - 50) / 100));

  return {
    symbol: code,
    name,
    model,
    mode: "frontend-preview",
    inputBars: normalizeRowsForKronos(rows, 512).length,
    summary: {
      return5d,
      return10d,
      return20d,
      direction,
      confidence,
    },
    agreement: "前端模拟预览：基于趋势分与近期波动生成，不是真实 Kronos-base 模型输出。",
    forecast: [
      { step: 5, predictedClose: close * (1 + return5d), predictedReturn: return5d },
      { step: 10, predictedClose: close * (1 + return10d), predictedReturn: return10d },
      { step: 20, predictedClose: close * (1 + return20d), predictedReturn: return20d },
    ],
    risk: {
      note: "This is a frontend preview fallback, not real Kronos inference.",
    },
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

function completedTD9Cycles(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 10) return [];
  const rows = calcSimpleTD9(rawRows);
  const cycles = [];

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].tdUp === 9 || rows[i].tdDown === 9) {
      const isUp = rows[i].tdUp === 9;
      const startIndex = Math.max(0, i - 8);
      const turns = [];
      for (let j = startIndex; j <= i; j += 1) {
        turns.push({
          turn: j - startIndex + 1,
          index: j,
          date: rows[j]?.date || "-",
          open: rows[j]?.open,
          close: rows[j]?.close,
        });
      }
      cycles.push({
        type: isUp ? "up" : "down",
        label: isUp ? "上涨9转周期" : "下跌9转周期",
        startIndex,
        endIndex: i,
        startDate: rows[startIndex]?.date || "-",
        endDate: rows[i]?.date || "-",
        turns,
      });
    }
  }

  return cycles.reverse();
}

function bestComboForSingleCycle(cycle) {
  if (!cycle || !Array.isArray(cycle.turns) || cycle.turns.length < 9) return null;
  const candidates = [];
  for (let buyTurn = 1; buyTurn <= 8; buyTurn += 1) {
    for (let sellTurn = buyTurn + 1; sellTurn <= 9; sellTurn += 1) {
      const buy = cycle.turns.find((t) => t.turn === buyTurn);
      const sell = cycle.turns.find((t) => t.turn === sellTurn);
      if (!buy || !sell || !Number.isFinite(buy.close) || !Number.isFinite(sell.close)) continue;
      candidates.push({
        buyTurn,
        sellTurn,
        buyClose: buy.close,
        sellClose: sell.close,
        ret: sell.close / buy.close - 1,
      });
    }
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.ret - a.ret)[0];
}

function turnReturnsFromFirst(cycle) {
  if (!cycle || !Array.isArray(cycle.turns) || cycle.turns.length < 1) return [];
  const first = cycle.turns.find((t) => t.turn === 1);
  const baseClose = first?.close;
  if (!Number.isFinite(baseClose) || baseClose === 0) return [];
  return cycle.turns.map((t) => ({
    turn: t.turn,
    ret: Number.isFinite(t.close) ? t.close / baseClose - 1 : null,
  }));
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

      <div className="mt-3 space-y-2 text-xs">
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
            MACD
            <InfoTip text="MACD 使用 EMA12 与 EMA26 计算 DIF，再对 DIF 做 EMA9 得到 DEA。现在会识别水下金叉/水上金叉/零轴附近金叉，以及水下死叉/水上死叉。水下金叉表示 DIF 在0轴下方上穿 DEA，偏短线反弹；水上金叉更偏强势上涨确认。" />
          </div>
          <div className="mt-1 text-slate-500">{prediction.macdText}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="inline-flex items-center">
            RSI
            <InfoTip text="RSI14 统计最近 14 根 K 线的平均上涨幅度和平均下跌幅度。RSI 高于 70-75 通常表示短线过热，低于 30-40 通常表示短线超跌。" />
          </div>
          <div className="mt-1 text-slate-500">{prediction.rsiText}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="inline-flex items-center">
            KDJ
            <InfoTip text="KDJ9 先计算 RSV，再平滑得到 K、D，并用 J=3K-2D 表示更敏感的动能。K 上穿 D 偏多，K 下穿 D 偏空；K/D 高于 80 偏过热，低于 20 偏超跌。" />
          </div>
          <div className="mt-1 text-slate-500">{prediction.kdjText}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="inline-flex items-center">
            布林带
            <InfoTip text="BOLL20 使用最近 20 根收盘价均值作为中轨，上下轨为中轨加减 2 倍标准差。价格在中轨上方偏强，突破上轨可能表示强势但也可能短线过热；跌破下轨可能表示超跌。" />
          </div>
          <div className="mt-1 text-slate-500">{prediction.bollText}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="inline-flex items-center">
            ATR
            <InfoTip text="ATR14 衡量最近 14 根 K 线的真实波动范围，考虑最高最低价以及与前收盘价的跳空。ATR 占价格比例越高，说明波动和风险越大。" />
          </div>
          <div className="mt-1 text-slate-500">{prediction.atrText}</div>
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
    </div>
  );
}

function kronosReturnText(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function KronosForecastPanel({ forecast, loading, error, model, horizon, onModelChange, onHorizonChange, onRun }) {
  const summary = forecast?.summary || null;
  const direction = summary?.direction || "-";
  const directionClass =
    direction === "bullish" ? "text-red-600" : direction === "bearish" ? "text-green-700" : "text-slate-700";

  return (
    <div className="mt-5 border-t pt-4">
      <div className="mb-2 flex items-center text-sm font-semibold text-slate-700">
        AI Forecast
        <InfoTip text="当前版本在页面内直接运行，不需要你部署后端。它不是直接运行真实 Kronos-base PyTorch 模型，而是使用当前已有的趋势分、技术指标、九转、断层和近期波动生成本地预测结果。Kronos-base 可作为后续真实后端模型接入方向。" />
      </div>

      <div className="space-y-2 rounded-2xl bg-slate-50 p-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <select value={model} onChange={(e) => onModelChange(e.target.value)} className="rounded-xl border bg-white px-2 py-1 outline-none">
            <option value="Local-AI-mini">Local-AI-mini</option>
            <option value="Local-AI-small">Local-AI-small</option>
            <option value="Local-AI-base">Local-AI-base</option>
            <option value="Kronos-base-ready">Kronos-base-ready</option>
          </select>
          <select value={horizon} onChange={(e) => onHorizonChange(Number(e.target.value))} className="rounded-xl border bg-white px-2 py-1 outline-none">
            <option value={5}>预测5日</option>
            <option value={10}>预测10日</option>
            <option value={20}>预测20日</option>
          </select>
        </div>

        <Button onClick={onRun} disabled={loading} className="w-full rounded-xl">
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "预测中" : "运行 AI 预测"}
        </Button>

        {error && <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-amber-700">{error}</div>}

        {!forecast && !error && (
          <div className="rounded-xl bg-white p-2 text-slate-500">
            这个版本可以直接运行，不需要你配置前端或后端。点击“运行 AI 预测”即可基于当前股票数据生成预测结果。
          </div>
        )}

        {forecast && (
          <div className="space-y-2 rounded-xl bg-white p-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-slate-600">
              当前为页面内本地预测结果，可直接使用；不是外部 Kronos-base PyTorch 模型的真实推理结果。
            </div>
            <div className="flex justify-between">
              <span>模型模式</span>
              <span>{forecast.model || model}</span>
            </div>
            <div className="flex justify-between">
              <span>输入K线</span>
              <span>{forecast.inputBars || "-"} 根</span>
            </div>
            <div className="flex justify-between">
              <span>预测方向</span>
              <span className={`font-semibold ${directionClass}`}>{direction}</span>
            </div>
            <div className="flex justify-between">
              <span>置信度</span>
              <span>{Number.isFinite(summary?.confidence) ? percentText(summary.confidence) : "-"}</span>
            </div>
            <div className="flex justify-between">
              <span>预测5日</span>
              <span>{kronosReturnText(summary?.return5d)}</span>
            </div>
            <div className="flex justify-between">
              <span>预测10日</span>
              <span>{kronosReturnText(summary?.return10d)}</span>
            </div>
            <div className="flex justify-between">
              <span>预测20日</span>
              <span>{kronosReturnText(summary?.return20d)}</span>
            </div>
            {forecast?.agreement && <div className="text-slate-500">说明：{forecast.agreement}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function buildTrendChecklist(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 80) {
    return { ready: false, items: [], summary: "历史数据不足" };
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
  const isNear20High = latest.close >= prev20High * 0.97;

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
      neutral: !isNew20High && isNear20High,
      status: isNew20High ? "是" : isNear20High ? "接近" : "否",
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
      status: latestGap ? (latestGap.type === "up" ? "向上未回补" : "向下未回补") : "暂无",
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
      reason: "多数趋势条件偏强，均线/动能/量价等信号更支持上涨方向。",
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
      reason: "趋势略偏强但还不够一致，更适合持有观察，不宜盲目追高。",
    };
  } else if (negative >= 3) {
    tradeAction = {
      label: "建议继续持有",
      colorClass: "text-blue-700",
      bgClass: "bg-blue-50 border-blue-100",
      reason: "趋势略偏弱但未形成强卖出条件，适合降低预期并继续观察。",
    };
  }

  return { ready: true, items, summary, positive, negative, tradeAction };
}

function calcADXState(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period * 2) return { ready: false, text: "样本不足", direction: "neutral" };

  const trs = [];
  const plusDMs = [];
  const minusDMs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  function avgLast(arr) {
    const part = arr.slice(-period);
    return part.reduce((a, b) => a + b, 0) / Math.max(1, part.length);
  }

  const atr = avgLast(trs);
  if (!Number.isFinite(atr) || atr === 0) return { ready: false, text: "样本不足", direction: "neutral" };
  const plusDI = (100 * avgLast(plusDMs)) / atr;
  const minusDI = (100 * avgLast(minusDMs)) / atr;
  const diSum = plusDI + minusDI;
  const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;

  let strength = "弱";
  if (dx >= 35) strength = "强";
  else if (dx >= 20) strength = "中";

  const direction = plusDI > minusDI ? "up" : minusDI > plusDI ? "down" : "neutral";
  return {
    ready: true,
    direction,
    value: dx,
    strength,
    plusDI,
    minusDI,
    text: `DMI ${direction === "up" ? "+DI > -DI" : direction === "down" ? "-DI > +DI" : "DI接近"}；强度 ${strength}，ADX≈${latestValid(dx, 1)}`,
  };
}

function calcPriceStructureState(rows) {
  if (!Array.isArray(rows) || rows.length < 45) return { ready: false, text: "样本不足", state: "unknown" };
  const recent = rows.slice(-20);
  const previous = rows.slice(-40, -20);
  const recentHigh = Math.max(...recent.map((r) => r.high));
  const recentLow = Math.min(...recent.map((r) => r.low));
  const prevHigh = Math.max(...previous.map((r) => r.high));
  const prevLow = Math.min(...previous.map((r) => r.low));

  if (recentHigh > prevHigh && recentLow > prevLow) {
    return { ready: true, state: "hhhl", text: `HH/HL：近20日高点 ${latestValid(recentHigh)} > 前20日高点 ${latestValid(prevHigh)}，低点也抬高` };
  }
  if (recentHigh < prevHigh && recentLow < prevLow) {
    return { ready: true, state: "lhll", text: `LH/LL：近20日高点 ${latestValid(recentHigh)} < 前20日高点 ${latestValid(prevHigh)}，低点也降低` };
  }
  return { ready: true, state: "mixed", text: `结构震荡：近20日高点 ${latestValid(recentHigh)} / 低点 ${latestValid(recentLow)}，尚未形成清晰 HH/HL 或 LH/LL` };
}

function buildTrendRegime(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 90) {
    return { ready: false, direction: "未知", strength: "-", quality: "样本不足", score: 50, reasons: ["历史K线不足，无法判断趋势状态。"] };
  }

  const i = rawRows.length - 1;
  const latest = rawRows[i];
  const ma5 = calcMAValue(rawRows, i, 5);
  const ma10 = calcMAValue(rawRows, i, 10);
  const ma20 = calcMAValue(rawRows, i, 20);
  const ma60 = calcMAValue(rawRows, i, 60);
  const ma20Prev = calcMAValue(rawRows, i - 5, 20);
  const ma60Prev = calcMAValue(rawRows, i - 5, 60);
  const macd = calcMACDState(rawRows);
  const kdj = calcKDJState(rawRows);
  const volumePrice = calcVolumePriceState(rawRows);
  const adx = calcADXState(rawRows);
  const structure = calcPriceStructureState(rawRows);

  let upScore = 0;
  let downScore = 0;
  const reasons = [];

  if (latest.close > ma20) {
    upScore += 2;
    reasons.push("价格站上MA20");
  } else {
    downScore += 2;
    reasons.push("价格低于MA20");
  }
  if (ma20 > ma60) {
    upScore += 2;
    reasons.push("MA20高于MA60");
  } else {
    downScore += 2;
    reasons.push("MA20低于MA60");
  }
  if (ma20 > ma20Prev && ma60 > ma60Prev) {
    upScore += 2;
    reasons.push("MA20/MA60同步向上");
  }
  if (ma20 < ma20Prev && ma60 < ma60Prev) {
    downScore += 2;
    reasons.push("MA20/MA60同步向下");
  }
  if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) {
    upScore += 3;
    reasons.push("均线多头排列");
  }
  if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) {
    downScore += 3;
    reasons.push("均线空头排列");
  }
  if (structure.state === "hhhl") {
    upScore += 2;
    reasons.push("价格结构 HH/HL");
  }
  if (structure.state === "lhll") {
    downScore += 2;
    reasons.push("价格结构 LH/LL");
  }
  if (macd.state === "bull" || macd.state === "weakBull") {
    upScore += 1;
    reasons.push("MACD偏多");
  }
  if (macd.state === "nearGolden") {
    upScore += 1;
    reasons.push("MACD临近金叉");
  }
  if (macd.state === "bear" || macd.state === "weakBear") {
    downScore += 1;
    reasons.push("MACD偏空");
  }
  if (macd.state === "nearDeath") {
    downScore += 1;
    reasons.push("MACD临近死叉");
  }
  if (kdj.state === "golden" || kdj.state === "bull") {
    upScore += 1;
    reasons.push("KDJ偏多");
  }
  if (kdj.state === "death" || kdj.state === "bear") {
    downScore += 1;
    reasons.push("KDJ偏空");
  }
  if (volumePrice.state === "confirmUp") {
    upScore += 1;
    reasons.push("上涨放量确认");
  }
  if (volumePrice.state === "confirmDown") {
    downScore += 1;
    reasons.push("下跌放量确认");
  }
  if (adx.direction === "up") upScore += 1;
  if (adx.direction === "down") downScore += 1;

  const diff = upScore - downScore;
  let direction = "震荡趋势";
  let directionClass = "text-slate-700";
  let bgClass = "bg-slate-50 border-slate-100";
  if (diff >= 4) {
    direction = "上升趋势";
    directionClass = "text-red-600";
    bgClass = "bg-red-50 border-red-100";
  } else if (diff <= -4) {
    direction = "下跌趋势";
    directionClass = "text-green-700";
    bgClass = "bg-green-50 border-green-100";
  }

  const rawStrength = Math.abs(diff) + (adx.ready ? Math.min(4, Math.round(adx.value / 10)) : 0);
  let strength = "弱";
  if (rawStrength >= 8) strength = "强";
  else if (rawStrength >= 4) strength = "中";

  let quality = "一般";
  if (direction === "上升趋势" && (volumePrice.state === "weakUp" || calcRSIState(rawRows).state === "overbought")) quality = "偏过热/有背离";
  else if (direction === "下跌趋势" && calcRSIState(rawRows).state === "oversold") quality = "超跌但仍需确认";
  else if (direction !== "震荡趋势" && strength !== "弱") quality = "较健康";
  else if (direction === "震荡趋势") quality = "方向不清晰";

  const score = Math.max(0, Math.min(100, Math.round(50 + diff * 4)));
  return {
    ready: true,
    direction,
    directionClass,
    bgClass,
    strength,
    quality,
    score,
    upScore,
    downScore,
    reasons: reasons.slice(0, 5),
    maText: `MA5 ${latestValid(ma5)} / MA10 ${latestValid(ma10)} / MA20 ${latestValid(ma20)} / MA60 ${latestValid(ma60)}`,
    macdText: macd.text,
    macdPattern: macd.pattern,
    macdState: macd.state,
    structureText: structure.text,
    adxText: adx.text,
  };
}

function MACDPatternVisual({ pattern, macdState }) {
  const p = String(pattern || "");

  const isUnderGolden = p.includes("水下金叉");
  const isAboveGolden = p.includes("水上金叉");
  const isNearGolden = p.includes("零轴附近金叉");
  const isUnderDeath = p.includes("水下死叉");
  const isAboveDeath = p.includes("水上死叉");
  const isNearDeath = p.includes("零轴附近死叉");

  const isGolden = isUnderGolden || isAboveGolden || isNearGolden || macdState === "bull" || macdState === "weakBull";
  const isDeath = isUnderDeath || isAboveDeath || isNearDeath || macdState === "bear" || macdState === "weakBear";
  const isAbove = isAboveGolden || isAboveDeath || p.includes("水上");
  const isUnder = isUnderGolden || isUnderDeath || p.includes("水下");

  const axisY = isAbove ? 62 : isUnder ? 28 : 45;
  const title = pattern || "MACD形态";

  let explain = "MACD 通过 DIF 与 DEA 的相对位置，以及柱体变化，帮助判断动能和趋势变化。";
  if (isUnderGolden) {
    explain = "水下金叉：DIF 上穿 DEA，但交叉发生在0轴下方。绿柱逐渐缩短，说明空头动能减弱，可能出现短线反弹；但仍处弱势区，稳定性通常不如水上金叉。";
  } else if (isAboveGolden) {
    explain = "水上金叉：DIF 上穿 DEA，且交叉发生在0轴上方。红柱逐渐放大，说明多头动能增强，通常比水下金叉更强、更稳定，偏向上涨趋势延续。";
  } else if (isNearGolden) {
    explain = "零轴附近金叉：DIF 在零轴附近上穿 DEA，说明动能可能从弱转强，需要结合价格是否站上均线和成交量确认。";
  } else if (isUnderDeath) {
    explain = "水下死叉：DIF 在0轴下方下穿 DEA，说明弱势区内空头仍占优，反弹可能结束后继续承压。";
  } else if (isAboveDeath) {
    explain = "水上死叉：DIF 在0轴上方下穿 DEA，说明强势上涨开始转弱，需要警惕回调或阶段性见顶。";
  } else if (isNearDeath) {
    explain = "零轴附近死叉：DIF 在零轴附近下穿 DEA，说明动能可能转弱，需要观察是否跌破关键均线。";
  } else if (isGolden) {
    explain = "DIF 位于 DEA 上方，短线动能偏多；若发生在0轴上方，通常更强，若发生在0轴下方，则更偏反弹。";
  } else if (isDeath) {
    explain = "DIF 位于 DEA 下方，短线动能偏空；若发生在0轴上方，可能是强势转弱，若发生在0轴下方，则偏弱势延续。";
  }

  const fastPath = isGolden
    ? isAbove
      ? "M18 48 C34 47, 46 44, 58 39 C74 30, 96 25, 120 20"
      : "M18 58 C34 56, 46 50, 58 42 C74 34, 96 28, 120 24"
    : isAbove
      ? "M18 20 C34 23, 46 28, 58 36 C74 46, 96 52, 120 56"
      : "M18 24 C34 27, 46 33, 58 42 C74 52, 96 58, 120 62";

  const slowPath = isGolden
    ? isAbove
      ? "M18 40 C34 39, 46 38, 60 36 C78 34, 98 32, 120 30"
      : "M18 47 C34 46, 46 44, 60 41 C78 38, 98 35, 120 33"
    : isAbove
      ? "M18 30 C34 31, 46 34, 60 38 C78 42, 98 45, 120 47"
      : "M18 34 C34 35, 46 38, 60 42 C78 46, 98 49, 120 51";

  const bars = isGolden ? (isAbove ? [7, 10, 13, 16, 19, 22] : [24, 21, 18, 15, 12, 9]) : isAbove ? [24, 21, 18, 15, 12, 9] : [8, 11, 14, 17, 20, 23];
  const barColor = isAbove ? "#dc2626" : "#16a34a";
  const labelColor = isGolden ? "#dc2626" : "#16a34a";
  const crossY = isGolden ? (isAbove ? 39 : 42) : isAbove ? 36 : 42;
  const label = isUnderGolden
    ? "水下金叉"
    : isAboveGolden
      ? "水上金叉"
      : isNearGolden
        ? "零轴金叉"
        : isUnderDeath
          ? "水下死叉"
          : isAboveDeath
            ? "水上死叉"
            : isNearDeath
              ? "零轴死叉"
              : isGolden
                ? "偏多"
                : isDeath
                  ? "偏空"
                  : "中性";

  return (
    <div className="mt-2 rounded-lg bg-white/80 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-slate-500">MACD示意</span>
        <span className={isGolden ? "font-semibold text-red-600" : isDeath ? "font-semibold text-green-700" : "font-semibold text-slate-700"}>{title}</span>
      </div>
      <svg viewBox="0 0 140 100" className="h-28 w-full rounded-lg bg-slate-50">
        <line x1="8" x2="132" y1={axisY} y2={axisY} stroke="#94a3b8" strokeDasharray="4 3" />
        <text x="10" y={axisY - 5} fontSize="9" fill="#64748b">0轴</text>
        {[0, 1, 2, 3, 4, 5].map((n) => {
          const x = 22 + n * 14;
          const h = bars[n];
          const y = isAbove ? axisY - h : axisY;
          return <rect key={n} x={x} y={y} width="6" height={Math.max(3, h)} fill={barColor} opacity="0.48" />;
        })}
        <path d={slowPath} fill="none" stroke="#d4af37" strokeWidth="2" />
        <path d={fastPath} fill="none" stroke="#111827" strokeWidth="2.4" />
        <circle cx="59" cy={crossY} r="5.5" fill="none" stroke={labelColor} strokeWidth="2" />
        <text x="78" y={crossY + 3} fontSize="10" fill={labelColor}>{label}</text>
        <text x="18" y="91" fontSize="9" fill="#111827">DIF</text>
        <text x="45" y="91" fontSize="9" fill="#b59f00">DEA</text>
        <text x="76" y="91" fontSize="9" fill="#64748b">柱体</text>
      </svg>
      <div className="mt-2 leading-relaxed text-slate-500">{explain}</div>
    </div>
  );
}

function TrendRegimePanel({ rawRows }) {
  const regime = useMemo(() => buildTrendRegime(rawRows), [rawRows]);
  const checklist = useMemo(() => buildTrendChecklist(rawRows), [rawRows]);

  const action = checklist?.tradeAction;
  const summaryClass = checklist?.summary?.includes("偏强")
    ? "text-red-600"
    : checklist?.summary?.includes("偏弱")
      ? "text-green-700"
      : "text-slate-700";

  return (
    <div className="mb-3 rounded-2xl border bg-white p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-700">趋势状态与交易结论</span>
        <InfoTip text="合并展示趋势状态、交易结论和趋势条件明细。趋势判断基于均线、价格结构、MACD、成交量、断层和DMI/ADX等信号。" />
      </div>

      {!regime.ready ? (
        <div className="rounded-xl bg-slate-50 p-2 text-slate-500">{regime.reasons?.[0] || "历史数据不足"}</div>
      ) : (
        <div className={`rounded-xl border p-2 ${regime.bgClass}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-600">当前趋势</span>
            <span className={`font-bold ${regime.directionClass}`}>{regime.direction}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-white/70 p-2">
              <div className="text-slate-500">强度</div>
              <div className="font-semibold text-slate-800">{regime.strength}</div>
            </div>
            <div className="rounded-lg bg-white/70 p-2">
              <div className="text-slate-500">质量</div>
              <div className="font-semibold text-slate-800">{regime.quality}</div>
            </div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-slate-200">
            <div className="h-2 rounded-full bg-slate-700" style={{ width: `${regime.score}%` }} />
          </div>
          <div className="mt-1 text-right text-slate-500">趋势状态分 {regime.score}/100</div>
          <div className="mt-2 rounded-lg bg-white/80 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">MACD形态</span>
              <span className={regime.macdState === "bull" || regime.macdState === "weakBull" || regime.macdState === "nearGolden" ? "font-semibold text-red-600" : regime.macdState === "bear" || regime.macdState === "weakBear" || regime.macdState === "nearDeath" ? "font-semibold text-green-700" : "font-semibold text-slate-700"}>{regime.macdPattern || "-"}</span>
            </div>
            <div className="mt-1 leading-relaxed text-slate-500">{regime.macdText}</div>
          </div>
          <MACDPatternVisual pattern={regime.macdPattern} macdState={regime.macdState} />
          <div className="mt-2 leading-relaxed text-slate-500">依据：{regime.reasons.join("；")}</div>
          <div className="mt-1 leading-relaxed text-slate-400">{regime.structureText}</div>
          <div className="mt-1 leading-relaxed text-slate-400">{regime.adxText}</div>
        </div>
      )}

      {checklist.ready && action && (
        <div className="mt-3 space-y-2">
          <div className={`rounded-xl border p-2 ${action.bgClass}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600">交易结论</span>
              <span className={`font-bold ${action.colorClass}`}>{action.label}</span>
            </div>
            <div className="mt-1 leading-relaxed text-slate-500">{action.reason}</div>
          </div>

          <div className={`rounded-xl bg-slate-50 p-2 font-semibold ${summaryClass}`}>{checklist.summary}</div>

          <div className="space-y-1.5">
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
        </div>
      )}
    </div>
  );
}

function TD9StatsTable({ rawRows }) {
  const [page, setPage] = useState(0);
  const [cycleFilter, setCycleFilter] = useState("all");
  const pageSize = 5;
  const cycles = useMemo(() => completedTD9Cycles(rawRows), [rawRows]);
  const filteredCycles = useMemo(() => {
    if (cycleFilter === "up") return cycles.filter((c) => c.type === "up");
    if (cycleFilter === "down") return cycles.filter((c) => c.type === "down");
    return cycles;
  }, [cycles, cycleFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredCycles.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const visibleCycles = filteredCycles.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const visibleRows = useMemo(() => visibleCycles.map((cycle) => ({ cycle, bestInThisCycle: bestComboForSingleCycle(cycle) })), [visibleCycles]);

  return (
    <div className="mt-4 rounded-2xl border bg-white p-4">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-base font-semibold text-slate-800">9转周期内买卖统计</div>
          <div className="text-xs text-slate-500">每行是一个完整 1~9 周期；第二列只展示该周期内部的最佳买卖点，不再展示历史周期胜率。</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <select value={cycleFilter} onChange={(e) => setCycleFilter(e.target.value)} className="rounded-xl border bg-white px-2 py-1 outline-none">
            <option value="all">全部9转</option>
            <option value="up">只看上涨</option>
            <option value="down">只看下跌</option>
          </select>
          <span>
            共 {filteredCycles.length} / {cycles.length} 个周期，第 {safePage + 1} / {totalPages} 页
          </span>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[920px] table-fixed text-sm">
          <thead>
            <tr className="border-b bg-slate-50 text-left text-slate-600">
              <th className="w-12 px-2 py-2">#</th>
              <th className="w-12 px-2 py-2 text-center">涨跌</th>
              <th className="w-[180px] px-2 py-2">开始日期 ~ 结束日期</th>
              <th className="w-[210px] px-2 py-2">本周期最佳买卖点</th>
              <th className="px-2 py-2">1~9转累计涨跌</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={5}>暂无完成9转周期。</td>
              </tr>
            ) : (
              visibleRows.map(({ cycle, bestInThisCycle }, idx) => {
                const originalIndex = cycles.findIndex((c) => c.endIndex === cycle.endIndex && c.type === cycle.type);
                const cycleNumber = originalIndex >= 0 ? cycles.length - originalIndex : filteredCycles.length - (safePage * pageSize + idx);
                return (
                  <tr key={`${cycle.endDate}-${idx}`} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="w-12 px-2 py-3 font-semibold text-slate-700">#{cycleNumber}</td>
                    <td className="w-12 px-2 py-3 text-center">
                      <span className={`inline-flex items-center justify-center text-lg font-bold ${cycle.type === "up" ? "text-red-600" : "text-green-700"}`} title={cycle.type === "up" ? "上涨9转周期" : "下跌9转周期"}>
                        {cycle.type === "up" ? "▲" : "▼"}
                      </span>
                    </td>
                    <td className="w-[190px] whitespace-nowrap px-2 py-3 text-xs text-slate-700">{cycle.startDate} ~ {cycle.endDate}</td>
                    <td className="w-[210px] break-words px-2 py-3 text-xs leading-relaxed text-slate-700">
                      {bestInThisCycle ? (
                        <span>
                          <span className="font-semibold text-blue-700">第{bestInThisCycle.buyTurn}转买</span>
                          <span className="mx-1">/</span>
                          <span className="font-semibold text-purple-700">第{bestInThisCycle.sellTurn}转卖</span>
                          <span className="ml-2 text-slate-500">收益 {percentText(bestInThisCycle.ret)}</span>
                          <div className="mt-1 text-[11px] text-slate-400">
                            ({latestValid(bestInThisCycle.sellClose)} - {latestValid(bestInThisCycle.buyClose)}) / {latestValid(bestInThisCycle.buyClose)} = {percentText(bestInThisCycle.ret)}
                          </div>
                        </span>
                      ) : (
                        <span className="text-slate-500">该周期数据不足，无法计算。</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-xs leading-relaxed">
                      <div className="flex flex-wrap gap-1">
                        {turnReturnsFromFirst(cycle).map((item) => (
                          <span key={`${cycle.endDate}-${item.turn}`} className={`rounded-md bg-slate-50 px-1.5 py-0.5 ${Number.isFinite(item.ret) && item.ret >= 0 ? "text-red-600" : "text-green-700"}`} title={`第${item.turn}转相对第1转收盘价的累计涨跌幅`}>
                            {item.turn}:{percentText(item.ret)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" className="rounded-xl" disabled={safePage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</Button>
        <Button variant="outline" className="rounded-xl" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>下一页</Button>
      </div>
    </div>
  );
}

function Chart({ rows, visibleGaps, showGaps, zoom = 1 }) {
  const width = Math.round(1100 * zoom);
  const height = Math.round(760 * zoom);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const scrollRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0, moved: false });

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

  const safeRows = useMemo(() => rows.filter((r) => [r.open, r.close, r.high, r.low, r.volume].every(Number.isFinite)), [rows]);

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
    const macdSeries = calcMACDSeries(safeRows);
    const macdValues = macdSeries.flatMap((m) => [m.dif, m.dea, m.hist]).filter(Number.isFinite);
    const macdAbsMax = Math.max(...macdValues.map((v) => Math.abs(v)), 0.01);
    const macdCrosses = [];
    for (let i = 1; i < macdSeries.length; i += 1) {
      const prev = macdSeries[i - 1];
      const curr = macdSeries[i];
      if (![prev?.dif, prev?.dea, curr?.dif, curr?.dea, curr?.hist].every(Number.isFinite)) continue;
      const prevDiff = prev.dif - prev.dea;
      const currDiff = curr.dif - curr.dea;
      const nearThreshold = Math.max(0.03, Math.abs(curr.dea) * 0.08, Math.abs(curr.hist) * 0.25);
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
      } else if (Math.abs(currDiff) <= nearThreshold) {
        macdCrosses.push({
          index: i,
          type: currDiff > 0 ? "golden" : "death",
          label: currDiff > 0 ? "临近金叉" : "临近死叉",
          value: (curr.dif + curr.dea) / 2,
          zone: curr.dif > 0 && curr.dea > 0 ? "water" : curr.dif < 0 && curr.dea < 0 ? "under" : "near",
        });
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
    return { margin, mainH, gap, volH, macdH, plotW, xStep, candleW, x, y, vy, volBase, macdTop, macdBase, macdY, macdAbsMax, yMax, yMin, maxVol, ma5, ma10, ma20, macdSeries, macdCrosses, gaps, makePath };
  }, [safeRows, width, height, visibleGaps]);

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

  return (
    <div
      ref={scrollRef}
      className="w-full cursor-grab overflow-x-auto rounded-2xl border bg-white p-3 shadow-sm active:cursor-grabbing"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        beginDrag(e.clientX);
      }}
      onMouseMove={(e) => moveDrag(e.clientX)}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onTouchStart={(e) => beginDrag(e.touches[0]?.clientX || 0)}
      onTouchMove={(e) => moveDrag(e.touches[0]?.clientX || 0)}
      onTouchEnd={endDrag}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: `${width}px`, height: `${height}px` }}
        className="cursor-pointer select-none"
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const scaleX = width / Math.max(rect.width, 1);
          const mouseX = (e.clientX - rect.left) * scaleX;
          const idx = Math.floor((mouseX - chart.margin.left) / chart.xStep);
          if (idx >= 0 && idx < safeRows.length) setHoverIndex(idx);
        }}
        onClick={(e) => {
          if (dragRef.current.moved) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const scaleX = width / Math.max(rect.width, 1);
          const mouseX = (e.clientX - rect.left) * scaleX;
          const idx = Math.floor((mouseX - chart.margin.left) / chart.xStep);
          if (idx >= 0 && idx < safeRows.length) setSelectedIndex(idx);
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
        <text x="18" y="39" fontSize="12" fill="#ff9900">MA5</text>
        <text x="64" y="39" fontSize="12" fill="#3366cc">MA10</text>
        <text x="116" y="39" fontSize="12" fill="#9933cc">MA20</text>

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
        {chart.macdCrosses.map((cross, idx) => {
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
    </div>
  );
}

export default function AShareTD9InteractiveChart() {
  const [code, setCode] = useState("600519");
  const [period, setPeriod] = useState("101");
  const [adjust, setAdjust] = useState("1");
  const [displayCount, setDisplayCount] = useState(120);
  const [tdMode, setTdMode] = useState("current");
  const [showGaps, setShowGaps] = useState(true);
  const [unfilledOnly, setUnfilledOnly] = useState(true);
  const [rawRows, setRawRows] = useState([]);
  const [meta, setMeta] = useState({ code: "", name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kronosModel, setKronosModel] = useState("Local-AI-base");
  const [kronosHorizon, setKronosHorizon] = useState(20);
  const [kronosLoading, setKronosLoading] = useState(false);
  const [kronosError, setKronosError] = useState("");
  const [kronosForecast, setKronosForecast] = useState(null);
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

  async function load() {
    const normalized = String(code || "").trim();
    if (!isSixDigitCode(normalized)) {
      setError("请输入 6 位 A 股代码，例如 600519、000001、300750。");
      return;
    }
    setLoading(true);
    setError("");
    setKronosError("");
    setKronosForecast(null);
    try {
      const result = await fetchAshareKline({
        code: normalized,
        period,
        adjust,
        limit: Math.max(5000, Number(displayCount) + 120),
      });
      setRawRows(result.klines);
      setMeta({
        code: result.code,
        name: result.name,
        marketCap: result.marketCap || null,
        floatMarketCap: result.floatMarketCap || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      setRawRows([]);
      setMeta({ code: normalized, name: "" });
    } finally {
      setLoading(false);
    }
  }

  async function runKronosForecast() {
    const normalized = String(code || "").trim();
    if (!isSixDigitCode(normalized)) {
      setKronosError("请输入有效的 6 位 A 股代码后再运行 AI 预测。");
      return;
    }
    if (!rawRows.length) {
      setKronosError("请先点击查询，获取当前股票 K 线数据。");
      return;
    }
    setKronosLoading(true);
    setKronosError("");
    setKronosForecast(null);

    window.setTimeout(() => {
      try {
        const preview = buildKronosPreviewForecast({
          code: normalized,
          name: meta.name,
          rows: rawRows,
          model: kronosModel,
          horizon: kronosHorizon,
          prediction,
        });
        setKronosForecast(preview);
      } catch (e) {
        setKronosError(e instanceof Error ? e.message : "AI 预测失败。");
      } finally {
        setKronosLoading(false);
      }
    }, 250);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 p-4 text-slate-900">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-2xl font-semibold">
              <BarChart3 className="h-6 w-6" />
              A股 K线
            </div>
            <p className="mt-1 text-sm text-slate-500">输入股票代码后查询。默认只显示当前正在形成的九转。</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
            <div className="col-span-2 flex items-center gap-2 rounded-xl border bg-white px-3 py-2 md:w-44">
              <Search className="h-4 w-4 text-slate-400" />
              <input value={code} onChange={(e) => setCode(onlyDigits(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") load(); }} placeholder="如 600519" className="w-full outline-none" />
            </div>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-xl border bg-white px-3 py-2 outline-none">
              {PERIOD_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <select value={adjust} onChange={(e) => setAdjust(e.target.value)} className="rounded-xl border bg-white px-3 py-2 outline-none">
              {ADJUST_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <select value={displayCount} onChange={(e) => setDisplayCount(Number(e.target.value))} className="rounded-xl border bg-white px-3 py-2 outline-none">
              <option value={30}>近30根</option>
              <option value={45}>近45根</option>
              <option value={60}>近60根</option>
              <option value={80}>近80根</option>
              <option value={120}>近120根</option>
              <option value={180}>近180根</option>
              <option value={240}>近240根</option>
            </select>
            <select value={tdMode} onChange={(e) => setTdMode(e.target.value)} className="rounded-xl border bg-white px-3 py-2 outline-none">
              <option value="current">只显示当前九转</option>
              <option value="full">显示全部1~9转</option>
              <option value="ths">同花顺显示逻辑</option>
              <option value="simple">简化连续计数</option>
            </select>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={showGaps} onChange={(e) => setShowGaps(e.target.checked)} />
              断层
            </label>
            <label className="flex items-center gap-1 rounded-xl border bg-white px-3 py-2 text-sm">
              <input type="checkbox" checked={unfilledOnly} onChange={(e) => setUnfilledOnly(e.target.checked)} />
              未回补
            </label>
            <Button onClick={load} disabled={loading} className="rounded-xl">
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "加载中" : "查询"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)]">
          <Card className="rounded-2xl self-start xl:sticky xl:top-4">
            <CardContent className="max-h-[calc(100vh-2rem)] overflow-y-auto p-4">
              <KronosForecastPanel
                forecast={kronosForecast}
                loading={kronosLoading}
                error={kronosError}
                model={kronosModel}
                horizon={kronosHorizon}
                onModelChange={setKronosModel}
                onHorizonChange={setKronosHorizon}
                onRun={runKronosForecast}
              />
              <TrendRegimePanel rawRows={rawRows} />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-4">
            <Card className="rounded-2xl md:col-span-1">
              <CardContent className="p-4">
                <div className="text-sm text-slate-500">当前标的</div>
                <div className="mt-1 text-2xl font-semibold">{meta.name || "-"}</div>
                <div className="text-sm text-slate-500">{meta.code || code}</div>
                {latest && (
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span>日期</span>
                      <span>{latest.date}</span>
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
                  </div>
                )}
                <TrendPredictionPanel prediction={prediction} />
              </CardContent>
            </Card>
            <Card className="rounded-2xl md:col-span-3">
              <CardContent className="p-4">
                <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-lg font-semibold">{meta.code ? `${meta.code} ${meta.name}` : "K线图"}</div>
                    <div className="text-xs text-slate-500">九转规则：上涨结构 close[i] &gt; close[i-4]；下跌结构 close[i] &lt; close[i-4]。当前默认只显示最新正在形成的九转；可切换为全部1~9转或同花顺显示逻辑。</div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="hidden items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 md:flex">
                      <TrendingUp className="h-3.5 w-3.5" />
                      绿字=上涨九结构；红字=下跌九结构
                    </div>
                    <div className="flex items-center gap-1 rounded-xl border bg-white p-1 text-xs text-slate-600">
                      <button type="button" className="rounded-lg px-2 py-1 hover:bg-slate-100" onClick={() => setChartZoom((z) => Math.max(0.8, Number((z - 0.1).toFixed(2))))}>缩小</button>
                      <button type="button" className="rounded-lg px-2 py-1 font-semibold text-slate-800 hover:bg-slate-100" onClick={() => setChartZoom(1)}>{Math.round(chartZoom * 100)}%</button>
                      <button type="button" className="rounded-lg px-2 py-1 hover:bg-slate-100" onClick={() => setChartZoom((z) => Math.min(1.8, Number((z + 0.1).toFixed(2))))}>放大</button>
                    </div>
                  </div>
                </div>
                {rows.length > 0 ? (
                  <>
                    <Chart rows={rows} visibleGaps={visibleGaps} showGaps={showGaps} zoom={chartZoom} />
                    <TD9StatsTable rawRows={rawRows} />
                  </>
                ) : (
                  <div className="rounded-2xl bg-slate-100 p-12 text-center text-slate-500">暂无数据</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-4 text-sm text-slate-500 shadow-sm">
          说明：这是学习/研究用图表，不构成投资建议。断层基于已拉取的完整历史 K 线计算，再映射到当前显示区间；规则按相邻 K 线高低价判断：向上断层为当日最低价高于前一根最高价，向下断层为当日最高价低于前一根最低价；默认只显示未回补断层。
        </div>
      </div>
    </div>
  );
}
