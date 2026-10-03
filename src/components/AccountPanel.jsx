import { useState } from 'react';
import { authJson, clearAuth, jsonRequest } from '../lib/authClient.js';

export default function AccountPanel({ user, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (newPassword !== confirmation) return setError('两次输入的新密码不一致。');
    setBusy(true); setError('');
    try {
      await authJson('/api/auth/change-password', jsonRequest('POST', { currentPassword, newPassword }));
      clearAuth();
      onLogout('密码已修改，请重新登录。');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 shadow-sm">
    <h2 className="text-lg font-semibold">账号设置</h2>
    <p className="mt-2 text-sm text-slate-500">{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</p>
    <form onSubmit={submit} className="mt-5 space-y-4">
      {[['原密码', currentPassword, setCurrentPassword, 'current-password'], ['新密码', newPassword, setNewPassword, 'new-password'], ['确认新密码', confirmation, setConfirmation, 'new-password']].map(([label, value, setter, autocomplete]) => <label key={label} className="block text-sm">{label}<input type="password" required minLength={6} value={value} onChange={(e) => setter(e.target.value)} autoComplete={autocomplete} className="mt-1 block w-full rounded-xl border border-slate-200 p-2" /></label>)}
      <p className="text-xs text-slate-500">修改后，所有设备上的旧登录凭证都会失效。</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? '正在修改…' : '修改密码'}</button>
    </form>
  </div>;
}
