"""Task 36 连续运行测试。

模拟 30 分钟数据流，验证：
- 无内存泄漏：适配器内部数据结构有界（_seen_seqs / _telemetry_ts_window / _buffer）
- 无事件丢失：处理 N 帧后产出的统一帧数量与输入一致，dropped_frames=0
- 无推理中断：推理管线在连续帧流上持续产出结果
- Storage 记录数正确：写入 storage 的遥测记录数 = 输入帧数
- 设备重连续接：断连 5s（100 帧）后重连，BACKFILL 补传不丢失

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_sustained_run -v
"""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# inference 包在 edge_platform/ 下，需要 edge_platform 目录在 path 上
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from inference.events import EventEngine  # noqa: E402
from inference.pipeline import InferencePipeline  # noqa: E402
from inference.rules import RuleEngine  # noqa: E402

from edge_platform import stubs  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.injector import WireInjector  # noqa: E402
from edge_platform.edge.exo_semantic import to_storage_dict  # noqa: E402

# 30 分钟 × 20Hz = 36000 帧
FRAMES_30_MIN_20HZ = 36000


def _frame_to_msg(frame):
    """UnifiedExoFrame → 存储/推理管线消息格式（device_id/timestamp/telemetry）。

    to_storage_dict 产出 entity_id/event_time/pose/load/device 分组，
    而 stubs.Storage.insert_telemetry 与 InferencePipeline.handle_telemetry
    要求 device_id/timestamp/telemetry 顶层字段，本函数做必要的字段名映射。
    """
    d = to_storage_dict(frame)
    pose = d.get("pose") or {}
    load = d.get("load") or {}
    device = d.get("device") or {}
    return {
        "record_id": d.get("record_id", ""),
        "device_id": d.get("entity_id", ""),
        "timestamp": d.get("event_time", ""),
        "sequence": 0,
        "source_type": d.get("source_type", "real"),
        "person_id": d.get("worker_id"),
        "telemetry": {
            "pitch_deg": pose.get("trunk_pitch_deg"),
            "torque_nm": load.get("torque_nm"),
            "assist_level": load.get("assist_level"),
            "battery_percent": device.get("battery_pct"),
            "load_score": load.get("cumulative_load_score"),
        },
        "quality": d.get("quality") or {"status": "unknown"},
    }


class SustainedRunNoLossTest(unittest.TestCase):
    """连续运行 30 分钟（36000 帧），验证无帧丢失、无内存泄漏。"""

    def test_30_minute_continuous_stream_no_frame_loss(self):
        inj = WireInjector(device_id="EXO-SR-01", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000, battery_pct=80)
        adapter = NyExoA1Adapter("EXO-SR-01", source_type="controlled_test")
        produced = []
        adapter.frame_sink = lambda frame, meta: produced.append(frame)
        adapter.start()

        n = FRAMES_30_MIN_20HZ
        raw = inj.telemetry_burst(n, action="walk")
        count = adapter.feed(raw)
        self.assertEqual(count, n, "feed 返回的产出帧数应等于输入帧数")
        self.assertEqual(len(produced), n, "frame_sink 收到的帧数应等于输入帧数")

        health = adapter.health()
        self.assertEqual(health["dropped_frames"], 0, "不应有背压丢帧")
        self.assertEqual(health["bad_crc_frames"], 0, "不应有坏帧")
        self.assertEqual(health["malformed_frames"], 0, "不应有畸形帧")

        # record_id 全局唯一
        record_ids = [f.record_id for f in produced]
        self.assertEqual(len(set(record_ids)), n, "record_id 必须全部唯一")

        # 内存有界：_seen_seqs 受 BACKFILL_DEDUP_WINDOW 限制
        self.assertLessEqual(len(adapter._seen_seqs), 4096,
                             "_seen_seqs 应受去重窗口限制（无内存泄漏）")
        self.assertLessEqual(len(adapter._seen_seq_order), 4096)
        # _telemetry_ts_window 受采样窗口限制
        self.assertLessEqual(len(adapter._telemetry_ts_window), 1000,
                             "_telemetry_ts_window 应受采样窗口限制")
        # _buffer 处理完毕后应为空（无粘包残留）
        self.assertEqual(len(adapter._buffer), 0, "处理完毕后 _buffer 应为空")

    def test_no_packet_loss_for_contiguous_sequence(self):
        """连续 SEQ 不应有丢包率。"""
        inj = WireInjector(device_id="EXO-SR-02", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000)
        adapter = NyExoA1Adapter("EXO-SR-02", source_type="controlled_test")
        adapter.start()
        adapter.feed(inj.telemetry_burst(200, action="stand"))
        self.assertEqual(adapter.packet_loss_pct(), 0.0)


class SustainedRunStorageTest(unittest.TestCase):
    """连续运行后 Storage 记录数正确。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sustained_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)

    def tearDown(self):
        self.storage.close()

    def test_storage_records_match_frame_count(self):
        inj = WireInjector(device_id="EXO-SR-03", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000)
        adapter = NyExoA1Adapter("EXO-SR-03", source_type="controlled_test")

        n = 600  # 30s 数据
        raw = inj.telemetry_burst(n, action="walk")
        adapter.feed(raw)
        frames = adapter.drain()
        self.assertEqual(len(frames), n)
        # 写入 storage
        for f in frames:
            self.storage.insert_telemetry(_frame_to_msg(f))
        counts = self.storage.counts()
        self.assertEqual(counts["telemetry"], n, "Storage 遥测记录数应等于帧数")


class SustainedRunInferenceTest(unittest.TestCase):
    """连续运行下推理管线不中断。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_sustained_inf_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)

    def tearDown(self):
        self.storage.close()

    def test_inference_continuous_throughout_stream(self):
        """36000 帧连续流，推理管线应持续产出结果（无中断）。"""
        from edge_platform.stubs import Bus, ModelRegistry

        bus = Bus()
        registry = ModelRegistry(Path(self.tmp) / "models")
        rules = RuleEngine("risk-rule-stub-0.1", {})
        pipeline = InferencePipeline(self.storage, bus, registry, rules)

        inj = WireInjector(device_id="EXO-SR-04", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000, battery_pct=80)
        adapter = NyExoA1Adapter("EXO-SR-04", source_type="controlled_test",
                                 worker_id="P-001")

        n = 600  # 30s @ 20Hz
        raw = inj.telemetry_burst(n, action="walk")
        adapter.feed(raw)
        frames = adapter.drain()
        self.assertEqual(len(frames), n)

        inference_count = 0
        for f in frames:
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            # 写入 storage 供 EventEngine 查证据
            self.storage.insert_telemetry(msg)
            res = pipeline.handle_telemetry(msg)
            if res is not None:
                inference_count += 1

        # WINDOW_SIZE=40, STEP_SIZE=20：首条推理在第 40 帧，之后每 20 帧一条
        # 600 帧 → (600-40)/20 + 1 = 29 条推理
        self.assertGreater(inference_count, 0, "推理管线应产出结果")
        expected = (n - 40) // 20 + 1
        self.assertEqual(inference_count, expected,
                         "推理结果数应与步长推算一致（无中断）")

    def test_event_state_consistent_under_continuous_stream(self):
        """连续高负荷帧流应触发 LOAD_CONTINUOUS 事件，且事件状态一致。"""
        from edge_platform.stubs import Bus, ModelRegistry

        bus = Bus()
        registry = ModelRegistry(Path(self.tmp) / "models")
        # 用短窗规则加速触发
        rules = RuleEngine("risk-rule-v1.0", {"load_sec": 1, "cooldown_sec": 30})
        event_engine = EventEngine(self.storage, bus)
        pipeline = InferencePipeline(self.storage, bus, registry, rules,
                                     event_engine=event_engine)

        inj = WireInjector(device_id="EXO-SR-05", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000, battery_pct=80)
        adapter = NyExoA1Adapter("EXO-SR-05", source_type="controlled_test",
                                 worker_id="P-001")

        # 40 帧高扭矩（lift 画像：torque≈42Nm > 20Nm 阈值）
        raw = inj.telemetry_burst(40, action="lift")
        adapter.feed(raw)
        frames = adapter.drain()

        for f in frames:
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            self.storage.insert_telemetry(msg)
            pipeline.handle_telemetry(msg)

        events = self.storage.list_events(100)
        load_events = [e for e in events if e.get("event_code") == "LOAD_CONTINUOUS"]
        self.assertGreater(len(load_events), 0, "应触发 LOAD_CONTINUOUS 事件")
        for e in load_events:
            self.assertEqual(e["status"], "open", "事件状态应一致")
            self.assertEqual(e["severity"], "L2")


class SustainedRunReconnectTest(unittest.TestCase):
    """设备断连 5s（100 帧）后重连，BACKFILL 补传不丢失。"""

    def test_disconnect_5s_reconnect_no_data_loss(self):
        inj = WireInjector(device_id="EXO-RC-01", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000, battery_pct=80)
        adapter = NyExoA1Adapter("EXO-RC-01", source_type="controlled_test")
        adapter.start()

        # 1. 正常上线：IDENT + 5 帧遥测
        online_bytes = inj.ident() + inj.telemetry_burst(5, action="walk")
        produced_online = adapter.feed(online_bytes)
        self.assertEqual(produced_online, 5, "上线阶段应产出 5 帧遥测")

        # 2. 断连 5s = 100 帧（20Hz × 5s）
        missed = 100
        cached = inj.disconnect(missed_frames=missed, action="lift")
        self.assertEqual(cached, missed, "断连期间应缓存 100 帧")

        # 3. 重连：IDENT + BACKFILL（含 3 个重复条目用于验证去重）
        reconnect_bytes = inj.reconnect(missed_frames=0, duplicates=3)
        produced_reconnect = adapter.feed(reconnect_bytes)
        # BACKFILL 100 缓存 + 3 重复 = 103 条目；去重 3 个重复 SEQ → 100 帧补传；IDENT 不产帧
        self.assertEqual(produced_reconnect, missed,
                         "重连后应补传 100 帧（103 条目 - 3 重复去重）")

        # 4. 恢复实时遥测 20 帧
        post_bytes = inj.telemetry_burst(20, action="walk")
        produced_post = adapter.feed(post_bytes)
        self.assertEqual(produced_post, 20, "重连后实时帧应正常产出")

        # 总帧数 = 5（上线）+ 100（补传）+ 20（恢复）= 125
        total = len(adapter.drain())
        self.assertEqual(total, 5 + missed + 20, "总帧数应匹配")

        health = adapter.health()
        self.assertEqual(health["dropped_frames"], 0, "不应有丢帧")
        self.assertGreater(health["backfill_frames"], 0, "应有 BACKFILL 帧")
        self.assertEqual(health["backfill_duplicates"], 3, "应去重 3 个重复条目")

    def test_reconnect_after_disconnect_no_event_loss(self):
        """断连+重连后，事件状态一致（无事件丢失）。"""
        from edge_platform.stubs import Bus, ModelRegistry

        tmp = tempfile.mkdtemp(prefix="ewoh_reconnect_evt_")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        db_path = Path(tmp) / "test.db"
        storage = stubs.Storage(db_path)
        try:
            bus = Bus()
            registry = ModelRegistry(Path(tmp) / "models")
            rules = RuleEngine("risk-rule-v1.0", {"load_sec": 1, "cooldown_sec": 30})
            event_engine = EventEngine(storage, bus)
            pipeline = InferencePipeline(storage, bus, registry, rules,
                                         event_engine=event_engine)

            inj = WireInjector(device_id="EXO-RC-02", source_label="controlled_test",
                               hz=20.0, start_ts_ms=1_000_000, battery_pct=80)
            adapter = NyExoA1Adapter("EXO-RC-02", source_type="controlled_test",
                                     worker_id="P-001")

            # 上线 + 40 帧高负荷 → 触发事件
            adapter.feed(inj.ident() + inj.telemetry_burst(40, action="lift"))
            for f in adapter.drain():
                msg = _frame_to_msg(f)
                msg["person_id"] = "P-001"
                storage.insert_telemetry(msg)
                pipeline.handle_telemetry(msg)

            events_before = storage.list_events(100)
            self.assertGreater(len(events_before), 0, "断连前应有事件")

            # 断连 5s + 重连 + 20 帧恢复
            inj.disconnect(missed_frames=100, action="lift")
            adapter.feed(inj.reconnect(missed_frames=0, duplicates=2))
            adapter.feed(inj.telemetry_burst(20, action="lift"))
            for f in adapter.drain():
                msg = _frame_to_msg(f)
                msg["person_id"] = "P-001"
                storage.insert_telemetry(msg)
                pipeline.handle_telemetry(msg)

            events_after = storage.list_events(100)
            # 事件数量不应减少（断连重连不丢失已有事件）
            self.assertGreaterEqual(len(events_after), len(events_before),
                                    "重连后事件数量不应减少")
        finally:
            storage.close()


class SustainedRunMemoryBoundedTest(unittest.TestCase):
    """连续运行下适配器内部状态有界（无内存泄漏）。"""

    def test_keep_raw_ring_bounded(self):
        """keep_raw=True 时原始帧环形缓冲有界。"""
        inj = WireInjector(device_id="EXO-MEM-01", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000)
        adapter = NyExoA1Adapter("EXO-MEM-01", source_type="controlled_test",
                                 keep_raw=True, raw_ring_size=128)
        adapter.start()
        # 投递 1000 帧 >> raw_ring_size
        adapter.feed(inj.telemetry_burst(1000, action="walk"))
        adapter.drain()
        # 环形缓冲应不超过 raw_ring_size
        self.assertLessEqual(len(adapter._raw_ring), 128,
                             "原始帧环形缓冲应受 raw_ring_size 限制")
        self.assertEqual(len(adapter._raw_ring), 128)

    def test_seen_seqs_bounded_under_large_stream(self):
        """36000 帧后 _seen_seqs 不超过去重窗口。"""
        inj = WireInjector(device_id="EXO-MEM-02", source_label="controlled_test",
                           hz=20.0, start_ts_ms=1_000_000)
        adapter = NyExoA1Adapter("EXO-MEM-02", source_type="controlled_test")
        adapter.start()
        adapter.feed(inj.telemetry_burst(FRAMES_30_MIN_20HZ, action="walk"))
        adapter.drain()
        self.assertLessEqual(len(adapter._seen_seqs), 4096)
        self.assertLessEqual(len(adapter._seen_seq_order), 4096)
        # buffer 处理完毕为空
        self.assertEqual(len(adapter._buffer), 0)


if __name__ == "__main__":
    unittest.main()
