import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseTradeSideDailyPlan } from "./tdxTradeSideHistory.js";
import { parseTdxDailyTradeSidePackage, validateTdxDailyPackage, TDX_DAILY_HISTORY_SOURCE, tdxDailyVerification } from "./tdxDailyTradeSide.js";

const HEADERS = { Referer: "https://www.tdx.com.cn/", "User-Agent": "Mozilla/5.0" };
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const RETRY_MS = 60000;

// The files are a download cache, never a history assembled from the dates on
// which this app happened to run. Deleting the cache simply downloads them again.
export function createDailyPackageLoader({ request = globalThis.fetch,
  cacheDir = process.env.TRADE_SIDE_FILE_CACHE_DIR || path.resolve(".cache/trade-side-history"),
  validatePackage = validateTdxDailyPackage, concurrency = 4 } = {}) {
  const pending = new Map();
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("历史文件下载并发数必须是 1 至 8。");
  let downloads = 0;
  const waiters = [];
  async function acquire() {
    if (downloads >= concurrency) await new Promise(resolve => waiters.push(resolve));
    else downloads++;
  }
  function release() {
    const next = waiters.shift();
    if (next) next();
    else downloads--;
  }
  return async function loadPackage(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
      throw new Error("历史文件日期无效。");
    if (pending.has(date)) return pending.get(date);
    const promise = (async () => {
      const compactDate = date.replaceAll("-", "");
      const filename = cacheDir ? path.join(cacheDir, `${compactDate}.zip`) : null;
      if (filename) {
        try {
          const data = await fs.readFile(filename);
          if (data.length > MAX_PACKAGE_BYTES) throw new Error("缓存历史文件过大。");
          validatePackage(data, date);
          return data;
        } catch (error) {
          if (error.code && error.code !== "ENOENT") throw error;
          if (error.code !== "ENOENT") await fs.rm(filename, { force: true });
        }
      }
      await acquire();
      try {
        const response = await request(`https://www.tdx.com.cn/products/data/data/g4day/${compactDate}.zip`, {
          headers: HEADERS, signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`${date} 通达信盘后文件 HTTP ${response.status}。`);
        if (Number(response.headers?.get("content-length")) > MAX_PACKAGE_BYTES)
          throw new Error(`${date} 历史文件超过允许大小。`);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_PACKAGE_BYTES) throw new Error(`${date} 历史文件超过允许大小。`);
          chunks.push(Buffer.from(chunk));
        }
        const data = Buffer.concat(chunks);
        if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50)
          throw new Error(`${date} 下载内容不是有效历史 ZIP。`);
        validatePackage(data, date);
        if (filename) {
          await fs.mkdir(cacheDir, { recursive: true });
          const temporary = `${filename}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temporary, data); await fs.rename(temporary, filename); }
          finally { await fs.rm(temporary, { force: true }); }
        }
        return data;
      } finally { release(); }
    })().finally(() => pending.delete(date));
    pending.set(date, promise);
    return promise;
  };
}

export async function fetchDailyTradeSidePlan(code, limit, { request = globalThis.fetch, now = Date.now } = {}) {
  const symbol = code.startsWith("6") ? `sh${code}` : `sz${code}`;
  const startedAt = now();
  const params = new URLSearchParams({ param: `${symbol},day,,,${limit + 30},` });
  const response = await request(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${params}`, {
    headers: { Referer: "https://gu.qq.com/", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`历史交易日接口 HTTP ${response.status}。`);
  return parseTradeSideDailyPlan(await response.json(), code, { limit, now: () => startedAt });
}

export function createDirectTradeSideHistoryService({ fetchPlan = fetchDailyTradeSidePlan,
  loadPackage = createDailyPackageLoader(), parsePackage = parseTdxDailyTradeSidePackage,
  now = Date.now, concurrency = 4 } = {}) {
  const jobs = new Map();
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("历史查询并发数必须是 1 至 8。");
  const stocks = new Map();
  const queue = [];
  let active = 0;
  let disposed = false;
  const cutoff = () => {
    const local = new Date(now() + 8 * 3600000);
    if (local.getUTCHours() * 60 + local.getUTCMinutes() < 910) local.setUTCDate(local.getUTCDate() - 1);
    return local.toISOString().slice(0, 10);
  };
  function drain() {
    while (!disposed && active < concurrency && queue.length) {
      const work = queue.shift();
      active++;
      void work().finally(() => { active--; drain(); });
    }
  }
  function schedule(code, limit, endDate) {
    const previous = jobs.get(code);
    if (previous?.status === "loading") {
      previous.requestedLimit = Math.max(previous.requestedLimit, limit);
      return previous;
    }
    if (previous?.cutoff === endDate && previous.limit >= limit
      && (previous.status === "complete" || now() - previous.finishedAt < RETRY_MS)) return previous;
    const rows = stocks.get(code) || new Map();
    stocks.set(code, rows);
    const job = { status: "loading", done: 0, total: 0, processed: 0, missingDates: [], errors: {},
      limit, requestedLimit: limit, cutoff: endDate, targetDates: [], startedAt: now() };
    jobs.set(code, job);
    queue.push(async () => {
      try {
        const plan = await fetchPlan(code, limit, { now: () => job.startedAt });
        if (!Array.isArray(plan) || !plan.length) throw new Error("未取得已收盘的历史交易日。");
        job.targetDates = plan.map(day => day.date);
        job.total = plan.length;
        // Recent days arrive first so the one-week list is usable while the
        // remaining older packages are downloaded.
        const pendingDays = [...plan].reverse();
        let index = 0;
        const workers = Array.from({ length: Math.min(concurrency, pendingDays.length) }, async () => {
          while (index < pendingDays.length) {
            if (disposed) throw new Error("历史查询已停止。");
            const day = pendingDays[index++];
            if (day.date > endDate) throw new Error("交易日计划包含未收盘日期。");
            if (!rows.has(day.date)) {
              try {
                const data = await loadPackage(day.date);
                const row = parsePackage(data, { ...day, now });
                if (row.code !== code || row.date !== day.date || !row.complete || !row.quality?.validated)
                  throw new Error("历史文件记录未通过校验。");
                rows.set(day.date, row);
              } catch (error) {
                job.missingDates.push(day.date);
                job.errors[day.date] = error?.message || "历史文件查询失败。";
              }
            }
            if (rows.has(day.date)) job.done++;
            job.processed++;
          }
        });
        const outcomes = await Promise.allSettled(workers);
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure) throw failure.reason;
        job.status = job.missingDates.length ? "error" : "complete";
        if (job.missingDates.length) job.error = `${job.missingDates.length} 个交易日未取得通过校验的历史文件。`;
      } catch (error) { job.status = "error"; job.error = error?.message || "历史查询失败。"; }
      finally {
        job.finishedAt = now();
        if (!disposed && job.requestedLimit > job.limit) schedule(code, job.requestedLimit, cutoff());
      }
    });
    drain();
    return job;
  }
  async function query(input, limit = 120) {
    const code = String(input || "").trim();
    if (!/^(?:6\d{5}|0\d{5}|3\d{5})$/.test(code)) throw new Error("目前盘后历史文件支持沪深 A 股代码。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120) throw new Error("历史条数必须是 1 至 120 的整数。");
    if (disposed) throw new Error("历史查询服务已停止。");
    const endDate = cutoff();
    const job = schedule(code, limit, endDate);
    const targets = new Set(job.targetDates);
    const rows = [...(stocks.get(code)?.values() || [])].filter(row => row.date <= endDate
      && (!targets.size || targets.has(row.date))).sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
    return { code, source: TDX_DAILY_HISTORY_SOURCE, verification: tdxDailyVerification(), unit: "手", rows,
      history: { status: job.status, done: job.done, total: job.total, processed: job.processed,
        targetDates: [...job.targetDates], missingDates: [...job.missingDates].sort(), errors: { ...job.errors },
        firstDate: rows[0]?.date ?? null, ...(job.error ? { error: job.error } : {}) },
      collection: { persisted: false, tracking: false, storage: "official-daily-file-cache", days: rows.length,
        completedDays: rows.length, firstDate: rows[0]?.date ?? null,
        lastCollectedAt: rows.at(-1)?.collectedAt ?? null },
      ...(job.error ? { warning: job.error } : {}) };
  }
  function dispose() { disposed = true; queue.length = 0; }
  return { query, dispose };
}

export const directTradeSideHistoryService = createDirectTradeSideHistoryService();
