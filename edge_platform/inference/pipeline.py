"""推理管线：订阅 telemetry，每设备 2s 滑窗（步长 1s），规则+模型混合推理。

- 规则引擎始终运行，draft 直接转交 EventEngine；
- 动作分类优先活动模型；registry 无活动模型 / 模型损坏 / predict 抛错时
  自动退回规则模式（is_rule=True，model_version='rule-fallback'，简单阈值
  给 stand/walk/bend/lift/unknown 判定）；
- 推理结果结构冻结（见 _infer 返回 dict）；insert_inference + publish 'inference'；
- 内存保留推理耗时许本（P50/P95），供 /api/inference/metrics。
"""

import threading
import time
from collections import deque

from . import SAMPLE_HZ, WINDOW_SEC, STEP_SEC, new_id
from .events import EventEngine
from .features import extract_features

WINDOW_SIZE = WINDOW_SEC * SAMPLE_HZ   # 40
STEP_SIZE = STEP_SEC * SAMPLE_HZ       # 20

# 规则降级模式的启发式量纲（用于 key_features 排序）
_HEURISTIC_SCALE = {
    "pitch": 45.0, "roll": 45.0, "gyro": 150.0,
    "accel": 3.0, "torque": 25.0, "assist": 1.0,
}


def _window_quality(window):
    """窗口数据质量：invalid>30% → invalid；非 good>20% → degraded；否则 good。"""
    n = len(window)
    if not n:
        return "invalid"
    invalid = sum(1 for m in window if (m.get("quality") or {}).get("status") == "invalid")
    non_good = sum(1 for m in window if (m.get("quality") or {}).get("status", "good") != "good")
    if invalid / n > 0.30:
        return "invalid"
    if non_good / n > 0.20:
        return "degraded"
    return "good"


class InferencePipeline:
    def __init__(self, storage, bus, registry, rules, event_engine=None):
        self.storage = storage
        self.bus = bus
        self.registry = registry
        self.rules = rules
        self.events = event_engine or EventEngine(storage, bus)
        self._buf = {}          # device_id -> deque(遥测消息)
        self._cnt = {}          # device_id -> 距上次推理的消息计数
        self._entered = {}      # device_id -> 本步长内是否有 draft 进入事件判断
        self._lat = deque(maxlen=5000)   # 推理耗时样本（ms）
        self._model = None      # 活动模型缓存（按版本失效）
        self._model_ver = None
        self._threads = []

    # ---- 模型获取（版本缓存 + 自动降级） ----
    def _get_model(self):
        if self.registry is None:
            return None, None
        try:
            ver = self.registry.active_version()
        except Exception:
            ver = None
        if not ver:
            self._model = self._model_ver = None
            return None, None
        if ver != self._model_ver:
            try:
                got = self.registry.active()
            except Exception:
                got = None
            if not got:
                self._model = self._model_ver = None
                return None, None
            self._model, self._model_meta = got
            self._model_ver = ver
        return self._model, self._model_meta

    # ---- 规则降级判定（无模型可用时） ----
    @staticmethod
    def _rule_label(feats):
        if feats is None:
            return "unknown", 0.0, "data_quality"
        if feats["pitch_mean"] > 35:
            return "bend", 0.7, None
        if feats["torque_mean"] > 15 or feats["assist_mean"] > 0.5:
            return "lift", 0.65, None
        if feats["gyro_mag_mean"] > 40 or feats["accel_mag_std"] > 1.5:
            return "walk", 0.65, None
        return "stand", 0.6, None

    def _key_features(self, feats, model):
        """top3 关键特征名：有模型按 |z-score|，降级模式按启发式量纲归一。"""
        if feats is None:
            return []
        scores = {}
        for k, v in feats.items():
            if model is not None and k in model.feature_names:
                i = model.feature_names.index(k)
                scores[k] = abs((v - model.mean[i]) / model.std[i])
            else:
                prefix = k.split("_")[0]
                scores[k] = abs(v) / _HEURISTIC_SCALE.get(prefix, 1.0)
        return [k for k, _ in sorted(scores.items(), key=lambda t: -t[1])[:3]]

    # ---- 消息入口 ----
    def handle_telemetry(self, msg):
        """处理一条遥测：规则始终运行；满足步长时输出一条推理结果。"""
        dev = msg.get("device_id")
        if not dev:
            return None
        # invalid 数据保留入库（供审计/回放），但不进入推理窗口与规则判断
        if (msg.get("quality") or {}).get("status") == "invalid":
            return None
        buf = self._buf.setdefault(dev, deque(maxlen=WINDOW_SIZE))
        buf.append(msg)
        self._cnt[dev] = self._cnt.get(dev, 0) + 1
        try:
            drafts = self.rules.on_telemetry(msg) or []
        except Exception:
            drafts = []  # 规则异常不阻断推理主路
        for d in drafts:
            self.events.handle_draft(d)
            self._entered[dev] = True
        if len(buf) < WINDOW_SIZE or self._cnt[dev] < STEP_SIZE:
            return None
        self._cnt[dev] = 0
        return self._infer(dev, list(buf))

    def handle_device_status(self, msg):
        """设备状态消息：{"device_id","status","timestamp"}（offline/online）。"""
        dev = msg.get("device_id")
        ts = msg.get("timestamp")
        if not dev:
            return
        if msg.get("status") == "offline":
            d = self.rules.on_offline(dev, ts)
            if d:
                self.events.handle_draft(d)
        else:
            self.rules.on_recover(dev, ts)

    # ---- 单窗推理 ----
    def _infer(self, dev, window):
        t0 = time.perf_counter()
        feats = extract_features(window)
        model, meta = self._get_model()
        is_rule = False
        if model is not None:
            try:
                pred = model.predict(feats)
                label = pred["label"]
                conf = pred["confidence"]
                reason = pred["unknown_reason"]
                model_id = model.model_id
                model_version = meta.get("version", model.version)
            except Exception:
                model = None  # 模型运行期异常 → 降级
        if model is None:
            is_rule = True
            label, conf, reason = self._rule_label(feats)
            model_id = "rules"
            model_version = "rule-fallback"
        key_features = self._key_features(feats, None if is_rule else model)
        ms = (time.perf_counter() - t0) * 1000.0
        self._lat.append(ms)
        entered = bool(self._entered.pop(dev, False))
        res = {
            "inference_id": new_id("INF"),
            "device_id": dev,
            "ts_start": window[0]["timestamp"],
            "ts_end": window[-1]["timestamp"],
            "label": label,
            "confidence": conf,
            "data_quality": _window_quality(window),
            "model_id": model_id,
            "model_version": model_version,
            "inference_ms": round(ms, 3),
            "window_sec": WINDOW_SEC,
            "key_features": key_features,
            "is_rule": is_rule,
            "entered_event_judgment": entered,
            "unknown_reason": reason,
            "source_type": window[-1].get("source_type"),
        }
        self.storage.insert_inference(res)
        self.bus.publish("inference", res)
        return res

    # ---- 指标 ----
    def metrics(self):
        """推理延迟统计，供 /api/inference/metrics。"""
        xs = sorted(self._lat)
        n = len(xs)
        if not n:
            return {"count": 0, "p50": None, "p95": None}

        def pct(p):
            return xs[min(n - 1, max(0, int(round(p / 100.0 * n)) - 1))]

        return {"count": n, "p50": round(pct(50), 3), "p95": round(pct(95), 3)}

    # ---- 后台消费（可选；测试可直接调 handle_*） ----
    def start(self):
        """订阅 telemetry / device_status 并后台消费（daemon 线程）。"""
        def loop(q, fn):
            while True:
                fn(q.get())

        for topic, fn in (("telemetry", self.handle_telemetry),
                          ("device_status", self.handle_device_status)):
            t = threading.Thread(target=loop, args=(self.bus.subscribe(topic), fn),
                                 daemon=True, name="inference-%s" % topic)
            t.start()
            self._threads.append(t)
