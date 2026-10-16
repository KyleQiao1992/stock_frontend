# A 股内外盘历史

## 当前实现

历史列表改为直接读取通达信官网已经发布的每日盘后文件，不依赖 Redis 存了几天，也不把腾讯当前报价或已有两日采集记录替代成历史。当前快照直接查询腾讯，两个来源分别展示，不混合累计。

- 历史文件入口：[通达信每日数据](https://www.tdx.com.cn/article/daydata.html)。文件格式为 `https://www.tdx.com.cn/products/data/data/g4day/YYYYMMDD.zip`。
- `server/tdxDailyTradeSide.js` 独立解析 ZIP 内配对的 `.cod`、`.md1`，校验全部条目 CRC32、长度、日期、证券身份及偏移。
- `server/directTradeSideHistory.js` 根据腾讯未复权日线中的实际交易日期查询历史包。查询开始时冻结北京时间收盘截止日，15:10 前排除当天。
- `server/ashareTradeSideHistory.js` 默认历史服务和即时服务都不调用 Redis；此面板不再启动 Redis 采集或历史补日任务。旧 Redis 实现仍保留在源码供兼容测试，但不再是当前页面的数据来源。
- 官方原 ZIP 缓存在项目 `.cache/trade-side-history`，可用 `TRADE_SIDE_FILE_CACHE_DIR` 指定其他目录。删除缓存会重新下载官方历史文件，历史范围不会退回采集开始日期。缓存无 TTL；新日期按需下载，损坏缓存校验后重新下载。不修改现有 Redis 数据和 MySQL 表。

首页历史请求立即返回任务状态。每只股票最多并行处理四个历史日，文件加载器总下载并发限制为四，同日请求共用下载。前端在加载时每三秒查询进度；完成后每六十秒刷新。失败日期和具体原因保留在 API，页面显示简短错误和实际记录数，不补零、不复制快照填补。

## 字段及准确性边界

官网盘后包保留整数股数，可以解决旧 TCP 历史分笔仅提供整数手、688610 丢失零股的问题。它仍是**通达信累计内外盘口径**，不能称为已核验的交易所原始 B/S/N 方向。

`.cod` 每条 150 字节，证券代码在 `[0:6]`，序号为 `[32:34]` 小端 uint16。配对 `.md1` 每块 512 字节，位置为序号乘 512。主要字段：

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| 36 | float64 | 收盘价 |
| 44 | uint32 | 行情时间 HHMMSS |
| 56 | uint64 | 总成交股数 |
| 80 | uint64 | 通达信内盘累计股数 |
| 88 | uint64 | 通达信外盘累计股数 |

OHLC、总股数及代码映射布局参考原作者 [jing2uo/tdx2db 的原生解析](https://github.com/jing2uo/tdx2db/blob/master/tdx/merge.go)，本项目没有运行其软件或引入其二进制。

**80/88 字段没有找到通达信官方字段字典。** 顺序依据实际交叉验证：603818 在 2026-10-13、10-14 两日的四个字段，分别精确对应通达信分笔内/外盘加一半中性量；另与 MAC 行情协议显式标为内/外盘的字段对照了 688610、603818、600519。此验证说明供应商分类包含中性量处理，不证明每笔成交方向，也不证明与交易所原始标志一致。

实际 2026-10-13 数据：

- 603818：内盘 17,374,650 股 = 历史分笔内盘 16,848,400 + 中性 1,052,500 / 2；外盘 14,044,650 = 13,518,400 + 1,052,500 / 2。
- 688610：总量 1,301,251 股，内盘 658,905 股，外盘 641,759 股，另有 587 股未计入两字段。

实际 2026-10-14 数据：

| 股票 | 总量（股） | 内盘（股） | 外盘（股） | 未计入量（股） |
| --- | ---: | ---: | ---: | ---: |
| 688610 | 1,763,046 | 986,721 | 775,699 | 626 |
| 603818 | 26,818,300 | 14,360,100 | 12,458,200 | 0 |
| 600519 | 2,377,273 | 945,643 | 1,431,610 | 20 |

未计入量按 `totalShares - innerShares - outerShares` 原样保留，不摊派、不推断为已知中性量。API 的 `sourceVolumes` 保留原始安全整数股数；展示为手时除以 100，保留零股小数。

每行保留官方文件 URL、整个 ZIP 和证券块 SHA256、原始字段偏移、行情时间和校验范围。`exchangeDirectionVerified: false`；`rawRecordsRetained: false`，因为文件不是交易所逐笔记录；`rawSnapshotRetained: true` 对应保留官方原始盘后 ZIP。

科创板腾讯日线单位为股：总股数必须完全相同才展示（`comparisonPrecision: 'share'`）。其他沪深 A 股腾讯日线单位为整数手：与盘后股数四舍五入为手比较（`comparisonPrecision: 'rounded-lot'`），不声称校验了腾讯无法表达的股余数。所有收盘价均按分核对，历史数量关系和股数安全整数也必须通过检查。

顶部腾讯快照和左侧当前内外盘仍使用腾讯原始字段，并保留真实报价时间。688/689 的腾讯量字段除以 100 转成手，避免之前放大 100 倍的单位错误。

## 时间范围与统计

选项为「近一周、近2周、近3周、近一月、近2月」，默认近一周。以北京时间当前自然日期为终点：周包含当天的 7/14/21 个自然日；月按日历月回溯，月底夹紧，起点为回溯边界后一天。按真实日期筛选，不按条数、不把最后一个旧数据日当成今天、不补休市日。

前端请求最近 60 个实际交易日，覆盖最长的近两个月。列表、柱图和期间累计使用同一批日期；只有已收盘记录进入累计。

- 差额：`外盘 - 内盘`。
- 差额占比：`(外盘 - 内盘) / (外盘 + 内盘) * 100`。
- 外盘占比：`外盘 / (外盘 + 内盘) * 100`。
- 累计占比用期间两盘总量计算，不平均每日比例，不固定取最后五行。

内外盘不能推算主力/散户身份、人数或真实资金净流入金额。

## 接口

`GET /api/ashare-trade-side-history?code=688610&limit=60` 沿用原登录鉴权，limit 为 1–120 整数。

```js
{
  code,
  source: { key: 'tdx-daily', name: '通达信盘后历史' },
  unit: '手',
  rows: [{ code, date, source: 'tdx-daily', sourceUrl,
    innerVol, outerVol, totalVol, unclassifiedVol,
    sourceVolumes: { totalShares, innerShares, outerShares, unclassifiedShares },
    netVol, netRatio, outerRatio, complete: true,
    quoteTime: null, collectedAt, quality }],
  latest: /* 独立查询的腾讯当前快照，获取失败为 null */,
  realtimeSource: { key: 'tencent', name: '腾讯即时行情' },
  history: { status, done, total, processed, targetDates, missingDates, errors },
  collection: { persisted: false, tracking: false,
    storage: 'official-daily-file-cache', days },
  verification: { exchangeDirectionVerified: false, /* 其他实际校验范围 */ }
}
```

`persisted: false` 表示没有写入旧 Redis 历史归档，不表示官方 ZIP 没有文件缓存。`snapshotHistory` 为兼容已有注入调用保留；默认服务不产生采集历史行，页面也不再自动切换到采集记录。

## 实际验证

已直接取得并核验 **688610 的 60 个实际交易日，2026-07-15 至 2026-10-14**；60/60 日的官方文件 CRC、总股数和收盘价检查通过，`missingDates=[]`。这一结果来自官网真实旧日文件，未读取 Redis 归档、未生成模拟历史行。

以北京时间 2026-10-15 统计，五个范围的实际记录数依次为 4、5、8、15、37；累计差额依次为 -5,083.32、-6,231.68、-9,442.52、-6,909、-20,427.97 手。未收盘的 10 月 15 日没有生成记录，国庆休市也未补零。

页面验收使用独立本地测试身份，调用与应用相同的实时历史 handler（直接读官方文件），没有用两日存档或模拟历史替换接口。五档列表行数、柱图数量、累计差额和占比均已核对。用户本地 `127.0.0.1:5173` 页面 HTTP 200；未登录的历史请求为 401，正式鉴权没有修改。没有声称已验证用户当前登录会话。

完整测试 595 项通过、1 项原有真实 Redis 集成测试跳过；随后整数股累计修正的相关 54 项测试通过。构建、ESLint 和差异格式检查通过。未构建 Docker 镜像，未部署线上。

## 尚未达到的目标

用户此前选择「交易所方向为准」。当前官网盘后数据解决真实历史获取、零股精度和 Redis 依赖问题，**没有达到交易所原始方向验证目标**，不能把总量或收盘价相符当作该目标已经实现。

[上证信息历史产品](https://www.sseinfo.com/services/assortment/historical/)提供历史数据申请。按 [官方历史接口说明](https://www.sseinfo.com/services/assortment/market/hqywwd/wdzsjk/c/10824356/files/4ddcd5a592f9429f9288b0d2cb0c9549.pdf)，取得完整 StockTick.csv 后应只统计 Type=T，保留 TickBSFlag 的 B/S/N 与 Qty 原始股数，以及原文件、哈希、格式和完整交付范围。当前没有取得目标股票完整交易所原始历史文件，没有购买、注册或联系供应方。

以上是本地实现和本地验证；没有部署或验证线上服务器。
