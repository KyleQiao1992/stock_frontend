import { readFileSync } from "node:fs";

// This report exposes the same level-two Eastmoney industry membership as f100.
// EM2016 company-profile categories and third-party industries are different.
const REPORT = "RPT_F10_CORETHEME_BOARDTYPE";
const LISTING_REPORT = "RPT_F10_BASIC_ORGINFO";
const CLASSIFICATION = "东方财富行业";
const HOSTS = ["https://datacenter.eastmoney.com", "https://datacenter-web.eastmoney.com"];
const PAGE_SIZE = 10000;
const MAX_ROWS = 20000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json", Referer: "https://data.eastmoney.com/" };
const A_SYMBOL = /^(?:sh(?:60|68)\d{4}|sz(?:00|30)\d{4}|bj(?:[48]\d{5}|920\d{3}))$/;
const B_SYMBOL = /^(?:sh900\d{3}|sz20\d{4})$/;
const CDR_SYMBOL = /^sh689\d{3}$/;

async function defaultLoadBundledSnapshot() {
  return JSON.parse(readFileSync(new URL("./data/ashare-industries.json", import.meta.url), "utf8"));
}

function invalid(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "EASTMONEY_CLASSIFICATION_INVALID", stage: "industry-map" });
}

function text(value, max = 160) {
  return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;
}

function parseMembers(rows) {
  const seen = new Set();
  const members = [];
  for (const row of rows) {
    const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(row?.SECUCODE || "");
    if (!match || row.SECURITY_CODE !== match[1] || row.BOARD_TYPE !== "行业" || String(row.BOARD_LEVEL) !== "2") {
      throw invalid("东方财富行业归属身份或层级无效");
    }
    const symbol = { SH: "sh", SZ: "sz", BJ: "bj" }[match[2]] + match[1];
    const name = text(row.SECURITY_NAME_ABBR);
    const industry = text(row.BOARD_NAME, 100);
    const board = String(row.BOARD_CODE || "");
    if (!name || !industry || !/^\d{3,6}$/.test(board) || (!A_SYMBOL.test(symbol) && !B_SYMBOL.test(symbol))) {
      throw invalid("东方财富行业归属字段无效");
    }
    // Duplicate ownership is invalid even when the duplicate repeats one label.
    if (seen.has(symbol)) throw invalid("东方财富行业归属重复或包含多个行业");
    seen.add(symbol);
    if (A_SYMBOL.test(symbol)) {
      members.push({ symbol, code: match[1], name, industry, industryCode: `BK${board.padStart(4, "0")}` });
    }
  }
  if (!members.length) throw invalid("东方财富A股行业归属为空");
  return members;
}

function listingDate(value) {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?: 00:00:00)?$/.exec(value || "");
  const ms = match && Date.parse(`${match[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== match[1]) {
    throw invalid("东方财富CDR上市日期无效");
  }
  return match[1];
}

function confirmedCdrs(members, records, now) {
  const cdrs = new Map(members.filter((row) => CDR_SYMBOL.test(row.symbol)).map((row) => [row.symbol, row]));
  if (!Array.isArray(records) || records.length !== cdrs.size) throw invalid("东方财富CDR上市信息覆盖不完整");
  const seen = new Set();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const listed = [];
  for (const row of records) {
    const member = cdrs.get(row?.symbol);
    if (!member || row.code !== member.code || seen.has(row.symbol)) throw invalid("东方财富CDR上市信息身份或唯一性无效");
    seen.add(row.symbol);
    const date = listingDate(row.listingDate);
    if (date && date <= today) listed.push({ symbol: member.symbol, code: member.code, name: member.name, listingDate: date });
  }
  return listed;
}

function validateBundled(value, now) {
  const at = Date.parse(value?.classificationUpdatedAt);
  if (value?.classification !== CLASSIFICATION || value.classificationSource !== "eastmoney" || value.report !== REPORT
    || value.level !== 2 || !Number.isFinite(at) || at > now || !Array.isArray(value.members)
    || value.members.length === 0 || value.members.length > MAX_ROWS
    || !Number.isSafeInteger(value.providerCount) || value.providerCount > MAX_ROWS
    || !Number.isSafeInteger(value.excludedNonA) || value.excludedNonA < 0
    || value.providerCount !== value.members.length + value.excludedNonA) return null;
  const seen = new Set();
  for (const row of value.members) {
    if (!A_SYMBOL.test(row?.symbol || "") || row.code !== row.symbol.slice(2) || !text(row.name)
      || !text(row.industry, 100) || !/^BK\d{4,6}$/.test(row.industryCode || "") || seen.has(row.symbol)) return null;
    seen.add(row.symbol);
  }
  try {
    const listedCdrs = confirmedCdrs(value.members, value.cdrListingDates, now);
    const listingAt = Date.parse(value.cdrListingUpdatedAt);
    if (value.cdrListingDates.length && (!Number.isFinite(listingAt) || listingAt > now || value.cdrListingReport !== LISTING_REPORT)) return null;
    return { ...value, listedCdrs };
  } catch { return null; }
}

/** Load a complete level-two map. Classification freshness never changes quote timestamps. */
export function createEastmoneyIndustryProvider({ request = fetch, now = Date.now, budgetMs = 10000,
  loadBundledSnapshot = defaultLoadBundledSnapshot } = {}) {
  let lastGood = null;
  let inflight = null;

  async function retrieve(signal) {
    const deadline = now() + budgetMs;
    let lastError;
    for (const host of HOSTS) {
      if (signal?.aborted) throw signal.reason || new Error("行业查询已取消");
      if (now() >= deadline) break;
      try {
        async function page(number, listingCodes = null) {
          const remaining = deadline - now();
          if (remaining <= 0) throw invalid("东方财富行业查询超时");
          const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5000, remaining))));
          const params = new URLSearchParams({ reportName: listingCodes ? LISTING_REPORT : REPORT,
            columns: listingCodes ? "SECUCODE,SECURITY_CODE,LISTING_DATE" : "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,BOARD_CODE,BOARD_NAME,BOARD_TYPE,BOARD_LEVEL",
            filter: listingCodes ? `(SECURITY_CODE in (${listingCodes.map((code) => `"${code}"`).join(",")}))` : '(BOARD_TYPE="行业")(BOARD_LEVEL="2")', pageSize: String(PAGE_SIZE), pageNumber: String(number),
            sortColumns: "SECURITY_CODE", sortTypes: "1", source: "WEB", client: "WEB" });
          const response = await request(`${host}/api/data/v1/get?${params}`, { headers: HEADERS,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
          if (!response.ok) throw Object.assign(new Error(`东方财富行业 HTTP ${response.status}`), {
            code: "EASTMONEY_CLASSIFICATION_HTTP_ERROR", stage: "industry-map", status: response.status,
          });
          const body = await response.json();
          const result = body?.result;
          if (body?.success !== true || !Number.isSafeInteger(result?.count) || result.count <= 0 || result.count > MAX_ROWS
            || result.pages !== Math.ceil(result.count / PAGE_SIZE) || !Array.isArray(result.data)) {
            throw invalid("东方财富行业列表数量或格式无效");
          }
          if (result.data.length !== Math.min(PAGE_SIZE, result.count - (number - 1) * PAGE_SIZE)) {
            throw invalid("东方财富行业分页不完整");
          }
          return result;
        }
        const first = await page(1);
        const rows = [...first.data];
        for (let number = 2; number <= first.pages; number += 1) {
          const next = await page(number);
          if (next.count !== first.count || next.pages !== first.pages) throw invalid("东方财富行业分页总数变化");
          rows.push(...next.data);
        }
        if (rows.length !== first.count) throw invalid("东方财富行业列表不完整");
        const members = parseMembers(rows);
        const cdrMembers = members.filter((row) => CDR_SYMBOL.test(row.symbol));
        let cdrListingDates = [];
        if (cdrMembers.length) {
          const listings = await page(1, cdrMembers.map((row) => row.code));
          if (listings.count !== cdrMembers.length || listings.pages !== 1) throw invalid("东方财富CDR上市信息覆盖不完整");
          cdrListingDates = listings.data.map((row) => {
            if (!/^689\d{3}\.SH$/.test(row?.SECUCODE || "") || row.SECURITY_CODE !== row.SECUCODE.slice(0, 6)) {
              throw invalid("东方财富CDR上市信息身份无效");
            }
            return { symbol: `sh${row.SECURITY_CODE}`, code: row.SECURITY_CODE, listingDate: listingDate(row.LISTING_DATE) };
          });
        }
        const listedCdrs = confirmedCdrs(members, cdrListingDates, now());
        const result = { members, classification: CLASSIFICATION, classificationSource: "eastmoney",
          classificationUpdatedAt: new Date(now()).toISOString(), report: REPORT, level: 2,
          listedCdrs, cdrListingDates, cdrListingReport: LISTING_REPORT,
          cdrListingUpdatedAt: cdrMembers.length ? new Date(now()).toISOString() : null,
          providerCount: rows.length, excludedNonA: rows.length - members.length, cached: false, classificationStale: false };
        lastGood = result;
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        lastError = error;
      }
    }
    let bundled = null;
    try { bundled = validateBundled(await loadBundledSnapshot(), now()); } catch { /* Preserve a previous successful map if the bundle cannot be read. */ }
    const previous = lastGood && Date.parse(lastGood.classificationUpdatedAt) <= now() ? lastGood : null;
    const fallback = previous && (!bundled || Date.parse(previous.classificationUpdatedAt) >= Date.parse(bundled.classificationUpdatedAt))
      ? previous : bundled;
    if (!fallback) throw lastError || invalid("东方财富行业数据源不可用");
    // Never relabel a failed request as a new classification fetch or cache it as fresh.
    return { ...fallback, listedCdrs: confirmedCdrs(fallback.members, fallback.cdrListingDates, now()), cached: true, classificationStale: true };
  }

  return async function loadIndustries({ signal } = {}) {
    if (signal?.aborted) throw signal.reason || new Error("行业查询已取消");
    const age = lastGood && now() - Date.parse(lastGood.classificationUpdatedAt);
    if (lastGood && age >= 0 && age < CACHE_MS) return structuredClone({ ...lastGood,
      listedCdrs: confirmedCdrs(lastGood.members, lastGood.cdrListingDates, now()), cached: true });
    if (!inflight) inflight = retrieve(signal).finally(() => { inflight = null; });
    return structuredClone(await inflight);
  };
}

export const loadEastmoneyIndustryMap = createEastmoneyIndustryProvider();
