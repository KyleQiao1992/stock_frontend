export function referenceTime(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
  const text = String(value ?? '').replace(' ', 'T');
  return Date.parse(`${text.length === 10 ? `${text}T00:00:00` : text}+08:00`) / 1000;
}

const price = (v) => Number.isFinite(v) ? v.toFixed(2) : '—';
const normalizedPeriod = (period) => ({ 101: 'day', 102: 'week', 103: 'month', 5: '5m', 15: '15m', 30: '30m', 60: '60m' })[period] || period;
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
    observation: '尚无滑动笔重叠区；未执行一二三类买卖点识别。', confirmed_signal: null, latest_signal: null,
  }, levels: { close, last_bi_high: high.price, last_bi_low: low.price }, scenarios: [] };
  const tag = (time, v) => `${formatTime(time, period)} @ ${price(v)}`;
  const range = `当前滑动笔重叠区 ${formatTime(zone.sdt, period)} ~ ${formatTime(zone.edt, period)}（ZG ${price(zone.zg)} / ZD ${price(zone.zd)}）`;
  const position = close > zone.zg ? 'above' : close < zone.zd ? 'below' : 'inside';
  const positionLabel = { above: '重叠区上方', below: '重叠区下方', inside: '重叠区内部' }[position];
  const title = `向${up ? '上' : '下'}末笔 · ${positionLabel}`;
  const context = { range, close: price(close), high: price(high.price), low: price(low.price),
    highBar: tag(high.time, high.price), lowBar: tag(low.time, low.price), zg: price(zone.zg), zd: price(zone.zd),
    zgBar: tag(zone.zg_time, zone.zg), zdBar: tag(zone.zd_time, zone.zd) };
  const observation = `最新完成笔${up ? '向上' : '向下'}，现价位于${positionLabel}；这是价格位置观察，未执行一二三类买卖点识别。${range}。`;
  const vsLabel = `${positionLabel}（${range}）`;
  const biasNote = `现价 ${price(close)} 位于${vsLabel}；位置观察不提供买卖点或操作信号。`;
  const verification = '后续需另行核验相应走势级别、原文递归中枢及各类买卖点适用的趋势、背驰、离开回试等条件；本功能未执行。滑动笔重叠区边界或单根 K 线不能直接推出一二三类买卖点。';
  const pendingCheck = () => [{ kind: 'verification', title: '买卖点需另行核验', trigger: verification,
    action: '此处只列后续核验项目，没有识别或确认买卖点。', hypothetical: true }];
  const scenarios = [
    { id: 'A', name: '重叠区上方', bias: '上方位置',
      explain: `假设后续收盘位于滑动笔重叠区上方，仅描述价格位置。${range}。`,
      condition: `后续收盘高于上沿 ${context.zg}（${context.zgBar}）。`,
      path: '进入或保持重叠区上方 → 观察后续是否返回区间。', next_points: pendingCheck(),
      invalid: `收盘不再高于 ${context.zg} 时，不再满足上方位置条件。` },
    { id: 'B', name: '重叠区内部', bias: '区间内位置',
      explain: `假设后续收盘位于滑动笔重叠区内，仅描述价格位置。${range}。`,
      condition: `后续收盘不低于下沿 ${context.zd}，且不高于上沿 ${context.zg}。`,
      path: '进入或保持重叠区内部 → 观察后续是否越过边界。', next_points: pendingCheck(),
      invalid: `收盘低于 ${context.zd} 或高于 ${context.zg} 时，不再满足区间内位置条件。` },
    { id: 'C', name: '重叠区下方', bias: '下方位置',
      explain: `假设后续收盘位于滑动笔重叠区下方，仅描述价格位置。${range}。`,
      condition: `后续收盘低于下沿 ${context.zd}（${context.zdBar}）。`,
      path: '进入或保持重叠区下方 → 观察后续是否返回区间。', next_points: pendingCheck(),
      invalid: `收盘不再低于 ${context.zd} 时，不再满足下方位置条件。` },
  ];
  return { ok: true, asof, period,
    conclusion: { kind: null, kind_hint: null, position_branch: `${up ? 'up' : 'down'}-${position}`,
      is_hypothesis: true, status: 'forming', status_label: '位置观察',
      title, side: null, summary: observation, basis: '', confirm_note: '',
      observation_basis: '仅依据最新完成笔方向与现价相对滑动笔重叠区的位置生成观察；未执行一二三类买卖点识别。',
      trigger_condition: verification, bias: '位置观察', bias_note: biasNote,
      structure_fact: `最新完成笔方向：${up ? '向上' : '向下'}${extending ? `，端点后出现${up ? '更高高点' : '更低低点'}` : ''}；现价 ${price(close)}，${vsLabel}。`,
      observation, action_hint: biasNote,
      invalidation: '现价跨过重叠区边界，位置分支随之改变；新行情或历史窗口变化也可能修正笔与重叠区。',
      confirmed_signal: null, latest_signal: null },
    scenarios,
    levels: { close, last_bi_high: high.price, last_bi_low: low.price, last_bi_high_bar: context.highBar,
      last_bi_low_bar: context.lowBar, zs_zg: zone.zg, zs_zd: zone.zd,
      active_zs_id: `zs-${referenceTime(zone.sdt)}-${referenceTime(zone.edt)}`,
      zs_algorithm: zone.algorithm, zs_bi_count: zone.bi_count, zs_zg_bar: context.zgBar, zs_zd_bar: context.zdBar,
      zs_range: range, vs_zs: position, vs_zs_label: vsLabel, bias: '位置观察', bias_note: biasNote },
    disclaimer: '以上为末笔方向与滑动笔重叠区位置的分支情景，未执行一二三类买卖点识别。关键价旁标注对应 K 线时间；不构成投资建议。' };
}
