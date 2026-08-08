"""遥测帧格式适配（Batch 8.4，修复走读 H2 帧格式断裂）。

背景：适配器产出的统一语义帧（to_storage_dict 分组格式：
entity_id/event_time/pose/load/device/quality），与存储/推理管线期望的
扁平格式（device_id/timestamp/telemetry）字段不对齐，生产路径
`AdapterManager._read_loop` 直接透传导致 KeyError 隐患。

本模块提供纯函数转换：分组格式 → 扁平存储格式（与
tests/test_sustained_run.py 中 `_frame_to_msg` 同语义，正式化到生产代码）。

字段映射：
- entity_id      → device_id
- event_time     → timestamp
- pose/load/device/quality 分组 → telemetry 嵌套 + 顶层 quality
- worker_id      → person_id
"""

from __future__ import annotations

from typing import Any, Dict

# 分组帧中的键 → telemetry 嵌套键（仅映射管线消费的字段，未映射字段不泄漏）
_TELEMETRY_FIELD_MAP: Dict[str, str] = {
    # pose（运动级）
    "trunk_pitch_deg": "pitch_deg",
    "angular_velocity_dps": "angular_velocity_dps",
    # load（负荷级）
    "assist_level": "assist_level",
    "torque_nm": "torque_nm",
    "cumulative_load_score": "cumulative_load_score",
    # device（设备级）
    "battery_pct": "battery_pct",
    "temperature_c": "temperature_c",
    "fault_code": "fault_code",
}


def unified_to_telemetry_row(frame_dict: Dict[str, Any]) -> Dict[str, Any]:
    """UnifiedExoFrame 分组格式 → 存储/推理管线扁平格式（纯函数）。

    输入为 `to_storage_dict` 输出（或任意分组格式 dict）；
    输出含 storage.insert_telemetry 与 inference 管线所需的
    device_id / timestamp / telemetry / quality 顶层字段。
    """
    pose = frame_dict.get("pose") or {}
    load = frame_dict.get("load") or {}
    device = frame_dict.get("device") or {}
    quality = frame_dict.get("quality") or {}

    telemetry: Dict[str, Any] = {}
    for src_group in (pose, load, device):
        for src_key, dst_key in _TELEMETRY_FIELD_MAP.items():
            if src_key in src_group and src_group[src_key] is not None:
                telemetry[dst_key] = src_group[src_key]

    return {
        "record_id": frame_dict.get("record_id", ""),
        "device_id": frame_dict.get("entity_id", ""),
        "timestamp": frame_dict.get("event_time", ""),
        "sequence": frame_dict.get("sequence", 0),
        "source_type": frame_dict.get("source_type", "real"),
        "person_id": frame_dict.get("worker_id"),
        "telemetry": telemetry,
        "quality": {
            "status": quality.get("status", "good"),
            "confidence": quality.get("confidence"),
            "packet_loss_pct": quality.get("packet_loss_pct"),
        },
        "raw_ref": frame_dict.get("raw_ref", ""),
    }


def is_grouped_frame(msg: Any) -> bool:
    """判断消息是否为分组格式（entity_id/event_time 顶层 + pose/load 嵌套）。

    用于 `_read_loop` 兼容双格式：分组帧需转换，扁平帧直接透传。
    """
    if not isinstance(msg, dict):
        return False
    return "entity_id" in msg and "event_time" in msg and ("pose" in msg or "load" in msg)


__all__ = ["unified_to_telemetry_row", "is_grouped_frame"]
