"""多源传感器帧上行桥测试（2026-09-10 边缘韧性收口）。

覆盖「三类传感器数据真正到达平台」这条链路的韧性语义：
- 按 endpoint 路由（environment / camera / location 逐帧，exoskeleton 批量）；
- 请求头带 X-Ingest-Key / X-Org-Id（机器通道契约）；
- 2xx 接受 / `skipped` 计入 duplicates / 4xx 转死信 / 429 与 5xx、网络错误重试；
- 离线落盘 + 跨重启断点续传（新实例加载队列继续发送）；
- 有界缓冲（满时丢最旧 + 计数）、非归一化帧计数丢弃；
- 默认不接管外骨骼（避免与 edge_to_spark 双通道），显式开启时走批量端点。

纯 Python 标准库 + unittest。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
from io import BytesIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.config import Settings
from edge_platform.edge.bridge.sensor_uplink import MAX_BUFFER, SensorUplinkBridge
from edge_platform.edge.bus import MessageBus
from edge_platform.runtime.protocols import STREAM_SENSOR_FRAMES


class _FakeResponse:
    def __init__(self, status: int, body: dict | str = ""):
        self.status = status
        self._raw = body if isinstance(body, str) else json.dumps(body)

    def read(self) -> bytes:
        return self._raw.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeOpener:
    """记录请求并返回脚本化响应。

    `responses` 为 (status, body) 列表（按请求顺序消费）；元素为 Exception
    时抛出（模拟网络错误）。用尽后返回 200 接受。
    """

    def __init__(self, responses=None):
        self.requests: list[dict] = []
        self.responses = list(responses or [])

    def __call__(self, request, timeout=None):
        body = json.loads(request.data.decode("utf-8")) if request.data else None
        self.requests.append(
            {
                "url": request.full_url,
                "headers": {k.lower(): v for k, v in request.header_items()},
                "body": body,
            }
        )
        if self.responses:
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            status, payload = item
            if status >= 400:
                raw = payload if isinstance(payload, str) else json.dumps(payload)
                raise urllib.error.HTTPError(request.full_url, status, "err", {}, BytesIO(raw.encode()))
            return _FakeResponse(status, payload)
        return _FakeResponse(200, {"accepted": True, "skipped": False})

    def paths(self) -> list[str]:
        return [r["url"].split("/api/ingest/", 1)[-1] for r in self.requests]


def _entry(endpoint: str, record_id: str, payload: dict | None = None) -> dict:
    """队列文件里持久化的条目形状（与 `_to_entry` 一致）。"""
    body = {"record_id": record_id, **(payload or {})}
    return {
        "_uid": f"uid-{record_id}",
        "kind": endpoint,
        "endpoint": endpoint,
        "batch": endpoint == "exoskeleton",
        "record_id": record_id,
        "payload": body,
    }


def _frame(endpoint: str, record_id: str, payload: dict | None = None) -> dict:
    body = {"record_id": record_id, **(payload or {})}
    return {
        "kind": endpoint,
        "device_id": f"DEV-{record_id}",
        "record_id": record_id,
        "uplink": {"endpoint": endpoint, "batch": endpoint == "exoskeleton", "payload": body},
    }


class SensorUplinkRoutingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.queue = os.path.join(self.tmp, "sensor-uplink.jsonl")
        self.opener = _FakeOpener()
        self.bridge = SensorUplinkBridge(
            bus=MessageBus(),
            spark_url="http://127.0.0.1:3100",
            ingest_key="k-test",
            org_id="00000000-0000-4000-8000-000000000001",
            queue_path=self.queue,
            opener=self.opener,
        )

    def tearDown(self):
        self.bridge.stop()

    def test_routes_each_kind_to_its_endpoint_with_machine_headers(self):
        self.bridge.enqueue(_frame("environment", "rec-env", {"sensor_id": "ENV-1", "temperature": 24.5}))
        self.bridge.enqueue(_frame("camera", "rec-cam", {"camera_id": "CAM-1", "detections": []}))
        self.bridge.enqueue(_frame("location", "rec-loc", {"entity_id": "P-001", "locator": "uwb", "x": 1, "y": 2}))

        self.assertTrue(self.bridge.flush_once())
        self.assertEqual(
            self.opener.paths(),
            ["environment", "camera", "location"],
            "三类帧必须各自投递到平台的对应 ingest 端点",
        )
        first = self.opener.requests[0]
        self.assertEqual(first["headers"]["x-ingest-key"], "k-test")
        self.assertEqual(first["headers"]["x-org-id"], "00000000-0000-4000-8000-000000000001")
        self.assertEqual(self.bridge.health()["stats"]["sent"], 3)
        self.assertEqual(
            sorted(self.bridge.health()["stats"]["sent_record_ids"]),
            sorted(["rec-env", "rec-cam", "rec-loc"]),
        )
        self.assertEqual(self.bridge.health()["buffer"], 0)

    def test_exoskeleton_is_not_taken_over_by_default(self):
        self.bridge.enqueue(_frame("exoskeleton", "rec-exo", {"device_id": "EXO-1"}))
        self.assertFalse(self.bridge.flush_once())
        stats = self.bridge.health()["stats"]
        self.assertEqual(stats["skipped_exoskeleton"], 1)
        self.assertEqual(stats["sent"], 0)
        self.assertEqual(self.opener.requests, [])

    def test_exoskeleton_uses_batch_endpoint_when_explicitly_enabled(self):
        bridge = SensorUplinkBridge(
            bus=MessageBus(),
            spark_url="http://127.0.0.1:3100",
            queue_path="",
            opener=self.opener,
            include_exoskeleton=True,
        )
        for index in range(3):
            bridge.enqueue(_frame("exoskeleton", f"rec-exo-{index}", {"device_id": f"EXO-{index}"}))
        self.assertTrue(bridge.flush_once())
        self.assertEqual(self.opener.paths(), ["exoskeleton/batch"])
        frames = self.opener.requests[0]["body"]["frames"]
        self.assertEqual(len(frames), 3)
        self.assertEqual(bridge.health()["stats"]["sent"], 3)

    def test_per_endpoint_counters_split_kinds(self):
        self.bridge.enqueue(_frame("environment", "rec-1"))
        self.bridge.enqueue(_frame("camera", "rec-2"))
        self.bridge.enqueue(_frame("location", "rec-3"))
        # 一轮 flush 内每个非批量端点各发队头一条（三类各一条 → 一轮发完）
        self.assertTrue(self.bridge.flush_once())
        self.assertFalse(self.bridge.flush_once(), "队列已空，无进展")
        by_endpoint = self.bridge.health()["stats"]["by_endpoint"]
        self.assertEqual(by_endpoint["environment"]["sent"], 1)
        self.assertEqual(by_endpoint["camera"]["sent"], 1)
        self.assertEqual(by_endpoint["location"]["sent"], 1)

    def test_duplicate_response_counts_as_duplicate_not_sent(self):
        self.opener.responses = [(200, {"accepted": False, "skipped": True, "record_id": "rec-env"})]
        self.bridge.enqueue(_frame("environment", "rec-env"))
        self.assertTrue(self.bridge.flush_once())
        stats = self.bridge.health()["stats"]
        self.assertEqual(stats["duplicates"], 1)
        self.assertEqual(stats["sent"], 0)
        self.assertEqual(stats["by_endpoint"]["environment"]["duplicates"], 1)
        # 明细：命中的重放不进 sent 明细（便于事后核对"平台里有没有这条"）
        self.assertEqual(stats["sent_record_ids"], [])
        self.assertEqual(self.bridge.health()["buffer"], 0, "重放命中即视为已投递，不留在队列")

    def test_platform_explicit_rejection_goes_to_dead_letter(self):
        self.opener.responses = [(400, {"accepted": False, "skipped": False, "error": "租户上下文缺失"})]
        self.bridge.enqueue(_frame("environment", "rec-bad"))
        self.assertTrue(self.bridge.flush_once())
        stats = self.bridge.health()["stats"]
        self.assertEqual(stats["rejected"], 1)
        self.assertEqual(self.bridge.health()["buffer"], 0)
        with open(f"{self.queue}.dead-letter.jsonl", encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual([r["record_id"] for r in rows], ["rec-bad"])

    def test_429_and_5xx_retry_without_dead_letter(self):
        self.opener.responses = [
            (429, {"error": "rate limited"}),
            (503, {"error": "upstream"}),   # 5xx 同样重试
            (200, {"accepted": True}),
        ]
        self.bridge.enqueue(_frame("camera", "rec-retry"))
        self.assertFalse(self.bridge.flush_once(), "429 → 重试")
        self.assertEqual(self.bridge.health()["buffer"], 1, "限流时帧必须留在队列等待重试")
        self.assertEqual(self.bridge.health()["stats"]["rejected"], 0, "限流绝不转死信")
        self.assertFalse(self.bridge.flush_once(), "503 → 重试")
        self.assertEqual(self.bridge.health()["buffer"], 1)
        # 第三次投递成功 → 队列清空
        self.assertTrue(self.bridge.flush_once())
        self.assertEqual(self.bridge.health()["buffer"], 0)
        self.assertEqual(self.bridge.health()["stats"]["sent"], 1)
        self.assertEqual(self.bridge.health()["stats"]["retried"], 2)

    def test_network_error_keeps_frame_for_retry(self):
        self.opener.responses = [urllib.error.URLError("connection refused")]
        self.bridge.enqueue(_frame("location", "rec-net"))
        self.assertFalse(self.bridge.flush_once())
        self.assertEqual(self.bridge.health()["buffer"], 1)
        self.assertEqual(self.bridge.health()["stats"]["retried"], 1)

    def test_non_normalized_frame_is_counted_not_crashed(self):
        self.bridge.enqueue({"foo": "bar"})
        self.bridge.enqueue({"uplink": {"endpoint": "environment"}})  # 缺 payload
        stats = self.bridge.health()["stats"]
        self.assertEqual(stats["dropped_invalid"], 2)
        self.assertFalse(self.bridge.flush_once())


class SensorUplinkOfflineBufferTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.queue = os.path.join(self.tmp, "sensor-uplink.jsonl")

    def test_offline_frames_survive_restart_and_replay(self):
        failing = _FakeOpener([urllib.error.URLError("offline")] * 2)
        bridge = SensorUplinkBridge(
            bus=MessageBus(), spark_url="http://127.0.0.1:3100", queue_path=self.queue, opener=failing,
        )
        bridge.enqueue(_frame("environment", "rec-off-1"))
        bridge.enqueue(_frame("camera", "rec-off-2"))
        self.assertFalse(bridge.flush_once())
        self.assertEqual(bridge.health()["buffer"], 2)
        bridge.stop()

        # 队列已落盘：新实例（模拟边缘进程重启）加载后继续投递
        with open(self.queue, encoding="utf-8") as fh:
            persisted = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual({r["record_id"] for r in persisted}, {"rec-off-1", "rec-off-2"})

        healthy = _FakeOpener()
        revived = SensorUplinkBridge(
            bus=MessageBus(), spark_url="http://127.0.0.1:3100", queue_path=self.queue, opener=healthy,
        )
        self.assertEqual(revived.health()["buffer"], 2)
        self.assertEqual(revived.health()["stats"]["replayed"], 2)
        self.assertTrue(revived.flush_once())
        self.assertEqual(sorted(healthy.paths()), ["camera", "environment"])
        self.assertEqual(revived.health()["buffer"], 0)
        revived.stop()

    def test_truncated_queue_tail_is_skipped_not_fatal(self):
        with open(self.queue, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(_entry("environment", "rec-ok")) + "\n")
            fh.write('{"endpoint": "environment", "payload": {"record_id": "rec-half"')  # 崩溃残留半行
        opener = _FakeOpener()
        bridge = SensorUplinkBridge(
            bus=MessageBus(), spark_url="http://127.0.0.1:3100", queue_path=self.queue, opener=opener,
        )
        self.assertEqual(bridge.health()["buffer"], 1)
        self.assertTrue(bridge.flush_once())
        self.assertEqual(opener.paths(), ["environment"])
        bridge.stop()

    def test_buffer_is_bounded_and_drops_oldest(self):
        bridge = SensorUplinkBridge(
            bus=MessageBus(), spark_url="http://127.0.0.1:3100", queue_path="", opener=_FakeOpener(),
        )
        for index in range(MAX_BUFFER + 5):
            bridge.enqueue(_frame("environment", f"rec-{index}"))
        health = bridge.health()
        self.assertEqual(health["buffer"], MAX_BUFFER)
        self.assertEqual(health["stats"]["dropped_overflow"], 5)
        bridge.stop()

    def test_enqueue_during_compaction_is_not_lost(self):
        """UR8（2026-09-13 审查）：压实（快照→写 tmp→os.replace）与入队追加并发时，
        追加进旧 inode 的行会被 replace 丢弃——进程此刻崩溃即丢帧，违背
        "入队即落盘（崩溃安全）"。修复后 _append_file 与 _persist 同锁串行：
        并发入队的帧要么在快照里、要么在 replace 之后写进新文件，二者必居其一。

        测试用受控的 os.replace 钩子固定交错点：压实停在 replace 前，另一线程
        完成一次完整入队，再放行 replace——旧实现必丢行（红），新实现必保留（绿）。
        """
        import threading
        from unittest import mock

        bridge = SensorUplinkBridge(
            bus=MessageBus(), spark_url="http://127.0.0.1:3100", queue_path=self.queue, opener=_FakeOpener(),
        )
        bridge.enqueue(_frame("environment", "rec-base"))
        self.assertEqual(bridge.health()["buffer"], 1)

        real_replace = os.replace
        at_replace = threading.Event()
        proceed = threading.Event()

        def slow_replace(src, dst):
            at_replace.set()  # 压实已快照（不含并发帧），停在替换前一刻
            proceed.wait(2)
            real_replace(src, dst)

        enqueued = threading.Event()

        def do_enqueue():
            bridge.enqueue(_frame("environment", "rec-race"))
            enqueued.set()

        with mock.patch("os.replace", slow_replace):
            compactor = threading.Thread(target=bridge._persist)
            compactor.start()
            self.assertTrue(at_replace.wait(2), "压实未到达 replace 交错点")
            writer = threading.Thread(target=do_enqueue)
            writer.start()
            # 旧实现：此刻并发帧的行已写进旧 inode，即将被 replace 丢弃；
            # 新实现：_append_file 在等压实的锁，超时属预期（0.5s 内完成握手即可）。
            enqueued.wait(0.5)
            proceed.set()
            compactor.join(2)
            writer.join(2)
        self.assertFalse(writer.is_alive())
        with open(self.queue, encoding="utf-8") as fh:
            persisted = [json.loads(line) for line in fh if line.strip()]
        self.assertIn(
            "rec-race",
            {r["record_id"] for r in persisted},
            "并发入队帧必须落盘（崩溃安全：在快照里或在 replace 后写入新文件）",
        )
        self.assertIn("rec-base", {r["record_id"] for r in persisted})
        bridge.stop()


class SensorUplinkSecurityLifecycleTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        for key in list(os.environ):
            if key.startswith("EWOH_"):
                os.environ.pop(key, None)
        Settings.reset()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        Settings.reset()

    def test_unknown_runtime_mode_disables_insecure_http(self):
        os.environ["EWOH_RUNTIME_MODE"] = "producton"
        os.environ["EWOH_SENSOR_UPLINK_KEY"] = "secret"
        Settings.reset()
        bridge = SensorUplinkBridge(
            MessageBus(), "http://127.0.0.1:3100", ingest_key="secret", opener=_FakeOpener(),
        )
        self.assertFalse(bridge.enabled)
        self.assertEqual(bridge.health()["disabled_reason"], "insecure_http_in_production")

    def test_settings_failure_disables_insecure_http(self):
        with unittest.mock.patch.object(Settings, "load", side_effect=RuntimeError("config unavailable")):
            bridge = SensorUplinkBridge(
                MessageBus(), "http://127.0.0.1:3100", ingest_key="secret", opener=_FakeOpener(),
            )
        self.assertFalse(bridge.enabled)
        self.assertEqual(bridge.health()["disabled_reason"], "insecure_http_in_production")

    def test_stop_unsubscribes_and_restart_does_not_duplicate_subscription(self):
        bus = MessageBus()
        bridge = SensorUplinkBridge(
            bus=bus, spark_url="http://127.0.0.1:3100", opener=_FakeOpener(),
        )
        bridge.start()
        self.assertEqual(len(bus._subs[STREAM_SENSOR_FRAMES]), 1)
        bridge.stop()
        self.assertEqual(len(bus._subs[STREAM_SENSOR_FRAMES]), 0)
        bridge.start()
        self.assertEqual(len(bus._subs[STREAM_SENSOR_FRAMES]), 1)
        bridge.stop()


class SensorUplinkRetargetTest(unittest.TestCase):
    """断网恢复：同一实例原地切换目标（避免换桥造成的订阅空窗/双写队列）。"""

    def test_retarget_switches_target_and_resets_backoff(self):
        bus = MessageBus()
        first = _FakeOpener([urllib.error.URLError("offline")])
        bridge = SensorUplinkBridge(
            bus=bus, spark_url="http://127.0.0.1:9", queue_path="", opener=first,
        )
        bridge.enqueue(_frame("environment", "rec-retarget"))
        self.assertFalse(bridge.flush_once(), "断网阶段：投递失败但帧留在队列")
        self.assertEqual(bridge.health()["buffer"], 1)
        self.assertGreaterEqual(bridge._consecutive_failures, 1)

        # 恢复：原地 retarget 到可用地址（订阅未变），同一份队列继续投递
        bridge.retarget("http://127.0.0.1:3100")
        self.assertEqual(bridge._consecutive_failures, 0, "切换目标必须清零退避")
        self.assertTrue(bridge.flush_once())
        self.assertEqual(bridge.health()["buffer"], 0)
        self.assertEqual(first.paths()[-1], "environment")
        self.assertTrue(first.requests[-1]["url"].startswith("http://127.0.0.1:3100"))

    def test_retarget_ignores_empty_and_same_url(self):
        bridge = SensorUplinkBridge(bus=MessageBus(), spark_url="http://a:1", queue_path="", opener=_FakeOpener())
        bridge.retarget("")
        self.assertEqual(bridge.health()["url"], "http://a:1")
        bridge.retarget("http://a:1/")
        self.assertEqual(bridge.health()["url"], "http://a:1")


if __name__ == "__main__":
    unittest.main()
