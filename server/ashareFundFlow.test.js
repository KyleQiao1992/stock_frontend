import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEastmoneyDataPcPayload,
  parseEastmoneyFundFlowPayload,
  parseStockDdxHtml,
} from "./ashareFundFlow.js";

test("maps the AKShare-compatible Eastmoney field order", () => {
  const payload = {
    data: {
      klines: [
        "2026-07-21,100,20,30,40,60,1.5,0.3,0.4,0.5,0.8,12.34,2.1,0,0",
        "2026-07-22,-50,-10,-15,-20,-30,-0.7,-0.1,-0.2,-0.3,-0.4,12.10,-1.9,0,0",
      ],
    },
  };

  const result = parseEastmoneyFundFlowPayload(payload, "600519", 30);
  assert.equal(result.source.key, "akshare-eastmoney");
  assert.equal(result.latest.date, "2026-07-22");
  assert.equal(result.latest.mainNetAmount, -50);
  assert.equal(result.latest.smallNetAmount, -10);
  assert.equal(result.latest.superLargeNetRatio, -0.4);
  assert.equal(result.summary.fiveDay.mainNetAmount, 50);
  assert.equal(result.summary.fiveDay.smallNetAmount, 10);
});

test("parses a DDX table into the unified fallback shape", () => {
  const html = `
    <table>
      <tr><th>日期</th><th>DDX</th><th>DDY</th><th>DDZ</th><th>BBD(万元)</th></tr>
      <tr><td>2026-07-21</td><td>0.12</td><td>-0.23</td><td>4.56</td><td>1,234.5万元</td></tr>
    </table>
  `;

  const result = parseStockDdxHtml(html, "600519", 30);
  assert.equal(result.source.key, "stockddx");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.latest.dde.ddx, 0.12);
  assert.equal(result.latest.dde.ddy, -0.23);
  assert.equal(result.latest.dde.ddz, 4.56);
  assert.equal(result.latest.dde.bbd, 1234.5);
});

test("maps the Eastmoney DataPC historical response and sorts it by date", () => {
  const payload = {
    history: [
      {
        rq: "2026-07-23",
        spj: "146.81",
        zdf: "-4.75%",
        zllr_je: "-886.85万",
        zllr_jzb: "-3.25%",
        cddjlr_je: "-998.42万",
        cddjlr_jzb: "-3.66%",
        ddjlr_je: "111.58万",
        ddjlr_jzb: "0.41%",
        zdjlr_je: "-824.64万",
        zdjlr_jzb: "-3.02%",
        xdjlr_je: "1711.49万",
        xdjlr_jzb: "6.27%",
      },
      {
        rq: "2026-07-22",
        spj: "154.13",
        zdf: "-7.02%",
        zllr_je: "-0.30亿",
        zllr_jzb: "-8.20%",
        cddjlr_je: "-1005.69万",
        cddjlr_jzb: "-2.77%",
        ddjlr_je: "-1969.02万",
        ddjlr_jzb: "-5.43%",
        zdjlr_je: "517.18万",
        zdjlr_jzb: "1.43%",
        xdjlr_je: "2457.54万",
        xdjlr_jzb: "6.77%",
      },
    ],
  };

  const result = parseEastmoneyDataPcPayload(payload, "688610", 30);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].date, "2026-07-22");
  assert.equal(result.latest.date, "2026-07-23");
  assert.equal(result.latest.smallNetAmount, 17_114_900);
  assert.equal(result.latest.smallNetRatio, 6.27);
  assert.equal(result.rows[0].mainNetAmount, -30_000_000);
});
