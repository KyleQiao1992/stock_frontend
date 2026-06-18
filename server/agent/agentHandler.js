// 轻量 ReAct Agent 的 HTTP 入口： POST /api/agent/chat
// 请求体: { messages: [{ role: "user"|"assistant", content: string }] }
// 响应:   { ok, reply, steps }   steps 为本轮调用过的工具轨迹（便于前端展示/调试）。

import { chat, isConfigured } from "./llmClient.js";
import { TOOL_DEFS, makeToolContext, runTool } from "./tools.js";

const MAX_ITERS = 8;

const SYSTEM_PROMPT = [
  "你是一个嵌入在股票分析平台里的投研助手。",
  "你可以调用平台提供的工具来获取实时的 A 股/美股数据、因子、推荐、用户自选股以及自选股回测结果。",
  "原则：",
  "1. 需要数据时优先调用工具，不要凭空编造行情、财务或回测数字。",
  "2. 用户提到某只股票但没给代码时，先用 search_ashare 找代码。",
  "3. 工具返回的是 JSON 文本，请基于其中的真实字段作答。",
  "4. 用简洁的中文回答，必要时给出结构化要点；不做投资建议背书，只做客观分析。",
].join("\n");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body; // express 已解析
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function createAgentHandler() {
  return async function agentHandler(req, res) {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "仅支持 POST。" });
    }
    if (!isConfigured()) {
      return sendJson(res, 503, {
        ok: false,
        error: "Agent 未配置大模型。请在 .env.local 设置 AGENT_API_KEY（及可选的 AGENT_PROVIDER/AGENT_MODEL）。",
      });
    }

    try {
      const body = await readBody(req);
      const incoming = Array.isArray(body.messages) ? body.messages : [];
      const history = incoming
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, text: m.content }));

      if (!history.length) {
        return sendJson(res, 400, { ok: false, error: "messages 为空。" });
      }

      // 把前端传来的当前选中标的拼进系统提示，作为对话上下文。
      const ctxCodes = body.context || {};
      const contextLines = [];
      if (ctxCodes.ashare) contextLines.push(`当前用户正在查看的 A 股代码：${ctxCodes.ashare}`);
      if (ctxCodes.us) contextLines.push(`当前用户正在查看的美股代码：${ctxCodes.us}`);
      const system = contextLines.length
        ? `${SYSTEM_PROMPT}\n\n上下文（用户未指明标的时可参考）：\n${contextLines.join("\n")}`
        : SYSTEM_PROMPT;

      const ctx = makeToolContext(req);
      const steps = [];
      let reply = "";

      for (let i = 0; i < MAX_ITERS; i++) {
        const last = i === MAX_ITERS - 1;
        // 最后一轮不再给工具，逼模型给出文字结论。
        const { text, toolCalls } = await chat({
          system,
          history,
          tools: last ? [] : TOOL_DEFS,
        });

        if (!toolCalls.length) {
          reply = text;
          break;
        }

        // 记录这一轮助手的工具调用。
        history.push({ role: "assistant", text, toolCalls });

        for (const tc of toolCalls) {
          const result = await runTool(ctx, tc.name, tc.args);
          const step = { tool: tc.name, args: tc.args };
          // 从工具结果里解析出标的代码/名称，供前端「研究上下文」展示。
          try {
            const parsed = JSON.parse(result);
            const first = Array.isArray(parsed?.items) ? parsed.items[0] : null;
            step.code = parsed?.code || first?.code || "";
            step.name = parsed?.name || first?.name || "";
          } catch {
            // 结果非 JSON，忽略。
          }
          steps.push(step);
          history.push({ role: "tool", id: tc.id, name: tc.name, result });
        }
      }

      if (!reply) reply = "（已达到最大推理步数，未能给出最终结论，请重试或缩小问题范围。）";
      return sendJson(res, 200, { ok: true, reply, steps });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  };
}
