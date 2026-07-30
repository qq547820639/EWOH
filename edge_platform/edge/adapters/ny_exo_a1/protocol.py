"""NXP1 v1.0 线协议编解码（NY-EXO-A1 腰部助力外骨骼）。

纯标准库实现（struct + 自实现 CRC-16/CCITT-FALSE），不引入第三方依赖。

帧格式（小端字节序）：
  0xAA55 | LEN(1B) | TYPE(1B) | SEQ(4B LE) | TS_MS(8B LE) | PAYLOAD(LEN B)
  | CRC16/CCITT-FALSE(2B, 覆盖 LEN..PAYLOAD) | 0x0D0A

消息类型（TYPE）：
  0x02 IDENT     设备→平台  device_id(8B ASCII) + fw(3B) + hw(1B)
  0x01 HEARTBEAT 设备→平台  battery(u8) + status(u8) + fw(3B)
  0x10 TELEMETRY 设备→平台  20B（pitch/roll/ax/ay/az/gx/gy/gz/torque i16 + assist/battery u8）
  0x11 BACKFILL  设备→平台  count(u8) + count×32B（SEQ+TS_MS+20B 遥测）
  0x20 FAULT     设备→平台  code(u8) + detail(u8)
  0x81 IDENT_REQUEST 平台→设备（白名单，本阶段不实现发送）
  0x82 TIME_SYNC     平台→设备（白名单，本阶段不实现发送）

安全边界：本模块仅实现解码与受控编码（用于测试/注入），不实现任何
平台→设备业务命令发送。
"""
import struct

# ---- 帧定界 ----
FRAME_HEAD = b"\xAA\x55"
FRAME_TAIL = b"\x0D\x0A"

# ---- 消息类型 ----
TYPE_IDENT = 0x02
TYPE_HEARTBEAT = 0x01
TYPE_TELEMETRY = 0x10
TYPE_BACKFILL = 0x11
TYPE_FAULT = 0x20

# 平台侧允许发送的白名单命令（本阶段不实现发送，仅声明安全边界）
TYPE_IDENT_REQUEST = 0x81
TYPE_TIME_SYNC = 0x82

PROTOCOL_VERSION = "NXP1-1.0"
DEVICE_MODEL = "NY-EXO-A1"

# 帧定长字段总长（HEAD 2 + LEN 1 + TYPE 1 + SEQ 4 + TS_MS 8 + CRC 2 + TAIL 2 = 20）
_FRAME_FIXED_LEN = 20
_TELEMETRY_PAYLOAD_LEN = 20
_IDENT_PAYLOAD_LEN = 12        # 8B device_id + 3B fw + 1B hw
_HEARTBEAT_PAYLOAD_LEN = 5     # 1B battery + 1B status + 3B fw
_FAULT_PAYLOAD_LEN = 2        # 1B code + 1B detail
_BACKFILL_ITEM_LEN = 32        # SEQ(4) + TS_MS(8) + 20B 遥测

# 物理量量程（用于解码后越界判断）
PITCH_RANGE = 180.0
ROLL_RANGE = 180.0
ACCEL_RANGE_MG = 16000
GYRO_RANGE_DPS = 2000
TORQUE_RANGE_NM = 100

# i16 缺失哨兵（传感器故障时设备写入该值表示无数据）
_MISSING_SENTINEL = 0x7FFF

# 故障码 -> 名称映射（来自协议确认书 2.5）
FAULT_NAMES = {
    0x00: "NO_FAULT",
    0x01: "IMU_FAULT",
    0x02: "LOW_BATTERY",
    0x03: "OVERTEMP",
    0x04: "COMM_DEGRADED",
}


def crc16_ccitt_false(data):
    """CRC-16/CCITT-FALSE：init=0xFFFF, poly=0x1021, 无输入/输出反射, xor_out=0。

    覆盖字段：LEN..PAYLOAD（不含帧头与帧尾）。
    """
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def _to_i16(v):
    """将数值截断/钳位到 i16 范围 [-32768, 32767]。"""
    v = int(round(v))
    return max(-32768, min(32767, v))


def _phys_to_i16(v, scale):
    """物理量 -> i16（None 表示传感器缺失，写入哨兵 0x7FFF）。"""
    if v is None:
        return _MISSING_SENTINEL
    return _to_i16(v / scale)


def _encode_frame(frame_type, seq, ts_ms, payload):
    """组装完整帧：HEAD | LEN | TYPE | SEQ | TS_MS | PAYLOAD | CRC | TAIL。"""
    if len(payload) > 255:
        raise ValueError("payload 过长，超过 1B LEN 上限: %d" % len(payload))
    body = (bytes([len(payload), frame_type & 0xFF])
            + struct.pack("<I", int(seq) & 0xFFFFFFFF)
            + struct.pack("<Q", int(ts_ms) & 0xFFFFFFFFFFFFFFFF)
            + payload)
    crc = crc16_ccitt_false(body)
    return FRAME_HEAD + body + struct.pack("<H", crc) + FRAME_TAIL


def _encode_device_id(device_id):
    """device_id -> 8B ASCII（超长截断，不足补 0x00）。"""
    return device_id.encode("ascii", "replace")[:8].ljust(8, b"\x00")


def _encode_firmware(fw):
    """固件版本 -> 3B（"1.4.2" -> [1,4,2]）。"""
    if isinstance(fw, str):
        parts = [int(x) for x in fw.split(".")]
    else:
        parts = list(fw)
    parts = (parts + [0, 0, 0])[:3]
    return bytes(parts)


def encode_ident(device_id, fw, hw, seq=0, ts_ms=0):
    """编码 IDENT 帧。

    device_id: 设备 ID（截断/补 0 到 8B ASCII）
    fw: 固件版本字符串（如 "1.4.2"）或 3 元组
    hw: 硬件版本（1B）
    seq/ts_ms: 帧序号与设备时间戳（默认 0）
    """
    payload = _encode_device_id(device_id) + _encode_firmware(fw) + bytes([int(hw) & 0xFF])
    return _encode_frame(TYPE_IDENT, seq, ts_ms, payload)


def encode_telemetry(seq, ts_ms, pitch, roll, ax, ay, az, gx, gy, gz, torque, assist, battery):
    """编码 TELEMETRY 帧（20B 载荷）。

    所有物理量使用平台单位：pitch/roll(°), ax/ay/az(mg), gx/gy/gz(dps),
    torque(Nm), assist/battery(%)。None 表示传感器缺失（写入哨兵值）。
    """
    payload = struct.pack(
        "<9h",
        _phys_to_i16(pitch, 0.1), _phys_to_i16(roll, 0.1),
        _to_i16(ax) if ax is not None else _MISSING_SENTINEL,
        _to_i16(ay) if ay is not None else _MISSING_SENTINEL,
        _to_i16(az) if az is not None else _MISSING_SENTINEL,
        _phys_to_i16(gx, 0.1), _phys_to_i16(gy, 0.1), _phys_to_i16(gz, 0.1),
        _phys_to_i16(torque, 0.1),
    ) + bytes([int(round(assist)) & 0xFF, int(round(battery)) & 0xFF])
    return _encode_frame(TYPE_TELEMETRY, seq, ts_ms, payload)


def encode_heartbeat(seq, ts_ms, battery, status, fw):
    """编码 HEARTBEAT 帧（battery u8 + status u8 + fw 3B）。"""
    payload = bytes([int(round(battery)) & 0xFF, int(status) & 0xFF]) + _encode_firmware(fw)
    return _encode_frame(TYPE_HEARTBEAT, seq, ts_ms, payload)


def encode_fault(seq, ts_ms, code, detail):
    """编码 FAULT 帧（code u8 + detail u8）。"""
    payload = bytes([int(code) & 0xFF, int(detail) & 0xFF])
    return _encode_frame(TYPE_FAULT, seq, ts_ms, payload)


def _telemetry_dict_to_bytes(tele):
    """telemetry dict -> 20B（用于 BACKFILL 子项编码）。

    tele 支持键：pitch/roll(°), ax/ay/az(mg), gx/gy/gz(dps), torque(Nm), assist/battery(%)。
    """
    return struct.pack(
        "<9h",
        _phys_to_i16(tele.get("pitch", 0.0), 0.1),
        _phys_to_i16(tele.get("roll", 0.0), 0.1),
        _to_i16(tele.get("ax", 0)) if tele.get("ax") is not None else _MISSING_SENTINEL,
        _to_i16(tele.get("ay", 0)) if tele.get("ay") is not None else _MISSING_SENTINEL,
        _to_i16(tele.get("az", 0)) if tele.get("az") is not None else _MISSING_SENTINEL,
        _phys_to_i16(tele.get("gx", 0.0), 0.1),
        _phys_to_i16(tele.get("gy", 0.0), 0.1),
        _phys_to_i16(tele.get("gz", 0.0), 0.1),
        _phys_to_i16(tele.get("torque", 0.0), 0.1),
    ) + bytes([int(round(tele.get("assist", 0))) & 0xFF,
               int(round(tele.get("battery", 0))) & 0xFF])


def encode_backfill(seq, ts_ms, items):
    """编码 BACKFILL 帧。

    items: list of (item_seq, item_ts_ms, tele_dict)，tele_dict 含 11 个物理量字段。
    count 上限 255。
    """
    count = min(len(items), 255)
    payload = bytes([count])
    for i in range(count):
        item_seq, item_ts, tele = items[i]
        payload += struct.pack("<I", int(item_seq) & 0xFFFFFFFF)
        payload += struct.pack("<Q", int(item_ts) & 0xFFFFFFFFFFFFFFFF)
        payload += _telemetry_dict_to_bytes(tele)
    return _encode_frame(TYPE_BACKFILL, seq, ts_ms, payload)


def parse_telemetry_payload(payload):
    """解析 TELEMETRY 20B 载荷 -> 物理量 dict（平台单位）。

    缺失哨兵 0x7FFF -> None。mg -> m/s² 用 /1000*9.80665。assist_level=assist/100。
    """
    if len(payload) < _TELEMETRY_PAYLOAD_LEN:
        return None
    (pitch_i, roll_i, ax_i, ay_i, az_i,
     gx_i, gy_i, gz_i, torque_i) = struct.unpack_from("<9h", payload, 0)
    assist = payload[18]
    battery = payload[19]

    def _i16_to_phys(v, scale):
        return None if v == _MISSING_SENTINEL else round(v * scale, 4)

    pitch = _i16_to_phys(pitch_i, 0.1)
    roll = _i16_to_phys(roll_i, 0.1)
    ax = None if ax_i == _MISSING_SENTINEL else ax_i
    ay = None if ay_i == _MISSING_SENTINEL else ay_i
    az = None if az_i == _MISSING_SENTINEL else az_i
    gx = _i16_to_phys(gx_i, 0.1)
    gy = _i16_to_phys(gy_i, 0.1)
    gz = _i16_to_phys(gz_i, 0.1)
    torque = _i16_to_phys(torque_i, 0.1)

    def _mg_to_ms2(mg):
        return None if mg is None else round(mg / 1000.0 * 9.80665, 4)

    return {
        "pitch_deg": pitch,
        "roll_deg": roll,
        "ax_mg": ax, "ay_mg": ay, "az_mg": az,
        "acceleration": [_mg_to_ms2(ax), _mg_to_ms2(ay), _mg_to_ms2(az)],
        "gx_dps": gx, "gy_dps": gy, "gz_dps": gz,
        "angular_velocity": [gx, gy, gz],
        "torque_nm": torque,
        "assist_level": round(assist / 100.0, 3),
        "assist_pct": assist,
        "battery_percent": battery,
    }


def _parse_ident_payload(payload):
    if len(payload) < _IDENT_PAYLOAD_LEN:
        return None
    device_id = payload[0:8].rstrip(b"\x00").decode("ascii", "replace")
    fw_parts = list(payload[8:11])
    firmware_version = "%d.%d.%d" % (fw_parts[0], fw_parts[1], fw_parts[2])
    hardware_version = payload[11]
    return {"device_id": device_id, "firmware_version": firmware_version,
            "hardware_version": hardware_version}


def _parse_heartbeat_payload(payload):
    if len(payload) < _HEARTBEAT_PAYLOAD_LEN:
        return None
    battery = payload[0]
    status = payload[1]
    fw_parts = list(payload[2:5])
    firmware_version = "%d.%d.%d" % (fw_parts[0], fw_parts[1], fw_parts[2])
    return {"battery_percent": battery, "status": status,
            "firmware_version": firmware_version}


def _parse_fault_payload(payload):
    if len(payload) < _FAULT_PAYLOAD_LEN:
        return None
    code = payload[0]
    detail = payload[1]
    return {"code": code, "detail": detail, "fault_name": FAULT_NAMES.get(code, "UNKNOWN")}


def _parse_backfill_payload(payload):
    if len(payload) < 1:
        return None
    count = payload[0]
    items = []
    offset = 1
    for _ in range(count):
        if offset + _BACKFILL_ITEM_LEN > len(payload):
            break
        item_seq = struct.unpack_from("<I", payload, offset)[0]
        item_ts = struct.unpack_from("<Q", payload, offset + 4)[0]
        tele_bytes = payload[offset + 12:offset + 12 + _TELEMETRY_PAYLOAD_LEN]
        items.append({"seq": item_seq, "ts_ms": item_ts,
                      "telemetry": parse_telemetry_payload(tele_bytes)})
        offset += _BACKFILL_ITEM_LEN
    return {"count": count, "items": items}


_PAYLOAD_PARSERS = {
    TYPE_IDENT: _parse_ident_payload,
    TYPE_HEARTBEAT: _parse_heartbeat_payload,
    TYPE_TELEMETRY: parse_telemetry_payload,
    TYPE_BACKFILL: _parse_backfill_payload,
    TYPE_FAULT: _parse_fault_payload,
}


def decode_frame(buf):
    """从 buf 开头尝试解析一帧。

    返回 (frame_dict|None, consumed:int)：
      - 头部不匹配 -> (None, 1) 跳 1 字节重同步
      - 数据不足 -> (None, 0) 等待更多数据
      - CRC/帧尾失败 -> 返回 frame（crc_ok=False / tail_ok=False），consumed=total
        （保留原始字节供上层审计，上层应按 crc_ok 过滤）
      - 成功 -> 返回 frame（payload 已按 TYPE 解析为 dict），consumed=total

    frame_dict 含：type/seq/ts_ms/payload(dict)/payload_raw(bytes)/raw(bytes)/
    crc_ok/tail_ok/total_len/device_id(仅 IDENT)。
    """
    if len(buf) == 0:
        return None, 0  # 空，等待更多数据
    # 首字节非 0xAA -> 跳 1 字节重同步
    if buf[0] != 0xAA:
        return None, 1
    # 可能是帧头起始，但数据不足 -> 等待更多
    if len(buf) < 2 or buf[1] != 0x55:
        return None, 1 if (len(buf) >= 2 and buf[1] != 0x55) else 0
    if len(buf) < _FRAME_FIXED_LEN:
        return None, 0
    length = buf[2]
    total = _FRAME_FIXED_LEN + length
    if len(buf) < total:
        return None, 0
    frame_type = buf[3]
    seq = struct.unpack_from("<I", buf, 4)[0]
    ts_ms = struct.unpack_from("<Q", buf, 8)[0]
    payload_raw = bytes(buf[16:16 + length])
    crc_recv = struct.unpack_from("<H", buf, 16 + length)[0]
    crc_calc = crc16_ccitt_false(buf[2:16 + length])
    tail_ok = buf[total - 2] == 0x0D and buf[total - 1] == 0x0A
    crc_ok = (crc_recv == crc_calc)
    raw = bytes(buf[:total])

    payload = None
    device_id = None
    if crc_ok and tail_ok:
        parser = _PAYLOAD_PARSERS.get(frame_type)
        if parser:
            payload = parser(payload_raw)
            if frame_type == TYPE_IDENT and payload:
                device_id = payload.get("device_id")
        else:
            payload = {"raw": payload_raw}

    return {
        "type": frame_type, "seq": seq, "ts_ms": ts_ms,
        "payload": payload, "payload_raw": payload_raw,
        "raw": raw, "crc_ok": crc_ok, "tail_ok": tail_ok,
        "total_len": total, "device_id": device_id,
    }, total
