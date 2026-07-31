"""NXP1 v1.0 线协议编码器（Task 2.3 注入器与无真机自测专用）。

与 `protocol.py`（解码侧）严格互逆：`decode_frame(encode_xxx(...))` 必须还原出
同一组厂商物理量。协议口径来源同为
`delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md`（NXP1 v1.0 冻结基线）。

用途边界（重要）
----------------
本模块只编码 **设备 → 平台** 方向的上行帧
（HEARTBEAT / IDENT / TELEMETRY / BACKFILL / FAULT），用于在没有真机时按同一
线协议驱动适配层做协议/质量/断线/补传/乱序/故障码自测。

安全红线（协议确认书 §4）：平台与大模型不得实现任何指向
「关节实时控制目标 / 关闭或放宽限扭限速 / 关闭急停与异常退出 / 绕过本地安全校验的
调试指令」的写入路径。即便是协议确认书 §3.6 允许的下行白名单命令
（IDENT_REQUEST 0x81、TIME_SYNC 0x82），本仓库亦 **不提供编码函数、不提供发送路径**，
`encode_frame` 对任何非上行 TYPE 直接抛 `ValueError`。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

import struct

from edge_platform.edge.adapters.ny_exo_a1 import protocol

#: 允许编码的方向：仅「设备 → 平台」上行帧（协议确认书 2.2）
UPLINK_TYPES = (
    protocol.TYPE_HEARTBEAT,
    protocol.TYPE_IDENT,
    protocol.TYPE_TELEMETRY,
    protocol.TYPE_BACKFILL,
    protocol.TYPE_FAULT,
)

#: 协议确认书 §3.6 下行白名单命令。本仓库不实现其编码与发送，仅在此登记以便审计。
DOWNLINK_TYPES = {0x81: "IDENT_REQUEST", 0x82: "TIME_SYNC"}

#: 协议确认书 §4 禁止平台写入清单（安全红线，永不实现）
FORBIDDEN_WRITE_CAPABILITIES = (
    "关节实时控制目标",
    "关闭或放宽限扭/限速",
    "关闭急停与异常退出",
    "绕过本地安全校验的调试指令",
)

#: LEN 字段为 1B，载荷上限 255B
MAX_PAYLOAD_LEN = 255

#: BACKFILL 单条目长度：SEQ u32 + TS_MS u64 + 20B 遥测（协议确认书 2.4）
BACKFILL_ENTRY_LEN = 32

#: 单个 BACKFILL 帧最多可携带的条目数（1B count + n×32B ≤ 255）
MAX_BACKFILL_ENTRIES_PER_FRAME = (MAX_PAYLOAD_LEN - 1) // BACKFILL_ENTRY_LEN

#: 协议确认书 3.5：设备断线期间最多缓存 300 条
MAX_BACKFILL_CACHE = 300

#: 默认固件/硬件版本（与协议确认书 1. 基本信息一致）
DEFAULT_FIRMWARE = "1.4.2"
DEFAULT_HARDWARE = 0x23  # BCD 风格：HW2.3


def _to_i16(value):
    """任意数值 → i16 取值域内的整数（四舍五入并钳位）。"""
    v = int(round(float(value)))
    return max(-32768, min(32767, v))


def _phys_to_i16(value, scale):
    """物理量 → i16 原始值；None 表示传感器缺失，编码为哨兵 0x7FFF。"""
    if value is None:
        return protocol.MISSING_SENTINEL
    return _to_i16(float(value) / scale)


def _fw_bytes(firmware_version):
    """固件版本字符串 'a.b.c' 或三元序列 → 3 字节。"""
    if firmware_version is None:
        return b"\x00\x00\x00"
    if isinstance(firmware_version, str):
        parts = []
        for chunk in firmware_version.split("."):
            try:
                parts.append(int(chunk))
            except ValueError:
                parts.append(0)
    else:
        parts = [int(x) for x in firmware_version]
    parts = (parts + [0, 0, 0])[:3]
    return bytes(p & 0xFF for p in parts)


def encode_frame(frame_type, seq, ts_ms, payload):
    """按 NXP1 v1.0 帧格式封帧。

    帧头 0xAA55 | LEN(1B) | TYPE(1B) | SEQ(4B LE) | TS_MS(8B LE)
    | PAYLOAD | CRC16/CCITT-FALSE(2B, 覆盖 LEN..PAYLOAD) | 帧尾 0x0D0A

    仅允许上行 TYPE；下行/未知 TYPE 一律拒绝（安全边界：平台无写入设备的路径）。
    """
    if frame_type not in UPLINK_TYPES:
        name = DOWNLINK_TYPES.get(frame_type, "UNKNOWN")
        raise ValueError(
            "拒绝编码非上行帧 TYPE=0x%02X (%s)：平台不实现任何向设备写入的路径"
            % (frame_type & 0xFF, name))
    payload = bytes(payload or b"")
    if len(payload) > MAX_PAYLOAD_LEN:
        raise ValueError("payload 超过 1B LEN 上限: %d B" % len(payload))
    body = (bytes([len(payload), frame_type & 0xFF])
            + struct.pack("<I", int(seq) & 0xFFFFFFFF)
            + struct.pack("<Q", int(ts_ms) & 0xFFFFFFFFFFFFFFFF)
            + payload)
    crc = protocol.crc16_ccitt_false(body)
    return protocol.FRAME_HEAD + body + struct.pack("<H", crc) + protocol.FRAME_TAIL


def encode_ident(device_id, seq=0, ts_ms=0, firmware_version=DEFAULT_FIRMWARE,
                 hardware_version=DEFAULT_HARDWARE):
    """IDENT(0x02)：device_id 8B ASCII（超长截断/不足补 0x00）+ fw 3B + hw 1B。"""
    did = str(device_id).encode("ascii", "replace")[:8].ljust(8, b"\x00")
    payload = did + _fw_bytes(firmware_version) + bytes([int(hardware_version) & 0xFF])
    return encode_frame(protocol.TYPE_IDENT, seq, ts_ms, payload)


def encode_heartbeat(battery_pct=100, status=0, seq=0, ts_ms=0,
                     firmware_version=DEFAULT_FIRMWARE):
    """HEARTBEAT(0x01)：battery u8 + status u8 + fw 3B（1s 周期）。"""
    payload = bytes([int(battery_pct) & 0xFF, int(status) & 0xFF]) + _fw_bytes(firmware_version)
    return encode_frame(protocol.TYPE_HEARTBEAT, seq, ts_ms, payload)


def encode_telemetry_payload(pitch_deg=0.0, roll_deg=0.0, ax_mg=0, ay_mg=0, az_mg=0,
                             gx_dps=0.0, gy_dps=0.0, gz_dps=0.0, torque_nm=0.0,
                             assist_pct=0, battery_pct=0):
    """仅生成 TELEMETRY 20B 载荷（BACKFILL 复用同一子结构，协议确认书 2.4）。"""
    return struct.pack(
        "<9h",
        _phys_to_i16(pitch_deg, 0.1), _phys_to_i16(roll_deg, 0.1),
        _phys_to_i16(ax_mg, 1), _phys_to_i16(ay_mg, 1), _phys_to_i16(az_mg, 1),
        _phys_to_i16(gx_dps, 0.1), _phys_to_i16(gy_dps, 0.1), _phys_to_i16(gz_dps, 0.1),
        _phys_to_i16(torque_nm, 0.1),
    ) + bytes([int(assist_pct or 0) & 0xFF, int(battery_pct or 0) & 0xFF])


def encode_telemetry(seq=0, ts_ms=0, **fields):
    """TELEMETRY(0x10)：20B 载荷（协议确认书 2.3），20Hz 周期帧。"""
    return encode_frame(protocol.TYPE_TELEMETRY, seq, ts_ms,
                        encode_telemetry_payload(**fields))


def encode_fault(fault_code, detail=0, seq=0, ts_ms=0):
    """FAULT(0x20)：code u8 + detail u8；code=0x00 表示故障恢复。"""
    return encode_frame(protocol.TYPE_FAULT, seq, ts_ms,
                        bytes([int(fault_code) & 0xFF, int(detail) & 0xFF]))


def encode_backfill(entries, seq=0, ts_ms=0):
    """BACKFILL(0x11)：count u8 + count ×（SEQ u32 + TS_MS u64 + 20B 遥测）。

    entries: [{"seq": int, "ts_ms": int, "telemetry": {遥测字段...}}, ...]
    单帧条目数不得超过 MAX_BACKFILL_ENTRIES_PER_FRAME（7），超出请用 encode_backfill_batch。
    """
    entries = list(entries or [])
    if len(entries) > MAX_BACKFILL_ENTRIES_PER_FRAME:
        raise ValueError("单个 BACKFILL 帧最多 %d 条，实际 %d 条"
                         % (MAX_BACKFILL_ENTRIES_PER_FRAME, len(entries)))
    payload = bytearray([len(entries)])
    for item in entries:
        payload += struct.pack("<I", int(item.get("seq", 0)) & 0xFFFFFFFF)
        payload += struct.pack("<Q", int(item.get("ts_ms", 0)) & 0xFFFFFFFFFFFFFFFF)
        payload += encode_telemetry_payload(**(item.get("telemetry") or {}))
    return encode_frame(protocol.TYPE_BACKFILL, seq, ts_ms, bytes(payload))


def encode_backfill_batch(entries, start_seq=0, ts_ms=0):
    """把任意条数的缓存条目切分为多个 BACKFILL 帧，返回拼接后的字节流。

    条目数超过协议确认书 3.5 约定的 300 条上限时按设备行为截断到最近 300 条。
    每个 BACKFILL 帧自身的 SEQ 从 start_seq 起递增。
    """
    entries = list(entries or [])[-MAX_BACKFILL_CACHE:]
    out = bytearray()
    seq = int(start_seq)
    for i in range(0, len(entries), MAX_BACKFILL_ENTRIES_PER_FRAME):
        chunk = entries[i:i + MAX_BACKFILL_ENTRIES_PER_FRAME]
        out += encode_backfill(chunk, seq=seq, ts_ms=ts_ms)
        seq += 1
    return bytes(out)


def corrupt_crc(frame_bytes, offset=16):
    """把一个合法帧的指定偏移字节取反，使 CRC 失配（坏帧注入自测用）。"""
    data = bytearray(frame_bytes)
    if len(data) <= offset:
        raise ValueError("帧长度 %d 不足以在偏移 %d 处注入错误" % (len(data), offset))
    data[offset] ^= 0xFF
    return bytes(data)


__all__ = [
    "UPLINK_TYPES", "DOWNLINK_TYPES", "FORBIDDEN_WRITE_CAPABILITIES",
    "MAX_BACKFILL_ENTRIES_PER_FRAME", "MAX_BACKFILL_CACHE",
    "encode_frame", "encode_ident", "encode_heartbeat", "encode_telemetry",
    "encode_telemetry_payload", "encode_fault", "encode_backfill",
    "encode_backfill_batch", "corrupt_crc",
]
