# FSL 定义、修正及参考数值对照

核对日期：2026-10-24。**旧实现不符合查到的公开公式，现已删除自行归一化的 DMA 权重及股本估算，并与 HQChart 公开实现的参考数值对齐。** 这项结论限于下列公式、初始化及有效数值输入，不代表已与通达信或 moomoo 客户端逐值核对。

## 定义及可执行参考

- [米筐 RQData 官方股票技术指标文档](https://www.ricequant.com/doc/rqdata/python/stock-mod)：FSL 的 SWL、SWS 及 CAPITAL 定义。
- [HQChart 的指标定义](https://github.com/jones2000/HQChart/blob/master/webhqchart/umychart.index.data.js)：FSL 脚本。
- [HQChart 的公式解释器](https://github.com/jones2000/HQChart/blob/master/webhqchart/umychart.complier.js)：EMA、SUM、MAX、DMA 的实际执行行为。
- [通达信官方函数文档](https://help.tdx.com.cn/gspt/docs/markdown/redword/functionlist.html)：DMA 的递推式和分数权重说明。该文字说明本身不能证明其客户端如何处理 A≥1；本次没有实测客户端。

公开表达式为：

```text
SWL = (7 * EMA(CLOSE,5) + 3 * EMA(CLOSE,10)) / 10
A = MAX(1, 100 * SUM(VOL,5) / (3 * CAPITAL))
SWS = DMA(EMA(CLOSE,12), A)
```

HQChart 的 DMA 对 A<1 执行 `Y=A*X+(1-A)*上一周期Y`，对 A≥1 直接取 X。因此，在这份 FSL 脚本和该解释器的组合下，A 始终≥1，**SWS 等价于 EMA(CLOSE,12)**。这不是把 MAX 擅自改成 MIN，也不需要将成交量或换手率归一化。当前源码中的 SUM 使用最初不足五根的已有数据；EMA 从第一根收盘价开始输出。

本次通过 GitHub 读取的文件版本记录为 Git blob SHA（不是提交 SHA）：

| 文件 | Git blob SHA |
| --- | --- |
| `webhqchart/umychart.complier.js` | `5edc8e4582a891e00ce3c97ffa43e667da31d1a0` |
| `webhqchart/umychart.index.data.js` | `4afa070988f6c407f9362b0d6fcce86f1268ea9e` |

## 已修正的差异

| 项目 | 旧实现 | 当前实现 |
| --- | --- | --- |
| SWL | EMA5、EMA10 按 7:3 加权 | 保留，并与独立参考逐值比较 |
| SWS | 权重改为 `MIN(1,MAX(0.01,SUM(VOL,5)/(3*CAPITAL)))` | 采用已验证的 MAX / DMA 边界，等价为 EMA12 |
| 初始化 | 前四根没有 SWS | 首根即输出，EMA 以首根收盘价初始化 |
| 股本数据 | 从换手率或当前报价估算历史股本 | 删除这项依赖；缺少换手率仍可计算 |
| 历史稳定性 | 当前报价估算可能改变过去的值 | 仅使用截至对应 K 线的收盘价；追加后续行情不改变既有前缀 |
| 页面 | 可能显示 SWS 估算，MACD 开关落在 FSL 边上 | 无适配版/估算标识；两副图使用共同样式和独立开关 |

例如首五根价格均为 10、第六根为 16，参考第六根 SWS 为 `10.923076923076923`，旧实现为 `10.00923076923077`。旧权重会改变慢线和交叉日期，属于数值错误，不是显示差异。

实现位于 `src/lib/fsl.js`，图表接入位于 `src/components/AShareTD9InteractiveChart.jsx`。缺少有效收盘价时断开并重置 EMA；这是项目的数据缺口处理策略，不包含在上游有效数据数值对照的结论内。

## 独立对照及验收结果

从上述 HQChart 源码提取原有 EMA、SUM、MAX、DMA 函数，在独立上下文中执行原 FSL 表达式生成固定参考输出。生成过程没有调用项目的 `calcFslSeries`；版本及参考数据保存在 `src/lib/fixtures/fsl-hqchart-reference.json`。

三组输入包含平价后突变、反复上落，以及零量/大成交量和股本变化，共 80 根 K 线、160 个 SWL/SWS 数值。新增对照在旧实现上实际得到 **10 项中 6 项失败**，修正后 **10 项全部通过**。参考数值最大绝对误差为 `5.684341886080802e-14`，测试容差为 `1e-10`。另覆盖追加未来 K 线、缺失数据、未完成 K 线及可见窗口第一根交叉的行为。

交叉标记属于项目显示规则：SWL 从不高于 SWS 变为高于时显示金叉，反向显示死叉；不跨缺失值或明确未完成的 K 线确认信号。原 FSL 脚本只定义两条线，本次未声称项目的相等触碰规则与各行情软件的 CROSS 函数完全一致。

完整 App 新增逐根悬浮读取这 80 根参考数值的用例，并验证两副图的开关互不影响。`npm run test:e2e -- --list` 共登记 75 项；实际完整执行因测试服务监听 `127.0.0.1:5198` 返回 `EPERM` 而在启动阶段失败，**75 项均未执行**，不能用计算测试替代页面验收。真实本地页面的目视核对、全量 Node 测试及真实服务/线上范围，另见 `docs/browser-acceptance.md` 的最新记录。
