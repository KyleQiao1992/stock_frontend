export default function ChanControls({ options, onChange }) {
  if (!options) return null;
  const toggle = (key) => onChange({ ...options, [key]: !options[key] });
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs text-slate-600">
      <button type="button" aria-pressed={options.enabled} onClick={() => toggle('enabled')}
        className={`rounded-lg px-2.5 py-1.5 ${options.enabled ? 'bg-amber-50 text-amber-700' : 'hover:bg-slate-100'}`}
        title="逐根处理包含与分型，按旧笔独立K条件连笔；色框为滑动笔重叠区，实线末端为动态极值">缠论</button>
      {options.enabled && [['bi', '笔'], ['zs', '重叠区'], ['fx', '分型']].map(([key, label]) => (
        <label key={key} className="inline-flex cursor-pointer items-center gap-1 px-1.5 py-1">
          <input type="checkbox" checked={!!options[key]} onChange={() => toggle(key)} className="accent-amber-600" />{label}
        </label>
      ))}
    </div>
  );
}
