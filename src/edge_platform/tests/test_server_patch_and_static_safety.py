"""P0 回归测试：静态目录穿越防护 + PATCH 写路径 production 门禁与审计。

背景（系统性走读发现）：
- P0-1：Handler.translate_path 覆盖了父类实现却未做 `..` 清洗，
  GET /../../../demo.db 可匿名读取仓库任意文件（含全量数据库）。
- P0-2：do_PATCH（/api/tasks/{id} 乐观锁更新）缺 production 认证门禁与
  自动审计，与 do_POST 不对称（POST 有 PUBLIC_POST_PATHS 白名单 + 审计）。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_server_patch_and_static_safety -v
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
from edge_platform.scheduler.events import EventBus  # noqa: E402
from edge_platform.scheduler.repository import SchedulingRepository  # noqa: E402


class _Fixture:
    """真实 HTTP server（随机端口）+ 真实 SQLite Storage + 真实调度闭环装配。"""

    def __init__(self, runtime_mode="development", repo_readonly=False):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_patch_safety_")
        self._old_env = dict(os.environ)
        os.environ["EWOH_RUNTIME_MODE"] = runtime_mode
        Settings.reset()
        self.storage = Storage(Path(self.tmp) / "patch.db")
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage, readonly=repo_readonly)
        self.event_bus = EventBus()
        self.scheduler, self.resource_state = run.build_scheduler(
            self.storage, self.repo, self.event_bus, mode=runtime_mode
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

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def patch(self, path, payload):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PATCH",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()


class StaticPathTraversalTest(unittest.TestCase):
    """P0-1：静态目录只服务 STATIC_DIR 内文件，拒绝任何 `..` 穿越。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = _Fixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_parent_traversal_rejected(self):
        status, _, _ = self.fx.get("/../config.py")
        self.assertEqual(status, 404)

    def test_deep_traversal_to_repo_root_rejected(self):
        for path in (
            "/../../../demo.db",
            "/../../../README.md",
            "/../../../../etc/passwd",
            "/..%2f..%2f..%2fdemo.db",
        ):
            status, _, body = self.fx.get(path)
            self.assertEqual(status, 404, f"{path} 不应可读: {body[:120]!r}")

    def test_api_routes_still_served(self):
        status, headers, body = self.fx.get("/api/status")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertIn("now", json.loads(body))


class PatchWriteGateTest(unittest.TestCase):
    """P0-2：do_PATCH 与 do_POST 对齐——production 认证 fail-closed + 自动审计。"""

    def _seed_task(self, fixture, task_id="TSK-PATCH-001"):
        fixture.storage.upsert_task(
            task_id,
            task_type="搬运",
            priority=5,
            status="draft",
            station_id="S1",
        )
        return task_id

    def test_production_patch_without_token_401(self):
        fx = _Fixture(runtime_mode="production")
        try:
            task_id = self._seed_task(fx)
            status, _, body = fx.patch("/api/tasks/" + task_id, {"priority": 9})
            self.assertEqual(status, 401, f"production 无 token 的 PATCH 应 401: {body[:200]!r}")
            payload = json.loads(body)
            self.assertEqual(payload["error"]["code"], "unauthorized")
        finally:
            fx.close()

    def test_development_patch_succeeds_and_is_audited(self):
        fx = _Fixture(runtime_mode="development")
        try:
            task_id = self._seed_task(fx)
            status, _, body = fx.patch("/api/tasks/" + task_id, {"priority": 9})
            self.assertEqual(status, 200, f"development PATCH 应成功: {body[:200]!r}")
            payload = json.loads(body)
            self.assertEqual(payload["task"]["priority"], 9)
            audits = fx.storage.list_audit_logs(action="PATCH /api/tasks/" + task_id)
            self.assertTrue(audits, "成功的 PATCH 必须写入审计日志（action=PATCH …）")
            self.assertEqual(audits[0]["target_id"], task_id)
        finally:
            fx.close()

    def test_patch_on_non_task_path_still_404(self):
        fx = _Fixture()
        try:
            status, _, body = fx.patch("/api/other/thing", {"priority": 9})
            self.assertEqual(status, 404, f"非任务路径 PATCH 应 404: {body[:200]!r}")
        finally:
            fx.close()


class SchedulerReadonlyGateTest(unittest.TestCase):
    """P1-01 回归：readonly/advisory 模式下任务写接口返回 403 SCHEDULING_READ_ONLY（而非 500/400）。"""

    def test_post_tasks_readonly_403(self):
        fx = _Fixture(runtime_mode="development", repo_readonly=True)
        try:
            req = urllib.request.Request(
                fx.base + "/api/tasks",
                data=json.dumps({"task_type": "搬运", "priority": 5}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(req, timeout=5)
                self.fail("readonly 仓储下创建任务应被拒绝")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 403, "readonly 写被拒应返回 403 而非 500")
                payload = json.loads(e.read())
                self.assertEqual(payload["error"]["code"], "SCHEDULING_READ_ONLY")
        finally:
            fx.close()

    def test_patch_tasks_readonly_403(self):
        fx = _Fixture(runtime_mode="development", repo_readonly=True)
        try:
            task_id = "TSK-RO-001"
            # 直接经 storage 预置任务（绕过仓储），使请求走到 readonly 写守卫而非 404。
            fx.storage.upsert_task(task_id, task_type="搬运", priority=5, status="draft")
            status, _, body = fx.patch("/api/tasks/" + task_id, {"priority": 9})
            self.assertEqual(status, 403, f"readonly PATCH 应 403: {body[:200]!r}")
            payload = json.loads(body)
            self.assertEqual(payload["error"]["code"], "SCHEDULING_READ_ONLY")
        finally:
            fx.close()


class ActorIdentityResolutionTest(unittest.TestCase):
    """P1 安全修复：审计身份以服务端 token 为准，客户端自报仅未认证时降级。"""

    def _seed_event(self, fx, event_id="EVT-ACTOR-001"):
        from datetime import datetime, timedelta

        fx.storage.insert_event(
            {
                "event_id": event_id,
                "event_code": "LOAD_CONTINUOUS",
                "severity": "L2",
                "status": "open",
                "person_id": "P-001",
                "device_id": "EXO-001",
                "start_time": (datetime.now() + timedelta(seconds=-30)).astimezone().isoformat(timespec="milliseconds"),
                "trigger": {"type": "rule"},
                "evidence": {"window_before_sec": 30, "window_after_sec": 30},
                "source_type": "simulated",
            }
        )
        return event_id

    def _login(self, fx, username="admin", password="admin123"):
        req = urllib.request.Request(
            fx.base + "/api/auth/login",
            data=json.dumps({"username": username, "password": password}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            payload = json.loads(r.read())
        return payload["token"]

    def _post(self, fx, path, payload, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            fx.base + path, data=json.dumps(payload).encode("utf-8"), headers=headers
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    def test_token_identity_overrides_client_supplied_author(self):
        fx = _Fixture()
        try:
            event_id = self._seed_event(fx)
            token = self._login(fx)
            self._post(
                fx,
                f"/api/events/{event_id}/comment",
                {"comment": "冒充他人评论", "author_id": "attacker"},
                token=token,
            )
            handlings = fx.storage.list_event_handlings(event_id)
            self.assertTrue(handlings)
            self.assertEqual(
                handlings[-1]["handler_id"], "U-ADMIN",
                "携带有效 token 时必须以 token 身份为准，客户端自报 author_id 不得生效",
            )
        finally:
            fx.close()

    def test_anonymous_dev_fallback_keeps_client_field(self):
        fx = _Fixture()
        try:
            event_id = self._seed_event(fx, "EVT-ACTOR-002")
            self._post(
                fx,
                f"/api/events/{event_id}/comment",
                {"comment": "离线演示评论", "author_id": "offline-user"},
            )
            handlings = fx.storage.list_event_handlings(event_id)
            self.assertTrue(handlings)
            self.assertEqual(
                handlings[-1]["handler_id"], "offline-user",
                "development 未认证时保留客户端自报（离线演示便利，非审计权威）",
            )
        finally:
            fx.close()


class VisionSsidfGuardTest(unittest.TestCase):
    """P1 安全修复：视觉理解出站地址 SSRF 防护（base_url/image_url 仅公网）。"""

    def test_validate_outbound_url_rejects_internal_hosts(self):
        from edge_platform.perception.ark_vision import validate_outbound_url

        for url in (
            "http://169.254.169.254/latest/meta-data",
            "http://127.0.0.1:8000/api",
            "http://localhost:8000",
            "http://[::1]:8000",
            "http://10.0.0.8/internal",
            "http://192.168.1.100/",
            "file:///etc/passwd",
        ):
            ok, reason = validate_outbound_url(url)
            self.assertFalse(ok, f"{url} 应被拒绝，reason={reason}")

    def test_validate_outbound_url_allows_public_hosts(self):
        from edge_platform.perception.ark_vision import validate_outbound_url

        for url in (
            "https://ark.cn-beijing.volces.com/api/v3",
            "https://example.com/img.png",
        ):
            ok, reason = validate_outbound_url(url)
            self.assertTrue(ok, f"{url} 应被允许，reason={reason}")

    def test_vision_endpoint_rejects_internal_base_url_override(self):
        fx = _Fixture()
        try:
            req = urllib.request.Request(
                fx.base + "/api/vision/understand",
                data=json.dumps(
                    {
                        "image_url": "https://example.com/a.png",
                        "question": "x",
                        "api_key": "dummy-key",
                        "base_url": "http://169.254.169.254",
                    }
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(req, timeout=5)
                self.fail("内网 base_url 应被拒绝")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 502)
                body = json.loads(e.read())
                self.assertIn("base_url 不安全", body.get("error", ""))
        finally:
            fx.close()


class SseAuthGateTest(unittest.TestCase):
    """P1 安全修复：production 下 SSE 事件流要求 Bearer 认证（fail-closed）。"""

    def test_production_stream_without_token_401(self):
        fx = _Fixture(runtime_mode="production")
        try:
            status, _, body = fx.get("/api/command-map/stream")
            self.assertEqual(status, 401, f"production 匿名订阅应 401: {body[:160]!r}")
            payload = json.loads(body)
            self.assertEqual(payload["error"]["code"], "unauthorized")
        finally:
            fx.close()

    def test_development_stream_still_open(self):
        fx = _Fixture(runtime_mode="development")
        try:
            req = urllib.request.Request(fx.base + "/api/command-map/stream")
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.status, 200)
                ctype = r.headers.get("Content-Type", "")
                self.assertIn("text/event-stream", ctype)
                first_line = r.readline().decode("utf-8", "replace")  # 首个 retry 指令即证明流可达
                self.assertTrue(first_line)
        finally:
            fx.close()


if __name__ == "__main__":
    unittest.main()
