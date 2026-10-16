import { getRedisClient } from "./redisClient.js";
import { tencentAshareVolumeToLots, tencentAshareVolumeUnit } from "../src/lib/tencentAshareVolume.js";
import { directTradeSideHistoryService } from "./directTradeSideHistory.js";

const PREFIX = "ashare-trade-side:v1";
export const TRADE_SIDE_TRACKED_KEY = `${PREFIX}:tracked`;
const INTERVAL_MS = 60000;
const BATCH_SIZE = 60;
const HEADERS = { Referer: "https://gu.qq.com/", "User-Agent": "Mozilla/5.0" };

// Compare the provider timestamp inside Redis: separate server instances must
// not let a slower, older response overwrite a later quote for the same day.
export const UPSERT_TRADE_SIDE_SCRIPT = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
if previous then
  local ok, row = pcall(cjson.decode, previous)
  if not ok or type(row) ~= 'table' or type(row.quoteTime) ~= 'string' then
    return redis.error_reply('Stored trade-side history is invalid')
  end
  if row.quoteTime >= ARGV[2] then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

export function normalizeTradeSideCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("请输入有效的六位 A 股代码。");
  return code;
}

export function toTradeSideSymbol(value) {
  const code = normalizeTradeSideCode(value);
  if (/^(?:8|4|92)/.test(code)) return `bj${code}`;
  return `${/^(?:60|68|90)/.test(code) ? "sh" : "sz"}${code}`;
}

const historyKey = (symbol) => `${PREFIX}:daily:${symbol}`;
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "")
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const numericVolume = (value) => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
  && Number.isFinite(Number(value)) ? Number(value) : null;

export function parseTencentTradeSideQuote(symbol, fields, collectedAt = Date.now()) {
  if (!/^(?:sh|sz|bj)\d{6}$/.test(symbol) || !Array.isArray(fields)
    || fields.length < 41 || fields[2] !== symbol.slice(2) || !String(fields[1] || "").trim()) {
    throw new Error("腾讯内外盘报价身份或格式无效。");
  }
  const timestamp = String(fields[30] || "");
  if (!/^\d{14}$/.test(timestamp)) throw new Error("腾讯内外盘报价没有有效时间。");
  const date = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
  const clock = `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`;
  const quoteTime = `${date}T${clock}+08:00`;
  if (!validDate(date) || timestamp.slice(8, 10) > "23" || timestamp.slice(10, 12) > "59"
    || timestamp.slice(12, 14) > "59" || Date.parse(quoteTime) > collectedAt + 300000) {
    throw new Error("腾讯内外盘报价日期或时间无效。");
  }
  const sourceVolumes = { outerVol: numericVolume(fields[7]), innerVol: numericVolume(fields[8]), totalVol: numericVolume(fields[6]) };
  if (Object.values(sourceVolumes).some((value) => value === null)) {
    throw new Error("腾讯报价未提供完整的内盘、外盘和成交量。");
  }
  const outerVol = tencentAshareVolumeToLots(sourceVolumes.outerVol, symbol);
  const innerVol = tencentAshareVolumeToLots(sourceVolumes.innerVol, symbol);
  const totalVol = tencentAshareVolumeToLots(sourceVolumes.totalVol, symbol);
  const sideVolume = sourceVolumes.innerVol + sourceVolumes.outerVol;
  const sourceNetVol = sourceVolumes.outerVol - sourceVolumes.innerVol;
  const netVol = sourceNetVol / (tencentAshareVolumeUnit(symbol) === "share" ? 100 : 1);
  return {
    code: symbol.slice(2), name: fields[1].trim(), date, quoteTime,
    innerVol, outerVol, totalVol, netVol,
    volumeUnit: "lot", sourceVolumeUnit: tencentAshareVolumeUnit(symbol), sourceVolumes,
    netRatio: sideVolume > 0 ? sourceNetVol / sideVolume * 100 : null,
    outerRatio: sideVolume > 0 ? sourceVolumes.outerVol / sideVolume * 100 : null,
    // Collection time does not prove a closing quote. An old intraday quote
    // remains incomplete even when fetched on a later day or after the close.
    complete: clock >= "15:00:00",
    collectedAt: new Date(collectedAt).toISOString(),
    suspended: fields[40] === "S",
  };
}

export async function fetchTencentTradeSideQuotes(symbols, { request = fetch, now = Date.now } = {}) {
  if (!symbols.length || symbols.length > BATCH_SIZE
    || symbols.some((symbol) => !/^(?:sh|sz|bj)\d{6}$/.test(symbol))) {
    throw new Error("内外盘报价查询参数无效。");
  }
  const response = await request(`https://qt.gtimg.cn/q=${symbols.join(",")}`, {
    headers: HEADERS, signal: AbortSignal.timeout(8000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`腾讯内外盘接口 HTTP ${response.status}。`);
  const body = new TextDecoder("gb18030").decode(await response.arrayBuffer());
  const rows = new Map();
  for (const match of body.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)";/g)) {
    if (!symbols.includes(match[1])) continue;
    try { rows.set(match[1], parseTencentTradeSideQuote(match[1], match[2].split("~"), now())); }
    catch (error) { rows.set(match[1], { error: error.message }); }
  }
  for (const symbol of symbols) if (!rows.has(symbol)) rows.set(symbol, { error: "腾讯内外盘报价返回不完整。" });
  return rows;
}

export function createTradeSideSnapshotService({ fetchQuotes = fetchTencentTradeSideQuotes,
  request, now = Date.now } = {}) {
  return {
    async get(input) {
      const code = normalizeTradeSideCode(input);
      const symbol = toTradeSideSymbol(code);
      const quotes = await fetchQuotes([symbol], { request, now });
      const latest = quotes.get(symbol);
      if (!latest || latest.error) throw new Error(latest?.error || "腾讯即时内外盘报价返回不完整。");
      return { code, name: latest.name, source: { key: "tencent", name: "腾讯即时行情" },
        unit: "手", latest };
    },
  };
}

export const tradeSideSnapshotService = createTradeSideSnapshotService();

export function isTradeSideCollectionWindow(at) {
  const shanghai = new Date(at + 8 * 3600000);
  const day = shanghai.getUTCDay();
  const minute = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  // Polling on a public holiday can only repeat the provider's real previous
  // session; rows are keyed by quote date, never by the polling date.
  return day >= 1 && day <= 5 && minute >= 8 * 60 + 50 && minute <= 16 * 60 + 30;
}

function storedRow(value, code) {
  let row = JSON.parse(value);
  if (row?.code !== code || !validDate(row.date) || typeof row.quoteTime !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(row.quoteTime)
    || !row.quoteTime.startsWith(`${row.date}T`) || !Number.isFinite(Date.parse(row.quoteTime))
    || typeof row.complete !== "boolean" || typeof row.name !== "string"
    || row.complete !== (row.quoteTime.slice(11, 19) >= "15:00:00")
    || !Number.isFinite(Date.parse(row.collectedAt))
    || [row.innerVol, row.outerVol, row.totalVol].some((volume) => !Number.isFinite(volume) || volume < 0)
    || (row.volumeUnit != null && row.volumeUnit !== "lot")) {
    throw new Error("已保存的内外盘历史记录格式无效。");
  }
  // v1 records without a unit contain Tencent's source counters, including
  // shares for STAR Market stocks. Normalize on read even when the unchanged
  // quote timestamp correctly prevents the collector from rewriting the row.
  if (row.volumeUnit == null) {
    const sourceVolumes = { innerVol: row.innerVol, outerVol: row.outerVol, totalVol: row.totalVol };
    row = { ...row, volumeUnit: "lot", sourceVolumeUnit: tencentAshareVolumeUnit(code), sourceVolumes,
      innerVol: tencentAshareVolumeToLots(row.innerVol, code),
      outerVol: tencentAshareVolumeToLots(row.outerVol, code),
      totalVol: tencentAshareVolumeToLots(row.totalVol, code) };
  }
  // Derive ratios from the actual archived counters, retaining the original
  // total separately (rounding/auction volume can differ from the side sum).
  const sideVolume = row.innerVol + row.outerVol;
  const source = row.sourceVolumes;
  const hasMatchingSource = source
    && tencentAshareVolumeToLots(source.innerVol, code) === row.innerVol
    && tencentAshareVolumeToLots(source.outerVol, code) === row.outerVol;
  const netVol = hasMatchingSource ? (source.outerVol - source.innerVol)
    / (tencentAshareVolumeUnit(code) === "share" ? 100 : 1) : row.outerVol - row.innerVol;
  return { ...row, netVol,
    netRatio: sideVolume > 0 ? netVol / sideVolume * 100 : null,
    outerRatio: sideVolume > 0 ? row.outerVol / sideVolume * 100 : null };
}

export function createTradeSideHistoryService({ getRedis = getRedisClient,
  fetchQuotes = fetchTencentTradeSideQuotes, now = Date.now, log = console.warn } = {}) {
  let timer = null;
  let background = null;
  const inflight = new Map();

  async function collect(redis, symbols) {
    const key = symbols.join(",");
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const snapshots = await fetchQuotes(symbols, { now });
      const skipped = new Map();
      const errors = new Map();
      for (const symbol of symbols) {
        const row = snapshots.get(symbol);
        if (!row || row.error) {
          errors.set(symbol, row?.error || "腾讯内外盘报价返回不完整。");
          continue;
        }
        if (row.suspended || row.totalVol === 0 || row.innerVol + row.outerVol === 0) {
          skipped.set(symbol, row.suspended ? "当前报价显示停牌，未将零成交记录计入内外盘历史。"
            : "当前报价尚无有效买卖成交，未计入内外盘历史。");
          continue;
        }
        try {
          await redis.eval(UPSERT_TRADE_SIDE_SCRIPT, { keys: [historyKey(symbol)],
            arguments: [row.date, row.quoteTime, JSON.stringify(row)] });
        } catch { errors.set(symbol, "内外盘历史保存失败，本次报价未保存；请检查 Redis 写入权限和存储状态。"); }
      }
      return { skipped, errors };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function get(code, limit = 120) {
    code = normalizeTradeSideCode(code);
    const symbol = toTradeSideSymbol(code);
    let redis;
    try { redis = await getRedis(); }
    catch { throw new Error("内外盘历史存储不可用，本次报价未保存；请检查 Redis 连接。"); }
    let tracking = false;
    let warning = "";
    let collectionError = "";
    try { await redis.sAdd(TRADE_SIDE_TRACKED_KEY, symbol); tracking = true; }
    catch { collectionError = "登记持续采集失败，请检查 Redis 写入权限。"; }
    if (tracking) {
      try {
        const result = await collect(redis, [symbol]);
        warning = result.skipped.get(symbol) || "";
        collectionError = result.errors.get(symbol) || "";
      } catch (error) {
        collectionError = error?.message || "内外盘采集失败。";
      }
    }
    let allRows;
    try { allRows = (await redis.hVals(historyKey(symbol))).map((value) => storedRow(value, code))
      .sort((left, right) => left.date.localeCompare(right.date)); }
    catch { throw new Error("内外盘历史存储读取失败或记录格式无效，未使用临时数据替代。"); }
    const rows = allRows.slice(-limit);
    if (!rows.length) throw new Error(collectionError || warning || "尚未采集到有效内外盘历史。");
    const latest = rows.at(-1);
    if (collectionError) warning = `${collectionError} 当前显示已保存的真实历史，最新记录时间为 ${latest.quoteTime}。`;
    return {
      code, name: latest.name, source: { key: "tencent", name: "腾讯行情" }, unit: "手",
      rows, latest,
      collection: { persisted: true, tracking,
        firstDate: allRows[0].date, lastCollectedAt: latest.collectedAt,
        days: allRows.length, completedDays: allRows.filter((row) => row.complete).length,
        intervalSeconds: INTERVAL_MS / 1000,
        notice: "仅保留实际采集的腾讯内外盘报价；采集前的交易日无法从现有 K 线回填。",
        ...(collectionError ? { error: collectionError } : {}) },
      ...(warning ? { warning } : {}),
    };
  }

  async function collectTracked() {
    if (background) return background;
    background = (async () => {
      const redis = await getRedis();
      const symbols = (await redis.sMembers(TRADE_SIDE_TRACKED_KEY))
        .filter((symbol) => /^(?:sh|sz|bj)\d{6}$/.test(symbol));
      for (let offset = 0; offset < symbols.length; offset += BATCH_SIZE) {
        try {
          const result = await collect(redis, symbols.slice(offset, offset + BATCH_SIZE));
          if (result.errors.size) log(`[trade-side-history] ${result.errors.size} registered quotes could not be saved`);
        }
        catch (error) { log("[trade-side-history] registered quote batch failed", error?.message || "unknown"); }
      }
    })().finally(() => { background = null; });
    return background;
  }

  function start() {
    if (timer) return dispose;
    const run = () => { void collectTracked().catch(() => log("[trade-side-history] Redis collection unavailable")); };
    run();
    timer = setInterval(() => { if (isTradeSideCollectionWindow(now())) run(); }, INTERVAL_MS);
    timer.unref?.();
    return dispose;
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { get, collectTracked, start, dispose };
}

export const tradeSideHistoryService = createTradeSideHistoryService();
// Kept as the server lifecycle hook. This panel now reads provider history and
// current quotes directly; neither Redis collector is started for it.
export const startTradeSideHistoryCollection = () => () => directTradeSideHistoryService.dispose();

export function createTradeSideHistoryApiService({ realtime = tradeSideSnapshotService,
  archive = directTradeSideHistoryService } = {}) {
  return {
    async get(code, limit = 120) {
      // Both defaults read their providers independently of Redis. A current
      // quote is not added to the historical rows or treated as a saved day.
      const [current, historical] = await Promise.allSettled([
        realtime.get(code, limit), archive.query(code, limit),
      ]);
      if (historical.status === "rejected") throw historical.reason;
      const payload = historical.value;
      const latest = current.status === "fulfilled" ? { ...current.value.latest, source: "tencent" } : null;
      const currentWarning = current.status === "fulfilled" ? current.value.warning
        : current.reason?.message || "腾讯即时行情暂时不可用。";
      const warning = [payload.warning, currentWarning].filter(Boolean).join(" ");
      return { ...payload, name: latest?.name || payload.rows.at(-1)?.name || code,
        latest, realtimeSource: { key: "tencent", name: "腾讯即时行情" },
        snapshotHistory: { source: { key: "tencent", name: "腾讯采集记录" }, unit: "手",
          rows: current.status === "fulfilled" && Array.isArray(current.value.rows)
            ? [...current.value.rows] : [],
          collection: current.status === "fulfilled" ? current.value.collection ?? null : null },
        ...(warning ? { warning } : {}) };
    },
  };
}

export const tradeSideHistoryApiService = createTradeSideHistoryApiService();

export function createAshareTradeSideHistoryHandler({ service = tradeSideHistoryApiService } = {}) {
  return async function ashareTradeSideHistoryHandler(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    let code;
    let limit;
    try {
      const params = new URL(req.url || "", "http://localhost").searchParams;
      code = normalizeTradeSideCode(params.get("code"));
      const requested = params.has("limit") ? Number(params.get("limit")) : 120;
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 120) throw new Error("历史条数必须是 1 至 120 的整数。");
      limit = requested;
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    try { res.statusCode = 200; res.end(JSON.stringify(await service.get(code, limit))); }
    catch (error) { res.statusCode = 502; res.end(JSON.stringify({ error: error?.message || "内外盘历史加载失败。" })); }
  };
}
