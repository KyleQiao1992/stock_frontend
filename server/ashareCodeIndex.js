import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIST_PATH = path.resolve(__dirname, "./data/ashare-list.json");

// 后台从新浪刷新全量列表的间隔。静态快照保证启动即可用，刷新只为补新股/改名。
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SINA_PAGE_SIZE = 100;
const SINA_MAX_PAGES = 80; // 5500 余只，留足余量

// 沪/深/京 A 股的市场标签，按代码段粗分（仅用于下拉里的展示文案）。
function marketLabel(code) {
  if (/^(60|68|9)/.test(code)) return "沪A";
  if (/^(00|30|2)/.test(code)) return "深A";
  if (/^(8|4|920)/.test(code)) return "京A";
  return "A股";
}

function buildEntry(code, name) {
  const full = pinyin(name, { toneType: "none", type: "array", nonZh: "consecutive" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const initials = pinyin(name, { pattern: "first", toneType: "none", type: "array", nonZh: "consecutive" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return {
    code,
    name,
    market: marketLabel(code),
    pinyin: initials.toUpperCase(), // 下拉右侧展示用，沿用东方财富的首字母风格
    _full: full,
    _initials: initials,
  };
}

let index = []; // buildEntry 结果数组
let ready = false;

function setIndex(list) {
  const next = [];
  const seen = new Set();
  for (const item of list) {
    const code = String(item?.code || "").trim();
    const name = String(item?.name || "").trim();
    if (!/^\d{6}$/.test(code) || !name) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    next.push(buildEntry(code, name));
  }
  index = next;
  ready = next.length > 0;
}

async function loadStaticSnapshot() {
  try {
    const raw = await readFile(LIST_PATH, "utf-8");
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length) {
      setIndex(list);
      console.log(`[ashareCodeIndex] loaded ${index.length} stocks from snapshot`);
    }
  } catch (error) {
    console.warn("[ashareCodeIndex] failed to load snapshot:", error?.message || error);
  }
}

async function fetchSinaPage(page) {
  const url =
    "http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
    `?page=${page}&num=${SINA_PAGE_SIZE}&sort=symbol&asc=1&node=hs_a`;
  const res = await fetch(url, {
    headers: {
      Referer: "https://finance.sina.com.cn/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!res.ok) throw new Error(`Sina list HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// 后台刷新：失败不影响已加载的静态快照。
async function refreshFromSina() {
  try {
    const collected = new Map();
    for (let page = 1; page <= SINA_MAX_PAGES; page += 1) {
      const rows = await fetchSinaPage(page);
      if (!rows.length) break;
      for (const x of rows) {
        const code = String(x?.code || "").trim();
        const name = String(x?.name || "").trim();
        if (/^\d{6}$/.test(code) && name) collected.set(code, name);
      }
      if (rows.length < SINA_PAGE_SIZE) break;
    }
    if (collected.size > 0) {
      setIndex(Array.from(collected, ([code, name]) => ({ code, name })));
      console.log(`[ashareCodeIndex] refreshed ${index.length} stocks from Sina`);
    }
  } catch (error) {
    console.warn("[ashareCodeIndex] Sina refresh failed:", error?.message || error);
  }
}

let initPromise = null;
export function initAshareCodeIndex() {
  if (!initPromise) {
    initPromise = loadStaticSnapshot().then(() => {
      // 启动后异步刷新一次，再定时刷新。
      refreshFromSina();
      setInterval(refreshFromSina, REFRESH_INTERVAL_MS).unref?.();
    });
  }
  return initPromise;
}

function stripped(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

// 返回命中分数，0 表示不匹配。分数越高越靠前。
function scoreEntry(entry, kw, kwAlnum) {
  const { code, name, _full, _initials } = entry;
  if (/^\d+$/.test(kw)) {
    if (code === kw) return 1000;
    if (code.startsWith(kw)) return 900;
    if (code.includes(kw)) return 700;
    return 0;
  }
  if (name === kw) return 980;
  if (name.includes(kw)) return 820;
  if (!kwAlnum) return 0; // 纯中文/符号输入，没有可比的拼音串，避免 startsWith("") 误命中全表
  if (_initials === kwAlnum) return 880;
  if (_full === kwAlnum) return 860;
  if (_initials.startsWith(kwAlnum)) return 780;
  if (_full.startsWith(kwAlnum)) return 760;
  if (_full.includes(kwAlnum)) return 600;
  if (_initials.includes(kwAlnum)) return 540;
  return 0;
}

export function searchLocal(keyword, limit = 10) {
  if (!ready) return [];
  const kw = stripped(keyword);
  if (!kw) return [];
  const kwAlnum = kw.replace(/[^a-z0-9]/g, "");
  const scored = [];
  for (const entry of index) {
    const score = scoreEntry(entry, kw, kwAlnum);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code));
  return scored.slice(0, limit).map(({ entry }) => ({
    code: entry.code,
    name: entry.name,
    quoteId: "",
    market: entry.market,
    pinyin: entry.pinyin,
  }));
}

export function isCodeIndexReady() {
  return ready;
}
