# 港股功能调研与落地建议

调研日期：2026-09-20

## 结论

建议先做一个与现有 A 股、美股并列的“港股”个股页 MVP，第一版只承诺：港股搜索、日/周/月 K 线、前复权/后复权、自选与收藏夹、现有技术指标和缠论分析复用、基础行情卡片，以及清楚的数据时间与币种标识。

财报、公告、资金流、推荐、回测和港股大盘应分阶段接入。它们不是简单复用 A 股接口：港股财务口径、证券类别、交易币种、公司行动和数据许可都不同。如果在第一版一起做，最容易出现的是界面完成了，但数据不完整或口径不可信。

当前项目的腾讯行情接口已经现场验证可返回 `hk00700`、`hk09988`、`hk03690`、`hk00005` 和人民币柜台 `hk80700` 的名称、日线及快照。腾讯是港交所列明的 BMP 实时基本报价服务商，技术上可以取得非延时的基本价格、当日高低、成交量额等数据；详细结果见[腾讯港股行情接口调研](./tencent-hk-api-research.md)。腾讯网页接口本身没有公开的第三方再分发授权和 SLA，正式对外产品应向腾讯采购 BMP Third Party Service，或与其他港交所持牌供应商签约。

## 建议的产品范围

### P0：可用的港股个股页

- 顶部新增“港股”标签，布局沿用当前 A 股/美股个股页。
- 支持代码和名称搜索。展示代码统一为 5 位字符串，例如 `00700`、`09988`；输入可兼容 `700`、`00700`、`hk00700`、`0700.HK`，归一化后保存为 `00700`。
- 支持日 K、周 K、月 K 及前复权/后复权；复用现有 MA、MACD、RSI、KDJ、BOLL、TD9、缺口、缠论和画线。
- 基础信息至少包括名称、代码、交易币种、最新价、涨跌幅、成交量、成交额、行情时间和数据状态。市值必须随币种显示，不能继续使用隐含“人民币”的数值格式。
- 支持港股自选、收藏夹、新增/移除/移动收藏，Redis key 独立使用 `market=hk`。
- 默认自选可采用恒生指数、恒生中国企业指数或恒生科技指数中的高流动性股票，但清单需要定期更新，不能长期硬编码成“当前成分股”。
- 界面明确显示“实时/延时/收盘数据”、行情时间和来源。无法确认实时权利时，产品文案只能写“延时行情”。

### P1：公司资料与披露

- 公司简介：中英文名称、行业、上市板、上市日期、主要业务、交易币种、每手股数。
- 财务摘要：收入、归母净利润、每股盈利、资产负债、经营现金流；保留原报表币种和报告期，不把港股半年报强行映射成 A 股季报。
- 港交所披露易公告入口：按股票和公告类别展示标题、发布时间与原文链接。官方搜索适合作为原文入口；结构化财务指标仍需要单独的数据供应商或自建解析流程。
- 公司行动：拆股、合股、派息、供股、配股、特别股息和代码/每手股数变更。复权价格必须能追溯使用了哪些公司行动。

### P2：市场级与策略能力

- 恒生指数、国企指数、恒生科技指数趋势页。
- 港股推荐、因子、回测。因子库和回测日历必须按香港交易日、币种及公司行动重算，不能复用 A 股推荐 Redis key。
- 南向资金、沽空数据、港股通标识、VCM/CAS 标识和行业热力图。
- 资金流需要先定义数据来源和算法口径。现有 A 股“主力/小单”字段不能直接复制到港股并沿用同一解释。

## 港股与现有市场的关键差异

| 项目 | 港股实现要求 | 对现有页面的影响 |
| --- | --- | --- |
| 代码 | 以 5 位字符串展示，必须保留前导零；不同币种柜台有不同代码 | 不能复用 A 股 6 位校验，也不能转成数字 |
| 证券范围 | 港交所还包含 ETF、REIT、债券、窝轮、牛熊证等 | MVP 搜索应只收普通股；类型过滤应在证券主数据层完成 |
| 币种 | 常见为 HKD，也存在 RMB/USD 柜台；同一证券可有多个柜台 | 行情、金额、市值和收藏项都要携带 `currency` 与 `counterCode` |
| 每手股数 | 没有统一的固定手数，且发行人可变更 | 如果以后展示交易计算器，必须从证券主数据读取 board lot |
| 交易时间 | 全日交易包含 09:00–09:30 开市前、09:30–12:00 早市、13:00–16:00 午市及 16:00 后随机收市的收市竞价 | 行情状态不能套用 A 股时间；12:00–13:00 应显示午休而非收盘 |
| 涨跌限制 | 没有 A 股式的统一每日涨跌停；部分证券适用基于 5 分钟参考价的 VCM 冷静期 | 删除“涨跌停风险”类推断；如展示 VCM，必须标明适用证券和动态阈值 |
| 交易与交收 | 经纪可安排当日买入后当日卖出；交易所买卖一般 T+2 交收 | 文案不要写成 A 股 T+1；回测成交规则需单独配置 |
| 恶劣天气 | 自 2024-09-23 起，恶劣天气下市场原则上继续交易 | 不能再根据八号风球直接判定全天休市，应读取正式市场状态 |
| 公司名称 | 名称可能带 `-W`、`-S`、`-B`、`-SW` 等标记 | 名称应原样保存，同时将标记拆成结构化标签供筛选和解释 |
| 颜色 | 面向当前中文用户可继续红涨绿跌 | 颜色应归入用户/地区配置，避免未来英文版被固定死 |

港交所的现行交易时段见[证券市场交易时间](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=zh-cn)；每手股数没有统一标准，见[港交所公司行动交易安排指南](https://www.hkex.com.hk/-/media/HKEX-Market/Listing/Rules-and-Guidance/Archive/Other-Guidance-Materials-for-Listed-Issuers/d_ta_mu1607.pdf?la=en)；日内交易说明见[港交所证券交易 FAQ](https://www.hkex.com.hk/Global/Exchange/FAQ/Securities-Market/Trading?sc_lang=en)；VCM 机制见[港交所 VCM FAQ](https://www.hkex.com.hk/Global/Exchange/FAQ/Securities-Market/Trading/VCM?sc_lang=en)；交收安排见[港交所证券交收说明](https://www.hkex.com.hk/services/settlement-and-depository/settlement?sc_lang=en)；恶劣天气交易自 2024-09-23 实施，见[港交所实施通知](https://www.hkex.com.hk/eng/prod/dataprod/Documents/24-09-16%20Implementation%20of%20Severe%20Weather%20Trading%20Starting%20from%2023%20September%202024.pdf)。

## 数据源建议

| 数据 | 原型/内部验证 | 正式产品建议 | 备注 |
| --- | --- | --- | --- |
| 搜索与基础行情 | 腾讯搜索、BMP 快照、分时及 `hk` K 线接口 | 向腾讯采购 BMP Third Party Service，或采用其他有明确授权的港交所持牌供应商 | 腾讯自身获准提供实时 BMP，但直接调用其网页接口不等于取得第三方再分发权 |
| 证券主数据 | 港交所公开证券清单 | 港交所 Securities Master File 或供应商参考数据 | 正式主数据应覆盖证券类型、币种、每手股数、上市/退市、柜台映射 |
| 历史收盘数据 | 原型阶段由行情供应商提供 | 港交所 Data Marketplace 或有授权供应商 | 港交所提供可程序化下载的历史产品，但不少产品按月收费 |
| 公告原文 | 港交所披露易链接 | Issuer Information feed 或持牌聚合商 | 网页搜索不是稳定的结构化 API；不要依赖页面抓取作为长期生产接口 |
| 标准化财务 | 暂缓，或只展示供应商可核验字段 | 有港股覆盖的基本面供应商 | 需要处理 HKFRS/IFRS、银行/保险特殊报表、半年报及币种差异 |
| 新闻 | 现有腾讯新闻链路做兼容性验证 | 有新闻授权和港股代码映射的供应商 | 新闻版权与行情授权是两件事，需分别确认 |
| 南向/沽空/市场统计 | 暂缓 | 港交所数据产品或持牌供应商 | 先定义更新频率和展示口径，再开发界面 |

港交所的[行情再分发要求](https://www.hkex.com.hk/Services/Market-Data-Services/Real-Time-Data-Services/Data-Licensing/HKEX-IS/Market-Data-Vendor-Licence/Delayed-Data-and_or-IIS/Requirements/Business-Requirements-for-Information-Vendors?sc_lang=en)明确要求延时数据至少延迟 15 分钟，并显著显示延时标识或时间戳。港交所公布的[市场数据供应商收费](https://www.hkex.com.hk/Services/Rules-and-Forms-and-Fees/Fees/Securities-%28Hong-Kong%29/Market-Data/Market-Data-Vendors?sc_lang=zh-HK)显示，延时数据再分发许可也有费用。港交所[历史数据产品](https://sc.hkex.com.hk/TuniS/www.hkex.com.hk/eng/ods/historicalData.aspx)包括收盘价数据和证券主档，并提供订阅后的程序化下载。

如选择第三方，当前可核实的一个候选是 [Webull Market Data API](https://developer.webull.hk/apis/docs/market-data-api/overview/)，其文档明确列出港股股票和 ETF、HTTP 历史/快照以及实时推送。是否允许把数据展示给本产品的最终用户，仍需在签约时确认，不能只依据接口文档推断再分发权。

## 对当前代码的影响

当前主页面 `src/components/AShareTD9InteractiveChart.jsx` 约一万行，市场处理采用大量 A 股/美股二选一逻辑。新增第三个市场之前，建议先建立统一适配层：

```text
marketAdapters/
  ashare.js
  us.js
  hk.js

统一接口：
  normalizeCode(input)
  validateCode(code)
  search(query)
  loadKline({ code, period, adjust, limit })
  loadProfile(code)
  loadFinancials(code)
  formatMoney(value, currency)
```

建议把前端状态改成按市场索引的对象，而不是继续增加三元表达式：

```js
marketCodes = { ashare: "", hk: "", us: "" }
favorites = { ashare: [], hk: [], us: [] }
watchlists = { ashare: [], hk: [], us: [] }
```

后端需要至少新增：

- `GET /api/hk-search?q=`
- `GET /api/hk-kline?code=&period=&adjust=&limit=`
- `GET /api/hk-profile?code=`（P1）
- `GET /api/hk-finance?code=`（P1）

现有通用接口也要扩展：

- `favoritesHandlers.js` 的市场白名单、代码校验和名称补全增加 `hk`。
- `redisHandlers.js` 的推荐市场映射预留 `hk`，但在没有港股因子数据前不显示“推荐”。
- Agent 上下文和工具增加港股代码；避免把港股请求落到美股分支。
- 行情返回统一增加 `currency`、`quoteTime`、`delayMinutes`、`source`、`marketStatus`、`boardLot`、`securityType`。
- 当前腾讯快照字段注释和市值单位按 A 股写死，港股适配器必须独立解析并保留 HKD/RMB/USD。

推荐的内部标识：

```json
{
  "instrumentId": "HK:00700:HKD",
  "market": "hk",
  "code": "00700",
  "sourceSymbol": "hk00700",
  "name": "腾讯控股",
  "currency": "HKD",
  "securityType": "equity",
  "boardLot": 100,
  "quoteTime": "2026-09-18T16:08:32+08:00",
  "delayMinutes": 15
}
```

`boardLot` 和 `delayMinutes` 只是字段示例，必须来自正式数据源，不能把示例值当成全市场默认值。

## 验收标准

P0 上线前至少覆盖以下场景：

1. `700`、`00700`、`hk00700`、`0700.HK` 都能定位到 `00700`，保存和显示后仍保留前导零。
2. 普通 HKD 股票、`-W/-SW/-B/-S` 股票、RMB 柜台、停牌股、退市代码和无数据代码有明确结果。
3. 日/周/月线及不复权/前复权/后复权切换后，价格和公司行动日期可抽样对照供应商原始数据。
4. 香港午休、收市竞价、随机收市、半日市、假期和恶劣天气交易的市场状态正确。
5. 行情卡片始终展示币种与行情时间；延时数据始终显示“延时”，网络失败不会回放成“实时”。
6. A 股、美股原有搜索、自选、收藏、K 线、财报和 Agent 行为没有回归。
7. 自选中 `00700` 与 `80700` 视为两个独立柜台，不因名称相同而去重。

## 粗略工作量

在不接正式商业数据采购、P0 只做个股页的前提下：

- 市场适配层重构与回归：2–3 人日。
- 港股搜索、K 线后端代理和字段归一化：2–3 人日。
- 港股标签、状态、自选/收藏与币种时间展示：2–3 人日。
- 测试、异常场景和部署验证：2 人日。

合计约 8–11 人日。P1 的公司资料、公告与结构化财务约再增加 6–12 人日，实际取决于供应商接口和授权；P2 的推荐、回测、资金流和热力图属于独立数据项目，不建议与 P0 绑定排期。

## 推荐实施顺序

1. 先确定用途是内部工具还是对外产品，并据此确定数据授权路径。
2. 把当前二元市场判断抽成适配层，补 `hk` 市场状态结构。
3. 用后端代理完成港股搜索和 K 线，不让浏览器直接依赖第三方 JSONP。
4. 完成 P0 页面、自选和数据时间/币种标识，并做 A 股、美股回归。
5. 选定正式数据源后替换原型适配器，再进入 P1/P2。
