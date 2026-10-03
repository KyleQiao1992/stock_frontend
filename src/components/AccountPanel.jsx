import { useState } from 'react';
import { Button } from './ui/button.jsx';
import { Card } from './ui/card.jsx';
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
  return <Card className="mx-auto w-full max-w-lg rounded-2xl p-5 sm:p-6">
    <h2 className="text-lg font-semibold text-slate-900">账号设置</h2>
    <p className="mt-2 text-sm text-slate-500">{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</p>
    <form onSubmit={submit} className="mt-5 space-y-4">
      {[['原密码', currentPassword, setCurrentPassword, 'current-password'], ['新密码', newPassword, setNewPassword, 'new-password'], ['确认新密码', confirmation, setConfirmation, 'new-password']].map(([label, value, setter, autocomplete]) => <label key={label} className="block text-sm font-medium text-slate-700">{label}<input type="password" required minLength={6} value={value} onChange={(e) => setter(e.target.value)} autoComplete={autocomplete} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200" /></label>)}
      <p className="text-xs text-slate-500">修改后，所有设备上的旧登录凭证都会失效。</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy} className="min-h-11 w-full rounded-xl sm:w-auto">{busy ? '正在修改…' : '修改密码'}</Button>
    </form>
  </Card>;
}
