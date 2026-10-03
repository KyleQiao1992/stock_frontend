// 新浪公开行情中心：全 A 名单/报价、同源逐股行情日期，以及明确标注的新浪行业分类。
// 行业目录是旧新浪分类，仅覆盖部分股票；缺失与冲突都保留为未分类，绝不删股票。
const API = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
const DIRECTORY = "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" };
const TENCENT_HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.qq.com/" };
const PAGE = 100;
const INDUSTRY_CACHE_MS = 6 * 60 * 60 * 1000;

function sourceError(message, { code, stage, status, cause } = {}) {
  return Object.assign(new Error(message, { cause }), { code, stage, ...(status == null ? {} : { status }) });
}

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
  let preferredQuoteSource = "sina";

  return async function loadSnapshot({ withIndustries = false, signal } = {}) {
    const deadline = now() + budgetMs;
    async function response(url, stage, provider = "sina") {
      if (signal?.aborted) throw signal.reason || new Error("新浪快照查询已取消");
      const remaining = deadline - now();
      const prefix = provider === "tencent" ? "TENCENT" : "SINA";
      if (remaining <= 0) throw sourceError("新浪全A快照查询超时", { code: `${prefix}_TIMEOUT`, stage });
      const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(8000, remaining))));
      let result;
      try {
        result = await request(url, { headers: provider === "tencent" ? TENCENT_HEADERS : HEADERS,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (cause) {
        throw sourceError(`行情请求失败：${cause?.message || "连接失败"}`, { code: `${prefix}_NETWORK_ERROR`, stage, cause });
      }
      if (!result.ok) throw sourceError(`${provider === "tencent" ? "腾讯" : "新浪"}快照 HTTP ${result.status}`,
        { code: `${prefix}_HTTP_ERROR`, stage, status: result.status });
      return result;
    }
    async function nodePage(node, page) {
      const result = await response(`${API}getHQNodeData?page=${page}&num=${PAGE}&sort=symbol&asc=1&node=${encodeURIComponent(node)}`,
        node === "hs_a" ? "universe-page" : "industry-page");
      const rows = await result.json();
      if (!Array.isArray(rows)) throw new Error(`新浪 ${node} 第${page}页格式无效`);
      return rows;
    }

    const expected = positiveCount(await (await response(`${API}getHQNodeStockCount?node=hs_a`, "universe-count")).json());
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

    // node 的 ticktime 没有日期。报价必须同时提供实际日期、价格与成交额；
    // 新浪 HQ 在某些服务器返回403时，整份报价切到腾讯，不能拼接两源量价。
    const symbols = [...bySymbol.keys()];
    const batches = Array.from({ length: Math.ceil(symbols.length / PAGE) }, (_, index) => symbols.slice(index * PAGE, (index + 1) * PAGE));
    async function readQuotes(provider) {
      const quotes = new Map();
      const tencent = provider === "tencent";
      const prefix = tencent ? "TENCENT" : "SINA";
      async function batchQuotes(batch) {
        const url = tencent ? `https://qt.gtimg.cn/q=${batch.join(",")}` : `https://hq.sinajs.cn/list=${batch.join(",")}`;
        const result = await response(url, "quotes", provider);
        const text = new TextDecoder("gbk").decode(await result.arrayBuffer());
        const returned = new Set();
        const pattern = tencent ? /v_((?:sh|sz|bj)\d{6})="([^"]*)";/g : /var hq_str_((?:sh|sz|bj)\d{6})="([^"]*)";/g;
        for (const match of text.matchAll(pattern)) {
          if (!batch.includes(match[1])) continue;
          returned.add(match[1]);
          const values = match[2].split(tencent ? "~" : ",");
          if (tencent && match[2] && (values[2] !== match[1].slice(2) || values.length < 38)) {
            throw sourceError("腾讯股票报价身份或格式无效", { code: "TENCENT_RESPONSE_INVALID", stage: "quotes" });
          }
          const rawDate = tencent && /^\d{14}$/.test(values[30] || "") ? values[30] : "";
          const date = tencent ? rawDate && `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : values[30];
          const time = tencent ? rawDate && `${rawDate.slice(8, 10)}:${rawDate.slice(10, 12)}:${rawDate.slice(12, 14)}` : values[31];
          const parsedAt = quoteTimestamp(date, time);
          const quoteAt = parsedAt !== null && parsedAt <= now() / 1000 + 300 ? parsedAt : null;
          let amount = numeric(values[tencent ? 37 : 9]);
          if (tencent) {
            amount = amount === null ? null : numeric(amount * 10000);
            const total = (values[35] || "").split("/").map(numeric);
            // 35为现价/累计成交量/累计成交额(元)，37万元在沪深会四舍五入。
            // 核对本行现价和成交量后保留元精度，不取其他股票或源的量价。
            if (total.length === 3 && total.every(Number.isFinite) && total[2] >= 0
              && total[0] === numeric(values[3]) && total[1] === numeric(values[6])) amount = total[2];
          }
          quotes.set(match[1], {
            quoteAt, date: quoteAt === null ? null : date,
            open: numeric(values[tencent ? 5 : 1]),
            previousClose: numeric(values[tencent ? 4 : 2]), close: numeric(values[3]),
            amount,
          });
        }
        if (returned.size !== batch.length) throw sourceError(`行情日期批次不完整（${returned.size}/${batch.length}）`,
          { code: `${prefix}_COVERAGE_INCOMPLETE`, stage: "quotes" });
      }
      // 先探测一批，拒绝连接时不用同时发六个注定失败的请求。
      await batchQuotes(batches[0]);
      await pool(batches.slice(1), batchQuotes);
      const latest = Math.max(...[...quotes.values()].map((row) => row.quoteAt || 0));
      if (!latest) throw sourceError("全A没有真实行情日期", { code: `${prefix}_RESPONSE_INVALID`, stage: "quotes" });
      if (now() / 1000 - latest > 14 * 86400) throw sourceError("全A行情日期过旧", { code: `${prefix}_RESPONSE_INVALID`, stage: "quotes" });
      return quotes;
    }
    let quoteSource = preferredQuoteSource;
    let dates;
    try {
      dates = await readQuotes(quoteSource);
    } catch (error) {
      if (signal?.aborted || now() >= deadline) throw error;
      quoteSource = quoteSource === "sina" ? "tencent" : "sina";
      dates = await readQuotes(quoteSource);
    }
    preferredQuoteSource = quoteSource;

    let mapping = null;
    if (withIndustries) {
      if (industryCache && now() - industryCache.at < INDUSTRY_CACHE_MS) mapping = industryCache.mapping;
      else {
        const result = await response(DIRECTORY, "industry-directory");
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
        // 量价与日期都来自同一条报价，不能把 node 旧涨幅拼到新报价时间上。
        close,
        open: timestamp?.open ?? null,
        pct: close > 0 && previousClose > 0 ? (close / previousClose - 1) * 100 : null,
        amount: timestamp?.amount ?? null, // 已按报价源统一为元。
        cap: cap === null ? null : numeric(cap * 10000), // node mktcap/nmc: 万元 -> 元。
        floatCap: floatCap === null ? null : numeric(floatCap * 10000),
        mainInflow: null, // 当前接口不提供主力净额，不能补0。
        industry,
        quoteAt: timestamp?.quoteAt ?? null,
        quoteDate: timestamp?.date ?? null,
        quoteSource,
      };
    });
    const quoteDates = Object.keys(quoteDateCounts).sort();
    if (!quoteDates.length) throw new Error("新浪全A没有真实行情日期");
    const latestQuoteAt = Math.max(...stocks.map((row) => row.quoteAt || 0));
    // 个别停牌旧报价仍保留，但整个市场不能反复把数月前行情包装成新快照。
    if (now() / 1000 - latestQuoteAt > 14 * 86400) throw new Error("新浪全A行情日期过旧");
    const metadata = {
      source: quoteSource === "tencent" ? "sina-tencent" : "sina",
      quoteSource, universeSource: "sina", capitalSource: "sina",
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
