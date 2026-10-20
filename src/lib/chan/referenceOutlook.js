import { parseKlineTime } from '../klinePeriod.js';

export const referenceTime = parseKlineTime;

const price = (v) => Number.isFinite(v) ? v.toFixed(2) : '—';
const normalizedPeriod = (period) => ({ 101: 'day', 102: 'week', 103: 'month', 5: '5m', 15: '15m', 30: '30m', 60: '60m', 240: '240m' })[period] || period;
function formatTime(value, period) {
  const time = referenceTime(value);
  return Number.isFinite(time) ? new Date((time + 8 * 3600) * 1000).toISOString()
    .slice(0, period.endsWith('m') ? 16 : 10).replace('T', ' ') : '—';
}
// Reference observations are hypotheses. Direction/zone position never creates a confirmed signal.
export function buildReferenceOutlook({ candles = [], biPoints = [], zsList = [], close, period = 'day' }) {
  period = normalizedPeriod(period);
  const asof = referenceTime(candles.at(-1)?.time) || 0;
  if (biPoints.length < 2 || !candles.length) return { ok: false, asof, period };
  const [a, b] = biPoints.slice(-2);
  const up = b.price > a.price;
  const extending = candles.some((c) => referenceTime(c.time) >= referenceTime(b.time)
    && (up ? c.high > b.price : c.low < b.price));
  const high = up ? b : a, low = up ? a : b;
  const zone = zsList.reduce((latest, z) => !latest || referenceTime(z.edt) > referenceTime(latest.edt) ? z : latest, null);
  // No zone evidence: retain facts without assigning a one/two/three class.
  if (!zone) return { ok: true, asof, period, conclusion: {
    title: '等待结构', kind: null, kind_hint: null, status: 'forming', status_label: '结构形成中',
    structure_fact: `最新完成笔方向：${up ? '向上' : '向下'}；现价 ${price(close)}，尚无滑动笔重叠区。`,
    observation: '尚无滑动笔重叠区，先跟踪末笔延伸及后续分型。', confirmed_signal: null, latest_signal: null,
  }, levels: { close, last_bi_high: high.price, last_bi_low: low.price }, scenarios: [] };
  const tag = (time, v) => `${formatTime(time, period)} @ ${price(v)}`;
  const range = `当前滑动笔重叠区 ${formatTime(zone.sdt, period)} ~ ${formatTime(zone.edt, period)}（ZG ${price(zone.zg)} / ZD ${price(zone.zd)}）`;
  const position = close > zone.zg ? 'above' : close < zone.zd ? 'below' : 'inside';
  const positionLabel = { above: '重叠区上方', below: '重叠区下方', inside: '重叠区内部' }[position];
  const title = `向${up ? '上' : '下'}末笔 · ${positionLabel}`;
  const context = { range, close: price(close), high: price(high.price), low: price(low.price),
    highBar: tag(high.time, high.price), lowBar: tag(low.time, low.price), zg: price(zone.zg), zd: price(zone.zd),
    zgBar: tag(zone.zg_time, zone.zg), zdBar: tag(zone.zd_time, zone.zd) };
  const observation = {
    above: '现价处于重叠区上方，接下来关注继续上行、首次回试或重新回到区间。',
    inside: '现价处于重叠区内部，接下来关注区间内往返，以及向上或向下离开后的走势。',
    below: '现价处于重叠区下方，接下来关注继续下行、首次反抽或重新回到区间。',
  }[position];
  const vsLabel = `${positionLabel}（${range}）`;
  const biasNote = `现价 ${price(close)} 位于${vsLabel}。`;
  // Restore conditional observations, without turning a price-position branch
  // into a detected signal. Lessons 20/101 require distinct structure sequences.
  const watches = {
    B1: { kind: 'B1', title: '一类买点观察', hypothetical: true,
      trigger: '若同级别下跌趋势末段出现底背驰，结合次级别转折，关注一买位置。',
      action: `图上末笔低点 ${context.lowBar} 可用于对照下探位置。` },
    S1: { kind: 'S1', title: '一类卖点观察', hypothetical: true,
      trigger: '若同级别上涨趋势末段出现顶背驰，结合次级别转折，关注一卖位置。',
      action: `图上末笔高点 ${context.highBar} 可用于对照上冲位置。` },
    B2: { kind: 'B2', title: '二类买点观察', hypothetical: true,
      trigger: '若已形成一买，其后的次级别回升结束，再次探底或回试的次级别走势结束时，关注二买。',
      action: '以真实一买及其后的走势为锚点；弱二买可以低于一买，不能只按“不破前低”判断。' },
    S2: { kind: 'S2', title: '二类卖点观察', hypothetical: true,
      trigger: '若已形成一卖，其后的次级别回落结束，再次上探或回抽的次级别走势结束时，关注二卖。',
      action: '以真实一卖及其后的走势为锚点；弱二卖可以高于一卖，不能只按“不破前高”判断。' },
    B3: { kind: 'B3', title: '三类买点观察', hypothetical: true,
      trigger: '若次级别走势向上离开同级别中枢，随后首次次级别回试完成，且低点不跌破该中枢ZG，关注三买。',
      action: '跟踪“向上离开 → 首次回试 → 回试完成”的先后顺序。' },
    S3: { kind: 'S3', title: '三类卖点观察', hypothetical: true,
      trigger: '若次级别走势向下离开同级别中枢，随后首次次级别回抽完成，且高点不升破该中枢ZD，关注三卖。',
      action: '跟踪“向下离开 → 首次回抽 → 回抽完成”的先后顺序。' },
  };
  const scenarios = [
    { id: 'A', name: '重叠区上方', bias: '上方位置',
      explain: '关注上行后的首次回试，以及继续上冲后是否出现转折结构。',
      condition: `后续收盘高于上沿 ${context.zg}（${context.zgBar}）。`,
      path: '上行延续 → 首次回试，或上冲后出现转折。', next_points: [watches.B3, watches.S1],
      invalid: `收盘不再高于 ${context.zg} 时，不再满足上方位置条件。` },
    { id: 'B', name: '重叠区内部', bias: '区间内位置',
      explain: '区间内的位置本身不决定买卖类型，重点观察已有一类买卖点之后的次级别回试。',
      condition: `后续收盘不低于下沿 ${context.zd}，且不高于上沿 ${context.zg}。`,
      path: '已有一类转折 → 次级别回升或回落 → 再次回试结束。', next_points: [watches.B2, watches.S2],
      invalid: `收盘低于 ${context.zd} 或高于 ${context.zg} 时，不再满足区间内位置条件。` },
    { id: 'C', name: '重叠区下方', bias: '下方位置',
      explain: '关注下行后的首次反抽，以及继续下探后是否出现转折结构。',
      condition: `后续收盘低于下沿 ${context.zd}（${context.zdBar}）。`,
      path: '下行延续 → 首次反抽，或下探后出现转折。', next_points: [watches.S3, watches.B1],
      invalid: `收盘不再低于 ${context.zd} 时，不再满足下方位置条件。` },
  ];
  return { ok: true, asof, period,
    conclusion: { kind: null, kind_hint: null, position_branch: `${up ? 'up' : 'down'}-${position}`,
      is_hypothesis: true, status: 'forming', status_label: '位置观察',
      title, side: null, summary: observation, basis: '', confirm_note: '',
      observation_basis: '仅依据最新完成笔方向与现价相对滑动笔重叠区的位置生成观察；未执行一二三类买卖点识别。',
      bias: '位置观察', bias_note: biasNote,
      structure_fact: `最新完成笔方向：${up ? '向上' : '向下'}${extending ? `，端点后出现${up ? '更高高点' : '更低低点'}` : ''}；现价 ${price(close)}，${vsLabel}。`,
      observation, action_hint: biasNote,
      invalidation: '现价跨过重叠区边界，位置分支随之改变；新行情或历史窗口变化也可能修正笔与重叠区。',
      confirmed_signal: null, latest_signal: null },
    scenarios,
    watch_note: '以下是后续条件观察，未判定已触发。图上价格来自笔与滑动重叠区，不能代替各类买卖点所需的级别、背驰及中枢结构。',
    levels: { close, last_bi_high: high.price, last_bi_low: low.price, last_bi_high_bar: context.highBar,
      last_bi_low_bar: context.lowBar, zs_zg: zone.zg, zs_zd: zone.zd,
      active_zs_id: `zs-${referenceTime(zone.sdt)}-${referenceTime(zone.edt)}`,
      zs_algorithm: zone.algorithm, zs_bi_count: zone.bi_count, zs_zg_bar: context.zgBar, zs_zd_bar: context.zdBar,
      zs_range: range, vs_zs: position, vs_zs_label: vsLabel, bias: '位置观察', bias_note: biasNote },
    disclaimer: '关键价旁标注对应K线时间。条件观察不构成投资建议。' };
}
