import { Eye, EyeOff } from 'lucide-react';

// Shared SVG presentation for price indicators: frame, legend and crosses.
export function IndicatorFrame({ kind, left, right, top, height, middle, ticks }) {
  return <g data-indicator-frame={kind} data-panel-top={top} data-panel-height={height}>
    {/* The previous panel's bottom edge is the shared divider; do not draw a second top edge. */}
    <line x1={left} x2={right} y1={middle} y2={middle} stroke="var(--chart-grid-soft)" strokeDasharray="4 4" />
    <line {...{ [`data-${kind}-bottom`]: '' }} x1={left} x2={right} y1={top + height} y2={top + height} stroke="var(--chart-grid)" />
    {ticks.map(({ y, label }, index) => <text key={index} data-indicator-axis x={right + 8} y={y} fontSize="11" fill="var(--chart-ink-3)">{label}</text>)}
  </g>;
}

export function IndicatorHeader({ kind, top, title, items, columnWidth }) {
  return <g data-indicator-header={kind}>
    <text data-indicator-title {...(kind === 'fsl' ? { 'data-fsl-heading': '' } : {})} x="18" y={top + 14} fontSize="12" fill="var(--chart-ink-3)">{title}</text>
    {items.map((item, index) => {
      const x = 64 + index * columnWidth;
      return <text key={item.key} data-indicator-value={item.key}
        {...(kind === 'fsl' ? { 'data-fsl-value': item.key } : {})}
        x={x} y={top + 14} fontSize="12" fill={item.color}
        stroke="var(--chart-surface)" strokeWidth="3" paintOrder="stroke">{item.label}</text>;
    })}
  </g>;
}

export function IndicatorCrossMarker({ kind, type, date, x, y, labelX = x, labelY, title }) {
  const label = type === 'golden' ? '金叉' : '死叉';
  const color = type === 'golden' ? 'var(--chart-up)' : 'var(--chart-down)';
  return <g data-indicator-cross={kind} {...{ [`data-${kind}-cross`]: type }} data-date={date}>
    {title && <title>{title}</title>}
    <line x1={x} y1={y} x2={labelX} y2={labelY - 4} stroke={color} strokeWidth=".8" opacity=".7" />
    <circle cx={x} cy={y} r="6" fill="var(--chart-chip-soft)" stroke={color} strokeWidth="2" />
    <rect x={labelX - 16} y={labelY - 12} width="32" height="16" rx="8" fill="var(--chart-chip-strong)" stroke={color} strokeWidth="1" />
    <text {...(kind === 'fsl' ? { 'data-fsl-cross-label': '' } : {})} x={labelX} y={labelY} textAnchor="middle" fontSize="10" fontWeight="700" fill={color}>{label}</text>
  </g>;
}

export function IndicatorSignalToggle({ kind, top, shown, onToggle }) {
  const name = kind.toUpperCase();
  return <button type="button" data-indicator-toggle={kind}
    className="absolute right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/98 text-slate-500 shadow-sm backdrop-blur hover:border-slate-300 hover:bg-white hover:text-slate-700"
    style={{ top: top + 4 }}
    onClick={event => { event.stopPropagation(); onToggle(); }}
    title={`${shown ? '隐藏' : '显示'}${name}金叉/死叉标记`}
    aria-label={`${shown ? '隐藏' : '显示'}${name}金叉和死叉标记`}
    aria-pressed={shown}>
    {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
  </button>;
}
