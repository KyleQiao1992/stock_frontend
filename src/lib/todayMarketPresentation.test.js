import test from "node:test";
import assert from "node:assert/strict";
import { todayMarketPresentation } from "./todayMarketPresentation.js";

const snapshot = {
  date: "2026-09-30",
  previousDate: "2026-09-29",
  updatedAt: "2026-10-04T03:22:27+08:00",
  poolAvailability: { previousZt: true },
  premiumCoverage: { expected: 12, quoted: 0 },
};

test("holiday presentation keeps the actual quotation session and its previous session", () => {
  const view = todayMarketPresentation(snapshot, "2026-10-03T19:22:27Z");
  assert.equal(view.date, "2026-09-30");
  assert.equal(view.previousDate, "2026-09-29");
  assert.match(view.sessionNotice, /最近可用交易日 2026-09-30/);
  assert.equal(view.premiumExtra, "2026-09-29 → 2026-09-30");
  assert.match(view.unavailableMessage, /2026-09-30/);
  assert.match(view.historyUnavailableMessage, /2026-09-30.*该交易日历史曲线暂无数据/);
});

test("date comparison follows Beijing midnight rather than local or UTC midnight", () => {
  assert.equal(todayMarketPresentation(snapshot, "2026-09-30T15:59:59Z").sessionNotice, null);
  assert.match(todayMarketPresentation(snapshot, "2026-09-30T16:00:00Z").sessionNotice, /2026-09-30/);
});

test("pre-market retains the previous quotation date without inferring a holiday", () => {
  const view = todayMarketPresentation({ ...snapshot, date: "2026-09-28", previousDate: "2026-09-24" }, "2026-09-28T00:30:00-04:00");
  assert.equal(view.date, "2026-09-28");
  assert.equal(view.sessionNotice, null);
  const beforeOpen = todayMarketPresentation({ ...snapshot, date: "2026-09-24", previousDate: "2026-09-23" }, "2026-09-27T23:30:00Z");
  assert.match(beforeOpen.sessionNotice, /最近可用交易日 2026-09-24/);
  assert.match(beforeOpen.sessionNotice, /开盘前/);
});

test("fetch time cannot supply or replace the quotation session", () => {
  const now = "2026-10-03T19:22:27Z";
  const view = todayMarketPresentation({ ...snapshot, updatedAt: "2027-01-01T00:00:00Z" }, now);
  assert.equal(view.date, "2026-09-30");
  assert.match(view.sessionNotice, /2026-09-30/);
  assert.equal(todayMarketPresentation({ updatedAt: snapshot.updatedAt }, now).date, "—");
  assert.equal(todayMarketPresentation({ date: "2026-02-30" }, now).sessionNotice, null);
  assert.equal(todayMarketPresentation({ ...snapshot, previousDate: "2026-10-01" }, now).previousDate, null);
});

test("missing premium distinguishes empty prior-session samples from unavailable current quotes", () => {
  const noSamples = todayMarketPresentation({ ...snapshot, premiumCoverage: { expected: 0, quoted: 0 } }, "2026-10-03T00:00:00Z");
  assert.match(noSamples.premiumUnavailableMessage, /2026-09-29 无涨停股票/);
  assert.doesNotMatch(noSamples.premiumUnavailableMessage, /涨停池暂不可用/);
  const noQuotes = todayMarketPresentation(snapshot, "2026-10-03T00:00:00Z");
  assert.match(noQuotes.premiumUnavailableMessage, /2026-09-29.*2026-09-30 暂无可用报价/);
  assert.doesNotMatch(noQuotes.premiumUnavailableMessage, /涨停池暂不可用/);
  const noPool = todayMarketPresentation({ ...snapshot, poolAvailability: { previousZt: false } }, "2026-10-03T00:00:00Z");
  assert.match(noPool.premiumUnavailableMessage, /2026-09-29 的涨停池暂不可用/);
  const noSession = todayMarketPresentation({ ...snapshot, previousDate: null }, "2026-10-03T00:00:00Z");
  assert.equal(noSession.premiumExtra, "接力溢价");
  assert.match(noSession.premiumUnavailableMessage, /前一交易日.*2026-09-30/);
});
