import { Component, lazy, Suspense, useEffect, useState } from "react";
import { authJson, clearAuth } from "./lib/authClient.js";
import LoginPage from "./components/LoginPage";
import { useTheme } from "./theme";

const AShareTD9InteractiveChart = lazy(() => import("./components/AShareTD9InteractiveChart"));

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("App render error", error, info);
  }

  render() {
    if (this.state.error) {
      const message = this.state.error instanceof Error ? this.state.error.message : "页面渲染异常";

      return (
        <div className="min-h-screen bg-canvas p-6 text-slate-900">
          <div className="mx-auto max-w-xl rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800 shadow-sm">
            <div className="text-lg font-semibold">页面遇到异常</div>
            <div className="mt-2 text-sm leading-6">
              {message || "当前操作触发了异常，请重试。"}
            </div>
            <button
              type="button"
              className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              onClick={() => this.setState({ error: null })}
            >
              返回页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [auth, setAuth] = useState(null);
  const [notice, setNotice] = useState('');
  const [authError, setAuthError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let active = true;
    let revision = 0;
    async function refresh() {
      const requestRevision = ++revision;
      try {
        const data = await authJson('/api/auth/me', { signal: controller.signal });
        if (active && requestRevision === revision && localStorage.getItem('token') === token) {
          setAuth(data.user); setAuthError('');
        }
      } catch (error) {
        if (active && requestRevision === revision && error.name !== 'AbortError' && error.status !== 401) setAuthError(error.message);
      }
    }
    const expired = (event) => { setToken(null); setAuth(null); setNotice(event.detail || '请重新登录。'); };
    window.addEventListener('auth-expired', expired);
    window.addEventListener('auth-forbidden', refresh);
    window.addEventListener('focus', refresh);
    refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('auth-expired', expired); window.removeEventListener('auth-forbidden', refresh); window.removeEventListener('focus', refresh); };
  }, [token, retry]);
  useEffect(() => {
    function syncStorage(event) {
      if (event.key !== 'token' && event.key !== null) return;
      const nextToken = localStorage.getItem('token');
      if (nextToken === token) return;
      setAuth(null); setAuthError(''); setNotice(''); setToken(nextToken);
    }
    window.addEventListener('storage', syncStorage);
    return () => window.removeEventListener('storage', syncStorage);
  }, [token]);
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();

  function handleLogout(message = '') {
    clearAuth(); setToken(null); setAuth(null); setAuthError('');
    setNotice(typeof message === 'string' ? message : '');
  }
  function handleLogin(data) {
    setAuth(null); setNotice(''); setAuthError(''); setToken(data.token);
  }
  if (!token) return <LoginPage onLogin={handleLogin} notice={notice} />;
  if (!auth) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas text-sm text-slate-600">
    <p>{authError || '正在验证登录状态…'}</p>
    {authError && <button onClick={() => { setAuthError(''); setRetry((v) => v + 1); }}>重试</button>}
    <button onClick={() => handleLogout()}>返回登录</button>
  </div>;

  return (
    <AppErrorBoundary>
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-slate-500">正在加载行情工作台…</div>}>
        <AShareTD9InteractiveChart
          onLogout={handleLogout}
          user={auth}
          themePreference={themePreference}
          onThemeChange={setThemePreference}
        />
      </Suspense>
    </AppErrorBoundary>
  );
}
