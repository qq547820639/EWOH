"""NY-EXO-A1 腰部助力外骨骼 NXP1 v1.0 线协议解码。

协议口径来源：`delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md`（厂商冻结基线），
与 `fixtures/fixtures_generator.py` 的编码实现字节兼容——本模块可直接解码 fixtures/*.bin。

帧格式（全部多字节数值小端）：
    帧头 0xAA55 | LEN(1B) | TYPE(1B) | SEQ(4B u32) | TS_MS(8B u64)
    | PAYLOAD(LEN B) | CRC16/CCITT-FALSE(2B, 覆盖 LEN..PAYLOAD) | 帧尾 0x0D0A

固定开销 20 字节（2 头 + 1 LEN + 1 TYPE + 4 SEQ + 8 TS_MS + 2 CRC + 2 尾），
整帧长度 = 20 + LEN。

本模块只做「线协议 → 厂商原始物理量 dict」，不做统一语义映射；
统一语义转换在 adapter.py 中完成（spec：厂商字段不泄漏到上层业务）。

纯 Python 标准库实现，不引入任何第三方依赖。
"""

import struct

PROTOCOL_VERSION = "NXP1 v1.0"

FRAME_HEAD = b"\xAA\x55"
FRAME_TAIL = b"\x0D\x0A"

#: 帧固定开销（除 PAYLOAD 外的全部字节）
FRAME_OVERHEAD = 20

# ---- 消息类型（协议确认书 2.2） ----
TYPE_HEARTBEAT = 0x01
TYPE_IDENT = 0x02
TYPE_TELEMETRY = 0x10
TYPE_BACKFILL = 0x11
TYPE_FAULT = 0x20

TYPE_NAMES = {
    TYPE_HEARTBEAT: "HEARTBEAT",
    TYPE_IDENT: "IDENT",
    TYPE_TELEMETRY: "TELEMETRY",
    TYPE_BACKFILL: "BACKFILL",
    TYPE_FAULT: "FAULT",
}

#: i16 缺失/传感器故障哨兵值（协议确认书：异常值表示约定）
MISSING_SENTINEL = 0x7FFF

#: TELEMETRY 载荷长度（协议确认书 2.3：9×i16 + assist u8 + battery u8）
TELEMETRY_PAYLOAD_LEN = 20

# ---- 量程（协议确认书 3：超出量程判 invalid，但线协议本身合法） ----
RANGE_PITCH_DEG = (-180.0, 180.0)
RANGE_ROLL_DEG = (-180.0, 180.0)
RANGE_TORQUE_NM = (-100.0, 100.0)
RANGE_BATTERY_PCT = (0, 100)


def crc16_ccitt_false(data):
    """CRC-16/CCITT-FALSE（init=0xFFFF, poly=0x1021, 无反射, 无异或输出）。"""
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


def _i16_to_phys(raw, scale):
    """i16 原始值 → 物理量；哨兵值 0x7FFF 表示缺失，返回 None。"""
    if raw == MISSING_SENTINEL:
        return None
    return round(raw * scale, 4)


def decode_frame(buf):
    """从 buf 起始解析一帧。

    返回 (frame_dict | None, consumed_bytes)：
    - 帧头不匹配 → (None, 1)，调用方跳 1 字节重同步；
    - 数据不足一帧 → (None, 0)，调用方等待更多数据；
    - 解析出帧 → (frame, total_len)，即使 CRC 失败也返回帧（crc_ok=False），
      由上层决定丢弃，便于统计坏帧率。

    frame_dict 字段：type / type_name / seq / ts_ms / payload / crc_ok / tail_ok / total_len。
    """
    if len(buf) < 2:
        return None, 0
    if buf[0] != FRAME_HEAD[0] or buf[1] != FRAME_HEAD[1]:
        return None, 1
    if len(buf) < FRAME_OVERHEAD:
        return None, 0
    length = buf[2]
    total = FRAME_OVERHEAD + length
    if len(buf) < total:
        return None, 0

    frame_type = buf[3]
    seq = struct.unpack_from("<I", buf, 4)[0]
    ts_ms = struct.unpack_from("<Q", buf, 8)[0]
    payload = bytes(buf[16:16 + length])
    crc_recv = struct.unpack_from("<H", buf, 16 + length)[0]
    crc_calc = crc16_ccitt_false(bytes(buf[2:16 + length]))

    return {
        "type": frame_type,
        "type_name": TYPE_NAMES.get(frame_type, "UNKNOWN"),
        "seq": seq,
        "ts_ms": ts_ms,
        "payload": payload,
        "crc_ok": crc_recv == crc_calc,
        "tail_ok": buf[total - 2] == FRAME_TAIL[0] and buf[total - 1] == FRAME_TAIL[1],
        "total_len": total,
    }, total


def decode_stream(raw, drop_bad_crc=True):
    """解析拼接的多帧字节流，返回帧 dict 列表。

    drop_bad_crc=True 时丢弃 CRC 校验失败的帧（spec：坏帧不得进入上层）。
    无法重同步或数据耗尽时结束。
    """
    frames = []
    buf = memoryview(bytes(raw))
    while len(buf) > 0:
        frame, consumed = decode_frame(buf)
        if consumed == 0:
            break  # 数据不足一帧，等待更多数据
        if frame is not None and not (drop_bad_crc and not frame["crc_ok"]):
            frames.append(frame)
        buf = buf[consumed:]
    return frames


def parse_ident_payload(payload):
    """解析 IDENT(0x02) 载荷：device_id 8B ASCII + fw 3B + hw 1B。

    device_id 为 8 字节 ASCII，右侧 0x00 填充；线协议对超长 ID 截断为前 8 字节。
    """
    if len(payload) < 8:
        raise ValueError(f"IDENT 载荷过短: {len(payload)} B（至少 8B）")
    device_id = payload[0:8].rstrip(b"\x00").decode("ascii", "replace")
    out = {"device_id": device_id, "firmware_version": None, "hardware_version": None}
    if len(payload) >= 11:
        out["firmware_version"] = f"{payload[8]}.{payload[9]}.{payload[10]}"
    if len(payload) >= 12:
        # hw 1B 为 BCD 风格编码：0x23 表示 HW2.3
        out["hardware_version"] = f"{payload[11] >> 4}.{payload[11] & 0x0F}"
    return out


def parse_telemetry_payload(payload):
    """解析 TELEMETRY(0x10) 载荷（20B，协议确认书 2.3），返回厂商原始物理量 dict。

    偏移/缩放：pitch,roll i16×0.1°；ax,ay,az i16×1 mg；gx,gy,gz i16×0.1 dps；
    torque i16×0.1 Nm；assist u8 %；battery u8 %。
    i16 字段为 0x7FFF 时表示传感器缺失，对应值为 None。
    """
    if len(payload) < TELEMETRY_PAYLOAD_LEN:
        raise ValueError(f"TELEMETRY 载荷过短: {len(payload)} B（需 {TELEMETRY_PAYLOAD_LEN} B）")
    pitch, roll, ax, ay, az, gx, gy, gz, torque = struct.unpack_from("<9h", payload, 0)
    assist_pct, battery_pct = payload[18], payload[19]
    return {
        "pitch_deg": _i16_to_phys(pitch, 0.1),
        "roll_deg": _i16_to_phys(roll, 0.1),
        "accel_mg": [_i16_to_phys(ax, 1), _i16_to_phys(ay, 1), _i16_to_phys(az, 1)],
        "gyro_dps": [_i16_to_phys(gx, 0.1), _i16_to_phys(gy, 0.1), _i16_to_phys(gz, 0.1)],
        "torque_nm": _i16_to_phys(torque, 0.1),
        "assist_pct": assist_pct,
        "battery_pct": battery_pct,
    }


def parse_fault_payload(payload):
    """解析 FAULT(0x20) 载荷：code u8 + detail u8。code=0x00 表示无故障。"""
    if len(payload) < 1:
        raise ValueError(f"FAULT 载荷过短: {len(payload)} B（至少 1B）")
    code = payload[0]
    return {
        "fault_code": code,
        "fault_detail": payload[1] if len(payload) >= 2 else 0,
        "faulted": code != 0x00,
    }


def parse_heartbeat_payload(payload):
    """解析 HEARTBEAT(0x01) 载荷：battery u8 + status u8 + fw 3B。"""
    if len(payload) < 2:
        raise ValueError(f"HEARTBEAT 载荷过短: {len(payload)} B（至少 2B）")
    out = {"battery_pct": payload[0], "status": payload[1], "firmware_version": None}
    if len(payload) >= 5:
        out["firmware_version"] = f"{payload[2]}.{payload[3]}.{payload[4]}"
    return out


def parse_backfill_payload(payload):
    """解析 BACKFILL(0x11) 载荷：count u8 + count ×（SEQ u32 + TS_MS u64 + 20B 遥测）。

    返回补传条目列表 [{seq, ts_ms, telemetry}, ...]；每条 32B。
    """
    if len(payload) < 1:
        raise ValueError(f"BACKFILL 载荷过短: {len(payload)} B（至少 1B）")
    count = payload[0]
    entries = []
    offset = 1
    for _ in range(count):
        if offset + 32 > len(payload):
            break  # 载荷截断，返回已解析部分
        seq = struct.unpack_from("<I", payload, offset)[0]
        ts_ms = struct.unpack_from("<Q", payload, offset + 4)[0]
        entries.append({
            "seq": seq,
            "ts_ms": ts_ms,
            "telemetry": parse_telemetry_payload(payload[offset + 12:offset + 32]),
        })
        offset += 32
    return entries


def parse_payload(frame):
    """按帧类型分派载荷解析；未知类型返回 {}。"""
    parsers = {
        TYPE_IDENT: parse_ident_payload,
        TYPE_TELEMETRY: parse_telemetry_payload,
        TYPE_FAULT: parse_fault_payload,
        TYPE_HEARTBEAT: parse_heartbeat_payload,
        TYPE_BACKFILL: parse_backfill_payload,
    }
    parser = parsers.get(frame["type"])
    return parser(frame["payload"]) if parser else {}


def in_range(value, bounds):
    """量程校验：value 为 None（缺失）视为不越界，交由数据质量层按缺失处理。"""
    if value is None:
        return True
    return bounds[0] <= value <= bounds[1]
