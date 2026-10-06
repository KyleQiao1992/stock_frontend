import { useId } from 'react';
import { visibleOffset } from '../lib/chan/index.js';

export default function ChanOverlay({ layer, data, options, rows, chart }) {
  const clipId = useId();
  if (!options?.enabled || !data || !rows.length) return null;
  const offset = visibleOffset(data, rows);
  if (offset < 0) return null;
  const x = (time) => chart.x(time - 1 - offset);
  const path = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${chart.y(p.price)}`).join(' ');
  const active = data.zs.findLast((z) => z.status === 'active')?.id;
  return (
    <g data-chan-layer={layer} pointerEvents="none" aria-hidden="true">
      <defs><clipPath id={clipId}><rect x={chart.margin.left} y={chart.margin.top} width={chart.plotW} height={chart.mainH} /></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {layer === 'zones' && options.zs && data.zs.map((z, i) => (
          <rect key={z.id} data-chan-zone={z.id} x={x(z.sdt)} y={chart.y(z.zg)} width={Math.max(0, x(z.edt) - x(z.sdt))}
            height={Math.max(0, chart.y(z.zd) - chart.y(z.zg))}
            fill={z.id === active ? 'var(--chan-active-fill)' : `var(--chan-zone-${i % 3})`}
            stroke={z.id === active ? 'var(--chan-active)' : 'var(--chan-zone-border)'} strokeWidth={z.id === active ? 1.8 : 1}>
            <title>{z.label} · {z.segment_count} 段 · ZG {z.zg} / ZD {z.zd}</title>
          </rect>
        ))}
        {layer === 'lines' && <>
          {options.bi && <>
            <path data-chan-path="bi" d={path(data.bi)} fill="none" stroke="var(--chan-bi)" strokeWidth="1.5" strokeLinejoin="round" />
            <path data-chan-path="pending-bi" d={path(data.pending)} fill="none" stroke="var(--chan-bi)" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
          </>}
          {options.segment && <>
            {data.segments.map((s) => <path key={s.id} data-chan-path="segment" d={path([s.start, s.end])}
              fill="none" stroke="var(--chan-segment)" strokeWidth="2.6" strokeLinejoin="round" />)}
            <path data-chan-path="pending-segment" d={path(data.pendingSegments)} fill="none"
              stroke="var(--chan-segment)" strokeWidth="2.2" strokeDasharray="8 5" opacity="0.65" />
          </>}
          {options.fx && data.fx.map((f) => (
            <circle key={`${f.time}-${f.mark}`} cx={x(f.time)} cy={chart.y(f.price) + (f.mark === 'G' ? -8 : 8)}
              r="3" fill={f.mark === 'G' ? 'var(--chan-top)' : 'var(--chan-bottom)'} />
          ))}
        </>}
      </g>
    </g>
  );
}
