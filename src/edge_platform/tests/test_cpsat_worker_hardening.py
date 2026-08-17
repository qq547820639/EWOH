"""CP-SAT Worker 运行时加固测试（Task 6 / P1；**不依赖 ortools**）。

覆盖（全部用 mock 求解器，本机无 ortools 也可绿）：
1. 并发上限：并发请求 > CPSAT_WORKER_MAX_CONCURRENCY → 部分 429 QUEUE_SATURATED（不崩溃/不挂起）；
2. 请求超时：求解 sleep 超过时间预算 → solverStatus=TIMEOUT JSON（不让客户端挂起）；
3. 问题规模上限：tasks / estimated candidates 超限 → 413 PROBLEM_TOO_LARGE；
4. 关联 ID：X-Request-ID 回显（响应头 + JSON 信封 requestId）；缺省生成 req-<hex>；
5. /metrics：cpsat_solver_* 系列 Prometheus 文本格式；
6. 内存守卫：ru_maxrss 超上限 → memoryWarning 字段（绝不崩溃 worker）；
7. 优雅停机：子进程 SIGTERM → 退出码 0。

运行：
    PYTHONPATH=src python -m pytest src/edge_platform/tests/test_cpsat_worker_hardening.py -q
"""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.cpsat import worker as cpsat_worker  # noqa: E402
from edge_platform.scheduler.cpsat.contract import SolverResponse  # noqa: E402

_ORIGINAL_SOLVE = cpsat_worker.solve


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_idle(timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cpsat_worker._current_concurrency() == 0:
            return True
        time.sleep(0.05)
    return cpsat_worker._current_concurrency() == 0


def _minimal_body() -> dict:
    return {
        "requestId": "req-hardening",
        "snapshotVersion": "WS-HARDENING",
        "policyVersion": 1,
        "solverVersion": "cpsat-v1",
        "horizonMinutes": 60,
        "nowMs": 0,
        "weights": {},
        "tasks": [],
        "persons": [],
        "devices": [],
        "stations": [],
        "reservations": [],
        "frozenAssignments": [],
        "baselineAssignee": {},
        "timeLimitMs": 1000,
    }


def _task(task_id: str) -> dict:
    return {
        "taskId": task_id,
        "priority": 1.0,
        "earliestStartMs": 0,
        "dueMs": None,
        "durationMs": 30_000,
        "requiredSkills": [],
    }


def _person(person_id: str) -> dict:
    return {
        "id": person_id,
        "status": "available",
        "locationStationId": None,
        "skills": [],
        "certifications": [],
    }


def _station(station_id: str) -> dict:
    return {"id": station_id, "x": 0, "y": 0, "capacity": 5}


class CpsatWorkerHardeningTest(unittest.TestCase):
    """基于真实 ThreadingHTTPServer + mock 求解器，逐项验证运行时加固。"""

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.httpd = cpsat_worker.ThreadingHTTPServer(
            ("127.0.0.1", cls.port), cpsat_worker.SolverHandler
        )
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        _wait_idle()
        cpsat_worker._shutdown_runtime()

    def setUp(self):
        # 恢复默认配置 + 恢复真实求解器 + 重建运行池（避免测试间污染）
        cpsat_worker.CPSAT_WORKER_MAX_CONCURRENCY = 4
        cpsat_worker.CPSAT_WORKER_QUEUE_WAIT_MS = 1000
        cpsat_worker.CPSAT_WORKER_MAX_SOLVE_MS = 120000
        cpsat_worker.CPSAT_WORKER_TIMEOUT_MARGIN_MS = 5000
        cpsat_worker.CPSAT_WORKER_MAX_TASKS = 1000
        cpsat_worker.CPSAT_WORKER_MAX_CANDIDATES = 50000
        cpsat_worker.CPSAT_WORKER_MAX_MEMORY_MB = 2048
        cpsat_worker.solve = _ORIGINAL_SOLVE
        cpsat_worker._shutdown_runtime()

    # ---- 工具 ----

    def _get_json(self, path: str, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        with urllib.request.urlopen(req, timeout=5) as res:  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
            return res.status, json.loads(res.read().decode("utf-8"))

    def _get_text(self, path: str) -> str:
        with urllib.request.urlopen(self.base + path, timeout=5) as res:  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
            self.assertTrue(
                res.headers.get("Content-Type", "").startswith("text/plain"),
                "metrics 必须为 text/plain",
            )
            return res.read().decode("utf-8")

    def _post_json(self, path: str, body: str):
        req = urllib.request.Request(
            self.base + path,
            data=body.encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
                return res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    # ---- 1. 并发上限 ----

    def test_concurrency_cap_returns_429_when_saturated(self):
        cpsat_worker.CPSAT_WORKER_MAX_CONCURRENCY = 2
        cpsat_worker.CPSAT_WORKER_QUEUE_WAIT_MS = 300
        cpsat_worker.CPSAT_WORKER_MAX_SOLVE_MS = 10000
        cpsat_worker.CPSAT_WORKER_TIMEOUT_MARGIN_MS = 50

        def slow_solve(_request):
            # EDT-008：睡眠 2s（>> 排队等待 300ms + 线程启动抖动），保证 6 个
            # 并发请求必然在占用窗口内到达，saturation 断言不受 CI 负载抖动影响。
            time.sleep(2.0)
            return SolverResponse(
                solverVersion="cpsat-v1",
                solverStatus="OPTIMAL",
                solveDurationMs=2000,
                objective=1.0,
            )

        cpsat_worker.solve = slow_solve
        cpsat_worker._ensure_runtime()

        results: list = []
        lock = threading.Lock()

        def fire():
            status, payload = self._post_json(
                "/api/scheduler/v2/solve", json.dumps(_minimal_body())
            )
            with lock:
                results.append((status, payload))

        threads = [threading.Thread(target=fire) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        self.assertEqual(len(results), 6, "6 个请求都必须得到响应（不挂起）")
        ok = sum(1 for s, _ in results if s == 200)
        saturated = sum(1 for s, _ in results if s == 429)
        self.assertGreaterEqual(ok, 1, "应至少有请求被放行执行")
        self.assertGreaterEqual(saturated, 1, "超出并发上限的请求应得到 429")
        for s, payload in results:
            if s == 429:
                self.assertEqual(payload["error"]["code"], "QUEUE_SATURATED")
        _wait_idle()

    # ---- 2. 请求超时 ----

    def test_request_timeout_returns_timeout_json(self):
        cpsat_worker.CPSAT_WORKER_MAX_CONCURRENCY = 1
        cpsat_worker.CPSAT_WORKER_MAX_SOLVE_MS = 10000
        cpsat_worker.CPSAT_WORKER_TIMEOUT_MARGIN_MS = 50

        def slow_solve(_request):
            time.sleep(2.0)
            return SolverResponse(
                solverVersion="cpsat-v1",
                solverStatus="OPTIMAL",
                solveDurationMs=2000,
                objective=1.0,
            )

        cpsat_worker.solve = slow_solve
        cpsat_worker._ensure_runtime()

        body = {**_minimal_body(), "timeLimitMs": 100}  # 预算 = 100 + 50 = 150ms < 2s sleep
        status, payload = self._post_json("/api/scheduler/v2/solve", json.dumps(body))
        self.assertEqual(status, 200, "超时仍返回 200 + TIMEOUT JSON，而非挂起")
        self.assertEqual(payload["solverStatus"], "TIMEOUT")
        self.assertEqual(payload["unassignedTaskIds"], [])
        self.assertIn("requestId", payload)
        _wait_idle()  # 等在途任务结束，避免信号量污染后续测试

    # ---- 3. 问题规模上限 ----

    def test_max_tasks_exceeded_returns_413(self):
        cpsat_worker.CPSAT_WORKER_MAX_TASKS = 2
        body = {**_minimal_body(), "tasks": [_task(f"t{i}") for i in range(3)]}
        status, payload = self._post_json("/api/scheduler/v2/solve", json.dumps(body))
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "PROBLEM_TOO_LARGE")

    def test_max_candidates_exceeded_returns_413(self):
        cpsat_worker.CPSAT_WORKER_MAX_CANDIDATES = 2
        body = {
            **_minimal_body(),
            "tasks": [_task("t1")],
            "persons": [_person(f"p{i}") for i in range(3)],
            "stations": [_station("s1")],
        }
        # 估计候选 = 1 任务 × 3 人 × 1 站 = 3 > 2 → 413
        status, payload = self._post_json("/api/scheduler/v2/solve", json.dumps(body))
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "PROBLEM_TOO_LARGE")

    def test_under_limit_requests_still_solve(self):
        cpsat_worker.CPSAT_WORKER_MAX_TASKS = 2
        cpsat_worker.CPSAT_WORKER_MAX_CANDIDATES = 2
        body = {
            **_minimal_body(),
            "tasks": [_task("t1")],
            "persons": [_person("p1")],
            "stations": [_station("s1")],
        }
        status, payload = self._post_json("/api/scheduler/v2/solve", json.dumps(body))
        self.assertEqual(status, 200)
        # 无 ortools → UNAVAILABLE（如实报告，未被 413 误伤）
        self.assertEqual(payload["solverStatus"], "UNAVAILABLE")

    # ---- 4. 关联 ID ----

    def test_correlation_id_echoed_in_header_and_body(self):
        req = urllib.request.Request(
            self.base + "/health/live", headers={"X-Request-ID": "my-corr-1"}
        )
        with urllib.request.urlopen(req, timeout=5) as res:  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
            self.assertEqual(res.headers.get("X-Request-ID"), "my-corr-1")
            payload = json.loads(res.read().decode("utf-8"))
        self.assertEqual(payload["requestId"], "my-corr-1")

    def test_correlation_id_generated_when_missing(self):
        status, payload = self._get_json("/health/live")
        self.assertEqual(status, 200)
        self.assertTrue(payload["requestId"].startswith("req-"))

    def test_solve_response_includes_request_id(self):
        status, payload = self._post_json(
            "/api/scheduler/v2/solve", json.dumps(_minimal_body())
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["requestId"].startswith("req-"))

    # ---- 5. /metrics ----

    def test_metrics_endpoint_exposes_cpsat_series(self):
        # 先跑一次真实求解（无 ortools → UNAVAILABLE），让计数器有数据
        self._post_json("/api/scheduler/v2/solve", json.dumps(_minimal_body()))
        text = self._get_text("/metrics")
        for name in [
            "cpsat_solver_requests_total",
            "cpsat_solver_duration_ms_sum",
            "cpsat_solver_duration_ms_count",
            "cpsat_solver_timeouts_total",
            "cpsat_solver_concurrency_current",
            "cpsat_solver_health",
        ]:
            self.assertIn(name, text)
        self.assertIn("# TYPE cpsat_solver_requests_total counter", text)
        self.assertIn("# TYPE cpsat_solver_duration_ms_sum counter", text)
        self.assertIn("# TYPE cpsat_solver_concurrency_current gauge", text)
        self.assertIn("# TYPE cpsat_solver_health gauge", text)
        self.assertIn('cpsat_solver_requests_total{status="UNAVAILABLE"}', text)

    # ---- 6. 内存守卫 ----

    def test_memory_guard_adds_warning_without_crash(self):
        cpsat_worker.CPSAT_WORKER_MAX_MEMORY_MB = 0  # 任何 ru_maxrss 都超限
        status, payload = self._post_json(
            "/api/scheduler/v2/solve", json.dumps(_minimal_body())
        )
        self.assertEqual(status, 200)
        self.assertIn("memoryWarning", payload)
        self.assertEqual(payload["memoryWarning"]["limitMb"], 0)
        self.assertGreater(payload["memoryWarning"]["ruMaxRssMb"], 0)

    # ---- 7. 优雅停机 ----

    def test_graceful_shutdown_sigterm_exits_zero(self):
        port = _free_port()
        src = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        repo = os.path.abspath(os.path.join(src, ".."))
        env = dict(os.environ, PYTHONPATH=src)
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "edge_platform.scheduler.cpsat.worker",
                "--port",
                str(port),
            ],
            cwd=repo,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            deadline = time.time() + 15
            ready = False
            while time.time() < deadline:
                if proc.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(  # nosec B310 - 测试桩：URL 为本地 fixture 服务器，非用户输入
                        f"http://127.0.0.1:{port}/health/live", timeout=1
                    ) as res:
                        if res.status == 200:
                            ready = True
                            break
                except Exception:  # noqa: BLE001 - 就绪轮询
                    time.sleep(0.2)
            self.assertTrue(ready, "worker 未在超时内就绪")
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=20)
            self.assertEqual(
                proc.returncode,
                0,
                f"worker 收到 SIGTERM 后应优雅退出（退出码 0）；输出:\n{out}",
            )
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    unittest.main()
