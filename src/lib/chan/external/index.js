import { analyzeChan } from '../index.js';

const SOURCE = 'https://github.com/JustinGongjj/chan-structure-workstation';
const REVISION = '274f7a2d730bf961aa93d1d33b4359a455c542cd';

/**
 * Use the production pen and feature-sequence segment chain, then the
 * project’s independent pen-reference lifecycle. The upstream pen-center
 * engine is retained as a comparison but is not used by this chart: it
 * truncates after 500 search iterations and treats a pen ending outside the
 * zone as immediate termination even if its range crosses the core.
 * This is an engineering pen-level reference, not a recursive movement center.
 */
export function analyzeExternalChan(rows, period = 'day') {
  const local = analyzeChan(rows, period);
  const definition = {
    ...local.definition,
    engine: 'external', source: SOURCE, revision: REVISION,
    label: '本项目笔和线段 + 笔构造参考中枢',
    zoneLevel: '已完成笔范围构造的参考区，非递归走势中枢',
    segmentSource: '本项目已确认笔和特征序列线段',
    confirmationScope: '笔、线段与笔参考中枢按当前历史窗口复算确认依据；不是系统首次观测时刻',
  };
  if (local.inputProblem) return { ...local, definition, upstream: null };

  const zs = local.penZs.map(zone => ({ ...zone,
    level: 'pen_reference', label: '笔构造参考中枢',
    segment_count: zone.pen_count, stroke_count: zone.pen_count,
  }));
  return {
    ...local, zs, zsUncertainty: local.penZsUncertainty, definition,
    // These signals are calculated from segment centers, not the pen-reference
    // geometry; do not present them as results of this mode.
    outlook: { ok: false, reason: 'combined_pen_center_reference' }, trades: [], upstream: null,
  };
}
