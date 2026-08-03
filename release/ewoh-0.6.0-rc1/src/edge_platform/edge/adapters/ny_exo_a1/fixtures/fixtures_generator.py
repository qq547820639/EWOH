#!/usr/bin/env python3
"""NXP1 v1.0 协议测试样例（fixtures）生成器。

用途
----
为 NY-EXO-A1 腰部助力外骨骼适配层与协议解码层生成各类边界/异常测试帧，
用于无真机时的协议解码测试、数据质量处理（Task 10）验证、断线/补传/乱序/
故障码路径自测，以及固件升级前后帧对比。

生成物
------
在脚本所在 fixtures/ 目录下生成：
  - 各类 `<name>.bin` 原始帧文件（单帧或多帧拼接，可直接被 decode_frame 解析）
  - `index.json`：描述每个 fixture 的用途、帧类型、关键字段、设备 ID、协议版本

帧编码遵循《真实设备协议确认书_NY-EXO-A1.md》冻结的 NXP1 v1.0 线协议：
  帧头 0xAA55 | LEN(1B) | TYPE(1B) | SEQ(4B LE) | TS_MS(8B LE) | PAYLOAD(LEN B)
  | CRC16/CCITT-FALSE(2B, 覆盖 LEN..PAYLOAD) | 帧尾 0x0D0A

协议实现来源
------------
优先使用 `edge_platform.edge.protocol`（由适配器任务交付）；若该模块尚未落地
（并行开发阶段），则使用本文件内置的等价回退实现，保证脚本独立可运行。
当正式 protocol.py 上线后，重新运行本生成器即可用真实编码函数刷新 fixtures。

运行
----
  python -m edge_platform.edge.adapters.ny_exo_a1.fixtures.fixtures_generator
  python src/edge_platform/edge/adapters/ny_exo_a1/fixtures/fixtures_generator.py
"""

import json
import os
import struct
import sys
import time


def _find_repo_root():
    """沿 __file__ 向上查找包含 edge_platform 目录的仓库根，便于复用 protocol.py。"""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.isdir(os.path.join(d, "edge_platform")):
            return d
        d = os.path.dirname(d)
    return None


_REPO_ROOT = _find_repo_root()
if _REPO_ROOT and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ---- 协议实现：优先复用 edge/protocol.py，缺失时使用内置回退 -------------------
try:
    from edge_platform.edge.protocol import (  # type: ignore
        PROTOCOL_VERSION,
        decode_frame,
        encode_ident,
        encode_status,
        encode_telemetry,
    )

    _USING_REAL_PROTOCOL = True
except Exception:  # noqa: BLE001 - 任意导入失败均回退到内置实现
    _USING_REAL_PROTOCOL = False
    PROTOCOL_VERSION = "NXP1 v1.0"

    _FRAME_HEAD = b"\xaa\x55"
    _FRAME_TAIL = b"\x0d\x0a"
    TYPE_HEARTBEAT = 0x01
    TYPE_IDENT = 0x02
    TYPE_TELEMETRY = 0x10
    TYPE_BACKFILL = 0x11
    TYPE_FAULT = 0x20
    _MISSING_SENTINEL = 0x7FFF  # i16 缺失/传感器故障哨兵值

    def _crc16_ccitt_false(data):
        crc = 0xFFFF
        for b in data:
            crc ^= b << 8
            for _ in range(8):
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
        return crc

    def _to_i16(v):
        v = int(round(v))
        return max(-32768, min(32767, v))

    def _phys_to_i16(v, scale):
        if v is None:
            return _MISSING_SENTINEL
        return _to_i16(v / scale)

    def encode_frame(frame_type, seq, ts_ms, payload):
        if len(payload) > 255:
            raise ValueError(f"payload 过长，超过 1B LEN 上限: {len(payload)}")
        body = (
            bytes([len(payload), frame_type & 0xFF])
            + struct.pack("<I", seq & 0xFFFFFFFF)
            + struct.pack("<Q", ts_ms & 0xFFFFFFFFFFFFFFFF)
            + payload
        )
        crc = _crc16_ccitt_false(body)
        return _FRAME_HEAD + body + struct.pack("<H", crc) + _FRAME_TAIL

    def encode_ident(device_id, fw, hw, seq, ts_ms):
        # device_id 字段为 8B ASCII：超长截断，不足补 0x00
        did = device_id.encode("ascii", "replace")[:8].ljust(8, b"\x00")
        if isinstance(fw, str):
            parts = [int(x) for x in fw.split(".")]
        else:
            parts = list(fw)
        parts = (parts + [0, 0, 0])[:3]
        return encode_frame(TYPE_IDENT, seq, ts_ms, did + bytes(parts) + bytes([hw & 0xFF]))

    def encode_telemetry(
        pitch_deg=0.0,
        roll_deg=0.0,
        ax_mg=0,
        ay_mg=0,
        az_mg=0,
        gx_dps=0.0,
        gy_dps=0.0,
        gz_dps=0.0,
        torque_nm=0.0,
        assist_pct=0,
        battery_pct=0,
        seq=0,
        ts_ms=0,
    ):
        payload = struct.pack(
            "<9h",
            _phys_to_i16(pitch_deg, 0.1),
            _phys_to_i16(roll_deg, 0.1),
            _to_i16(ax_mg),
            _to_i16(ay_mg),
            _to_i16(az_mg),
            _phys_to_i16(gx_dps, 0.1),
            _phys_to_i16(gy_dps, 0.1),
            _phys_to_i16(gz_dps, 0.1),
            _phys_to_i16(torque_nm, 0.1),
        ) + bytes([int(assist_pct) & 0xFF, int(battery_pct) & 0xFF])
        return encode_frame(TYPE_TELEMETRY, seq, ts_ms, payload)

    def encode_status(fault_code, detail=0, seq=0, ts_ms=0):
        # 状态帧映射为 NXP1 FAULT(0x20)：code=fault_code, detail=detail
        return encode_frame(TYPE_FAULT, seq, ts_ms, bytes([fault_code & 0xFF, detail & 0xFF]))

    def decode_frame(buf):
        """从 buf 起始解析一帧；返回 (frame_dict|None, consumed_bytes)。

        无完整帧返回 (None, 0) 等待更多数据；头部不匹配返回 (None, 1) 跳字节重同步。
        """
        if len(buf) < 2 or buf[0] != 0xAA or buf[1] != 0x55:
            return None, 1
        if len(buf) < 20:
            return None, 0
        length = buf[2]
        total = 20 + length
        if len(buf) < total:
            return None, 0
        frame_type = buf[3]
        seq = struct.unpack_from("<I", buf, 4)[0]
        ts_ms = struct.unpack_from("<Q", buf, 8)[0]
        payload = bytes(buf[16 : 16 + length])
        crc_recv = struct.unpack_from("<H", buf, 16 + length)[0]
        crc_calc = _crc16_ccitt_false(buf[2 : 16 + length])
        tail_ok = buf[total - 2] == 0x0D and buf[total - 1] == 0x0A
        device_id = None
        if frame_type == TYPE_IDENT and length >= 8:
            device_id = payload[0:8].rstrip(b"\x00").decode("ascii", "replace")
        return {
            "type": frame_type,
            "seq": seq,
            "ts_ms": ts_ms,
            "payload": payload,
            "crc_ok": crc_recv == crc_calc,
            "tail_ok": tail_ok,
            "total_len": total,
            "device_id": device_id,
        }, total


TYPE_NAMES = {
    0x01: "HEARTBEAT",
    0x02: "IDENT",
    0x10: "TELEMETRY",
    0x11: "BACKFILL",
    0x20: "FAULT",
}

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_TS = 1756000000000  # 固定基准时间（epoch ms），保证 fixtures 可复现


def _type_label(t):
    return f"0x{t:02X} {TYPE_NAMES.get(t, 'UNKNOWN')}"


def _decode_all(raw):
    """解析拼接帧，返回 frame dict 列表（用于自检）。"""
    out, buf = [], raw
    while buf:
        frame, consumed = decode_frame(buf)
        if consumed == 0 and frame is None:
            break
        if frame is not None:
            out.append(frame)
        buf = buf[consumed:]
    return out


def _build_entry(name, raw, description, fields, device_id="EXO-TEST-001", extra=None):
    frames = _decode_all(raw)
    entry = {
        "name": name,
        "file": name + ".bin",
        "frame_type": _type_label(frames[0]["type"]) if frames else "UNKNOWN",
        "frame_count": len(frames),
        "device_id": device_id,
        "protocol_version": PROTOCOL_VERSION,
        "description": description,
        "fields": fields,
        "bytes_len": len(raw),
        "crc_ok": bool(frames) and all(f["crc_ok"] for f in frames),
    }
    if extra:
        entry.update(extra)
    return entry


def _build_specs():
    """构造 (name, raw_bytes, description, fields, device_id, extra) 列表。"""
    specs = []

    specs.append(
        (
            "ident_normal",
            encode_ident("EXO-TEST-001", "1.2.0", 0x23, seq=1, ts_ms=BASE_TS),
            "正常 IDENT 帧：device_id=EXO-TEST-001, fw=1.2.0, hw=2.3, 协议 NXP1 v1.0。",
            {"device_id": "EXO-TEST-001", "fw": "1.2.0", "hw": "0x23"},
            "EXO-TEST-001",
            {"wire_device_id_note": "NXP1 IDENT device_id 字段为 8B ASCII，超长 ID 在线协议中截断为前 8 字节"},
        )
    )

    specs.append(
        (
            "telemetry_normal",
            encode_telemetry(
                pitch_deg=32.1,
                roll_deg=2.4,
                az_mg=9810,
                gy_dps=18.4,
                torque_nm=18.6,
                assist_pct=45,
                battery_pct=82,
                seq=100,
                ts_ms=BASE_TS,
            ),
            "正常遥测帧：pitch=32.1°, torque=18.6Nm, battery=82%。",
            {"pitch_deg": 32.1, "torque_nm": 18.6, "battery_pct": 82},
        )
    )

    specs.append(
        (
            "telemetry_low_battery",
            encode_telemetry(pitch_deg=30.0, torque_nm=12.0, battery_pct=8, seq=101, ts_ms=BASE_TS + 50),
            "低电量遥测帧：battery=8%（低于安全阈值），用于低电量规则与安全态测试。",
            {"pitch_deg": 30.0, "torque_nm": 12.0, "battery_pct": 8},
        )
    )

    specs.append(
        (
            "telemetry_high_torque",
            encode_telemetry(pitch_deg=25.0, torque_nm=45.0, battery_pct=70, seq=102, ts_ms=BASE_TS + 100),
            "高力矩遥测帧：torque=45.0Nm（接近 ±100Nm 量程上限），用于高负荷规则测试。",
            {"pitch_deg": 25.0, "torque_nm": 45.0, "battery_pct": 70},
        )
    )

    specs.append(
        (
            "telemetry_out_of_range",
            encode_telemetry(pitch_deg=185.0, torque_nm=10.0, battery_pct=80, seq=103, ts_ms=BASE_TS + 150),
            "超量程遥测帧：pitch=185.0°（超出 ±180° 量程），帧线协议合法但应被数据质量层判为 invalid。",
            {"pitch_deg": 185.0, "torque_nm": 10.0, "battery_pct": 80},
        )
    )

    specs.append(
        (
            "telemetry_missing_field",
            encode_telemetry(pitch_deg=30.0, torque_nm=None, battery_pct=80, seq=104, ts_ms=BASE_TS + 200),
            "字段缺失遥测帧：torque=None（传感器故障），载荷中 torque i16 写入哨兵值 0x7FFF 表示缺失。",
            {"pitch_deg": 30.0, "torque_nm": None, "battery_pct": 80, "missing_sentinel": "0x7FFF"},
        )
    )

    specs.append(
        (
            "status_normal",
            encode_status(fault_code=0x00, seq=1, ts_ms=BASE_TS),
            "正常状态帧：fault_code=0x00（无故障），映射为 NXP1 FAULT(0x20) code=0x00。",
            {"fault_code": "0x00"},
        )
    )

    specs.append(
        (
            "status_fault",
            encode_status(fault_code=0x10, seq=2, ts_ms=BASE_TS + 1000),
            "故障码状态帧：fault_code=0x10，映射为 NXP1 FAULT(0x20) code=0x10，用于故障码处理测试。",
            {"fault_code": "0x10"},
        )
    )

    corrupted = bytearray(encode_telemetry(pitch_deg=30.0, torque_nm=15.0, battery_pct=80, seq=200, ts_ms=BASE_TS))
    corrupted[16] ^= 0xFF  # 翻转 PAYLOAD 首字节，使 CRC 失配
    specs.append(
        (
            "corrupted_frame",
            bytes(corrupted),
            "CRC 错误帧：在合法遥测帧基础上翻转 PAYLOAD 一字节，CRC 校验失败，应被解码层拒绝。",
            {"corrupted": True, "flipped_offset": 16},
            "EXO-TEST-001",
            {"crc_ok": False},
        )
    )

    seqs = [100, 101, 115, 116]
    gap_raw = b"".join(
        encode_telemetry(pitch_deg=30.0, torque_nm=12.0, battery_pct=80, seq=s, ts_ms=BASE_TS + i * 50)
        for i, s in enumerate(seqs)
    )
    specs.append(
        (
            "sequence_gap",
            gap_raw,
            "序号跳变帧序列：seq=100,101,115,116（101→115 跳变），用于序号跳变/丢包检测测试。",
            {"seq_list": seqs, "gap": "101->115"},
        )
    )

    return specs


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    specs = _build_specs()
    entries = []
    for spec in specs:
        name, raw, desc, fields = spec[0], spec[1], spec[2], spec[3]
        dev = spec[4] if len(spec) > 4 else "EXO-TEST-001"
        extra = spec[5] if len(spec) > 5 else None
        with open(os.path.join(OUT_DIR, name + ".bin"), "wb") as f:
            f.write(raw)
        entries.append(_build_entry(name, raw, desc, fields, dev, extra))

    index = {
        "protocol_version": PROTOCOL_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "generator": "fixtures_generator.py",
        "using_real_protocol": _USING_REAL_PROTOCOL,
        "frame_format": "NXP1 v1.0: AA55|LEN|TYPE|SEQ(LE)|TS_MS(LE)|PAYLOAD|CRC16/CCITT-FALSE|0D0A",
        "fixtures": entries,
    }
    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    # 自检：逐 fixture 解码并打印状态
    print(f"fixtures 生成目录: {OUT_DIR}")
    print(f"协议来源: {'edge_platform.edge.protocol' if _USING_REAL_PROTOCOL else '内置回退实现'}")
    print(f"协议版本: {PROTOCOL_VERSION}")
    print(f"fixtures 数量: {len(entries)}")
    for e in entries:
        flag = "OK" if e["crc_ok"] else "CRC-FAIL"
        print(
            "  - {:<28} {:<14} frames={} bytes={} [{}]".format(
                e["file"], e["frame_type"], e["frame_count"], e["bytes_len"], flag
            )
        )
    print(f"index.json 条目数: {len(entries)}")


if __name__ == "__main__":
    main()
