"""Edge→Cloud 事件上行测试（NO-04b：EventUplink）。

覆盖：信封契约校验 fail-closed（非法不发送计数）；合法信封入缓冲；
本地 HTTP 服务端接收批量上行（POST /api/ingest/events 载荷形状 + headers）；
网络失败批次重放（at-least-once + 退避，云端幂等去重兜底）；health 形状。
"""

import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.bridge.event_uplink import EventUplink
from edge_platform.edge.bus import MessageBus


def _envelope(event_type="EntityDeclared", event_id="EVT-1", occurred="2026-08-16T08:00:00Z"):
    now = "2026-08-16T08:00:01Z"
    return {
        "eventId": event_id,
        "eventType": event_type,
        "schemaVersion": "1.0.0",
        "occurredAt": occurred,
        "observedAt": now,
        "receivedAt": now,
        "source": "edge:world-projection",
    }


class _UplinkHandler(BaseHTTPRequestHandler):
    received_batches = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        _UplinkHandler.received_batches.append(
            {
                "path": self.path,
                "headers": dict(self.headers),
                "body": json.loads(body.decode("utf-8")),
            }
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

    def log_message(self, *args):  # 静默访问日志
        return


class EventUplinkTest(unittest.TestCase):
    def setUp(self):
        _UplinkHandler.received_batches = []
        self.bus = MessageBus()
        self.httpd = HTTPServer(("127.0.0.1", 0), _UplinkHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)

    def test_invalid_envelope_dropped_counted(self):
        uplink = EventUplink(self.bus, f"http://127.0.0.1:{self.port}")
        uplink._enqueue({"envelope": {"eventId": "x", "eventType": "EntityDeclared"}})
        uplink._enqueue({"no_envelope": True})
        health = uplink.health()
        self.assertEqual(health["stats"]["dropped_invalid"], 2)
        self.assertEqual(health["buffer"], 0)

    def test_valid_envelope_buffered_and_posted(self):
        uplink = EventUplink(self.bus, f"http://127.0.0.1:{self.port}")
        uplink._enqueue({"envelope": _envelope()})
        self.assertEqual(uplink.health()["buffer"], 1)
        ok = uplink._post_batch(uplink._drain())
        self.assertTrue(ok)
        deadline = time.time() + 3
        while time.time() < deadline and not _UplinkHandler.received_batches:
            time.sleep(0.05)
        self.assertEqual(len(_UplinkHandler.received_batches), 1)
        posted = _UplinkHandler.received_batches[0]
        self.assertEqual(posted["path"], "/api/ingest/events")
        self.assertEqual(posted["body"]["events"][0]["eventType"], "EntityDeclared")

    def test_post_failure_keeps_batch(self):
        # 未监听端口 → 连接失败 → 批次回到缓冲（at-least-once）
        uplink = EventUplink(self.bus, "http://127.0.0.1:1")
        uplink._enqueue({"envelope": _envelope(event_id="EVT-FAIL")})
        batch = uplink._drain()
        self.assertFalse(uplink._post_batch(batch))
        self.assertEqual(uplink.health()["stats"]["failures"], 0)  # 直调不计数（loop 计数）
        self.assertEqual(len(batch), 1)

    def test_loop_failure_counts_stats(self):
        """EDT-007：loop 路径的失败计数真正被测——指向不可达端口启动 loop，
        发布事件后按 deadline 轮询断言 failures ≥ 1 且批次保留在缓冲。"""
        uplink = EventUplink(self.bus, "http://127.0.0.1:1", queue_path="")
        uplink.start()
        try:
            self.bus.publish("events", {"envelope": _envelope(event_id="EVT-LOOP-FAIL")})
            deadline = time.time() + 10
            while time.time() < deadline and uplink.health()["stats"]["failures"] < 1:
                time.sleep(0.05)
            stats = uplink.health()["stats"]
            self.assertGreaterEqual(stats["failures"], 1, "loop 发送失败应计入 failures")
            self.assertGreaterEqual(uplink.health()["buffer"], 1, "失败批次应保留在缓冲（at-least-once）")
        finally:
            uplink.stop()

    def test_headers_and_batch_limit(self):
        uplink = EventUplink(
            self.bus,
            f"http://127.0.0.1:{self.port}",
            ingest_key="KEY-1",
            org_id="ORG-1",
            batch_size=2,
        )
        for i in range(3):
            uplink._enqueue({"envelope": _envelope(event_id=f"EVT-{i}")})
        batch = uplink._drain()
        self.assertEqual(len(batch), 2)
        self.assertTrue(uplink._post_batch(batch))
        deadline = time.time() + 3
        while time.time() < deadline and not _UplinkHandler.received_batches:
            time.sleep(0.05)
        posted = _UplinkHandler.received_batches[0]
        self.assertEqual(posted["headers"].get("X-Ingest-Key"), "KEY-1")
        self.assertEqual(posted["headers"].get("X-Org-Id"), "ORG-1")

    def test_loop_drains_and_posts(self):
        uplink = EventUplink(self.bus, f"http://127.0.0.1:{self.port}")
        uplink.start()
        try:
            self.bus.publish("events", {"envelope": _envelope(event_id="EVT-LOOP")})
            deadline = time.time() + 5
            while time.time() < deadline and not _UplinkHandler.received_batches:
                time.sleep(0.05)
            self.assertEqual(len(_UplinkHandler.received_batches), 1)
            self.assertEqual(uplink.health()["stats"]["sent"], 1)
        finally:
            uplink.stop()

    def test_cross_restart_resume_from_queue(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            queue_path = os.path.join(tmp, "uplink-queue.json")
            # 首次进程：入队（未发送，无法直连云端的占位 URL）
            uplink1 = EventUplink(self.bus, "http://127.0.0.1:1", queue_path=queue_path)
            uplink1._enqueue({"envelope": _envelope(event_id="EVT-RESUME")})
            self.assertTrue(os.path.exists(queue_path))
            # 模拟进程重启：新实例从队列文件恢复未发送批次
            uplink2 = EventUplink(self.bus, f"http://127.0.0.1:{self.port}", queue_path=queue_path)
            self.assertEqual(uplink2.health()["buffer"], 1)
            batch = uplink2._drain()
            self.assertTrue(uplink2._post_batch(batch))
            with uplink2._lock:
                uplink2._persist()  # 成功截断
            deadline = time.time() + 3
            while time.time() < deadline and not _UplinkHandler.received_batches:
                time.sleep(0.05)
            self.assertEqual(len(_UplinkHandler.received_batches), 1)
            self.assertEqual(
                _UplinkHandler.received_batches[0]["body"]["events"][0]["eventId"], "EVT-RESUME"
            )
            # 队列文件已被截断为空
            import json as _json

            with open(queue_path, encoding="utf-8") as fh:
                self.assertEqual(_json.load(fh), [])


if __name__ == "__main__":
    unittest.main()
