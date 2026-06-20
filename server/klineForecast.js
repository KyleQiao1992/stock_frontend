// K 线预测 handler：把历史 K 线转发给 Kronos 推理服务（Python/FastAPI），
// 返回未来若干根预测 K 线。Kronos 服务的搭建见 server/kronos-service/README.md。
//
// 前端用法：
//   POST /api/kline-forecast
//   body: { klines: [{date,open,high,low,close,volume,amount}, ...], pred_len?, freq? }
//   resp: { pred_len, model, klines: [{date,open,high,low,close,volume,amount}, ...] }

const KRONOS_SERVICE_URL = (process.env.KRONOS_SERVICE_URL || "http://127.0.0.1:8008").replace(/\/$/, "");

// Kronos 至少要看到 ~一段历史才有意义；同时限制最大数量，避免把超长序列发过去。
const MIN_HISTORY = 32;
const MAX_HISTORY = 512;
const DEFAULT_PRED_LEN = 30;
const MAX_PRED_LEN = 120;

function readJsonBody(req) {
  // 路由未挂 express.json()，这里自己读 body，保持与其他 handler 一致的零依赖风格。
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeKlines(input) {
  if (!Array.isArray(input)) throw new Error("klines 必须是数组");
  const rows = input
    .map((k) => ({
      date: String(k?.date || "").slice(0, 19),
      open: Number(k?.open),
      high: Number(k?.high),
      low: Number(k?.low),
      close: Number(k?.close),
      volume: Number(k?.volume) || 0,
      amount: Number(k?.amount) || 0,
    }))
    .filter((r) => r.date && [r.open, r.high, r.low, r.close].every(Number.isFinite));

  if (rows.length < MIN_HISTORY) {
    throw new Error(`历史 K 线不足，至少需要 ${MIN_HISTORY} 根（实际 ${rows.length}）`);
  }
  // 只取最近 MAX_HISTORY 根作为上下文。
  return rows.slice(-MAX_HISTORY);
}

export function createKlineForecastHandler() {
  return async function klineForecastHandler(req, res) {
    const reply = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };

    try {
      const body = await readJsonBody(req);
      const klines = sanitizeKlines(body.klines);
      const predLen = Math.min(Math.max(Number(body.pred_len) || DEFAULT_PRED_LEN, 1), MAX_PRED_LEN);
      const freq = ["B", "D", "W", "M"].includes(body.freq) ? body.freq : "B";

      const upstream = await fetch(`${KRONOS_SERVICE_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ klines, pred_len: predLen, freq }),
        signal: AbortSignal.timeout(120000), // CPU 推理可能较慢
      });

      const text = await upstream.text();
      if (!upstream.ok) {
        let detail = text;
        try {
          detail = JSON.parse(text)?.detail || text;
        } catch {
          /* 保留原始文本 */
        }
        return reply(502, { error: `Kronos 服务返回 ${upstream.status}: ${detail}` });
      }

      return reply(200, JSON.parse(text));
    } catch (error) {
      const msg = error?.message || String(error);
      // fetch 连不上服务时给出更友好的提示。
      const isDown = /fetch failed|ECONNREFUSED|timeout/i.test(msg);
      return reply(isDown ? 503 : 400, {
        error: isDown ? `无法连接 Kronos 服务（${KRONOS_SERVICE_URL}）：${msg}` : msg,
      });
    }
  };
}
