#!/usr/bin/env python3
"""EWOH 平台服务层（纯标准库 HTTP 服务）。

覆盖任务：
- Task 4  平台数据源切换：全部数据接口读持久层 Storage，支持 real/controlled_test/simulated 过滤与来源标识
- Task 5  历史回放与原始数据导出（按设备+时间段，回放态/实时态区分）
- Task 15 九页 API 支撑：来源/更新时间/质量/版本/异常/证据入口
- Task 19 演示闭环：一键重置与六步演示指引
安全边界：本服务不提供任何写入急停、限扭、关节实时控制等安全闭环参数的接口。
"""

import csv
import io
import json
import ssl
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import services
from .config import Settings
from .monitoring import PrometheusExporter
from .rbac import check_export_role
from .scheduler.cpsat import solver as cpsat_solver
from .scheduler.cpsat.contract import SolverRequest
from .security import SecurityHeaders

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
# 离线判定 / 证据窗口：从统一配置读取（Task 32），不再硬编码
OFFLINE_AFTER_SEC = Settings.load().offline_after_sec  # 超过该时长无新遥测即判定离线
EVIDENCE_WINDOW_SEC = Settings.load().evidence_window_sec  # 事件证据窗口：前后各 N 秒
SOURCE_LABELS = {"real": "REAL DEVICE", "controlled_test": "受控数据", "simulated": "模拟数据"}

# Task 16.6 横切关注点：请求体上限与默认分页
MAX_BODY_BYTES = 1 * 1024 * 1024  # POST body 限制 1MB
DEFAULT_LIMIT = 100  # 列表端点默认分页大小


def now_iso():
    return services.iso(datetime.now())


parse_ts = services.parse_ts


def get_actor_from_request(handler):
    """从 Authorization header 解析 Bearer token 得到操作人身份。

    auth 模块未就绪时降级为 anonymous，保证平台在离线/演示场景可用。
    未携带 token 或解析失败一律返回 "anonymous"，不强制认证。
    """
    auth = (handler.headers.get("Authorization", "") or "").strip()
    if not auth.startswith("Bearer "):
        return "anonymous"
    token = auth[len("Bearer ") :].strip()
    if not token:
        return "anonymous"
    sm = _get_session_manager()
    if sm is None:
        return "anonymous"
    try:
        session = sm.verify(token)
        if session is not None:
            return session.user_id
    except Exception:
        pass
    return "anonymous"


# Task 16/27：SessionManager 单例（auth 模块就绪后懒加载）
_session_manager = None
_session_manager_lock = threading.Lock()


def _get_session_manager():
    """获取或创建 SessionManager 单例。auth 模块未就绪时返回 None。"""
    global _session_manager
    if _session_manager is not None:
        return _session_manager
    with _session_manager_lock:
        if _session_manager is None:
            try:
                from edge_platform.auth import SessionManager

                _session_manager = SessionManager()
            except ImportError:
                pass
    return _session_manager


class Context:
    """平台运行上下文：依赖按契约注入（联调前可注入 stub）。"""

    def __init__(
        self,
        storage,
        bus=None,
        pipeline=None,
        registry=None,
        rules=None,
        manager=None,
        metrics=None,
        scheduling_repository=None,
        event_bus=None,
        scheduler=None,
        resource_state_service=None,
        kafka=None,
    ):
        self.storage = storage
        self.bus = bus
        self.pipeline = pipeline
        self.registry = registry
        self.rules = rules
        self.manager = manager
        # Task 33：可注入 MetricsCollector 单例（run.py 创建）
        self.metrics = metrics
        # 智能调度持久化仓储（cmd-map-edge-scheduling）：调度数据落库，重启不丢失
        self.scheduling_repository = scheduling_repository
        # Phase 5：实时事件总线（SSE /api/command-map/stream 抽干其事件）
        self.event_bus = event_bus
        # 智能调度闭环服务（Phase 6 API 接线）
        self.scheduler = scheduler
        # Phase 3：统一实时资源状态聚合服务
        self.resource_state_service = resource_state_service
        # 实时事件通道（兼容命名；当前复用 event_bus，供未来接入外部消息队列）
        self.kafka = kafka if kafka is not None else event_bus
        self.started_at = time.time()
        self.assignments = []  # 人工确认派工记录（演示会话级，不自动派工）
        self.lock = threading.Lock()

    def device_online(self, d):
        """掉线判定：online 标志 + last_seen 新鲜度双重判断。"""
        last = parse_ts(d.get("last_seen"))
        fresh = bool(last) and (datetime.now().astimezone() - last).total_seconds() <= OFFLINE_AFTER_SEC
        return bool(d.get("online")) and fresh


def _device_view(ctx, d):
    v = dict(d)
    v["online"] = ctx.device_online(d)
    v["source_label"] = SOURCE_LABELS.get(d.get("source_type"), d.get("source_type"))
    return v


def _filter_source(items, source):
    if source in SOURCE_LABELS:
        return [x for x in items if x.get("source_type") == source]
    return items


def _latest_state(ctx, device_id):
    """实时态：最新一条遥测 + 最近推理结果。"""
    rec = services.norm_telemetry(ctx.storage.latest_telemetry(device_id))
    if not rec:
        return None
    end = parse_ts(rec.get("timestamp")) or datetime.now().astimezone()
    inf = ctx.storage.query_inference(
        device_id, services.iso(end - timedelta(seconds=10)), services.iso(end + timedelta(seconds=1)), 1
    )
    rec["inference"] = services.norm_inference(inf[-1]) if inf else None
    rec["source_label"] = SOURCE_LABELS.get(rec.get("source_type"), rec.get("source_type"))
    rec["mode"] = "realtime"
    return rec


def make_handler(ctx):
    class Handler(SimpleHTTPRequestHandler):
        # Task 16 演示用 token 存储（auth 模块未就绪时使用）；auth 就绪后由其管理
        _tokens = {}  # type: ignore[var-annotated]
        _tokens_lock = threading.Lock()

        def translate_path(self, path):
            parsed = urlparse(path).path
            if parsed.startswith("/api/"):
                return str(STATIC_DIR / "index.html")
            if parsed == "/":
                parsed = "/index.html"
            return str(STATIC_DIR / parsed.lstrip("/"))

        def log_message(self, fmt, *args):
            print("[EWOH]", fmt % args)

        # ---- Task 16.6 横切关注点：请求 ID 中间件 ----
        def send_response(self, code, message=None):
            # 每个请求生成 X-Request-ID（uuid4 hex 前 8 位），响应头返回
            if not getattr(self, "_request_id", None):
                inbound = self.headers.get("X-Request-ID") if self.headers else None
                self._request_id = inbound or uuid.uuid4().hex[:8]
            super().send_response(code, message)
            self.send_header("X-Request-ID", self._request_id)
            # CORS：指挥地图前端（ui/command_map）与 backend 跨端口部署时允许跨域，
            # 仅当请求携带 Origin 时回送（边缘平台本地部署，不构成公网风险）
            origin = self.headers.get("Origin") if self.headers else None
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Vary", "Origin")

        # ---- 基础工具 ----
        def _flush_post_audit(self):
            """在发送响应前刷新待审计的 POST 操作日志，避免客户端先收到响应的竞态。"""
            if getattr(self, "_post_audit_pending", False):
                self._post_audit_pending = False
                self._audit(
                    "POST " + urlparse(self.path).path,
                    target_type=getattr(self, "_audit_target_type", "api"),
                    target_id=getattr(self, "_audit_target_id", None),
                    result="success",
                )

        def send_json(self, obj, status=200, download=None):
            self._flush_post_audit()
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{download}"')
            self.end_headers()
            self.wfile.write(data)

        def send_csv(self, rows, columns, filename):
            """导出 CSV 附件（纯标准库 csv 模块）。"""
            self._flush_post_audit()
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(columns)
            for r in rows:
                writer.writerow([r.get(c, "") for c in columns])
            data = buf.getvalue().encode("utf-8-sig")  # BOM 便于 Excel 中文
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def read_json(self):
            # Task 16.6：POST body 限制 1MB
            n = int(self.headers.get("Content-Length", "0") or 0)
            if n > MAX_BODY_BYTES:
                # 分块排空 body，避免连接关闭时 RST 导致客户端收不到错误响应
                try:
                    remaining = n
                    while remaining > 0:
                        chunk = self.rfile.read(min(remaining, 65536))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                except Exception:
                    pass
                raise ValueError("请求体超过 1MB 限制")
            try:
                return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except ValueError:
                return {}

        def qs(self):
            return parse_qs(urlparse(self.path).query)

        def arg(self, name, default=""):
            return self.qs().get(name, [default])[0]

        def _limit(self):
            try:
                return max(0, int(self.arg("limit", str(DEFAULT_LIMIT)) or DEFAULT_LIMIT))
            except ValueError:
                return DEFAULT_LIMIT

        def _offset(self):
            try:
                return max(0, int(self.arg("offset", "0") or 0))
            except ValueError:
                return 0

        # ---- Task 16.6 统一错误响应 ----
        def _new_error(self, code, message, status):
            """统一错误响应：{error: {code, message, request_id}}"""
            self._post_audit_pending = False  # 校验错误不记 success 审计
            return self.send_json(
                {"error": {"code": code, "message": message, "request_id": getattr(self, "_request_id", "")}}, status
            )

        # ---- Task 16.6 操作人身份与审计 ----
        def _actor(self):
            return get_actor_from_request(self)

        def _audit(self, action, target_type=None, target_id=None, before=None, after=None, result="success"):
            """记录审计日志（失败不影响主流程）。"""
            try:
                ctx.storage.insert_audit_log(
                    action=action,
                    actor_id=self._actor(),
                    target_type=target_type,
                    target_id=target_id,
                    before=before,
                    after=after,
                    result=result,
                    request_id=getattr(self, "_request_id", None),
                    source_ip=self.client_address[0] if self.client_address else None,
                )
            except Exception:
                pass

        # ---- GET 路由 ----
        def do_GET(self):
            self._request_id = None  # keep-alive 复用实例时重置请求 ID
            self._post_audit_pending = False
            p = urlparse(self.path).path
            try:
                if p == "/api/status":
                    return self.send_json(self.api_status())
                if p == "/metrics":
                    return self.send_metrics()
                if p == "/api/inference/metrics":
                    return self.send_json(self.api_inference_metrics())
                if p == "/api/devices":
                    items = [
                        _device_view(ctx, d) for d in _filter_source(ctx.storage.list_devices(), self.arg("source"))
                    ]
                    return self.send_json({"items": items, "now": now_iso(), "offline_after_sec": OFFLINE_AFTER_SEC})
                if p == "/api/people":
                    return self.send_json({"items": ctx.storage.list_people(), "now": now_iso()})
                if p == "/api/telemetry":
                    return self.api_latest()
                if p == "/api/telemetry/series":
                    return self.api_series()
                if p == "/api/telemetry/export":
                    return self.api_export()
                if p == "/api/inference":
                    return self.api_inference()
                if p == "/api/person/profile":
                    return self.api_profile()
                if p == "/api/events":
                    items = [
                        services.norm_event(e) for e in ctx.storage.list_events(int(self.arg("limit", "100") or 100))
                    ]
                    for e in items:
                        e["source_label"] = SOURCE_LABELS.get(e.get("source_type"), e.get("source_type"))
                    return self.send_json({"items": _filter_source(items, self.arg("source")), "now": now_iso()})
                if p == "/api/event":
                    return self.api_event_detail()
                if p == "/api/tasks/assignments":
                    return self.send_json({"items": ctx.assignments})
                # ---- 智能调度（Phase 3/5/6）----
                if p == "/api/resources/state":
                    return self.api_resource_state()
                if p == "/api/command-map/stream":
                    return self.api_command_map_stream()
                if p == "/api/tasks":
                    return self.api_tasks()
                if p == "/api/scheduling/requests":
                    items = [r.to_dict() for r in ctx.scheduler.list_requests()] if ctx.scheduler else []
                    return self.send_json({"items": items})
                if p == "/api/scheduling/plans":
                    return self.api_scheduling_plans()
                if p == "/api/scheduler/v2/solver/health":
                    return self.send_json(
                        {
                            "ok": True,
                            "available": cpsat_solver.is_available(),
                            "solverVersion": "cpsat-v1",
                        }
                    )
                if p == "/api/assignments":
                    return self.api_assignments()
                if p.startswith("/api/tasks/") and p != "/api/tasks/":
                    parts = p[len("/api/tasks/") :].split("/")
                    if len(parts) == 1 and parts[0]:
                        return self.api_task_detail(parts[0])
                    return self._new_error("not_found", "路径不存在", 404)
                if p.startswith("/api/scheduling/requests/") and p != "/api/scheduling/requests/":
                    parts = p[len("/api/scheduling/requests/") :].split("/")
                    if len(parts) == 1 and parts[0]:
                        return self.api_scheduling_request_detail(parts[0])
                    return self._new_error("not_found", "路径不存在", 404)
                if p.startswith("/api/scheduling/plans/") and p != "/api/scheduling/plans/":
                    parts = p[len("/api/scheduling/plans/") :].split("/")
                    if len(parts) == 1 and parts[0]:
                        return self.api_scheduling_plan_detail(parts[0])
                    return self._new_error("not_found", "路径不存在", 404)
                if p == "/api/demo/guide":
                    return self.send_json({"steps": DEMO_STEPS})
                # ---- Task 30：安全策略查询（不暴露密钥） ----
                if p == "/api/security/policy":
                    return self.api_security_policy()
                # ---- Task 16 新增 GET 端点（RESTful 路径参数版本） ----
                if p == "/api/me":
                    return self.api_me()
                if p == "/api/audit":
                    return self.api_audit()
                if p == "/api/models":
                    return self.api_models()
                if p == "/api/rules":
                    return self.api_rules()
                if p.startswith("/api/devices/") and p != "/api/devices/":
                    parts = p[len("/api/devices/") :].split("/")
                    if len(parts) == 1 and parts[0]:
                        return self.api_device_detail(parts[0])
                    if len(parts) == 2 and parts[1] == "health":
                        return self.api_device_health(parts[0])
                    return self._new_error("not_found", "路径不存在", 404)
                if p.startswith("/api/events/") and p != "/api/events/":
                    parts = p[len("/api/events/") :].split("/")
                    if len(parts) == 1 and parts[0]:
                        return self.api_event_detail_v2(parts[0])
                    return self._new_error("not_found", "路径不存在", 404)
            except BrokenPipeError:
                return
            except Exception as e:  # 统一错误出口，避免泄露内部细节
                return self.send_json({"error": "请求处理失败", "detail": str(e)}, 500)
            return super().do_GET()

        # ---- POST 路由 ----
        def do_POST(self):
            self._request_id = None  # keep-alive 复用实例时重置请求 ID
            self._post_audit_pending = False
            # 提前生成 request_id，确保审计日志能关联到本次请求
            inbound = self.headers.get("X-Request-ID") if self.headers else None
            self._request_id = inbound or uuid.uuid4().hex[:8]
            p = urlparse(self.path).path
            try:
                payload = self.read_json()
            except ValueError as e:
                # Task 16.6：请求体超 1MB
                return self._new_error("body_too_large", str(e), 400)
            # Task 16.6：POST 操作自动审计（action/path/actor_id/request_id）
            # 审计在 send_json/send_csv 发送响应前写入，避免竞态
            self._post_audit_pending = True
            self._audit_target_type = "api"
            self._audit_target_id = None
            try:
                if p == "/api/event/status":
                    self.api_event_status(payload)
                    return
                if p == "/api/tasks/recommend":
                    res = services.recommend(ctx.storage, ctx.assignments, payload, ctx.device_online)
                    if ctx.metrics is not None:
                        ctx.metrics.record_recommendation()
                    self.send_json(res)
                    return
                if p == "/api/tasks/confirm":
                    res = services.confirm_assignment(ctx.storage, ctx.assignments, payload, ctx.device_online)
                    if res.get("ok") and ctx.metrics is not None:
                        ctx.metrics.record_assignment_confirmed()
                    self.send_json(res, 200 if res.get("ok") else 409)
                    return
                if p == "/api/query":
                    self.send_json(
                        services.answer(ctx.storage, payload.get("question", ""), ctx.device_online, ctx.assignments)
                    )
                    return
                if p == "/api/scenario/evaluate":
                    self.send_json(services.evaluate_scenario(payload))
                    return
                if p == "/api/vision/understand":
                    self.api_vision_understand(payload)
                    return
                if p == "/api/reset":
                    self.api_reset()
                    return
                # ---- Task 16 新增 POST 端点 ----
                if p == "/api/auth/login":
                    self.api_auth_login(payload)
                    return
                if p == "/api/auth/refresh":
                    self.api_auth_refresh()
                    return
                if p == "/api/telemetry/export":
                    self.api_export_post(payload)
                    return
                if p.startswith("/api/events/") and p.endswith("/status"):
                    self.api_event_status_v2(p[len("/api/events/") : -len("/status")], payload)
                    return
                if p.startswith("/api/events/") and p.endswith("/comment"):
                    self.api_event_comment(p[len("/api/events/") : -len("/comment")], payload)
                    return
                # ---- 智能调度（Phase 6）----
                if p == "/api/tasks":
                    return self.api_create_task(payload)
                if p == "/api/scheduling/requests":
                    return self.api_create_scheduling_request(payload)
                if p.startswith("/api/scheduling/plans/") and p.endswith("/confirm"):
                    return self.api_confirm_plan(p[len("/api/scheduling/plans/") : -len("/confirm")], payload)
                if p.startswith("/api/scheduling/plans/") and p.endswith("/reject"):
                    return self.api_reject_plan(p[len("/api/scheduling/plans/") : -len("/reject")], payload)
                if p.startswith("/api/scheduling/plans/") and p.endswith("/replan"):
                    return self.api_replan_plan(p[len("/api/scheduling/plans/") : -len("/replan")], payload)
                if p.startswith("/api/assignments/") and p.endswith("/start"):
                    return self.api_assignment_status(
                        p[len("/api/assignments/") : -len("/start")], "executing", payload
                    )
                if p.startswith("/api/assignments/") and p.endswith("/pause"):
                    return self.api_assignment_status(
                        p[len("/api/assignments/") : -len("/pause")], "paused", payload
                    )
                if p.startswith("/api/assignments/") and p.endswith("/complete"):
                    return self.api_assignment_status(
                        p[len("/api/assignments/") : -len("/complete")], "completed", payload
                    )
                if p.startswith("/api/assignments/") and p.endswith("/cancel"):
                    return self.api_assignment_status(
                        p[len("/api/assignments/") : -len("/cancel")], "cancelled", payload
                    )
                if p.startswith("/api/assignments/") and p.endswith("/override"):
                    return self.api_assignment_override(p[len("/api/assignments/") : -len("/override")], payload)
                if p == "/api/scheduler/v2/solve":
                    try:
                        resp = cpsat_solver.solve(SolverRequest.from_dict(payload))
                        return self.send_json({"ok": True, "response": resp.to_dict()})
                    except Exception as e:
                        return self._new_error("solver_error", str(e), 500)
                self._post_audit_pending = False  # 404 不审计
                return self.send_json({"error": "not found"}, 404)
            except BrokenPipeError:
                self._post_audit_pending = False
                return
            except Exception as e:
                self._post_audit_pending = False
                self._audit(
                    "POST " + p,
                    target_type=getattr(self, "_audit_target_type", "api"),
                    target_id=getattr(self, "_audit_target_id", None),
                    result="error",
                )
                return self.send_json({"error": "请求处理失败", "detail": str(e)}, 500)

        def do_HEAD(self):
            self._request_id = None  # keep-alive 复用实例时重置请求 ID
            return super().do_HEAD()

        def do_PATCH(self):
            """PATCH /api/tasks/{id} — 乐观锁局部更新任务（status/priority 等）。"""
            self._request_id = None
            self._post_audit_pending = False
            p = urlparse(self.path).path
            try:
                payload = self.read_json()
            except ValueError as e:
                return self._new_error("body_too_large", str(e), 400)
            if not p.startswith("/api/tasks/") or p == "/api/tasks/":
                return self.send_json({"error": "not found"}, 404)
            task_id = p[len("/api/tasks/") :].split("/")[0]
            if not task_id:
                return self.send_json({"error": "not found"}, 404)
            return self.api_update_task(task_id, payload)

        def do_OPTIONS(self):
            """CORS 预检：允许指挥地图前端跨端口调用 API（本地边缘部署）。"""
            self._request_id = None
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        # ---- API 实现 ----
        def api_status(self):
            try:
                counts = ctx.storage.counts()
                db_ok = isinstance(counts, dict)
            except Exception:
                counts, db_ok = {}, False
            latency = {}
            if ctx.pipeline and hasattr(ctx.pipeline, "latency_stats"):
                try:
                    latency = ctx.pipeline.latency_stats()
                except Exception:
                    latency = {}
            model = {"active": None, "versions": [], "mode": "rules_only"}
            if ctx.registry:
                try:
                    model = {
                        "active": ctx.registry.active(),
                        "versions": ctx.registry.versions(),
                        "mode": "model" if ctx.registry.active() else "rules_only",
                    }
                except Exception:
                    pass
            services_health = {
                "gateway": "healthy",  # 本 HTTP 网关
                "database": "healthy" if db_ok else "down",  # SQLite 持久层
                "inference": "healthy" if ctx.pipeline else ("rules_only" if ctx.rules else "unknown"),
                "assistant": "healthy",  # 本地白名单助手，无外部依赖
                "adapters": "healthy" if ctx.manager else "not_running",
            }
            return {
                "offline": True,
                "now": now_iso(),
                "uptime_sec": round(time.time() - ctx.started_at),
                "services": services_health,
                "db_counts": counts,
                "latency": latency,
                "model": model,
                "rule_version": getattr(ctx.rules, "rule_version", None),
                "listeners": getattr(ctx.manager, "listeners", {}),
                "source_labels": SOURCE_LABELS,
                "safety_boundary": "平台与大模型不得写入急停、限扭、关节实时控制等安全闭环参数。",
            }

        # ---- Task 33：监控指标 ----
        def _refresh_device_stats(self):
            """根据当前设备/遥测态刷新 MetricsCollector 的设备级指标。

            - online/offline：基于 device_online 双重判定
            - low_battery：最近遥测 load_score 不参与；以 telemetry.battery_level < 20 计
            - avg_packet_loss_pct：取最近遥测 packet_loss_pct 的均值（缺失视为 0）
            """
            if ctx.metrics is None:
                return
            devices = ctx.storage.list_devices()
            online = sum(1 for d in devices if ctx.device_online(d))
            offline = len(devices) - online
            low_battery, loss_values = 0, []
            for d in devices:
                rec = services.norm_telemetry(ctx.storage.latest_telemetry(d.get("device_id")))
                if not rec:
                    continue
                tel = rec.get("telemetry") or {}
                batty = tel.get("battery_level")
                try:
                    if batty is not None and float(batty) < 20:
                        low_battery += 1
                except (TypeError, ValueError):
                    pass
                loss = tel.get("packet_loss_pct")
                try:
                    if loss is not None:
                        loss_values.append(float(loss))
                except (TypeError, ValueError):
                    pass
            avg_loss = (sum(loss_values) / len(loss_values)) if loss_values else 0.0
            ctx.metrics.set_device_stats(online, offline, avg_packet_loss_pct=avg_loss, low_battery_count=low_battery)

        def send_metrics(self):
            """Task 33：Prometheus exposition format（text/plain; version=0.0.4）。"""
            if ctx.metrics is None:
                return self.send_json({"error": "metrics collector 未启用"}, 503)
            self._refresh_device_stats()
            text = PrometheusExporter().format_prometheus(ctx.metrics.snapshot())
            data = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def api_inference_metrics(self):
            """Task 33：推理延迟/吞吐/unknown 占比 JSON。

            优先取 MetricsCollector 的累计统计；若未注入则回落到 pipeline.latency_stats()。
            """
            now = datetime.now().astimezone()
            start = parse_ts(self.arg("start")) or (now - timedelta(hours=24))
            end = parse_ts(self.arg("end")) or now
            limit = int(self.arg("limit", "5000") or 5000)
            # 从持久层统计 unknown 占比（按时间段）
            inf_rows = []
            try:
                for d in ctx.storage.list_devices():
                    inf_rows.extend(
                        ctx.storage.query_inference(d.get("device_id"), services.iso(start), services.iso(end), limit)
                    )
            except Exception:
                inf_rows = []
            total = len(inf_rows)
            unknown = sum(1 for r in inf_rows if (r.get("label") == "unknown"))
            unknown_ratio = round(unknown / total, 4) if total else 0.0
            # 延迟优先用 collector 累计值（覆盖所有历史样本），其次用 pipeline.latency_stats
            p50_ms = p95_ms = None
            count = 0
            if ctx.metrics is not None:
                snap = ctx.metrics.snapshot()
                count = snap.get("inference_count", 0)
                p50_ms = snap.get("inference_p50_ms")
                p95_ms = snap.get("inference_p95_ms")
                errors = snap.get("error_count", 0)
                unknown_total = snap.get("unknown_count", 0)
            else:
                errors = 0
                unknown_total = 0
            if ctx.pipeline is not None:
                try:
                    if hasattr(ctx.pipeline, "latency_stats"):
                        lat = ctx.pipeline.latency_stats() or {}
                    elif hasattr(ctx.pipeline, "metrics"):
                        lat = ctx.pipeline.metrics() or {}
                    else:
                        lat = {}
                except Exception:
                    lat = {}
                if p50_ms is None:
                    p50_ms = lat.get("p50_ms") or lat.get("p50")
                if p95_ms is None:
                    p95_ms = lat.get("p95_ms") or lat.get("p95")
                if not count:
                    count = lat.get("count", 0)
            # 吞吐：按查询窗口内推理数估算每秒吞吐
            window_sec = max(1.0, (end - start).total_seconds())
            throughput_per_sec = round(total / window_sec, 4)
            return {
                "now": now_iso(),
                "window": {"start": services.iso(start), "end": services.iso(end)},
                "inference_count": count,
                "window_inference_count": total,
                "inference_p50_ms": p50_ms,
                "inference_p95_ms": p95_ms,
                "throughput_per_sec": throughput_per_sec,
                "unknown_count": unknown_total,
                "window_unknown_count": unknown,
                "unknown_ratio": unknown_ratio,
                "error_count": errors,
                "source": "metrics_collector" if ctx.metrics is not None else "pipeline",
            }

        def api_latest(self):
            device_id = self.arg("device_id")
            if not device_id:
                devices = _filter_source(ctx.storage.list_devices(), self.arg("source"))
                device_id = devices[0]["device_id"] if devices else ""
            rec = _latest_state(ctx, device_id)
            if not rec:
                return self.send_json({"error": "no data", "device_id": device_id, "mode": "realtime"}, 404)
            return self.send_json(rec)

        def api_series(self):
            """回放态：按设备+时间段返回原始时间序列（正序）。"""
            device_id, start, end = self.arg("device_id"), self.arg("start"), self.arg("end")
            limit = int(self.arg("limit", "2000") or 2000)
            if not (device_id and parse_ts(start) and parse_ts(end)):
                return self.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
            rows = ctx.storage.query_telemetry(
                device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)), limit
            )
            items = [services.norm_telemetry(r) for r in rows]
            inf = [
                services.norm_inference(r)
                for r in ctx.storage.query_inference(
                    device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)), limit
                )
            ]
            for r in items:
                r["source_label"] = SOURCE_LABELS.get(r.get("source_type"), r.get("source_type"))
            return self.send_json(
                {
                    "device_id": device_id,
                    "mode": "replay",
                    "items": items,
                    "inference": inf,
                    "start": start,
                    "end": end,
                    "now": now_iso(),
                }
            )

        def api_export(self):
            """原始数据片段导出（Task 5）：JSON 附件下载，携带来源标识。"""
            if self._enforce_export_role():
                return
            device_id, start, end = self.arg("device_id"), self.arg("start"), self.arg("end")
            if not (device_id and parse_ts(start) and parse_ts(end)):
                return self.send_json({"error": "需要 device_id/start/end（ISO 时间）"}, 400)
            slice_ = ctx.storage.export_slice(device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)))
            if isinstance(slice_, list):
                slice_ = {"records": slice_}
            out = {
                "export_type": "raw_slice",
                "device_id": device_id,
                "start": start,
                "end": end,
                "exported_at": now_iso(),
                "slice": slice_,
            }
            fname = f"ewoh_slice_{device_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            return self.send_json(out, download=fname)

        def api_inference(self):
            device_id = self.arg("device_id")
            now = datetime.now().astimezone()
            start = parse_ts(self.arg("start")) or (now - timedelta(hours=24))
            end = parse_ts(self.arg("end")) or now
            limit = int(self.arg("limit", "200") or 200)
            items = [
                services.norm_inference(r)
                for r in ctx.storage.query_inference(device_id, services.iso(start), services.iso(end), limit)
            ]
            return self.send_json({"items": items, "now": now_iso()})

        def api_profile(self):
            """单人作业画像：人员 + 绑定设备 + 当前状态 + 24h 动作分布 + 未处置事件。"""
            pid = self.arg("person_id")
            person = next((p for p in ctx.storage.list_people() if p.get("person_id") == pid), None)
            if not person:
                return self.send_json({"error": "人员不存在"}, 404)
            dev = next((d for d in ctx.storage.list_devices() if d.get("person_id") == pid), None)
            now = datetime.now().astimezone()
            dist, latest, quality = {}, None, "unknown"
            if dev:
                latest = _latest_state(ctx, dev["device_id"])
                quality = (latest or {}).get("quality", {}).get("status", "unknown")
                start = services.iso(now - timedelta(hours=24))
                for r in ctx.storage.query_inference(dev["device_id"], start, services.iso(now), 2000):
                    r = services.norm_inference(r)
                    dist[r.get("label", "unknown")] = dist.get(r.get("label", "unknown"), 0) + 1
            metrics = services.person_metrics(ctx.storage, person, dev)
            events = [
                services.norm_event(e)
                for e in ctx.storage.list_events(100)
                if services.norm_event(e).get("person_id") == pid
            ]
            return self.send_json(
                {
                    "person": person,
                    "skills": services.person_skills(person),
                    "device": _device_view(ctx, dev) if dev else None,
                    "latest": latest,
                    "action_distribution_24h": dist,
                    "metrics": metrics,
                    "events": events[:10],
                    "quality": quality,
                    "now": now_iso(),
                }
            )

        def api_event_detail(self):
            """事件详情 + 前后各 30 秒证据窗口（可追溯到原始数据）。"""
            eid = self.arg("id")
            evt = services.norm_event(ctx.storage.get_event(eid))
            if not evt:
                return self.send_json({"error": "事件不存在"}, 404)
            t0 = parse_ts(evt.get("start_time"))
            t1 = parse_ts(evt.get("end_time")) or t0
            records, dev_id = [], evt.get("device_id")
            if t0 and dev_id:
                rows = ctx.storage.query_telemetry(
                    dev_id,
                    services.iso(t0 - timedelta(seconds=EVIDENCE_WINDOW_SEC)),
                    services.iso(t1 + timedelta(seconds=EVIDENCE_WINDOW_SEC)),
                    500,
                )
                records = [services.norm_telemetry(r) for r in rows]
            evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
            return self.send_json(
                {
                    "event": evt,
                    "evidence_window_sec": EVIDENCE_WINDOW_SEC,
                    "evidence_records": records,
                    "now": now_iso(),
                }
            )

        def api_event_status(self, payload):
            eid, status = payload.get("event_id"), payload.get("status")
            if status not in ("open", "confirmed", "closed", "dismissed"):
                return self.send_json({"error": "非法状态"}, 400)
            handling = payload.get("handling") or {}
            handling.setdefault("handled_by", payload.get("handled_by", ""))
            handling.setdefault("handled_at", now_iso())
            # Task 33：业务级指标——事件开/闭计数与关闭时长
            if ctx.metrics is not None:
                before = services.norm_event(ctx.storage.get_event(eid)) or {}
                if status == "open" and before.get("status") != "open":
                    ctx.metrics.record_event_open()
                elif status in ("closed", "dismissed") and before.get("status") not in ("closed", "dismissed"):
                    t0 = parse_ts(before.get("start_time"))
                    t1 = parse_ts(before.get("end_time")) or parse_ts(handling.get("handled_at"))
                    if t0 and t1:
                        try:
                            hours = max(0.0, (t1 - t0).total_seconds() / 3600.0)
                            ctx.metrics.record_event_close(hours)
                        except Exception:
                            pass
            ctx.storage.update_event_status(eid, status, handling)
            return self.send_json({"ok": True, "event": services.norm_event(ctx.storage.get_event(eid))})

        def api_reset(self):
            """一键重置（Task 19）：清空演示派工与模拟态数据；真实数据必须保留。"""
            with ctx.lock:
                ctx.assignments.clear()
            note = "已清空人工确认记录。"
            if hasattr(ctx.storage, "reset_demo"):
                ctx.storage.reset_demo()
                note += "模拟/受控演示数据已重置；真实设备数据不受影响。"
            else:
                note += "持久层数据保持不动（真实数据不做清除）。"
            return self.send_json({"ok": True, "note": note, "now": now_iso()})

        def api_vision_understand(self, payload):
            """POST /api/vision/understand — 视觉理解（演示模式默认后端：Ark）。

            body: {image_url?, question?, api_key?, base_url?, model?}。
            image_url 缺省时使用演示模式默认图，question 缺省为"你看见了什么？"。
            api_key/base_url/model 为可选的请求级覆盖（优先级高于环境变量），
            用于前端设置里管理员填写/替换演示用的方舟密钥。未配置 API Key 时返回明确错误。
            """
            from edge_platform.perception.ark_vision import describe_image

            image_url = (payload.get("image_url") or "").strip()
            question = (payload.get("question") or "").strip()
            api_key = (payload.get("api_key") or "").strip()
            base_url = (payload.get("base_url") or "").strip()
            model = (payload.get("model") or "").strip()
            self._audit_target_type = "vision"
            self._audit_target_id = (image_url or "demo_default")[:120]
            result = describe_image(image_url, question, api_key=api_key, base_url=base_url, model=model)
            if not result.get("ok"):
                return self.send_json(
                    {
                        "ok": False,
                        "backend": result.get("backend", "ark"),
                        "error": result.get("error", "视觉理解失败"),
                        "now": now_iso(),
                    },
                    502,
                )
            return self.send_json(
                {
                    "ok": True,
                    "backend": result.get("backend", "ark"),
                    "model": result.get("model"),
                    "answer": result.get("answer", ""),
                    "now": now_iso(),
                }
            )

        # ---- Task 16 新增端点实现 ----

        def _bearer_token(self):
            """从 Authorization header 提取 Bearer token；缺失返回空串。"""
            auth = (self.headers.get("Authorization", "") or "").strip()
            if auth.startswith("Bearer "):
                return auth[len("Bearer ") :].strip()
            return ""

        def _enforce_export_role(self):
            """导出端点 RBAC 校验：携带 Bearer token 且会话有效时，校验角色是否在导出允许名单内。

            无 token（演示/离线模式）或会话无效时放行，不破坏现有无认证调用；
            仅当 token 解析出有效会话且角色不在 export_allowed_roles 时返回 403。
            返回 True 表示已发送 403 响应（调用方应直接 return），False 表示放行。
            """
            token = self._bearer_token()
            if not token:
                return False
            sm = _get_session_manager()
            if sm is None:
                return False
            try:
                session = sm.verify(token)
            except Exception:
                return False
            if session is None:
                return False
            allowed = Settings.load().export_allowed_roles
            if not check_export_role(session.role, allowed):
                self._new_error("forbidden", "当前角色无导出权限", 403)
                return True
            return False

        def api_auth_login(self, payload):
            """POST /api/auth/login — {username, password} → {token, user}。

            auth 模块未就绪时使用演示用 token（uuid4 hex）；auth 就绪后委派 SessionManager。
            """
            username = (payload.get("username") or "").strip()
            password = (payload.get("password") or "").strip()
            if not username or not password:
                return self._new_error("invalid_credentials", "用户名或密码不能为空", 400)
            self._audit_target_type = "auth"
            self._audit_target_id = username
            sm = _get_session_manager()
            if sm is not None:
                token = sm.login(username, password)
                if token is None:
                    return self._new_error("invalid_credentials", "用户名或密码错误或已锁定", 401)
                session = sm.verify(token)
                user = {"user_id": session.user_id, "username": username, "role": session.role}
                return self.send_json({"token": token, "user": user})
            # auth 模块未就绪：演示用简单 token
            token = uuid.uuid4().hex
            user = {"user_id": username, "username": username, "role": "admin"}
            with self._tokens_lock:
                self._tokens[token] = user
            return self.send_json({"token": token, "user": user})

        def api_auth_refresh(self):
            """POST /api/auth/refresh — Bearer token → 新 token（旋转）。"""
            token = self._bearer_token()
            if not token:
                return self._new_error("unauthorized", "缺少 Authorization Bearer token", 401)
            sm = _get_session_manager()
            if sm is not None:
                session = sm.verify(token)
                if session is None:
                    return self._new_error("unauthorized", "token 无效或已过期", 401)
                sm.revoke(token)
                # 用同一用户身份创建新会话
                from edge_platform.auth import User  # noqa: F401

                new_token = sm.create(
                    User(user_id=session.user_id, username=session.user_id, role=session.role, display_name="")
                )
                user = {"user_id": session.user_id, "role": session.role}
                self._audit_target_type = "auth"
                self._audit_target_id = session.user_id
                return self.send_json({"token": new_token, "user": user})
            # fallback：演示用 token 旋转
            with self._tokens_lock:
                user = self._tokens.get(token)
                if user is None:
                    return self._new_error("unauthorized", "token 无效或已过期", 401)
                new_token = uuid.uuid4().hex
                self._tokens[new_token] = user
                del self._tokens[token]
            self._audit_target_type = "auth"
            self._audit_target_id = user.get("user_id") or user.get("username")
            return self.send_json({"token": new_token, "user": user})

        def api_me(self):
            """GET /api/me — Bearer token → 当前用户信息。"""
            token = self._bearer_token()
            if not token:
                return self._new_error("unauthorized", "缺少 Authorization Bearer token", 401)
            sm = _get_session_manager()
            if sm is not None:
                session = sm.verify(token)
                if session is None:
                    return self._new_error("unauthorized", "token 无效或已过期", 401)
                return self.send_json({"user": {"user_id": session.user_id, "role": session.role}})
            # fallback：演示用 token
            with self._tokens_lock:
                user = self._tokens.get(token)
            if not user:
                return self._new_error("unauthorized", "token 无效或已过期", 401)
            return self.send_json({"user": user})

        def api_device_detail(self, device_id):
            """GET /api/devices/{device_id} — 单设备详情。"""
            d = next((x for x in ctx.storage.list_devices() if x.get("device_id") == device_id), None)
            if not d:
                return self._new_error("not_found", "设备不存在", 404)
            return self.send_json({"device": _device_view(ctx, d), "now": now_iso()})

        def api_device_health(self, device_id):
            """GET /api/devices/{device_id}/health — 在线/电量/故障/丢包/最后通信。"""
            d = next((x for x in ctx.storage.list_devices() if x.get("device_id") == device_id), None)
            if not d:
                return self._new_error("not_found", "设备不存在", 404)
            rec = services.norm_telemetry(ctx.storage.latest_telemetry(device_id)) or {}
            tele = rec.get("telemetry") or {}
            quality = rec.get("quality") or {}
            health = {
                "device_id": device_id,
                "online": ctx.device_online(d),
                "last_seen": d.get("last_seen"),
                "battery_pct": tele.get("battery_pct", tele.get("battery_level")),
                "fault": bool(tele.get("fault")) or quality.get("status", "good") not in ("good", None, "unknown"),
                "packet_loss_pct": quality.get("packet_loss_pct", 0.0),
                "quality_status": quality.get("status", "unknown"),
                "now": now_iso(),
            }
            return self.send_json(health)

        def api_export_post(self, payload):
            """POST /api/telemetry/export — body 导出遥测（需审计）。支持 json/csv。"""
            if self._enforce_export_role():
                return
            device_id = payload.get("device_id") or ""
            start = payload.get("start") or ""
            end = payload.get("end") or ""
            fmt = (payload.get("format") or "json").lower()
            if not (device_id and parse_ts(start) and parse_ts(end)):
                return self._new_error("invalid_params", "需要 device_id/start/end（ISO 时间）", 400)
            if fmt not in ("json", "csv"):
                return self._new_error("invalid_format", "format 仅支持 json/csv", 400)
            slice_ = ctx.storage.export_slice(device_id, services.iso(parse_ts(start)), services.iso(parse_ts(end)))
            if isinstance(slice_, list):
                slice_ = {"records": slice_}
            records = slice_.get("records", [])
            self._audit_target_type = "telemetry"
            self._audit_target_id = device_id
            if fmt == "csv":
                cols = ["record_id", "device_id", "timestamp", "sequence", "source_type", "telemetry", "quality"]
                flat = []
                for r in records:
                    row = dict(r)
                    row["telemetry"] = json.dumps(r.get("telemetry", {}), ensure_ascii=False)
                    row["quality"] = json.dumps(r.get("quality", {}), ensure_ascii=False)
                    flat.append(row)
                return self.send_csv(flat, cols, f"ewoh_slice_{device_id}.csv")
            out = {
                "export_type": "raw_slice",
                "device_id": device_id,
                "start": start,
                "end": end,
                "format": fmt,
                "exported_at": now_iso(),
                "slice": slice_,
                "request_id": getattr(self, "_request_id", ""),
            }
            fname = f"ewoh_slice_{device_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            return self.send_json(out, download=fname)

        def api_event_detail_v2(self, event_id):
            """GET /api/events/{event_id} — 单事件详情（含证据/handling）。"""
            evt = services.norm_event(ctx.storage.get_event(event_id))
            if not evt:
                return self._new_error("not_found", "事件不存在", 404)
            t0 = parse_ts(evt.get("start_time"))
            t1 = parse_ts(evt.get("end_time")) or t0
            records, dev_id = [], evt.get("device_id")
            if t0 and dev_id:
                rows = ctx.storage.query_telemetry(
                    dev_id,
                    services.iso(t0 - timedelta(seconds=EVIDENCE_WINDOW_SEC)),
                    services.iso(t1 + timedelta(seconds=EVIDENCE_WINDOW_SEC)),
                    500,
                )
                records = [services.norm_telemetry(r) for r in rows]
            evt["source_label"] = SOURCE_LABELS.get(evt.get("source_type"), evt.get("source_type"))
            handlings = (
                ctx.storage.list_event_handlings(event_id) if hasattr(ctx.storage, "list_event_handlings") else []
            )
            return self.send_json(
                {
                    "event": evt,
                    "evidence_window_sec": EVIDENCE_WINDOW_SEC,
                    "evidence_records": records,
                    "handlings": handlings,
                    "now": now_iso(),
                }
            )

        def api_event_status_v2(self, event_id, payload):
            """POST /api/events/{event_id}/status — 更新事件处置状态。"""
            status = payload.get("status")
            if status not in ("open", "confirmed", "closed", "dismissed"):
                return self._new_error("invalid_status", "非法状态", 400)
            evt = ctx.storage.get_event(event_id)
            if not evt:
                return self._new_error("not_found", "事件不存在", 404)
            handler_id = payload.get("handler_id") or payload.get("handled_by") or self._actor()
            action = payload.get("action") or status
            comment = payload.get("comment")
            handling = {"handled_by": handler_id, "handled_at": now_iso(), "action": action, "comment": comment}
            ctx.storage.update_event_status(event_id, status, handling)
            if hasattr(ctx.storage, "insert_event_handling"):
                ctx.storage.insert_event_handling(
                    event_id, handler_id, action, comment=comment, audit_ref=getattr(self, "_request_id", None)
                )
            self._audit_target_type = "risk_event"
            self._audit_target_id = event_id
            return self.send_json({"ok": True, "event": services.norm_event(ctx.storage.get_event(event_id))})

        def api_event_comment(self, event_id, payload):
            """POST /api/events/{event_id}/comment — 添加事件评论。"""
            comment = (payload.get("comment") or "").strip()
            author_id = (payload.get("author_id") or self._actor()).strip()
            if not comment:
                return self._new_error("invalid_params", "comment 不能为空", 400)
            if not ctx.storage.get_event(event_id):
                return self._new_error("not_found", "事件不存在", 404)
            rec = None
            if hasattr(ctx.storage, "insert_event_handling"):
                rec = ctx.storage.insert_event_handling(
                    event_id, author_id, "comment", comment=comment, audit_ref=getattr(self, "_request_id", None)
                )
            self._audit_target_type = "risk_event"
            self._audit_target_id = event_id
            return self.send_json({"ok": True, "handling": rec, "now": now_iso()})

        def api_audit(self):
            """GET /api/audit — 查询审计日志（?action=&actor_id=&limit=&offset= 分页）。"""
            action = self.arg("action") or None
            actor_id = self.arg("actor_id") or None
            limit, offset = self._limit(), self._offset()
            items = (
                ctx.storage.list_audit_logs(action=action, actor_id=actor_id, limit=limit, offset=offset)
                if hasattr(ctx.storage, "list_audit_logs")
                else []
            )
            return self.send_json({"items": items, "limit": limit, "offset": offset, "now": now_iso()})

        def api_models(self):
            """GET /api/models — 查询已注册模型列表。"""
            limit, offset = self._limit(), self._offset()
            items = ctx.storage.list_models() if hasattr(ctx.storage, "list_models") else []
            return self.send_json(
                {"items": items[offset : offset + limit], "limit": limit, "offset": offset, "now": now_iso()}
            )

        def api_rules(self):
            """GET /api/rules — 查询已注册规则列表。"""
            limit, offset = self._limit(), self._offset()
            items = ctx.storage.list_rules() if hasattr(ctx.storage, "list_rules") else []
            return self.send_json(
                {"items": items[offset : offset + limit], "limit": limit, "offset": offset, "now": now_iso()}
            )

        def api_security_policy(self):
            """GET /api/security/policy — 返回当前安全配置（不暴露密钥）。

            Task 30：仅返回非敏感字段（tls_enabled / session_timeout /
            login_fail_lock），tls_cert/tls_key/jwt_secret 等敏感值不返回。
            """
            try:
                s = Settings.load()
                tls_enabled = bool(s.tls_cert and s.tls_key)
                session_timeout = s.session_timeout_sec
                login_fail_lock = s.login_fail_lock
            except Exception:
                tls_enabled, session_timeout, login_fail_lock = False, 0, 0
            return self.send_json(
                {
                    "tls_enabled": tls_enabled,
                    "session_timeout_sec": session_timeout,
                    "login_fail_lock": login_fail_lock,
                    "now": now_iso(),
                    # 安全说明：敏感字段（tls_cert/tls_key/jwt_secret/oidc_client_id）
                    # 永不通过此端点返回。
                    "redacted": ["tls_cert", "tls_key", "jwt_secret", "oidc_client_id"],
                }
            )

        # ---- 智能调度 API（Phase 3/5/6）----

        def _sched(self):
            """返回调度服务；未接线时抛 503。"""
            if ctx.scheduler is None:
                raise RuntimeError("调度服务未启用")
            return ctx.scheduler

        def api_resource_state(self):
            """GET /api/resources/state — 统一实时资源状态（Phase 3）。"""
            if ctx.resource_state_service is None:
                return self.send_json({"items": [], "now": now_iso(), "note": "资源状态服务未启用"})
            items = ctx.resource_state_service.build_resource_states(ctx.storage, ctx)
            return self.send_json({"items": items, "now": now_iso()})

        def api_command_map_stream(self):
            """GET /api/command-map/stream — SSE 实时事件流（Phase 5）。"""
            bus = ctx.event_bus
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                self.wfile.write(b"retry: 3000\n\n")
                self.wfile.flush()
            except Exception:
                return
            if bus is None:
                return
            sub = bus.subscribe()
            try:
                while True:
                    try:
                        event = sub.get(timeout=15)
                    except Exception:
                        # 心跳：保持连接存活
                        try:
                            self.wfile.write(b": ping\n\n")
                            self.wfile.flush()
                        except Exception:
                            break
                        continue
                    data = json.dumps(event, ensure_ascii=False)
                    try:
                        self.wfile.write(f"event: {event['event_type']}\ndata: {data}\n\n".encode())
                        self.wfile.flush()
                    except Exception:
                        break
            finally:
                bus.unsubscribe(sub)

        def api_tasks(self):
            """GET /api/tasks — 任务列表（?status= 过滤）。"""
            try:
                sched = self._sched()
                status = self.arg("status") or None
                items = sched.list_tasks(status=status)
                return self.send_json({"items": items, "now": now_iso()})
            except RuntimeError as e:
                return self._new_error("not_ready", str(e), 503)

        def api_task_detail(self, task_id):
            """GET /api/tasks/{id} — 单任务详情。"""
            try:
                sched = self._sched()
                item = sched.get_task(task_id)
                return self.send_json({"task": item, "now": now_iso()})
            except KeyError:
                return self._new_error("not_found", "任务不存在", 404)
            except RuntimeError as e:
                return self._new_error("not_ready", str(e), 503)

        def _task_field(self, payload, key):
            v = payload.get(key)
            if v is None:
                return None
            if key in (
                "required_skills",
                "required_device_capabilities",
                "predecessor_task_ids",
                "exclusive_resource_ids",
            ):
                return list(v) if isinstance(v, list) else []
            if key in ("priority", "estimated_duration_sec"):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return 0
            if key in ("load_level",):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return 0.0
            if key == "safety_critical":
                return bool(v)
            return v

        def api_create_task(self, payload):
            """POST /api/tasks — 创建任务。"""
            try:
                sched = self._sched()
            except RuntimeError as e:
                return self._new_error("not_ready", str(e), 503)
            actor = self._actor()
            fields = {}
            for key in (
                "task_id", "task_type", "priority", "status", "station_id", "zone_id",
                "required_skills", "required_device_capabilities", "release_at", "earliest_start",
                "due_at", "estimated_duration_sec", "predecessor_task_ids", "exclusive_resource_ids",
                "load_level", "safety_critical",
            ):
                v = self._task_field(payload, key)
                if v is not None:
                    fields[key] = v
            task = sched.create_task(actor_id=actor, **fields)
            return self.send_json({"ok": True, "task": task.to_dict()})

        def api_update_task(self, task_id, payload):
            """PATCH /api/tasks/{id} — 乐观锁局部更新任务。"""
            try:
                sched = self._sched()
            except RuntimeError as e:
                return self._new_error("not_ready", str(e), 503)
            actor = self._actor()
            expected_version = payload.get("version")
            reason = payload.get("reason", "")
            fields = {}
            for key in (
                "task_type", "priority", "status", "station_id", "zone_id",
                "required_skills", "required_device_capabilities", "release_at", "earliest_start",
                "due_at", "estimated_duration_sec", "predecessor_task_ids", "exclusive_resource_ids",
                "load_level", "safety_critical",
            ):
                v = self._task_field(payload, key)
                if v is not None:
                    fields[key] = v
            if not fields:
                return self._new_error("invalid_params", "无可更新字段", 400)
            try:
                updated = sched.update_task(
                    task_id, actor_id=actor, expected_version=expected_version, reason=reason, **fields
                )
            except KeyError:
                return self._new_error("not_found", "任务不存在", 404)
            except ValueError as e:
                return self._new_error("invalid_state", str(e), 409)
            except Exception as e:
                if getattr(e, "__class__", None) and e.__class__.__name__ == "VersionConflictError":
                    return self._new_error("VERSION_CONFLICT", str(e), 409)
                return self._new_error("invalid_request", str(e), 400)
            return self.send_json({"ok": True, "task": updated})

        def api_create_scheduling_request(self, payload):
            """POST /api/scheduling/requests — 创建调度请求并生成影子方案（闭环入口）。"""
            try:
                sched = self._sched()
            except RuntimeError as e:
                return self._new_error("not_ready", str(e), 503)
            task_ids = payload.get("task_ids") or []
            trigger_type = payload.get("trigger_type") or "manual"
            policy_id = payload.get("policy_id") or ""
            created_by = payload.get("created_by") or self._actor()
            if not task_ids:
                return self._new_error("invalid_params", "task_ids 不能为空", 400)
            req = sched.create_request(task_ids, trigger_type, policy_id, created_by)
            plans = sched.generate_plans(req.request_id, storage=ctx.storage)
            return self.send_json(
                {
                    "ok": True,
                    "request": req.to_dict(),
                    "plans": [p.to_dict() for p in plans],
                }
            )

        def api_scheduling_request_detail(self, request_id):
            """GET /api/scheduling/requests/{id} — 调度请求详情。"""
            if ctx.scheduler is None:
                return self._new_error("not_ready", "调度服务未启用", 503)
            try:
                req = ctx.scheduler.get_request(request_id)
            except KeyError:
                return self._new_error("not_found", "请求不存在", 404)
            plans = [p.to_dict() for p in ctx.scheduler.list_plans() if p.request_id == request_id]
            return self.send_json({"request": req.to_dict(), "plans": plans})

        def api_scheduling_plans(self):
            """GET /api/scheduling/plans — 方案列表（?status= 过滤）。"""
            if ctx.scheduler is None:
                return self.send_json({"items": [], "now": now_iso()})
            status = self.arg("status") or None
            items = [
                p.to_dict()
                for p in ctx.scheduler.list_plans()
                if not status or p.status == status
            ]
            return self.send_json({"items": items, "now": now_iso()})

        def api_scheduling_plan_detail(self, plan_id):
            """GET /api/scheduling/plans/{id} — 方案详情。"""
            if ctx.scheduler is None:
                return self._new_error("not_ready", "调度服务未启用", 503)
            try:
                plan = ctx.scheduler.get_plan(plan_id)
            except KeyError:
                return self._new_error("not_found", "方案不存在", 404)
            return self.send_json({"plan": plan.to_dict()})

        def _plan_action(self, plan_id, action, payload):
            """POST /api/scheduling/plans/{id}/{action} — 确认/驳回/重排。"""
            if ctx.scheduler is None:
                return self._new_error("not_ready", "调度服务未启用", 503)
            actor = payload.get("actor_id") or self._actor()
            reason = payload.get("reason", "")
            try:
                if action == "confirm":
                    plan = ctx.scheduler.confirm(
                        plan_id,
                        actor,
                        reason,
                        world_state_version=payload.get("world_state_version"),
                    )
                elif action == "reject":
                    plan = ctx.scheduler.reject(plan_id, actor, reason)
                elif action == "replan":
                    plan = ctx.scheduler.replan(
                        plan_id,
                        payload.get("trigger_type") or "manual",
                        actor,
                        reason,
                    )
                else:
                    return self._new_error("not_found", "路径不存在", 404)
            except KeyError:
                return self._new_error("not_found", "方案不存在", 404)
            except Exception as e:
                code = getattr(e, "code", None) or "INVALID_REQUEST"
                return self._new_error(code, str(e), 409)
            return self.send_json({"ok": True, "plan": plan.to_dict()})

        def api_confirm_plan(self, plan_id, payload):
            return self._plan_action(plan_id, "confirm", payload)

        def api_reject_plan(self, plan_id, payload):
            return self._plan_action(plan_id, "reject", payload)

        def api_replan_plan(self, plan_id, payload):
            return self._plan_action(plan_id, "replan", payload)

        def api_assignments(self):
            """GET /api/assignments — 派工列表（?status= 过滤）。"""
            if ctx.scheduler is None:
                return self.send_json({"items": [], "now": now_iso()})
            status = self.arg("status") or None
            items = [a.to_dict() for a in ctx.scheduler.list_assignments(status=status)]
            return self.send_json({"items": items, "now": now_iso()})

        def api_assignment_status(self, assignment_id, new_status, payload):
            """POST /api/assignments/{id}/{start|pause|complete|cancel} — 派工状态转换。"""
            if ctx.scheduler is None:
                return self._new_error("not_ready", "调度服务未启用", 503)
            actor = payload.get("actor_id") or self._actor()
            reason = payload.get("reason", "")
            try:
                a = ctx.scheduler.set_assignment_status(assignment_id, new_status, actor, reason)
            except KeyError:
                return self._new_error("not_found", "派工不存在", 404)
            except ValueError as e:
                return self._new_error("ILLEGAL_STATE", str(e), 409)
            return self.send_json({"ok": True, "assignment": a.to_dict()})

        def api_assignment_override(self, assignment_id, payload):
            """POST /api/assignments/{id}/override — 人工覆盖派工（重排/改派）。"""
            if ctx.scheduler is None:
                return self._new_error("not_ready", "调度服务未启用", 503)
            actor = payload.get("actor_id") or self._actor()
            reason = payload.get("reason", "")
            new_status = payload.get("status") or "executing"
            try:
                a = ctx.scheduler.set_assignment_status(assignment_id, new_status, actor, reason, force=True)
            except KeyError:
                return self._new_error("not_found", "派工不存在", 404)
            except ValueError as e:
                return self._new_error("ILLEGAL_STATE", str(e), 409)
            return self.send_json({"ok": True, "assignment": a.to_dict()})

    return Handler


DEMO_STEPS = [
    {
        "step": 1,
        "name": "断公网展示本地服务",
        "panel": "health",
        "hint": "拔掉外网后系统健康页全部本地服务保持 healthy",
    },
    {"step": 2, "name": "真机上线与人员绑定", "panel": "devices", "hint": "设备管理页出现 REAL DEVICE 标识与绑定人员"},
    {"step": 3, "name": "真人站立/行走/弯腰/搬举", "panel": "realtime", "hint": "实时态势页动作标签随真人动作变化"},
    {
        "step": 4,
        "name": "触发安全可控风险事件",
        "panel": "events",
        "hint": "事件中心出现结构化事件，可查看前后 30 秒证据",
    },
    {"step": 5, "name": "本地查询事件与人员状态", "panel": "assistant", "hint": "本地助手引用真实记录回答白名单问题"},
    {
        "step": 6,
        "name": "输入客户场景生成试点建议",
        "panel": "scenario",
        "hint": "场景评估器输出一页纸与捷顺下一步请求",
    },
]


def build_server(addr, ctx, tls_cert=None, tls_key=None):
    """构建 HTTP(S) 服务。

    Task 30：若 ``tls_cert`` 与 ``tls_key`` 均提供（或从 Settings 读取到非空值），
    用 ``ssl.wrap_socket`` 包装为 HTTPS；否则保持 HTTP。
    安全响应头中间件 ``SecurityHeaders`` 在此统一注入到 handler 类。
    """
    handler_cls = make_handler(ctx)
    SecurityHeaders.wrap(handler_cls)
    httpd = ThreadingHTTPServer(addr, handler_cls)
    # 优先使用显式参数，其次读取 Settings
    if tls_cert is None or tls_key is None:
        try:
            s = Settings.load()
            tls_cert = tls_cert or s.tls_cert or None
            tls_key = tls_key or s.tls_key or None
        except Exception:
            pass
    if tls_cert and tls_key:
        # ssl.wrap_socket 在 3.12 起 deprecated 但仍可用；保留以匹配 Task 30 口径。
        httpd.socket = ssl.wrap_socket(httpd.socket, certfile=tls_cert, keyfile=tls_key, server_side=True)
    return httpd
