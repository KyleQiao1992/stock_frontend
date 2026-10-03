export function clearAuth() {
  for (const key of ['token', 'userId', 'username']) localStorage.removeItem(key);
}
export async function authFetch(url, opts = {}) {
  const token = localStorage.getItem('token');
  if (token && /[^\x20-\x7e]/.test(token)) {
    clearAuth();
    window.dispatchEvent(new CustomEvent('auth-expired', { detail: '登录信息异常，请重新登录。' }));
    throw new Error('登录信息异常，请重新登录。');
  }
  const headers = new Headers(opts.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { cache: 'no-store', ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    const message = body.error || (res.status === 401 ? '登录已失效，请重新登录。' : '没有操作权限。');
    if (res.status === 401) {
      // Ignore a late response from a previous account after another login.
      if (localStorage.getItem('token') === token) {
        clearAuth();
        window.dispatchEvent(new CustomEvent('auth-expired', { detail: message }));
      }
    } else window.dispatchEvent(new Event('auth-forbidden'));
    throw Object.assign(new Error(message), { status: res.status });
  }
  return res;
}
export async function authJson(url, opts = {}) {
  const res = await authFetch(url, opts);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || '操作失败，请重试。');
  return body;
}
export const jsonRequest = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
