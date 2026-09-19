"""上行桥批量逐帧对账单测（NO-68g 评审补强）。

覆盖两个通道的"2xx 批量响应含逐帧 results"分类语义（此前 2xx 一律整组记
sent——平台逐帧拒绝被记成发送成功，账目失真，2026-09-15 仿真对抗实测）：

- SensorUplinkBridge._send_group（批量分支）：results 与 entries 逐帧对位，
  accepted=true → sent；accepted=false&skipped=true → duplicate；
  accepted=false → rejected + 单帧死信（record_id 进死信文件）。
- results 缺失 → 退回整组口径（不误判）。
- results 与 entries 错位（record_id 不匹配）→ 该帧退回乐观 sent。
- SparkBridge._dead_letter_per_item（edge_to_spark 通道）：rejected 帧计入
  dead_lettered 并写死信文件；skipped=true 的 duplicate 不算 rejected。

不依赖真实后端：_post / resp 以桩替换。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from edge_platform.edge.bridge.edge_to_spark import SparkBridge
from edge_platform.edge.bridge.sensor_uplink import SensorUplinkBridge
from edge_platform.edge.bus import MessageBus


def _entry(record_id: str) -> dict:
    return {
        "_uid": f"uid-{record_id}",
        "kind": "exoskeleton",
        "endpoint": "exoskeleton",
        "batch": True,
        "record_id": record_id,
        "payload": {"device_id": "EXO-01", "record_id": record_id},
    }


def _item(record_id: str, accepted: bool, skipped: bool = False, error: str | None = None) -> dict:
    out = {"record_id": record_id, "accepted": accepted, "skipped": skipped}
    if error:
        out["error"] = error
    return out


class SensorUplinkBatchClassifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.queue_path = str(Path(self.tmp.name) / "q.jsonl")
        self.bridge = SensorUplinkBridge(
            MessageBus(),
            "http://127.0.0.1:1",  # 不会被真正请求（_post 被桩替换）
            ingest_key="k",
            org_id="org",
            queue_path=self.queue_path,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _group(self, entries, results):
        self.bridge._post = lambda path, body: (201, {"results": results})
        return self.bridge._send_group("exoskeleton", entries)

    def test_mixed_results_classified_per_item(self):
        """1 sent + 1 duplicate + 1 rejected：逐帧分类，rejected 转死信。"""
        entries = [_entry("R1"), _entry("R2"), _entry("R3")]
        results = [
            _item("R1", accepted=True),
            _item("R2", accepted=False, skipped=True),
            _item("R3", accepted=False, error="CLOCK_DRIFT_FUTURE_TS"),
        ]
        verdict = self._group(entries, results)
        self.assertEqual(verdict, "sent")
        stats = self.bridge._stats
        self.assertEqual(stats["sent"], 1)
        self.assertEqual(stats["duplicates"], 1)
        self.assertEqual(stats["rejected"], 1)
        # rejected 帧必须移出缓冲且死信文件留 record_id 痕
        self.assertEqual([e["record_id"] for e in self.bridge._buffer], [])
        with open(f"{self.queue_path}.dead-letter.jsonl", encoding="utf-8") as fh:
            dead = [json.loads(line) for line in fh if line.strip()]
        self.assertIn("R3", [d["payload"]["record_id"] for d in dead])

    def test_missing_results_falls_back_to_group_accounting(self):
        """无 results（旧平台）→ 整组按 sent 计（原口径，不误判）。"""
        entries = [_entry("R1"), _entry("R2")]
        self.bridge._post = lambda path, body: (201, {"total": 2})
        verdict = self.bridge._send_group("exoskeleton", entries)
        self.assertEqual(verdict, "sent")
        self.assertEqual(self.bridge._stats["sent"], 2)

    def test_record_id_mismatch_falls_back_to_optimistic(self):
        """results 与请求错位（record_id 对不上）→ 退回整组乐观口径。"""
        entries = [_entry("R1")]
        results = [_item("OTHER", accepted=False, error="x")]
        verdict = self._group(entries, results)
        self.assertEqual(verdict, "sent")
        self.assertEqual(self.bridge._stats["sent"], 1)
        self.assertEqual(self.bridge._stats["rejected"], 0)


class SparkBridgeDeadLetterPerItemTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.queue_path = str(Path(self.tmp.name) / "spark-q.json")
        self.bridge = SparkBridge("http://127.0.0.1:1", "k", org_id="org", queue_path=self.queue_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_rejected_items_dead_lettered(self):
        batch = [
            {"record_id": "A", "device_id": "EXO-01"},
            {"record_id": "B", "device_id": "EXO-01"},
        ]
        results = [
            _item("A", accepted=True),
            _item("B", accepted=False, error="CLOCK_DRIFT_FUTURE_TS"),
        ]

        class FakeResp:
            @staticmethod
            def read():
                return json.dumps({"results": results}).encode()

        self.bridge._dead_letter_per_item(batch, FakeResp())
        self.assertEqual(self.bridge.dead_lettered, 1)
        with open(f"{self.queue_path}.dead-letter.jsonl", encoding="utf-8") as fh:
            dead = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual(dead[0]["record_id"], "B")

    def test_skipped_duplicate_not_counted_rejected(self):
        batch = [{"record_id": "A", "device_id": "EXO-01"}]
        results = [_item("A", accepted=False, skipped=True)]

        class FakeResp:
            @staticmethod
            def read():
                return json.dumps({"results": results}).encode()

        self.bridge._dead_letter_per_item(batch, FakeResp())
        self.assertEqual(self.bridge.dead_lettered, 0)


if __name__ == "__main__":
    unittest.main()
