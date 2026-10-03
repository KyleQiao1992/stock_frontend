import test from "node:test";
import assert from "node:assert/strict";
import { parseTencentQuoteIndicators } from "./tencentQuoteIndicators.js";

function snapshot(market) {
  const fields = Array(78).fill("");
  fields[0] = market === "hk" ? "100" : "200";
  fields[7] = fields[8] = "0";
  fields[30] = market === "hk" ? "2026/10/02 16:08:10" : "2026-10-02 16:00:01";
  fields[49] = "411.000"; // 52-week low, NOT volume ratio in HK/US.
  fields[50] = "1.20";
  fields[64] = "0.71";
  return fields;
}

test("HK and US use their own Tencent volume ratio fields", () => {
  assert.equal(parseTencentQuoteIndicators(snapshot("hk"), "hk").volumeRatio, 1.2);
  assert.equal(parseTencentQuoteIndicators(snapshot("us"), "us").volumeRatio, 0.71);
  assert.equal(parseTencentQuoteIndicators(snapshot("us"), "us").volumeRatioSource, "tencent");
});

test("quote timestamp is the supplier timestamp; inner/outer placeholders remain unavailable", () => {
  const result = parseTencentQuoteIndicators(snapshot("hk"), "hk");
  assert.equal(result.indicatorsQuoteTime, "2026/10/02 16:08:10");
  assert.equal(result.innerVol, null);
  assert.equal(result.outerVol, null);
});

test("missing or invalid ratio never becomes a made-up zero", () => {
  for (const raw of [null, undefined, "", " ", "-", "NaN", "Infinity", "-1"]) {
    const fields = snapshot("us");
    fields[64] = raw;
    const result = parseTencentQuoteIndicators(fields, "us");
    assert.equal(result.volumeRatio, null);
    assert.equal(result.volumeRatioSource, "unavailable");
  }
  const fields = snapshot("us");
  fields[64] = "0";
  assert.equal(parseTencentQuoteIndicators(fields, "us").volumeRatio, 0);
});

test("wrong market, missing timestamp and truncated payload cannot supply a ratio", () => {
  assert.equal(parseTencentQuoteIndicators(snapshot("hk"), "us").volumeRatio, null);
  assert.equal(parseTencentQuoteIndicators(snapshot("us"), "ashare").volumeRatio, null);
  assert.equal(parseTencentQuoteIndicators([], "us").volumeRatio, null);
  const fields = snapshot("hk");
  fields[30] = "";
  assert.equal(parseTencentQuoteIndicators(fields, "hk").volumeRatio, null);
});

test("session VWAP uses actual cumulative turnover divided by shares", () => {
  for (const market of ["hk", "us"]) {
    const fields = snapshot(market);
    fields[3] = "101";
    fields[36] = "1000";
    fields[37] = "100000";
    const result = parseTencentQuoteIndicators(fields, market);
    assert.equal(result.sessionVwap, 100);
    assert.ok(Math.abs(result.sessionVwapPremium - 1) < 1e-10);
    assert.equal(result.sessionVwapSource, "tencent");
  }
});

test("missing turnover or zero volume cannot produce session VWAP", () => {
  for (const invalid of ["", "-", "0", "-1", "Infinity", null, undefined]) {
    for (const index of [36, 37]) {
      const fields = snapshot("us");
      fields[36] = "1000";
      fields[37] = "100000";
      fields[index] = invalid;
      const result = parseTencentQuoteIndicators(fields, "us");
      assert.equal(result.sessionVwap, null);
      assert.equal(result.sessionVwapSource, "unavailable");
    }
  }
});
