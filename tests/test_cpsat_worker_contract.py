"""CP-SAT Worker HTTP 契约测试（Batch 9）。

验证 worker 与 NestJS `CpSatSchedulingSolver` 的 HTTP 契约：
1. GET /health/live 存活探针；
2. GET /api/scheduler/v2/solver/health 求解器可用性（ortools 缺失时 available=false）；
3. POST /api/scheduler/v2/solve 接收 SolverRequest JSON → 返回 SolverResponse JSON；
4. ortools 缺失时 solverStatus=UNAVAILABLE（绝不冒充 CP-SAT 成功）；
5. 非法请求 → 400（不崩溃 worker）。

启动 worker 于随机端口（threading 后台），测试后关闭。
"""

import json
import os
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from edge_platform.scheduler.cpsat import worker as cpsat_worker  # noqa: E402
from edge_platform.scheduler.cpsat.solver import SOLVER_VERSION  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CpsatWorkerContractTest(unittest.TestCase):
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

    def _get(self, path: str):
        with urllib.request.urlopen(f"{self.base}{path}", timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf-8"))

    def _post(self, path: str, body: str):
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=body.encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read().decode("utf-8"))

    def test_health_live(self):
        status, payload = self._get("/health/live")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_solver_health_reports_availability(self):
        status, payload = self._get("/api/scheduler/v2/solver/health")
        self.assertEqual(status, 200)
        self.assertIn("available", payload)
        self.assertEqual(payload["solverVersion"], SOLVER_VERSION)
        # ortools 缺失时如实报告不可用（不冒充）
        self.assertIn("note", payload)

    def test_solve_empty_request_returns_unavailable_when_no_ortools(self):
        request = {
            "tasks": [], "persons": [], "devices": [], "stations": [],
            "reservations": [], "frozenAssignments": [], "constraints": [],
            "weights": {}, "nowMs": 0, "horizonEndMs": 0,
        }
        status, payload = self._post("/api/scheduler/v2/solve", json.dumps(request))
        self.assertEqual(status, 200)
        # 无 ortools 环境 → UNAVAILABLE（云侧据此回退 heuristic）
        if not cpsat_worker.is_available():
            self.assertEqual(payload["solverStatus"], "UNAVAILABLE")
            self.assertEqual(payload["solverVersion"], SOLVER_VERSION)
        else:
            self.assertIn(payload["solverStatus"], {"OPTIMAL", "FEASIBLE", "INFEASIBLE"})

    def test_solve_invalid_json_returns_400(self):
        req = urllib.request.Request(
            f"{self.base}/api/scheduler/v2/solve",
            data=b"not-json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(body["error"]["code"], "BAD_REQUEST")

    def test_unknown_path_returns_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"{self.base}/nope", timeout=5)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
