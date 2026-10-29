export default function ChanControls({ options, onChange }) {
  if (!options) return null;
  const toggle = (key) => onChange({ ...options, [key]: !options[key] });
  const external = options.engine !== 'original';
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs text-slate-600">
      <button type="button" aria-pressed={options.enabled} onClick={() => toggle('enabled')}
        className={`rounded-lg px-2.5 py-1.5 ${options.enabled ? 'bg-amber-50 text-amber-700' : 'hover:bg-slate-100'}`}
        title={external ? '本项目笔与特征序列线段，按笔范围构造参考中枢；结果可能随新行情重算' : '本项目引擎：旧笔、特征序列线段与线段中枢'}>缠论</button>
      {options.enabled && <select aria-label="缠论引擎" value={external ? 'external' : 'original'}
        onChange={(event) => onChange({ ...options, engine: event.target.value })}
        className="max-w-full rounded-lg border border-slate-200 bg-white px-1.5 py-1.5 text-slate-700">
        <option value="external">笔构造参考中枢</option>
        <option value="original">本项目线段中枢</option>
      </select>}
      {options.enabled && [['bi', '笔'], ['segment', '线段'], ['zs', '中枢'], ...(!external ? [['penZs', '笔构造参考']] : []), ['fx', '分型']].map(([key, label]) => (
        <label key={key} className="inline-flex cursor-pointer items-center gap-1 px-1.5 py-1">
          <input type="checkbox" checked={!!options[key]} onChange={() => toggle(key)} className="accent-amber-600" />{label}
        </label>
      ))}
    </div>
  );
}
