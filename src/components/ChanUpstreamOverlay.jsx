import { useId } from 'react';
import { visibleOffset } from '../lib/chan/index.js';

// Draw the upstream engine's own coordinates without joining its independent
// segment endpoints or assigning the local engine's confirmation semantics.
export default function ChanUpstreamOverlay({ layer, data, options, rows, chart }) {
  const clipId = useId();
  const raw = data.upstreamRaw;
  if (!options?.enabled || !raw || !rows.length) return null;
  const offset = visibleOffset(data, rows);
  if (offset < 0) return null;
  const x = (index) => chart.x(index - offset);
  const point = (index, value) => `${x(index)},${chart.y(value)}`;
  const dateAt = (index) => data.dates[index] ?? `第 ${index + 1} 根K`;
  const visible = (start, end) => end - offset >= 0 && start - offset < rows.length;
  const endpoints = raw.bis.flatMap((pen, index) => [
    { index: pen.i0, value: pen.p0, top: pen.dir < 0 },
    ...(index === raw.bis.length - 1 ? [{ index: pen.i1, value: pen.p1, top: pen.dir > 0 }] : []),
  ]);
  return <g data-chan-layer={layer} data-chan-engine="upstream" pointerEvents="none">
    <defs><clipPath id={clipId}><rect x={chart.margin.left} y={chart.margin.top} width={chart.plotW} height={chart.mainH} /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}>
      {layer === 'zones' && options.zs && raw.pivots.map((zone, index) => {
        const title = `开源原版笔中枢（非递归） · ${zone.count} 笔\n${dateAt(zone.i0)} 至 ${dateAt(zone.i1)}\nZG ${zone.zg} / ZD ${zone.zd} · GG ${zone.gg} / DD ${zone.dd}\n${zone.active ? '上游最新参考' : '上游历史参考'}${zone.upgraded ? ' · 上游九笔升级标记（不是递归级别证明）' : ''}\n上游未提供确认依据时刻`;
        return <rect key={index} data-chan-upstream-zone={index} data-chan-zone-zg={zone.zg} data-chan-zone-zd={zone.zd}
          data-chan-zone-start={zone.i0} data-chan-zone-end={zone.i1}
          x={x(zone.i0)} y={chart.y(zone.zg)} width={Math.max(0, x(zone.i1) - x(zone.i0))}
          height={Math.max(0, chart.y(zone.zd) - chart.y(zone.zg))}
          fill={zone.active ? 'rgba(47,111,237,0.22)' : 'rgba(255,193,7,0.18)'}
          stroke={zone.active ? 'rgba(126,182,255,0.9)' : 'rgba(255,193,7,0.55)'}
          strokeWidth={zone.active ? 2 : 1} role="img" aria-label={title}><title>{title}</title></rect>;
      })}
      {layer === 'lines' && <>
        {options.bi && raw.bis.map((pen, index) => <path key={index} data-chan-upstream-pen={index}
          d={`M${point(pen.i0, pen.p0)} L${point(pen.i1, pen.p1)}`} fill="none" stroke="#ffd54f" strokeWidth="1.5" />)}
        {options.bi && endpoints.map((p, index) => {
          const px = x(p.index), py = chart.y(p.value);
          return <polygon key={index} data-chan-upstream-endpoint={`${p.index}:${p.value}`}
            points={p.top ? `${px},${py + 9} ${px + 9},${py - 9} ${px - 9},${py - 9}`
              : `${px},${py - 9} ${px + 9},${py + 9} ${px - 9},${py + 9}`}
            fill={p.top ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)'} />;
        })}
        {options.segment && raw.segments.map((segment, index) => {
          const title = `开源原版简化线段 · ${segment.done ? '上游标记完成' : '上游标记发展中'}\n起点：${dateAt(segment.i0)} @ ${segment.p0}\n终点：${dateAt(segment.i1)} @ ${segment.p1}\n上游未提供确认依据时刻`;
          return <path key={index} data-chan-upstream-segment={index} data-chan-upstream-done={String(segment.done)}
            d={`M${point(segment.i0, segment.p0)} L${point(segment.i1, segment.p1)}`}
            fill="none" stroke="var(--chan-segment)" strokeWidth="2.75" strokeLinecap="round"
            strokeDasharray={segment.done ? undefined : '7 4'} pointerEvents="stroke" role="img" aria-label={title}
            tabIndex={visible(segment.i0, segment.i1) ? 0 : -1}><title>{title}</title></path>;
        })}
        {options.fx && raw.fractals.map((fract, index) => <circle key={index} data-chan-upstream-fractal={index}
          cx={x(fract.barIdx)} cy={chart.y(fract.price) + (fract.type === 'top' ? -10 : 10)} r="3.5"
          fill={fract.type === 'top' ? 'rgba(255,138,128,0.95)' : 'rgba(105,240,174,0.95)'} />)}
      </>}
    </g>
  </g>;
}
