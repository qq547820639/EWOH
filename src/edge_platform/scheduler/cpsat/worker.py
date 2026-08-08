"""CP-SAT 求解 HTTP Worker（Batch 9 部署准备）。

提供与 NestJS `CpSatSchedulingSolver` 对齐的 HTTP 契约：
- POST /api/scheduler/v2/solve   接收 SolverRequest JSON → 返回 SolverResponse JSON
- GET  /health/live               存活探针
- GET  /api/scheduler/v2/solver/health   求解器可用性（是否安装了 ortools）

实现：纯标准库 http.server（ThreadingHTTPServer），零第三方运行时依赖，
与边缘平台"运行时零第三方依赖"哲学一致；唯一可选依赖 ortools（缺失时
solve 返回 UNAVAILABLE，由云侧安全回退 heuristic，绝不冒充 CP-SAT 成功）。

启动：
    python -m edge_platform.scheduler.cpsat.worker [--host 0.0.0.0] [--port 8000]

部署：见 deploy/cloud/docker-compose.cpsat.yml（独立容器，不写设备实时安全控制参数）。
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict

from .contract import SolverRequest
from .solver import SOLVER_VERSION, is_available, solve

BODY_LIMIT = 16 * 1024 * 1024  # 16MB，与云侧请求体上限对齐


class SolverHandler(BaseHTTPRequestHandler):
    server_version = f"EWOH-CPSAT-Worker/{SOLVER_VERSION}"

    # ---- 工具 ----
    def _send_json(self, status: int, payload: Dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> str:
        length = int(self.headers.get("Content-Length", 0))
        if length > BODY_LIMIT:
            raise ValueError(f"body too large: {length}")
        return self.rfile.read(length).decode("utf-8")

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - 覆盖基类
        # 抑制默认访问日志噪音，仅保留错误
        if fmt.startswith("code 4") or fmt.startswith("code 5"):
            super().log_message(fmt, *args)

    # ---- 路由 ----
    def do_GET(self) -> None:
        if self.path == "/health/live":
            self._send_json(200, {"ok": True, "service": "cpsat-worker"})
            return
        if self.path == "/api/scheduler/v2/solver/health":
            self._send_json(
                200,
                {
                    "available": is_available(),
                    "solverVersion": SOLVER_VERSION,
                    "note": (
                        "ortools installed"
                        if is_available()
                        else "ortools missing - solve returns UNAVAILABLE"
                    ),
                },
            )
            return
        self._send_json(404, {"error": {"code": "NOT_FOUND", "message": f"unknown path: {self.path}"}})

    def do_POST(self) -> None:
        if self.path != "/api/scheduler/v2/solve":
            self._send_json(404, {"error": {"code": "NOT_FOUND", "message": f"unknown path: {self.path}"}})
            return
        try:
            raw = self._read_body()
            data = json.loads(raw)
            request = SolverRequest.from_dict(data)
        except ValueError as e:
            self._send_json(400, {"error": {"code": "BAD_REQUEST", "message": str(e)}})
            return
        except Exception as e:  # noqa: BLE001 - 契约解析失败统一 400
            self._send_json(400, {"error": {"code": "BAD_REQUEST", "message": f"invalid request: {e}"}})
            return

        try:
            response = solve(request)
            self._send_json(200, response.to_dict())
        except Exception as e:  # noqa: BLE001 - 求解异常不崩溃 worker
            self._send_json(500, {"error": {"code": "INTERNAL", "message": str(e)}})


def main() -> None:
    ap = argparse.ArgumentParser(description="EWOH CP-SAT 求解 HTTP Worker")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), SolverHandler)
    print(
        f"[cpsat-worker] listening on http://{args.host}:{args.port} "
        f"(ortools={'available' if is_available() else 'MISSING -> UNAVAILABLE fallback'})"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
