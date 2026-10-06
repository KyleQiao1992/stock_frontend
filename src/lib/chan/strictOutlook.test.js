import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlook, buildTrades } from './outlook.js';

const candles = [{ time: '2026-10-06', close: 12 }];
const biPoints = [
  { time: '2026-09-01', price: 8, mark: 'D' },
  { time: '2026-09-09', price: 15, mark: 'G' },
  { time: '2026-09-18', price: 10, mark: 'D' },
];
const zone = {
  id: 'zs-fixture', sdt: '2026-08-01', edt: '2026-09-20', zg: 14, zd: 9,
  zg_time: '2026-08-18', zd_time: '2026-09-08',
  segment_count: 5, level: 'segment', algorithm: 'sequential_segments',
  label: '线段中枢（本图最小级别）', status: 'active',
};
const segment = {
  id: 'segment-fixture', start: { time: '2026-08-01', price: 8 },
  end: { time: '2026-09-09', price: 15 },
  startIndex: 0, endIndex: 3, direction: 'up', confirmed: true,
};

function outlook(overrides = {}) {
  return buildOutlook({ candles, biPoints, zsList: [zone], segments: [segment], close: 12, period: '101', ...overrides });
}

test('insufficient completed strokes cannot produce an outlook', () => {
  assert.equal(outlook({ biPoints: [] }).ok, false);
  assert.equal(outlook({ biPoints: [biPoints[0]] }).ok, false);
  assert.equal(outlook({ candles: [] }).ok, false);
});

test('stroke direction and price position never generate a trading signal', () => {
  const upwards = biPoints.slice(0, 2);
  for (const points of [biPoints, upwards]) {
    for (const close of [1, zone.zd, 12, zone.zg, 100]) {
      const result = outlook({ biPoints: points, close });
      assert.equal(result.ok, true);
      assert.equal(result.conclusion.kind_hint, 'STRUCTURE');
      assert.equal(result.conclusion.title, '缠论结构');
      assert.equal(result.conclusion.side, 'neutral');
      assert.equal(result.conclusion.bias, '中性');
      assert.equal(result.conclusion.is_hypothesis, false);
      assert.equal(result.conclusion.confirmed_signal, null);
      assert.equal(result.conclusion.latest_signal, null);
      assert.deepEqual(result.scenarios, []);
      assert.doesNotMatch(JSON.stringify(result), /"(?:score|score_max|next_points)"/);
      assert.doesNotMatch(result.conclusion.title, /买|卖/);
    }
  }
});

test('positions include the zone boundaries without implying a break or a signal', () => {
  assert.equal(outlook({ close: 15 }).levels.vs_zs, 'above');
  assert.equal(outlook({ close: 8 }).levels.vs_zs, 'below');
  assert.equal(outlook({ close: zone.zg }).levels.vs_zs, 'inside');
  assert.equal(outlook({ close: zone.zd }).levels.vs_zs, 'inside');
  assert.match(outlook({ close: 15 }).conclusion.invalidation, /现价穿越 ZG\/ZD 只改变相对位置/);
});

test('outlook exposes the evidence still needed for all three signal classes', () => {
  const result = outlook();
  assert.match(result.conclusion.trigger_condition, /趋势背驰及次级别证据/);
  assert.match(result.conclusion.trigger_condition, /依赖已确认的一类买卖点/);
  assert.match(result.conclusion.trigger_condition, /首次次级别回试完成且低点不跌破 ZG/);
  assert.match(result.conclusion.trigger_condition, /首次次级别回抽完成且高点不升破 ZD/);
  assert.match(result.disclaimer, /未递归计算/);
});

test('zone boundary dates come from their actual source endpoints', () => {
  const result = outlook();
  assert.equal(result.levels.zs_zg_bar, '2026-08-18 @ 14.00');
  assert.equal(result.levels.zs_zd_bar, '2026-09-08 @ 9.00');
  assert.equal(result.levels.zs_level, 'segment');
  assert.equal(result.levels.zs_segment_count, 5);
  const withoutDates = outlook({ zsList: [{ ...zone, zg_time: undefined, zd_time: undefined }] });
  assert.equal(withoutDates.levels.zs_zg_bar, '— @ 14.00');
  assert.equal(withoutDates.levels.zs_zd_bar, '— @ 9.00');
});

test('only confirmed segments enter the facts and pending strokes cannot change completed levels', () => {
  const pendingBi = [biPoints.at(-1), { time: '2026-10-06', price: 999, mark: 'G' }];
  const result = outlook({ pendingBi, segments: [segment, { ...segment, id: 'pending', confirmed: false, direction: 'down' }] });
  assert.equal(result.levels.completed_segment_count, 1);
  assert.equal(result.levels.last_segment_direction, 'up');
  assert.equal(result.levels.last_segment_start, '2026-08-01');
  assert.equal(result.levels.last_segment_end, '2026-09-09');
  assert.equal(result.levels.last_bi_high, 15);
  assert.equal(result.levels.last_bi_low, 10);
  assert.match(result.conclusion.structure_fact, /当前虚线笔尚未完成/);
  assert.doesNotMatch(result.conclusion.structure_fact, /999/);
});

test('absence of a zone or completed segment remains a neutral structural record', () => {
  const result = outlook({ zsList: [], segments: [] });
  assert.equal(result.levels.zs_zg, null);
  assert.equal(result.levels.zs_zd, null);
  assert.equal(result.levels.active_zs_id, null);
  assert.equal(result.levels.last_segment_direction, null);
  assert.equal(result.levels.vs_zs, 'none');
  assert.equal(result.conclusion.kind_hint, 'STRUCTURE');
  assert.match(result.conclusion.structure_fact, /尚无已确认线段/);
  assert.match(result.conclusion.observation, /当前不绘制中枢/);
});

test('a closed zone is explicitly identified as a past reference', () => {
  const result = outlook({ zsList: [{ ...zone, status: 'closed' }] });
  assert.equal(result.levels.zs_status, 'closed');
  assert.match(result.levels.zs_range, /最近已结束的线段中枢/);
  assert.doesNotMatch(result.levels.zs_range, /当前参考中枢/);
});

test('completed endpoint references preserve prices and dates and are not signal classes', () => {
  assert.deepEqual(buildTrades(), []);
  const trades = buildTrades(biPoints);
  assert.equal(trades.length, biPoints.length);
  for (const [index, trade] of trades.entries()) {
    const point = biPoints[biPoints.length - 1 - index];
    assert.equal(trade.time_str, point.time);
    assert.equal(trade.price, point.price);
    assert.equal(trade.tier, 'bi_reference');
    assert.match(trade.desc, /仅作结构定位/);
    assert.ok(['BI_S', 'BI_B'].includes(trade.kind));
  }
});
