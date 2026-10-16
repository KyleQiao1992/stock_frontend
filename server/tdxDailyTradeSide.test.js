import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { parseTdxDailyTradeSidePackage, TDX_DAILY_HISTORY_SOURCE, tdxDailyVerification,
  validateTdxDailyPackage, readTdxDailyPackageEntries } from "./tdxDailyTradeSide.js";

const manifest = JSON.parse(readFileSync(new URL("./fixtures/tdxDaily/manifest.json", import.meta.url)));
const now = () => Date.parse("2026-10-14T10:00:00Z");
const options = { code: "688610", date: manifest.date, expectedTotalShares: 1301251, close: 134.1, now };
function crc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function archive(entries, method = 8) {
  const blocks = []; const directory = []; let offset = 0;
  for (const [name, body] of entries) {
    const filename = Buffer.from(name);
    const compressed = method === 8 ? deflateRawSync(body) : body;
    const checksum = crc(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); blocks.push(local, filename, compressed);
    offset += local.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  const central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...blocks, central, end]);
}
function realEntries(codes = ["688610"], market = "sh") {
  const cod = []; const md1 = [];
  for (const [index, code] of codes.entries()) {
    const row = Buffer.from(readFileSync(new URL(`./fixtures/tdxDaily/${code}.codrow`, import.meta.url)));
    row.writeUInt16LE(index, 32); // Only remap the storage offset for compact test archives.
    cod.push(row);
    md1.push(readFileSync(new URL(`./fixtures/tdxDaily/${code}.md1block`, import.meta.url)));
  }
  return [[`${market}261013.cod`, Buffer.concat(cod)], [`${market}261013.md1`, Buffer.concat(md1)]];
}

test("real STAR snapshot retains exact shares and does not assign the 587-share remainder", () => {
  const row = parseTdxDailyTradeSidePackage(archive(realEntries()), options);
  assert.deepEqual(row.sourceVolumes, { totalShares: 1301251, innerShares: 658905, outerShares: 641759, unclassifiedShares: 587 });
  assert.equal(row.innerVol, 6589.05); assert.equal(row.outerVol, 6417.59);
  assert.equal(row.totalVol, 13012.51); assert.equal(row.unknownVol, 5.87);
  assert.equal(row.neutralVol, undefined); assert.equal(row.netVol, -171.46);
  assert.equal(row.quoteTime, null); assert.equal(row.complete, true);
  assert.equal(row.quality.comparisonPrecision, "share"); assert.equal(row.quality.volumeDifferenceShares, 0);
  assert.equal(row.quality.packageChecksumValidated, true);
  assert.equal(row.provenance.exchangeDirectionVerified, false);
  assert.equal(row.provenance.rawRecordsRetained, false);
  assert.equal(row.sourceUrl, manifest.sourceUrl);
  assert.deepEqual(row.quality.nativeVolumeFields, { innerOffset: 80, outerOffset: 88 });
});
test("multiple real stock blocks use their own COD identity and sequence", () => {
  const zip = archive(realEntries(["603818", "688610", "600519"]));
  for (const fixture of manifest.rows) {
    const row = parseTdxDailyTradeSidePackage(zip, { ...options, code: fixture.code,
      expectedTotalShares: fixture.totalShares, close: fixture.close });
    assert.equal(row.sourceVolumes.innerShares, fixture.innerShares);
    assert.equal(row.sourceVolumes.outerShares, fixture.outerShares);
  }
});
test("ordinary quotes validate rounded lots without falsely claiming share-level equality", () => {
  const row = parseTdxDailyTradeSidePackage(archive(realEntries(["600519"])), { ...options,
    code: "600519", close: 1274.89, sourceVolumeUnit: "lot", expectedTotalVol: 26573 });
  assert.equal(row.totalVol, 26572.76);
  assert.equal(row.quality.comparisonPrecision, "rounded-lot");
  assert.equal(row.quality.quoteVolumeDifferenceLots, 0);
  assert.equal(row.quality.volumeDifferenceShares, undefined);
});
test("CRC validation accepts STORE and DEFLATE but rejects changed content", () => {
  const stored = archive(realEntries(), 0);
  assert.equal(parseTdxDailyTradeSidePackage(stored, options).source, "tdx-daily");
  stored[60] ^= 1;
  assert.throws(() => parseTdxDailyTradeSidePackage(stored, options), /CRC32/);
});
test("incorrect ZIP declared sizes, duplicated entries, truncation, and wrong dates are rejected", () => {
  const zip = archive(realEntries());
  const broken = Buffer.from(zip); broken.writeUInt32LE(0xffffffff, 22);
  assert.throws(() => parseTdxDailyTradeSidePackage(broken, options), /长度/);
  assert.throws(() => parseTdxDailyTradeSidePackage(zip.subarray(0, zip.length - 1), options), /截断/);
  assert.throws(() => parseTdxDailyTradeSidePackage(archive([...realEntries(), ...realEntries()]), options), /重复/);
  assert.throws(() => parseTdxDailyTradeSidePackage(zip, { ...options, date: "2026-10-12" }), /日期/);
  assert.throws(() => parseTdxDailyTradeSidePackage(archive([["../sh261013.cod", Buffer.alloc(150)], realEntries()[1]]), options), /名称/);
});
test("missing pairs, malformed record sizes, wrong codes, and out-of-bound mappings are rejected", () => {
  const entries = realEntries();
  assert.throws(() => parseTdxDailyTradeSidePackage(archive([entries[0], ["sz261013.md1", entries[1][1]]]), options), /配对/);
  assert.throws(() => parseTdxDailyTradeSidePackage(archive([[entries[0][0], entries[0][1].subarray(0, 149)], entries[1]]), options), /记录大小/);
  assert.throws(() => parseTdxDailyTradeSidePackage(archive(entries), { ...options, code: "688611" }), /没有/);
  entries[0][1].writeUInt16LE(2, 32);
  assert.throws(() => parseTdxDailyTradeSidePackage(archive(entries), options), /边界/);
});
test("exact-share mismatches and rounded-lot mismatches remain explicit failures", () => {
  const zip = archive(realEntries());
  assert.throws(() => parseTdxDailyTradeSidePackage(zip, { ...options, expectedTotalShares: 1301250 }), /总股数/);
  assert.throws(() => parseTdxDailyTradeSidePackage(zip, { ...options, sourceVolumeUnit: "lot", expectedTotalVol: 13012 }), /整数手/);
  assert.throws(() => parseTdxDailyTradeSidePackage(zip, { ...options, close: 134.11 }), /收盘价/);
});
test("unsafe shares, overcounted directions, unclosed snapshots and invalid prices are rejected", () => {
  for (const [mutate, pattern] of [
    [block => block.writeBigUInt64LE(2n ** 54n, 56), /精确/],
    [block => block.writeBigUInt64LE(1301252n, 80), /关系/],
    [block => block.writeBigUInt64LE(1301251n, 88), /关系/],
    [block => block.writeUInt32LE(145959, 44), /尚未收盘/],
    [block => block.writeDoubleLE(NaN, 36), /收盘价/],
  ]) {
    const entries = realEntries(); mutate(entries[1][1]);
    assert.throws(() => parseTdxDailyTradeSidePackage(archive(entries), options), pattern);
  }
});
test("market inference covers Shenzhen and Beijing without using Shanghai files", () => {
  for (const [market, code] of [["sz", "300745"], ["bj", "920000"]]) {
    const entries = realEntries(["688610"], market);
    entries[0][1].write(code, 0, "ascii");
    assert.equal(parseTdxDailyTradeSidePackage(archive(entries), { ...options, code }).code, code);
  }
});
test("source provenance separates complete snapshots from verified exchange flags", () => {
  assert.deepEqual(TDX_DAILY_HISTORY_SOURCE, { key: "tdx-daily", name: "通达信盘后历史" });
  assert.equal(tdxDailyVerification().exchangeDirectionVerified, false);
  assert.equal(tdxDailyVerification().neutralHandling, "vendor-allocation");
  assert.throws(() => parseTdxDailyTradeSidePackage(archive(realEntries()), { ...options, date: "2026-10-15" }), /日期/);
});
test("cache validator checks every market's CRC before returning validated entries", () => {
  const zip = archive([...realEntries(), ...realEntries(["600519"], "sz")], 0);
  assert.equal(validateTdxDailyPackage(zip, manifest.date).validated, true);
  assert.equal(readTdxDailyPackageEntries(zip, manifest.date).size, 4);
  const name = Buffer.from("sz261013.md1");
  zip[zip.indexOf(name) + name.length + 88] ^= 1;
  assert.throws(() => validateTdxDailyPackage(zip, manifest.date), /CRC32/);
  assert.throws(() => parseTdxDailyTradeSidePackage(zip, options), /CRC32/);
});
