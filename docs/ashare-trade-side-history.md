# A 股内外盘历史

原「资金动向」已改为实际历史成交统计。此前只存腾讯即时内外盘，历史从采集当天开始，不能满足查看过去日期的要求。当前实现通过通达信历史分笔接口回填过去交易日，腾讯即时报价独立展示。

## 数据来源与统计口径

- 历史图表和表格：通达信 L1 历史分笔成交，按接口原始方向字段统计。0 为买入量（外盘），1 为卖出量（内盘），2 及其他方向单列中性/未判定量。不是交易所 Level-2 逐笔，也不按价格变化估算方向。
- 顶部当前数据与个股侧栏：腾讯即时行情原始内外盘字段，保留真实报价时间。
- 两个源的方向判定不同，不能将通达信历史伪装成腾讯历史，不能混合两种来源做累计统计。
- 单位为手，1 手 = 100 股。内外盘不能推算主力/散户身份、人数或真实资金净流入金额。

历史公式：`netVol = outerVol - innerVol`；`netRatio = netVol / (innerVol + outerVol) × 100`；`outerRatio = outerVol / (innerVol + outerVol) × 100`。分母只含已明确归类的买卖两盘，未判定量不强行归类。近 5 日累计占比由累积两盘成交量计算，不取每日占比的简单平均。

`totalVol` 保留全部分笔量；`regularVol` 为不晚于 15:00 的分笔量；`afterHoursVol` 依记录时间单列 15:00 之后的数量。方向 5 的含义未获得本协议的官方定义，不据此猜测方向，其数量计入未判定量。

页面可切换最近 30 / 60 / 120 个已保存历史交易日，并显示每日日量和差额占比。加载期间明确显示进度；失败日期保持缺失，并显示错误，不补零，不拿今天的腾讯数字填历史。

## 真实历史完整性校验

**当前没有接入交易所原始历史逐笔。** `validated: true` 仅表示下面的分页、常规成交总量和收盘价检查通过，不表示买卖方向已被交易所数据验证。API 顶层及每行 `quality.verification` 显式返回：

```js
{
  directionSource: 'tdx',
  exchangeDirectionVerified: false,
  rawRecordsRetained: false,
  comparisonSource: 'tencent-unadjusted-daily',
  validationScope: ['pagination', 'regular-volume', 'regular-close']
}
```

通达信原始响应目前只在抓取过程中使用，没有长期留存。即使成交总量与收盘价相同，交换买卖方向仍可能通过这些检查，因此不能据此保证内外盘方向准确。旧归档读取同样复核收盘价证据，并按实际来源重建核验状态，不能由旧 `validated` 或归档内的声明升级为交易所核验。

`server/tdxTradeSideHistory.js` 使用 Node 原生 TCP 独立实现历史分笔协议。协议格式参考 [rainx/pytdx 原作者历史分笔实现](https://github.com/rainx/pytdx/blob/master/pytdx/parser/get_history_transaction_data.py)；原仓库未声明标准许可证，不标注为 MIT，也没有引入其 Python 包或复制实现。

日期、未复权收盘价和日成交总量取腾讯未复权日线：`fqkline/get?param=<symbol>,day,,,<limit>,`，第六个参数为空仍需保留末尾逗号。该接口的 `qt` 当前报价不用于回填任何历史日。

每个历史交易日必须：

1. 来自真实日线日期，成交量非零；上海时间当天 15:10 前排除当日，查询开始时固定截止日。
2. 分页读取每页最多 2000 条，按实际返回条数增加偏移，直至明确空页；页重复、截断、乱序、数量溢出、网络错误均不能算完整。
3. 解压及原始字段长度合法，数量可由安全整数精确表示。
4. 全天 `regularVol` 与该日原始日线手数严格相等，最后常规成交价与未复权收盘价相等。
5. 保存成功后才能进入 API 的历史 `rows`。

目前实际历史客户端支持沪深 A 股。北交所仍可展示腾讯当前内外盘，但尚未实现其历史分笔协议。服务器历史保留范围没有固定天数保证，30/60/120 日以实际成功回填与保存的日期为准。

## 接口与后台任务

`GET /api/ashare-trade-side-history?code=603818&limit=120` 沿用原登录鉴权，limit 为 1 至 120 的整数。返回：

```js
{
  code,
  name,
  source: { key: 'tdx', name: '通达信历史分笔统计' },
  unit: '手',
  rows: [{
    code, date, source: 'tdx', complete: true, validated: true,
    innerVol, outerVol, neutralVol, unknownVol, totalVol,
    regularVol, afterHoursVol, netVol, netRatio, outerRatio,
    tradeCount, quality, collectedAt, quoteTime: null
  }],
  latest: /* 独立的已保存腾讯最新快照，无法取得时为 null */,
  realtimeSource: { key: 'tencent', name: '腾讯即时行情' },
  history: { status, done, total, processed, missingDates, firstDate, error, errors },
  collection: { persisted, tracking, days, firstDate, lastCollectedAt, notice },
  warning
}
```

`rows` 只含通达信完整历史，按日期升序。历史 daily 记录没有实时 `quoteTime`，不伪造 15:00 的报价时间。最新腾讯报价只放 `latest`，不会混成一个历史日。腾讯失败也不阻断已保存历史展示。

历史请求启动异步任务，首响应快速返回已有存档和 `history.status='loading'`。前端加载期间每 3 秒刷新，完成后恢复 60 秒刷新。同一股票共用任务，最多同时补两只股票；每只最多 3 条串行 TCP 连接。单请求 5 秒超时，整批 180 秒超时。失败有 5 分钟重试间隔，已核验保存的日期不重抓。

服务启动恢复已登记股票。上海时间工作日 15:10–16:30 检查历史补日，只保存符合收盘截止日的记录。另保留腾讯当前快照每 60 秒采集机制。构建不会启动采集；开发、preview、生产启动入口均接入，关闭时停止任务并中止连接。

## 存储

两个来源使用独立无短期 TTL 的 Redis key：

- `ashare-trade-side:v1:tracked`、`ashare-trade-side:v1:daily:<symbol>`：腾讯实时采集；同日原子比较真实报价时间，旧响应不能覆盖新响应。
- `ashare-trade-side-history:tdx:v1:limits`：历史补齐范围，Lua 原子记录最大请求条数，避免小范围请求覆盖大范围。
- `ashare-trade-side-history:tdx:v1:daily:<symbol>`：已完整校验的历史每日统计，HSETNX 保留成功保存的记录。

未新增或改动 MySQL 表、账户、旧推荐及市场快照数据。存档长期可靠性依赖 Redis AOF/RDB、保留磁盘和备份。当前只读检查确认 `appendonly=yes`、RDB 已配置、`maxmemory=0`、`maxmemory-policy=noeviction`；未做磁盘丢失或备份恢复演练。

## 按交易所方向接入：尚待取得数据

用户已选择交易所方向作为目标标准，目前没有历史逐笔数据接口或导出权限。当前通达信统计保留为参考，不能冒充该目标标准。

[上证信息历史行情产品](https://www.sseinfo.com/services/assortment/historical/)提供 Level-2 逐笔历史及业务申请入口。已检查 [CIIS 官方免费样本](https://www.ciis.com.hk/hongkong/en/historicaldata1/sampledata/index.shtml)：新版 StockTick 样本只有 2024-07-04 09:33:05.00 至 09:33:05.30 的 1001 条记录，其中成交 369 笔，603818 为 0 条。它只能用于格式验证，不能回填目标股票的全天或 120 日历史。没有找到目标范围可匿名免费取得的官方入口；这不代表所有供应方均无免费试用。

取得数据时应要求以下范围，而不是只购买实时 Level-2 行情：

> 需要上海证券交易所股票 603818，自 2026-04-16 起的完整历史逐笔成交，保留交易所原始主动买卖标志，持续补充后续交易日。请确认是否提供 StockTick.csv 或字段等价的无损数据、目标日期是否完整、个人本地自用能否申请，以及具体报价和使用许可。若产品将用于公网展示，请另行明确展示许可。请提供一日完整原始数据用于接入验收。

后续接入必须按 [官方历史接口说明 1.1.5（2026-03-27）](https://www.sseinfo.com/services/assortment/market/hqywwd/wdzsjk/c/10824356/files/4ddcd5a592f9429f9288b0d2cb0c9549.pdf)读取 `StockTick.csv`：只统计 `Type=T` 的成交，`TickBSFlag` 中 B 为主动买入（外盘）、S 为主动卖出（内盘）、N 为未知；`Qty` 单位是股。订单新增和删除不能算成交，未知方向不能估算归类。序号按通道跨证券排列，过滤单只股票后不能要求序号连续。

验收还需要保留原始文件、文件哈希、供应方、格式版本和逐笔标志，核对完整交付范围及逐笔汇总与同口径日行情。当前尚未实现这一官方数据导入流程，也没有取得目标股票的官方原始文件。没有购买、注册或联系供应方；官方来源同样不构成绝对无误的保证。

## 实际验证结果

已为曲美家居 `603818` 实际抓取并保存 **120 个交易日**，范围 **2026-04-16 至 2026-10-14**。120/120 日通过全日分页、常规成交总量及收盘价核验，`missingDates=[]`。保存的是真实来源数据，未使用人工历史样本或估算。

示例：2026-10-13 通达信统计内盘 168484 手、外盘 135184 手、中性量 10525 手、总量 314193 手；腾讯同日内盘 163292 手、外盘 150901 手。总成交量一致而方向划分不同，页面明确标明来源，不覆盖腾讯侧栏。

通过真实配置的 Redis 执行历史保存和最大范围 Lua，另用新服务读取存档恢复历史；这与之前仅使用 Redis 替身的测试不同。没有做 Redis 服务重启恢复演练，也未部署线上代码。

完整测试 **551 项通过、1 项原有真实 Redis 测试跳过**；构建、ESLint 通过。新增协议测试覆盖日期编码、分页 EOF/重复页、分片和压缩 TCP、方向字段、成交总量/收盘价验证及收盘时间冻结。存储测试覆盖来源隔离、异步任务、范围扩大、保存拒绝和失败日期不补零。另验证成交量/收盘价相同而方向相反的两份记录均不能升级为交易所核验、旧归档声明不能升级核验范围、缺失/不一致的收盘价证据被拒绝。

通过只读获取真实 Redis 存档，再交给新归档代码复核，120/120 日仍通过收盘价和总量一致性检查；全部明确标记交易所方向未核验。本次没有修改这 120 日的成交方向或数量。

页面验证使用独立本地测试身份和实际已保存的历史数据（不更改正式鉴权），实际打包组件已验证 30 / 60 / 120 日切换分别显示 30 / 60 / 120 条，历史来源与腾讯当前快照独立显示。未把该测试页描述为用户登录会话或线上页面。
