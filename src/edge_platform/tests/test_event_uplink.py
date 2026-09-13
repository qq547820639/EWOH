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

from edge_platform.edge.bridge import event_uplink
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
        # 未监听端口 → 连接失败 → 瞬态失败可重试（at-least-once）
        uplink = EventUplink(self.bus, "http://127.0.0.1:1")
        uplink._enqueue({"envelope": _envelope(event_id="EVT-FAIL")})
        batch = uplink._drain()
        self.assertEqual(uplink._post_batch(batch), "retry")
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
        self.assertEqual(uplink._post_batch(batch), "ok")
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
            # 等到**这一条**事件被投递（而不是"列表非空"）：整仓测试并行/高负载时
            # 固定 5s 轮询会偶发超时（实测全量套件跑动时出现 1 次假失败），
            # 且"列表非空"无法区分是本用例的事件还是上一个用例的残留。
            deadline = time.time() + 20
            delivered = False
            while time.time() < deadline:
                for batch in _UplinkHandler.received_batches:
                    envelopes = (batch.get("body") or {}).get("events") or []
                    if any(
                        isinstance(e, dict)
                        and (e.get("eventId") == "EVT-LOOP"
                             or (e.get("envelope") or {}).get("eventId") == "EVT-LOOP")
                        for e in envelopes
                    ):
                        delivered = True
                        break
                if delivered:
                    break
                time.sleep(0.05)
            self.assertTrue(delivered, "EVT-LOOP 未在 20s 内送达（上行链路异常，而非测试超时）")
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
            # 模拟进程重启：新实例从队列文件恢复未发送批次（JSONL 格式）
            uplink2 = EventUplink(self.bus, f"http://127.0.0.1:{self.port}", queue_path=queue_path)
            self.assertEqual(uplink2.health()["buffer"], 1)
            batch = uplink2._drain()
            self.assertEqual(uplink2._post_batch(batch), "ok")
            with uplink2._lock:
                uplink2._persist()  # 成功截断
            deadline = time.time() + 3
            while time.time() < deadline and not _UplinkHandler.received_batches:
                time.sleep(0.05)
            self.assertEqual(len(_UplinkHandler.received_batches), 1)
            self.assertEqual(
                _UplinkHandler.received_batches[0]["body"]["events"][0]["eventId"], "EVT-RESUME"
            )
            # 队列文件已被截断为空（JSONL：0 行）
            with open(queue_path, encoding="utf-8") as fh:
                self.assertEqual(fh.read().strip(), "")

    def test_legacy_json_array_queue_loadable(self):
        """旧全量重写格式（JSON 数组）的存量队列文件仍可恢复。"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            queue_path = os.path.join(tmp, "uplink-queue.json")
            with open(queue_path, "w", encoding="utf-8") as fh:
                json.dump([_envelope(event_id="EVT-LEGACY")], fh, ensure_ascii=False)
            uplink = EventUplink(self.bus, f"http://127.0.0.1:{self.port}", queue_path=queue_path)
            self.assertEqual(uplink.health()["buffer"], 1)
            self.assertEqual(uplink._drain()[0]["eventId"], "EVT-LEGACY")

    def test_poison_batch_dead_lettered_not_blocking(self):
        """P1（2026-08-19 审计）：毒信封 dead-letter——队头信封连续失败达到
        MAX_BATCH_ATTEMPTS 次后被剔除转死信文件，后续批次正常上行（不再永久
        阻塞队头）。驱动真实 _loop（退避打桩加速）。"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            queue_path = os.path.join(tmp, "uplink-queue.json")
            uplink = EventUplink(self.bus, "http://127.0.0.1:1", queue_path=queue_path)
            uplink._backoff = lambda: None  # 测试加速：跳过退避 sleep
            # 含毒信封（EVT-POISON）的批次持续失败；不含的正常成功
            uplink._post_batch = (
                lambda batch: "retry"
                if any(e.get("eventId") == "EVT-POISON" for e in batch)
                else "ok"
            )
            uplink._enqueue({"envelope": _envelope(event_id="EVT-POISON")})
            uplink._enqueue({"envelope": _envelope(event_id="EVT-AFTER")})
            uplink.start()
            try:
                # 等待毒信封剔除 + 后续批次投递成功
                deadline = time.time() + 10
                while time.time() < deadline:
                    stats = uplink.health()["stats"]
                    if stats["dead_lettered"] >= 1 and stats["sent"] >= 1:
                        break
                    time.sleep(0.02)
                stats = uplink.health()["stats"]
                self.assertEqual(stats["dead_lettered"], 1, "毒信封应剔除转死信（且仅它一条）")
                self.assertEqual(stats["sent"], 1, "后续批次应正常上行（不被阻塞）")
                self.assertEqual(uplink.health()["buffer"], 0)
                # 死信文件落盘且可解析（人工重放载体），内容是毒信封
                dl_path = f"{queue_path}.dead-letter.jsonl"
                self.assertTrue(os.path.exists(dl_path))
                with open(dl_path, encoding="utf-8") as fh:
                    lines = [json.loads(line) for line in fh if line.strip()]
                self.assertEqual([e["eventId"] for e in lines], ["EVT-POISON"])
            finally:
                uplink.stop()

    def test_cloud_4xx_reject_goes_dead_letter(self):
        """P1：云端 4xx（非 429）拒绝 → 立即 dead_letter（重试无意义）。"""

        class _RejectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": false}')

            def log_message(self, *args):
                return

        reject_httpd = HTTPServer(("127.0.0.1", 0), _RejectHandler)
        reject_port = reject_httpd.server_address[1]
        threading.Thread(target=reject_httpd.serve_forever, daemon=True).start()
        try:
            uplink = EventUplink(self.bus, f"http://127.0.0.1:{reject_port}")
            uplink._enqueue({"envelope": _envelope(event_id="EVT-REJECT")})
            self.assertEqual(uplink._post_batch(uplink._drain()), "dead_letter")
        finally:
            reject_httpd.shutdown()
            reject_httpd.server_close()

    def test_buffer_bounded_drops_oldest(self):
        """P1：离线缓冲有界——满时丢最旧（dropped_overflow 计数），新事件优先。"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            queue_path = os.path.join(tmp, "uplink-queue.json")
            uplink = EventUplink(self.bus, "http://127.0.0.1:1", queue_path=queue_path)
            for i in range(event_uplink.MAX_BUFFER + 2):
                uplink._enqueue({"envelope": _envelope(event_id=f"EVT-CAP-{i}")})
            health = uplink.health()
            self.assertEqual(health["buffer"], event_uplink.MAX_BUFFER, "缓冲以 MAX_BUFFER 为界")
            self.assertEqual(health["stats"]["dropped_overflow"], 2, "溢出丢弃计数")
            # 最旧 2 条被丢弃，队头是 EVT-CAP-2
            self.assertEqual(uplink._drain()[0]["eventId"], "EVT-CAP-2")

    def test_jsonl_tail_truncated_line_skipped(self):
        """P1：JSONL 尾部半行（崩溃残留）加载时显式跳过，不影响其余行。"""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            queue_path = os.path.join(tmp, "uplink-queue.json")
            with open(queue_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(_envelope(event_id="EVT-OK"), ensure_ascii=False) + "\n")
                fh.write('{"eventId": "EVT-HALF"')  # 无换行的半行
            uplink = EventUplink(self.bus, f"http://127.0.0.1:{self.port}", queue_path=queue_path)
            self.assertEqual(uplink.health()["buffer"], 1)
            self.assertEqual(uplink._drain()[0]["eventId"], "EVT-OK")


if __name__ == "__main__":
    unittest.main()
