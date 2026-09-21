"""UR8-edge-core 对抗式审查回归测试（2026-09-13，存量代码审查轮）。

每条用例对应本轮审查确认的存量缺陷（先红后绿）：
1. ContractWorldStore 状态时间回退 → 双时态区间倒置 → snapshot() 契约自检永久失败；
2. EventUplink 读超时（TimeoutError 逃逸 URLError 处理）杀死上行线程 → 上行静默停摆；
3. NXP1 解码：CRC 失败帧按声明 LEN 消费 → LEN 字节被破坏时吞掉后续健康帧；
4. 世界投影无视帧质量：invalid 帧以 confidence=1.0 投影为世界事实（不可信数据伪造）；
5. InferencePipeline consent 审计环形丢弃计数恒 0（_append_denied 从未被调用）；
6. 推理窗口乱序帧 → 证据区间 ts_end < ts_start（伪造单调 2s 窗口语义）；
7. EDGE-041 明文 http 守卫对大写 scheme（HTTP://）失效（三个 uplink 一致）；
8. edge_to_spark：云端 4xx 毒批次永久阻塞队头（无死信路径 + 无明文 http 守卫）。
9. EDGE-041 旁路第二轮：URL 前后空白（" http://…"）绕过 startswith 守卫，
   但 urlsplit/urllib 会剥掉空白照常明文发送（四个上行一致，含 edge_to_spark）；
10. 世界投影重启恢复（from_dict）后以 version=1 重复声明 → 永久 declaration_rejected；
11. EventUplink 空 URL 拼成 "/api/ingest/events" 使 enabled 误报 True。
"""

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _fixtures import FakeBus, FakeStorage  # noqa: E402
from inference import ms_to_ts  # noqa: E402
from inference.model import ModelRegistry  # noqa: E402
from inference.pipeline import InferencePipeline  # noqa: E402
from inference.rules import RuleEngine  # noqa: E402
from world_model.contract_store import ContractWorldStore, WorldStoreContractError  # noqa: E402
from world_model.projection import TelemetryWorldProjector  # noqa: E402

from edge_platform.edge.bus import MessageBus  # noqa: E402

TENANT = "org-1"
FACTORY = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"


# ---------- 1. 世界状态时间回退 ----------


class StateTimeRegressionTest(unittest.TestCase):
    """补传/乱序帧带旧时间戳写入世界状态 → 区间倒置 → snapshot() 永久失败。"""

    def test_state_time_regression_rejected_and_snapshot_stays_valid(self):
        store = ContractWorldStore()
        eid = "exo:NY-A1-SN-0007"
        store.set_state(eid, "exo", {"battery": 80}, "real", 1.0, ts="2026-09-13T10:00:02+00:00")
        with self.assertRaises(WorldStoreContractError) as cm:
            # 迟到帧（ts 早于当前状态）必须被拒绝，而不是写出 valid_to < valid_from 的坏区间
            store.set_state(eid, "exo", {"battery": 82}, "real", 1.0, ts="2026-09-13T10:00:01+00:00")
        self.assertEqual(cm.exception.code, "state_time_regression")
        # 坏区间未入库：快照自检可继续通过，当前状态保持最新事实
        snap = store.snapshot()
        self.assertEqual(len(snap["states"]), 1)
        self.assertEqual(store.current(eid, "exo").state_json["battery"], 80)

    def test_equal_ts_set_state_allowed(self):
        store = ContractWorldStore()
        eid = "exo:NY-A1-SN-0008"
        store.set_state(eid, "exo", {"battery": 80}, "real", 1.0, ts="2026-09-13T10:00:02+00:00")
        store.set_state(eid, "exo", {"battery": 79}, "real", 1.0, ts="2026-09-13T10:00:02+00:00")
        snap = store.snapshot()  # 同刻写入不产生倒置区间
        self.assertEqual(len(snap["states"]), 2)


# ---------- 2. EventUplink 读超时杀死线程 ----------


class EventUplinkTimeoutTest(unittest.TestCase):
    """响应头读超时以 TimeoutError 逃逸 → _loop 线程死亡 → 上行静默停摆。"""

    def setUp(self):
        self.bus = MessageBus()

    def test_post_batch_read_timeout_returns_retry(self):
        from edge_platform.edge.bridge.event_uplink import EventUplink

        uplink = EventUplink(self.bus, "http://127.0.0.1:59998", queue_path="")
        uplink._enqueue({"envelope": {"eventId": "E-T", "eventType": "EntityDeclared",
                                      "schemaVersion": "1.0.0",
                                      "occurredAt": "2026-09-13T10:00:00Z",
                                      "source": "edge:test"}})
        batch = uplink._drain()
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            # 读超时是瞬态失败：必须按 retry 处理，而不是把异常抛进 _loop
            self.assertEqual(uplink._post_batch(batch), "retry")
        self.assertEqual(len(batch), 1)

    def test_loop_thread_survives_read_timeout(self):
        from edge_platform.edge.bridge.event_uplink import EventUplink

        uplink = EventUplink(self.bus, "http://127.0.0.1:59998", queue_path="")
        uplink.start()
        try:
            self.bus.publish("events", {"envelope": {"eventId": "E-T2", "eventType": "EntityDeclared",
                                                     "schemaVersion": "1.0.0",
                                                     "occurredAt": "2026-09-13T10:00:00Z",
                                                     "source": "edge:test"}})
            # 读超时路径（TimeoutError 逃逸 URLError 包装）——正是它曾击穿 _loop
            with mock.patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
                deadline = time.time() + 5
                while time.time() < deadline and uplink.health()["stats"]["failures"] < 1:
                    time.sleep(0.05)
                stats = uplink.health()["stats"]
            self.assertGreaterEqual(stats["failures"], 1, "读超时应计入 failures（可观测）")
            self.assertTrue(uplink._thread.is_alive(), "读超时不得杀死上行线程")
        finally:
            uplink.stop()


# ---------- 3. NXP1 CRC 失败帧吞掉后续健康帧 ----------


class ExoCodecResyncTest(unittest.TestCase):
    def _three_frames(self):
        from edge_platform.edge.adapters.ny_exo_a1 import codec

        f1 = codec.encode_telemetry(seq=1, ts_ms=1000, pitch_deg=10.0, torque_nm=5.0, assist_pct=30, battery_pct=80)
        f2 = codec.encode_telemetry(seq=2, ts_ms=1050, pitch_deg=11.0, torque_nm=5.0, assist_pct=30, battery_pct=80)
        f3 = codec.encode_telemetry(seq=3, ts_ms=1100, pitch_deg=12.0, torque_nm=5.0, assist_pct=30, battery_pct=80)
        return f1, f2, f3

    def test_decode_stream_resyncs_after_bad_crc(self):
        from edge_platform.edge.adapters.ny_exo_a1 import protocol

        f1, f2, f3 = self._three_frames()
        bad = bytearray(f1)
        bad[2] = 0x28  # LEN 20 → 40（模拟线上单比特破坏），CRC 必然失败
        frames = protocol.decode_stream(bytes(bad) + f2 + f3)
        self.assertEqual([f["seq"] for f in frames], [2, 3], "CRC 失败帧之后的健康帧必须恢复")

    def test_adapter_feed_resyncs_after_corrupted_len(self):
        from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter

        f1, f2, f3 = self._three_frames()
        bad = bytearray(f1)
        bad[2] = 0x28
        adapter = NyExoA1Adapter("EXO-UR8")
        adapter.feed(bytes(bad) + f2 + f3)
        seqs = [fr.sequence for fr in adapter.drain()]
        self.assertEqual(seqs, [2, 3], "LEN 被破坏的坏帧不得吞掉后续健康帧")
        self.assertGreaterEqual(adapter.health()["bad_crc_frames"], 1)


# ---------- 4. 世界投影无视帧质量 ----------


def _proj_row(device_id, quality, telemetry=None, ts="2026-09-13T10:00:00Z"):
    return {
        "record_id": "TS-UR8",
        "device_id": device_id,
        "timestamp": ts,
        "sequence": 1,
        "source_type": "real",
        "telemetry": telemetry or {"battery_pct": 80, "cumulative_load_score": 0.4},
        "quality": quality,
    }


class ProjectionQualityTest(unittest.TestCase):
    def setUp(self):
        self.store = ContractWorldStore()
        self.projector = TelemetryWorldProjector(
            self.store, MessageBus(), tenant_id=TENANT, factory_id=FACTORY, kind_map={"EXO-": "exo"}
        )

    def test_invalid_frame_rejected_not_projected_as_fact(self):
        out = self.projector.handle(_proj_row("EXO-BAD", {"status": "invalid", "confidence": 0.0},
                                              telemetry={"battery_pct": 250}))
        self.assertFalse(out["projected"])
        self.assertEqual(out["skipped_reason"], "bad_quality")
        self.assertEqual(self.projector.health()["counters"]["rejected_quality"], 1)
        self.assertIsNone(self.store.current("exo:EXO-BAD", "exo"))

    def test_unknown_quality_frame_rejected(self):
        out = self.projector.handle(_proj_row("EXO-UNK", {"status": "unknown"}))
        self.assertFalse(out["projected"])
        self.assertEqual(out["skipped_reason"], "bad_quality")

    def test_degraded_frame_projected_with_frame_confidence(self):
        out = self.projector.handle(_proj_row("EXO-DEG", {"status": "degraded", "confidence": 0.4}))
        self.assertTrue(out["projected"])
        self.assertEqual(self.store.current("exo:EXO-DEG", "exo").confidence, 0.4)

    def test_good_frame_defaults_full_confidence(self):
        out = self.projector.handle(_proj_row("EXO-GOOD", {"status": "good"}))
        self.assertTrue(out["projected"])
        self.assertEqual(self.store.current("exo:EXO-GOOD", "exo").confidence, 1.0)


# ---------- 5. consent 环形丢弃计数 ----------


class ConsentDeniedDropCounterTest(unittest.TestCase):
    """R2-ESC-005 承诺：环形满丢弃最旧审计条目时计数 consent_denied_dropped。"""

    def test_ring_overflow_counts_dropped(self):
        from collections import deque

        from governance.consent import ConsentManager

        storage, bus = FakeStorage(), FakeBus()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        registry = ModelRegistry(tmp)
        rules = RuleEngine(config={"bend_sec": 1, "load_sec": 1, "degraded_sec": 1, "cooldown_sec": 30})
        pipe = InferencePipeline(storage, bus, registry, rules, consent_manager=ConsentManager())
        pipe.consent_denied_log = deque(maxlen=2)
        for i in range(3):
            pipe.handle_telemetry(_consent_frame(f"P{i}"))
        self.assertEqual(len(pipe.consent_denied_log), 2)
        self.assertEqual(pipe.consent_denied_dropped, 1, "环形丢弃必须计数（可观测），不得恒 0")


def _consent_frame(person_id):
    return {
        "record_id": f"REC-{person_id}",
        "device_id": "D1",
        "person_id": person_id,
        "timestamp": ms_to_ts(1785300000000),
        "telemetry": {"pitch_deg": 10.0, "torque_nm": 5.0, "assist_level": 0.2},
        "quality": {"status": "good"},
        "source_type": "controlled_test",
    }


# ---------- 6. 推理窗口乱序帧 → 证据区间倒置 ----------


class WindowOrderEvidenceTest(unittest.TestCase):
    """补传旧帧晚到（到达序在最后）→ ts_end 取到旧帧 → 伪造出倒置的 2s 窗口。"""

    def test_out_of_order_window_keeps_monotonic_evidence_interval(self):
        storage, bus = FakeStorage(), FakeBus()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        registry = ModelRegistry(tmp)
        rules = RuleEngine(config={"bend_sec": 1, "load_sec": 1, "degraded_sec": 1, "cooldown_sec": 30})
        pipe = InferencePipeline(storage, bus, registry, rules)
        t0 = 1785300000000
        res = None
        for i in range(39):
            res = pipe.handle_telemetry(_order_frame(t0 + i * 50, seq=i))
        # 第 40 条：迟到 1s 的旧帧（到达序最后）
        res = pipe.handle_telemetry(_order_frame(t0 - 1000, seq=39, backfill=True))
        self.assertIsNotNone(res)
        from inference import ts_to_ms

        self.assertGreaterEqual(
            ts_to_ms(res["ts_end"]), ts_to_ms(res["ts_start"]),
            "证据窗口必须按帧时间戳单调，不得把乱序到达伪装成 ts_start>ts_end 的窗口",
        )
        self.assertEqual(res["ts_start"], ms_to_ts(t0 - 1000))


def _order_frame(t_ms, seq, backfill=False):
    msg = {
        "record_id": f"REC-ORD-{seq}",
        "device_id": "D1",
        "person_id": "P1",
        "timestamp": ms_to_ts(t_ms),
        "sequence": seq,
        "telemetry": {"pitch_deg": 10.0, "torque_nm": 5.0, "assist_level": 0.2},
        "quality": {"status": "good"},
        "source_type": "controlled_test",
    }
    if backfill:
        msg["backfill"] = True
    return msg


# ---------- 7. 明文 http 守卫大小写旁路 ----------


class InsecureHttpGuardCaseTest(unittest.TestCase):
    """EDGE-041：URL scheme 大小写不敏感（RFC 3986），守卫必须先归一再判定。"""

    def test_event_uplink_uppercase_scheme_rejected_in_production(self):
        from edge_platform.edge.bridge import event_uplink

        with mock.patch.object(event_uplink, "_runtime_mode", return_value="production"):
            u = event_uplink.EventUplink(MessageBus(), "HTTP://insecure.example")
        self.assertFalse(u.enabled)
        self.assertEqual(u._disabled_reason, "insecure_http_in_production")

    def test_sensor_uplink_uppercase_scheme_rejected_in_production(self):
        from edge_platform.edge.bridge import sensor_uplink

        with mock.patch.object(sensor_uplink, "_runtime_mode", return_value="production"):
            s = sensor_uplink.SensorUplinkBridge(MessageBus(), "HTTP://insecure.example")
        self.assertFalse(s.enabled)
        self.assertEqual(s._disabled_reason, "insecure_http_in_production")

    def test_sensor_uplink_retarget_uppercase_scheme_rejected(self):
        from edge_platform.edge.bridge import sensor_uplink

        with mock.patch.object(sensor_uplink, "_runtime_mode", return_value="production"):
            s = sensor_uplink.SensorUplinkBridge(MessageBus(), "https://ok.example")
            s.retarget("HTTP://insecure.example")
        self.assertEqual(s._base_url, "https://ok.example")
        self.assertTrue(s.enabled)

    def test_metrics_uplink_uppercase_scheme_rejected_in_production(self):
        from edge_platform.edge.bridge import metrics_uplink

        with mock.patch.object(metrics_uplink, "_runtime_mode", return_value="production"):
            m = metrics_uplink.MetricsUplink(mock.Mock(), "HTTP://insecure.example")
        self.assertFalse(m.enabled)
        self.assertEqual(m._disabled_reason, "insecure_http_in_production")

    def test_event_uplink_https_still_enabled_in_production(self):
        from edge_platform.edge.bridge import event_uplink

        with mock.patch.object(event_uplink, "_runtime_mode", return_value="production"):
            u = event_uplink.EventUplink(MessageBus(), "HTTPS://secure.example")
        self.assertTrue(u.enabled)


# ---------- 8. edge_to_spark 毒批次阻塞队头 ----------


class EdgeToSparkPoisonBatchTest(unittest.TestCase):
    """云端 4xx（帧被平台拒绝）→ 整批永久重试，队头及其后所有帧被阻塞。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.queue_path = os.path.join(self.tmp, "edge_to_spark.queue.json")
        from edge_platform.edge.bridge import edge_to_spark as ets

        self.ets = ets

    def _bridge(self):
        bridge = self.ets.SparkBridge("http://127.0.0.1:59997", ingest_key="K", source=None, queue_path=self.queue_path)
        bridge._buffer = [{"record_id": "R1"}, {"record_id": "R2"}]
        return bridge

    def _http_400(self):
        return urllib.error.HTTPError(
            "http://127.0.0.1:59997/api/ingest/exoskeleton/batch", 400, "Bad Request", {}, io.BytesIO(b"{}")
        )

    def test_4xx_batch_goes_dead_letter_not_blocking(self):
        bridge = self._bridge()
        with mock.patch("urllib.request.urlopen", side_effect=self._http_400()):
            bridge._backoff = lambda: None  # 测试不等待退避
            bridge._flush_batch()
        self.assertEqual(bridge._buffer, [], "4xx 拒绝的批次不得永久留在队头")
        self.assertEqual(bridge.dead_lettered, 2)
        dl = self.queue_path + ".dead-letter.jsonl"
        with open(dl, encoding="utf-8") as fh:
            lines = [json.loads(x) for x in fh.read().splitlines() if x.strip()]
        self.assertEqual([e["record_id"] for e in lines], ["R1", "R2"])

    def test_transient_failure_keeps_batch(self):
        bridge = self._bridge()
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("conn refused")):
            bridge._backoff = lambda: None
            bridge._flush_batch()
        self.assertEqual(len(bridge._buffer), 2, "瞬态失败批次必须保留（at-least-once）")
        self.assertEqual(bridge.dead_lettered, 0)

    def test_production_rejects_plaintext_http(self):
        with mock.patch.object(self.ets, "_runtime_mode", return_value="production"):
            bridge = self.ets.SparkBridge("HTTP://insecure.example", ingest_key="K", source=None, queue_path="")
        self.assertEqual(bridge.disabled_reason, "insecure_http_in_production")
        bridge._buffer = [{"record_id": "R9"}]
        with mock.patch("urllib.request.urlopen", side_effect=self._http_400()) as posted:
            bridge._backoff = lambda: None
            bridge._flush_batch()
        # 禁用状态下不得发出携带凭据的请求
        posted.assert_not_called()
        self.assertEqual(len(bridge._buffer), 1)


# ---------- 9. 明文 http 守卫空白旁路（UR8 第二轮） ----------


class InsecureHttpGuardWhitespaceTest(unittest.TestCase):
    """URL 前后空白时 lower().startswith("http://") 不命中，但 urlsplit/urllib
    会剥掉空白照常发 http——production 下 X-Ingest-Key 明文外泄（已用本地 HTTP
    服务端到端复现）。守卫判定前必须先 strip 归一。"""

    def test_event_uplink_padded_http_rejected_in_production(self):
        from edge_platform.edge.bridge import event_uplink

        for padded in (" http://insecure.example", "\thttp://insecure.example", "http://insecure.example "):
            with self.subTest(url=padded):
                with mock.patch.object(event_uplink, "_runtime_mode", return_value="production"):
                    u = event_uplink.EventUplink(MessageBus(), padded)
                self.assertFalse(u.enabled, padded)
                self.assertEqual(u._disabled_reason, "insecure_http_in_production")
                # 归一后的 URL 不残留空白：守卫命中且发送目标一致
                self.assertEqual(u._url, "http://insecure.example/api/ingest/events")

    def test_sensor_uplink_padded_http_rejected_in_production(self):
        from edge_platform.edge.bridge import sensor_uplink

        with mock.patch.object(sensor_uplink, "_runtime_mode", return_value="production"):
            s = sensor_uplink.SensorUplinkBridge(MessageBus(), " http://insecure.example")
        self.assertFalse(s.enabled)
        self.assertEqual(s._disabled_reason, "insecure_http_in_production")
        self.assertEqual(s._base_url, "http://insecure.example")

    def test_metrics_uplink_padded_http_rejected_in_production(self):
        from edge_platform.edge.bridge import metrics_uplink

        with mock.patch.object(metrics_uplink, "_runtime_mode", return_value="production"):
            m = metrics_uplink.MetricsUplink(mock.Mock(), " http://insecure.example")
        self.assertFalse(m.enabled)

    def test_edge_to_spark_padded_http_rejected_in_production(self):
        from edge_platform.edge.bridge import edge_to_spark as ets

        with mock.patch.object(ets, "_runtime_mode", return_value="production"):
            b = ets.SparkBridge(" http://insecure.example", ingest_key="K", source=None, queue_path="")
        self.assertEqual(b.disabled_reason, "insecure_http_in_production")


# ---------- 10. EventUplink 空 URL 误报 enabled（UR8 第二轮） ----------


class EventUplinkEmptyUrlTest(unittest.TestCase):
    """空 URL 不得拼成 "/api/ingest/events" 令 enabled 误报 True——组件自身
    契约是"空 = 上行关闭"（run.py 的外层守卫不覆盖直接构造方/health 消费方）。"""

    def test_empty_url_disabled(self):
        from edge_platform.edge.bridge import event_uplink

        u = event_uplink.EventUplink(MessageBus(), "")
        self.assertEqual(u._url, "")
        self.assertFalse(u.enabled)

    def test_whitespace_url_disabled(self):
        from edge_platform.edge.bridge import event_uplink

        u = event_uplink.EventUplink(MessageBus(), "   ")
        self.assertEqual(u._url, "")
        self.assertFalse(u.enabled)


if __name__ == "__main__":
    unittest.main()
