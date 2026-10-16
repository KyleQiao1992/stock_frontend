import { getRedisClient } from "./redisClient.js";
import { TDX_HISTORY_SOURCE, tdxHistoryVerification } from "./tradeSideHistoryProvenance.js";

export const TDX_HISTORY_PREFIX = "ashare-trade-side-history:tdx:v1";
export const TDX_HISTORY_LIMITS_KEY = `${TDX_HISTORY_PREFIX}:limits`;
export { TDX_HISTORY_SOURCE } from "./tradeSideHistoryProvenance.js";
export const REGISTER_TDX_HISTORY_LIMIT = `
local previous = tonumber(redis.call('HGET', KEYS[1], ARGV[1])) or 0
local requested = tonumber(ARGV[2])
if requested > previous then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return requested
end
return previous
`;
const INTERVAL_MS = 60000;
const RETRY_MS = 300000;
const TRACKED_QUOTES_KEY = "ashare-trade-side:v1:tracked";

function identity(code) {
  code = String(code || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("请输入有效的六位 A 股代码。");
  const market = /^(?:8|4|92)/.test(code) ? "bj" : /^(?:60|68|90)/.test(code) ? "sh" : "sz";
  return { code, symbol: `${market}${code}` };
}

export const tdxHistoryKey = (symbol) => `${TDX_HISTORY_PREFIX}:daily:${symbol}`;
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "")
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// A request started during the session must never turn that session into a
// closing record merely because its network work completes after the close.
export function eligibleTdxHistoryDate(at) {
  const day = new Date(at + 8 * 3600000);
  if (day.getUTCHours() * 60 + day.getUTCMinutes() < 15 * 60 + 10) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function normalizeRow(value, code, cutoff) {
  const row = typeof value === "string" ? JSON.parse(value) : value;
  if (row?.code !== code || !validDate(row.date) || row.date > cutoff
    || !(row.source === "tdx" || row.source?.key === "tdx")
    || row.complete !== true || row.quoteTime !== null || row.validated !== true
    || !Number.isFinite(Date.parse(row.collectedAt))
    || row.quality?.validated !== true || row.quality?.paginationComplete !== true
    || row.quality?.volumeDifference !== 0
    || !Number.isFinite(row.close) || row.close <= 0
    || !Number.isFinite(row.quality?.closingPrice) || row.quality.closingPrice <= 0
    || Math.round(row.close * 100) !== Math.round(row.quality.closingPrice * 100)
    || [row.innerVol, row.outerVol, row.totalVol, row.neutralVol, row.unknownVol,
      row.regularVol, row.afterHoursVol, row.quality?.expectedTotalVol]
      .some((volume) => !Number.isSafeInteger(volume) || volume < 0)
    || row.innerVol + row.outerVol + row.neutralVol + row.unknownVol !== row.totalVol
    || row.regularVol + row.afterHoursVol !== row.totalVol
    || row.regularVol !== row.quality?.expectedTotalVol) {
    throw new Error("通达信历史记录未通过全天成交校验，未保存。");
  }
  const sideVolume = row.innerVol + row.outerVol;
  return { ...row, source: "tdx", quoteTime: null, complete: true,
    quality: { ...row.quality, verification: tdxHistoryVerification() },
    neutralVol: row.neutralVol ?? 0, unknownVol: row.unknownVol ?? 0,
    netVol: row.outerVol - row.innerVol,
    netRatio: sideVolume > 0 ? (row.outerVol - row.innerVol) / sideVolume * 100 : null,
    outerRatio: sideVolume > 0 ? row.outerVol / sideVolume * 100 : null };
}

async function fetchHistory(options) {
  const { fetchTdxTradeSideHistory } = await import("./tdxTradeSideHistory.js");
  return fetchTdxTradeSideHistory(options);
}

export function createTradeSideHistoryArchive({ getRedis = getRedisClient,
  fetchArchive = fetchHistory, now = Date.now, log = console.warn,
  concurrency = 2 } = {}) {
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let timer = null;
  let background = null;
  let disposed = false;

  async function readRows(redis, code, symbol, cutoff) {
    try {
      return (await redis.hVals(tdxHistoryKey(symbol)))
        .map((value) => normalizeRow(value, code, cutoff))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      throw new Error("通达信历史存储读取失败或数据校验无效，未使用临时数据替代。");
    }
  }

  function drain() {
    while (!disposed && active < concurrency && queue.length) {
      const task = queue.shift();
      active += 1;
      void task().finally(() => { active -= 1; drain(); });
    }
  }

  function schedule({ code, symbol, limit, redis, rows, cutoff }) {
    const previous = jobs.get(symbol);
    if (previous?.status === "loading") {
      previous.requestedLimit = Math.max(previous.requestedLimit, limit);
      return previous;
    }
    if (previous?.cutoff === cutoff && previous.limit >= limit
      && (previous.status === "complete" || now() - previous.finishedAt < RETRY_MS)) return previous;
    const job = { status: "loading", done: Math.min(limit, rows.length), total: limit,
      processed: 0, missingDates: [], errors: {}, limit, requestedLimit: limit, cutoff,
      firstDate: rows[0]?.date ?? null, controller: new AbortController() };
    jobs.set(symbol, job);
    queue.push(async () => {
      const persistedDates = new Set(rows.map((row) => row.date));
      try {
        const result = await fetchArchive({ code, limit, now, signal: job.controller.signal,
          existingDates: persistedDates,
          onDay: async (input) => {
            const row = normalizeRow(input, code, cutoff);
            try { await redis.hSetNX(tdxHistoryKey(symbol), row.date, JSON.stringify(row)); }
            catch {
              job.persistenceError = "通达信历史保存失败，本次未保存数据不会显示；请检查 Redis 写入权限。";
              throw new Error(job.persistenceError);
            }
            persistedDates.add(row.date);
            job.done = Math.min(limit, persistedDates.size);
            job.firstDate = !job.firstDate || row.date < job.firstDate ? row.date : job.firstDate;
          },
          onProgress: (quality) => {
            if (Number.isSafeInteger(quality.total) && quality.total >= 0) job.total = quality.total;
            if (Number.isSafeInteger(quality.done) && quality.done >= 0) job.done = quality.done;
            if (Number.isSafeInteger(quality.processed)) job.processed = quality.processed;
            if (Array.isArray(quality.missingDates)) job.missingDates = quality.missingDates.filter(validDate);
            if (quality.errors && typeof quality.errors === "object") job.errors = { ...quality.errors };
          } });
        const quality = result?.quality;
        if (!quality || !Number.isSafeInteger(quality.total) || !Number.isSafeInteger(quality.done)
          || !Array.isArray(quality.missingDates)) throw new Error("通达信历史校验结果无效。");
        job.total = quality.total;
        job.done = quality.done;
        job.processed = quality.processed ?? quality.total;
        job.missingDates = quality.missingDates.filter(validDate);
        job.errors = quality.errors || {};
        job.error = job.persistenceError || (job.missingDates.length
          ? `${job.missingDates.length} 个交易日的历史分笔不可用或未通过完整校验。` : "");
        if (!job.total) job.error ||= "没有获取到可校验的交易日历史。";
        if (job.done !== job.total || job.processed !== job.total) job.error ||= "历史交易日校验未完整结束，已保存的数据仍可查看。";
        job.status = job.error ? "error" : "complete";
      } catch (error) {
        job.status = "error";
        job.error = job.persistenceError || error?.message || "通达信历史分笔读取失败。";
        job.errorCode = error?.code;
      } finally {
        job.finishedAt = now();
        if (!disposed && job.requestedLimit > job.limit) {
          try {
            const saved = await readRows(redis, code, symbol, eligibleTdxHistoryDate(now()));
            schedule({ code, symbol, limit: job.requestedLimit, redis, rows: saved,
              cutoff: eligibleTdxHistoryDate(now()) });
          } catch (error) { job.status = "error"; job.error = error.message; }
        }
      }
    });
    drain();
    return job;
  }

  async function query(input, limit = 120) {
    const { code, symbol } = identity(input);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120) throw new Error("历史条数必须是 1 至 120 的整数。");
    const cutoff = eligibleTdxHistoryDate(now());
    let redis;
    try { redis = await getRedis(); }
    catch { throw new Error("通达信历史存储不可用，请检查 Redis 连接。"); }
    const allRows = await readRows(redis, code, symbol, cutoff);
    let registrationError = "";
    try {
      await redis.eval(REGISTER_TDX_HISTORY_LIMIT, { keys: [TDX_HISTORY_LIMITS_KEY], arguments: [symbol, String(limit)] });
    } catch { registrationError = "登记历史补日失败，请检查 Redis 写入权限。"; }
    const job = registrationError ? { status: "error", done: Math.min(limit, allRows.length),
      total: limit, missingDates: [], error: registrationError }
      : schedule({ code, symbol, limit, redis, rows: allRows, cutoff });
    const history = { status: job.status, done: job.done, total: job.total,
      processed: job.processed ?? 0, missingDates: [...job.missingDates],
      firstDate: allRows[0]?.date ?? null,
      ...(job.error ? { error: job.error } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(Object.keys(job.errors || {}).length ? { errors: { ...job.errors } } : {}) };
    return { code, source: TDX_HISTORY_SOURCE, verification: tdxHistoryVerification(),
      unit: "手", rows: allRows.slice(-limit), history,
      collection: { persisted: true, tracking: !registrationError, firstDate: allRows[0]?.date ?? null,
        days: allRows.length, completedDays: allRows.length,
        lastCollectedAt: allRows.at(-1)?.collectedAt ?? null,
        intervalSeconds: INTERVAL_MS / 1000,
        notice: allRows.length ? "已保存的历史核对过常规成交总量和收盘价，并完成分页检查；这些检查不能证明买卖方向与交易所一致。"
          : "尚无通过完整性核验的历史记录。",
        ...(registrationError ? { error: registrationError } : {}) },
      ...(job.error ? { warning: job.error } : {}) };
  }

  async function collectTracked() {
    if (background) return background;
    background = (async () => {
      const redis = await getRedis();
      const limits = await redis.hGetAll(TDX_HISTORY_LIMITS_KEY);
      const tracked = await redis.sMembers(TRACKED_QUOTES_KEY);
      const symbols = new Set([...Object.keys(limits), ...tracked]);
      for (const symbol of symbols) {
        if (!/^(?:sh|sz|bj)\d{6}$/.test(symbol)) continue;
        try { await query(symbol.slice(2), Math.min(120, Math.max(1, Number(limits[symbol]) || 30))); }
        catch (error) { log("[tdx-trade-side-history] supplement failed", error?.message || "unknown"); }
      }
    })().finally(() => { background = null; });
    return background;
  }

  function start() {
    if (timer) return dispose;
    disposed = false;
    const run = () => { void collectTracked().catch((error) => log("[tdx-trade-side-history] unavailable", error?.message || "unknown")); };
    run();
    timer = setInterval(() => {
      const local = new Date(now() + 8 * 3600000);
      if (local.getUTCDay() >= 1 && local.getUTCDay() <= 5
        && local.getUTCHours() * 60 + local.getUTCMinutes() >= 15 * 60 + 10
        && local.getUTCHours() * 60 + local.getUTCMinutes() <= 16 * 60 + 30) run();
    }, INTERVAL_MS);
    timer.unref?.();
    return dispose;
  }

  function dispose() {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
    queue.splice(0);
    for (const job of jobs.values()) if (job.status === "loading") {
      job.controller.abort(); job.status = "error"; job.error = "历史加载已停止。";
    }
  }

  return { query, collectTracked, start, dispose };
}

export const tradeSideHistoryArchive = createTradeSideHistoryArchive();
