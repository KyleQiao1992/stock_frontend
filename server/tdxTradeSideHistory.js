import net from "node:net";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { tencentAshareVolumeToLots, tencentAshareVolumeUnit } from "../src/lib/tencentAshareVolume.js";

// Protocol layout reference (independent Node implementation):
// https://github.com/rainx/pytdx/blob/master/pytdx/parser/get_history_transaction_data.py
// The original repository does not declare a license. The
// counters below use TDX's classified historical transactions, not Tencent's
// current quote classifications, which can assign the same volume differently.
import { TDX_HISTORY_SOURCE, tdxHistoryVerification } from "./tradeSideHistoryProvenance.js";
export { TDX_HISTORY_SOURCE } from "./tradeSideHistoryProvenance.js";
export const TDX_HISTORY_HOSTS = Object.freeze([
  { host: "218.6.170.47", port: 7709 },
  { host: "123.125.108.14", port: 7709 },
]);
const SETUP_PACKETS = [
  "0c0218930001030003000d0001",
  "0c0218940001030003000d0002",
  "0c031899000120002000db0fd5d0c9ccd6a4a8af0000008fc22540130000d500c9cc bdf0d7ea00000002".replaceAll(" ", ""),
].map((hex) => Buffer.from(hex, "hex"));
const PAGE_SIZE = 2000;
const MAX_POSITION = 65535;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function fail(message, code) {
  const error = new Error(`通达信历史成交：${message}`);
  if (code) error.code = code;
  throw error;
}
function assertExactVolumeAvailable(code) {
  if (tencentAshareVolumeUnit(code) === "share") {
    fail(`${code} 科创板成交量按股计，含不足一手的零股；当前通达信历史分笔仅返回整数手，不能还原精确内外盘股数。需要保留逐笔股数的历史数据源。`, "TDX_SHARE_PRECISION_UNAVAILABLE");
  }
}
function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("历史成交查询已取消。");
}
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

export function buildTdxHistoryPacket({ code, market, date, start = 0, count = PAGE_SIZE }) {
  if (!/^\d{6}$/.test(code) || ![0, 1].includes(market) || !validDate(date)
    || !Number.isInteger(start) || start < 0 || start > MAX_POSITION
    || !Number.isInteger(count) || count < 1 || count > PAGE_SIZE) fail("查询参数无效。");
  const packet = Buffer.alloc(30);
  Buffer.from("0c013001000112001200b50f", "hex").copy(packet);
  packet.writeUInt32LE(Number(date.replaceAll("-", "")), 12);
  packet.writeUInt16LE(market, 16);
  packet.write(code, 18, 6, "ascii");
  packet.writeUInt16LE(start, 24);
  packet.writeUInt16LE(count, 26);
  // The fixed header advertises an 18-byte body, but pytdx's actual request
  // body is 16 bytes (date, market, code, start, count), hence 28 bytes total.
  return packet.subarray(0, 28);
}

function readVarint(buffer, cursor) {
  if (cursor.pos >= buffer.length) fail("成交响应被截断。");
  const first = buffer[cursor.pos++];
  let value = first & 63;
  let factor = 64;
  let part = first;
  let bytes = 1;
  while (part & 128) {
    if (cursor.pos >= buffer.length || ++bytes > 8) fail("成交变长整数无效或被截断。");
    part = buffer[cursor.pos++];
    value += (part & 127) * factor;
    factor *= 128;
    if (!Number.isSafeInteger(value)) fail("成交数量超出可验证范围。");
  }
  return first & 64 ? -value : value;
}

export function parseTdxHistoryTransactions(body, requestedCount = PAGE_SIZE) {
  if (!Buffer.isBuffer(body) || body.length < 2) fail("成交响应缺少记录数量。");
  const count = body.readUInt16LE(0);
  if (count > requestedCount) fail("成交页超出请求数量，不能确认分页完整性。");
  if (!count) {
    if (![2, 6].includes(body.length)) fail("空成交响应格式无效。");
    return [];
  }
  if (body.length < 6) fail("成交响应头被截断。");
  const cursor = { pos: 6 };
  let price = 0;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor.pos + 2 > body.length) fail("成交时间字段被截断。");
    const minute = body.readUInt16LE(cursor.pos);
    cursor.pos += 2;
    price += readVarint(body, cursor);
    const vol = readVarint(body, cursor);
    const side = readVarint(body, cursor);
    const reserved = readVarint(body, cursor);
    if (minute > 1439 || !Number.isSafeInteger(price) || price <= 0 || vol < 0 || side < 0 || reserved !== 0)
      fail("成交时间、价格、数量或方向字段无效。");
    rows.push({ minute, price: price / 100, vol, side });
  }
  if (cursor.pos !== body.length) fail("成交响应含有未识别字段，不能确认分页完整性。");
  return rows;
}

class TdxConnection {
  constructor(socket, { timeoutMs, signal }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.failure = null;
    this.busy = false;
    this.abort = () => this.close(signal?.reason instanceof Error ? signal.reason : new Error("历史成交查询已取消。"));
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 131070) this.close(new Error("通达信响应超过协议最大长度。"));
      this.deliver();
    });
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => this.close(new Error("通达信连接在响应完成前关闭。")));
    signal?.addEventListener("abort", this.abort, { once: true });
  }
  deliver() {
    if (!this.waiter) return;
    if (this.failure) { const { reject } = this.waiter; this.waiter = null; reject(this.failure); }
    else if (this.buffer.length >= this.waiter.count) {
      const { resolve, count } = this.waiter;
      const result = this.buffer.subarray(0, count);
      this.buffer = this.buffer.subarray(count);
      this.waiter = null;
      resolve(result);
    }
  }
  read(count) {
    return new Promise((resolve, reject) => {
      if (this.waiter) { reject(new Error("通达信响应读取不能并行。")); return; }
      this.waiter = { count, resolve, reject };
      this.deliver();
    });
  }
  async request(packet) {
    checkAbort(this.signal);
    if (this.busy) fail("同一连接不能并行发送请求。");
    if (this.failure) throw this.failure;
    this.busy = true;
    const timer = setTimeout(() => this.close(new Error("通达信成交响应超时。")), this.timeoutMs);
    try {
      this.socket.write(packet);
      const header = await this.read(16);
      const compressedSize = header.readUInt16LE(12);
      const expandedSize = header.readUInt16LE(14);
      if (!compressedSize && expandedSize) fail("压缩响应长度无效。");
      const compressed = compressedSize ? await this.read(compressedSize) : Buffer.alloc(0);
      const body = compressedSize === expandedSize ? compressed
        : inflateSync(compressed, { maxOutputLength: expandedSize });
      if (body.length !== expandedSize) fail("响应解压长度不匹配。");
      return body;
    } catch (error) { this.close(error); throw error; }
    finally { clearTimeout(timer); this.busy = false; }
  }
  close(error = new Error("通达信连接已关闭。")) {
    if (!this.failure) this.failure = error;
    this.signal?.removeEventListener("abort", this.abort);
    this.socket.destroy();
    this.deliver();
  }
}

export async function connectTdxHistory(host, { timeoutMs = 5000, signal } = {}) {
  checkAbort(signal);
  const socket = net.createConnection({ host: host.host, port: host.port });
  const connection = new TdxConnection(socket, { timeoutMs, signal });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => connection.close(new Error("通达信历史服务器连接超时。")), timeoutMs);
      const clean = () => { clearTimeout(timer); socket.removeListener("connect", connected); socket.removeListener("error", failed); socket.removeListener("close", closed); };
      const connected = () => { clean(); resolve(); };
      const failed = (error) => { clean(); reject(error); };
      const closed = () => { clean(); reject(connection.failure || new Error("通达信连接已关闭。")); };
      socket.once("connect", connected);
      socket.once("error", failed);
      socket.once("close", closed);
    });
    socket.setNoDelay(true);
    for (const packet of SETUP_PACKETS) await connection.request(packet);
    return connection;
  } catch (error) { connection.close(error); throw error; }
}

export async function readTdxTradeSideDay(connection, { code, market, date, expectedTotalVol, close }, { now = Date.now, signal } = {}) {
  assertExactVolumeAvailable(code);
  if (!Number.isSafeInteger(expectedTotalVol) || expectedTotalVol <= 0 || !Number.isFinite(close) || close <= 0)
    fail("日线成交量或收盘价无效，不能验证完整历史。");
  const totals = { innerVol: 0, outerVol: 0, neutralVol: 0, unknownVol: 0, totalVol: 0, regularVol: 0, afterHoursVol: 0 };
  const unknownSides = {};
  const pageHashes = new Set();
  let start = 0;
  let tradeCount = 0;
  let pageCount = 0;
  let closingPrice = null;
  let closingMinute = -1;
  let earliestMinute = Infinity;
  let latestMinute = -1;
  while (true) {
    checkAbort(signal);
    if (start > MAX_POSITION) fail("成交记录超过协议分页位置上限，不能确认全天完整。");
    const body = await connection.request(buildTdxHistoryPacket({ code, market, date, start }));
    const ticks = parseTdxHistoryTransactions(body);
    pageCount += 1;
    if (!ticks.length) break;
    const hash = createHash("sha256").update(body).digest("hex");
    if (pageHashes.has(hash)) fail("历史成交接口重复返回同一页，不能确认全天完整。");
    pageHashes.add(hash);
    const findCloseInThisPage = closingPrice === null;
    let previousMinute = -1;
    for (const tick of ticks) {
      if (tick.minute < previousMinute) fail("历史成交页时间顺序无效，不能确认完整性。");
      previousMinute = tick.minute;
      const key = tick.side === 0 ? "outerVol" : tick.side === 1 ? "innerVol" : tick.side === 2 ? "neutralVol" : "unknownVol";
      totals[key] += tick.vol;
      totals.totalVol += tick.vol;
      if (tick.side > 2) unknownSides[tick.side] = (unknownSides[tick.side] || 0) + tick.vol;
      if (tick.minute <= 900) {
        totals.regularVol += tick.vol;
        // Pages are newest-first, but each page itself is oldest-first. Only
        // the first page with the latest regular minute may choose its close.
        if (findCloseInThisPage && tick.minute >= closingMinute) { closingMinute = tick.minute; closingPrice = tick.price; }
      } else { totals.afterHoursVol += tick.vol; }
      earliestMinute = Math.min(earliestMinute, tick.minute);
      latestMinute = Math.max(latestMinute, tick.minute);
      if (!Object.values(totals).every(Number.isSafeInteger)) fail("全天成交数量超出安全整数范围。");
    }
    tradeCount += ticks.length;
    start += ticks.length;
  }
  if (!tradeCount) fail(`${date} 没有可验证的历史成交记录。`);
  if (totals.regularVol !== expectedTotalVol)
    fail(`${date} 常规成交量与日线不一致（成交 ${totals.regularVol} 手，日线 ${expectedTotalVol} 手），未作为完整历史。`);
  if (Math.round(closingPrice * 100) !== Math.round(close * 100))
    fail(`${date} 最后常规成交价与日线收盘价不一致，未作为完整历史。`);
  const classifiedVol = totals.innerVol + totals.outerVol;
  if (!classifiedVol) fail(`${date} 没有有效的主动买卖成交方向。`);
  const netVol = totals.outerVol - totals.innerVol;
  const collectedAt = new Date(now()).toISOString();
  return {
    code, date, ...totals, unknownSides, netVol,
    netRatio: netVol / classifiedVol * 100,
    outerRatio: totals.outerVol / classifiedVol * 100,
    complete: true, validated: true, source: { ...TDX_HISTORY_SOURCE },
    method: "classified-transactions", tradeCount, quoteTime: null, collectedAt, close,
    quality: { validated: true, verification: tdxHistoryVerification(), paginationComplete: true, pageCount, expectedTotalVol,
      volumeDifference: totals.regularVol - expectedTotalVol, closingPrice,
      regularVol: totals.regularVol, afterHoursVol: totals.afterHoursVol,
      earliestMinute, latestMinute, classifiedVol },
  };
}

export function parseTradeSideDailyPlan(payload, code, { limit = 120, now = Date.now } = {}) {
  const symbol = code[0] === "6" ? `sh${code}` : `sz${code}`;
  const source = payload?.data?.[symbol];
  const bars = source?.day;
  if (String(payload?.code) !== "0" || !Array.isArray(bars)) fail("真实历史日线接口格式无效。");
  const shanghai = new Date(now() + SHANGHAI_OFFSET_MS);
  const today = shanghai.toISOString().slice(0, 10);
  const currentDayComplete = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes() >= 910;
  const byDate = new Map();
  for (const bar of bars) {
    const date = bar?.[0];
    const close = Number(bar?.[2]);
    const rawVolume = Number(bar?.[5]);
    const expectedTotalVol = tencentAshareVolumeToLots(bar?.[5], code);
    if (!validDate(date) || date > today || (date === today && !currentDayComplete)) continue;
    if (bar?.[2] == null || String(bar[2]).trim() === '' || bar?.[5] == null || String(bar[5]).trim() === ''
      || !Number.isFinite(close) || close <= 0 || !Number.isSafeInteger(rawVolume) || rawVolume < 0)
      fail(`${date} 日线缺少可验证的收盘价或总成交量。`);
    if (!expectedTotalVol) continue; // A suspension is not a recorded trading day.
    byDate.set(date, { code, market: code[0] === "6" ? 1 : 0, date, close, expectedTotalVol,
      sourceVolumeUnit: tencentAshareVolumeUnit(code),
      expectedTotalShares: tencentAshareVolumeUnit(code) === "share" ? rawVolume : rawVolume * 100 });
  }
  const plan = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
  if (!plan.length) fail("没有已收盘且有实际成交的交易日期。");
  return plan;
}

export async function fetchTdxTradeSideHistory({ code, limit = 120, now = Date.now, onDay, onProgress, signal,
  existingDates = [], request = globalThis.fetch, connect = connectTdxHistory, hosts = TDX_HISTORY_HOSTS,
  concurrency = 3, timeoutMs = 5000 } = {}) {
  if (!/^(?:6\d{5}|0\d{5}|3\d{5})$/.test(code)) fail("暂只支持沪深 A 股历史成交。");
  if (!Number.isInteger(limit) || limit < 1 || limit > 120 || !hosts.length) fail("历史查询范围或服务器无效。");
  assertExactVolumeAvailable(code);
  const planStartedAt = now();
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  checkAbort(signal);
  const symbol = code[0] === "6" ? `sh${code}` : `sz${code}`;
  // fqkline requires the sixth adjustment parameter, even when it is empty.
  // The empty value requests original prices for the close-price comparison.
  const params = new URLSearchParams({ param: `${symbol},day,,,${Math.min(limit + 30, 800)},` });
  const response = await request(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${params}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { Referer: "https://gu.qq.com/", "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) fail(`日线接口 HTTP ${response.status}。`);
  const plan = parseTradeSideDailyPlan(await response.json(), code, { limit, now: () => planStartedAt });
  const targetDates = plan.map((day) => day.date);
  const existing = new Set(existingDates);
  const remaining = plan.filter((day) => !existing.has(day.date)).reverse();
  const rows = [];
  const quality = { done: plan.length - remaining.length, total: plan.length,
    processed: plan.length - remaining.length, missingDates: [], errors: {},
    firstDate: plan[0].date, lastDate: plan.at(-1).date, targetDates };
  const progress = async () => { if (onProgress) await onProgress({ ...quality, missingDates: [...quality.missingDates], errors: { ...quality.errors } }); };
  await progress();
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), remaining.length) }, async () => {
    let connection = null;
    let hostIndex = 0;
    try {
      while (index < remaining.length) {
        checkAbort(signal);
        const day = remaining[index++];
        let row = null;
        let lastError = null;
        for (let attempt = 0; attempt < hosts.length; attempt += 1) {
          checkAbort(signal);
          try {
            if (!connection) connection = await connect(hosts[hostIndex], { timeoutMs, signal });
            row = await readTdxTradeSideDay(connection, day, { now, signal });
            break;
          } catch (error) {
            lastError = error;
            connection?.close();
            connection = null;
            hostIndex = (hostIndex + 1) % hosts.length;
          }
        }
        if (row) {
          if (onDay) await onDay(row); // Persistence failure must fail the job.
          rows.push(row);
          quality.done += 1;
        } else {
          checkAbort(signal);
          quality.missingDates.push(day.date);
          quality.errors[day.date] = lastError?.message || "历史成交查询失败。";
        }
        quality.processed += 1;
        await progress();
      }
    } finally { connection?.close(); }
  });
  // allSettled keeps sockets alive only until every worker has closed, including
  // when an async archive callback fails while other days are in flight.
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  rows.sort((a, b) => a.date.localeCompare(b.date));
  quality.missingDates.sort();
  return { code, rows, targetDates, quality };
}
