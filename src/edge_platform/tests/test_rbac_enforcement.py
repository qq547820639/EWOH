"""P1 RBAC 落地回归测试：production 下按角色执行权限矩阵（is_allowed 横切接线）。

背景（走读 R-1）：`is_allowed` 矩阵此前零路由调用——除导出端点外，任意已登录用户
可处置事件/建任务/读审计。修复后 production 模式在认证门禁之后按
`action_for_request(method, path)` 映射动作并执行矩阵校验（fail-closed）。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_rbac_enforcement -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import run, server  # noqa: E402
from edge_platform.config import Settings  # noqa: E402
from edge_platform.edge.storage import Storage  # noqa: E402
from edge_platform.rbac.permissions import action_for_request  # noqa: E402
from edge_platform.scheduler.events import EventBus  # noqa: E402
from edge_platform.scheduler.repository import SchedulingRepository  # noqa: E402


class ActionMappingTest(unittest.TestCase):
    """action_for_request 纯函数映射（无需服务器）。

    EDGE-001 整改（2026-08-17）后：全部 GET /api/* 与 /metrics 均映射 VIEW_*
    动作（未映射路径由 server 层 fail-closed 拒绝）。
    """

    def test_read_restricted_paths(self):
        self.assertEqual(action_for_request("GET", "/api/audit"), "view_audit")
        self.assertEqual(action_for_request("GET", "/api/telemetry/export"), "export_data")
        self.assertEqual(action_for_request("GET", "/api/telemetry"), "view_telemetry")
        self.assertEqual(action_for_request("GET", "/api/people"), "view_personnel")
        self.assertEqual(action_for_request("GET", "/api/person/profile"), "view_personnel")
        self.assertEqual(action_for_request("GET", "/api/status"), "view_telemetry")
        self.assertEqual(action_for_request("GET", "/metrics"), "view_telemetry")
        self.assertEqual(action_for_request("GET", "/api/tasks/T1"), "view_events")

    def test_write_paths(self):
        self.assertEqual(action_for_request("POST", "/api/tasks"), "manage_assignments")
        self.assertEqual(action_for_request("PATCH", "/api/tasks/T1"), "manage_assignments")
        self.assertEqual(action_for_request("POST", "/api/scheduling/requests"), "manage_assignments")
        self.assertEqual(action_for_request("POST", "/api/assignments/A1/start"), "manage_assignments")
        self.assertEqual(action_for_request("POST", "/api/events/E1/status"), "handle_events")
        self.assertEqual(action_for_request("POST", "/api/events/E1/comment"), "handle_events")
        self.assertEqual(action_for_request("POST", "/api/event/status"), "handle_events")  # EDGE-008
        self.assertEqual(action_for_request("POST", "/api/models/register"), "manage_models")
        self.assertEqual(action_for_request("POST", "/api/rules/register"), "manage_rules")
        self.assertEqual(action_for_request("POST", "/api/reset"), "manage_data")  # EDGE-012
        self.assertEqual(action_for_request("POST", "/api/query"), "query_assistant")  # EDGE-048
        self.assertEqual(action_for_request("POST", "/api/andon/raise"), "raise_andon")  # EDGE-039
        self.assertEqual(action_for_request("POST", "/api/world/states"), "manage_world")  # EDGE-038

    def test_public_and_unmapped(self):
        self.assertEqual(action_for_request("POST", "/api/auth/login"), None)
        self.assertEqual(action_for_request("POST", "/api/auth/refresh"), None)
        # GET 面未映射 /api/* 路径返回 None（server.do_GET 对其 fail-closed 401）
        self.assertEqual(action_for_request("GET", "/api/no-such-route"), None)


class _Fixture:
    """production 模式 + 可写调度仓储 + 真实闭环装配（RBAC 只拦角色，不拦业务）。"""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_rbac_")
        self._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = "production"
        Settings.reset()
        self.storage = Storage(Path(self.tmp) / "rbac.db")
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage, readonly=False)
        self.event_bus = EventBus()
        self.scheduler, self.resource_state = run.build_scheduler(
            self.storage, self.repo, self.event_bus, mode="production"
        )
        self.ctx = server.Context(
            self.storage,
            scheduling_repository=self.repo,
            event_bus=self.event_bus,
            scheduler=self.scheduler,
            resource_state_service=self.resource_state,
        )
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        Settings.reset()
        os.environ.clear()
        os.environ.update(self._old_env)

    def login(self, username, password):
        req = urllib.request.Request(
            self.base + "/api/auth/login",
            data=json.dumps({"username": username, "password": password}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())["token"]

    def req(self, method, path, body=None, token=None):
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


class RbacEnforcementTest(unittest.TestCase):
    """production 下按角色执行矩阵（operator 无 manage_assignments；admin 全权）。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _Fixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_operator_create_task_forbidden(self):
        token = self.fx.login("operator", "operator123")
        status, body = self.fx.req("POST", "/api/tasks", {"task_type": "搬运", "priority": 5}, token=token)
        self.assertEqual(status, 403, f"operator 无 manage_assignments 应 403: {body}")
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_admin_create_task_allowed(self):
        token = self.fx.login("admin", "admin123")
        status, body = self.fx.req("POST", "/api/tasks", {"task_type": "搬运", "priority": 5}, token=token)
        self.assertEqual(status, 200, f"admin 应有 manage_assignments: {body}")
        self.assertTrue(body.get("ok"))

    def test_operator_view_audit_allowed(self):
        token = self.fx.login("operator", "operator123")
        status, _ = self.fx.req("GET", "/api/audit", token=token)
        self.assertEqual(status, 200, "operator 有 view_audit")

    def test_anonymous_audit_read_401(self):
        # EDT-005（原 EDGE-001 面收敛）：production 匿名访问受限读路径钉死 401
        #（无会话 → unauthorized，非角色 403）
        status, body = self.fx.req("GET", "/api/audit")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_anonymous_get_api_denied_401(self):
        # EDGE-001：production 下匿名 GET 业务数据面 → 401（不再匿名放行）
        for path in ("/api/tasks", "/api/people", "/api/telemetry", "/api/status",
                     "/api/scheduling/plans", "/metrics"):
            status, body = self.fx.req("GET", path)
            self.assertEqual(status, 401, f"{path} 匿名读应 401: {body}")
            self.assertEqual(body["error"]["code"], "unauthorized")

    def test_unmapped_get_path_default_denied_401(self):
        # EDGE-001：未映射的 /api/* GET 默认拒绝（fail-closed）
        status, body = self.fx.req("GET", "/api/no-such-thing")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_authenticated_get_allowed_with_view_action(self):
        # EDGE-001：认证后按 VIEW_* 动作放行（operator 有 view_telemetry/view_events）
        token = self.fx.login("operator", "operator123")
        for path in ("/api/tasks", "/api/telemetry", "/api/status"):
            status, body = self.fx.req("GET", path, token=token)
            self.assertNotEqual(status, 401, f"{path} 认证读不应 401: {body}")
            self.assertNotEqual(status, 403, f"{path} 认证读不应 403: {body}")

    def test_viewer_cannot_read_personnel_pii(self):
        # EDGE-014：/api/people 映射 view_personnel（viewer 无权 → 403）。
        # viewer 不在离线种子账号内——经服务端 SessionManager 单例直接铸造会话。
        sm = server._get_session_manager()
        self.assertIsNotNone(sm)
        user = type("ViewerUser", (), {"user_id": "U-VIEWER", "role": "viewer", "display_name": "viewer"})()
        token = sm.create(user)
        status, body = self.fx.req("GET", "/api/people", token=token)
        self.assertEqual(status, 403, f"viewer 读人员 PII 应 403: {body}")
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_operator_patch_task_forbidden(self):
        token = self.fx.login("operator", "operator123")
        self.fx.storage.upsert_task("TSK-RBAC-1", task_type="搬运", priority=5, status="draft")
        status, body = self.fx.req("PATCH", "/api/tasks/TSK-RBAC-1", {"priority": 9}, token=token)
        self.assertEqual(status, 403, f"operator PATCH 应 403: {body}")
        self.assertEqual(body["error"]["code"], "forbidden")

    def test_safety_officer_handle_event_allowed(self):
        token = self.fx.login("safety_officer", "safety123")
        # 事件不存在会 404，但绝不能是 RBAC forbidden——证明 handle_events 放行到领域逻辑。
        status, body = self.fx.req(
            "POST", "/api/events/EVT-NOT-EXIST/status", {"status": "handled"}, token=token
        )
        self.assertNotEqual(status, 403, f"safety_officer 应有权处置事件: {body}")
        self.assertNotEqual(body.get("error", {}).get("code"), "forbidden")


if __name__ == "__main__":
    unittest.main()
