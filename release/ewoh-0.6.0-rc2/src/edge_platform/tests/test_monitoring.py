"""Task 33 监控指标体系单元测试。

覆盖：
- MetricsCollector：四层指标采集（系统/设备/推理/业务）、线程安全、reset、snapshot 派生
- PrometheusExporter：exposition format（# HELP / # TYPE / metric{labels} value）
- server.py 新增 /metrics 与 /api/inference/metrics 路由（直接调用 Handler 方法，避免多线程）

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_monitoring -v
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs
from edge_platform.monitoring import MetricsCollector, PrometheusExporter


# ---------- MetricsCollector ----------
class MetricsCollectorTest(unittest.TestCase):
    def test_initial_snapshot_has_zero_counts(self):
        c = MetricsCollector()
        snap = c.snapshot()
        self.assertGreaterEqual(snap["uptime_seconds"], 0.0)
        self.assertEqual(snap["inference_count"], 0)
        self.assertEqual(snap["inference_p50_ms"], 0.0)
        self.assertEqual(snap["inference_p95_ms"], 0.0)
        self.assertEqual(snap["unknown_count"], 0)
        self.assertEqual(snap["error_count"], 0)
        self.assertEqual(snap["open_event_count"], 0)
        self.assertEqual(snap["avg_event_close_hours"], 0.0)
        self.assertEqual(snap["assignment_adoption_rate"], 0.0)
        self.assertEqual(snap["online_count"], 0)
        self.assertEqual(snap["offline_count"], 0)
        self.assertEqual(snap["low_battery_count"], 0)
        self.assertEqual(snap["db_counts"], {})

    def test_record_inference_counts_and_percentiles(self):
        c = MetricsCollector()
        for ms in [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]:
            c.record_inference(ms, "stand")
        # unknown 计入 unknown_count 但不影响 P50/P95 样本
        c.record_inference(15, "unknown")
        # error 计入 error_count，不计入 P50/P95 样本，也不计入 inference_count 之外的样本
        c.record_inference(999, "stand", error=True)
        snap = c.snapshot()
        self.assertEqual(snap["inference_count"], 12)  # 10 stand + 1 unknown + 1 error
        self.assertEqual(snap["unknown_count"], 1)
        self.assertEqual(snap["error_count"], 1)
        # P50 应位于 10 个正常样本的中位附近（不含 unknown 的耗时？实际含）
        # 注意：unknown 的 15ms 也作为耗时样本进入百分位计算
        self.assertGreater(snap["inference_p50_ms"], 0)
        self.assertGreaterEqual(snap["inference_p95_ms"], snap["inference_p50_ms"])

    def test_record_inference_invalid_duration_does_not_crash(self):
        c = MetricsCollector()
        c.record_inference("not-a-number", "stand")  # type: ignore[arg-type]
        c.record_inference(None, "stand")  # type: ignore[arg-type]
        snap = c.snapshot()
        # 计数仍累加，仅耗时样本被丢弃
        self.assertEqual(snap["inference_count"], 2)
        self.assertEqual(snap["inference_p50_ms"], 0.0)

    def test_event_open_close_tracking(self):
        c = MetricsCollector()
        c.record_event_open()
        c.record_event_open()
        c.record_event_close(2.5)
        c.record_event_close(7.5)
        snap = c.snapshot()
        self.assertEqual(snap["event_open_total"], 2)
        self.assertAlmostEqual(snap["avg_event_close_hours"], 5.0, places=3)

    def test_event_close_invalid_duration_ignored(self):
        c = MetricsCollector()
        c.record_event_close("oops")  # type: ignore[arg-type]
        c.record_event_close(None)  # type: ignore[arg-type]
        snap = c.snapshot()
        self.assertEqual(snap["avg_event_close_hours"], 0.0)

    def test_assignment_adoption_rate(self):
        c = MetricsCollector()
        # 无推荐时 → 0
        self.assertEqual(c.snapshot()["assignment_adoption_rate"], 0.0)
        c.record_recommendation()
        c.record_recommendation()
        c.record_recommendation()
        c.record_assignment_confirmed()
        snap = c.snapshot()
        self.assertEqual(snap["recommendation_count"], 3)
        self.assertEqual(snap["confirmed_count"], 1)
        self.assertAlmostEqual(snap["assignment_adoption_rate"], 1 / 3, places=4)

    def test_set_device_stats(self):
        c = MetricsCollector()
        c.set_device_stats(online_count=5, offline_count=2, avg_packet_loss_pct=3.5, low_battery_count=1)
        snap = c.snapshot()
        self.assertEqual(snap["online_count"], 5)
        self.assertEqual(snap["offline_count"], 2)
        self.assertAlmostEqual(snap["avg_packet_loss_pct"], 3.5, places=3)
        self.assertEqual(snap["low_battery_count"], 1)

    def test_set_db_counts(self):
        c = MetricsCollector()
        c.set_db_counts({"device": 3, "person": 5, "risk_event": 7})
        snap = c.snapshot()
        self.assertEqual(snap["db_counts"], {"device": 3, "person": 5, "risk_event": 7})

    def test_snapshot_derives_db_counts_from_storage(self):
        storage = stubs.Storage(":memory:")
        try:
            storage.upsert_device(device_id="EXO-1", model="M", source_type="simulated")
            storage.upsert_person(person_id="P-1", display_name="A")
            storage.insert_event(
                {
                    "event_id": "EVT-1",
                    "event_code": "X",
                    "severity": "L1",
                    "status": "open",
                    "start_time": "2026-07-31T00:00:00+08:00",
                    "trigger": {},
                    "evidence": {},
                    "source_type": "simulated",
                }
            )
            c = MetricsCollector(storage=storage)
            snap = c.snapshot()
            self.assertEqual(snap["db_counts"]["device"], 1)
            self.assertEqual(snap["db_counts"]["person"], 1)
            self.assertEqual(snap["open_event_count"], 1)
        finally:
            storage.close()

    def test_reset_clears_all(self):
        c = MetricsCollector()
        c.record_inference(10, "stand")
        c.record_event_open()
        c.record_event_close(1.0)
        c.record_recommendation()
        c.record_assignment_confirmed()
        c.set_device_stats(1, 1)
        c.set_db_counts({"x": 1})
        old_start = c._start
        time.sleep(0.01)
        c.reset()
        new_start = c._start
        self.assertGreater(new_start, old_start)
        snap = c.snapshot()
        self.assertEqual(snap["inference_count"], 0)
        self.assertEqual(snap["event_open_total"], 0)
        self.assertEqual(snap["avg_event_close_hours"], 0.0)
        self.assertEqual(snap["recommendation_count"], 0)
        self.assertEqual(snap["confirmed_count"], 0)
        self.assertEqual(snap["online_count"], 0)
        self.assertEqual(snap["db_counts"], {})

    def test_thread_safety_under_concurrency(self):
        """并发 record_inference 不丢计数、不抛异常。"""
        c = MetricsCollector()
        N_THREADS = 8
        N_PER_THREAD = 200

        def worker():
            for i in range(N_PER_THREAD):
                c.record_inference(float(i % 50), "stand" if i % 2 else "walk")

        threads = [threading.Thread(target=worker) for _ in range(N_THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        snap = c.snapshot()
        self.assertEqual(snap["inference_count"], N_THREADS * N_PER_THREAD)


# ---------- PrometheusExporter ----------
class PrometheusExporterTest(unittest.TestCase):
    def test_format_contains_help_and_type(self):
        c = MetricsCollector()
        c.record_inference(10.0, "stand")
        text = PrometheusExporter().format_prometheus(c.snapshot())
        self.assertIn("# HELP ewoh_uptime_seconds", text)
        self.assertIn("# TYPE ewoh_uptime_seconds gauge", text)
        self.assertIn("# TYPE ewoh_inference_count_total counter", text)
        self.assertIn("ewoh_inference_count_total 1", text)

    def test_format_db_counts_with_labels(self):
        c = MetricsCollector()
        c.set_db_counts({"device": 3, "person": 5})
        text = PrometheusExporter().format_prometheus(c.snapshot())
        self.assertIn('ewoh_db_count{table="device"} 3', text)
        self.assertIn('ewoh_db_count{table="person"} 5', text)

    def test_format_empty_db_counts_emits_placeholder(self):
        c = MetricsCollector()
        text = PrometheusExporter().format_prometheus(c.snapshot())
        # 无 db_counts 时输出占位行，便于抓取端识别序列
        self.assertIn("ewoh_db_count 0", text)

    def test_format_label_escaping(self):
        c = MetricsCollector()
        # 包含反斜杠/双引号/换行的 table 名应被转义
        c.set_db_counts({'bad"name': 1, "line\nbreak": 2})
        text = PrometheusExporter().format_prometheus(c.snapshot())
        self.assertIn('ewoh_db_count{table="bad\\"name"} 1', text)
        self.assertIn('ewoh_db_count{table="line\\nbreak"} 2', text)

    def test_format_float_values(self):
        c = MetricsCollector()
        c.record_inference(12.5, "stand")
        c.record_event_close(3.25)
        text = PrometheusExporter().format_prometheus(c.snapshot())
        # P50/P95 应为数值形式
        self.assertRegex(text, r"ewoh_inference_p50_ms \d+(\.\d+)?")
        self.assertRegex(text, r"ewoh_event_avg_close_hours \d+(\.\d+)?")

    def test_format_rejects_non_dict(self):
        with self.assertRaises(TypeError):
            PrometheusExporter().format_prometheus("not a dict")  # type: ignore[arg-type]

    def test_render_requires_bound_collector(self):
        ex = PrometheusExporter()
        with self.assertRaises(RuntimeError):
            ex.render()
        c = MetricsCollector()
        ex2 = PrometheusExporter(collector=c)
        # 绑定 collector 后 render 应成功
        text = ex2.render()
        self.assertIn("# HELP ewoh_uptime_seconds", text)


# ---------- HTTP 路由 ----------
class _HandlerHarness:
    """直接构造 Handler 实例并调用其路由方法，避免多线程 HTTP 服务器导致的 SQLite
    跨线程访问段错误。

    通过重写 send_response/send_header/end_headers/wfile 捕获响应，不启动真实 socket。
    """

    def __init__(self, ctx):
        self._handler_cls = server.make_handler(ctx)

    def _make_handler(self, method, path, body=None):
        import io

        h = self._handler_cls.__new__(self._handler_cls)
        h.command = method
        h.path = path
        h.headers = {"Content-Type": "application/json"}
        body_bytes = json.dumps(body).encode("utf-8") if body is not None else b""
        h.rfile = io.BytesIO(body_bytes)
        h.headers = _FakeHeaders(
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(body_bytes)),
            }
        )
        h._resp_status = None
        h._resp_headers = {}
        h._resp_body = io.BytesIO()

        class _WFile:
            def __init__(self, buf):
                self.buf = buf

            def write(self, data):
                self.buf.write(data)

            def flush(self):
                pass

        h.wfile = _WFile(h._resp_body)

        def send_response(status):
            h._resp_status = status

        def send_header(k, v):
            h._resp_headers[k] = v

        def end_headers():
            pass

        h.send_response = send_response
        h.send_header = send_header
        h.end_headers = end_headers
        h.log_message = lambda fmt, *args: None
        return h

    def get(self, path):
        h = self._make_handler("GET", path)
        h.do_GET()
        body = h._resp_body.getvalue().decode("utf-8")
        return h._resp_status, h._resp_headers, body

    def post(self, path, body):
        h = self._make_handler("POST", path, body)
        h.do_POST()
        data = h._resp_body.getvalue().decode("utf-8")
        try:
            return h._resp_status, json.loads(data) if data else {}
        except ValueError:
            return h._resp_status, {"raw": data}


class _FakeHeaders:
    """模拟 http.client.HTTPMessage 的最小 dict-like 接口。"""

    def __init__(self, d):
        self._d = {k.lower(): v for k, v in d.items()}

    def get(self, k, default=""):
        return self._d.get(k.lower(), default)


class MonitoringRoutesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_mon_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "mon.db")
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        # 注入一条 open 事件 + 一条 inference 用于 /api/inference/metrics
        # start_time 设为 1 小前，确保关闭时长 > 0
        # person_id=P-003 避免影响 P-001 的推荐硬约束（高风险未解除）
        from datetime import datetime as _dt
        from datetime import timedelta as _td

        _evt_start = (_dt.now().astimezone() - _td(hours=1)).isoformat(timespec="milliseconds")
        self.storage.insert_event(
            {
                "event_id": "EVT-T1",
                "event_code": "LOAD_HIGH",
                "severity": "L2",
                "status": "open",
                "device_id": "EXO-003",
                "person_id": "P-003",
                "start_time": _evt_start,
                "trigger": {},
                "evidence": {},
                "source_type": "simulated",
            }
        )
        self.storage.insert_inference(
            {
                "inference_id": "INF-T1",
                "device_id": "EXO-001",
                "ts_start": "2026-07-31T10:00:00+08:00",
                "ts_end": "2026-07-31T10:00:01+08:00",
                "label": "stand",
                "source_type": "simulated",
            }
        )
        self.storage.insert_inference(
            {
                "inference_id": "INF-T2",
                "device_id": "EXO-001",
                "ts_start": "2026-07-31T10:00:01+08:00",
                "ts_end": "2026-07-31T10:00:02+08:00",
                "label": "unknown",
                "source_type": "simulated",
            }
        )
        self.metrics = MetricsCollector(storage=self.storage)
        # 预置部分推理样本，验证 /metrics 与 /api/inference/metrics 输出
        for ms in [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]:
            self.metrics.record_inference(float(ms), "stand")
        self.metrics.record_inference(12.0, "unknown")
        self.metrics.record_recommendation()
        self.metrics.record_assignment_confirmed()
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(self.storage, bus, registry, rules)
        manager = stubs.AdapterManager(self.storage, bus)
        manager.start()
        self.ctx = server.Context(
            self.storage,
            bus=bus,
            pipeline=pipeline,
            registry=registry,
            rules=rules,
            manager=manager,
            metrics=self.metrics,
        )
        self.harness = _HandlerHarness(self.ctx)
        self.addCleanup(self._teardown)

    def _teardown(self):
        self.storage.close()

    def test_metrics_route_returns_prometheus_text(self):
        status, headers, body = self.harness.get("/metrics")
        self.assertEqual(status, 200)
        self.assertIn("text/plain", headers.get("Content-Type", ""))
        self.assertIn("version=0.0.4", headers.get("Content-Type", ""))
        self.assertIn("# HELP ewoh_uptime_seconds", body)
        self.assertIn("# TYPE ewoh_inference_count_total counter", body)
        # 推理计数应包含预置的 12 条（10 stand + 1 unknown + ... 实际是 11 条非 error）
        self.assertRegex(body, r"ewoh_inference_count_total \d+")
        # db_counts 应出现设备/人员表
        self.assertIn('ewoh_db_count{table="device"}', body)
        # 派生的 open_event_count 应 ≥1（EVT-T1）
        self.assertRegex(body, r"ewoh_event_open_count [1-9]\d*")

    def test_inference_metrics_route_returns_json(self):
        import json

        # 使用显式时间窗覆盖预置的 2026-07-31T10:00 推理记录
        status, headers, body = self.harness.get(
            "/api/inference/metrics?start=2026-07-31T00:00:00%2B08:00&end=2026-08-01T00:00:00%2B08:00"
        )
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertIn("inference_p50_ms", data)
        self.assertIn("inference_p95_ms", data)
        self.assertIn("throughput_per_sec", data)
        self.assertIn("unknown_ratio", data)
        self.assertIn("window", data)
        # 预置的 2 条 inference（1 stand + 1 unknown）→ unknown_ratio = 0.5
        self.assertEqual(data["window_inference_count"], 2)
        self.assertEqual(data["window_unknown_count"], 1)
        self.assertAlmostEqual(data["unknown_ratio"], 0.5, places=4)
        # collector 累计的 inference_count 应 ≥ 11（10 stand + 1 unknown）
        self.assertGreaterEqual(data["inference_count"], 11)
        self.assertEqual(data["source"], "metrics_collector")

    def test_event_status_close_records_close_duration(self):
        # 关闭事件 → record_event_close 应被调用
        before = self.metrics.snapshot()["avg_event_close_hours"]
        status, resp = self.harness.post(
            "/api/event/status", {"event_id": "EVT-T1", "status": "closed", "handling": {"handled_by": "班组长A"}}
        )
        self.assertEqual(status, 200)
        self.assertTrue(resp.get("ok"))
        after = self.metrics.snapshot()["avg_event_close_hours"]
        # EVT-T1 start_time=10:00，handled_at=now → 关闭时长 > 0
        self.assertGreater(after, before)

    def test_recommend_and_confirm_update_adoption(self):
        # 生成推荐 → recommendation_count +1
        before_rec = self.metrics.snapshot()["recommendation_count"]
        status, resp = self.harness.post(
            "/api/tasks/recommend", {"required_skill": "搬运", "zone_id": "月台A", "load_level": 0.3}
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.metrics.snapshot()["recommendation_count"], before_rec + 1)
        # 确认派工（P-001 具备搬运技能且授权） → confirmed_count +1
        cand = [r for r in resp["items"] if r["person_id"] == "P-001"]
        self.assertTrue(cand, "P-001 应在推荐列表中")
        self.assertTrue(cand[0]["eligible"], "P-001 应满足硬约束")
        before_conf = self.metrics.snapshot()["confirmed_count"]
        status2, resp2 = self.harness.post(
            "/api/tasks/confirm",
            {
                "task_id": "T-MON-1",
                "person_id": "P-001",
                "confirmer": "班组长A",
                "required_skill": "搬运",
                "zone_id": "月台A",
            },
        )
        self.assertEqual(status2, 200)
        self.assertTrue(resp2.get("ok"))
        self.assertEqual(self.metrics.snapshot()["confirmed_count"], before_conf + 1)

    def test_metrics_route_503_when_no_collector(self):
        """未注入 collector 时 /metrics 返回 503。"""
        storage = stubs.Storage(":memory:")
        try:
            ctx = server.Context(storage, manager=stubs.AdapterManager(storage, stubs.Bus()))
            h = _HandlerHarness(ctx)
            status, _, _ = h.get("/metrics")
            self.assertEqual(status, 503)
        finally:
            storage.close()


# ---------- 集成：pipeline → MetricsCollector ----------
class PipelineIntegrationTest(unittest.TestCase):
    """验证 InferencePipeline 调用 record_inference 注入 collector。"""

    def test_stub_pipeline_accepts_collector(self):
        storage = stubs.Storage(":memory:")
        try:
            bus = stubs.Bus()
            registry = stubs.ModelRegistry(Path(tempfile.mkdtemp()) / "models")
            rules = stubs.RuleEngine("stub", {})
            metrics = MetricsCollector()
            pipe = stubs.InferencePipeline(storage, bus, registry, rules, metrics_collector=metrics)
            self.assertIs(pipe._metrics, metrics)
        finally:
            storage.close()


if __name__ == "__main__":
    unittest.main()
