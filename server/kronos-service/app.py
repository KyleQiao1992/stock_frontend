"""
Kronos 推理微服务
=================

把 Kronos（https://github.com/shiyu-coder/Kronos）封装成一个 HTTP 服务，
让 Node 后端可以通过 POST /predict 调用它做 K 线预测。

设计目标：
- 与 Node 后端解耦：Node 只发 JSON（一段历史 K 线 + 预测长度），拿回预测的 K 线。
- 模型只加载一次（启动时），后续请求复用，避免每次请求重载权重。
- 设备（CPU / CUDA）由 KronosPredictor 内部处理；可用 KRONOS_DEVICE 覆盖。

运行方式见同目录 README.md。
"""

import os
import logging

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Kronos 的 model 包来自其仓库（git clone 后把 model/ 放到 PYTHONPATH，或 pip install -e .）。
from model import Kronos, KronosTokenizer, KronosPredictor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("kronos-service")

# ---- 可通过环境变量配置 ----------------------------------------------------
TOKENIZER_REPO = os.getenv("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base")
MODEL_REPO = os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-small")
MAX_CONTEXT = int(os.getenv("KRONOS_MAX_CONTEXT", "512"))
DEVICE = os.getenv("KRONOS_DEVICE", "cpu")  # "cpu" 或 "cuda:0"

app = FastAPI(title="Kronos 推理服务", version="0.1.0")

# 进程级单例：启动时加载一次，全局复用。
_predictor: KronosPredictor | None = None


def get_predictor() -> KronosPredictor:
    global _predictor
    if _predictor is None:
        logger.info("加载 tokenizer=%s model=%s device=%s", TOKENIZER_REPO, MODEL_REPO, DEVICE)
        tokenizer = KronosTokenizer.from_pretrained(TOKENIZER_REPO)
        model = Kronos.from_pretrained(MODEL_REPO)
        _predictor = KronosPredictor(model, tokenizer, device=DEVICE, max_context=MAX_CONTEXT)
        logger.info("Kronos 加载完成")
    return _predictor


# ---- 请求 / 响应模型 -------------------------------------------------------
class Kline(BaseModel):
    date: str  # ISO 日期 "YYYY-MM-DD" 或带时间的字符串
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    amount: float = 0.0


class PredictRequest(BaseModel):
    klines: list[Kline] = Field(..., description="历史 K 线，按时间升序")
    pred_len: int = Field(30, ge=1, le=512, description="要预测的未来 K 线根数")
    freq: str = Field("B", description="未来时间戳频率：B=工作日, D=日, W=周, M=月")
    # 采样参数（透传给 Kronos）
    T: float = 1.0
    top_p: float = 0.9
    sample_count: int = 1


class PredictedKline(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    amount: float


class PredictResponse(BaseModel):
    pred_len: int
    model: str
    klines: list[PredictedKline]


@app.get("/health")
def health():
    return {"status": "ok", "loaded": _predictor is not None, "model": MODEL_REPO}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if len(req.klines) < 2:
        raise HTTPException(status_code=400, detail="至少需要 2 根历史 K 线")

    # 1) 历史 K 线 -> DataFrame（Kronos 需要 open/high/low/close，volume/amount 可选）
    df = pd.DataFrame([k.model_dump() for k in req.klines])
    x_timestamp = pd.to_datetime(df["date"])
    x_df = df[["open", "high", "low", "close", "volume", "amount"]]

    # 2) 生成未来时间戳：从最后一根之后按 freq 递推 pred_len 个
    last_ts = x_timestamp.iloc[-1]
    y_timestamp = pd.Series(
        pd.date_range(start=last_ts, periods=req.pred_len + 1, freq=req.freq)[1:]
    )

    # 3) 调用 Kronos
    try:
        predictor = get_predictor()
        pred_df = predictor.predict(
            df=x_df,
            x_timestamp=x_timestamp,
            y_timestamp=y_timestamp,
            pred_len=req.pred_len,
            T=req.T,
            top_p=req.top_p,
            sample_count=req.sample_count,
        )
    except Exception as exc:  # noqa: BLE001  —— 把推理错误转成 502 让 Node 处理
        logger.exception("预测失败")
        raise HTTPException(status_code=502, detail=f"Kronos 预测失败: {exc}") from exc

    # 4) 拼回带日期的结果
    out: list[PredictedKline] = []
    for ts, (_, row) in zip(y_timestamp, pred_df.iterrows()):
        out.append(
            PredictedKline(
                date=pd.Timestamp(ts).strftime("%Y-%m-%d"),
                open=float(row.get("open", 0.0)),
                high=float(row.get("high", 0.0)),
                low=float(row.get("low", 0.0)),
                close=float(row.get("close", 0.0)),
                volume=float(row.get("volume", 0.0)),
                amount=float(row.get("amount", 0.0)),
            )
        )

    return PredictResponse(pred_len=req.pred_len, model=MODEL_REPO, klines=out)
