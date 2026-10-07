import { observationText, scenarioText } from './referenceOutlookText.js';

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
function fill(value, context) {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (_, key) => context[key]);
  if (Array.isArray(value)) return value.map((item) => fill(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, context)]));
  return value;
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
    structure_fact: `最新完成笔方向：${up ? '向上' : '向下'}；现价 ${price(close)}，尚无参考笔中枢。`,
    observation: '等待参考笔中枢形成。', confirmed_signal: null, latest_signal: null,
  }, levels: { close, last_bi_high: high.price, last_bi_low: low.price }, scenarios: [] };
  const tag = (time, v) => `${formatTime(time, period)} @ ${price(v)}`;
  const range = `当前参考中枢 ${formatTime(zone.sdt, period)} ~ ${formatTime(zone.edt, period)}（ZG ${price(zone.zg)} / ZD ${price(zone.zd)}）`;
  const position = close > zone.zg ? 'above' : close < zone.zd ? 'below' : 'inside';
  const positionLabel = { above: '中枢上方', below: '中枢下方', inside: '中枢内部' }[position];
  const kind = up ? { above: 'S1', inside: 'S2', below: 'S3' }[position] : { below: 'B1', inside: 'B2', above: 'B3' }[position];
  const side = up ? 'sell' : 'buy', bias = up ? '偏空' : '偏多';
  const title = `${{ 1: '一', 2: '二', 3: '三' }[kind[1]]}类${up ? '卖' : '买'}点观察`;
  const context = { range, close: price(close), high: price(high.price), low: price(low.price),
    highBar: tag(high.time, high.price), lowBar: tag(low.time, low.price), zg: price(zone.zg), zd: price(zone.zd),
    zgBar: tag(zone.zg_time, zone.zg), zdBar: tag(zone.zd_time, zone.zd) };
  // S3 is the symmetric branch; the captured reference cases cover B1/B2/B3/S1/S2.
  const observation = fill(observationText[kind] || '近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 价格已在中枢下方，若反抽中枢下沿不过，结构偏向三卖观察。 下沿参考K：{zdBar}。参考{range}。', context);
  const vsLabel = `${positionLabel}（${range}）`;
  const biasNote = `结构偏向${title}，现价 ${price(close)} 位于${vsLabel}；当前不是确认${up ? '卖' : '买'}点，倾向${up ? '先控制风险' : '观望'}并等待新确认 K。`;
  const triggers = {
    B1: '等待向下离开段背驰结束并出现反向笔，由新确认 K 触发一买信号。',
    B2: '等待回调结束且不破前低，并由转强 K 触发二买信号。',
    B3: '等待回踩当前参考中枢上沿不破，并由转强 K 触发三买信号。',
    S1: '等待向上离开段背驰结束并出现反向笔，由新确认 K 触发一卖信号。',
    S2: '等待反弹结束且不破前高，并由转弱 K 触发二卖信号。',
    S3: '等待反抽当前参考中枢下沿不过，并由转弱 K 触发三卖信号。',
  };
  const scores = kind.endsWith('1') ? [7, 5, 5] : kind.endsWith('2') ? [6, 8, 4] : [8, 4, 2];
  return { ok: true, asof, period,
    conclusion: { kind: null, kind_hint: kind, is_hypothesis: true, status: 'forming', status_label: '结构形成中',
      title, side, summary: observation, basis: '', confirm_note: '',
      observation_basis: '依据最新完成笔方向、未完成段方向与现价相对当前参考中枢的位置推断；不是已确认信号。',
      trigger_condition: triggers[kind], bias, bias_note: biasNote,
      structure_fact: `最新完成笔方向：${up ? '向上' : '向下'}${extending ? '，末笔仍在延伸' : ''}；现价 ${price(close)}，${vsLabel}。`,
      observation, action_hint: biasNote,
      invalidation: up ? `若收盘升破末笔高点 ${context.high} 或当前参考中枢上沿 ${context.zg}，当前偏空观察失效。`
        : `若收盘跌破末笔低点 ${context.low} 或当前参考中枢下沿 ${context.zd}，当前偏多观察失效。`,
      confirmed_signal: null, latest_signal: null },
    scenarios: fill(scenarioText[side], context).map((scenario, index) => ({ ...scenario, score: scores[index] })),
    levels: { close, last_bi_high: high.price, last_bi_low: low.price, last_bi_high_bar: context.highBar,
      last_bi_low_bar: context.lowBar, zs_zg: zone.zg, zs_zd: zone.zd,
      active_zs_id: `zs-${referenceTime(zone.sdt)}-${referenceTime(zone.edt)}`,
      zs_algorithm: zone.algorithm, zs_bi_count: zone.bi_count, zs_zg_bar: context.zgBar, zs_zd_bar: context.zdBar,
      zs_range: range, vs_zs: position, vs_zs_label: vsLabel, bias, bias_note: biasNote },
    disclaimer: '评分满分 10 分，依当前结构吻合度赋分；关键价旁标注对应 K 线时间。分支情景而非预言，不构成投资建议。' };
}
