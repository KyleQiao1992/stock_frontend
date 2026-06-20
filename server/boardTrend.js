import { getRedisClient } from "./redisClient.js";

// 东方财富板块/行情通用 ut 令牌（与前端 buildEastmoneyKlineUrl 保持一致，板块 K 线必须带它）。
export const EM_UT = "fa5fd1943c7b386f172d6893dbfba10b";

export const EM_FETCH_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://data.eastmoney.com/",
};

// 与前端 emaFromValues / movingAverage / calcMACDSeries / evalTrend 完全一致，保证结论和卡片图一致。
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

function movingAverageLast(closes, n) {
  // 只需最后两根的均线，取末尾窗口即可。
  function avgAt(i) {
    const start = Math.max(0, i - n + 1);
    let sum = 0;
    for (let j = start; j <= i; j += 1) sum += closes[j];
    return sum / (i - start + 1);
  }
  const i = closes.length - 1;
  return { now: avgAt(i), prev: avgAt(i - 1) };
}

function evalTrend(rows, maPeriod) {
  const safe = Array.isArray(rows) ? rows.filter((r) => r && Number.isFinite(r.close)) : [];
  if (safe.length < maPeriod + 2) return null;
  const closes = safe.map((r) => r.close);
  const { now: maNow, prev: maPrev } = movingAverageLast(closes, maPeriod);
  const ema12 = emaFromValues(closes, 12);
  const ema26 = emaFromValues(closes, 26);
  const dif = closes.map((_, i) =>
    Number.isFinite(ema12[i]) && Number.isFinite(ema26[i]) ? ema12[i] - ema26[i] : null,
  );
  const i = safe.length - 1;
  const difNow = dif[i];
  const close = safe[i].close;
  if (![close, maNow, maPrev, difNow].every(Number.isFinite)) return null;
  const c1 = close > maNow;
  const c2 = maNow > maPrev;
  const c3 = difNow > 0;
  return { c1, c2, c3, isBull: c1 && c2 && c3 };
}

// 板块代码归一：东财有时返回 "1036"，有时返回 "BK1036"。统一成 BKxxxx。
function normalizeBoardCode(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "";
  if (/^BK\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `BK${s}`;
  return "";
}

// 拉全部概念板块列表（按主力净流入 f62 降序）。多个 host 兜底。
export async function fetchConceptBoardList() {
  // push2delay 是东财「延时行情」host：在实时 push2 被墙/限流的网络里它仍可达，优先用它。
  const hosts = [
    "https://push2delay.eastmoney.com",
    "https://push2.eastmoney.com",
    "https://1.push2.eastmoney.com",
    "https://82.push2.eastmoney.com",
  ];
  // fs 用字面量 m:90+t:3（概念板块）。+ 不做百分号编码，部分网关对此敏感。
  // 注意：clist 单页最多返回 100 条（无视 pz），概念板块约 490+ 个，必须翻页。
  const PAGE = 100;
  function pageUrl(host, pn) {
    return (
      `${host}/api/qt/clist/get?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&ut=${EM_UT}` +
      `&fid=f62&fs=m:90+t:3&fields=f12,f13,f14,f2,f3,f62`
    );
  }
  function parsePage(payload) {
    const list = payload?.data?.diff;
    const arr = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
    return arr
      .map((d) => ({
        // 板块代码可能带/不带 BK 前缀；统一补成 BKxxxx。secid 需要 90.BKxxxx。
        code: normalizeBoardCode(d.f12),
        name: String(d.f14 || "").trim(),
        price: Number(d.f2),
        pct: Number(d.f3),
        mainInflow: Number(d.f62),
      }))
      .filter((b) => b.code && b.name);
  }

  const errors = [];
  for (const host of hosts) {
    try {
      const first = await fetch(pageUrl(host, 1), { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!first.ok) {
        errors.push(`${host}: HTTP ${first.status}`);
        continue;
      }
      const firstPayload = await first.json();
      const total = Number(firstPayload?.data?.total) || 0;
      let boards = parsePage(firstPayload);
      if (!boards.length) {
        errors.push(`${host}: empty(total=${total})`);
        continue;
      }
      // 翻完剩余页（并发拉取），凑齐全部概念板块。
      const pages = Math.min(20, Math.ceil(total / PAGE)); // 上限 20 页防御异常 total。
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) => i + 2).map(async (pn) => {
            try {
              const r = await fetch(pageUrl(host, pn), { headers: EM_FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
              if (!r.ok) return [];
              return parsePage(await r.json());
            } catch {
              return [];
            }
          }),
        );
        boards = boards.concat(...rest);
      }
      // 按代码去重（翻页偶发重复）。
      const seen = new Set();
      return boards.filter((b) => (seen.has(b.code) ? false : seen.add(b.code)));
    } catch (e) {
      errors.push(`${host}: ${e?.message || e}`);
    }
  }
  throw new Error(`概念板块列表不可用：${errors.slice(-4).join("；")}`);
}

// 拉单个板块日 K（90.BKxxxx），只取计算多头结论够用的尾部窗口。
// 传入 deadline（ms 时间戳）：超过就不再换 host 重试，避免失败时每个板块拖很久。
async function fetchBoardKline(code, limit, deadline) {
  // 同样优先延时 host，它在实时 push2 被墙时仍可达；其余 his host 兜底。
  const hosts = [
    "https://push2delay.eastmoney.com",
    "https://push2his.eastmoney.com",
    "https://79.push2his.eastmoney.com",
  ];
  const url =
    `/api/qt/stock/kline/get?secid=90.${code}&ut=${EM_UT}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=0&beg=0&end=20500101&lmt=${limit}`;
  for (const host of hosts) {
    const budget = deadline - Date.now();
    if (budget <= 0) break; // 已超总预算，放弃该板块。
    try {
      const res = await fetch(`${host}${url}`, {
        headers: EM_FETCH_HEADERS,
        signal: AbortSignal.timeout(Math.min(8000, budget)),
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const klines = payload?.data?.klines;
      if (!Array.isArray(klines) || !klines.length) continue;
      return klines
        .map((line) => {
          const p = String(line).split(",");
          return { date: p[0], close: Number(p[2]), pct: Number(p[8]) };
        })
        .filter((r) => r.date && Number.isFinite(r.close));
    } catch {
      // try next host
    }
  }
  return null;
}

// 并发池：限制同时在飞的请求数，避免一次性几百个把 eastmoney 打挂。
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function loadBoardTrends({ ma, year }) {
  const t0 = Date.now();
  const boards = await fetchConceptBoardList();
  const listMs = Date.now() - t0;

  // latest：只需 ma+预热，窗口很小很快；历史年份：覆盖到该年 + 预热。
  const limit =
    year === "latest"
      ? Math.max(ma + 60, 160)
      : Math.min(6000, Math.max(300, (new Date().getFullYear() - Number(year) + 2) * 260));

  // 全局预算：拉完列表后给 K 线计算最多 ~30s，超时的板块直接标记“无数据”返回，
  // 保证接口一定在合理时间内响应，而不是几百个超时把请求挂死。
  const deadline = Date.now() + 30000;

  const rows = await mapWithConcurrency(boards, 24, async (board) => {
    if (Date.now() > deadline) return { ...board, trend: null, available: false };
    const kl = await fetchBoardKline(board.code, limit, deadline);
    if (!kl || !kl.length) return { ...board, trend: null, available: false };

    let feed = kl;
    let latest = kl[kl.length - 1];
    if (year !== "latest") {
      let lastIdx = -1;
      for (let i = 0; i < kl.length; i += 1) if (String(kl[i].date).startsWith(year)) lastIdx = i;
      if (lastIdx === -1) return { ...board, trend: null, available: false };
      feed = kl.slice(0, lastIdx + 1);
      latest = kl[lastIdx];
    }
    const trend = evalTrend(feed, ma);
    return {
      code: board.code,
      name: board.name,
      mainInflow: board.mainInflow,
      close: latest?.close ?? null,
      pct: latest?.pct ?? null,
      trend,
      available: Boolean(trend),
    };
  });

  // 多头优先，其次按主力净流入降序。
  rows.sort((a, b) => {
    const ab = a.trend?.isBull ? 1 : 0;
    const bb = b.trend?.isBull ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return (b.mainInflow || -Infinity) - (a.mainInflow || -Infinity);
  });

  const rated = rows.filter((r) => r.available).length;
  console.log(
    `[board-trend] ma=${ma} year=${year} boards=${rows.length} rated=${rated} ` +
      `listMs=${listMs} totalMs=${Date.now() - t0}`,
  );

  return { ma, year, count: rows.length, rated, boards: rows, updatedAt: new Date().toISOString() };
}

export function createBoardTrendHandler() {
  return async function boardTrendHandler(req, res) {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      const ma = Math.min(250, Math.max(5, Number(requestUrl.searchParams.get("ma")) || 60));
      const yearRaw = requestUrl.searchParams.get("year") || "latest";
      const year = /^\d{4}$/.test(yearRaw) ? yearRaw : "latest";

      const cacheKey = `board-trend:${ma}:${year}`;
      const ttl = year === "latest" ? 600 : 86400; // 最新窗口缓存 10 分钟，历史年份缓存 1 天。

      let redis = null;
      try {
        redis = await getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(cached);
          return;
        }
      } catch {
        redis = null; // Redis 不可用时退化为每次实时计算。
      }

      const payload = await loadBoardTrends({ ma, year });
      const body = JSON.stringify(payload);
      // 只缓存“足够完整”的结果（多数板块已判定）。若这次因超时大面积“无数据”，
      // 不写缓存，让下次请求重新计算，避免把降级结果钉住 10 分钟。
      const wellRated = payload.count > 0 && payload.rated >= payload.count * 0.8;
      if (redis && wellRated) {
        try {
          await redis.set(cacheKey, body, { EX: ttl });
        } catch {
          // 缓存写失败不影响返回。
        }
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(body);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: error?.message || String(error) }));
    }
  };
}
