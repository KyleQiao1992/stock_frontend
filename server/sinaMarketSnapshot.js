// 新浪公开行情中心：全 A 名单/报价、同源逐股行情日期，以及明确标注的新浪行业分类。
// 行业目录是旧新浪分类，仅覆盖部分股票；缺失与冲突都保留为未分类，绝不删股票。
const API = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
const DIRECTORY = "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" };
const PAGE = 100;
const INDUSTRY_CACHE_MS = 6 * 60 * 60 * 1000;

function numeric(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveCount(value) {
  const count = numeric(value);
  if (!Number.isInteger(count) || count <= 0 || count > 20000) throw new Error("新浪全A数量无效");
  return count;
}

function aSymbol(value) {
  const symbol = String(value || "");
  return /^(?:sh(?:60|68)\d{4}|sz(?:00|30)\d{4}|bj(?:[48]\d{5}|920\d{3}))$/.test(symbol) ? symbol : null;
}

function quoteTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time || "")) return null;
  const utcDate = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(utcDate.getTime()) || utcDate.toISOString().slice(0, 10) !== date) return null;
  const ms = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;
  async function run() {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failure ||= error;
      }
    }
  }
  // 出错后停止发新任务，并等已经在飞的请求结束，避免失败重试叠加悬空并发。
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, run));
  if (failure) throw failure;
  return results;
}

export function createSinaMarketSnapshotProvider({ request = fetch, now = Date.now, budgetMs = 25000 } = {}) {
  let industryCache = null;

  return async function loadSnapshot({ withIndustries = false, signal } = {}) {
    const deadline = now() + budgetMs;
    async function response(url) {
      if (signal?.aborted) throw signal.reason || new Error("新浪快照查询已取消");
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("新浪全A快照查询超时");
      const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(8000, remaining))));
      const result = await request(url, { headers: HEADERS, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!result.ok) throw new Error(`新浪快照 HTTP ${result.status}`);
      return result;
    }
    async function nodePage(node, page) {
      const result = await response(`${API}getHQNodeData?page=${page}&num=${PAGE}&sort=symbol&asc=1&node=${encodeURIComponent(node)}`);
      const rows = await result.json();
      if (!Array.isArray(rows)) throw new Error(`新浪 ${node} 第${page}页格式无效`);
      return rows;
    }

    const expected = positiveCount(await (await response(`${API}getHQNodeStockCount?node=hs_a`)).json());
    const pageCount = Math.ceil(expected / PAGE);
    const pages = await pool(Array.from({ length: pageCount }, (_, index) => index + 1), async (page) => {
      const rows = await nodePage("hs_a", page);
      const size = Math.min(PAGE, expected - (page - 1) * PAGE);
      if (rows.length !== size) throw new Error(`新浪全A第${page}页不完整（${rows.length}/${size}）`);
      return rows;
    });
    const bySymbol = new Map();
    for (const row of pages.flat()) {
      const symbol = aSymbol(row?.symbol);
      if (!symbol || row.code !== symbol.slice(2) || !String(row.name || "").trim()) throw new Error("新浪全A股票身份无效");
      bySymbol.set(symbol, row);
    }
    if (bySymbol.size !== expected) throw new Error(`新浪全A去重后覆盖不完整（${bySymbol.size}/${expected}）`);

    // node 快照的 ticktime 没有日期。逐股 hq 字段30/31才是该报价实际日期/时间，
    // 不能用抓取日期给停牌、节假日或旧报价补日期。
    const symbols = [...bySymbol.keys()];
    const batches = Array.from({ length: Math.ceil(symbols.length / PAGE) }, (_, index) => symbols.slice(index * PAGE, (index + 1) * PAGE));
    const dates = new Map();
    await pool(batches, async (batch) => {
      const result = await response(`https://hq.sinajs.cn/list=${batch.join(",")}`);
      const text = new TextDecoder("gbk").decode(await result.arrayBuffer());
      const returned = new Set();
      for (const match of text.matchAll(/var hq_str_((?:sh|sz|bj)\d{6})="([^"]*)";/g)) {
        if (!batch.includes(match[1])) continue;
        returned.add(match[1]);
        const values = match[2].split(",");
        const parsedAt = quoteTimestamp(values[30], values[31]);
        const quoteAt = parsedAt !== null && parsedAt <= now() / 1000 + 300 ? parsedAt : null;
        dates.set(match[1], {
          quoteAt,
          date: quoteAt === null ? null : values[30],
          open: numeric(values[1]),
          previousClose: numeric(values[2]),
          close: numeric(values[3]),
          amount: numeric(values[9]),
        });
      }
      if (returned.size !== batch.length) throw new Error(`新浪行情日期批次不完整（${returned.size}/${batch.length}）`);
    });

    let mapping = null;
    if (withIndustries) {
      if (industryCache && now() - industryCache.at < INDUSTRY_CACHE_MS) mapping = industryCache.mapping;
      else {
        const result = await response(DIRECTORY);
        const text = new TextDecoder("gbk").decode(await result.arrayBuffer());
        const directories = new Map();
        for (const match of text.matchAll(/"(new_[A-Za-z0-9]+)":"[^,]+,([^,]+),(\d+),/g)) {
          if (match[1] === "new_stock") continue; // 次新股不是互斥行业。
          const count = Number(match[3]);
          if (!Number.isSafeInteger(count) || count > 20000) throw new Error("新浪行业成员数量无效");
          if (count > 0) directories.set(match[1], { code: match[1], name: match[2].trim(), count });
        }
        if (!directories.size) throw new Error("新浪行业目录无效");
        if (directories.size > 200) throw new Error("新浪行业数量超出范围");
        if ([...directories.values()].reduce((sum, item) => sum + item.count, 0) > 20000) throw new Error("新浪行业成员数量超出范围");
        // 旧行业目录/count接口的历史数量与实际成员并不一致，不能据它截断。
        // 逐页读取至源接口的短页；计数只用于输入上限，分类覆盖以实得成员为准。
        const members = await pool([...directories.values()], async (item) => {
          const all = [];
          for (let page = 1; page <= 20; page += 1) {
            const rows = await nodePage(item.code, page);
            if (!rows.length && page === 1) throw new Error(`新浪行业 ${item.code} 成员为空`);
            all.push(...rows);
            if (rows.length < PAGE) return { name: item.name, rows: all };
          }
          throw new Error(`新浪行业 ${item.code} 分页超出范围`);
        });
        if (members.reduce((sum, item) => sum + item.rows.length, 0) > 20000) throw new Error("新浪行业实际成员数量超出范围");
        const next = new Map();
        for (const member of members) {
          for (const row of member.rows) {
            const symbol = aSymbol(row?.symbol);
            if (!symbol) continue;
            const names = next.get(symbol) || new Set();
            names.add(member.name);
            next.set(symbol, names);
          }
        }
        if (!next.size) throw new Error("新浪行业成员为空");
        mapping = next;
        industryCache = { at: now(), mapping }; // 仅完整成功且非空的分类可替换缓存。
      }
    }

    let classified = 0;
    let conflicts = 0;
    let dated = 0;
    const quoteDateCounts = {};
    const stocks = symbols.map((symbol) => {
      const row = bySymbol.get(symbol);
      const names = mapping?.get(symbol);
      const industry = names?.size === 1 ? [...names][0] : null;
      if (industry) classified += 1;
      if (names?.size > 1) conflicts += 1;
      const timestamp = dates.get(symbol);
      if (timestamp?.date) {
        dated += 1;
        quoteDateCounts[timestamp.date] = (quoteDateCounts[timestamp.date] || 0) + 1;
      }
      const cap = numeric(row.mktcap);
      const floatCap = numeric(row.nmc);
      const close = timestamp?.close ?? null;
      const previousClose = timestamp?.previousClose ?? null;
      return {
        code: symbol.slice(2),
        market: symbol.startsWith("sh") ? 1 : 0,
        exchange: symbol.slice(0, 2),
        name: String(row.name).trim(),
        // 量价与日期都来自同一条 HQ 行，不能把 node 旧日期的涨幅拼到新报价时间上。
        close,
        open: timestamp?.open ?? null,
        pct: close > 0 && previousClose > 0 ? (close / previousClose - 1) * 100 : null,
        amount: timestamp?.amount ?? null, // 新浪 HQ amount: 元。
        cap: cap === null ? null : numeric(cap * 10000), // node mktcap/nmc: 万元 -> 元。
        floatCap: floatCap === null ? null : numeric(floatCap * 10000),
        mainInflow: null, // 当前接口不提供主力净额，不能补0。
        industry,
        quoteAt: timestamp?.quoteAt ?? null,
        quoteDate: timestamp?.date ?? null,
      };
    });
    const quoteDates = Object.keys(quoteDateCounts).sort();
    if (!quoteDates.length) throw new Error("新浪全A没有真实行情日期");
    const latestQuoteAt = Math.max(...stocks.map((row) => row.quoteAt || 0));
    // 个别停牌旧报价仍保留，但整个市场不能反复把数月前行情包装成新快照。
    if (now() / 1000 - latestQuoteAt > 14 * 86400) throw new Error("新浪全A行情日期过旧");
    const metadata = {
      source: "sina",
      classification: withIndustries ? "新浪行业" : null,
      classificationCoverage: { classified, total: stocks.length, unclassified: stocks.length - classified, conflicts },
      date: quoteDates.at(-1),
      dataDate: quoteDates.at(-1),
      quoteTime: new Date(latestQuoteAt * 1000).toISOString(),
      quoteDateRange: { from: quoteDates[0], to: quoteDates.at(-1) },
      quoteDateCounts,
      coverage: { expected, received: stocks.length, dated },
      updatedAt: new Date(now()).toISOString(),
    };
    return { stocks, live: true, ...metadata, metadata };
  };
}

let defaultProvider = null;
export function loadSinaMarketSnapshot({ request, now, budgetMs, ...options } = {}) {
  if (request || now || budgetMs) return createSinaMarketSnapshotProvider({ request, now, budgetMs })(options);
  defaultProvider ||= createSinaMarketSnapshotProvider();
  return defaultProvider(options);
}
