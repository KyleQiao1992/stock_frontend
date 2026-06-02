import { Component } from "react";
import AShareTD9InteractiveChart from "./components/AShareTD9InteractiveChart";

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
        <div className="min-h-screen bg-slate-50 p-6 text-slate-900">
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
  return (
    <AppErrorBoundary>
      <AShareTD9InteractiveChart />
    </AppErrorBoundary>
  );
}
