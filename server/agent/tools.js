// Agent 工具定义。每个工具映射到项目已有的 /api/* 接口。
// 执行时通过本机 HTTP 自调用，并透传当前用户的 Bearer token，
// 从而完全复用现有的鉴权与按用户隔离逻辑（如自选股、回测）。

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const TOOL_SPECS = [
  {
    name: "search_ashare",
    description: "按关键词（名称/拼音/代码）搜索 A 股标的，返回匹配的股票代码与名称列表。需要代码时先用它。",
    parameters: {
      type: "object",
      properties: { keyword: { type: "string", description: "搜索关键词，如『茅台』或『600519』" } },
      required: ["keyword"],
    },
    run: (ctx, a) => ctx.apiGet("/api/ashare-search", { q: a.keyword }),
  },
  {
    name: "get_ashare_profile",
    description: "获取某只 A 股的公司概况/基本信息。入参为股票代码（如 600519）。",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    run: (ctx, a) => ctx.apiGet("/api/ashare-profile", { code: a.code }),
  },
  {
    name: "get_ashare_finance",
    description: "获取某只 A 股的财务数据。入参为股票代码（如 600519）。",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    run: (ctx, a) => ctx.apiGet("/api/ashare-finance", { code: a.code }),
  },
  {
    name: "get_us_kline",
    description: "获取股票 K 线数据。symbol 为标的代码；period 取 101=日线/102=周线/103=月线；limit 为返回根数。",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        period: { type: "string", enum: ["101", "102", "103"], default: "101" },
        limit: { type: "integer", default: 600 },
      },
      required: ["symbol"],
    },
    run: (ctx, a) =>
      ctx.apiGet("/api/us-kline", { symbol: a.symbol, period: a.period || "101", limit: a.limit || 600 }),
  },
  {
    name: "list_factors",
    description: "列出可用的因子。status 可选 production（生产）或 preliminary（初步），不传则全部。",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["production", "preliminary"] } },
    },
    run: (ctx, a) => ctx.apiGet("/api/factors", { status: a.status }),
  },
  {
    name: "get_recommendations",
    description: "获取系统推荐的股票列表。market 取 ashare（A股）或 us（美股），默认 ashare。",
    parameters: {
      type: "object",
      properties: { market: { type: "string", enum: ["ashare", "us"], default: "ashare" } },
    },
    run: (ctx, a) => ctx.apiGet("/api/recommendations", { market: a.market || "ashare" }),
  },
  {
    name: "get_favorites",
    description: "获取当前登录用户的自选股列表。market 取 ashare 或 us，默认 ashare。",
    parameters: {
      type: "object",
      properties: { market: { type: "string", enum: ["ashare", "us"], default: "ashare" } },
    },
    run: (ctx, a) => ctx.apiGet("/api/favorites", { market: a.market || "ashare" }),
  },
  {
    name: "backtest_favorites",
    description: "对当前用户自选股做收益回测，返回每只票在不同持有期的收益与汇总胜率统计。仅支持 A 股。",
    parameters: {
      type: "object",
      properties: {
        groups: { type: "string", description: "可选，逗号分隔的收藏夹名做过滤；不传则全部" },
        page: { type: "integer", default: 1 },
      },
    },
    run: (ctx, a) => ctx.apiGet("/api/favorites-backtest", { market: "ashare", groups: a.groups, page: a.page || 1 }),
  },
];

// 把工具规格转成给 LLM 的精简描述（去掉 run）。
export const TOOL_DEFS = TOOL_SPECS.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

const TOOL_MAP = new Map(TOOL_SPECS.map((t) => [t.name, t]));

// 构造工具执行上下文：基于当前请求的 host + token 自调用。
export function makeToolContext(req) {
  let token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  // 防御：token 必须是合法 Latin1，否则放进请求头会抛 ByteString。脏 token 直接丢弃。
  if (/[^\x00-\xff]/.test(token)) token = "";
  const base = process.env.AGENT_API_BASE?.trim() || `http://${req.headers.host}`;
  return {
    async apiGet(pathname, params) {
      const url = `${base}${pathname}${qs(params)}`;
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const text = await res.text();
      return text;
    },
  };
}

export async function runTool(ctx, name, args) {
  const tool = TOOL_MAP.get(name);
  if (!tool) return JSON.stringify({ error: `未知工具: ${name}` });
  try {
    const result = await tool.run(ctx, args || {});
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: error?.message || String(error) });
  }
}
