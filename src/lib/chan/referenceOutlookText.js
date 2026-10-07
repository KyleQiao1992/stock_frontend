// Display templates transcribed from the reference API captures; prices and dates are supplied by the live structure.
export const scenarioText = {
  "sell": [
    {
      "id": "A",
      "name": "弱势下行",
      "score_max": 10,
      "bias": "偏空",
      "explain": "末笔转弱、反抽不过前高则空头延续；对应二卖/三卖跟随，偏向减仓或做空。 关键位锚定：{range}。",
      "condition": "向下笔延续，反抽不过前高（关注中枢下沿 {zd}，下沿K：{zdBar}）",
      "path": "顶分确认 → 向下笔离开震荡区 → 反抽受压",
      "next_points": [
        {
          "kind": "S2",
          "title": "二类卖点",
          "trigger": "反弹高点不高于前高（{high}，前高K：{highBar}）",
          "action": "反抽结束后可减仓/做空观察",
          "hypothetical": true
        },
        {
          "kind": "S3",
          "title": "三类卖点",
          "trigger": "跌破中枢后反抽不升破下沿（{zd}，下沿K：{zdBar}）；中枢区间见 {range}",
          "action": "三卖确认后趋势跟随，站回则退出",
          "hypothetical": true
        }
      ],
      "invalid": "收盘升破前高（{high}，前高K：{highBar}），弱势情景失效"
    },
    {
      "id": "B",
      "name": "中枢震荡",
      "score_max": 10,
      "bias": "中性",
      "explain": "价格在中枢内来回，上沿偏空、下沿偏多，倾向高抛低吸、控制仓位。 震荡箱体：{range}。",
      "condition": "价格围绕中枢上下沿来回（下沿 {zd}，下沿K：{zdBar} ~ 上沿 {zg}，上沿K：{zgBar}）",
      "path": "不形成明确离开段 → 中枢扩展/新生 → 等待方向选择",
      "next_points": [
        {
          "kind": "S2",
          "title": "二类卖点（中枢上沿）",
          "trigger": "反弹至中枢上沿受压，且不破前高（上沿 {zg}，上沿K：{zgBar}；前高 {high}，前高K：{highBar}）",
          "action": "中枢上沿减仓，避免中枢内追空",
          "hypothetical": true
        },
        {
          "kind": "B2",
          "title": "二类买点（中枢下沿）",
          "trigger": "回落至中枢下沿止跌，且不破前低（下沿 {zd}，下沿K：{zdBar}；前低 {low}，前低K：{lowBar}）",
          "action": "仅下沿短线博弈，仓位宜轻",
          "hypothetical": true
        }
      ],
      "invalid": "放量单边离开中枢并收盘站稳外侧，震荡情景让位于趋势情景"
    },
    {
      "id": "C",
      "name": "转强反包",
      "score_max": 10,
      "bias": "偏多",
      "explain": "卖点失效、升破关键高/中枢上沿，结构转向回补；先止损空单，再等新一卖。",
      "condition": "升破关键高点（{high}，前高K：{highBar}） 或中枢上沿（{zg}，上沿K：{zgBar}）",
      "path": "卖点失效 → 向上笔加速 → 寻找更高位置的新一卖",
      "next_points": [
        {
          "kind": "B1",
          "title": "一类买点（防守回补）",
          "trigger": "向下回踩无力且再破前高，视为结构转强（前高 {high}，前高K：{highBar}）",
          "action": "空单止损/回补，不在上升中继追空",
          "hypothetical": true
        },
        {
          "kind": "S1",
          "title": "新的一类卖点",
          "trigger": "更高位置出现顶背驰/向上笔结束（需新的确认K，非当前信号K）",
          "action": "原卖点作废，重置为一卖观察",
          "hypothetical": true
        }
      ],
      "invalid": "快速回落并失守 {close}，反包情景解除"
    }
  ],
  "buy": [
    {
      "id": "A",
      "name": "强势上行",
      "score_max": 10,
      "bias": "偏多",
      "explain": "末笔转强、站稳关键位则多头延续；对应二买/三买跟随，偏向做多。 关键位锚定：{range}。",
      "condition": "向上笔延续，收盘站稳前高附近（关注中枢上沿 {zg}，上沿K：{zgBar}）",
      "path": "底分确认 → 向上笔离开震荡区 → 回踩不破关键位",
      "next_points": [
        {
          "kind": "B2",
          "title": "二类买点",
          "trigger": "回调低点不低于前低（{low}，前低K：{lowBar}）",
          "action": "回踩结束转强时可做多/加仓观察",
          "hypothetical": true
        },
        {
          "kind": "B3",
          "title": "三类买点",
          "trigger": "突破中枢后回踩不跌破上沿（{zg}，上沿K：{zgBar}）；中枢区间见 {range}",
          "action": "三买确认后趋势跟随，跌破则退出",
          "hypothetical": true
        }
      ],
      "invalid": "收盘跌破前低（{low}，前低K：{lowBar}），强势情景失效"
    },
    {
      "id": "B",
      "name": "中枢震荡",
      "score_max": 10,
      "bias": "中性",
      "explain": "价格在中枢内来回，上沿偏空减仓、下沿偏多轻仓，不宜单边追涨杀跌。 震荡箱体：{range}。",
      "condition": "价格围绕中枢上下沿来回（下沿 {zd}，下沿K：{zdBar} ~ 上沿 {zg}，上沿K：{zgBar}）",
      "path": "不形成明确离开段 → 中枢扩展/新生 → 等待方向选择",
      "next_points": [
        {
          "kind": "B2",
          "title": "二类买点（中枢下沿）",
          "trigger": "回落至中枢下沿附近止跌，且不破前低（下沿 {zd}，下沿K：{zdBar}；前低 {low}，前低K：{lowBar}）",
          "action": "仅中枢下沿短线博弈，仓位宜轻",
          "hypothetical": true
        },
        {
          "kind": "S2",
          "title": "二类卖点（中枢上沿）",
          "trigger": "反弹至中枢上沿受压，且不破前高（上沿 {zg}，上沿K：{zgBar}；前高 {high}，前高K：{highBar}）",
          "action": "中枢上沿减仓/观望，避免中枢内追涨",
          "hypothetical": true
        }
      ],
      "invalid": "放量单边离开中枢并收盘站稳外侧，震荡情景让位于趋势情景"
    },
    {
      "id": "C",
      "name": "转弱破位",
      "score_max": 10,
      "bias": "偏空",
      "explain": "买点失效、跌破关键低/中枢下沿，结构转向防守；先止损观望，勿摊平。",
      "condition": "跌破关键低点（{low}，前低K：{lowBar}） 或中枢下沿（{zd}，下沿K：{zdBar}）",
      "path": "买点失效 → 向下笔加速 → 寻找更低级别/新的一买",
      "next_points": [
        {
          "kind": "S1",
          "title": "一类卖点（防守）",
          "trigger": "向上反抽无力且再破前低，视为结构转弱（前低 {low}，前低K：{lowBar}）",
          "action": "多单止损/空仓等待，不在下跌中继抄底",
          "hypothetical": true
        },
        {
          "kind": "B1",
          "title": "新的一类买点",
          "trigger": "更低位置出现底背驰/向下笔结束（需新的确认K，非当前信号K）",
          "action": "原买点作废，重置为一买观察，勿摊平",
          "hypothetical": true
        }
      ],
      "invalid": "快速收回并站回 {close}上方，破位情景解除"
    }
  ]
};
export const observationText = {
  "S1": "近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 末笔向上后价格在中枢上方，结构偏向冲高后的一卖观察区。 末笔高点K：{highBar}。参考{range}。",
  "S2": "近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 末笔向上后回落进中枢，偏二卖观察：反弹不破前高则可酝酿二卖。 前高参考K：{highBar}。参考{range}。",
  "B1": "近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 末笔向下后价格在中枢下方，结构偏向寻底后的一买观察区；向上笔若确立并背驰结束，关注一买确认。 末笔低点K：{lowBar}。参考{range}。",
  "B2": "近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 末笔向下后进入中枢震荡，偏二买观察：回调不破前低则可酝酿二买。 前低参考K：{lowBar}。参考{range}。",
  "B3": "近期无一二三类信号触发，按最新笔与中枢位置做结构研判。 价格已在中枢上方，若回踩中枢上沿不破，结构偏向三买观察。 上沿参考K：{zgBar}。参考{range}。"
};
