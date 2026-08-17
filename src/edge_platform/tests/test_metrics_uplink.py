"""MetricsUplink 测试（ADR-028 / NO-12d，§19 指标腿 Edge→Cloud 上行）。

覆盖：snapshot → 规范样本映射（与 exporter METRIC_DEFS 单一事实源一致，
edge_id 标签全量附加，ewoh_db_count 带 table 标签按序稳定）、POST 批次
（成功/HTTP 非 2xx/URLError 退避路径）、health 统计、非法数值归 0 不炸。
HTTP 以 urllib 桩替换（纯单元，不发真实请求）。
"""

from __future__ import annotations

import json
import time
import unittest
import urllib.error
from unittest import mock

from edge_platform.edge.bridge.metrics_uplink import MetricsUplink
from edge_platform.monitoring import MetricsCollector
from edge_platform.monitoring.exporter import METRIC_DEFS


def _snapshot_fixture():
    return {
        "uptime_seconds": 12.3,
        "db_counts": {"devices": 4, "events": 9},
        "online_count": 3,
        "offline_count": 1,
        "avg_packet_loss_pct": 0.5,
        "low_battery_count": 2,
        "inference_count": 10,
        "inference_p50_ms": 1.5,
        "inference_p95_ms": 3.0,
        "unknown_count": 1,
        "error_count": 0,
        "open_event_count": 2,
        "event_open_total": 5,
        "avg_event_close_hours": 1.25,
        "assignment_adoption_rate": 0.6,
        "recommendation_count": 10,
        "confirmed_count": 6,
        "event_bus_handler_errors_total": 0,
    }


class TestMetricsUplink(unittest.TestCase):
    def test_build_samples_consistency_with_exporter_defs(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        samples = uplink.build_samples(_snapshot_fixture())
        scalar_defs = [d for d in METRIC_DEFS if d[4] is None]
        db_defs = [d for d in METRIC_DEFS if d[4] is not None]
        # 标量 1:1；db_count 按 table 展开（fixture 2 张表）
        self.assertEqual(len(samples), len(scalar_defs) + 2 * len(db_defs))
        # 所有样本带 edge_id；db_count 带 table
        for s in samples:
            self.assertEqual(s["labels"]["edge_id"], "edge-a")
        db_samples = [s for s in samples if s["metricName"] == "ewoh_db_count"]
        self.assertEqual({s["labels"]["table"] for s in db_samples}, {"devices", "events"})
        # 值映射抽查
        by_name = {s["metricName"]: s for s in samples if s["metricName"] == "ewoh_uptime_seconds"}
        self.assertEqual(by_name["ewoh_uptime_seconds"]["value"], 12.3)
        self.assertEqual(by_name["ewoh_uptime_seconds"]["metricType"], "gauge")

    def test_invalid_value_normalizes_to_zero(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        samples = uplink.build_samples({"uptime_seconds": None})
        self.assertEqual(samples[0]["value"], 0.0)

    def test_post_batch_success(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        resp = mock.Mock(status=200)
        with mock.patch("urllib.request.urlopen", return_value=mock.MagicMock(__enter__=mock.Mock(return_value=resp), __exit__=mock.Mock(return_value=False))) as fake, \
             mock.patch("urllib.request.Request") as req:
            ok = uplink._post_batch([{"metricName": "ewoh_uptime_seconds"}])
        self.assertTrue(ok)
        req.assert_called_once()
        body = json.loads(req.call_args.kwargs["data"])
        self.assertIn("metrics", body)

    def test_post_batch_http_error(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        resp = mock.Mock(status=500)
        with mock.patch("urllib.request.urlopen", return_value=mock.MagicMock(__enter__=mock.Mock(return_value=resp), __exit__=mock.Mock(return_value=False))):
            self.assertFalse(uplink._post_batch([]))

    def test_post_batch_url_error(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            self.assertFalse(uplink._post_batch([]))

    def test_health_stats(self):
        uplink = MetricsUplink(MetricsCollector(), "http://cloud", edge_id="edge-a")
        h = uplink.health()
        self.assertTrue(h["enabled"])
        self.assertEqual(h["edge_id"], "edge-a")
        self.assertEqual(h["stats"]["sent_samples"], 0)

    def test_disabled_when_url_empty(self):
        uplink = MetricsUplink(MetricsCollector(), "", edge_id="edge-a")
        self.assertFalse(uplink.enabled)

    def test_loop_cycle_counts_stats(self):
        """一轮循环：快照→发送成功→sent_samples/batches 累计（周期 5s 最小）。

        EDT-009：以 deadline 条件轮询替代固定 time.sleep(0.5)——慢机环境下
        等待首轮循环真正完成，消除 batches 计数的偶发抖动。
        """
        collector = MetricsCollector()
        uplink = MetricsUplink(collector, "http://cloud", edge_id="edge-a", interval_sec=5)
        resp = mock.Mock(status=200)
        with mock.patch("urllib.request.urlopen", return_value=mock.MagicMock(__enter__=mock.Mock(return_value=resp), __exit__=mock.Mock(return_value=False))):
            uplink.start()
            try:
                deadline = time.time() + 8.0
                while time.time() < deadline and uplink.health()["stats"]["batches"] < 1:
                    time.sleep(0.05)
            finally:
                uplink.stop()
                time.sleep(0.2)
        h = uplink.health()
        self.assertGreaterEqual(h["stats"]["batches"], 1)
        self.assertGreater(h["stats"]["sent_samples"], 0)
        self.assertIsNotNone(h["stats"]["last_success_ts"])


if __name__ == "__main__":
    unittest.main()
