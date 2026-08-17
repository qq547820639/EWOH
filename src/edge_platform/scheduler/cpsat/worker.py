"""CP-SAT 求解 HTTP Worker（Batch 9 部署准备 + Task 6 / P1 运行时加固）。

提供与 NestJS `CpSatSchedulingSolver` 对齐的 HTTP 契约：
- POST /api/scheduler/v2/solve   接收 SolverRequest JSON → 返回 SolverResponse JSON
- GET  /health/live               存活探针
- GET  /api/scheduler/v2/solver/health   求解器可用性（是否安装了 ortools）
- GET  /metrics                    Prometheus 文本格式指标（Task 6 / P1 新增）

Task 6 / P1 运行时加固（worker 运行级能力，全部零第三方运行时依赖）：
- 请求关联 ID：读取 X-Request-ID 头（缺省生成 req-<uuid4hex>）；响应头回显 + JSON 信封带
  requestId 字段（新增字段不破坏既有解析器——契约测试只断言既有字段）。
- 并发上限：ThreadPoolExecutor(max_workers=CPSAT_WORKER_MAX_CONCURRENCY，缺省 4) + 有界信号量；
  队列饱和（信号量获取超时 CPSAT_WORKER_QUEUE_WAIT_MS，缺省 1000ms）→ 429 QUEUE_SATURATED。
- 请求超时：每请求时间预算 = min(CPSAT_WORKER_MAX_SOLVE_MS, request.timeLimitMs)
  + CPSAT_WORKER_TIMEOUT_MARGIN_MS；超时返回 solverStatus=TIMEOUT JSON（不让客户端挂起）。
- 问题规模上限：CPSAT_WORKER_MAX_TASKS（缺省 1000）/ CPSAT_WORKER_MAX_CANDIDATES
  （缺省 50000，按候选生成同源廉价过滤估计）→ 413 PROBLEM_TOO_LARGE。
- 内存守卫：求解后检查 resource.getrusage(RUSAGE_SELF).ru_maxrss（> CPSAT_WORKER_MAX_MEMORY_MB，
  缺省 2048）→ 结果附 memoryWarning 字段 + 日志，绝不崩溃 worker。
- 结构化指标：GET /metrics 暴露 cpsat_solver_* 系列（HELP/TYPE/标签风格对齐
  src/edge_platform/monitoring/exporter.py）。
- 优雅停机：SIGTERM/SIGINT → 停止接收 → 排空在途（executor.shutdown(wait=True) 带上限）→
  server_close → 退出码 0。

实现：纯标准库 http.server + concurrent.futures + signal + resource，零第三方运行时依赖，
与边缘平台"运行时零第三方依赖"哲学一致；唯一可选依赖 ortools（缺失时 solve 返回
UNAVAILABLE，由云侧安全回退 heuristic，绝不冒充 CP-SAT 成功）。

启动：
    python -m edge_platform.scheduler.cpsat.worker [--host 0.0.0.0] [--port 8000]

部署：见 deploy/cloud/docker-compose.cpsat.yml（独立容器，不写设备实时安全控制参数）。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    import resource as _resource  # POSIX 专用；Windows 上不可用（边缘平台为 Linux/macOS）
except ImportError:  # pragma: no cover - 非 POSIX 环境
    _resource = None

from .contract import SolverRequest
from .solver import SOLVER_VERSION, is_available, person_has_required_skills, solve

BODY_LIMIT = 16 * 1024 * 1024  # 16MB，与云侧请求体上限对齐

# ---- Task 6 / P1：运行时加固配置（env 可覆盖；模块级常量，测试可直接 patch 后 _ensure_runtime） ----
CPSAT_WORKER_MAX_CONCURRENCY = int(os.environ.get("CPSAT_WORKER_MAX_CONCURRENCY", "4"))
CPSAT_WORKER_QUEUE_WAIT_MS = int(os.environ.get("CPSAT_WORKER_QUEUE_WAIT_MS", "1000"))
CPSAT_WORKER_MAX_SOLVE_MS = int(os.environ.get("CPSAT_WORKER_MAX_SOLVE_MS", "120000"))
CPSAT_WORKER_TIMEOUT_MARGIN_MS = int(os.environ.get("CPSAT_WORKER_TIMEOUT_MARGIN_MS", "5000"))
CPSAT_WORKER_MAX_TASKS = int(os.environ.get("CPSAT_WORKER_MAX_TASKS", "1000"))
CPSAT_WORKER_MAX_CANDIDATES = int(os.environ.get("CPSAT_WORKER_MAX_CANDIDATES", "50000"))
CPSAT_WORKER_MAX_MEMORY_MB = int(os.environ.get("CPSAT_WORKER_MAX_MEMORY_MB", "2048"))

# CP-SAT 生产激活阶梯（Task 6 / P1）：OFF → SHADOW → CANARY → PRODUCTION
# - OFF（当前）：worker 不可达/未部署 → solverStatus=UNAVAILABLE 回退 heuristic；
#   feature-status.yaml cpSat.productionEnabled=false（生产未启用，不得声称"生产就绪"）。
# - SHADOW：同一快照/策略双跑（heuristic=生产方案；CP-SAT=shadow 对比，isShadow，绝不派工）。
# - CANARY：shadow 对比稳定后按 canary 比例抽样放量；硬约束分歧自动回滚 canary=0
#   （见 ewoh-spark-app shadow-policy.service.ts / shadow-evaluator.service.ts）。
# - PRODUCTION：docs/runtime-gates.md G1..G12 全部通过 + shadow/canary 阈值达标
#   （PredictionConfig.autoRollbackOn：mae<=0.25 / fallbackRate<=0.5 / coverage>=0.8）后，
#   由 feature-status.yaml productionEnabled 翻转为 true。
ACTIVATION_LADDER = "OFF->SHADOW->CANARY->PRODUCTION"

# ---- 求解执行池（惰性初始化；并发上限由信号量硬约束，队列饱和 → 429） ----
_EXECUTOR: concurrent.futures.ThreadPoolExecutor | None = None
_SEMAPHORE: threading.BoundedSemaphore | None = None
_EXECUTOR_MAX_CONCURRENCY = 0
_EXECUTOR_LOCK = threading.Lock()

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_SOLVES = 0


def _ensure_runtime() -> tuple[concurrent.futures.ThreadPoolExecutor, threading.BoundedSemaphore]:
    """按当前 CPSAT_WORKER_MAX_CONCURRENCY 惰性构建/重建执行池与信号量。"""
    global _EXECUTOR, _SEMAPHORE, _EXECUTOR_MAX_CONCURRENCY
    with _EXECUTOR_LOCK:
        n = max(1, CPSAT_WORKER_MAX_CONCURRENCY)
        if _EXECUTOR is None or _EXECUTOR_MAX_CONCURRENCY != n:
            if _EXECUTOR is not None:
                _EXECUTOR.shutdown(wait=False, cancel_futures=True)
            _EXECUTOR = concurrent.futures.ThreadPoolExecutor(
                max_workers=n, thread_name_prefix="cpsat-solve"
            )
            _SEMAPHORE = threading.BoundedSemaphore(n)
            _EXECUTOR_MAX_CONCURRENCY = n
        return _EXECUTOR, _SEMAPHORE


def _shutdown_runtime() -> None:
    """测试/停机辅助：关闭并重置执行池（不阻塞在途求解）。"""
    global _EXECUTOR, _SEMAPHORE, _EXECUTOR_MAX_CONCURRENCY
    with _EXECUTOR_LOCK:
        if _EXECUTOR is not None:
            _EXECUTOR.shutdown(wait=False, cancel_futures=True)
        _EXECUTOR = None
        _SEMAPHORE = None
        _EXECUTOR_MAX_CONCURRENCY = 0


def _current_concurrency() -> int:
    with _ACTIVE_LOCK:
        return _ACTIVE_SOLVES


class _WorkerMetrics:
    """CP-SAT worker 进程内指标（Prometheus 文本格式；HELP/TYPE/标签风格对齐 exporter.py）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests_by_status: dict[str, int] = {}
        self._duration_sum_ms = 0.0
        self._duration_count = 0
        self._timeouts = 0

    def record_request(self, status: str, duration_ms: float) -> None:
        with self._lock:
            self._requests_by_status[status] = self._requests_by_status.get(status, 0) + 1
            self._duration_sum_ms += duration_ms
            self._duration_count += 1

    def record_timeout(self) -> None:
        with self._lock:
            self._timeouts += 1

    def render(self, concurrency_current: int) -> str:
        with self._lock:
            requests = dict(self._requests_by_status)
            duration_sum = self._duration_sum_ms
            duration_count = self._duration_count
            timeouts = self._timeouts
        lines: list[str] = []
        lines.append("# HELP cpsat_solver_requests_total CP-SAT 求解请求总数（按 solverStatus 标签）")
        lines.append("# TYPE cpsat_solver_requests_total counter")
        if not requests:
            lines.append("cpsat_solver_requests_total 0")
        else:
            for status in sorted(requests):
                lines.append(
                    f'cpsat_solver_requests_total{{status="{status}"}} {requests[status]}'
                )
        lines.append("# HELP cpsat_solver_duration_ms_sum CP-SAT 求解耗时总和（ms）")
        lines.append("# TYPE cpsat_solver_duration_ms_sum counter")
        lines.append(f"cpsat_solver_duration_ms_sum {duration_sum:g}")
        lines.append("# HELP cpsat_solver_duration_ms_count CP-SAT 求解请求计数")
        lines.append("# TYPE cpsat_solver_duration_ms_count counter")
        lines.append(f"cpsat_solver_duration_ms_count {duration_count}")
        lines.append("# HELP cpsat_solver_timeouts_total CP-SAT 求解超时总数（worker 时间预算触发）")
        lines.append("# TYPE cpsat_solver_timeouts_total counter")
        lines.append(f"cpsat_solver_timeouts_total {timeouts}")
        lines.append("# HELP cpsat_solver_concurrency_current 当前并发求解数（gauge）")
        lines.append("# TYPE cpsat_solver_concurrency_current gauge")
        lines.append(f"cpsat_solver_concurrency_current {concurrency_current}")
        lines.append("# HELP cpsat_solver_health 求解器可用性（1=ortools 可用，0=不可用）")
        lines.append("# TYPE cpsat_solver_health gauge")
        lines.append(f"cpsat_solver_health {1 if is_available() else 0}")
        return "\n".join(lines) + "\n"


_METRICS = _WorkerMetrics()


# ---- 问题规模 / 超时预算 / 内存守卫 ----

def _estimate_candidates(request: SolverRequest) -> int:
    """候选规模上界估计（与 solver.py 候选生成同源廉价过滤，估计值 >= 实际候选数）。

    仅使用计数级过滤（状态/资格/技能/证书/能力/工位），不重复 solver 的完整建模；
    作为 413 判定的保守上界（宁可多拒，不放过超规模请求）。
    """
    total = 0
    frozen_task_ids = {f.taskId for f in request.frozenAssignments}
    blocked_persons = set(request.safetyBlockedPersonIds or [])
    blocked_devices = set(request.safetyBlockedDeviceIds or [])
    for t in request.tasks:
        if t.taskId in frozen_task_ids:
            continue
        person_count = 0
        for p in request.persons:
            if p.id in blocked_persons or p.status != "available":
                continue
            if t.eligiblePersonIds is not None and p.id not in t.eligiblePersonIds:
                continue
            if not person_has_required_skills(
                p.skills, t.requiredSkills, t.skillMatchMode or "ALL"
            ):
                continue
            if not all(c in p.certifications for c in t.requiredCertifications):
                continue
            person_count += 1
        if person_count == 0:
            continue
        if t.requiredDeviceCapabilities:
            device_count = 0
            for d in request.devices:
                if d.id in blocked_devices or not d.online or d.status == "fault":
                    continue
                if t.eligibleDeviceIds is not None and d.id not in t.eligibleDeviceIds:
                    continue
                if not all(cap in d.capabilities for cap in t.requiredDeviceCapabilities):
                    continue
                device_count += 1
        else:
            device_count = 1
        if t.candidateStationIds:
            station_count = sum(1 for st in request.stations if st.id in t.candidateStationIds)
        else:
            station_count = len(request.stations)
        total += person_count * device_count * station_count
    return total


def _problem_too_large(request: SolverRequest) -> dict[str, Any] | None:
    """问题规模上限校验；超限返回 413 载荷（与既有 error 信封一致）。"""
    if len(request.tasks) > CPSAT_WORKER_MAX_TASKS:
        return {
            "error": {
                "code": "PROBLEM_TOO_LARGE",
                "message": (
                    f"tasks={len(request.tasks)} exceeds "
                    f"CPSAT_WORKER_MAX_TASKS={CPSAT_WORKER_MAX_TASKS}"
                ),
            }
        }
    estimated = _estimate_candidates(request)
    if estimated > CPSAT_WORKER_MAX_CANDIDATES:
        return {
            "error": {
                "code": "PROBLEM_TOO_LARGE",
                "message": (
                    f"estimated candidates={estimated} exceeds "
                    f"CPSAT_WORKER_MAX_CANDIDATES={CPSAT_WORKER_MAX_CANDIDATES}"
                ),
            }
        }
    return None


def _time_budget_ms(request: SolverRequest) -> int:
    """每请求时间预算 = min(worker 上限, request.timeLimitMs) + 小余量。"""
    base = max(request.timeLimitMs, 1)
    return min(CPSAT_WORKER_MAX_SOLVE_MS, base) + CPSAT_WORKER_TIMEOUT_MARGIN_MS


def _memory_warning_mb() -> dict[str, Any] | None:
    """内存守卫：ru_maxrss 超上限 → 返回 memoryWarning 载荷（绝不崩溃 worker）。"""
    if _resource is None:
        return None
    try:
        ru_maxrss = _resource.getrusage(_resource.RUSAGE_SELF).ru_maxrss
    except (AttributeError, ValueError):
        return None
    # macOS 的 ru_maxrss 单位为字节；Linux 为 KB。
    mb = ru_maxrss / (1024 * 1024) if sys.platform == "darwin" else ru_maxrss / 1024
    if mb > CPSAT_WORKER_MAX_MEMORY_MB:
        return {"ruMaxRssMb": round(mb, 1), "limitMb": CPSAT_WORKER_MAX_MEMORY_MB}
    return None


def _timeout_payload(request: SolverRequest) -> dict[str, Any]:
    """时间预算触顶时的 TIMEOUT 响应（与 solver.py 的 TIMEOUT 形状一致）。"""
    return {
        "solverVersion": SOLVER_VERSION,
        "solverStatus": "TIMEOUT",
        "solveDurationMs": _time_budget_ms(request),
        "objective": 0.0,
        "objectiveBreakdown": {},
        "hardViolations": [],
        "optimalityGap": None,
        "unassignedTaskIds": [t.taskId for t in request.tasks],
        "assignments": [],
    }


def _run_solve(request: SolverRequest) -> tuple[int, dict[str, Any], float]:
    """在线程池内执行一次求解；返回 (http_status, payload, duration_ms)。"""
    global _ACTIVE_SOLVES
    with _ACTIVE_LOCK:
        _ACTIVE_SOLVES += 1
    started = time.monotonic()
    try:
        response = solve(request)
        payload = response.to_dict()
        warning = _memory_warning_mb()
        if warning is not None:
            payload["memoryWarning"] = warning
            logging.getLogger("cpsat-worker").warning(
                "memory guard: ru_maxrss=%.1fMB > limit=%dMB",
                warning["ruMaxRssMb"],
                CPSAT_WORKER_MAX_MEMORY_MB,
            )
        return 200, payload, (time.monotonic() - started) * 1000.0
    except Exception as e:  # noqa: BLE001 - 求解异常不崩溃 worker
        return (
            500,
            {"error": {"code": "INTERNAL", "message": str(e)}},
            (time.monotonic() - started) * 1000.0,
        )
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE_SOLVES -= 1


def _solve_guarded(
    request: SolverRequest, semaphore: threading.BoundedSemaphore
) -> tuple[int, dict[str, Any], float]:
    """带信号量保护的求解任务：信号量由提交方获取、由本任务释放（超时后在途任务仍持锁）。"""
    try:
        return _run_solve(request)
    finally:
        semaphore.release()


def _status_label(status: int, payload: dict[str, Any]) -> str:
    """指标标签：solverStatus 优先，其次 error.code，最后 http_<status>。"""
    if isinstance(payload, dict):
        solver_status = payload.get("solverStatus")
        if isinstance(solver_status, str) and solver_status:
            return solver_status
        err = payload.get("error")
        if isinstance(err, dict) and isinstance(err.get("code"), str):
            return err["code"]
    return f"http_{status}"


# ---- HTTP Handler ----

class SolverHandler(BaseHTTPRequestHandler):
    server_version = f"EWOH-CPSAT-Worker/{SOLVER_VERSION}"

    # ---- 工具 ----
    def _request_id(self) -> str:
        rid = self.headers.get("X-Request-ID")
        if rid and rid.strip():
            return rid.strip()
        return f"req-{uuid.uuid4().hex}"

    def _send_json(self, status: int, payload: dict, request_id: str | None = None) -> None:
        rid = request_id or self._request_id()
        envelope = dict(payload)
        if "requestId" not in envelope:
            envelope["requestId"] = rid
        body = json.dumps(envelope).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Request-ID", rid)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):  # 客户端已断开（如云侧超时中止）
            pass

    def _send_text(self, status: int, text: str, request_id: str | None = None) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if request_id:
            self.send_header("X-Request-ID", request_id)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

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
        rid = self._request_id()
        if self.path == "/health/live":
            self._send_json(200, {"ok": True, "service": "cpsat-worker"}, rid)
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
                rid,
            )
            return
        if self.path == "/metrics":
            _ensure_runtime()  # 保证并发 gauge 口径与运行池一致
            self._send_text(200, _METRICS.render(_current_concurrency()), rid)
            return
        self._send_json(
            404,
            {"error": {"code": "NOT_FOUND", "message": f"unknown path: {self.path}"}},
            rid,
        )

    def do_POST(self) -> None:
        if self.path != "/api/scheduler/v2/solve":
            self._send_json(
                404,
                {"error": {"code": "NOT_FOUND", "message": f"unknown path: {self.path}"}},
                self._request_id(),
            )
            return
        rid = self._request_id()
        try:
            raw = self._read_body()
            data = json.loads(raw)
            request = SolverRequest.from_dict(data)
        except ValueError as e:
            self._send_json(400, {"error": {"code": "BAD_REQUEST", "message": str(e)}}, rid)
            return
        except Exception as e:  # noqa: BLE001 - 契约解析失败统一 400
            self._send_json(
                400,
                {"error": {"code": "BAD_REQUEST", "message": f"invalid request: {e}"}},
                rid,
            )
            return

        # 问题规模上限（413）
        oversized = _problem_too_large(request)
        if oversized is not None:
            self._send_json(413, oversized, rid)
            return

        # 并发上限：有界信号量（提交前获取；超时 → 429）
        executor, semaphore = _ensure_runtime()
        queue_wait = max(0.0, CPSAT_WORKER_QUEUE_WAIT_MS / 1000.0)
        if not semaphore.acquire(timeout=queue_wait):
            self._send_json(
                429,
                {
                    "error": {
                        "code": "QUEUE_SATURATED",
                        "message": "solver concurrency saturated; retry later",
                    }
                },
                rid,
            )
            return

        started = time.monotonic()
        try:
            future = executor.submit(_solve_guarded, request, semaphore)
        except RuntimeError:  # 执行池已关闭（停机中）
            semaphore.release()
            self._send_json(
                503,
                {"error": {"code": "SHUTTING_DOWN", "message": "worker is shutting down"}},
                rid,
            )
            return
        budget = _time_budget_ms(request)
        try:
            status, payload, duration_ms = future.result(timeout=budget / 1000.0)
        except concurrent.futures.TimeoutError:
            # 时间预算触顶：返回 TIMEOUT JSON，不让客户端挂起。在途任务继续执行，
            # 其信号量由 _solve_guarded 释放；若任务尚未开始（排队中）则取消并补偿释放。
            _METRICS.record_timeout()
            cancelled = future.cancel()
            if cancelled:
                semaphore.release()
            status, payload, duration_ms = 200, _timeout_payload(request), float(budget)
        elapsed = (time.monotonic() - started) * 1000.0
        _METRICS.record_request(_status_label(status, payload), duration_ms if duration_ms else elapsed)
        self._send_json(status, payload, rid)


def _drain_executor(cap_ms: int = 5000) -> None:
    """排空在途求解（带上限；超上限后不阻塞进程退出）。"""
    executor, _sem = _ensure_runtime()
    drain = threading.Thread(
        target=executor.shutdown, kwargs={"wait": True, "cancel_futures": True}
    )
    drain.daemon = True
    drain.start()
    drain.join(timeout=cap_ms / 1000.0)
    if drain.is_alive():
        print("[cpsat-worker] drain cap exceeded; exiting with in-flight solves abandoned")


def main() -> None:
    ap = argparse.ArgumentParser(description="EWOH CP-SAT 求解 HTTP Worker")
    ap.add_argument(
        "--host",
        default="127.0.0.1",  # EDGE-114：默认仅绑回环，暴露到网络须显式指定
    )
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    _ensure_runtime()
    httpd = ThreadingHTTPServer((args.host, args.port), SolverHandler)
    httpd.timeout = 1.0  # 轮询循环定期观察停止信号
    print(
        f"[cpsat-worker] listening on http://{args.host}:{args.port} "
        f"(ortools={'available' if is_available() else 'MISSING -> UNAVAILABLE fallback'}, "
        f"max_concurrency={CPSAT_WORKER_MAX_CONCURRENCY}, ladder={ACTIVATION_LADDER})"
    )

    stop = threading.Event()

    def _handle_signal(signum, _frame) -> None:
        print(f"[cpsat-worker] signal {signum} received; graceful shutdown...")
        stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        while not stop.is_set():
            httpd.handle_request()
    finally:
        _drain_executor()
        httpd.server_close()
        print("[cpsat-worker] shutdown complete")


if __name__ == "__main__":
    main()
