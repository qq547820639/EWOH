"""推理管线：订阅 telemetry，每设备 2s 滑窗（步长 1s），规则+模型混合推理。

- 规则引擎始终运行，draft 直接转交 EventEngine；
- 动作分类优先活动模型；registry 无活动模型 / 模型损坏 / predict 抛错时
  自动退回规则模式（is_rule=True，model_version='rule-fallback'，简单阈值
  给 stand/walk/bend/lift/carry/unknown 判定）；
- Task 20.2 unknown 六路触发（规则降级路径，模型路径沿用 model 自身 reasons）：
  1. data_quality        特征为 None（窗口质量不足）
  2. low_confidence      confidence < 0.6
  3. ambiguous           两动作特征同时命中（规则路径专用）
  4. firmware_unverified firmware_version 不在白名单
  5. out_of_distribution 特征超出训练分布合理区间
  6. sensor_channel_missing 关键传感器通道 None
- 推理结果结构冻结（见 _infer 返回 dict）；insert_inference + publish 'inference'；
- 内存保留推理耗时许本（P50/P95），供 /api/inference/metrics。
- Task 31：handle_telemetry 入口支持可选 consent_manager 钩子，
  拒绝授权的 person 的帧不进入推理（不入库、不发布、记录审计日志）。
"""

import threading
import time
from collections import deque
from datetime import datetime, timezone

from . import SAMPLE_HZ, STEP_SEC, WINDOW_SEC, new_id
from .events import EventEngine
from .features import extract_features

WINDOW_SIZE = WINDOW_SEC * SAMPLE_HZ  # 40
STEP_SIZE = STEP_SEC * SAMPLE_HZ  # 20

# 规则降级模式的启发式量纲（用于 key_features 排序）
_HEURISTIC_SCALE = {
    "pitch": 45.0,
    "roll": 45.0,
    "gyro": 150.0,
    "accel": 3.0,
    "torque": 25.0,
    "assist": 1.0,
}

# Task 20.2 unknown 触发常量
_LOW_CONF_THRESHOLD = 0.6  # confidence 低于此值 → unknown
_FIRMWARE_WHITELIST_DEFAULT = None  # None = 不校验；集合 = 校验

# 训练分布合理区间（超出 → out_of_distribution）
# 覆盖 stand/walk/bend/lift/carry 的生理可达范围
_TRAINING_BOUNDS = {
    "pitch_mean": (-30.0, 120.0),
    "pitch_max": (-30.0, 180.0),
    "roll_mean": (-90.0, 90.0),
    "gyro_mag_mean": (0.0, 300.0),
    "gyro_mag_max": (0.0, 500.0),
    "accel_mag_std": (0.0, 30.0),
    "torque_mean": (-10.0, 80.0),
    "torque_max": (-10.0, 100.0),
    "assist_mean": (-0.5, 1.5),
}

# 传感器关键通道（任一 None → sensor_channel_missing）
_KEY_CHANNELS = ("pitch_deg", "roll_deg", "torque_nm", "assist_level", "angular_velocity", "acceleration")

# Task 31：consent 检查使用的用途名（与 ConsentPurpose.TELEMETRY.value 一致）。
# ConsentManager.is_allowed 接受字符串，会自动转成 ConsentPurpose 枚举。
CONSENT_PURPOSE_TELEMETRY = "TELEMETRY"


def _now_iso():
    """当前 UTC ISO 8601（毫秒精度），用于审计时间戳。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


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
    def __init__(
        self,
        storage,
        bus,
        registry,
        rules,
        event_engine=None,
        firmware_whitelist=None,
        metrics_collector=None,
        consent_manager=None,
    ):
        self.storage = storage
        self.bus = bus
        self.registry = registry
        self.rules = rules
        self.events = event_engine or EventEngine(storage, bus)
        # Task 20.2: firmware 白名单（None = 不校验）
        self._firmware_whitelist = set(firmware_whitelist) if firmware_whitelist else None
        self._buf = {}  # device_id -> deque(遥测消息)
        self._cnt = {}  # device_id -> 距上次推理的消息计数
        self._entered = {}  # device_id -> 本步长内是否有 draft 进入事件判断
        self._lat = deque(maxlen=5000)  # 推理耗时样本（ms）
        self._model = None  # 活动模型缓存（按版本失效）
        self._model_ver = None
        self._threads = []
        # Task 33：可注入 MetricsCollector，记录每次推理耗时/标签/异常
        self._metrics = metrics_collector
        # Task 31：可注入 ConsentManager（None = 不检查授权，保持向后兼容）
        self._consent_manager = consent_manager
        # Task 31：授权拒绝审计日志（每条含 ts/person_id/device_id/frame_ts/reason/purpose）
        self.consent_denied_log = []

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
        """规则降级路径的动作判定（stand/walk/bend/lift/carry/unknown）。

        Task 20.1：carry = 高扭矩 + 持续行走特征（walk + high torque）。
        判定顺序：bend > carry > lift > walk > stand。
        """
        if feats is None:
            return "unknown", 0.0, "data_quality"
        if feats["pitch_mean"] > 35:
            return "bend", 0.7, None
        # Task 20.1: carry = 行走特征 + 高扭矩（区别于纯 lift 的静止高负荷）
        is_walk = feats["gyro_mag_mean"] > 40 or feats["accel_mag_std"] > 1.5
        is_high_load = feats["torque_mean"] > 15 or feats["assist_mean"] > 0.5
        if is_walk and is_high_load:
            return "carry", 0.65, None
        if is_high_load:
            return "lift", 0.65, None
        if is_walk:
            return "walk", 0.65, None
        return "stand", 0.6, None

    # ---- Task 20.2: unknown 六路触发 ----
    def _check_unknown_triggers(self, window, feats, label, conf, model, is_rule, firmware_version):
        """检查 unknown 六路触发条件，返回首个命中的 reason 字符串（或 None）。

        判定顺序固定（与模型路径互补：模型自身已有 data_quality/ambiguous/
        low_confidence，此处额外覆盖 firmware/distribution/sensor，并对规则
        路径补充 low_confidence/ambiguous）。
        """
        # 1. data_quality — 特征为 None（窗口质量不足）
        if feats is None:
            return "data_quality"
        # 2. low_confidence — confidence < 0.6（规则路径补充；模型路径阈值 0.55
        #    已在 predict 内判定，此处对模型正预测也做更严格的 0.6 复核）
        if conf < _LOW_CONF_THRESHOLD:
            return "low_confidence"
        # 3. ambiguous — 两动作特征同时命中（仅规则路径；模型路径用质心间距判定）
        if is_rule and self._is_ambiguous(feats):
            return "ambiguous"
        # 4. firmware_unverified — firmware_version 不在白名单
        if self._firmware_whitelist is not None:
            if not firmware_version or firmware_version not in self._firmware_whitelist:
                return "firmware_unverified"
        # 5. out_of_distribution — 特征超出训练分布合理区间
        if self._is_out_of_distribution(feats):
            return "out_of_distribution"
        # 6. sensor_channel_missing — 关键传感器通道 None
        if self._has_missing_channel(window):
            return "sensor_channel_missing"
        return None

    @staticmethod
    def _is_ambiguous(feats):
        """规则路径歧义判定：两个及以上动作的主条件同时命中（carry 组合除外）。

        carry = walk + high_load 是合法的复合动作，不视为歧义；
        其余组合（bend+walk、bend+load 等）视为歧义。
        """
        bend = feats["pitch_mean"] > 35
        load = feats["torque_mean"] > 15 or feats["assist_mean"] > 0.5
        walk = feats["gyro_mag_mean"] > 40 or feats["accel_mag_std"] > 1.5
        # carry = walk + load（无 bend）是合法组合，不视为歧义
        if walk and load and not bend:
            return False
        matches = sum([bend, load, walk])
        return matches >= 2

    @staticmethod
    def _is_out_of_distribution(feats):
        """特征超出训练分布合理区间。"""
        for key, (lo, hi) in _TRAINING_BOUNDS.items():
            v = feats.get(key)
            if v is None:
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv < lo or fv > hi:
                return True
        return False

    @staticmethod
    def _has_missing_channel(window):
        """窗口最新一条遥测的关键传感器通道是否缺失（None）。"""
        if not window:
            return True
        tel = window[-1].get("telemetry") or {}
        for ch in _KEY_CHANNELS:
            if tel.get(ch) is None:
                return True
        return False

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

    # ---- Task 31：授权检查 ----
    def _check_consent(self, msg):
        """检查本帧是否被授权采集遥测。

        - 未注入 consent_manager → 直接放行（向后兼容）。
        - msg 缺少 person_id → 放行（无法判定主体，按 fail-open）。
        - is_allowed 返回 False → 记录审计日志并返回 False（跳过该帧）。
        """
        if self._consent_manager is None:
            return True
        person_id = msg.get("person_id")
        if not person_id:
            return True  # 无主体信息，不阻止（保持现有行为）
        try:
            allowed = self._consent_manager.is_allowed(person_id, CONSENT_PURPOSE_TELEMETRY)
        except Exception:
            # 授权服务异常时 fail-open，避免授权故障导致全平台停摆；
            # 异常本身不写入审计以免噪声。
            return True
        if not allowed:
            self.consent_denied_log.append(
                {
                    "ts": _now_iso(),
                    "person_id": person_id,
                    "device_id": msg.get("device_id"),
                    "frame_ts": msg.get("timestamp"),
                    "reason": "consent_denied",
                    "purpose": CONSENT_PURPOSE_TELEMETRY,
                }
            )
            return False
        return True

    # ---- 消息入口 ----
    def handle_telemetry(self, msg):
        """处理一条遥测：规则始终运行；满足步长时输出一条推理结果。

        Task 31：入口处先做 consent 检查；拒绝授权的帧不进入缓冲、不触发规则、
        不产出推理结果（仅记录审计日志）。
        """
        dev = msg.get("device_id")
        if not dev:
            return None
        # Task 31：授权检查钩子（consent_manager 为 None 时直接放行）
        if not self._check_consent(msg):
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
        try:
            return self._infer(dev, list(buf))
        except Exception:
            # Task 33：推理过程异常计入 error_count（保持原异常向上传播）
            if self._metrics is not None:
                try:
                    self._metrics.record_inference(0.0, "unknown", error=True)
                except Exception:
                    pass
            raise

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
        # Task 20.2: unknown 六路触发（模型已返回 unknown 时保留其 reason；
        # 模型/规则正预测时按六路顺序复核，命中则降级为 unknown）
        firmware_version = window[-1].get("firmware_version") if window else None
        if label != "unknown":
            triggered = self._check_unknown_triggers(window, feats, label, conf, model, is_rule, firmware_version)
            if triggered:
                label = "unknown"
                reason = triggered
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
        # Task 33：记录推理指标到 MetricsCollector（若已注入）
        if self._metrics is not None:
            try:
                self._metrics.record_inference(ms, label, error=False)
            except Exception:
                pass
        # Task 21: 推理结果反馈规则引擎（ACTION_ANOMALY_LOW_QUALITY）
        try:
            anom_drafts = self.rules.on_inference(res) or []
        except Exception:
            anom_drafts = []
        for d in anom_drafts:
            self.events.handle_draft(d)
            self._entered[dev] = True
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

        for topic, fn in (("telemetry", self.handle_telemetry), ("device_status", self.handle_device_status)):
            t = threading.Thread(
                target=loop, args=(self.bus.subscribe(topic), fn), daemon=True, name=f"inference-{topic}"
            )
            t.start()
            self._threads.append(t)
