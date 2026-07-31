"""外骨骼数据分级与统一语义映射（Task 8.1）。

对应 spec「外骨骼数据分级与统一语义」：所有原始字段进入平台前转换为统一语义，
厂商字段不泄漏到上层业务。本模块定义四级数据字段清单与 UnifiedExoFrame 统一帧，
并提供 map_vendor_to_unified / to_storage_dict / from_storage_dict 工具。

四级数据（spec「外骨骼数据分级与统一语义」Requirement）：
- DEVICE   设备级：ID/硬件固件版本/电量/温度/故障码/通信质量/在线状态/传感器健康
- MOTION   运动级：加速度/角速度/姿态角/关节角/步态周期/动作频率/身体倾角
- LOAD     负荷级：助力水平/助力输出/力矩/压力/搬运次数/高负荷持续时间/累计负荷指标
- BUSINESS 业务级：绑定人员/当前任务/工位/起止时间/任务进度/异常说明

存储 JSON 示例（to_storage_dict 输出格式）：
{
  "record_id": "REC-a1b2c3d4",
  "ingested_at": "2026-07-31T08:30:00.123+00:00",
  "device_model": "NY-EXO-A1",
  "firmware_version": "1.2.0",
  "protocol_version": "NXP1 v1.0",
  "raw_ref": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "entity_id": "EXO-001",
  "worker_id": "P-001",
  "event_time": "2026-07-31T08:30:00.000+00:00",
  "source_type": "real",
  "pose": {"trunk_pitch_deg": 28.4, "angular_velocity_dps": 12.3,
           "joint_angles_deg": {"left_knee": 45.0}},
  "load": {"assist_level": 0.6, "torque_nm": 18.5, "cumulative_load_score": 0.42},
  "device": {"battery_pct": 78, "temperature_c": 36.5, "fault_code": null, "health": "good"},
  "quality": {"packet_loss_pct": 0.5, "confidence": 0.92, "status": "good"}
}

纯 Python 标准库实现，沿用 edge_platform.spatial 的 now_iso 时间戳约定。
"""

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, Optional

from edge_platform.spatial import new_id, now_iso


# ---- 数据分级常量（spec 5.1：四级数据字段清单） ----

TIER_DEVICE = "DEVICE"
TIER_MOTION = "MOTION"
TIER_LOAD = "LOAD"
TIER_BUSINESS = "BUSINESS"

DATA_TIERS = (TIER_DEVICE, TIER_MOTION, TIER_LOAD, TIER_BUSINESS)

# 各级字段清单（对应 spec Requirement「外骨骼数据分级与统一语义」）
TIER_FIELDS = {
    TIER_DEVICE: [
        "device_id", "hardware_version", "firmware_version",
        "battery_pct", "temperature_c", "fault_code",
        "comm_quality", "online", "sensor_health",
    ],
    TIER_MOTION: [
        "acceleration", "angular_velocity", "posture_angle", "joint_angles",
        "gait_cycle", "action_frequency", "trunk_pitch",
    ],
    TIER_LOAD: [
        "assist_level", "assist_output", "torque", "pressure",
        "lift_count", "high_load_duration", "cumulative_load",
    ],
    TIER_BUSINESS: [
        "bound_person", "current_task", "station",
        "start_time", "end_time", "task_progress", "anomaly_note",
    ],
}


@dataclass
class UnifiedExoFrame:
    """外骨骼统一语义帧（厂商字段经映射后产物，不含厂商私有字段）。

    字段分组对应 spec：pose=运动级核心，load=负荷级核心，device=设备级核心，
    quality=数据质量与置信度；entity_id/worker_id/event_time/source_type 为业务级索引。

    标准消息扩展字段（spec「标准消息扩展与数据质量」）：
    - record_id：平台全局唯一记录 ID，适配器产出时生成（new_id("REC")）
    - ingested_at：平台接收时刻（ISO 8601 UTC），区别于 event_time（设备产生时刻）
    - device_model / firmware_version / protocol_version：设备元信息追溯
    - raw_ref：原始帧字节 SHA256 引用，支持「标准消息 ↔ 原始帧」双向追溯
    """
    entity_id: str
    worker_id: Optional[str] = None
    event_time: str = ""
    source_type: str = "real"
    pose: Dict[str, Any] = field(default_factory=lambda: {
        "trunk_pitch_deg": None, "angular_velocity_dps": None, "joint_angles_deg": None,
    })
    load: Dict[str, Any] = field(default_factory=lambda: {
        "assist_level": None, "torque_nm": None, "cumulative_load_score": None,
    })
    device: Dict[str, Any] = field(default_factory=lambda: {
        "battery_pct": None, "temperature_c": None, "fault_code": None, "health": "unknown",
    })
    quality: Dict[str, Any] = field(default_factory=lambda: {
        "packet_loss_pct": None, "confidence": None, "status": "unknown",
    })
    # ---- 标准消息扩展字段（spec「标准消息扩展与数据质量」） ----
    record_id: str = ""
    ingested_at: str = ""
    device_model: str = ""
    firmware_version: str = ""
    protocol_version: str = ""
    raw_ref: str = ""

    def __post_init__(self):
        if not self.event_time:
            self.event_time = now_iso()
        if not self.record_id:
            self.record_id = new_id("REC")
        if not self.ingested_at:
            self.ingested_at = now_iso()
        # 确保分组 dict 至少包含规范字段（缺失补 None / health 默认 unknown）
        for k in ("trunk_pitch_deg", "angular_velocity_dps", "joint_angles_deg"):
            self.pose.setdefault(k, None)
        for k in ("assist_level", "torque_nm", "cumulative_load_score"):
            self.load.setdefault(k, None)
        for k in ("battery_pct", "temperature_c", "fault_code"):
            self.device.setdefault(k, None)
        self.device.setdefault("health", "unknown")
        # 质量状态统一为 good/degraded/invalid/unknown（spec「标准消息扩展与数据质量」）
        for k in ("packet_loss_pct", "confidence", "status"):
            self.quality.setdefault(k, None)
        self.quality.setdefault("status", "unknown")


def _set_path(frame: UnifiedExoFrame, path: str, value: Any):
    """按 'group.field' 形式的路径写入分组字段；未知路径忽略（保守不泄漏）。

    顶层字段（entity_id/worker_id/event_time/source_type 及标准消息扩展字段）通过 setattr 写入。
    """
    if not path or not isinstance(path, str):
        return
    if "." not in path:
        if path in ("entity_id", "worker_id", "event_time", "source_type",
                    "record_id", "ingested_at", "device_model",
                    "firmware_version", "protocol_version", "raw_ref"):
            setattr(frame, path, value)
        return
    group, field_name = path.split(".", 1)
    grp = getattr(frame, group, None)
    if isinstance(grp, dict):
        grp[field_name] = value


def map_vendor_to_unified(raw, mapping):
    """将厂商原始 dict 转换为 UnifiedExoFrame。

    mapping: {vendor_field_name: unified_path}
        例：{"pitch_deg": "pose.trunk_pitch_deg",
              "gyro_dps": "pose.angular_velocity_dps",
              "joint_angles": "pose.joint_angles_deg",
              "assist": "load.assist_level",
              "torque_nm": "load.torque_nm",
              "load_score": "load.cumulative_load_score",
              "battery": "device.battery_pct",
              "temp_c": "device.temperature_c",
              "fault": "device.fault_code",
              "health": "device.health",
              "loss_pct": "quality.packet_loss_pct",
              "conf": "quality.confidence",
              "dev_id": "entity_id",
              "person_id": "worker_id",
              "ts": "event_time",
              "src": "source_type"}

    厂商字段 NOT 在 mapping 中的不会出现在统一帧中（spec「厂商字段不泄漏到上层」）。
    """
    if not isinstance(raw, dict):
        raise TypeError("raw 必须为 dict")
    if not isinstance(mapping, dict):
        raise TypeError("mapping 必须为 dict")

    frame = UnifiedExoFrame(entity_id=raw.get("entity_id") or "unknown")

    for vendor_key, unified_path in mapping.items():
        if vendor_key not in raw:
            continue
        _set_path(frame, unified_path, raw[vendor_key])

    return frame


def to_storage_dict(frame):
    """将 UnifiedExoFrame 序列化为可存储/可 JSON 化的 dict（spec 5.2 示例格式）。"""
    if isinstance(frame, UnifiedExoFrame):
        return asdict(frame)
    if isinstance(frame, dict):
        return dict(frame)
    raise TypeError("frame 必须为 UnifiedExoFrame 或 dict")


def from_storage_dict(d):
    """从存储 dict 重建 UnifiedExoFrame（to_storage_dict 的逆运算）。"""
    if not isinstance(d, dict):
        raise TypeError("d 必须为 dict")
    return UnifiedExoFrame(
        entity_id=d.get("entity_id", "unknown"),
        worker_id=d.get("worker_id"),
        event_time=d.get("event_time", ""),
        source_type=d.get("source_type", "real"),
        pose=dict(d.get("pose") or {}),
        load=dict(d.get("load") or {}),
        device=dict(d.get("device") or {}),
        quality=dict(d.get("quality") or {}),
        record_id=d.get("record_id", ""),
        ingested_at=d.get("ingested_at", ""),
        device_model=d.get("device_model", ""),
        firmware_version=d.get("firmware_version", ""),
        protocol_version=d.get("protocol_version", ""),
        raw_ref=d.get("raw_ref", ""),
    )
