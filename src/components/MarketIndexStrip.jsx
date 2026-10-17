import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { authFetch } from "../lib/authClient.js";

function quoteTimeLabel(value) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "";
  return time.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export default function MarketIndexStrip({ indices, selectedSymbol, onSelect }) {
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    let controller;
    async function refresh() {
      if (!active || pending || document.visibilityState === "hidden") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      setLoading(true);
      try {
        const response = await authFetch("/api/market-indices", { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !payload.ok || !Array.isArray(payload.indices)) throw new Error(payload.error || "指数行情加载失败");
        if (active) {
          setQuotes(payload.indices);
          setError("");
        }
      } catch (failure) {
        if (active) {
          setQuotes([]);
          setError(failure.name === "AbortError" ? "指数行情请求超时" : failure.message || "指数行情加载失败");
        }
      } finally {
        window.clearTimeout(timeout);
        pending = false;
        if (active) setLoading(false);
      }
    }
    void Promise.resolve().then(refresh);
    const timer = window.setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [retry]);

  return (
    <section className="market-index-strip" aria-label="常用指数" aria-busy={loading}>
      <div className="market-index-quotes">
        {indices.map((index) => {
          const quote = quotes.find((item) => item.tencentSymbol === index.tencentSymbol);
          const available = quote?.available && Number.isFinite(quote.price) && Number.isFinite(quote.pct);
          const time = available ? quoteTimeLabel(quote.quoteTime) : "";
          const issue = error || quote?.error || "指数行情暂不可用";
          return (
            <button key={index.code} type="button" onClick={() => onSelect(index)} aria-pressed={selectedSymbol === index.tencentSymbol}
              className={`market-index-quote rounded-lg text-left transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${selectedSymbol === index.tencentSymbol ? "bg-slate-100" : ""}`}
              title={`${index.name} ${index.tencentSymbol}\n${available ? `行情 ${time}（北京时间）` : loading ? "正在加载指数行情" : issue}\n在主图查看指数`}
              aria-label={`${index.name}，${available ? `${quote.price.toFixed(2)}，${quote.pct > 0 ? "+" : ""}${quote.pct.toFixed(2)}%` : loading ? "加载中" : "行情不可用"}，查看图表`}>
              <span className="block text-[11px] leading-4 text-slate-500">{index.name}</span>
              {available ? (
                <span className="market-index-values tabular-nums">
                  <span className="text-[13px] font-semibold leading-5 text-slate-800">{quote.price.toFixed(2)}</span>
                  <span className={`text-[11px] leading-5 ${quote.pct > 0 ? "text-red-600" : quote.pct < 0 ? "text-green-700" : "text-slate-500"}`}>
                    {quote.pct > 0 ? "+" : ""}{quote.pct.toFixed(2)}%
                  </span>
                </span>
              ) : <span className={`block text-xs leading-5 ${loading ? "text-slate-400" : "text-amber-700"}`}>{loading ? "加载中…" : "暂不可用"}</span>}
            </button>
          );
        })}
      </div>
      {error || quotes.some((quote) => !quote.available) ? (
        <button type="button" aria-label="重试指数行情" title={error || "部分指数行情不可用，点击重试"} disabled={loading}
          onClick={() => setRetry((value) => value + 1)} className="shrink-0 rounded-lg p-1.5 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      ) : null}
    </section>
  );
}
