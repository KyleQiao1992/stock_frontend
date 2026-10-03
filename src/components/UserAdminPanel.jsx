import { useEffect, useState } from 'react';
import { Button } from './ui/button.jsx';
import { Card } from './ui/card.jsx';
import { authJson, jsonRequest } from '../lib/authClient.js';

export default function UserAdminPanel({ user }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [resetUser, setResetUser] = useState(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    authJson(`/api/admin/users?q=${encodeURIComponent(search)}&page=${page}`, { signal: controller.signal })
      .then((data) => { setResult(data); setLoading(false); })
      .catch((error) => { if (error.name !== 'AbortError') { setError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [search, page, reload]);
  async function mutate(target, method, action, body) {
    setBusy(true); setError(''); setMessage('');
    try {
      await authJson(`/api/admin/users/${encodeURIComponent(target.username)}${action ? `/${action}` : ''}`, jsonRequest(method, body));
      setMessage('操作已完成。'); setResetUser(null); setPassword(''); setConfirmation('');
      setLoading(true); setReload((v) => v + 1);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  function update(target, body) {
    const description = body.role ? `将角色改为${body.role === 'admin' ? '管理员' : '普通用户'}` : body.status === 'disabled' ? '禁用账号并撤销所有登录' : '启用账号';
    if (window.confirm(`确认对 ${target.username} ${description}？`)) mutate(target, 'PATCH', '', body);
  }
  return <Card className="min-w-0 rounded-2xl p-4 sm:p-6">
    <h2 className="text-lg font-semibold text-slate-900">账号管理</h2>
    <form className="my-5 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query); setError(''); setLoading(true); setReload((v) => v + 1); }}>
      <input aria-label="搜索用户名" placeholder="搜索用户名" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 sm:max-w-sm" />
      <Button type="submit" className="min-h-11 rounded-xl">搜索</Button>
    </form>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-green-700">{message}</p>}
    {loading ? <p className="text-sm text-slate-500">正在加载账号…</p> : result && <>
      <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[880px] text-left text-sm text-slate-700"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{['用户名', '角色', '状态', '注册时间', '操作'].map((label) => <th key={label} className="whitespace-nowrap border-b border-slate-200 px-4 py-3">{label}</th>)}</tr></thead>
        <tbody>{result.data.map((target) => <tr key={target.id} className="transition hover:bg-slate-50">
          <td className="whitespace-nowrap border-b border-slate-200 px-4 py-3">{target.username}{target.username === user.username && '（当前账号）'}</td>
          <td className="whitespace-nowrap border-b border-slate-200 px-4 py-3"><span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{target.role === 'admin' ? '管理员' : '普通用户'}</span></td>
          <td className="whitespace-nowrap border-b border-slate-200 px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${target.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{target.status === 'active' ? '正常' : '已禁用'}</span></td>
          <td className="whitespace-nowrap border-b border-slate-200 px-4 py-3">{target.createdAt ? new Date(target.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
          <td className="whitespace-nowrap border-b border-slate-200 px-4 py-3"><div className="flex gap-2">
            <button disabled={busy || target.username === user.username} onClick={() => update(target, { role: target.role === 'admin' ? 'user' : 'admin' })} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-40">{target.role === 'admin' ? '设为普通用户' : '设为管理员'}</button>
            <button disabled={busy || target.username === user.username} onClick={() => update(target, { status: target.status === 'active' ? 'disabled' : 'active' })} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-40">{target.status === 'active' ? '禁用' : '启用'}</button>
            <button disabled={busy} onClick={() => { setResetUser(target); setPassword(''); setConfirmation(''); setError(''); }} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-40">重置密码</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`确认撤销 ${target.username} 在所有设备上的登录？`)) mutate(target, 'POST', 'revoke-sessions', {}); }} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-40">撤销登录</button>
          </div></td>
        </tr>)}</tbody></table></div>
      {result.data.length === 0 && <p className="py-4 text-sm text-slate-500">没有匹配的账号。</p>}
      <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-2 text-sm text-slate-500 sm:flex sm:gap-3"><Button variant="outline" className="rounded-lg px-3" disabled={page <= 1 || busy} onClick={() => { setLoading(true); setPage((v) => v - 1); }}>上一页</Button><span className="text-center text-xs sm:text-sm">第 {page} 页 · 共 {result.total} 个账号</span><Button variant="outline" className="rounded-lg px-3" disabled={page * result.pageSize >= result.total || busy} onClick={() => { setLoading(true); setPage((v) => v + 1); }}>下一页</Button></div>
    </>}
    {resetUser && <form className="mt-6 max-w-md space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5" onSubmit={(e) => {
      e.preventDefault();
      if (password !== confirmation) return setError('两次输入的新密码不一致。');
      if (window.confirm(`确认重置 ${resetUser.username} 的密码？所有旧登录凭证都会失效。`)) mutate(resetUser, 'POST', 'reset-password', { newPassword: password });
    }}>
      <h3 className="font-medium">重置 {resetUser.username} 的密码</h3>
      <label className="block text-sm font-medium text-slate-700">新密码<input required type="password" minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200" /></label>
      <label className="block text-sm font-medium text-slate-700">确认新密码<input required type="password" minLength={6} autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200" /></label>
      <div className="flex gap-4 text-sm"><Button type="submit" disabled={busy} className="rounded-xl">确认重置</Button><Button variant="outline" disabled={busy} className="rounded-xl" onClick={() => { setResetUser(null); setPassword(''); setConfirmation(''); }}>取消</Button></div>
    </form>}
  </Card>;
}
