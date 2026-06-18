// 与具体大模型解耦的聊天客户端。
// 通过环境变量切换 provider，默认 Anthropic(Claude)，也支持任何 OpenAI 兼容接口
// （DeepSeek / Qwen-DashScope 兼容模式 / Zhipu 等）。不引入额外依赖，直接用 fetch。
//
// 统一的内部消息格式（history item）：
//   { role: "user", text }
//   { role: "assistant", text, toolCalls: [{ id, name, args }] }
//   { role: "tool", id, name, result }   // result 为字符串
//
// chat() 返回归一化后的一轮助手输出：{ text, toolCalls: [{ id, name, args }] }

const PROVIDER = (process.env.AGENT_PROVIDER || "anthropic").trim().toLowerCase();

const DEFAULTS = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-6",
  },
  openai: {
    // DeepSeek: https://api.deepseek.com/v1   Qwen 兼容模式: https://dashscope.aliyuncs.com/compatible-mode/v1
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
  },
};

function config() {
  const provider = PROVIDER === "openai" ? "openai" : "anthropic";
  const d = DEFAULTS[provider];
  const apiKey =
    process.env.AGENT_API_KEY?.trim() ||
    (provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim()) ||
    "";
  return {
    provider,
    apiKey,
    baseUrl: process.env.AGENT_BASE_URL?.trim() || d.baseUrl,
    model: process.env.AGENT_MODEL?.trim() || d.model,
    maxTokens: Number(process.env.AGENT_MAX_TOKENS) || 2048,
  };
}

export function isConfigured() {
  return Boolean(config().apiKey);
}

// ---- Anthropic ----

function toAnthropicMessages(history) {
  const out = [];
  for (const item of history) {
    if (item.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: item.text }] });
    } else if (item.role === "assistant") {
      const content = [];
      if (item.text) content.push({ type: "text", text: item.text });
      for (const tc of item.toolCalls || []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: "assistant", content });
    } else if (item.role === "tool") {
      // 连续的 tool 结果合并进同一条 user 消息。
      const block = { type: "tool_result", tool_use_id: item.id, content: item.result };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last._toolResults) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block], _toolResults: true });
      }
    }
  }
  return out.map(({ _toolResults, ...m }) => m);
}

async function chatAnthropic(cfg, { system, history, tools }) {
  const res = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system,
      messages: toAnthropicMessages(history),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM(anthropic) ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  let text = "";
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
  }
  return { text, toolCalls };
}

// ---- OpenAI 兼容 ----

function toOpenAiMessages(system, history) {
  const out = [{ role: "system", content: system }];
  for (const item of history) {
    if (item.role === "user") {
      out.push({ role: "user", content: item.text });
    } else if (item.role === "assistant") {
      const msg = { role: "assistant", content: item.text || null };
      if (item.toolCalls?.length) {
        msg.tool_calls = item.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      out.push(msg);
    } else if (item.role === "tool") {
      out.push({ role: "tool", tool_call_id: item.id, content: item.result });
    }
  }
  return out;
}

async function chatOpenAi(cfg, { system, history, tools }) {
  const res = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: toOpenAiMessages(system, history),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM(openai) ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function?.name, args };
  });
  return { text: msg.content || "", toolCalls };
}

export async function chat({ system, history, tools }) {
  const cfg = config();
  if (!cfg.apiKey) {
    throw new Error(
      "未配置大模型 API Key。请在 .env.local 设置 AGENT_API_KEY（或 ANTHROPIC_API_KEY / OPENAI_API_KEY）。",
    );
  }
  return cfg.provider === "openai"
    ? chatOpenAi(cfg, { system, history, tools })
    : chatAnthropic(cfg, { system, history, tools });
}
