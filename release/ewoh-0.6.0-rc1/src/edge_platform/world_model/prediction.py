"""短期预测与模型不确定性。

Predictor 基于规则与线性外推输出短期预测（疲劳/任务延误/设备失联/电量不足/空间拥堵），
每条 Prediction 携带 confidence 与 assumptions 标识模型不确定性；低置信度预测仍输出但在
assumptions 中置 flag，不静默丢弃。

对应 spec「工厂世界模型层」之「短期预测」场景与「标识模型不确定性」要求
（第一阶段规则与统计模型，可解释易验收）。纯 Python 标准库实现。
"""

from dataclasses import dataclass
from typing import Any

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso

MODEL_VERSION = "rules-v1"  # 第一阶段规则模型版本
LOW_CONFIDENCE_THRESHOLD = 0.5  # 低于此值视为低置信度


def _clamp01(x):
    """把数值夹到 [0,1]。"""
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


@dataclass
class Prediction:
    """短期预测结果：predicted_value 为预测值载荷，assumptions 记录模型假设与不确定性。"""

    prediction_id: str
    target_entity_id: str
    prediction_type: str  # FATIGUE/TASK_DELAY/DEVICE_OFFLINE/LOW_BATTERY/ZONE_CONGESTION
    horizon_min: int
    predicted_value: dict[str, Any]
    probability: float
    confidence: float
    assumptions: dict[str, Any]
    generated_at: str
    model_version: str = MODEL_VERSION

    def to_dict(self):
        return {
            "prediction_id": self.prediction_id,
            "target_entity_id": self.target_entity_id,
            "prediction_type": self.prediction_type,
            "horizon_min": self.horizon_min,
            "predicted_value": self.predicted_value,
            "probability": self.probability,
            "confidence": self.confidence,
            "assumptions": self.assumptions,
            "generated_at": self.generated_at,
            "model_version": self.model_version,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            prediction_id=d["prediction_id"],
            target_entity_id=d["target_entity_id"],
            prediction_type=d["prediction_type"],
            horizon_min=d["horizon_min"],
            predicted_value=d.get("predicted_value") or {},
            probability=d.get("probability", 0.0),
            confidence=d.get("confidence", 0.0),
            assumptions=d.get("assumptions") or {},
            generated_at=d.get("generated_at", ""),
            model_version=d.get("model_version", MODEL_VERSION),
        )


class Predictor:
    """规则式短期预测器：线性外推 + 阈值判定，输出带不确定性的预测。"""

    # 默认阈值（可按工厂配置覆盖）
    FATIGUE_LOAD_THRESHOLD = 80.0  # 累计负荷评分阈值（0~100）
    LOW_BATTERY_THRESHOLD = 20.0  # 电量百分比阈值
    TASK_DELAY_SLA_RATIO = 1.0  # 投影完工时间 / SLA 超过此值判延误
    ZONE_CONGESTION_HORIZON_MIN = 10  # 空间拥堵预测水平（分钟）
    DEVICE_OFFLINE_SILENCE_SEC = 60  # 失联秒数阈值
    DEVICE_OFFLINE_PACKET_LOSS = 50.0  # 丢包率百分比阈值

    def _make(
        self, target_entity_id, prediction_type, horizon_min, predicted_value, probability, confidence, assumptions
    ):
        """构造 Prediction；低置信度在 assumptions 中置 flag 但仍输出。"""
        assumptions = dict(assumptions or {})
        assumptions.setdefault("model", "rules-linear-extrapolation")
        if confidence < LOW_CONFIDENCE_THRESHOLD:
            assumptions["flag"] = "low_confidence"
        return Prediction(
            prediction_id=new_id("PRD"),
            target_entity_id=target_entity_id,
            prediction_type=prediction_type,
            horizon_min=horizon_min,
            predicted_value=predicted_value,
            probability=_clamp01(probability),
            confidence=_clamp01(confidence),
            assumptions=assumptions,
            generated_at=now_iso(),
        )

    def predict_fatigue(self, person_id, current_load_score, load_trend_per_min, horizon_min=30):
        """累计负荷线性外推：超过阈值 -> FATIGUE，否则 None。"""
        threshold = self.FATIGUE_LOAD_THRESHOLD
        predicted_load = float(current_load_score) + float(load_trend_per_min) * horizon_min
        if predicted_load <= threshold:
            return None
        exceeds_by = predicted_load - threshold
        probability = min(0.99, 0.3 + exceeds_by / 20.0)
        # 水平越长、趋势越接近 0，不确定性越高
        base = 0.85 - max(0.0, horizon_min - 30) * 0.01
        confidence = min(base, 0.9 if abs(float(load_trend_per_min)) > 0.1 else 0.45)
        return self._make(
            person_id,
            "FATIGUE",
            horizon_min,
            predicted_value={
                "predicted_load_score": round(predicted_load, 2),
                "threshold": threshold,
                "exceeds_by": round(exceeds_by, 2),
            },
            probability=probability,
            confidence=confidence,
            assumptions={
                "current_load_score": current_load_score,
                "load_trend_per_min": load_trend_per_min,
                "horizon_min": horizon_min,
                "threshold": threshold,
            },
        )

    def predict_low_battery(self, device_id, battery_pct, drain_per_min, threshold=20, horizon_min=60):
        """电量线性下降外推：水平内将跌破阈值 -> LOW_BATTERY，否则 None。"""
        drain = float(drain_per_min)
        predicted_battery = float(battery_pct) - drain * horizon_min
        if predicted_battery >= threshold:
            return None
        if drain > 0:
            minutes_to_threshold = max(0.0, (float(battery_pct) - threshold) / drain)
            probability = min(0.99, 0.5 + (horizon_min - minutes_to_threshold) / horizon_min * 0.49)
            confidence = 0.8 if drain > 0.5 else 0.5
        else:
            # 已低于阈值但无继续下降趋势：低置信度
            minutes_to_threshold = None
            probability = 0.5
            confidence = 0.4
        return self._make(
            device_id,
            "LOW_BATTERY",
            horizon_min,
            predicted_value={
                "predicted_battery_pct": round(predicted_battery, 2),
                "threshold": threshold,
                "minutes_to_threshold": round(minutes_to_threshold, 2) if minutes_to_threshold is not None else None,
            },
            probability=probability,
            confidence=confidence,
            assumptions={
                "battery_pct": battery_pct,
                "drain_per_min": drain_per_min,
                "horizon_min": horizon_min,
                "threshold": threshold,
            },
        )

    def predict_task_delay(self, task_id, progress_pct, elapsed_min, sla_min):
        """按当前进度速率投影完工时间，超过 SLA -> TASK_DELAY，否则 None。"""
        elapsed_min = float(elapsed_min)
        progress_pct = float(progress_pct)
        if progress_pct <= 0:
            # 无进度：已耗时过半 SLA 即视为延误风险（低置信度）
            if elapsed_min >= sla_min * 0.5:
                return self._make(
                    task_id,
                    "TASK_DELAY",
                    max(1, int(sla_min - elapsed_min)),
                    predicted_value={
                        "progress_pct": progress_pct,
                        "elapsed_min": elapsed_min,
                        "sla_min": sla_min,
                        "projected_completion_min": None,
                        "reason": "no_progress",
                    },
                    probability=0.6,
                    confidence=0.4,
                    assumptions={
                        "progress_pct": progress_pct,
                        "elapsed_min": elapsed_min,
                        "sla_min": sla_min,
                        "reason": "no_progress",
                    },
                )
            return None
        rate = progress_pct / elapsed_min if elapsed_min > 0 else progress_pct
        projected_completion_min = 100.0 / rate
        if projected_completion_min <= sla_min * self.TASK_DELAY_SLA_RATIO:
            return None
        probability = min(0.99, 0.4 + (projected_completion_min - sla_min) / sla_min * 0.5)
        confidence = 0.75 if elapsed_min >= 5 else 0.4
        return self._make(
            task_id,
            "TASK_DELAY",
            max(1, int(projected_completion_min - elapsed_min)),
            predicted_value={
                "progress_pct": progress_pct,
                "elapsed_min": elapsed_min,
                "sla_min": sla_min,
                "projected_completion_min": round(projected_completion_min, 2),
            },
            probability=probability,
            confidence=confidence,
            assumptions={
                "progress_pct": progress_pct,
                "elapsed_min": elapsed_min,
                "sla_min": sla_min,
                "rate_per_min": round(rate, 4),
            },
        )

    def predict_zone_congestion(self, station_id, current_occupancy, trend, capacity):
        """工位占用线性外推：超过容量 -> ZONE_CONGESTION，否则 None。"""
        horizon = self.ZONE_CONGESTION_HORIZON_MIN
        predicted_occupancy = float(current_occupancy) + float(trend) * horizon
        if predicted_occupancy <= capacity:
            return None
        probability = min(0.99, 0.4 + (predicted_occupancy - capacity) / max(1.0, float(capacity)) * 0.5)
        confidence = 0.7 if abs(float(trend)) > 0.1 else 0.4
        return self._make(
            station_id,
            "ZONE_CONGESTION",
            horizon,
            predicted_value={
                "current_occupancy": current_occupancy,
                "predicted_occupancy": round(predicted_occupancy, 2),
                "capacity": capacity,
                "trend_per_min": trend,
            },
            probability=probability,
            confidence=confidence,
            assumptions={
                "current_occupancy": current_occupancy,
                "trend_per_min": trend,
                "capacity": capacity,
                "horizon_min": horizon,
            },
        )

    def predict_device_offline(self, device_id, last_seen_ts, packet_loss_pct):
        """设备失联预测：丢包率高或静默超阈值 -> DEVICE_OFFLINE，否则 None。"""
        now_ms = ts_to_ms(now_iso())
        last_ms = ts_to_ms(last_seen_ts)
        silence_sec = max(0.0, (now_ms - last_ms) / 1000.0)
        packet_loss_pct = float(packet_loss_pct)
        triggered = packet_loss_pct >= self.DEVICE_OFFLINE_PACKET_LOSS or silence_sec >= self.DEVICE_OFFLINE_SILENCE_SEC
        if not triggered:
            return None
        prob_from_loss = min(1.0, packet_loss_pct / 100.0)
        prob_from_silence = min(1.0, silence_sec / (self.DEVICE_OFFLINE_SILENCE_SEC * 3))
        probability = min(0.99, 0.4 + max(prob_from_loss, prob_from_silence) * 0.5)
        confidence = 0.7 if silence_sec >= self.DEVICE_OFFLINE_SILENCE_SEC else 0.5
        return self._make(
            device_id,
            "DEVICE_OFFLINE",
            5,
            predicted_value={
                "last_seen_ts": last_seen_ts,
                "silence_sec": round(silence_sec, 2),
                "packet_loss_pct": packet_loss_pct,
            },
            probability=probability,
            confidence=confidence,
            assumptions={
                "last_seen_ts": last_seen_ts,
                "silence_sec": round(silence_sec, 2),
                "packet_loss_pct": packet_loss_pct,
                "silence_threshold_sec": self.DEVICE_OFFLINE_SILENCE_SEC,
                "packet_loss_threshold_pct": self.DEVICE_OFFLINE_PACKET_LOSS,
            },
        )
