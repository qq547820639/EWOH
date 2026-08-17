#!/usr/bin/env python3
"""EWOH 平台服务层（纯标准库 HTTP 服务）。

覆盖任务：
- Task 4  平台数据源切换：全部数据接口读持久层 Storage，支持 real/controlled_test/simulated 过滤与来源标识
- Task 5  历史回放与原始数据导出（按设备+时间段，回放态/实时态区分）
- Task 15 九页 API 支撑：来源/更新时间/质量/版本/异常/证据入口
- Task 19 演示闭环：一键重置与六步演示指引
- Task 9  服务模块化（P2）：路由按 domain 抽取到 edge_platform/routes/ 包，
          Handler 只保留横切中间件（请求 ID / CORS / body 上限 / 审计 / 统一错误信封）
          与路由分发，HTTP/SSE 契约保持字节级兼容。

安全边界：本服务不提供任何写入急停、限扭、关节实时控制等安全闭环参数的接口。
"""

import csv
import io
import json
import ssl
import threading
import time
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import services
from .config import Settings
from .rbac.permissions import action_for_request, is_allowed
from .routes import NOT_HANDLED, ReqMeta
from .routes._util import offline_after_sec
from .routes.registry import dispatch
from .security import SecurityHeaders, rate_limiter

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

# Task 16.6 横切关注点：请求体上限与默认分页
MAX_BODY_BYTES = 1 * 1024 * 1024  # POST body 限制 1MB
DEFAULT_LIMIT = 100  # 列表端点默认分页大小

# P0-Edge-Security：production 下 POST 写操作必须认证；以下为认证类公共端点白名单
PUBLIC_POST_PATHS = frozenset(
    {
        "/api/auth/login",
        "/api/auth/refresh",
    }
)


def _log_internal_error(method, path, request_id, exc):
    """内部异常日志（P0-Edge-Security）：详情只进日志，外部响应保持脱敏。"""
    import traceback

    print(
        f"[EWOH] internal_error method={method} path={path} request_id={request_id} "
        f"exc_type={exc.__class__.__name__} exc={exc!r}\n{traceback.format_exc()}"
    )


parse_ts = services.parse_ts


def get_actor_from_request(handler):
    """从 Authorization header 解析 Bearer token 得到操作人身份。

    返回：
    - 有效会话 → user_id
    - 未认证：
      - production：返回 None（调用方必须 fail-closed，禁止 anonymous 降级）；
      - development/simulation：返回 "anonymous"（离线/演示场景可用）。

    P0-Edge-Security：生产环境不允许 anonymous fallback。
    """
    auth = (handler.headers.get("Authorization", "") or "").strip()
    if not auth.startswith("Bearer "):
        return _anonymous_or_none()
    token = auth[len("Bearer ") :].strip()
    if not token:
        return _anonymous_or_none()
    sm = _get_session_manager()
    if sm is None:
        return _anonymous_or_none()
    try:
        session = sm.verify(token)
        if session is not None:
            return session.user_id
    except Exception as e:  # L3：认证异常按匿名处理（安全降级），但记录日志便于诊断
        print(f"[EWOH] session verify failed (fallback anonymous): {e!r}")
    return _anonymous_or_none()


def _anonymous_or_none():
    """production 未认证返回 None（fail-closed）；development/simulation 返回 anonymous。"""
    if Settings.load().runtime_mode == "production":
        return None
    return "anonymous"


def _verify_bearer_session(handler, sm):
    """从 Authorization header 校验 Bearer token，返回 Session 或 None（不抛异常）。"""
    auth = (handler.headers.get("Authorization", "") or "").strip()
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer ") :].strip()
    if not token:
        return None
    try:
        return sm.verify(token)
    except Exception as e:  # L3：认证异常按未认证处理（fail-closed），记录日志
        print(f"[EWOH] session verify failed (rbac): {e!r}")
        return None


def rbac_allowed(handler, action):
    """production 下按会话角色执行 RBAC 动作校验（fail-closed，P1 落地）。

    - 非 production → True（离线演示便利，审计仍记录 anonymous/自报身份）；
    - production 无会话/会话无效/未知角色 → False（禁止）；
    - 会话角色命中矩阵 → 按矩阵判定。
    """
    if Settings.load().runtime_mode != "production":
        return True
    sm = _get_session_manager()
    if sm is None:
        return False
    session = _verify_bearer_session(handler, sm)
    if session is None:
        return False
    return bool(is_allowed(session.role, action))


def _rbac_forbidden(handler):
    """统一 RBAC 拒绝响应（403 forbidden，不泄露矩阵细节）。"""
    return handler.send_json(
        {
            "error": {
                "code": "forbidden",
                "message": "当前角色无权执行该操作",
                "request_id": getattr(handler, "_request_id", ""),
            }
        },
        403,
    )


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
        world_store=None,
        world_projection=None,
        event_uplink=None,
        metrics_uplink=None,
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
        # NO-03b：契约校验的世界状态存储（ADR-008/ADR-015 运行时接线；缺省 None，
        # 路由 fail-closed 返回 503，绝不静默降级）
        self.world_store = world_store
        # NO-03c：遥测→世界模型自动投影（缺省 None；/api/status 如实报 enabled=false）
        self.world_projection = world_projection
        # NO-04b：Edge→Cloud 事件上行（缺省 None；/api/status 如实报 enabled=false）
        self.event_uplink = event_uplink
        self.metrics_uplink = metrics_uplink
        self.started_at = time.time()
        self.assignments = []  # 人工确认派工记录（演示会话级，不自动派工）
        self.lock = threading.Lock()

    def device_online(self, d):
        """掉线判定：online 标志 + last_seen 新鲜度双重判断。"""
        last = parse_ts(d.get("last_seen"))
        fresh = bool(last) and (datetime.now().astimezone() - last).total_seconds() <= offline_after_sec()
        return bool(d.get("online")) and fresh


def make_handler(ctx):
    class Handler(SimpleHTTPRequestHandler):
        # Task 16 演示用 token 存储（auth 模块未就绪时使用）；auth 就绪后由其管理
        _tokens = {}  # type: ignore[var-annotated]
        _tokens_lock = threading.Lock()
        # L2 修复：演示 token 有效期（auth 模块未就绪的降级路径），24h 过期 + 登录时惰性清理，
        # 消除"token 永不过期 + 内存缓慢增长"。
        _TOKEN_TTL = 24 * 3600

        @classmethod
        def _demo_token_cleanup(cls, force=False):
            """清理过期演示 token（force=True 全量扫描；否则每次登录顺带清理 1 次）。"""
            now = time.time()
            with cls._tokens_lock:
                expired = [k for k, v in cls._tokens.items() if v.get("exp", 0) <= now]
                for k in expired:
                    del cls._tokens[k]
            if expired:
                print(f"[EWOH] demo token cleanup removed {len(expired)} expired")

        def translate_path(self, path):
            parsed = urlparse(path).path
            if parsed.startswith("/api/"):
                return str(STATIC_DIR / "index.html")
            if parsed == "/":
                parsed = "/index.html"
            # P0-安全：静态目录只服务 STATIC_DIR 之内的相对文件。
            # 镜像标准库语义：丢弃 `.`/`..` 段（绝不越出 STATIC_DIR），
            # 阻断 GET /../../../demo.db 读取仓库任意文件（含全量数据库）。
            # 本类覆盖了父类 translate_path 的路径清洗，因此必须在此显式处理。
            segments = [
                seg for seg in parsed.split("/")
                if seg and seg not in (".", "..")
            ]
            return str(STATIC_DIR / "/".join(segments))

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
            # CORS（P0-Edge-Security）：production 必须使用显式 allowlist，
            # 未命中 allowlist 的 Origin 一律不回送 CORS 头（fail-closed）。
            # development/simulation 保留 echo 便于本地跨端口联调，但打印警告。
            origin = self.headers.get("Origin") if self.headers else None
            if origin:
                mode = Settings.load().runtime_mode
                allowlist = Settings.load().cors_origins
                if mode == "production":
                    if allowlist and origin in allowlist:
                        self.send_header("Access-Control-Allow-Origin", origin)
                        self.send_header("Access-Control-Allow-Credentials", "true")
                        self.send_header("Vary", "Origin")
                    # 未命中：不发送任何 CORS 头，浏览器同源策略阻止跨域读写
                else:
                    print(
                        "[EWOH] CORS 开发回退：echo Origin（仅限 development/simulation，"
                        "production 必须配置 EWOH_CORS_ORIGINS allowlist）"
                    )
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Access-Control-Allow-Credentials", "true")
                    self.send_header("Vary", "Origin")

        # ---- 基础工具 ----
        def _flush_post_audit(self):
            """在发送响应前刷新待审计的写操作日志，避免客户端先收到响应的竞态。"""
            if getattr(self, "_post_audit_pending", False):
                self._post_audit_pending = False
                method = getattr(self, "_audit_method", "POST")
                self._audit(
                    f"{method} " + urlparse(self.path).path,
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
                except Exception as e:  # L3：排空失败（连接可能已断），记录后继续抛 413
                    print(f"[EWOH] drain oversized body failed: {e!r}")
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
            except Exception as e:  # L3：审计失败不阻断业务，但记录便于诊断
                print(f"[EWOH] audit append failed (non-blocking): {e!r}")

        # ---- Task 9（P2）：路由分发 ----
        def _dispatch(self, method, payload=None):
            """构造 ReqMeta 并派发到 routes.registry（路由实现见 edge_platform/routes/）。"""
            p = urlparse(self.path).path
            req_meta = ReqMeta(
                method=method,
                path=p,
                path_parts=tuple(seg for seg in p.split("/") if seg),
                query=self.qs(),
                body=payload,
                headers=self.headers,
                client=getattr(self, "client_address", None),
            )
            return dispatch(ctx, self, method, req_meta)

        # ---- GET 路由（横切中间件 + 按域派发；未命中回退静态文件，与原行为一致） ----
        def _production_read_guard(self, p):
            """EDGE-001（2026-08-17 审计整改）：production 下全部 /api/* 与 /metrics
            GET 要求有效 Bearer token 并映射 VIEW_* 动作；未映射路径默认拒绝
            （fail-closed 401）。返回错误响应或 None（放行）。
            """
            if not (p.startswith("/api/") or p == "/metrics"):
                return None  # 静态资源/SPA 不经此守卫
            action = action_for_request("GET", p)
            if action is None:
                return self._new_error(
                    "unauthorized", "production 下未映射的 API 读路径默认拒绝", 401
                )
            sm = _get_session_manager()
            if sm is None:
                return self._new_error("auth_unavailable", "认证服务未就绪，拒绝读请求", 503)
            session = _verify_bearer_session(self, sm)
            if session is None:
                return self._new_error(
                    "unauthorized", "production 读操作必须携带有效 Bearer token", 401
                )
            if not is_allowed(session.role, action):
                return _rbac_forbidden(self)
            return None

        def do_GET(self):
            self._request_id = None  # keep-alive 复用实例时重置请求 ID
            self._post_audit_pending = False
            p = urlparse(self.path).path
            # EDGE-001：production 下 GET 面强制认证 + RBAC（未映射默认拒绝）；
            # development/simulation 保持宽松（离线演示直连，不破坏既有测试）。
            if Settings.load().runtime_mode == "production":
                guard = self._production_read_guard(p)
                if guard is not None:
                    return guard
            try:
                if self._dispatch("GET") is not NOT_HANDLED:
                    return
            except BrokenPipeError:
                return
            except Exception as e:  # 统一错误出口：内部日志记录详情，外部响应脱敏（P0-Edge-Security）
                _log_internal_error("GET", p, self._request_id, e)
                return self.send_json(
                    {"error": {"code": "internal_error", "message": "请求处理失败", "request_id": self._request_id}},
                    500,
                )
            # EDGE-025：未命中的 /api/*（与 /metrics）GET 返回 404 JSON，
            # 不再回退 SPA index.html（与 POST 未命中 404 JSON 口径一致）。
            if p.startswith("/api/") or p == "/metrics":
                return self.send_json({"error": "not found"}, 404)
            return super().do_GET()

        # ---- POST 路由（横切中间件 + 按域派发；未命中回退 {"error":"not found"} 404） ----
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
            self._audit_method = "POST"
            self._audit_target_type = "api"
            self._audit_target_id = None
            # P0-Edge-Security：production 下所有写操作（POST/PATCH）必须认证，
            # 公共端点白名单豁免。未认证 → 401（fail-closed，禁止 anonymous 写）。
            if Settings.load().runtime_mode == "production":
                actor = self._actor()
                if actor is None and p not in PUBLIC_POST_PATHS:
                    self._post_audit_pending = False
                    return self._new_error("unauthorized", "production 写操作必须携带有效 Bearer token", 401)
                # P1 RBAC 落地：认证通过后按角色校验写动作（如 operator 无 manage_assignments）。
                action = action_for_request("POST", p)
                if action and not rbac_allowed(self, action):
                    self._post_audit_pending = False
                    return _rbac_forbidden(self)
            try:
                if self._dispatch("POST", payload) is not NOT_HANDLED:
                    return
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
                _log_internal_error("POST", p, self._request_id, e)
                return self.send_json(
                    {"error": {"code": "internal_error", "message": "请求处理失败", "request_id": self._request_id}},
                    500,
                )

        def do_HEAD(self):
            self._request_id = None  # keep-alive 复用实例时重置请求 ID
            return super().do_HEAD()

        def do_PATCH(self):
            """PATCH /api/tasks/{id} — 乐观锁局部更新任务（status/priority 等）。"""
            self._request_id = None
            self._post_audit_pending = False
            # 提前生成 request_id，确保审计日志能关联到本次请求（与 do_POST 对齐）
            inbound = self.headers.get("X-Request-ID") if self.headers else None
            self._request_id = inbound or uuid.uuid4().hex[:8]
            p = urlparse(self.path).path
            try:
                payload = self.read_json()
            except ValueError as e:
                return self._new_error("body_too_large", str(e), 400)
            # 路径校验与原 do_PATCH 语义一致（/api/tasks/{id}，多余段忽略）：
            # 非 /api/tasks/ 前缀或尾部斜杠 → 404 {"error":"not found"}；
            # task_id 为空 → 404 {"error":"not found"}；其余交由路由域处理。
            if not p.startswith("/api/tasks/") or p == "/api/tasks/":
                return self.send_json({"error": "not found"}, 404)
            task_id = p[len("/api/tasks/") :].split("/")[0]
            if not task_id:
                return self.send_json({"error": "not found"}, 404)
            # P0-安全：production 下写操作必须认证（与 do_POST 对齐，fail-closed），
            # 公共端点白名单豁免；未认证 → 401，禁止 anonymous 写。
            if Settings.load().runtime_mode == "production":
                actor = self._actor()
                if actor is None and p not in PUBLIC_POST_PATHS:
                    return self._new_error("unauthorized", "production 写操作必须携带有效 Bearer token", 401)
                # P1 RBAC 落地：认证通过后按角色校验写动作（manage_assignments）。
                action = action_for_request("PATCH", p)
                if action and not rbac_allowed(self, action):
                    return _rbac_forbidden(self)
            # 写操作自动审计（与 do_POST 对齐）：send_json 响应前落库防竞态。
            self._post_audit_pending = True
            self._audit_method = "PATCH"
            self._audit_target_type = "task"
            self._audit_target_id = task_id
            try:
                outcome = self._dispatch("PATCH", payload)
                if outcome is not NOT_HANDLED:
                    return outcome
                self._post_audit_pending = False  # 404 不审计
                return self.send_json({"error": "not found"}, 404)
            except BrokenPipeError:
                self._post_audit_pending = False
                return
            except Exception as e:
                self._post_audit_pending = False
                self._audit(
                    "PATCH " + p,
                    target_type=getattr(self, "_audit_target_type", "api"),
                    target_id=getattr(self, "_audit_target_id", None),
                    result="error",
                )
                _log_internal_error("PATCH", p, self._request_id, e)
                return self.send_json(
                    {"error": {"code": "internal_error", "message": "请求处理失败", "request_id": self._request_id}},
                    500,
                )

        def do_OPTIONS(self):
            """CORS 预检：允许指挥地图前端跨端口调用 API（本地边缘部署）。"""
            self._request_id = None
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

    return Handler


def build_server(addr, ctx, tls_cert=None, tls_key=None):
    """构建 HTTP(S) 服务。

    Task 30：若 ``tls_cert`` 与 ``tls_key`` 均提供（或从 Settings 读取到非空值），
    用 TLS 包装为 HTTPS；否则保持 HTTP。
    EDGE-009（2026-08-17 审计整改）：``ssl.wrap_socket``（3.10 起 deprecated）改为
    ``SSLContext(PROTOCOL_TLS_SERVER)`` 并强制 ``minimum_version=TLSv1_2``，
    消除 TLS 1.0/1.1 弱协议协商面。
    安全响应头中间件 ``SecurityHeaders`` 在此统一注入到 handler 类。
    """
    handler_cls = make_handler(ctx)
    SecurityHeaders.wrap(handler_cls)
    # P0-Edge-Security：production 下接入速率限制（默认 60 req/min/IP，进程内内存）。
    # 仅 production 启用，避免开发/仿真/自检路径被限流误伤。
    if Settings.load().runtime_mode == "production":
        handler_cls = rate_limiter()(handler_cls)
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
        tls_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        tls_ctx.load_cert_chain(certfile=tls_cert, keyfile=tls_key)
        httpd.socket = tls_ctx.wrap_socket(httpd.socket, server_side=True)
    return httpd
