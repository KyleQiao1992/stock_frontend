import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEastmoneyIndustryProvider } from "./eastmoneyIndustryMap.js";

const NOW = Date.parse("2026-10-03T14:00:00Z");
const rows = [
  { SECUCODE: "000001.SZ", SECURITY_CODE: "000001", SECURITY_NAME_ABBR: "平安银行", BOARD_CODE: "475", BOARD_NAME: "银行Ⅱ", BOARD_TYPE: "行业", BOARD_LEVEL: "2" },
  { SECUCODE: "688610.SH", SECURITY_CODE: "688610", SECURITY_NAME_ABBR: "埃科光电", BOARD_CODE: "545", BOARD_NAME: "通用设备", BOARD_TYPE: "行业", BOARD_LEVEL: "2" },
  { SECUCODE: "689009.SH", SECURITY_CODE: "689009", SECURITY_NAME_ABBR: "九号公司", BOARD_CODE: "1325", BOARD_NAME: "其他交运设备Ⅱ", BOARD_TYPE: "行业", BOARD_LEVEL: "2" },
  { SECUCODE: "920002.BJ", SECURITY_CODE: "920002", SECURITY_NAME_ABBR: "万达轴承", BOARD_CODE: "545", BOARD_NAME: "通用设备", BOARD_TYPE: "行业", BOARD_LEVEL: "2" },
  { SECUCODE: "200011.SZ", SECURITY_CODE: "200011", SECURITY_NAME_ABBR: "深物业B", BOARD_CODE: "451", BOARD_NAME: "房地产开发", BOARD_TYPE: "行业", BOARD_LEVEL: "2" },
];

function source({ data = rows, transform, fail, listings } = {}) {
  const calls = [];
  const request = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, signal: options.signal });
    if (fail) return fail(parsed);
    const number = Number(parsed.searchParams.get("pageNumber"));
    const contents = parsed.searchParams.get("reportName") === "RPT_F10_BASIC_ORGINFO"
      ? listings || data.filter((row) => /^689\d{3}\.SH$/.test(row.SECUCODE)).map((row) => ({ SECUCODE: row.SECUCODE, SECURITY_CODE: row.SECURITY_CODE, LISTING_DATE: "2020-10-29 00:00:00" }))
      : data;
    let body = { success: true, result: { count: contents.length, pages: Math.ceil(contents.length / 10000), data: contents.slice((number - 1) * 10000, number * 10000) } };
    if (transform) body = transform(body, parsed);
    return { ok: true, json: async () => body };
  };
  return { calls, request };
}

function provider(fake, options = {}) {
  return createEastmoneyIndustryProvider({ request: fake.request, now: () => NOW, loadBundledSnapshot: async () => null, ...options });
}

test("uses Eastmoney level-two ownership, includes CDR/Beijing and excludes B shares", async () => {
  const fake = source();
  const result = await provider(fake)();
  assert.deepEqual(result.members.map((row) => row.symbol), ["sz000001", "sh688610", "sh689009", "bj920002"]);
  assert.equal(result.members[0].industry, "银行Ⅱ");
  assert.equal(result.members[0].industryCode, "BK0475");
  assert.equal(result.members[1].industry, "通用设备");
  assert.equal(result.classification, "东方财富行业");
  assert.equal(result.classificationSource, "eastmoney");
  assert.equal(result.classificationUpdatedAt, new Date(NOW).toISOString());
  assert.equal(result.report, "RPT_F10_CORETHEME_BOARDTYPE");
  assert.equal(result.level, 2);
  assert.equal(result.providerCount, 5);
  assert.equal(result.excludedNonA, 1);
  assert.equal(result.cached, false);
  assert.equal(result.classificationStale, false);
  assert.deepEqual(result.listedCdrs, [{ symbol: "sh689009", code: "689009", name: "九号公司", listingDate: "2020-10-29" }]);
  assert.equal(fake.calls[0].url.searchParams.get("filter"), '(BOARD_TYPE="行业")(BOARD_LEVEL="2")');
  assert.ok(fake.calls.every((call) => call.signal instanceof AbortSignal));
});

test("rejects empty, wrong-level, ambiguous, malformed and truncated maps wholesale", async () => {
  const cases = [
    source({ data: [] }),
    source({ data: [{ ...rows[0], BOARD_LEVEL: "3" }] }),
    source({ data: [{ ...rows[0], BOARD_TYPE: "板块" }] }),
    source({ data: [{ ...rows[0], SECUCODE: "000001.SH" }] }),
    source({ data: [{ ...rows[0], SECURITY_CODE: "600519" }] }),
    source({ data: [{ ...rows[0], BOARD_NAME: "" }] }),
    source({ data: [rows[0], rows[0]] }),
    source({ data: [rows[0], { ...rows[0], BOARD_NAME: "另一行业" }] }),
    source({ transform: (body) => ({ ...body, result: { ...body.result, count: 6 } }) }),
    source({ transform: (body) => ({ ...body, result: { ...body.result, pages: 2 } }) }),
    source({ transform: (body) => ({ ...body, success: false }) }),
  ];
  for (const fake of cases) {
    await assert.rejects(provider(fake)(), /行业/);
    assert.equal(fake.calls.length, 2);
  }
});

test("falls back to a second host and only caches complete success", async () => {
  const fake = source({ transform: (body, url) => url.hostname === "datacenter.eastmoney.com" ? { success: false } : body });
  const load = provider(fake);
  assert.equal((await load()).members.length, 4);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[1].url.hostname, "datacenter-web.eastmoney.com");
  assert.equal((await load()).cached, true);
  assert.equal(fake.calls.length, 3);
});

test("retrieves every page and rejects changes or missing later pages", async () => {
  const data = Array.from({ length: 10001 }, (_, index) => {
    const code = index < 10000 ? String(600000 + index) : "689009";
    return { ...rows[1], SECUCODE: `${code}.SH`, SECURITY_CODE: code };
  });
  const complete = source({ data });
  const result = await provider(complete)();
  assert.equal(result.members.length, data.length);
  assert.equal(complete.calls.length, 3);
  for (const change of [
    (body) => ({ ...body, result: { ...body.result, data: [] } }),
    (body) => ({ ...body, result: { ...body.result, count: 10002 } }),
  ]) {
    const broken = source({ data, transform: (body, url) => url.searchParams.get("pageNumber") === "2" ? change(body) : body });
    await assert.rejects(provider(broken)(), /行业/);
  }
});

test("six-hour cache preserves capture time, expires, and cannot be mutated by callers", async () => {
  let clock = NOW;
  const fake = source();
  const load = provider(fake, { now: () => clock });
  const first = await load();
  first.members[0].industry = "incorrect mutation";
  clock += 6 * 60 * 60 * 1000 - 1;
  const cached = await load();
  assert.equal(cached.cached, true);
  assert.equal(cached.classificationUpdatedAt, new Date(NOW).toISOString());
  assert.equal(cached.members[0].industry, "银行Ⅱ");
  assert.equal(fake.calls.length, 2);
  clock += 1;
  const next = await load();
  assert.equal(next.cached, false);
  assert.equal(next.classificationUpdatedAt, new Date(clock).toISOString());
  assert.equal(fake.calls.length, 4);
});

test("concurrent calls share one complete in-flight request", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const fake = source();
  const request = async (...args) => { await wait; return fake.request(...args); };
  const load = provider({ request });
  const first = load();
  const second = load();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.equal(fake.calls.length, 2);
});

test("failure uses the verified bundle without falsely renewing its timestamp", async () => {
  const bundle = JSON.parse(readFileSync(new URL("./data/ashare-industries.json", import.meta.url), "utf8"));
  const fake = source({ fail: async () => ({ ok: false, status: 403 }) });
  const load = createEastmoneyIndustryProvider({ request: fake.request, now: () => NOW });
  const first = await load();
  assert.equal(first.classificationUpdatedAt, bundle.classificationUpdatedAt);
  assert.equal(first.members.length, 5579);
  assert.equal(first.providerCount, 5658);
  assert.equal(first.excludedNonA, 79);
  assert.equal(new Set(first.members.map((row) => row.symbol)).size, first.members.length);
  assert.equal(first.classificationStale, true);
  assert.equal(first.cached, true);
  assert.equal(first.members.find((row) => row.code === "600519").industry, "白酒Ⅱ");
  await load();
  assert.equal(fake.calls.length, 4); // A failed network request must not become a six-hour fresh cache.
});

test("an expired successful map is retained on failure with its original capture time", async () => {
  let clock = NOW;
  let failed = false;
  const fake = source();
  const load = provider({ request: (...args) => failed ? Promise.reject(new Error("network failure")) : fake.request(...args) }, { now: () => clock });
  await load();
  clock += 6 * 60 * 60 * 1000;
  failed = true;
  const result = await load();
  assert.equal(result.classificationStale, true);
  assert.equal(result.classificationUpdatedAt, new Date(NOW).toISOString());
  assert.equal(result.members.length, 4);
});

test("aborted calls do not silently return bundled classification", async () => {
  const controller = new AbortController();
  const fake = source({ fail: async () => { controller.abort(new Error("cancelled")); throw new Error("network failure"); } });
  const load = createEastmoneyIndustryProvider({ request: fake.request, now: () => NOW });
  await assert.rejects(load({ signal: controller.signal }), /cancelled/);
  assert.equal(fake.calls.length, 1);
});

test("invalid or future-dated bundled metadata is not accepted", async () => {
  const bundle = JSON.parse(readFileSync(new URL("./data/ashare-industries.json", import.meta.url), "utf8"));
  const fake = source({ fail: async () => ({ ok: false, status: 403 }) });
  for (const bad of [{ ...bundle, level: 3 }, { ...bundle, providerCount: 1 }, { ...bundle, classificationUpdatedAt: new Date(NOW + 1).toISOString() }]) {
    await assert.rejects(provider(fake, { loadBundledSnapshot: async () => bad })(), /HTTP 403/);
  }
});

test("CDR supplements require a valid listing date on or before the Shanghai calendar date", async () => {
  const data = [rows[2], { ...rows[2], SECUCODE: "689010.SH", SECURITY_CODE: "689010" }, { ...rows[2], SECUCODE: "689011.SH", SECURITY_CODE: "689011" }];
  const listings = [
    { SECUCODE: "689009.SH", SECURITY_CODE: "689009", LISTING_DATE: "2020-10-29 00:00:00" },
    { SECUCODE: "689010.SH", SECURITY_CODE: "689010", LISTING_DATE: "2026-10-04 00:00:00" },
    { SECUCODE: "689011.SH", SECURITY_CODE: "689011", LISTING_DATE: null },
  ];
  const fake = source({ data, listings });
  const result = await provider(fake)();
  assert.equal(result.members.length, 3); // Classification remains complete for future/unconfirmed listings.
  assert.deepEqual(result.listedCdrs.map((row) => row.symbol), ["sh689009"]);
  assert.equal(result.cdrListingReport, "RPT_F10_BASIC_ORGINFO");
  assert.equal(fake.calls.filter((row) => row.url.searchParams.get("reportName") === "RPT_F10_BASIC_ORGINFO").length, 1);
  assert.equal(fake.calls[1].url.searchParams.get("filter"), '(SECURITY_CODE in ("689009","689010","689011"))');
  const nextDay = await provider(source({ data, listings }), { now: () => Date.parse("2026-10-03T18:00:00Z") })();
  assert.deepEqual(nextDay.listedCdrs.map((row) => row.symbol), ["sh689009", "sh689010"]);
});

test("without CDR members no listing report is requested", async () => {
  const fake = source({ data: [rows[0], rows[1], rows[3]] });
  const result = await provider(fake)();
  assert.deepEqual(result.listedCdrs, []);
  assert.deepEqual(result.cdrListingDates, []);
  assert.equal(fake.calls.length, 1);
});

test("CDR listing ownership, dates, duplicates, and coverage are checked before caching", async () => {
  const record = { SECUCODE: "689009.SH", SECURITY_CODE: "689009", LISTING_DATE: "2020-10-29 00:00:00" };
  for (const listings of [
    [],
    [{ ...record, SECUCODE: "689010.SH", SECURITY_CODE: "689010" }],
    [{ ...record, SECURITY_CODE: "689010" }],
    [{ ...record, LISTING_DATE: "2026-02-30 00:00:00" }],
    [{ ...record, LISTING_DATE: undefined }],
    [record, record],
  ]) {
    await assert.rejects(provider(source({ data: [rows[2]], listings }))(), /行业|CDR/);
  }
  const twoMembers = [rows[2], { ...rows[2], SECUCODE: "689010.SH", SECURITY_CODE: "689010" }];
  await assert.rejects(provider(source({ data: twoMembers, listings: [record, record] }))(), /唯一性/);
});

test("a failed listing query uses jointly verified bundled evidence and keeps both capture times", async () => {
  const bundle = JSON.parse(readFileSync(new URL("./data/ashare-industries.json", import.meta.url), "utf8"));
  const fake = source({ transform: (body, url) => url.searchParams.get("reportName") === "RPT_F10_BASIC_ORGINFO" ? { success: false } : body });
  const result = await createEastmoneyIndustryProvider({ request: fake.request, now: () => NOW })();
  assert.equal(result.classificationStale, true);
  assert.equal(result.classificationUpdatedAt, bundle.classificationUpdatedAt);
  assert.equal(result.cdrListingUpdatedAt, bundle.cdrListingUpdatedAt);
  assert.deepEqual(result.listedCdrs, [{ symbol: "sh689009", code: "689009", name: "九号公司", listingDate: "2020-10-29" }]);
  const missingEvidence = { ...bundle, cdrListingDates: [] };
  await assert.rejects(provider(fake, { loadBundledSnapshot: async () => missingEvidence })(), /行业/);
});
