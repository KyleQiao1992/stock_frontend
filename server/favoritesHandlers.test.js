import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFavoriteCode, normalizeMarket } from "./favoritesHandlers.js";

test("favorite markets keep A-share and US behavior while adding HK", () => {
  assert.equal(normalizeMarket("ashare"), "ashare");
  assert.equal(normalizeMarket("us"), "us");
  assert.equal(normalizeMarket("hk"), "hk");
  assert.throws(() => normalizeMarket("other"));
});

test("favorite codes are normalized independently per market", () => {
  assert.equal(normalizeFavoriteCode("600519", "ashare"), "600519");
  assert.equal(normalizeFavoriteCode("brk.b", "us"), "BRK.B");
  assert.equal(normalizeFavoriteCode("700", "hk"), "00700");
  assert.equal(normalizeFavoriteCode("HK09988", "hk"), "09988");
  assert.throws(() => normalizeFavoriteCode("00700", "ashare"));
  assert.throws(() => normalizeFavoriteCode("腾讯", "hk"));
});
