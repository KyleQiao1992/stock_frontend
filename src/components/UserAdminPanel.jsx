import { useEffect, useState } from 'react';
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
  return <div className="rounded-2xl bg-white p-6 shadow-sm">
    <h2 className="text-lg font-semibold">账号管理</h2>
    <form className="my-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query); setError(''); setLoading(true); setReload((v) => v + 1); }}>
      <input aria-label="搜索用户名" placeholder="搜索用户名" value={query} onChange={(e) => setQuery(e.target.value)} className="rounded-xl border border-slate-200 p-2 text-sm" />
      <button className="rounded-xl bg-slate-900 px-4 text-sm text-white">搜索</button>
    </form>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-green-700">{message}</p>}
    {loading ? <p className="text-sm text-slate-500">正在加载账号…</p> : result && <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['用户名', '角色', '状态', '注册时间', '操作'].map((label) => <th key={label} className="border-b p-3">{label}</th>)}</tr></thead>
        <tbody>{result.data.map((target) => <tr key={target.id}>
          <td className="border-b p-3">{target.username}{target.username === user.username && '（当前账号）'}</td>
          <td className="border-b p-3">{target.role === 'admin' ? '管理员' : '普通用户'}</td>
          <td className="border-b p-3">{target.status === 'active' ? '正常' : '已禁用'}</td>
          <td className="border-b p-3">{target.createdAt ? new Date(target.createdAt).toLocaleString() : '—'}</td>
          <td className="border-b p-3"><div className="flex flex-wrap gap-3">
            <button disabled={busy || target.username === user.username} onClick={() => update(target, { role: target.role === 'admin' ? 'user' : 'admin' })} className="text-blue-700 disabled:opacity-40">{target.role === 'admin' ? '设为普通用户' : '设为管理员'}</button>
            <button disabled={busy || target.username === user.username} onClick={() => update(target, { status: target.status === 'active' ? 'disabled' : 'active' })} className="text-blue-700 disabled:opacity-40">{target.status === 'active' ? '禁用' : '启用'}</button>
            <button disabled={busy} onClick={() => { setResetUser(target); setPassword(''); setConfirmation(''); setError(''); }} className="text-blue-700">重置密码</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`确认撤销 ${target.username} 在所有设备上的登录？`)) mutate(target, 'POST', 'revoke-sessions', {}); }} className="text-blue-700">撤销登录</button>
          </div></td>
        </tr>)}</tbody></table></div>
      {result.data.length === 0 && <p className="py-4 text-sm text-slate-500">没有匹配的账号。</p>}
      <div className="mt-4 flex items-center gap-4 text-sm"><button disabled={page <= 1 || busy} onClick={() => { setLoading(true); setPage((v) => v - 1); }}>上一页</button><span>第 {page} 页 · 共 {result.total} 个账号</span><button disabled={page * result.pageSize >= result.total || busy} onClick={() => { setLoading(true); setPage((v) => v + 1); }}>下一页</button></div>
    </>}
    {resetUser && <form className="mt-6 max-w-md space-y-3 rounded-xl border border-slate-200 p-4" onSubmit={(e) => {
      e.preventDefault();
      if (password !== confirmation) return setError('两次输入的新密码不一致。');
      if (window.confirm(`确认重置 ${resetUser.username} 的密码？所有旧登录凭证都会失效。`)) mutate(resetUser, 'POST', 'reset-password', { newPassword: password });
    }}>
      <h3 className="font-medium">重置 {resetUser.username} 的密码</h3>
      <label className="block text-sm">新密码<input required type="password" minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <label className="block text-sm">确认新密码<input required type="password" minLength={6} autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <div className="flex gap-4 text-sm"><button disabled={busy} className="rounded-lg bg-slate-900 px-3 py-2 text-white">确认重置</button><button type="button" disabled={busy} onClick={() => { setResetUser(null); setPassword(''); setConfirmation(''); }}>取消</button></div>
    </form>}
  </div>;
}
