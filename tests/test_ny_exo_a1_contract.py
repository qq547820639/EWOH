"""NY-EXO-A1 适配器契约测试（Track B 离线部分）。

校验「NXP1 v1.0 原始帧 → 统一语义模型」这条链路符合契约：
- 协议口径：delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md
- 统一语义：src/edge_platform/edge/exo_semantic.py（spec 5.2）
- 数据字典：docs/data/multimodal_schema.md

数据来源为仓库中**已存在**的 fixtures（src/edge_platform/edge/adapters/ny_exo_a1/fixtures/），
不新造假数据；每条断言的期望值取自 fixtures/index.json 的声明字段，因此 fixtures 与
断言不会各自漂移。

真机到位后：把 `_load_fixture` 换成真实设备回放字节流（scripts/record_raw_frames.py 录制的
会话）即可复用全部断言，无需改动测试逻辑。

仅依赖 Python 标准库 + pytest，可离线运行。
"""

import json
import sys
import unittest
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.edge.adapters.ny_exo_a1 import protocol  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.adapter import (  # noqa: E402
    VENDOR_TO_UNIFIED,
    NyExoA1Adapter,
    frames_from_bytes,
)
from edge_platform.edge.exo_semantic import UnifiedExoFrame, to_storage_dict  # noqa: E402

FIXTURE_DIR = SRC / "edge_platform" / "edge" / "adapters" / "ny_exo_a1" / "fixtures"

#: spec 5.2 统一语义帧必备顶层字段 + spec「标准消息扩展」6 个扩展字段
REQUIRED_TOP_FIELDS = (
    "entity_id", "worker_id", "event_time", "source_type",
    "pose", "load", "device", "quality",
    # 标准消息扩展字段（spec「标准消息扩展与数据质量」）
    "record_id", "ingested_at", "device_model",
    "firmware_version", "protocol_version", "raw_ref",
)

#: 各分组必备子字段（与 exo_semantic.UnifiedExoFrame 默认值保持一致）
REQUIRED_GROUP_FIELDS = {
    "pose": ("trunk_pitch_deg", "angular_velocity_dps", "joint_angles_deg"),
    "load": ("assist_level", "torque_nm", "cumulative_load_score"),
    "device": ("battery_pct", "temperature_c", "fault_code", "health"),
    # quality.status 统一为 good/degraded/invalid/unknown（spec「标准消息扩展与数据质量」）
    "quality": ("packet_loss_pct", "confidence", "status"),
}

#: spec：来源隔离枚举
VALID_SOURCE_TYPES = ("real", "controlled_test", "simulated")


def _load_index():
    with open(FIXTURE_DIR / "index.json", encoding="utf-8") as f:
        return json.load(f)


def _load_fixture(name):
    """读取 fixture 原始字节流。真机接入后此处换成真实录制会话即可。"""
    return (FIXTURE_DIR / name).read_bytes()


def _entries_by_name():
    return {e["name"]: e for e in _load_index()["fixtures"]}


class TestFixtureIntegrity(unittest.TestCase):
    """fixtures 自身完整性：文件存在、字节数与 CRC 状态与 index.json 声明一致。"""

    def setUp(self):
        self.index = _load_index()

    def test_index_declares_frozen_protocol_version(self):
        self.assertEqual(self.index["protocol_version"], protocol.PROTOCOL_VERSION)

    def test_every_declared_fixture_exists_and_matches_index(self):
        self.assertTrue(self.index["fixtures"], "index.json 未声明任何 fixture")
        for entry in self.index["fixtures"]:
            with self.subTest(fixture=entry["name"]):
                raw = _load_fixture(entry["file"])
                self.assertEqual(len(raw), entry["bytes_len"],
                                 "字节数与 index.json 声明不符")
                frames = protocol.decode_stream(raw, drop_bad_crc=False)
                self.assertEqual(len(frames), entry["frame_count"],
                                 "解码帧数与 index.json 声明不符")
                self.assertEqual(all(f["crc_ok"] for f in frames), entry["crc_ok"],
                                 "CRC 校验结果与 index.json 声明不符")
                for f in frames:
                    self.assertTrue(f["tail_ok"], "帧尾 0x0D0A 校验失败")


class TestUnifiedSemanticContract(unittest.TestCase):
    """契约 (a)(b)：适配器解析 fixture 并产出字段齐全的统一语义对象。"""

    #: 能产出遥测统一帧的 fixture（IDENT/FAULT 为状态帧，不产出遥测帧）
    TELEMETRY_FIXTURES = (
        "telemetry_normal", "telemetry_low_battery", "telemetry_high_torque",
        "telemetry_out_of_range", "telemetry_missing_field", "sequence_gap",
    )

    def setUp(self):
        self.entries = _entries_by_name()

    def _frames_for(self, name):
        entry = self.entries[name]
        return frames_from_bytes(_load_fixture(entry["file"]),
                                 device_id=entry["device_id"], worker_id="P-TEST-001")

    def test_adapter_produces_unified_exo_frame_objects(self):
        for name in self.TELEMETRY_FIXTURES:
            with self.subTest(fixture=name):
                frames = self._frames_for(name)
                self.assertTrue(frames, "未产出任何统一语义帧")
                for frame in frames:
                    self.assertIsInstance(frame, UnifiedExoFrame)

    def test_required_top_level_fields_present(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                d = to_storage_dict(frame)
                with self.subTest(fixture=name):
                    for key in REQUIRED_TOP_FIELDS:
                        self.assertIn(key, d, f"缺少 spec 5.2 必备字段 {key}")

    def test_required_group_subfields_present(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                d = to_storage_dict(frame)
                for group, subfields in REQUIRED_GROUP_FIELDS.items():
                    with self.subTest(fixture=name, group=group):
                        self.assertIsInstance(d[group], dict)
                        for sub in subfields:
                            self.assertIn(sub, d[group],
                                          f"{group} 缺少必备子字段 {sub}")

    def test_entity_id_matches_fixture_device_id(self):
        for name in self.TELEMETRY_FIXTURES:
            entry = self.entries[name]
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertEqual(frame.entity_id, entry["device_id"])

    def test_vendor_private_fields_do_not_leak(self):
        """spec：厂商私有字段不得出现在统一帧中（只允许映射表中的统一路径）。"""
        allowed_top = set(REQUIRED_TOP_FIELDS)
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                d = to_storage_dict(frame)
                with self.subTest(fixture=name):
                    self.assertEqual(set(d) - allowed_top, set(),
                                     "统一帧出现了非契约顶层字段")
                    for vendor_key in ("pitch_deg", "assist_pct", "gyro_dps",
                                       "accel_mg", "roll_deg", "seq", "ts_ms"):
                        self.assertNotIn(vendor_key, d,
                                         f"厂商原始字段 {vendor_key} 泄漏到统一帧")

    def test_mapping_table_targets_are_valid_unified_paths(self):
        """映射表的每个目标路径都必须是统一语义模型中真实存在的字段。"""
        probe = UnifiedExoFrame(entity_id="probe")
        for vendor_key, path in VENDOR_TO_UNIFIED.items():
            with self.subTest(vendor_field=vendor_key):
                if "." in path:
                    group, sub = path.split(".", 1)
                    self.assertIn(group, ("pose", "load", "device", "quality"))
                    self.assertIsInstance(getattr(probe, group), dict)
                else:
                    self.assertIn(path, REQUIRED_TOP_FIELDS)


class TestStandardMessageFields(unittest.TestCase):
    """契约 (spec「标准消息扩展与数据质量」)：6 个标准消息扩展字段齐全且语义正确。

    record_id / ingested_at / device_model / firmware_version / protocol_version / raw_ref
    必须在每条统一帧上出现，且取值符合契约：
    - record_id 全局唯一非空
    - ingested_at 可被 datetime.fromisoformat 解析且带时区（平台接收时刻）
    - device_model / protocol_version 非空（适配器已知值）
    - raw_ref 为 64 位 hex（SHA256）
    - quality.status 落在 {good, degraded, invalid, unknown}
    """

    TELEMETRY_FIXTURES = (
        "telemetry_normal", "telemetry_low_battery", "telemetry_high_torque",
        "telemetry_out_of_range", "telemetry_missing_field", "sequence_gap",
    )

    #: spec「标准消息扩展与数据质量」质量状态枚举
    VALID_QUALITY_STATUSES = ("good", "degraded", "invalid", "unknown")

    def setUp(self):
        self.entries = _entries_by_name()

    def _frames_for(self, name):
        entry = self.entries[name]
        return frames_from_bytes(_load_fixture(entry["file"]),
                                 device_id=entry["device_id"], worker_id="P-TEST-001")

    def test_record_id_is_non_empty_and_unique_per_frame(self):
        for name in self.TELEMETRY_FIXTURES:
            frames = self._frames_for(name)
            with self.subTest(fixture=name):
                ids = [f.record_id for f in frames]
                self.assertTrue(all(ids), "record_id 不得为空")
                # 同一 fixture 内多帧的 record_id 必须互异
                self.assertEqual(len(ids), len(set(ids)),
                                 "同一 fixture 内 record_id 必须唯一")

    def test_record_id_has_rec_prefix(self):
        """record_id 应带 REC- 前缀（new_id 约定），便于运维辨识。"""
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertTrue(frame.record_id.startswith("REC-"),
                                    f"record_id 应以 REC- 开头，实际: {frame.record_id}")

    def test_ingested_at_parses_with_fromisoformat(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    parsed = datetime.fromisoformat(frame.ingested_at)
                    self.assertIsNotNone(parsed.tzinfo,
                                         "ingested_at 必须带时区偏移，不得为 naive")

    def test_ingested_at_differs_from_event_time_semantically(self):
        """ingested_at（平台接收时刻，UTC ISO）与 event_time（设备产生时刻，本地时区）是不同语义。"""
        for frame in self._frames_for("telemetry_normal"):
            self.assertNotEqual(frame.ingested_at, frame.event_time,
                                "ingested_at 与 event_time 不应完全相同（一个是接收时刻，一个是设备时刻）")

    def test_device_model_is_populated(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertEqual(frame.device_model, "NY-EXO-A1")

    def test_protocol_version_is_populated(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertEqual(frame.protocol_version, protocol.PROTOCOL_VERSION)

    def test_raw_ref_is_sha256_hex(self):
        """raw_ref 必须是 64 位小写 hex（SHA256 输出）。"""
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertEqual(len(frame.raw_ref), 64,
                                     f"raw_ref 应为 64 位 hex，实际长度: {len(frame.raw_ref)}")
                    self.assertTrue(all(c in "0123456789abcdef" for c in frame.raw_ref),
                                    "raw_ref 必须为小写 hex 字符")

    def test_raw_ref_stable_for_same_fixture_bytes(self):
        """同一 fixture 两次回放，相同帧字节的 raw_ref 必须一致（内容寻址）。"""
        entry = self.entries["telemetry_normal"]
        raw = _load_fixture(entry["file"])
        first = frames_from_bytes(raw, device_id=entry["device_id"])[0]
        second = frames_from_bytes(raw, device_id=entry["device_id"])[0]
        self.assertEqual(first.raw_ref, second.raw_ref,
                         "相同原始帧字节的 raw_ref 必须一致")

    def test_quality_status_in_valid_enum(self):
        for name in self.TELEMETRY_FIXTURES:
            for frame in self._frames_for(name):
                with self.subTest(fixture=name):
                    self.assertIn(frame.quality["status"], self.VALID_QUALITY_STATUSES,
                                  f"quality.status 必须落在 good/degraded/invalid/unknown，"
                                  f"实际: {frame.quality['status']}")

    def test_standard_fields_survive_round_trip(self):
        """标准消息扩展字段经 to_storage_dict / from_storage_dict 往返后保持一致。"""
        from edge_platform.edge.exo_semantic import from_storage_dict
        entry = self.entries["telemetry_normal"]
        frame = frames_from_bytes(_load_fixture(entry["file"]),
                                  device_id=entry["device_id"])[0]
        d = to_storage_dict(frame)
        restored = from_storage_dict(d)
        self.assertEqual(restored.record_id, frame.record_id)
        self.assertEqual(restored.ingested_at, frame.ingested_at)
        self.assertEqual(restored.device_model, frame.device_model)
        self.assertEqual(restored.firmware_version, frame.firmware_version)
        self.assertEqual(restored.protocol_version, frame.protocol_version)
        self.assertEqual(restored.raw_ref, frame.raw_ref)
        self.assertEqual(restored.quality.get("status"), frame.quality.get("status"))


class TestSourceTypeIsolation(unittest.TestCase):
    """契约 (c)：source_type 取值必须落在 {real, controlled_test, simulated} 内。"""

    def test_default_source_type_is_valid(self):
        entry = _entries_by_name()["telemetry_normal"]
        for frame in frames_from_bytes(_load_fixture(entry["file"]),
                                       device_id=entry["device_id"]):
            self.assertIn(frame.source_type, VALID_SOURCE_TYPES)

    def test_all_valid_source_types_are_propagated(self):
        entry = _entries_by_name()["telemetry_normal"]
        raw = _load_fixture(entry["file"])
        for source_type in VALID_SOURCE_TYPES:
            with self.subTest(source_type=source_type):
                frames = frames_from_bytes(raw, device_id=entry["device_id"],
                                           source_type=source_type)
                self.assertTrue(frames)
                for frame in frames:
                    self.assertEqual(frame.source_type, source_type)

    def test_invalid_source_type_is_rejected(self):
        """来源隔离硬约束：非法 source_type 必须在适配器构造期就失败。"""
        with self.assertRaises(ValueError):
            NyExoA1Adapter("EXO-TEST-001", source_type="production")


class TestEventTimeContract(unittest.TestCase):
    """契约 (d)：event_time 可被标准库 datetime.fromisoformat 解析且带时区。"""

    def setUp(self):
        self.entry = _entries_by_name()["telemetry_normal"]
        self.raw = _load_fixture(self.entry["file"])

    def test_event_time_parses_with_fromisoformat(self):
        for frame in frames_from_bytes(self.raw, device_id=self.entry["device_id"]):
            parsed = datetime.fromisoformat(frame.event_time)
            self.assertIsNotNone(parsed.tzinfo, "event_time 必须带时区偏移，不得为 naive")

    def test_event_time_carries_expected_utc_plus_8_offset(self):
        """默认工厂本地时区为 +08:00（spec 5.2 示例口径）。"""
        for frame in frames_from_bytes(self.raw, device_id=self.entry["device_id"]):
            self.assertTrue(frame.event_time.endswith("+08:00"),
                            f"期望 +08:00 偏移，实际: {frame.event_time}")
            parsed = datetime.fromisoformat(frame.event_time)
            self.assertEqual(parsed.utcoffset().total_seconds(), 8 * 3600)

    def test_event_time_offset_is_configurable(self):
        frames = frames_from_bytes(self.raw, device_id=self.entry["device_id"],
                                   tz_offset_hours=0)
        for frame in frames:
            self.assertTrue(frame.event_time.endswith("+00:00"))
            self.assertIsNotNone(datetime.fromisoformat(frame.event_time).tzinfo)

    def test_event_time_reflects_device_timestamp_not_wall_clock(self):
        """时间戳必须来自设备 TS_MS，而非解析时刻（否则回放会失真）。"""
        first = frames_from_bytes(self.raw, device_id=self.entry["device_id"])[0]
        second = frames_from_bytes(self.raw, device_id=self.entry["device_id"])[0]
        self.assertEqual(first.event_time, second.event_time)


class TestPhysicalValueMapping(unittest.TestCase):
    """遥测物理量映射：解码值必须与 index.json 声明的字段值一致。"""

    def setUp(self):
        self.entries = _entries_by_name()

    def _single_frame(self, name):
        entry = self.entries[name]
        frames = frames_from_bytes(_load_fixture(entry["file"]),
                                   device_id=entry["device_id"])
        self.assertEqual(len(frames), 1, f"{name} 期望单帧")
        return frames[0], entry

    def test_normal_telemetry_values_match_index(self):
        for name in ("telemetry_normal", "telemetry_low_battery", "telemetry_high_torque"):
            with self.subTest(fixture=name):
                frame, entry = self._single_frame(name)
                declared = entry["fields"]
                self.assertAlmostEqual(frame.pose["trunk_pitch_deg"],
                                       declared["pitch_deg"], places=1)
                self.assertAlmostEqual(frame.load["torque_nm"],
                                       declared["torque_nm"], places=1)
                self.assertEqual(frame.device["battery_pct"], declared["battery_pct"])

    def test_assist_level_is_normalised_to_unit_interval(self):
        frame, _ = self._single_frame("telemetry_normal")
        self.assertIsNotNone(frame.load["assist_level"])
        self.assertGreaterEqual(frame.load["assist_level"], 0.0)
        self.assertLessEqual(frame.load["assist_level"], 1.0)

    def test_fields_absent_from_nxp1_protocol_are_none(self):
        """NXP1 v1.0 不提供关节角/设备温度/累计负荷 —— 必须为 None，不得臆造。"""
        frame, _ = self._single_frame("telemetry_normal")
        self.assertIsNone(frame.pose["joint_angles_deg"])
        self.assertIsNone(frame.device["temperature_c"])
        self.assertIsNone(frame.load["cumulative_load_score"])


class TestDataQualityContract(unittest.TestCase):
    """数据质量：越量程 / 字段缺失 / 坏帧 / 丢包 的处理符合协议确认书约定。"""

    def setUp(self):
        self.entries = _entries_by_name()

    def _frames(self, name, **kwargs):
        entry = self.entries[name]
        return frames_from_bytes(_load_fixture(entry["file"]),
                                 device_id=entry["device_id"], **kwargs)

    def test_out_of_range_marked_invalid(self):
        """pitch=185°（超 ±180° 量程）：线协议合法，但质量层必须判 invalid。"""
        frame = self._frames("telemetry_out_of_range")[0]
        self.assertEqual(frame.quality["status"], "invalid")
        self.assertEqual(frame.quality["confidence"], 0.0)

    def test_missing_field_marked_degraded_and_value_none(self):
        """torque 写入哨兵 0x7FFF：必须还原为 None 且质量降级，不得当成 3276.7Nm。"""
        frame = self._frames("telemetry_missing_field")[0]
        self.assertIsNone(frame.load["torque_nm"])
        self.assertEqual(frame.quality["status"], "degraded")

    def test_corrupted_frame_is_rejected(self):
        """CRC 校验失败帧不得进入上层。"""
        entry = self.entries["corrupted_frame"]
        raw = _load_fixture(entry["file"])
        self.assertEqual(frames_from_bytes(raw, device_id=entry["device_id"]), [])

        adapter = NyExoA1Adapter(entry["device_id"])
        adapter.feed(raw)
        self.assertEqual(adapter.health()["bad_crc_frames"], 1)

    def test_sequence_gap_is_reflected_in_packet_loss(self):
        """seq 100,101,115,116（101→115 跳变）必须体现为非零丢包率。"""
        entry = self.entries["sequence_gap"]
        adapter = NyExoA1Adapter(entry["device_id"])
        adapter.feed(_load_fixture(entry["file"]))
        frames = adapter.drain()
        self.assertEqual(len(frames), entry["frame_count"])
        self.assertGreater(adapter.packet_loss_pct(), 0.0,
                           "序号跳变未被计入丢包率")
        self.assertLessEqual(frames[-1].quality["packet_loss_pct"], 100.0)

    def test_contiguous_sequence_has_no_packet_loss(self):
        """无跳变时丢包率必须为 0，避免误报。"""
        entry = self.entries["telemetry_normal"]
        adapter = NyExoA1Adapter(entry["device_id"])
        adapter.feed(_load_fixture(entry["file"]))
        adapter.drain()
        self.assertEqual(adapter.packet_loss_pct(), 0.0)


class TestStatusFrameContract(unittest.TestCase):
    """状态帧：IDENT 回填设备元信息，FAULT 影响健康状态。"""

    def setUp(self):
        self.entries = _entries_by_name()

    def test_ident_frame_populates_device_info(self):
        entry = self.entries["ident_normal"]
        adapter = NyExoA1Adapter("PLACEHOLDER")
        adapter.feed(_load_fixture(entry["file"]))
        info = adapter.device_info()
        # 线协议 device_id 为 8B ASCII，超长 ID 截断（见 index.json 的 wire_device_id_note）
        self.assertEqual(info["device_id"], entry["device_id"][:8])
        self.assertEqual(info["firmware_version"], entry["fields"]["fw"])
        self.assertEqual(info["protocol_version"], protocol.PROTOCOL_VERSION)

    def test_ident_frame_produces_no_telemetry(self):
        entry = self.entries["ident_normal"]
        self.assertEqual(
            frames_from_bytes(_load_fixture(entry["file"]), device_id=entry["device_id"]), [])

    def test_fault_frame_degrades_health(self):
        entry = self.entries["status_fault"]
        adapter = NyExoA1Adapter(entry["device_id"])
        adapter.start()
        adapter.feed(_load_fixture(entry["file"]))
        self.assertEqual(adapter.health()["status"], "degraded")
        self.assertEqual(adapter.health()["fault_code"],
                         int(entry["fields"]["fault_code"], 16))

    def test_normal_status_frame_keeps_device_online(self):
        entry = self.entries["status_normal"]
        adapter = NyExoA1Adapter(entry["device_id"])
        adapter.start()
        adapter.feed(_load_fixture(entry["file"]))
        health = adapter.health()
        self.assertEqual(health["status"], "online")
        self.assertIsNone(health["fault_code"])


class TestStreamRobustness(unittest.TestCase):
    """字节流健壮性：粘包/半包/前导噪声必须能正确重同步。"""

    def setUp(self):
        self.entry = _entries_by_name()["telemetry_normal"]
        self.raw = _load_fixture(self.entry["file"])

    def test_split_delivery_reassembles_frame(self):
        """半包：分两次投递必须仍得到一条完整统一帧。"""
        adapter = NyExoA1Adapter(self.entry["device_id"])
        mid = len(self.raw) // 2
        self.assertEqual(adapter.feed(self.raw[:mid]), 0, "半包不应产出帧")
        self.assertEqual(adapter.feed(self.raw[mid:]), 1)
        self.assertEqual(len(adapter.drain()), 1)

    def test_leading_noise_is_resynchronised(self):
        adapter = NyExoA1Adapter(self.entry["device_id"])
        adapter.feed(b"\x00\xFF\x13garbage" + self.raw)
        self.assertEqual(len(adapter.drain()), 1)

    def test_concatenated_frames_all_decoded(self):
        adapter = NyExoA1Adapter(self.entry["device_id"])
        adapter.feed(self.raw * 3)
        self.assertEqual(len(adapter.drain()), 3)


class TestStorageRoundTrip(unittest.TestCase):
    """统一帧 → 存储 dict → JSON 往返必须无损（落库/接口传输前提）。"""

    def test_storage_dict_is_json_serialisable_and_reversible(self):
        from edge_platform.edge.exo_semantic import from_storage_dict

        entry = _entries_by_name()["telemetry_normal"]
        frame = frames_from_bytes(_load_fixture(entry["file"]),
                                  device_id=entry["device_id"], worker_id="P-TEST-001")[0]
        d = to_storage_dict(frame)
        restored = from_storage_dict(json.loads(json.dumps(d, ensure_ascii=False)))
        self.assertEqual(to_storage_dict(restored), d)


if __name__ == "__main__":
    unittest.main()
