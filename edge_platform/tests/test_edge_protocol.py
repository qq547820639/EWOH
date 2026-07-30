"""NXP1 v1.0 协议编解码单元测试。"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge.protocol import (
    encode_ident, encode_telemetry, encode_heartbeat, encode_fault, encode_backfill,
    decode_frame, crc16_ccitt_false, parse_telemetry_payload,
    TYPE_IDENT, TYPE_HEARTBEAT, TYPE_TELEMETRY, TYPE_BACKFILL, TYPE_FAULT,
    PROTOCOL_VERSION, DEVICE_MODEL, FRAME_HEAD, FRAME_TAIL, FAULT_NAMES)

BASE_TS = 1756000000000


class CRCTest(unittest.TestCase):
    def test_ccitt_false_known_vector(self):
        # "123456789" -> 0x29B1 (CCITT-FALSE 标准校验向量)
        self.assertEqual(crc16_ccitt_false(b"123456789"), 0x29B1)

    def test_empty(self):
        self.assertEqual(crc16_ccitt_false(b""), 0xFFFF)


class IdentCodecTest(unittest.TestCase):
    def test_roundtrip(self):
        raw = encode_ident("EXO-A001", "1.4.2", 0x23, seq=7, ts_ms=BASE_TS)
        frame, consumed = decode_frame(raw)
        self.assertIsNotNone(frame)
        self.assertEqual(consumed, len(raw))
        self.assertEqual(frame["type"], TYPE_IDENT)
        self.assertEqual(frame["seq"], 7)
        self.assertEqual(frame["ts_ms"], BASE_TS)
        self.assertTrue(frame["crc_ok"])
        self.assertTrue(frame["tail_ok"])
        self.assertEqual(frame["device_id"], "EXO-A001")
        self.assertEqual(frame["payload"]["firmware_version"], "1.4.2")
        self.assertEqual(frame["payload"]["hardware_version"], 0x23)

    def test_device_id_truncation_and_padding(self):
        # 超长截断（8B ASCII：取前 8 字符）
        raw = encode_ident("EXO-VERY-LONG-ID", "1.0.0", 1, seq=1, ts_ms=1)
        frame, _ = decode_frame(raw)
        self.assertEqual(frame["device_id"], "EXO-VERY")  # 截断到 8B ASCII
        # 不足补 0（解码时 rstrip 0x00 -> 原值）
        raw2 = encode_ident("AB", "1.0.0", 1, seq=1, ts_ms=1)
        frame2, _ = decode_frame(raw2)
        self.assertEqual(frame2["device_id"], "AB")


class TelemetryCodecTest(unittest.TestCase):
    def test_roundtrip(self):
        raw = encode_telemetry(100, BASE_TS, 32.1, 2.4, 0, 0, 9810,
                                1.2, 18.4, 0.6, 18.6, 45, 82)
        frame, consumed = decode_frame(raw)
        self.assertIsNotNone(frame)
        self.assertEqual(consumed, len(raw))
        self.assertEqual(frame["type"], TYPE_TELEMETRY)
        self.assertTrue(frame["crc_ok"])
        t = frame["payload"]
        self.assertAlmostEqual(t["pitch_deg"], 32.1, places=1)
        self.assertAlmostEqual(t["torque_nm"], 18.6, places=1)
        self.assertEqual(t["battery_percent"], 82)
        self.assertAlmostEqual(t["assist_level"], 0.45, places=2)

    def test_missing_field_sentinel(self):
        # torque=None 写入哨兵 0x7FFF，解码后为 None
        raw = encode_telemetry(101, BASE_TS, 30.0, 0.0, 0, 0, 9810,
                                0.0, 0.0, 0.0, None, 50, 80)
        frame, _ = decode_frame(raw)
        self.assertIsNone(frame["payload"]["torque_nm"])
        self.assertIsNotNone(frame["payload"]["pitch_deg"])

    def test_unit_conversion_mg_to_ms2(self):
        # 9810mg -> 9810/1000*9.80665 = 96.2032 m/s²
        payload = encode_telemetry(1, 1, 0, 0, 0, 0, 9810, 0, 0, 0, 0, 0, 80)[16:36]
        parsed = parse_telemetry_payload(payload)
        self.assertAlmostEqual(parsed["acceleration"][2], 96.2032, places=3)

    def test_out_of_range_pitch_preserved(self):
        # pitch=185 编码后仍可解码（线协议合法，质量层负责判 invalid）
        raw = encode_telemetry(102, BASE_TS, 185.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80)
        frame, _ = decode_frame(raw)
        self.assertAlmostEqual(frame["payload"]["pitch_deg"], 185.0, places=1)


class HeartbeatCodecTest(unittest.TestCase):
    def test_roundtrip(self):
        raw = encode_heartbeat(5, BASE_TS, 75, 0, "1.4.2")
        frame, consumed = decode_frame(raw)
        self.assertEqual(frame["type"], TYPE_HEARTBEAT)
        self.assertTrue(frame["crc_ok"])
        self.assertEqual(frame["payload"]["battery_percent"], 75)
        self.assertEqual(frame["payload"]["status"], 0)
        self.assertEqual(frame["payload"]["firmware_version"], "1.4.2")
        self.assertEqual(consumed, len(raw))


class FaultCodecTest(unittest.TestCase):
    def test_roundtrip(self):
        raw = encode_fault(9, BASE_TS, 0x01, 0x00)
        frame, _ = decode_frame(raw)
        self.assertEqual(frame["type"], TYPE_FAULT)
        self.assertTrue(frame["crc_ok"])
        self.assertEqual(frame["payload"]["code"], 0x01)
        self.assertEqual(frame["payload"]["fault_name"], "IMU_FAULT")

    def test_fault_name_mapping(self):
        self.assertEqual(FAULT_NAMES[0x02], "LOW_BATTERY")
        self.assertEqual(FAULT_NAMES[0x03], "OVERTEMP")
        self.assertEqual(FAULT_NAMES[0x04], "COMM_DEGRADED")


class BackfillCodecTest(unittest.TestCase):
    def test_roundtrip(self):
        items = [(200 + i, BASE_TS + i * 50,
                  {"pitch": 30.0, "torque": 12.0, "az": 9810, "battery": 80})
                 for i in range(3)]
        raw = encode_backfill(300, BASE_TS + 1000, items)
        frame, _ = decode_frame(raw)
        self.assertEqual(frame["type"], TYPE_BACKFILL)
        self.assertTrue(frame["crc_ok"])
        payload = frame["payload"]
        self.assertEqual(payload["count"], 3)
        self.assertEqual(len(payload["items"]), 3)
        self.assertEqual(payload["items"][0]["seq"], 200)
        self.assertAlmostEqual(payload["items"][0]["telemetry"]["pitch_deg"], 30.0, places=1)


class DecodeFailureTest(unittest.TestCase):
    def test_crc_failure_returns_frame_with_flag(self):
        raw = bytearray(encode_telemetry(1, BASE_TS, 30.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        raw[16] ^= 0xFF  # 翻转 PAYLOAD 首字节
        frame, consumed = decode_frame(bytes(raw))
        self.assertIsNotNone(frame)
        self.assertFalse(frame["crc_ok"])
        self.assertEqual(consumed, len(raw))  # 仍消费整帧

    def test_header_mismatch_skip_one(self):
        # 非 0xAA55 头 -> (None, 1) 跳 1 字节
        frame, consumed = decode_frame(b"\x00\x01\x02")
        self.assertIsNone(frame)
        self.assertEqual(consumed, 1)

    def test_insufficient_data_wait(self):
        # 头匹配但数据不足 -> (None, 0) 等待
        frame, consumed = decode_frame(b"\xAA\x55\x14\x10")
        self.assertIsNone(frame)
        self.assertEqual(consumed, 0)

    def test_multi_frame_stream(self):
        # 拼接多帧，逐帧解析
        raw = (encode_ident("EXO-A001", "1.0.0", 1, seq=1, ts_ms=BASE_TS)
               + encode_telemetry(2, BASE_TS + 50, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80)
               + encode_fault(3, BASE_TS + 100, 0x01, 0))
        buf = raw
        types = []
        while buf:
            frame, consumed = decode_frame(buf)
            if consumed == 0 and frame is None:
                break
            if frame is not None:
                types.append(frame["type"])
            buf = buf[consumed:]
        self.assertEqual(types, [TYPE_IDENT, TYPE_TELEMETRY, TYPE_FAULT])


if __name__ == "__main__":
    unittest.main()
