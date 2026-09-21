# 腾讯港股行情接口调研

调研日期：2026-09-20

## 结论

腾讯现有网页行情链路可以提供港股的实时基本报价、市场状态、搜索、当日一分钟分时、五日分时、日/周/月 K 线和新闻。`qt.gtimg.cn` 返回的港股快照包含精确到秒的行情时间，港交所也将 Tencent Holdings Limited 列为 BMP（Basic Market Prices，实时基本报价）服务提供商。

但 `qt.gtimg.cn`、`web.ifzq.gtimg.cn` 和 `smartbox.gtimg.cn` 是腾讯网页使用的未公开接口，没有公开的鉴权、配额、版本、SLA 或通用再分发授权。腾讯拥有 BMP 许可，只能证明腾讯获准在其批准的平台提供实时基本报价，不能证明任意第三方可以抓取并在自己的产品重新发布。

因此建议分成两条路径：

- 内部原型：可以接入网页接口，后端代理、限速、缓存并保留行情时间；接受随时变更、封禁或字段漂移的风险。
- 正式对外产品：向腾讯采购 BMP Third Party Service，明确站点/应用、用户范围、字段、刷新方式和再分发权；或选择其他港交所持牌供应商。腾讯在港交所公布的第三方 BMP 供应商名单中，具备商务接入的可能性。

## 已验证端点

### 1. 实时基本报价

```http
GET https://qt.gtimg.cn/q=hk00700
```

批量请求：

```http
GET https://qt.gtimg.cn/q=hk00700,hk09988,hk03690
```

精简报价：

```http
GET https://qt.gtimg.cn/q=s_hk00700
```

特征：

- 无需登录或 token。
- 响应为 GBK 编码文本，不是 JSON。
- `Access-Control-Allow-Origin: *`。
- `Cache-Control: max-age=0`。
- 无效代码返回 `v_pv_none_match="1";`，HTTP 状态仍为 200。
- 支持一次查询多个代码，但没有公开的批量上限或频率限制，不应依赖未经验证的大批量请求。

2026-09-20（周日）请求 `hk00700` 时，返回的最近行情时间为 `2026/09/18 16:08:32`，与上一交易日收市竞价时段一致。周末重复请求返回相同快照。由于本次调研不在交易时段，尚未实测行情从成交发生到接口出现的端到端延迟。

经过 `hk00700`、`hk09988`、`hk03690`、`hk00005` 和 `hk80700` 对照，当前港股返回中可稳定使用的字段如下：

| 下标 | 字段 | 示例 | 说明 |
| --- | --- | --- | --- |
| 1 | 中文简称 | 腾讯控股 | 原样保留 `-W/-SW/-B/-R` 等标记 |
| 2 | 代码 | 00700 | 五位字符串 |
| 3 | 最新/名义价格 | 419.000 | 非交易时段为最近收盘快照 |
| 4 | 昨收 | 426.000 | 计算涨跌基准 |
| 5 | 今开 | 428.000 |  |
| 6、36 | 累计成交量 | 28796138.0 | 港股样本表现为股数 |
| 30 | 行情时间 | 2026/09/18 16:08:32 | 判断新鲜度必须使用此字段，不能使用 HTTP 响应时间 |
| 31 | 涨跌额 | -7.000 |  |
| 32 | 涨跌幅 | -1.64 | 百分比数值 |
| 33 | 最高 | 430.400 |  |
| 34 | 最低 | 419.000 |  |
| 37 | 累计成交额 | 12180786280.956 | 币种见下标 75 |
| 39 | 市盈率 | 15.31 | 负值、0 或空值均可能出现，展示前需校验 |
| 43 | 振幅 | 2.68 | 百分比数值 |
| 44 | 流通市值 | 38108.4103 | 样本单位为亿计价币种 |
| 45 | 总市值 | 38108.4103 | 样本单位为亿计价币种 |
| 46 | 英文简称 | TENCENT |  |
| 59 | 换手率 | 0.32 | 与成交量/流通股本抽样相符 |
| 60 | 每手股数 | 100 | 不同股票不同，例如汇丰控股返回 400、中国移动返回 500 |
| 63 | 产品类型 | GP | 仍需用证券主数据限制 MVP 只展示股票 |
| 69、70 | 总/流通股本 | 9095085993.00 | 根据美团等样本可区分两者 |
| 75 | 交易币种 | HKD/CNY | `hk80700` 返回 CNY |

不要复用当前 A 股解析器：港股的下标 7–28（A 股盘口区域）在已测样本中全部为 0，换手率也不在当前代码使用的 A 股位置。字段 47–74 中仍有若干未获官方文档确认的估值和区间指标，第一版不应凭第三方博客猜测字段含义。

### 2. 市场状态

```http
GET https://qt.gtimg.cn/q=marketStat
```

返回服务器时间及多个市场状态，例如 `HK_close_未开盘`、`HK_close_已休市`。该接口可作为展示状态的辅助信号，但未找到官方枚举和 SLA；产品仍需用香港交易日历和交易时段做交叉校验。

### 3. 当日一分钟分时

```http
GET https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=hk00700
```

返回 JSON。每个点格式为：

```text
HHmm price cumulativeVolume cumulativeTurnover
```

实测 `hk00700` 最近交易日返回 332 个点，从 `09:30` 到 `16:08`，包含 `11:59` 和 `13:00`，午休期间没有伪造成交。成交量和成交额是当日累计值，绘制分钟柱时要与上一点相减。

这个接口是分钟快照，不是逐笔成交。若页面只需要价格卡片和分时线，已足够；若需要实时成交明细、买卖方向或盘口，必须采购更高等级行情。

### 4. 五日分时

```http
GET https://web.ifzq.gtimg.cn/appstock/app/day/query?code=hk00700
```

返回按交易日分组的一分钟累计数据。适合“五日”分时页，不应当成任意日期历史分钟数据库。

### 5. 日/周/月 K 线

```http
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,day,,,1000,qfq
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,week,,,500,qfq
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,month,,,240,qfq
```

周期支持 `day`、`week`、`month`，复权参数常见为 `qfq`、`hfq`。单条结构为：

```text
[date, open, close, high, low, volume, optionalCorporateAction]
```

注意：

- 本次测试 `qfq` 和 `hfq` 在最近 1000 根腾讯控股日线上数值相同，不能据此宣称港股复权有效。
- 不带复权尾参数的测试请求只返回 `version`，没有 K 线。
- 响应没有稳定的成交额列；现有 VWAP 会退化为典型价近似。
- 当前端点最多测试到 1000 根成功，未发现正式分页和上限文档。
- K 线响应中的 `qt` 可以提供名称和最新基本报价，但解析必须使用港股字段映射。

第一版建议只在界面写“腾讯口径前复权”，并对发生过拆股/合股/特别股息的股票抽样核对；验证前不要同时开放不复权、前复权和后复权三个选项。

### 6. 搜索

```http
GET https://smartbox.gtimg.cn/s3/?q=腾讯&t=all
GET https://smartbox.gtimg.cn/s3/?q=00700&t=all
```

响应是 `v_hint="..."` 文本，条目用 `^` 分隔，字段用 `~` 分隔。搜索结果会混入 A 股、基金、窝轮等产品，必须保留 `market=hk` 且只接受目标证券类型。该端点响应未观察到 CORS 许可，建议只从后端访问。

### 7. 新闻

```http
GET https://proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search?symbol=hk00700&n=20&page=1&type=1
```

现有 A 股新闻代码已经使用同一接口。将代码映射扩展到 `hk` 即可做兼容性验证，但新闻转载和展示授权要与行情许可分别确认。

### 8. 已失效或不应依赖的接口

```http
GET https://stock.gtimg.cn/data/index.php?appn=detail&action=data&c=hk00700&p=0
GET https://stock.gtimg.cn/data/index.php?appn=detail&action=timeline&c=hk00700
```

本次请求均为 HTTP 200 空响应。不要用它们实现逐笔成交。

## “实时”能提供到什么程度

港交所 BMP 是实时基本报价，包含名义/最新成交价、收盘价、当日高低、成交量、成交额及竞价时段 IEP/IEV；不包含最佳买卖价和买卖量。港交所的产品比较表也明确显示 BMP 没有 Best Bid/Ask 和市场深度。

因此，腾讯 BMP 适合当前页面的：

- 当前价、涨跌额、涨跌幅。
- 今开、昨收、最高、最低。
- 累计成交量和成交额。
- 当前日线合成及一分钟分时。
- 行情时间和市场状态。

它不适合直接承诺：

- 买一卖一和五档/十档盘口。
- 逐笔成交和买卖方向。
- 委托队列、经纪席位。
- 毫秒级推送或交易系统级低延迟。
- 稳定的 WebSocket 推送、配额和可用性 SLA。

## 推荐接入设计

浏览器不要直接访问腾讯。后端统一做代理和字段归一化：

```text
GET /api/hk/quote?codes=00700,09988
GET /api/hk/minute?code=00700
GET /api/hk/kline?code=00700&period=day&adjust=qfq&limit=1000
GET /api/hk/search?q=腾讯
```

统一返回：

```json
{
  "market": "hk",
  "code": "00700",
  "name": "腾讯控股",
  "currency": "HKD",
  "price": 419,
  "previousClose": 426,
  "open": 428,
  "high": 430.4,
  "low": 419,
  "volume": 28796138,
  "turnover": 12180786280.956,
  "change": -7,
  "changePct": -1.64,
  "quoteTime": "2026-09-18T16:08:32+08:00",
  "boardLot": 100,
  "source": "tencent-bmp",
  "realtime": true
}
```

`realtime: true` 只有在腾讯或港交所合同明确允许本产品使用实时 BMP 后才能对用户展示。内部原型可以保留 `sourceQuoteTime`，但不要把 HTTP 抓取时间当作行情时间。

建议的技术策略：

- 价格卡片在港股连续交易和竞价时段轮询；轮询间隔先配置为 3–5 秒，并加入全局批量合并和指数退避。腾讯没有公开频率承诺，不能无限提高频率。
- 自选列表使用批量精简报价 `s_hk...`，个股详情使用完整报价。
- 分时按 30–60 秒刷新，一分钟点只在时间或累计量发生变化时追加。
- 日 K 首次加载后缓存，交易时段用实时快照合成当天 bar；收市后再拉一次 K 线校准。
- 所有响应按 `quoteTime` 去重，拒绝时间倒退的数据。
- 第三方请求失败时显示最近成功时间和“行情暂不可用”，不能把缓存标为实时。
- 建立字段契约测试，覆盖 HKD 股票、RMB 柜台、停牌、未上市、退市、低流动性股票和不同每手股数。

## 许可与商务路径

港交所将 Tencent Holdings Limited 列为 BMP 服务商，也列在 BMP Third Party Service / Listed Company Service 供应商名单中。港交所公开名单给出了腾讯的指定联系人，这说明可以从腾讯采购合规的第三方 BMP 服务，但最终可用范围必须以腾讯报价和港交所批准的 Memorandum of Permitted Purpose 为准。

BMP 的范围和限制不是普通网页接口条款：港交所要求服务平台、展示形式及变更经过批准，并限制第三方直接访问或绕过服务页面。直接调用腾讯网页内部端点并转发到自己的产品，不等于取得 BMP Third Party Service。

相关官方资料：

- [港交所 BMP 服务介绍](https://www.hkex.com.hk/Services/Market-Data-Services/Real-Time-Data-Services/Data-Licensing/HKEX-IS/Market-Data-Vendor-Licence/Basic-Market-Prices-%28BMP%29-Service?sc_lang=en)
- [BMP 实时字段与 Level 1/Level 2 对比](https://www.hkex.com.hk/Services/Market-Data-Services/Real-Time-Data-Services/Overview/Real_time-Datafeeds?sc_lang=en)
- [BMP 服务实施指引](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Market-Data-Services/Real-Time-Data-Services/Data-Licensing_/HKEX_IS-Guiding-Note/Guiding-Notes-on-Basic-Market-Prices-Service_eng-v202304.pdf)
- [2026-03-31 BMP 服务商名单（含腾讯）](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Market-Data-Services/Real-Time-Data-Services/Data-Licensing_/HKEX_IS-Lists/2026/20260331-Websites-with-BMP_E.pdf)
- [BMP Third Party Service 说明](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Market-Data-Services/Real-Time-Data-Services/Data-Licensing_/HKEX_IS-Guiding-Note/Guiding-Note-on-Third-Party-Service-%28v202304%29.pdf)

## 尚需在交易时段验证

当前调研发生在周日，以下项目尚未实测，不能写成已确认事实：

1. `qt.gtimg.cn` 相对港交所成交时间的实际延迟分布。
2. 连续轮询时的限流、封禁阈值和 IP/地区差异。
3. 开市前 IEP/IEV、连续交易、午休、收市竞价和 VCM 时字段变化。
4. 停牌、无成交和新股上市首日的零值/空值语义。
5. 腾讯 K 线对港股拆股、合股、供股和特别股息的复权准确性。

建议在下一个港股交易日 09:15–16:10 做一次自动采样：每 3 秒记录腾讯响应时间、字段 30 行情时间、价格和成交量，并与腾讯自选股页面或有权限的券商实时行情对照。只有完成这次采样，才能给出“页面会延迟多少秒”的实测结论。

