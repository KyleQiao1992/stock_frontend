import test from "node:test";
import assert from "node:assert/strict";
import { loadSinaDaySnapshot } from "./sinaBoardFundflowSnapshot.js";

const DATA_DATE = "2026-09-30";
const NOW = Date.parse("2026-10-02T12:00:00Z");

function fakeSource(boards, records) {
  const calls = [];
  const request = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith("newFLJK.php")) {
      const list = Object.fromEntries(boards.map(({ code, name }) => [code, `${code},${name},1`]));
      const text = `var S_Finance_bankuai_class = ${JSON.stringify(list)};`;
      // Theme labels are ASCII here; the filtering test supplies an actual GBK fixture.
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    }
    const rows = records[parsed.searchParams.get("bankuai")] || [];
    return { ok: true, json: async () => rows };
  };
  return { calls, request };
}

function board(code, name = "Theme") { return { code: `gn_${code}`, name }; }
function row(r0_net, opendate = DATA_DATE, extras = {}) { return { opendate, r0_net, ...extras }; }

test("uses direct main net amount, keeps the provider date, and creates one snapshot point", async () => {
  const source = fakeSource([board("hwqc", "Huawei")], {
    gn_hwqc: [row("1078258856.4300", DATA_DATE, { netamount: "666753029.1500" })],
  });
  const data = await loadSinaDaySnapshot({ request: source.request, now: () => NOW });
  assert.equal(data.source, "sina");
  assert.equal(data.mode, "daily-snapshot");
  assert.equal(data.dim, "day");
  assert.equal(data.dataDate, DATA_DATE);
  assert.equal(data.asOf, DATA_DATE);
  assert.equal(data.date, null);
  assert.equal(data.updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(data.coverage, { available: 1, total: 1 });
  assert.ok(Math.abs(data.series[0].final - 10.7825885643) < 1e-12);
  assert.equal(data.series[0].points.length, 1);
  assert.equal(data.series[0].points[0].t, DATA_DATE);
  assert.ok(Math.abs(data.series[0].points[0].v - 10.7825885643) < 1e-12);
  assert.equal(source.calls[1].searchParams.get("num"), "1");
});

test("historical selection requires the exact date and never substitutes an earlier trading day", async () => {
  const source = fakeSource([board("a"), board("b")], {
    gn_a: [row(300, "2026-09-30"), row(-200, "2026-09-29")],
    gn_b: [row(500, "2026-09-30"), row(100, "2026-09-28")],
  });
  const data = await loadSinaDaySnapshot({ date: "2026-09-29", request: source.request, now: () => NOW });
  assert.equal(data.count, 1);
  assert.equal(data.dataDate, "2026-09-29");
  assert.equal(data.series[0].code, "gn_a");
  assert.deepEqual(data.series[0].points, [{ t: "2026-09-29", v: -0.000002 }]);
  assert.equal(source.calls[1].searchParams.get("num"), "120");
  await assert.rejects(
    loadSinaDaySnapshot({ date: "2026-10-01", request: source.request, now: () => NOW }),
    /2026-10-01 无可用/,
  );
});

test("invalid missing amounts cannot become artificial zero inflows", async () => {
  const invalid = [null, "", "  ", undefined, "-", "Infinity", Infinity, NaN, true];
  const boards = invalid.map((_, index) => board(`invalid${index}`)).concat(board("zero"));
  const records = Object.fromEntries(invalid.map((value, index) => [`gn_invalid${index}`, [row(value)]]));
  records.gn_zero = [row("0")];
  const source = fakeSource(boards, records);
  const data = await loadSinaDaySnapshot({ request: source.request, now: () => NOW });
  assert.equal(data.count, 1);
  assert.equal(data.series[0].code, "gn_zero");
  assert.equal(data.series[0].final, 0);
  assert.deepEqual(data.coverage, { available: 1, total: 10 });
});

test("aligns all ranked snapshots to the newest valid provider date", async () => {
  const source = fakeSource([board("a"), board("b"), board("c")], {
    gn_a: [row(300, "2026-09-30")],
    gn_b: [row(999999999, "2026-09-29")],
    gn_c: [row(-200, "2026-09-30")],
  });
  const data = await loadSinaDaySnapshot({ request: source.request, now: () => NOW });
  assert.deepEqual(data.series.map((item) => item.code), ["gn_a", "gn_c"]);
  assert.deepEqual(data.coverage, { available: 2, total: 3 });
  assert.ok(data.series.every((item) => item.points.length === 1 && item.points[0].t === DATA_DATE));
});

test("takes both ranked ends without duplicate boards", async () => {
  const boards = Array.from({ length: 8 }, (_, index) => board(String(index)));
  const records = Object.fromEntries(boards.map((item, index) => [item.code, [row((index - 4) * 1e8)]]));
  const source = fakeSource(boards, records);
  const data = await loadSinaDaySnapshot({ top: 3, request: source.request, now: () => NOW });
  assert.equal(data.count, 6);
  assert.deepEqual(data.series.map((item) => item.final), [3, 2, 1, -2, -3, -4]);
  assert.equal(new Set(data.series.map((item) => item.code)).size, 6);
  const small = fakeSource(boards.slice(0, 4), records);
  const sparse = await loadSinaDaySnapshot({ top: 3, request: small.request, now: () => NOW });
  assert.equal(sparse.count, 4);
  assert.equal(new Set(sparse.series.map((item) => item.code)).size, 4);
});

test("excludes aggregate concepts and deduplicates provider board codes before querying", async () => {
  const calls = [];
  // GBK: 融资融券. Using actual source encoding also checks the GBK decoder.
  const aggregateName = Uint8Array.from([0xc8, 0xda, 0xd7, 0xca, 0xc8, 0xda, 0xc8, 0xaf]);
  const prefix = new TextEncoder().encode('var list = {"gn_a":"gn_a,');
  const suffix = new TextEncoder().encode(',1","gn_b":"gn_b,Theme,1","gn_b":"gn_b,Theme,1"};');
  const encoded = new Uint8Array(prefix.length + aggregateName.length + suffix.length);
  encoded.set(prefix); encoded.set(aggregateName, prefix.length); encoded.set(suffix, prefix.length + aggregateName.length);
  const request = async (url) => {
    if (url.includes("newFLJK")) return { ok: true, arrayBuffer: async () => encoded.buffer };
    calls.push(new URL(url).searchParams.get("bankuai"));
    return { ok: true, json: async () => [row(10)] };
  };
  const data = await loadSinaDaySnapshot({ request, now: () => NOW });
  assert.deepEqual(calls, ["gn_b"]);
  assert.deepEqual(data.coverage, { available: 1, total: 1 });
});

test("empty or malformed provider data throws instead of returning a made-up chart", async () => {
  const source = fakeSource([board("a")], { gn_a: [row(null), row(100, "2026-02-30")] });
  await assert.rejects(loadSinaDaySnapshot({ request: source.request, now: () => NOW }), /快照不可用/);
  await assert.rejects(loadSinaDaySnapshot({ date: "2026-02-30", request: source.request, now: () => NOW }), /日期无效/);
});

test("caps active daily requests at ten and stops starting requests after the budget expires", async () => {
  const boards = Array.from({ length: 15 }, (_, index) => board(String(index)));
  const source = fakeSource(boards, {});
  let active = 0;
  let peak = 0;
  const request = async (url, options) => {
    if (url.includes("newFLJK")) return source.request(url, options);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { ok: true, json: async () => [row(100)] };
  };
  await loadSinaDaySnapshot({ request, now: () => NOW });
  assert.equal(peak, 10);
  const expired = fakeSource(boards, {});
  let time = NOW;
  const delayedList = async (url, options) => {
    const result = await expired.request(url, options);
    time += 25001;
    return result;
  };
  await assert.rejects(loadSinaDaySnapshot({ request: delayedList, now: () => time }), /快照不可用/);
  assert.equal(expired.calls.length, 1);
});
