"""兼容入口：re-export NXP1 v1.0 协议编解码。

edge_platform/scripts/record_raw_frames.py 与 fixtures_generator.py 优先复用本模块。
真实实现位于 edge.adapters.ny_exo_a1.protocol。
"""
from .adapters.ny_exo_a1.protocol import (  # noqa: F401
    encode_ident, encode_telemetry, encode_heartbeat, encode_fault, encode_backfill,
    decode_frame, crc16_ccitt_false, parse_telemetry_payload,
    TYPE_IDENT, TYPE_HEARTBEAT, TYPE_TELEMETRY, TYPE_BACKFILL, TYPE_FAULT,
    TYPE_IDENT_REQUEST, TYPE_TIME_SYNC,
    FRAME_HEAD, FRAME_TAIL, PROTOCOL_VERSION, DEVICE_MODEL,
    PITCH_RANGE, ROLL_RANGE, ACCEL_RANGE_MG, GYRO_RANGE_DPS, TORQUE_RANGE_NM,
    FAULT_NAMES)

__all__ = [
    "encode_ident", "encode_telemetry", "encode_heartbeat", "encode_fault",
    "encode_backfill", "decode_frame", "crc16_ccitt_false", "parse_telemetry_payload",
    "TYPE_IDENT", "TYPE_HEARTBEAT", "TYPE_TELEMETRY", "TYPE_BACKFILL", "TYPE_FAULT",
    "TYPE_IDENT_REQUEST", "TYPE_TIME_SYNC",
    "FRAME_HEAD", "FRAME_TAIL", "PROTOCOL_VERSION", "DEVICE_MODEL",
    "PITCH_RANGE", "ROLL_RANGE", "ACCEL_RANGE_MG", "GYRO_RANGE_DPS", "TORQUE_RANGE_NM",
    "FAULT_NAMES",
]
