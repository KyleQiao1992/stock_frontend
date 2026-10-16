import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

export const TDX_DAILY_HISTORY_SOURCE = Object.freeze({ key: "tdx-daily", name: "通达信盘后历史" });
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function fail(message) { throw new Error(`通达信盘后历史：${message}`); }
function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
export function tdxDailyVerification() {
  return {
    directionSource: "tdx-daily", exchangeDirectionVerified: false,
    directionMode: "vendor-native-cumulative-counters",
    neutralHandling: "vendor-allocation", unclassifiedHandling: "retained-unallocated",
    rawRecordsRetained: false, rawSnapshotRetained: true,
    comparisonSource: "tencent-unadjusted-daily",
    validationScope: ["package-crc32", "security-identity", "daily-volume", "daily-close"],
  };
}

// Parse ZIP in memory. The official daily package contains only paired .cod
// (150-byte code mappings) and .md1 (512-byte market snapshots) files.
function unpackDailyZip(zip, suffix) {
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > MAX_PACKAGE_BYTES) fail("ZIP 包大小无效。");
  let eocd = -1;
  for (let position = zip.length - 22; position >= Math.max(0, zip.length - 65557); position -= 1) {
    if (zip.readUInt32LE(position) === 0x06054b50 && position + 22 + zip.readUInt16LE(position + 20) === zip.length) {
      eocd = position; break;
    }
  }
  if (eocd < 0) fail("ZIP 目录缺失或被截断。");
  const count = zip.readUInt16LE(eocd + 10);
  const directorySize = zip.readUInt32LE(eocd + 12);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 4) || zip.readUInt16LE(eocd + 6)
    || zip.readUInt16LE(eocd + 8) !== count || count < 2 || count > 6
    || directoryOffset + directorySize !== eocd) fail("ZIP 目录大小、分卷或记录数量无效。");
  const entries = new Map();
  const ranges = [];
  let cursor = directoryOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || zip.readUInt32LE(cursor) !== 0x02014b50) fail("ZIP 目录记录被截断。");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28);
    const extraSize = zip.readUInt16LE(cursor + 30);
    const commentSize = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameSize + extraSize + commentSize;
    if (recordEnd > eocd || zip.readUInt16LE(cursor + 34)) fail("ZIP 文件目录长度或分卷无效。");
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = nameBytes.toString("ascii");
    if (!nameBytes.equals(Buffer.from(name, "ascii")) || !new RegExp(`^(sh|sz|bj)${suffix}\\.(cod|md1)$`).test(name)
      || entries.has(name)) fail("ZIP 文件日期、名称或重复记录无效。");
    if (flags & 1 || ![0, 8].includes(method) || size > MAX_ENTRY_BYTES
      || compressedSize > MAX_PACKAGE_BYTES || (totalSize += size) > MAX_PACKAGE_BYTES) fail("ZIP 压缩格式或展开大小无效。");
    if (localOffset + 30 > directoryOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) fail("ZIP 本地文件头被截断。");
    const localNameSize = zip.readUInt16LE(localOffset + 26);
    const localExtraSize = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtraSize;
    const dataEnd = dataStart + compressedSize;
    if (zip.readUInt16LE(localOffset + 6) !== flags || zip.readUInt16LE(localOffset + 8) !== method
      || localNameSize !== nameSize || !zip.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes)
      || dataEnd > directoryOffset || ranges.some(([start, end]) => localOffset < end && dataEnd > start)) fail("ZIP 文件头、文件名或区间不一致。");
    if (!(flags & 8) && (zip.readUInt32LE(localOffset + 14) !== checksum
      || zip.readUInt32LE(localOffset + 18) !== compressedSize || zip.readUInt32LE(localOffset + 22) !== size)) fail("ZIP 头部长度或校验码不一致。");
    let body;
    try {
      const compressed = zip.subarray(dataStart, dataEnd);
      if (method === 0) body = compressed;
      else {
        const decoded = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size), info: true });
        if (decoded.engine.bytesWritten !== compressedSize) fail("ZIP 压缩流长度不一致。");
        body = decoded.buffer;
      }
    } catch { fail("ZIP 压缩流无效或展开大小不一致。"); }
    if (body.length !== size || crc32(body) !== checksum) fail("ZIP 文件大小或 CRC32 校验失败。");
    entries.set(name, body);
    ranges.push([localOffset, dataEnd]);
    cursor = recordEnd;
  }
  if (cursor !== eocd) fail("ZIP 目录含未识别数据。");
  for (const name of entries.keys()) {
    if (!entries.has(name.replace(/\.(cod|md1)$/, name.endsWith(".cod") ? ".md1" : ".cod"))) fail("ZIP 证券代码和行情文件没有配对。");
  }
  return entries;
}
function marketFor(code) {
  if (!/^\d{6}$/.test(code || "")) fail("股票代码无效。");
  if (/^6/.test(code)) return "sh";
  if (/^[03]/.test(code)) return "sz";
  if (/^(?:[48]|92)/.test(code)) return "bj";
  fail("股票市场无效。");
}
function readShares(block, offset) {
  const value = block.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("股数超过精确计算范围。");
  return Number(value);
}

export function readTdxDailyPackageEntries(zip, date) {
  if (!validDate(date)) fail("文件交易日期无效。");
  const files = unpackDailyZip(zip, date.replaceAll("-", "").slice(2));
  for (const [name, data] of files) {
    if (!data.length || data.length % (name.endsWith(".cod") ? 150 : 512)) fail("证券代码或行情文件记录大小无效。");
    if (name.endsWith(".cod")) {
      const md1 = files.get(name.replace(/\.cod$/, ".md1"));
      for (let position = 0; position < data.length; position += 150) {
        if (data.readUInt16LE(position + 32) * 512 + 512 > md1.length) fail("证券序号超出行情文件边界。");
      }
    }
  }
  return files;
}

export function validateTdxDailyPackage(zip, date) {
  const files = readTdxDailyPackageEntries(zip, date);
  return { validated: true, entryNames: [...files.keys()],
    packageSha256: createHash("sha256").update(zip).digest("hex") };
}

export function parseTdxDailyTradeSidePackage(zip, { code, date, expectedTotalShares,
  expectedTotalVol, sourceVolumeUnit = "share", close, now = Date.now } = {}) {
  const market = marketFor(code);
  const collectedTimestamp = typeof now === "function" ? now() : now;
  if (!validDate(date) || !Number.isFinite(collectedTimestamp)
    || date > new Date(collectedTimestamp + 8 * 3600000).toISOString().slice(0, 10)
    || !Number.isFinite(close) || close <= 0 || !["share", "lot"].includes(sourceVolumeUnit)) fail("交易日期、收盘价或校验单位无效。");
  const expected = sourceVolumeUnit === "share" ? expectedTotalShares : expectedTotalVol;
  if (!Number.isSafeInteger(expected) || expected <= 0) fail("日线缺少有效的成交量校验值。");
  const suffix = date.replaceAll("-", "").slice(2);
  const files = readTdxDailyPackageEntries(zip, date);
  const codName = `${market}${suffix}.cod`;
  const md1Name = `${market}${suffix}.md1`;
  const cod = files.get(codName);
  const md1 = files.get(md1Name);
  if (!cod || !md1 || !cod.length || cod.length % 150 || !md1.length || md1.length % 512) fail("证券代码或行情文件记录大小无效。");
  let sequence = null;
  for (let position = 0; position < cod.length; position += 150) {
    const mappedCode = cod.subarray(position, position + 6).toString("ascii");
    if (mappedCode === code) {
      if (sequence !== null) fail("证券代码重复，无法确认行情身份。");
      sequence = cod.readUInt16LE(position + 32);
    }
  }
  if (sequence === null) fail(`${date} 文件没有 ${code} 证券记录。`);
  const offset = sequence * 512;
  if (offset + 512 > md1.length) fail("证券序号超出行情文件边界。");
  const block = md1.subarray(offset, offset + 512);
  const clock = String(block.readUInt32LE(44)).padStart(6, "0");
  if (!/^\d{6}$/.test(clock) || clock.slice(0, 2) > "23" || clock.slice(2, 4) > "59"
    || clock.slice(4, 6) > "59" || clock < "150000") fail("证券行情尚未收盘或时间无效。");
  const packageClose = block.readDoubleLE(36);
  if (!Number.isFinite(packageClose) || packageClose <= 0
    || Math.round(packageClose * 100) !== Math.round(close * 100)) fail("盘后行情收盘价与真实日线不一致。");
  const totalShares = readShares(block, 56);
  const innerShares = readShares(block, 80);
  const outerShares = readShares(block, 88);
  if (!totalShares || innerShares > totalShares || outerShares > totalShares - innerShares
    || !innerShares && !outerShares) fail("成交总股数与内外盘股数关系无效。");
  if (sourceVolumeUnit === "share" && totalShares !== expectedTotalShares) fail("盘后成交总股数与真实日线不一致。");
  if (sourceVolumeUnit === "lot" && Math.round(totalShares / 100) !== expectedTotalVol) fail("盘后成交量与日线整数手不一致。");
  const unclassifiedShares = totalShares - innerShares - outerShares;
  const classifiedShares = innerShares + outerShares;
  const netShares = outerShares - innerShares;
  const verification = tdxDailyVerification();
  return {
    code, date, source: "tdx-daily", method: "vendor-native-cumulative-counters",
    sourceUrl: `https://www.tdx.com.cn/products/data/data/g4day/${date.replaceAll("-", "")}.zip`,
    quoteTime: null, complete: true, validated: true, close: packageClose,
    collectedAt: new Date(collectedTimestamp).toISOString(),
    volumeUnit: "lot", sourceVolumeUnit: "share",
    sourceVolumes: { totalShares, innerShares, outerShares, unclassifiedShares },
    totalVol: totalShares / 100, innerVol: innerShares / 100, outerVol: outerShares / 100,
    unknownVol: unclassifiedShares / 100, unclassifiedVol: unclassifiedShares / 100,
    netVol: netShares / 100, netRatio: netShares / classifiedShares * 100,
    outerRatio: outerShares / classifiedShares * 100, provenance: verification,
    quality: {
      validated: true, verification, packageChecksumValidated: true,
      packageSha256: createHash("sha256").update(zip).digest("hex"),
      comparisonPrecision: sourceVolumeUnit === "share" ? "share" : "rounded-lot",
      ...(sourceVolumeUnit === "share" ? { expectedTotalShares, volumeDifferenceShares: totalShares - expectedTotalShares }
        : { expectedTotalVol, quoteVolumeDifferenceLots: Math.round(totalShares / 100) - expectedTotalVol }),
      closingPrice: packageClose, classifiedVol: classifiedShares / 100,
      nativeSnapshotTime: clock, nativeVolumeFields: { innerOffset: 80, outerOffset: 88 },
      codName, md1Name, sequence,
      recordSha256: createHash("sha256").update(block).digest("hex"),
    },
  };
}
