import { useId } from 'react';
import { visibleOffset } from '../lib/chan/index.js';

export default function ChanOverlay({ layer, data, options, rows, chart }) {
  const clipId = useId();
  if (!options?.enabled || !data || !rows.length) return null;
  const offset = visibleOffset(data, rows);
  if (offset < 0) return null;
  const x = (time) => chart.x(time - 1 - offset);
  const path = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${chart.y(p.price)}`).join(' ');
  const active = data.zs.reduce((latest, z) => !latest || z.edt > latest.edt ? z : latest, null)?.id;
  const colors = ['rgba(255,193,7,0.18)', 'rgba(66,165,245,0.18)', 'rgba(171,71,188,0.16)',
    'rgba(38,166,154,0.18)', 'rgba(239,83,80,0.14)', 'rgba(255,167,38,0.18)'];
  return (
    <g data-chan-layer={layer} pointerEvents="none" aria-hidden="true">
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
          {options.fx && data.fx.map((f) => (
            <circle key={`${f.time}-${f.mark}`} cx={x(f.time)} cy={chart.y(f.price) + (f.mark === 'G' ? -10 : 10)}
              r="3.5" fill={f.mark === 'G' ? 'rgba(255,138,128,0.95)' : 'rgba(105,240,174,0.95)'}
              stroke={f.mark === 'G' ? '#ff8a80' : '#69f0ae'} strokeWidth="1" />
          ))}
          {options.bi && data.bi.map((p) => {
            const px = x(p.time), py = chart.y(p.price), top = p.mark === 'G';
            return <polygon key={`pen-${p.time}`} data-chan-endpoint={`${p.time}:${p.price}`}
              points={top ? `${px},${py + 9} ${px + 9},${py - 9} ${px - 9},${py - 9}`
                : `${px},${py - 9} ${px + 9},${py + 9} ${px - 9},${py + 9}`}
              fill={top ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)'} />;
          })}
        </>}
      </g>
    </g>
  );
}
