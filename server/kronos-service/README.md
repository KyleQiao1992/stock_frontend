# Kronos 推理服务

把 [Kronos](https://github.com/shiyu-coder/Kronos)（金融 K 线基础模型）封装成一个本地 HTTP 服务，
供 Node 后端通过 `/api/kline-forecast` 调用做未来 K 线预测。

```
React 前端 → Node/Express (klineForecast.js) → 本服务 (FastAPI + Kronos) → 模型权重
```

## 一次性准备

```bash
cd server/kronos-service

# 1) 建虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2) 装依赖
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU 版

# 3) 拉 Kronos 模型代码（提供 `from model import ...`）
git clone https://github.com/shiyu-coder/Kronos ../../.kronos-src
export PYTHONPATH="$PWD/../../.kronos-src:$PYTHONPATH"
```

模型权重（NeoQuasar/Kronos-small 等）会在首次请求时从 HuggingFace 自动下载并缓存。

## 启动

```bash
# 仍在已激活 venv、且 PYTHONPATH 指向 Kronos 仓库的情况下：
uvicorn app:app --host 127.0.0.1 --port 8008
```

可用环境变量调整：

| 变量 | 默认 | 说明 |
|------|------|------|
| `KRONOS_MODEL` | `NeoQuasar/Kronos-small` | 模型大小：mini/small/base |
| `KRONOS_TOKENIZER` | `NeoQuasar/Kronos-Tokenizer-base` | 配套 tokenizer |
| `KRONOS_MAX_CONTEXT` | `512` | 最大上下文长度 |
| `KRONOS_DEVICE` | `cpu` | `cpu` 或 `cuda:0` |

## 验证

```bash
curl -s localhost:8008/health
curl -s -X POST localhost:8008/predict -H 'Content-Type: application/json' -d '{
  "klines":[{"date":"2024-01-01","open":10,"high":11,"low":9,"close":10.5,"volume":1000,"amount":10500}],
  "pred_len":5
}'
```

## 接入 Node

在 Node 后端（或 `.env.local`）设置：

```
KRONOS_SERVICE_URL=http://127.0.0.1:8008
```

Node 端的 `server/klineForecast.js` 会把历史 K 线 POST 给本服务并返回预测结果。
