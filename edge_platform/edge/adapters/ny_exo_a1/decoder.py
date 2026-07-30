"""NXP1 v1.0 帧 -> 标准消息 解码层。

把 protocol.decode_frame 解出的 frame_dict 转为平台标准消息（含 Task 9 扩展字段）：
record_id / ingested_at / device_model / firmware_version / protocol_version / raw_ref。

标准消息结构（与协议确认书 §5 对齐 + Task 9 扩展）：
  {record_id, device_id, timestamp, sequence, ingested_at, device_model,
   firmware_version, protocol_version, raw_ref, telemetry, quality, source_type}
"""
from datetime import datetime, timezone

from .protocol import (PROTOCOL_VERSION, DEVICE_MODEL, TYPE_IDENT, TYPE_TELEMETRY,
                       TYPE_HEARTBEAT, TYPE_FAULT)
from ..base import (make_record_id, now_iso,
                     QUALITY_GOOD, QUALITY_DEGRADED, QUALITY_INVALID, QUALITY_UNKNOWN,
                     DEVICE_MODEL as BASE_DEVICE_MODEL)

# 质量状态常量（从 base 复用，供本模块内函数默认填充）
_QUALITY_DEFAULT = {"status": QUALITY_UNKNOWN}


def _ms_to_iso(ms):
    """epoch ms -> ISO 8601（毫秒精度，UTC）。None -> 当前时间。"""
    if ms is None:
        return now_iso()
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat(
        timespec="milliseconds")


def decode_ident_frame(frame):
    """IDENT 帧 -> {device_id, firmware_version, hardware_version}。"""
    payload = frame.get("payload") or {}
    return {
        "device_id": payload.get("device_id"),
        "firmware_version": payload.get("firmware_version"),
        "hardware_version": payload.get("hardware_version"),
    }


def decode_telemetry_frame(frame, source_type, device_id_hint=None):
    """TELEMETRY 帧 -> 完整标准消息（含 Task 9 扩展字段）。

    firmware_version 由 adapter 从已学习 IDENT 填入（device_id_hint 仅用于 device_id）。
    raw_ref 由 adapter 在 insert_raw_frame 后回填。
    """
    payload = frame.get("payload") or {}
    device_id = device_id_hint or payload.get("device_id")
    seq = frame.get("seq")
    ts_ms = frame.get("ts_ms")
    timestamp = _ms_to_iso(ts_ms)
    return {
        "record_id": make_record_id(),
        "device_id": device_id,
        "timestamp": timestamp,
        "sequence": seq,
        "ingested_at": now_iso(),
        "device_model": DEVICE_MODEL,
        "firmware_version": None,   # 由 adapter 从 IDENT 学习后填入
        "protocol_version": PROTOCOL_VERSION,
        "raw_ref": None,            # 由 adapter 在 insert_raw_frame 后回填
        "telemetry": payload,
        "quality": {"status": QUALITY_UNKNOWN},
        "source_type": source_type,
    }


def decode_heartbeat_frame(frame):
    """HEARTBEAT 帧 -> {device_id(None), battery_percent, status, firmware_version, timestamp}。"""
    payload = frame.get("payload") or {}
    return {
        "device_id": None,   # 由 adapter 填入
        "battery_percent": payload.get("battery_percent"),
        "status": payload.get("status"),
        "firmware_version": payload.get("firmware_version"),
        "timestamp": _ms_to_iso(frame.get("ts_ms")),
    }


def decode_fault_frame(frame):
    """FAULT 帧 -> {device_id(None), fault_code, fault_name, detail, timestamp}。"""
    payload = frame.get("payload") or {}
    return {
        "device_id": None,   # 由 adapter 填入
        "fault_code": payload.get("code"),
        "fault_name": payload.get("fault_name"),
        "detail": payload.get("detail"),
        "timestamp": _ms_to_iso(frame.get("ts_ms")),
    }


def decode_backfill_item(item, source_type, device_id_hint=None):
    """BACKFILL 单条子项 -> 标准消息（复用 telemetry 解码路径）。

    item: {seq, ts_ms, telemetry(dict from parse_telemetry_payload)}
    """
    tele = item.get("telemetry") or {}
    seq = item.get("seq")
    ts_ms = item.get("ts_ms")
    return {
        "record_id": make_record_id(),
        "device_id": device_id_hint,
        "timestamp": _ms_to_iso(ts_ms),
        "sequence": seq,
        "ingested_at": now_iso(),
        "device_model": DEVICE_MODEL,
        "firmware_version": None,
        "protocol_version": PROTOCOL_VERSION,
        "raw_ref": None,
        "telemetry": tele,
        "quality": {"status": QUALITY_UNKNOWN},
        "source_type": source_type,
        "_backfill": True,   # 标记补传数据，供上层区分
    }
