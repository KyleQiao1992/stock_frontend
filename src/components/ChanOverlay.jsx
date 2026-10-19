import { useId } from 'react';
import { visibleOffset } from '../lib/chan/index.js';

export default function ChanOverlay({ layer, data, options, rows, chart, onSelectFractal }) {
  const clipId = useId();
  if (!options?.enabled || !data || !rows.length) return null;
  const offset = visibleOffset(data, rows);
  if (offset < 0) return null;
  const x = (time) => chart.x(time - 1 - offset);
  const path = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${chart.y(p.price)}`).join(' ');
  const dateAt = (time) => data.dates[time - 1] ?? `第 ${time} 根K`;
  const pointLabel = (point) => `${dateAt(point.time)} @ ${point.price}`;
  const visibleLine = (start, end) => end.time - 1 - offset >= 0
    && start.time - 1 - offset < rows.length;
  const segments = data.segments ?? [];
  const pendingSegments = data.pendingSegments ?? [];
  const segmentTitle = (segment) => `已确认${segment.direction === 'up' ? '向上' : '向下'}线段 · ${segment.stroke_count} 笔\n起点：${pointLabel(segment.start)}\n终点：${pointLabel(segment.end)}\n确认依据K：${dateAt(segment.confirmed_time)}（本次历史窗口复算，非系统首次观测时刻）`;
  const pendingTitle = pendingSegments.length === 2
    ? `发展中线段参考 · 尚未确认\n起点：${pointLabel(pendingSegments[0])}\n当前方向极值：${pointLabel(pendingSegments[1])}\n后续完成笔仍可能改变此参考，未计入已确认线段` : '';
  const active = data.zs.reduce((latest, z) => !latest || z.edt > latest.edt ? z : latest, null)?.id;
  const colors = ['rgba(255,193,7,0.18)', 'rgba(66,165,245,0.18)', 'rgba(171,71,188,0.16)',
    'rgba(38,166,154,0.18)', 'rgba(239,83,80,0.14)', 'rgba(255,167,38,0.18)'];
  const interaction = (point, kind) => onSelectFractal ? {
    role: 'button', tabIndex: point.time - 1 - offset >= 0 && point.time - 1 - offset < rows.length ? 0 : -1,
    'aria-hidden': point.time - 1 - offset < 0 || point.time - 1 - offset >= rows.length ? true : undefined,
    pointerEvents: 'all', style: { cursor: 'pointer' },
    'aria-label': `${point.mark === 'G' ? '顶' : '底'}分型详情${kind === 'bi' ? '（笔端）' : ''}`,
    'aria-haspopup': 'dialog', 'data-chan-fractal': `${kind}:${point.mark}:${point.time}`,
    onMouseDown: (event) => event.stopPropagation(),
    onTouchStart: (event) => event.stopPropagation(),
    onClick: (event) => { event.stopPropagation(); onSelectFractal(point, kind); },
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); onSelectFractal(point, kind);
      }
    },
  } : {};
  return (
    <g data-chan-layer={layer} pointerEvents="none" aria-hidden={onSelectFractal || options.segment ? undefined : true}>
      <defs><clipPath id={clipId}><rect x={chart.margin.left} y={chart.margin.top} width={chart.plotW} height={chart.mainH} /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {layer === 'zones' && options.zs && data.zs.map((z, i) => (
          <rect key={z.id} data-chan-zone={z.id} x={x(z.sdt)} y={chart.y(z.zg)} width={Math.max(0, x(z.edt) - x(z.sdt))}
            height={Math.max(0, chart.y(z.zd) - chart.y(z.zg))}
            fill={z.id === active ? 'rgba(47,111,237,0.22)' : colors[i % colors.length]}
            stroke={z.id === active ? 'rgba(126,182,255,0.9)' : colors[i % colors.length].replace(/0\.\d+\)$/, '0.55)')}
            strokeWidth={z.id === active ? 2 : 1}>
            <title>{`${z.label} · ${z.bi_count} 笔 · ZG ${z.zg} / ZD ${z.zd}`}</title>
          </rect>
        ))}
        {layer === 'lines' && <>
          {options.bi && <>
            <path data-chan-path="bi" d={path(data.biLine)} fill="none" stroke="#ffd54f" strokeWidth="1.5" strokeLinejoin="round" />
          </>}
          {options.segment && <>
            {segments.map((segment) => (
              <path key={segment.id} data-chan-path="segment" data-chan-segment={segment.id}
                d={path([segment.start, segment.end])} fill="none" stroke="var(--chan-segment)"
                strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"
                pointerEvents="stroke" role="img" aria-label={segmentTitle(segment)}
                tabIndex={visibleLine(segment.start, segment.end) ? 0 : -1}>
                <title>{segmentTitle(segment)}</title>
              </path>
            ))}
            {pendingSegments.length === 2 && <path data-chan-path="pending-segment"
              d={path(pendingSegments)} fill="none" stroke="var(--chan-segment)" strokeWidth="2.5"
              strokeDasharray="7 4" strokeLinecap="round" strokeLinejoin="round"
              pointerEvents="stroke" role="img" aria-label={pendingTitle}
              tabIndex={visibleLine(pendingSegments[0], pendingSegments[1]) ? 0 : -1}>
              <title>{pendingTitle}</title>
            </path>}
          </>}
          {options.fx && data.fx.map((f) => (
            <g key={`${f.time}-${f.mark}`} {...interaction(f, 'fx')}>
            {onSelectFractal && <rect x={x(f.time) - 10} y={chart.y(f.price) + (f.mark === 'G' ? -20 : 0)}
              width="20" height="20" fill="transparent" />}
            <circle cx={x(f.time)} cy={chart.y(f.price) + (f.mark === 'G' ? -10 : 10)}
              r="3.5" fill={f.mark === 'G' ? 'rgba(255,138,128,0.95)' : 'rgba(105,240,174,0.95)'}
              stroke={f.mark === 'G' ? '#ff8a80' : '#69f0ae'} strokeWidth="1" />
            {onSelectFractal && <title>{`${f.mark === 'G' ? '顶' : '底'}分型 · 点击查看原始与合并K线`}</title>}
            </g>
          ))}
          {options.bi && data.bi.map((p) => {
            const px = x(p.time), py = chart.y(p.price), top = p.mark === 'G';
            return <g key={`pen-${p.time}`} {...interaction(p, 'bi')}>
              {onSelectFractal && <rect x={px - 11} y={py - 11} width="22" height="22" fill="transparent" />}
              <polygon data-chan-endpoint={`${p.time}:${p.price}`}
              points={top ? `${px},${py + 9} ${px + 9},${py - 9} ${px - 9},${py - 9}`
                : `${px},${py - 9} ${px + 9},${py + 9} ${px - 9},${py + 9}`}
              fill={top ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)'} />
              {onSelectFractal && <title>{`${top ? '顶' : '底'}分型（笔端） · 点击查看原始与合并K线`}</title>}
            </g>;
          })}
        </>}
      </g>
    </g>
  );
}
