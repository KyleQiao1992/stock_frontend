# 第三方缠论引擎

主图默认的“笔构造参考中枢”使用本项目的笔、特征序列线段和笔参考中枢规则。[Chan Structure Workstation](https://github.com/JustinGongjj/chan-structure-workstation) 的源码作为对照保留，固定于提交 `274f7a2d730bf961aa93d1d33b4359a455c542cd`；上游计算引擎保存在 `src/lib/chan/external/upstream.js`，仅将 CommonJS 导出改为 ESM 并增加来源说明。MIT 授权及版权见 `src/lib/chan/external/LICENSE`，构建后的许可证见 `public/licenses/chan-structure-workstation.txt`。

`src/lib/chan/external/index.js` 通过本项目主路径计算笔、线段和基于已完成笔的参考中枢。此前直接使用上游中枢函数会在一笔终点出框后过早结束参考框，且超过500次扫描时静默截断；现改为本项目参考中枢状态机，判断整个笔范围、离开与回试，记录确认依据及不确定性。这是工程参考，不是原仓库原样结果，也不是递归走势中枢。原项目线段在海欣样本中存在相邻段首尾不相接，部分笔的端点也不满足本项目的区间极值约定，因此不再用于画图；也不把基于那些笔段的上游走势、背驰和买卖点误当成本图结果。

上游完整批处理会过滤非正收盘价；本图不调用该批处理。有效的前复权负价历史不会被过滤，异常 K 线仍会使结构计算明确停止。图表使用已加载的全部历史。未经独立验证不能声称严格符合原典。

用户可以选择“本项目线段中枢”切回原算法；该模式同时提供单独可控的“笔构造参考”图层，参考区不会进入线段中枢或交易研判。

对照基准 `src/lib/chan/fixtures/600851-external-upstream-274f7a2.json` 来自将海欣股份 641 根前复权日线交给固定版本上游代码的结果，仅用于确认保留的上游源码未变，并非本图输出的预期。`src/lib/chan/externalCenterLifecycle.test.js` 覆盖真实行情的确认时序、贯穿核心、离开回试以及超过500次扫描；`tests/e2e/tencent-functional.spec.mjs` 从完整 App 检查真实图框、线段几何和引擎切换。
