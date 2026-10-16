import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDailyPackageLoader, createDirectTradeSideHistoryService,
  fetchDailyTradeSidePlan } from "./directTradeSideHistory.js";
import { tradeSideHistoryArchive } from "./tradeSideHistoryArchive.js";

// These small records are synthetic provider responses for task orchestration
// tests. Actual downloaded quantities are tested separately with source fixtures.
const NOW = Date.parse("2026-10-14T08:00:00Z");
const DATES = ["2026-10-09", "2026-10-12", "2026-10-13"];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the test history job");
    await new Promise(resolve => setImmediate(resolve));
  }
}
async function finish(service, code = "688610", limit = 3) {
  let result;
  await waitFor(async () => {
    result = await service.query(code, limit);
    return result.history.status !== "loading";
  });
  return result;
}
const planFor = (code, dates) => dates.map(date => ({ code, date, close: 1,
  expectedTotalShares: 1000, expectedTotalVol: 10, sourceVolumeUnit: "share" }));
const parseFake = (_data, { code, date, now }) => ({ code, date, complete: true,
  validated: true, source: "tdx-daily", quoteTime: null, close: 1,
  totalVol: 10, innerVol: 6, outerVol: 4, unknownVol: 0, netVol: -2,
  netRatio: -20, outerRatio: 40, collectedAt: new Date(now()).toISOString(),
  sourceVolumes: { totalShares: 1000, innerShares: 600, outerShares: 400, unclassifiedShares: 0 },
  quality: { validated: true } });
function fakeService(overrides = {}) {
  return createDirectTradeSideHistoryService({ now: () => NOW,
    fetchPlan: async (code, limit) => planFor(code, DATES.slice(-limit)),
    loadPackage: async date => Buffer.from(date), parsePackage: parseFake, ...overrides });
}

test("direct history loads older provider dates asynchronously without consulting the Redis archive", async t => {
  let redisCalls = 0;
  t.mock.method(tradeSideHistoryArchive, "query", async () => {
    redisCalls++;
    throw new Error("Redis is unavailable");
  });
  const gate = deferred();
  const service = fakeService({ loadPackage: async date => { await gate.promise; return Buffer.from(date); } });
  t.after(() => service.dispose());
  const first = await service.query("688610", 3);
  assert.equal(first.history.status, "loading");
  assert.deepEqual(first.rows, []);
  gate.resolve();
  const result = await finish(service);
  assert.equal(result.history.status, "complete");
  assert.deepEqual(result.rows.map(row => row.date), DATES);
  assert.ok(result.rows.every(row => row.quoteTime === null && row.complete));
  assert.equal(result.history.done, 3);
  assert.equal(result.collection.persisted, false);
  assert.equal(result.collection.storage, "official-daily-file-cache");
  assert.equal(result.verification.exchangeDirectionVerified, false);
  assert.equal(redisCalls, 0);
});

test("concurrent queries for one stock share a task and download each date once", async t => {
  const gate = deferred();
  let planCalls = 0;
  const loaded = [];
  const service = fakeService({ fetchPlan: async (code, limit) => {
    planCalls++;
    return planFor(code, DATES.slice(-limit));
  }, loadPackage: async date => { loaded.push(date); await gate.promise; return Buffer.from(date); } });
  t.after(() => service.dispose());
  const results = await Promise.all(Array.from({ length: 6 }, () => service.query("688610", 3)));
  assert.ok(results.every(result => result.history.status === "loading"));
  assert.equal(planCalls, 1);
  gate.resolve();
  const result = await finish(service);
  assert.equal(result.rows.length, 3);
  assert.deepEqual([...loaded].sort(), DATES);
  assert.equal(planCalls, 1);
});

test("a larger limit requested during loading extends the task without downloading a saved date twice", async t => {
  const gate = deferred();
  const limits = [];
  const loaded = [];
  const service = fakeService({ fetchPlan: async (code, limit) => {
    limits.push(limit);
    return planFor(code, DATES.slice(-limit));
  }, loadPackage: async date => { loaded.push(date); await gate.promise; return Buffer.from(date); } });
  t.after(() => service.dispose());
  await service.query("688610", 1);
  await service.query("688610", 3);
  gate.resolve();
  const result = await finish(service);
  assert.deepEqual(limits, [1, 3]);
  assert.equal(result.history.total, 3);
  assert.equal(result.history.done, 3);
  assert.deepEqual([...loaded].sort(), DATES);
  assert.deepEqual(result.rows.map(row => row.date), DATES);
});

test("a failed date stays missing and retries only that date after the retry interval", async t => {
  let clock = NOW;
  let failed = true;
  const loaded = [];
  const service = fakeService({ now: () => clock, loadPackage: async date => {
    loaded.push(date);
    if (date === DATES[1] && failed) throw new Error("test upstream missing package");
    return Buffer.from(date);
  } });
  t.after(() => service.dispose());
  const partial = await finish(service);
  assert.equal(partial.history.status, "error");
  assert.equal(partial.history.done, 2);
  assert.equal(partial.history.processed, 3);
  assert.deepEqual(partial.history.missingDates, [DATES[1]]);
  assert.match(partial.history.errors[DATES[1]], /missing package/);
  assert.deepEqual(partial.rows.map(row => row.date), [DATES[0], DATES[2]]);
  await service.query("688610", 3);
  assert.equal(loaded.length, 3);
  failed = false;
  clock += 60001;
  const recovered = await finish(service);
  assert.equal(recovered.history.status, "complete");
  assert.equal(recovered.rows.length, 3);
  assert.equal(loaded.filter(date => date === DATES[1]).length, 2);
  assert.equal(loaded.filter(date => date === DATES[0]).length, 1);
  assert.equal(loaded.filter(date => date === DATES[2]).length, 1);
});

test("parser identity and validation failures are reported per date and never added to rows", async t => {
  const service = fakeService({ parsePackage: (data, options) => {
    const row = parseFake(data, options);
    if (options.date === DATES[0]) row.code = "600519";
    if (options.date === DATES[1]) row.quality.validated = false;
    return row;
  } });
  t.after(() => service.dispose());
  const result = await finish(service);
  assert.equal(result.history.status, "error");
  assert.deepEqual(result.history.missingDates, DATES.slice(0, 2));
  assert.equal(result.history.done, 1);
  assert.deepEqual(result.rows.map(row => row.date), [DATES[2]]);
});

test("an unclosed current date is refused even if an injected plan claims it is ready", async t => {
  const service = fakeService({ now: () => Date.parse("2026-10-14T07:09:59Z"),
    fetchPlan: async code => planFor(code, ["2026-10-14"]),
    loadPackage: async () => { assert.fail("The unclosed day must not be downloaded"); } });
  t.after(() => service.dispose());
  const result = await finish(service, "688610", 1);
  assert.equal(result.history.status, "error");
  assert.deepEqual(result.rows, []);
  assert.match(result.history.error, /未收盘/);
});

test("the same stock refreshes its plan across the closing cutoff and reuses older dates", async t => {
  let clock = Date.parse("2026-10-14T07:09:59Z");
  const loaded = [];
  let plans = 0;
  const service = fakeService({ now: () => clock,
    fetchPlan: async code => {
      plans++;
      return planFor(code, clock < Date.parse("2026-10-14T07:10:00Z")
        ? ["2026-10-13"] : ["2026-10-13", "2026-10-14"]);
    }, loadPackage: async date => { loaded.push(date); return Buffer.from(date); } });
  t.after(() => service.dispose());
  assert.deepEqual((await finish(service, "688610", 2)).rows.map(row => row.date), ["2026-10-13"]);
  clock = Date.parse("2026-10-14T07:10:00Z");
  const refreshed = await finish(service, "688610", 2);
  assert.deepEqual(refreshed.rows.map(row => row.date), ["2026-10-13", "2026-10-14"]);
  assert.equal(plans, 2);
  assert.deepEqual(loaded, ["2026-10-13", "2026-10-14"]);
});

test("the daily plan freezes the request time so a response crossing 15:10 cannot promote a session", async () => {
  let clock = Date.parse("2026-10-14T07:09:59Z");
  const plans = await fetchDailyTradeSidePlan("688610", 3, { now: () => clock,
    request: async url => {
      assert.equal(new URL(url).searchParams.get("param"), "sh688610,day,,,33,");
      clock = Date.parse("2026-10-14T07:10:01Z");
      return { ok: true, json: async () => ({ code: 0, data: { sh688610: { day: [
        ["2026-10-13", "1", "1", "1", "1", "1000"],
        ["2026-10-14", "1", "1", "1", "1", "1000"],
      ] } } }) };
    } });
  assert.deepEqual(plans.map(day => day.date), ["2026-10-13"]);
  assert.equal(plans[0].expectedTotalShares, 1000);
});

// A tiny valid, synthetic paired ZIP exercises download/cache handling. It is
// not a fixture representing actual market history or quantities.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function packageFor(date = "2026-10-13") {
  const suffix = date.replaceAll("-", "").slice(2);
  const cod = Buffer.alloc(150); cod.write("688610", 0, "ascii");
  const md1 = Buffer.alloc(512);
  md1.writeDoubleLE(1, 36); md1.writeUInt32LE(161459, 44);
  md1.writeBigUInt64LE(1000n, 56); md1.writeBigUInt64LE(600n, 80); md1.writeBigUInt64LE(400n, 88);
  const entries = [[`sh${suffix}.cod`, cod], [`sh${suffix}.md1`, md1]];
  const blocks = [], directory = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const filename = Buffer.from(name);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    blocks.push(local, filename, body); directory.push(central, filename);
    offset += local.length + filename.length + body.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...blocks, central, end]);
}
function streamed(data, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    const split = Math.floor(data.length / 3);
    controller.enqueue(data.subarray(0, split));
    controller.enqueue(data.subarray(split, split * 2));
    controller.enqueue(data.subarray(split * 2));
    controller.close();
  } }), { status: 200, headers });
}

test("concurrent loads for one date share a streamed download", async () => {
  const gate = deferred();
  const bytes = packageFor();
  let requests = 0;
  const loader = createDailyPackageLoader({ cacheDir: null, request: async url => {
    requests++;
    assert.equal(url, "https://www.tdx.com.cn/products/data/data/g4day/20261013.zip");
    await gate.promise;
    return streamed(bytes);
  } });
  const results = [loader("2026-10-13"), loader("2026-10-13"), loader("2026-10-13")];
  await waitFor(() => requests === 1);
  gate.resolve();
  for (const result of await Promise.all(results)) assert.deepEqual(result, bytes);
  assert.equal(requests, 1);
});

test("a file cache avoids repeated downloads and deleting it obtains the package again", async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-direct-history-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const bytes = packageFor();
  let requests = 0;
  const loader = createDailyPackageLoader({ cacheDir, request: async () => { requests++; return streamed(bytes); } });
  assert.deepEqual(await loader("2026-10-13"), bytes);
  assert.deepEqual(await fs.readFile(path.join(cacheDir, "20261013.zip")), bytes);
  assert.deepEqual(await loader("2026-10-13"), bytes);
  assert.equal(requests, 1);
  await fs.rm(path.join(cacheDir, "20261013.zip"));
  assert.deepEqual(await loader("2026-10-13"), bytes);
  assert.equal(requests, 2);
  assert.deepEqual(await fs.readdir(cacheDir), ["20261013.zip"]);
});

test("invalid downloaded ZIP content and oversized declared bodies are refused before caching", async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-invalid-package-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const invalid = Buffer.alloc(22); invalid.writeUInt32LE(0x04034b50);
  const invalidLoader = createDailyPackageLoader({ cacheDir, request: async () => streamed(invalid) });
  await assert.rejects(invalidLoader("2026-10-13"), /ZIP|目录|校验/);
  assert.deepEqual(await fs.readdir(cacheDir), []);
  const oversized = createDailyPackageLoader({ cacheDir, request: async () => streamed(packageFor(),
    { "content-length": String(12 * 1024 * 1024 + 1) }) });
  await assert.rejects(oversized("2026-10-13"), /大小|过大/);
  assert.deepEqual(await fs.readdir(cacheDir), []);
});

test("a corrupted cached file is never returned as a historical package", async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-corrupt-package-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const bytes = packageFor();
  const damaged = Buffer.from(bytes); damaged[45] ^= 1;
  await fs.writeFile(path.join(cacheDir, "20261013.zip"), damaged);
  const loader = createDailyPackageLoader({ cacheDir, request: async () => streamed(bytes) });
  try {
    const result = await loader("2026-10-13");
    assert.deepEqual(result, bytes);
  } catch (error) {
    assert.match(error.message, /ZIP|CRC32|校验/);
  }
});

test("downloads for different days respect the global four-request concurrency limit", async () => {
  const dates = Array.from({ length: 8 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
  const gates = new Map(dates.map(date => [date, deferred()]));
  let started = 0, active = 0, peak = 0;
  const loader = createDailyPackageLoader({ cacheDir: null, request: async url => {
    const compact = new URL(url).pathname.match(/(\d{8})\.zip$/)[1];
    const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    started++; active++; peak = Math.max(peak, active);
    await gates.get(date).promise;
    active--;
    return streamed(packageFor(date));
  } });
  const pending = dates.map(date => loader(date));
  try {
    await waitFor(() => started >= 4);
    assert.equal(started, 4);
    assert.equal(peak, 4);
  } finally { for (const gate of gates.values()) gate.resolve(); }
  const results = await Promise.all(pending);
  assert.equal(results.length, dates.length);
  assert.equal(started, dates.length);
  assert.equal(peak, 4);
});
