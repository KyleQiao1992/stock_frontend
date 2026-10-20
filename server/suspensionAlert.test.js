import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseEastmoneyDailyKline,
  parseTencentDailyKline,
  countSameDirAbnormal,
  cumDeviation,
  abnormalWindow,
  deviationWindow,
} from './suspensionPrices.js';
import {
  computeRisk,
  createSuspensionAlertHandler,
  fetchDailyKline,
} from './suspensionAlert.js';

const SYMBOL = 'sh688610';
const REAL_ACTION = { cqr: '2026-10-19', FHcontent: '10派2元转4股' };
const REAL_DAYS = [
  { date: '2026-10-15', close: 118.5, referenceClose: 118.5 },
  { date: '2026-10-16', close: 113, referenceClose: 118.5 },
  { date: '2026-10-19', close: 79.21, referenceClose: 80.57 },
  { date: '2026-10-20', close: 80.4, referenceClose: 79.21 },
];
const REAL_INDEX = new Map([
  ['2026-10-15', 1359.52], ['2026-10-16', 1350],
  ['2026-10-19', 1340], ['2026-10-20', 1342.42],
]);

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Number.isFinite(actual), `expected a finite number, received ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function eastmoneyLine({ date, close, referenceClose = close, volume = 100, pct }) {
  // f51 date, f52 open, f53 close, f54 high, f55 low, f56 volume,
  // f57 amount, f58 amplitude, f59 pct, f60 change, f61 turnover.
  return [date, close, close, close, close, volume, 10000, 0, pct ?? ((close / referenceClose - 1) * 100).toFixed(2),
    (close - referenceClose).toFixed(2), 1].join(',');
}

function eastmoneyPayload(days) {
  return { data: { name: '埃科光电', klines: days.map(eastmoneyLine) } };
}

function tencentLine(date, close, event, volume = 100) {
  const row = [date, String(close), String(close), String(close), String(close), String(volume)];
  if (event) row.push(event);
  return row;
}

function tencentPayload(rows, additional = {}) {
  return { code: 0, data: { [SYMBOL]: { day: rows, ...additional } } };
}

test('688610 ex-rights regression: both providers recover the official reference close, not a raw-price collapse', () => {
  const eastmoney = parseEastmoneyDailyKline(eastmoneyPayload(REAL_DAYS));
  const tencent = parseTencentDailyKline(tencentPayload([
    tencentLine('2026-10-15', 118.5),
    tencentLine('2026-10-16', 113),
    tencentLine('2026-10-19', 79.21, REAL_ACTION),
    tencentLine('2026-10-20', 80.4),
  ]), SYMBOL);

  for (const parsed of [eastmoney, tencent]) {
    closeTo(parsed.rows[2].referenceClose, 80.57);
    assert.equal(parsed.rows.at(-1).close, 80.4);
    const expected = ((113 / 118.5) * (79.21 / 80.57) * (80.4 / 79.21) - 1) * 100
      - (1342.42 / 1359.52 - 1) * 100;
    closeTo(cumDeviation(parsed.rows, REAL_INDEX, 3), expected);
    closeTo(expected, -3.5847568969560872);
    const oldRawEndpoint = (80.4 / 118.5 - 1) * 100 - (1342.42 / 1359.52 - 1) * 100;
    closeTo(oldRawEndpoint, -30.89410186469387);
    assert.ok(Math.abs(cumDeviation(parsed.rows, REAL_INDEX, 3) - oldRawEndpoint) > 27);
    assert.equal(countSameDirAbnormal(parsed.rows, REAL_INDEX, 30, 10), 0);
  }
});

test('ordinary trading windows retain compounded endpoint returns rather than adding daily percentages', () => {
  const days = [
    { date: '2026-10-12', close: 100, referenceClose: 100 },
    { date: '2026-10-13', close: 110, referenceClose: 100, pct: 10 },
    { date: '2026-10-14', close: 99, referenceClose: 110, pct: -10 },
    { date: '2026-10-15', close: 108.9, referenceClose: 99, pct: 10 },
  ];
  const { rows } = parseEastmoneyDailyKline(eastmoneyPayload(days));
  const index = new Map(days.map(({ date }, i) => [date, [1000, 1050, 950, 1020][i]]));
  const expected = (108.9 / 100 - 1) * 100 - (1020 / 1000 - 1) * 100;
  closeTo(cumDeviation(rows, index, 3), expected);
  closeTo(expected, 6.9);
  assert.ok(Math.abs(expected - (10 - 10 + 10 - 2)) > 1);
  closeTo(cumDeviation(rows, index, 2, 2), (99 / 100 - 1) * 100 - (950 / 1000 - 1) * 100);
});

test('Tencent handles cash dividends, combined bonus/conversion shares, and multiple independent events', () => {
  const { rows } = parseTencentDailyKline(tencentPayload([
    tencentLine('2026-10-12', 100),
    tencentLine('2026-10-13', 99, { cqr: '2026-10-13', FHcontent: '10派10元' }),
    tencentLine('2026-10-14', 61.81, { cqr: '2026-10-14', FHcontent: '10送2股转增4股派1元' }),
    tencentLine('2026-10-15', 62.43),
  ]), SYMBOL);
  closeTo(rows[1].referenceClose, 99);
  closeTo(rows[2].referenceClose, 61.81);
  closeTo(rows[3].referenceClose, 61.81);
  const index = new Map(rows.map(({ date }) => [date, 1000]));
  closeTo(cumDeviation(rows, index, 3), (62.43 / 61.81 - 1) * 100);
});

test('Tencent rejects adjusted-only or unsupported corporate-action data', () => {
  assert.throws(() => parseTencentDailyKline({ code: 0, data: { [SYMBOL]: {
    qfqday: [tencentLine('2026-10-16', 80.572), tencentLine('2026-10-19', 79.21)],
  } } }, SYMBOL));
  assert.throws(() => parseTencentDailyKline(tencentPayload([
    tencentLine('2026-10-16', 113),
    tencentLine('2026-10-19', 79.21, { cqr: '2026-10-19', FHcontent: '10配3股配股价5元' }),
  ]), SYMBOL));
  const raw = parseTencentDailyKline(tencentPayload([
    tencentLine('2026-10-16', 113), tencentLine('2026-10-19', 79.21, REAL_ACTION),
  ], { qfqday: [tencentLine('2026-10-16', 80.572), tencentLine('2026-10-19', 79.21)] }), SYMBOL);
  assert.equal(raw.rows[0].close, 113);
  closeTo(raw.rows[1].referenceClose, 80.57);
});

test('ex-rights references round a half-cent up despite binary floating-point noise', () => {
  const { rows } = parseTencentDailyKline(tencentPayload([
    tencentLine('2026-10-16', 10.08),
    tencentLine('2026-10-19', 10.08, { cqr: '2026-10-19', FHcontent: '10派0.05元' }),
  ]), SYMBOL);
  assert.equal(rows[1].referenceClose, 10.08);
});

test('daily parsers sort sessions and omit zero-volume suspension placeholders', () => {
  const days = [
    { date: '2026-10-15', close: 110, referenceClose: 100 },
    { date: '2026-10-14', close: 100, referenceClose: 100, volume: 0 },
    { date: '2026-10-13', close: 100, referenceClose: 100 },
  ];
  const eastmoney = parseEastmoneyDailyKline(eastmoneyPayload(days));
  const tencent = parseTencentDailyKline(tencentPayload(days.map(({ date, close, volume }) =>
    tencentLine(date, close, null, volume ?? 100))), SYMBOL);
  for (const { rows } of [eastmoney, tencent]) {
    assert.deepEqual(rows.map(({ date }) => date), ['2026-10-13', '2026-10-15']);
    closeTo(rows[1].referenceClose, 100);
    const index = new Map([['2026-10-13', 1000], ['2026-10-15', 1010]]);
    closeTo(cumDeviation(rows, index, 1), 9);
  }
});

test('missing reference closes or index endpoints cannot produce a seemingly valid deviation', () => {
  assert.equal(cumDeviation(REAL_DAYS, REAL_INDEX, 4), null);
  for (const referenceClose of [undefined, null, 0, -1, NaN]) {
    const rows = REAL_DAYS.map(row => ({ ...row }));
    rows[2].referenceClose = referenceClose;
    assert.equal(cumDeviation(rows, REAL_INDEX, 3), null);
  }
  for (const date of ['2026-10-15', '2026-10-20']) {
    const index = new Map(REAL_INDEX);
    index.delete(date);
    assert.equal(cumDeviation(REAL_DAYS, index, 3), null);
  }
});

test('same-direction events retain repeated-edge counting and seed the left window boundary', () => {
  const closes = [100, 100, 100, 100, 150, 150, 150, 150, 225, 225, 225, 225];
  const rows = closes.map((close, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    close, referenceClose: closes[Math.max(0, i - 1)] }));
  const index = new Map(rows.map(({ date }) => [date, 1000]));
  assert.equal(countSameDirAbnormal(rows, index, 30, 10), 2);
  assert.equal(countSameDirAbnormal(rows, index, 30, 7), 1);
});

function syntheticHistory(tailCloses, tailIndexCloses = tailCloses.map(() => 1000)) {
  const closes = [...Array(31 - tailCloses.length).fill(tailCloses[0]), ...tailCloses];
  const indexCloses = [...Array(31 - tailIndexCloses.length).fill(tailIndexCloses[0]), ...tailIndexCloses];
  const rows = closes.map((close, i) => ({
    date: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10),
    close,
    referenceClose: closes[Math.max(0, i - 1)],
    volume: 100,
  }));
  return {
    stock: { name: '测试', rows },
    index: { rows: rows.map(({ date }, i) => ({ date, close: indexCloses[i] })) },
    byDate: new Map(rows.map(({ date }, i) => [date, indexCloses[i]])),
  };
}

test('within-three-session detection catches a two-day 44% move even when the full three days are below 30%', async () => {
  // The first day loses 10%; the following two gain 20% each. Thus 1.2²−1
  // is 44%, while 0.9×1.2²−1 is only 29.6%.
  const { stock, index, byDate } = syntheticHistory([100, 90, 108, 129.6]);
  const window = abnormalWindow(stock.rows, byDate);
  assert.equal(window.days, 2);
  closeTo(window.deviation, 44);
  closeTo(cumDeviation(stock.rows, byDate, 3), 29.6);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.levelLabel, '已触发异常波动');
  assert.equal(risk.metrics.dev3, 29.6);
  assert.equal(risk.metrics.abnWindowDays, 2);
  assert.equal(risk.metrics.abnDeviation, 44);
  assert.match(risk.reasons[0], /近2日累计偏离\+44\.0%/);
  assert.equal(risk.metrics.abnEventCount10, 1);
});

test('within-three-session detection includes a single session exactly at the threshold', async () => {
  // A 20% stock gain against a 10% index loss gives exactly 30 points.
  // Binary floating point yields just under 30; it must still reach the rule.
  const { stock, index, byDate } = syntheticHistory([100, 90, 81, 97.2], [1000, 1000, 1000, 900]);
  const window = abnormalWindow(stock.rows, byDate);
  assert.equal(window.days, 1);
  closeTo(window.deviation, 30);
  closeTo(cumDeviation(stock.rows, byDate, 3), 7.2);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.levelLabel, '已触发异常波动');
  assert.equal(risk.metrics.abnWindowDays, 1);
  assert.equal(risk.metrics.abnDeviation, 30);
  assert.match(risk.reasons[0], /近1日累计偏离\+30\.0%/);
  assert.equal(risk.metrics.abnEventCount10, 1);
});

test('the strongest suffix retains its direction when it opposes the full three-session return', async () => {
  const { stock, index, byDate } = syntheticHistory([100, 160, 128, 102.4]);
  closeTo(cumDeviation(stock.rows, byDate, 3), 2.4);
  const window = abnormalWindow(stock.rows, byDate);
  assert.equal(window.days, 2);
  closeTo(window.deviation, -36);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.levelLabel, '已触发异常波动');
  assert.equal(risk.metrics.dev3, 2.4);
  assert.equal(risk.metrics.abnDeviation, -36);
  assert.match(risk.reasons[0], /近2日累计偏离-36\.0%/);
});

test('near-abnormal status also uses the strongest suffix rather than the full three days', async () => {
  const { stock, index } = syntheticHistory([100, 80, 88, 99.44]);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.level, 'near_abnormal');
  assert.equal(risk.metrics.dev3, -0.56);
  assert.equal(risk.metrics.abnWindowDays, 2);
  assert.equal(risk.metrics.abnDeviation, 24.3);
  assert.match(risk.reasons[0], /近2日累计偏离\+24\.3%/);
});

test('a missing short-window benchmark cannot silently fall back to a valid full three-day window', async () => {
  const { stock, index, byDate } = syntheticHistory([100, 90, 108, 129.6]);
  const missingDate = stock.rows.at(-2).date;
  byDate.delete(missingDate);
  closeTo(cumDeviation(stock.rows, byDate, 3), 29.6);
  assert.equal(abnormalWindow(stock.rows, byDate), null);
  index.rows = index.rows.filter(({ date }) => date !== missingDate);
  await assert.rejects(computeRisk('688610', '测试', riskDependencies(stock, index)), /同期指数数据缺失/);
});

test('an eight-day rise within ten sessions triggers serious risk despite earlier losses', async () => {
  const tail = [100, 90, 80];
  for (let day = 1; day <= 8; day += 1) tail.push(80 * 1.1 ** day);
  const { stock, index } = syntheticHistory(tail);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  // Eight gains of 10% give +114.36%; the preceding 20% loss reduces the
  // full ten-day return to +71.49%, which cannot explain the serious trigger.
  assert.equal(risk.level, 'serious');
  assert.equal(risk.metrics.dev10, 71.49);
  assert.equal(risk.metrics.seriousWindows.dev10.days, 8);
  assert.equal(risk.metrics.seriousWindows.dev10.deviation, 114.36);
  closeTo(risk.metrics.seriousWindows.dev10.severity, 1.1 ** 8 - 1);
  assert.match(risk.reasons[0], /近8日累计偏离\+114\.4%（10日内/);
});

test('a twenty-one-day rise within thirty sessions triggers even when the full thirty days do not', async () => {
  const tail = [200];
  for (let day = 1; day <= 9; day += 1) tail.push(200 * 0.5 ** (day / 9));
  for (let day = 1; day <= 21; day += 1) tail.push(100 * 1.06 ** day);
  const { stock, index } = syntheticHistory(tail);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  const expected = (1.06 ** 21 - 1) * 100;
  assert.equal(risk.level, 'serious');
  assert.ok(risk.metrics.dev10 < 100);
  assert.ok(risk.metrics.dev30 < 200);
  assert.equal(risk.metrics.seriousWindows.dev30.days, 21);
  assert.equal(risk.metrics.seriousWindows.dev30.deviation, Number(expected.toFixed(2)));
  closeTo(risk.metrics.seriousWindows.dev30.severity, expected / 200);
  assert.match(risk.reasons[0], /近21日累计偏离\+240\.0%（30日内/);
});

test('asymmetric serious thresholds rank a negative trigger ahead of a larger positive move', async () => {
  const { stock, index, byDate } = syntheticHistory([100, 250, 100 / 1.7, 100]);
  // Latest day is +70%, latest two days −60%, latest three days 0%.
  // |+70| is larger, but −60/−50 = 1.2 reaches the serious rule.
  closeTo(cumDeviation(stock.rows, byDate, 1), 70);
  closeTo(cumDeviation(stock.rows, byDate, 2), -60);
  const window = deviationWindow(stock.rows, byDate, 10, { up: 100, down: -50 });
  assert.equal(window.days, 2);
  closeTo(window.deviation, -60);
  closeTo(window.severity, 1.2);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.level, 'serious');
  assert.equal(risk.metrics.dev10, 0);
  assert.equal(risk.metrics.seriousWindows.dev10.deviation, -60);
  assert.match(risk.reasons[0], /近2日累计偏离-60\.0%（10日内/);
});

test('near-serious status uses a shorter candidate and states its actual period', async () => {
  const tail = [100, 80];
  for (let day = 1; day <= 8; day += 1) tail.push(80 * 1.08 ** day);
  const { stock, index } = syntheticHistory(tail);
  const risk = await computeRisk('688610', '测试', riskDependencies(stock, index));
  assert.equal(risk.levelLabel, '接近严重异常波动');
  assert.ok(risk.metrics.dev10 < 80);
  assert.equal(risk.metrics.seriousWindows.dev10.days, 8);
  assert.ok(risk.metrics.seriousWindows.dev10.severity > 0.8);
  assert.match(risk.reasons[0], /近8日偏离\+85\.1%（10日内）/);
});

test('serious threshold equality survives floating point noise at both upward boundaries', async () => {
  const hundred = syntheticHistory([5, 6, 7], [500, 600, 200]);
  const hundredRisk = await computeRisk('688610', '测试', riskDependencies(hundred.stock, hundred.index));
  assert.equal(hundredRisk.level, 'serious');
  assert.equal(hundredRisk.metrics.seriousWindows.dev10.deviation, 100);
  assert.match(hundredRisk.reasons[0], /近2日累计偏离\+100\.0%（10日内/);

  const twoHundred = syntheticHistory([3, 11], [300, 500]);
  const twoHundredRisk = await computeRisk('688610', '测试', riskDependencies(twoHundred.stock, twoHundred.index));
  assert.equal(twoHundredRisk.level, 'serious');
  assert.equal(twoHundredRisk.metrics.seriousWindows.dev30.deviation, 200);
  assert.match(twoHundredRisk.reasons[0], /近1日累计偏离\+200\.0%（30日内/);
});

test('a missing intermediate thirty-day candidate cannot be ignored when complete endpoints exist', async () => {
  const { stock, index, byDate } = syntheticHistory([100, 90, 108, 129.6]);
  const missingDate = stock.rows.at(-15).date;
  byDate.delete(missingDate);
  for (const days of [3, 10, 30]) assert.ok(Number.isFinite(cumDeviation(stock.rows, byDate, days)));
  assert.ok(abnormalWindow(stock.rows, byDate));
  assert.equal(deviationWindow(stock.rows, byDate, 30, { up: 200, down: -70 }), null);
  index.rows = index.rows.filter(({ date }) => date !== missingDate);
  await assert.rejects(computeRisk('688610', '测试', riskDependencies(stock, index)), /同期指数数据缺失/);
});

function realFixture() {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/suspension688610-exrights.json', import.meta.url), 'utf8'));
  return {
    raw: fixture,
    stock: parseTencentDailyKline(fixture.stock, SYMBOL),
    index: parseTencentDailyKline(fixture.index, 'sh000688', { isIndex: true }),
  };
}

function riskDependencies(stock, index) {
  return {
    today: '2026-10-20',
    loadDaily: async (code, { isIndex }) => {
      assert.equal(code, isIndex ? '000688' : '688610');
      return isIndex ? index : stock;
    },
    loadFeed: async () => ({}),
  };
}

test('observed 31-session history produces normal risk with corrected 3/10/30-day deviations and zero events', async () => {
  const { stock, index } = realFixture();
  const byDate = new Map(index.rows.map(({ date, close }) => [date, close]));
  const cases = [
    [3, 118.5, 1359.52, -3.5847568969560872],
    [10, 152.62, 1569.34, -11.65654080020867],
    [30, 171.9, 1684.39, -14.100502284640104],
  ];
  for (const [days, stockStart, indexStart, expected] of cases) {
    // This is an independent endpoint expression for the single observed
    // action: raw stock return multiplied by old-close/ex-rights-reference.
    const endpointExpectation = (80.4 / stockStart * (113 / 80.57) - 1342.42 / indexStart) * 100;
    closeTo(endpointExpectation, expected);
    closeTo(cumDeviation(stock.rows, byDate, days), endpointExpectation);
  }
  const result = await computeRisk('688610', '埃科光电', riskDependencies(stock, index));
  assert.equal(result.level, 'normal');
  assert.equal(result.levelLabel, '正常');
  assert.equal(result.asOf, '2026-10-20');
  assert.equal(result.metrics.dev3, -3.58);
  assert.equal(result.metrics.dev10, -11.66);
  assert.equal(result.metrics.dev30, -14.1);
  assert.equal(result.metrics.abnEventCount10, 0);
});

test('Tencent validates the latest reference against a quote only for the same trading date', () => {
  const { raw } = realFixture();
  const source = raw.stock.data[SYMBOL];
  source.day = source.day.slice(0, -1); // Ex-rights session 2026-10-19.
  const quote = source.qt[SYMBOL];
  quote[30] = '20261019150000';
  quote[4] = '80.57';
  closeTo(parseTencentDailyKline(raw.stock, SYMBOL).rows.at(-1).referenceClose, 80.57);
  quote[4] = '113.00';
  assert.throws(() => parseTencentDailyKline(raw.stock, SYMBOL), /参考前收价/);
  quote[30] = '20261016150000';
  closeTo(parseTencentDailyKline(raw.stock, SYMBOL).rows.at(-1).referenceClose, 80.57);
});

test('Eastmoney rejects missing or contradictory reference-price evidence', () => {
  const missingChange = eastmoneyPayload(REAL_DAYS);
  const fields = missingChange.data.klines[2].split(',');
  fields[9] = '';
  missingChange.data.klines[2] = fields.join(',');
  assert.throws(() => parseEastmoneyDailyKline(missingChange), /参考前收价/);
  const inconsistent = eastmoneyPayload(REAL_DAYS);
  const conflictingFields = inconsistent.data.klines[2].split(',');
  conflictingFields[8] = '-29.90';
  inconsistent.data.klines[2] = conflictingFields.join(',');
  assert.throws(() => parseEastmoneyDailyKline(inconsistent), /不一致/);
});

async function invokeHandler(handler, name = '埃科光电') {
  const headers = {};
  const response = {
    setHeader(key, value) { headers[key] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  await handler({ url: `/api/suspension-alert?code=688610&name=${encodeURIComponent(name)}` }, response);
  return { ...response, headers };
}

test('handler ignores raw-close and fixed-three-session caches and separates corrected results by name', async () => {
  const name = 'ST 测试';
  const fixedThreeKey = `suspend-alert:reference-v2:688610:${encodeURIComponent(name)}`;
  const cached = new Map([
    ['suspend-alert:688610', JSON.stringify({ level: 'abnormal_or_near_serious' })],
    [fixedThreeKey, JSON.stringify({ level: 'normal' })],
  ]);
  const reads = [], writes = [], calculations = [];
  const redis = {
    get: async key => { reads.push(key); return cached.get(key); },
    set: async (key, value, options) => { writes.push({ key, options }); cached.set(key, value); },
  };
  const handler = createSuspensionAlertHandler({
    getRedis: async () => redis,
    compute: async (code, name) => { calculations.push({ code, name }); return { level: 'normal', code, name }; },
  });
  const expectedKey = `suspend-alert:reference-v3:688610:${encodeURIComponent(name)}`;
  const fresh = await invokeHandler(handler, name);
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.body.level, 'normal');
  assert.deepEqual(calculations, [{ code: '688610', name }]);
  assert.deepEqual(reads, [expectedKey]);
  assert.deepEqual(writes, [{ key: expectedKey, options: { EX: 300 } }]);
  assert.equal((await invokeHandler(handler, name)).body.level, 'normal');
  assert.equal(calculations.length, 1);
  await invokeHandler(handler, '测试');
  assert.equal(calculations.length, 2);
  assert.notEqual(writes[0].key, writes[1].key);
  assert.ok(!reads.includes('suspend-alert:688610'));
  assert.ok(!reads.includes(fixedThreeKey));
});

test('incomplete reference or benchmark data returns 502 and is never cached as normal', async (t) => {
  for (const missing of ['reference', 'benchmark', 'event-window benchmark']) await t.test(missing, async () => {
    const { stock, index } = realFixture();
    if (missing === 'reference') stock.rows.at(-2).referenceClose = null;
    else if (missing === 'benchmark') index.rows = index.rows.slice(0, -1);
    else {
      // October 14 is not one of today's 3/10/30-day endpoints. It is an
      // endpoint of historical 3-day windows needed by the event counter.
      index.rows = index.rows.filter(({ date }) => date !== '2026-10-14');
      const byDate = new Map(index.rows.map(({ date, close }) => [date, close]));
      for (const days of [3, 10, 30]) assert.ok(Number.isFinite(cumDeviation(stock.rows, byDate, days)));
      assert.throws(() => countSameDirAbnormal(stock.rows, byDate, 30, 10), /同期指数数据缺失/);
    }
    const dependencies = riskDependencies(stock, index);
    await assert.rejects(computeRisk('688610', '埃科光电', dependencies), /参考前收价|同期指数/);
    let writes = 0;
    const handler = createSuspensionAlertHandler({
      compute: (code, name) => computeRisk(code, name, dependencies),
      getRedis: async () => ({ get: async () => null, set: async () => { writes += 1; } }),
    });
    const result = await invokeHandler(handler);
    assert.equal(result.statusCode, 502);
    assert.match(result.body.error, /参考前收价|同期指数/);
    assert.equal(result.body.level, undefined);
    assert.equal(writes, 0);
  });
});

function tencentAfterEastmoneyFailure(raw, { adjustedOnly = false } = {}) {
  const calls = [];
  const request = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.hostname.endsWith('eastmoney.com')) return { ok: false, status: 503 };
    assert.equal(parsed.origin, 'https://ifzq.gtimg.cn');
    assert.equal(parsed.pathname, '/appstock/app/kline/kline');
    const symbol = parsed.searchParams.get('param').split(',')[0];
    const payload = structuredClone(symbol === SYMBOL ? raw.stock : raw.index);
    if (adjustedOnly && symbol === SYMBOL) {
      const source = payload.data[symbol];
      source.qfqday = source.day;
      delete source.day;
    }
    return { ok: true, json: async () => payload };
  };
  return { calls, request };
}

test('daily loading falls through all three Eastmoney hosts to raw Tencent day and computes risk without qfq data', async () => {
  const { raw } = realFixture();
  assert.equal(raw.stock.data[SYMBOL].qfqday, undefined);
  const { calls, request } = tencentAfterEastmoneyFailure(raw);
  const stock = await fetchDailyKline('688610', { request });
  closeTo(stock.rows.at(-2).referenceClose, 80.57);
  assert.equal(stock.rows.at(-3).close, 113);
  assert.deepEqual(calls.map(({ url }) => url.origin), [
    'https://push2his.eastmoney.com',
    'https://79.push2his.eastmoney.com',
    'https://82.push2his.eastmoney.com',
    'https://ifzq.gtimg.cn',
  ]);
  calls.length = 0;
  const risk = await computeRisk('688610', '埃科光电', {
    today: '2026-10-20',
    loadDaily: (code, options) => fetchDailyKline(code, { ...options, request }),
    loadFeed: async () => ({}),
  });
  assert.equal(risk.level, 'normal');
  assert.equal(risk.metrics.dev3, -3.58);
  assert.equal(risk.metrics.dev10, -11.66);
  assert.equal(risk.metrics.dev30, -14.1);
  assert.equal(risk.metrics.abnEventCount10, 0);
  assert.equal(calls.length, 8);
  const tencentCalls = calls.filter(({ url }) => url.hostname === 'ifzq.gtimg.cn');
  assert.equal(tencentCalls.length, 2);
  for (const { url, options } of tencentCalls) {
    const param = url.searchParams.get('param').split(',');
    assert.ok([SYMBOL, 'sh000688'].includes(param[0]));
    assert.deepEqual(param.slice(1), ['day', '', '', '60']);
    assert.ok(options.signal instanceof AbortSignal);
  }
  for (const { url } of calls.filter(({ url }) => url.hostname.endsWith('eastmoney.com'))) {
    assert.equal(url.searchParams.get('fqt'), '0');
  }
});

test('daily loading rejects Tencent qfq-only fallback after every Eastmoney host fails', async () => {
  const { raw } = realFixture();
  const { calls, request } = tencentAfterEastmoneyFailure(raw, { adjustedOnly: true });
  await assert.rejects(fetchDailyKline('688610', { request }), /腾讯日K.*不复权日K/);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.at(-1).url.searchParams.get('param').split(',').slice(1), ['day', '', '', '60']);
});

test('daily loading scopes Tencent action parsing to the requested recent snapshot', async () => {
  const { raw } = realFixture();
  raw.stock.data[SYMBOL].day.unshift(
    tencentLine('2026-08-27', 100),
    tencentLine('2026-08-28', 100, { cqr: '2026-08-28', FHcontent: '10配3股配股价5元' }),
  );
  const { request } = tencentAfterEastmoneyFailure(raw);
  const stock = await fetchDailyKline('688610', { request, limit: 31 });
  assert.equal(stock.rows.length, 31);
  assert.equal(stock.rows[0].date, '2026-08-31');
  closeTo(stock.rows.at(-2).referenceClose, 80.57);
});
