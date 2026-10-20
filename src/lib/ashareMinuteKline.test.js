import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTencentQfqTransforms, fetchAshareMinuteKline, parseTencentCorporateAction } from './ashareMinuteKline.js';

const SNAPSHOT_TIME = Date.parse('2026-10-19T16:15:00+08:00');
function payload(symbol, key, rows, quoteTime = '20261019161455') {
  const qt = [];
  qt[30] = quoteTime;
  return { code: 0, data: { [symbol]: { [key]: rows, qt: { [symbol]: qt } } } };
}
function loader({ symbol, minutes, raw = [], qfq = [], quoteTime }) {
  const calls = [];
  const loadJson = async url => {
    const parsed = new URL(url), param = parsed.searchParams.get('param').split(',');
    calls.push({ path: parsed.pathname, param });
    assert.equal(param[0], symbol);
    if (parsed.pathname.endsWith('/mkline')) {
      const key = param[1], end = param[2], count = +param[3];
      assert.ok(count <= 800);
      return payload(symbol, key, minutes.filter(row => !end || row[0] < end).slice(-count), quoteTime);
    }
    if (parsed.pathname.endsWith('/fqkline/get')) return payload(symbol, 'qfqday', qfq, quoteTime);
    return payload(symbol, 'day', raw, quoteTime);
  };
  return { calls, loadJson };
}

// Source observations captured from Tencent on 2026-10-19: 688610's 10-for-4
// conversion plus CNY 2 dividend. mkline ignores a qfq argument and returns 113,
// while qfqday's matching previous close is 80.572.
const REAL_ACTION = { nd: '2026', fh_sh: '2', djr: '2026-10-16', cqr: '2026-10-19', FHcontent: '10派2元转4股' };
const REAL_RAW = [
  ['2026-10-16', '121.910', '113.000', '121.910', '111.510', '1977912.000'],
  ['2026-10-19', '81.500', '79.210', '81.500', '73.460', '2627883.000', REAL_ACTION],
];
const REAL_QFQ = [
  ['2026-10-16', '86.936', '80.572', '86.936', '79.507', '1977912.000'],
  ['2026-10-19', '81.500', '79.210', '81.500', '73.460', '2627883.000', REAL_ACTION],
];

test('688610 real ex-rights counterexample: price uses verified affine qfq; actual shares become lots', async () => {
  const { calls, loadJson } = loader({ symbol: 'sh688610', raw: REAL_RAW, qfq: REAL_QFQ, minutes: [
    ['202610161455', '121.91', '113.00', '121.91', '111.51', '1977912'],
    ['202610191500', '79.18', '79.21', '79.48', '79.18', '12942'],
  ] });
  const result = await fetchAshareMinuteKline({ symbol: 'sh688610', code: '688610', period: '5', loadJson, now: SNAPSHOT_TIME });
  assert.equal(result.klines.length, 2);
  const [before, after] = result.klines;
  assert.ok(Math.abs(before.close - 80.572) <= 0.001);
  assert.ok(Math.abs(before.open - 86.936) <= 0.001);
  assert.equal(before.volume, 19779.12);
  assert.equal(after.close, 79.21);
  assert.equal(after.volume, 129.42);
  assert.equal(after.turnover, null); // Tencent mkline does not publish bar turnover.
  assert.equal(after.date, '2026-10-19 15:00');
  assert.ok(Math.abs(after.pct) < 2); // No spurious -30% ex-rights gap.
  assert.equal(after.complete, true);
  assert.ok(result.sourceInfo.includes('qfq: corporate actions'));
  assert.equal(calls.filter(call => call.path.endsWith('/mkline')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/fqkline/get')).length, 1);
});

test('cash adjustment uses the same additive offset for every OHLC, not a daily close ratio', () => {
  const event = { cqr: '2026-10-19', FHcontent: '10派10元' };
  const raw = [['2026-10-16', 10, 15, 20, 5], ['2026-10-19', 10, 10, 11, 9, 100, event]];
  const qfq = [['2026-10-16', 9, 14, 19, 4], ['2026-10-19', 10, 10, 11, 9, 100, event]];
  const transforms = buildTencentQfqTransforms(raw, qfq, ['2026-10-16', '2026-10-19']);
  const previous = transforms.get('2026-10-16');
  assert.equal(previous.slope, 1);
  assert.ok(Math.abs(previous.offset + 1) < 1e-10);
  assert.deepEqual(transforms.get('2026-10-19'), { slope: 1, offset: 0 });
  // Tencent may use an effective cash amount with a different rounding convention.
  const adjustedCash = qfq.map(row => row[0] === '2026-10-16'
    ? [row[0], ...row.slice(1).map(value => value - 0.002)] : row);
  assert.ok(Math.abs(buildTencentQfqTransforms(raw, adjustedCash, ['2026-10-16']).get('2026-10-16').offset + 1.002) < 1e-10);
});

function generatedBars(count, step = 5) {
  const rows = [];
  for (let day = 0; rows.length < count; day += 1) {
    const date = new Date(Date.UTC(2026, 7, 1 + day)).toISOString().slice(0, 10).replaceAll('-', '');
    for (const [start, end] of [[570, 690], [780, 900]]) {
      for (let minute = start + step; minute <= end && rows.length < count; minute += step) {
        const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`;
        rows.push([`${date}${time}`, 100, 101, 102, 99, 20]);
      }
    }
  }
  return rows;
}

test('minute history is paginated with <=800 requests and retains unique full times beyond 500 bars', async () => {
  const minutes = generatedBars(1600);
  const { calls, loadJson } = loader({ symbol: 'sh603268', minutes });
  const result = await fetchAshareMinuteKline({ symbol: 'sh603268', period: 5, adjust: '0', limit: 1320, loadJson, now: SNAPSHOT_TIME });
  assert.equal(result.klines.length, 1320);
  assert.equal(new Set(result.klines.map(row => row.date)).size, 1320);
  assert.deepEqual(calls.map(call => +call.param[3]), [800, 520]);
  assert.equal(calls[1].param[2], minutes.at(-800)[0]);
  assert.ok(result.klines[0].date < result.klines.at(-1).date);
  assert.equal(result.klines[0].volume, 20);
});

test('retention boundaries and a server that ignores the history cursor stop pagination without duplicating bars', async () => {
  const minutes = generatedBars(800);
  const retained = loader({ symbol: 'sh603268', minutes });
  const result = await fetchAshareMinuteKline({ symbol: 'sh603268', period: '5', adjust: '0',
    limit: 1320, loadJson: retained.loadJson, now: SNAPSHOT_TIME });
  assert.equal(result.klines.length, 800);
  assert.equal(retained.calls.length, 2); // Second page is the actual retention boundary.
  let requests = 0;
  const repeated = await fetchAshareMinuteKline({ symbol: 'sh603268', period: '5', adjust: '0', limit: 1320,
    loadJson: async () => { requests += 1; return payload('sh603268', 'm5', minutes); }, now: SNAPSHOT_TIME });
  assert.equal(requests, 2);
  assert.equal(repeated.klines.length, 800);
  let retainedRequests = 0;
  const noQuoteAtBoundary = await fetchAshareMinuteKline({ symbol: 'sh603268', period: '5', adjust: '0', limit: 1320,
    loadJson: async () => {
      retainedRequests += 1;
      return retainedRequests === 1 ? payload('sh603268', 'm5', minutes)
        : { code: 0, data: { sh603268: { m5: [] } } };
    }, now: SNAPSHOT_TIME });
  assert.equal(noQuoteAtBoundary.quotePayload.data.sh603268.qt.sh603268[30], '20261019161455');
});

test('history-page quote snapshots cannot move time backwards or replace a valid clock with an invalid date', async () => {
  const minutes = generatedBars(800);
  minutes[799][0] = '202610191005';
  const scenarios = [
    { first: '20261019100800', second: '20261019095800', chosen: 'first', complete: true },
    { first: '20261019100800', second: '20260230101500', chosen: 'first', complete: true },
    { first: '20261019100800', second: '20261019', chosen: 'first', complete: true },
    { first: '20261019100800', second: '20261019100800', chosen: 'second', complete: true },
    { first: '20261019100800', second: '20261019100900', chosen: 'second', complete: true },
    { first: '20260230100800', second: '20261019100800', chosen: 'second', complete: true },
    { first: null, second: '20261019100800', chosen: 'second', complete: true },
    { first: '20261019', second: '20260230101500', chosen: 'first', complete: false },
  ];
  for (const scenario of scenarios) {
    let requests = 0;
    const result = await fetchAshareMinuteKline({ symbol: 'sh603268', period: '5', adjust: '0', limit: 801,
      loadJson: async () => {
        requests += 1;
        const response = payload('sh603268', 'm5', requests === 1 ? minutes : [],
          requests === 1 ? scenario.first : scenario.second);
        response.data.sh603268.qt.sh603268[1] = requests === 1 ? 'first' : 'second';
        return response;
      }, now: Date.parse('2026-10-19T10:10:00+08:00') });
    assert.equal(result.klines.length, 800);
    assert.equal(result.quotePayload.data.sh603268.qt.sh603268[1], scenario.chosen, JSON.stringify(scenario));
    assert.equal(result.klines.at(-1).complete, scenario.complete, JSON.stringify(scenario));
  }
});

test('30-minute index uses its explicit Shanghai symbol and unadjusted lot volumes without daily/fq requests', async () => {
  const { calls, loadJson } = loader({ symbol: 'sh000688', minutes: [
    ['202610191430', 1340, 1335, 1342, 1334, '10000'],
    ['202610191500', 1335, 1329.19, 1336, 1328, '171016'],
  ] });
  const result = await fetchAshareMinuteKline({ symbol: 'sh000688', period: '30', isIndex: true, loadJson, now: SNAPSHOT_TIME });
  assert.equal(result.klines.at(-1).volume, 171016);
  assert.equal(result.klines.at(-1).date, '2026-10-19 15:00');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].param[1], 'm30');
});

test('unclosed tail requires source close and local finalization delay; future source bars remain incomplete', async () => {
  const { loadJson } = loader({ symbol: 'sz000001', quoteTime: '20261019094200', minutes: [
    ['202610190935', 10, 11, 11, 10, 100], ['202610190940', 11, 12, 12, 11, 100],
  ] });
  const result = await fetchAshareMinuteKline({ symbol: 'sz000001', period: '5', adjust: '0', loadJson,
    now: Date.parse('2026-10-19T09:40:30+08:00') });
  assert.deepEqual(result.klines.map(row => row.complete), [true, false]);
  const future = loader({ symbol: 'sz000001', quoteTime: '20261019100300', minutes: [
    ['202610191000', 10, 11, 11, 10, 100], ['202610191005', 11, 12, 12, 11, 100],
  ] });
  const ongoing = await fetchAshareMinuteKline({ symbol: 'sz000001', period: '5', adjust: '0', loadJson: future.loadJson,
    now: Date.parse('2026-10-19T10:03:00+08:00') });
  assert.deepEqual(ongoing.klines.map(row => row.complete), [true, false]);
});

test('a final quote frozen at 15:00 completes the closing bar at 15:01 and on the next day', async () => {
  const { loadJson } = loader({ symbol: 'sz000001', quoteTime: '20261019150000', minutes: [
    ['202610191500', 11, 12, 12, 11, 100],
  ] });
  for (const now of ['2026-10-19T15:01:00+08:00', '2026-10-20T09:00:00+08:00']) {
    const result = await fetchAshareMinuteKline({ symbol: 'sz000001', period: '5', adjust: '0', loadJson,
      now: Date.parse(now) });
    assert.equal(result.klines[0].complete, true);
  }
});

test('without a source quote clock, successor bars do not complete future bars before local close', async () => {
  const result = await fetchAshareMinuteKline({ symbol: 'sz000001', period: '5', adjust: '0',
    loadJson: async () => ({ code: 0, data: { sz000001: { m5: [
      ['202610191000', 10, 11, 11, 10, 100],
      ['202610191005', 11, 12, 12, 11, 100],
      ['202610191010', 12, 13, 13, 12, 100],
    ] } } }), now: Date.parse('2026-10-19T10:03:00+08:00') });
  assert.deepEqual(result.klines.map(row => row.complete), [true, false, false]);
});

test('unsupported periods/adjustments and daily responses fail explicitly instead of changing period', async () => {
  const base = { symbol: 'sh603268', loadJson: async () => payload('sh603268', 'day', [['2026-10-19', 10, 10, 10, 10, 100]]) };
  await assert.rejects(fetchAshareMinuteKline({ ...base, period: '60' }), /仅支持/);
  await assert.rejects(fetchAshareMinuteKline({ ...base, period: '5', adjust: '2' }), /仅支持/);
  await assert.rejects(fetchAshareMinuteKline({ ...base, period: '5', code: '000688' }), /明确且一致/);
  await assert.rejects(fetchAshareMinuteKline({ ...base, period: '5' }), /没有返回 5 分钟/);
  await assert.rejects(fetchAshareMinuteKline({ ...base, period: '5', limit: 0.5 }), /根数无效/);
  const malformed = { ...base, period: '5', isIndex: true,
    loadJson: async () => payload('sh603268', 'm5', [['202610191500', null, 10, 10, 10, 100]]) };
  await assert.rejects(fetchAshareMinuteKline(malformed), /OHLC 格式异常/);
});

test('missing daily coverage, inconsistent adjusted OHLC, and unsupported rights events stop qfq', () => {
  assert.throws(() => buildTencentQfqTransforms(REAL_RAW, REAL_QFQ, ['2026-10-15']), /覆盖不足/);
  const corrupt = structuredClone(REAL_QFQ);
  corrupt[0][2] = '85.000';
  assert.throws(() => buildTencentQfqTransforms(REAL_RAW, corrupt, ['2026-10-16']), /不满足一致/);
  assert.throws(() => parseTencentCorporateAction({ cqr: '2026-10-19', FHcontent: '10配3股配股价5元' }), /暂不支持/);
  assert.throws(() => buildTencentQfqTransforms(REAL_RAW, [], ['2026-10-16']), /缺少同源/);
  assert.deepEqual(parseTencentCorporateAction({ cqr: '2026-10-19', FHcontent: '10送2股转增4股派1元' }),
    { date: '2026-10-19', cash: 0.1, bonus: 0.6000000000000001, content: '10送2股转增4股派1元' });
});
