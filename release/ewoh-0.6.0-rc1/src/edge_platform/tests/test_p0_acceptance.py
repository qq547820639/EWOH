"""Task 38 P0 验收测试。

覆盖 5 个 P0 场景（delivery/05_测试验收/acceptance_criteria.md）：
- 场景 1：设备上线 → 遥测流 → 风险事件 → 事件处置 → 事件关闭（完整闭环）
- 场景 2：设备断连 → 补传 → 数据无丢失
- 场景 3：规则触发 → 事件去重 → 冷却 → 恢复收口
- 场景 4：数据导出 → 审计日志记录
- 场景 5：配置外置 → 环境变量覆盖 → 生效

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_p0_acceptance -v
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# inference 包在 edge_platform/ 下，需要 edge_platform 目录在 path 上
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from inference.events import EventEngine  # noqa: E402
from inference.pipeline import InferencePipeline  # noqa: E402
from inference.rules import RuleEngine  # noqa: E402

from edge_platform import server, stubs  # noqa: E402
from edge_platform.config import Settings  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.injector import WireInjector  # noqa: E402
from edge_platform.edge.exo_semantic import to_storage_dict  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


def _frame_to_msg(frame):
    """UnifiedExoFrame → 存储/推理管线消息格式（device_id/timestamp/telemetry）。"""
    d = to_storage_dict(frame)
    pose = d.get("pose") or {}
    load = d.get("load") or {}
    device = d.get("device") or {}
    return {
        "record_id": d.get("record_id", ""),
        "device_id": d.get("entity_id", ""),
        "timestamp": d.get("event_time", ""),
        "sequence": 0,
        "source_type": d.get("source_type", "real"),
        "person_id": d.get("worker_id"),
        "telemetry": {
            "pitch_deg": pose.get("trunk_pitch_deg"),
            "torque_nm": load.get("torque_nm"),
            "assist_level": load.get("assist_level"),
            "battery_percent": device.get("battery_pct"),
            "load_score": load.get("cumulative_load_score"),
        },
        "quality": d.get("quality") or {"status": "unknown"},
    }


def _ewoh_keys():
    return {k for k in os.environ if k.startswith("EWOH_")}


# ---------- P0 场景 1：设备上线 → 遥测流 → 风险事件 → 事件处置 → 事件关闭 ----------
class P0Scenario1FullClosedLoopTest(unittest.TestCase):
    """完整闭环：设备上线 → 遥测 → 风险事件触发 → 人工处置 → 事件关闭。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_p0_s1_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)

    def tearDown(self):
        self.storage.close()

    def test_device_online_to_event_close_full_loop(self):
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        rules = RuleEngine("risk-rule-v1.0", {"load_sec": 1, "cooldown_sec": 30})
        event_engine = EventEngine(self.storage, bus)
        pipeline = InferencePipeline(self.storage, bus, registry, rules, event_engine=event_engine)

        inj = WireInjector(
            device_id="EXO-P0-01", source_label="controlled_test", hz=20.0, start_ts_ms=1_000_000, battery_pct=80
        )
        adapter = NyExoA1Adapter("EXO-P0-01", source_type="controlled_test", worker_id="P-001")

        # 1. 设备上线：IDENT + 40 帧高负荷遥测（lift 画像 torque≈42Nm > 20Nm 阈值）
        adapter.feed(inj.ident() + inj.telemetry_burst(40, action="lift"))
        frames = adapter.drain()
        self.assertGreater(len(frames), 0, "应产出遥测帧")

        for f in frames:
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            self.storage.insert_telemetry(msg)
            pipeline.handle_telemetry(msg)

        # 2. 风险事件应已触发
        events = self.storage.list_events(100)
        load_events = [e for e in events if e.get("event_code") == "LOAD_CONTINUOUS"]
        self.assertGreater(len(load_events), 0, "应触发 LOAD_CONTINUOUS 事件")
        evt = load_events[0]
        self.assertEqual(evt["status"], "open")
        self.assertEqual(evt["severity"], "L2")
        event_id = evt["event_id"]

        # 3. 人工处置：确认事件
        self.storage.update_event_status(
            event_id,
            "confirmed",
            {"handled_by": "leader1", "action": "confirm", "handled_at": _iso(datetime.now()), "comment": "已现场核实"},
        )
        if hasattr(self.storage, "insert_event_handling"):
            self.storage.insert_event_handling(event_id, "leader1", "confirm", comment="已现场核实")
        evt = self.storage.get_event(event_id)
        self.assertEqual(evt["status"], "confirmed")

        # 4. 关闭事件
        self.storage.update_event_status(
            event_id,
            "closed",
            {"handled_by": "leader1", "action": "close", "handled_at": _iso(datetime.now()), "comment": "已调整工位"},
        )
        if hasattr(self.storage, "insert_event_handling"):
            self.storage.insert_event_handling(event_id, "leader1", "close", comment="已调整工位")
        evt = self.storage.get_event(event_id)
        self.assertEqual(evt["status"], "closed")

        # 5. 验证处置记录完整
        if hasattr(self.storage, "list_event_handlings"):
            handlings = self.storage.list_event_handlings(event_id)
            actions = [h["action"] for h in handlings]
            self.assertIn("confirm", actions)
            self.assertIn("close", actions)


# ---------- P0 场景 2：设备断连 → 补传 → 数据无丢失 ----------
class P0Scenario2DisconnectBackfillTest(unittest.TestCase):
    """设备断连 5s 后重连，BACKFILL 补传不丢失数据。"""

    def test_disconnect_reconnect_no_data_loss(self):
        inj = WireInjector(
            device_id="EXO-P0-02", source_label="controlled_test", hz=20.0, start_ts_ms=1_000_000, battery_pct=80
        )
        adapter = NyExoA1Adapter("EXO-P0-02", source_type="controlled_test")
        adapter.start()

        # 1. 上线：IDENT + 10 帧遥测
        online = adapter.feed(inj.ident() + inj.telemetry_burst(10, action="walk"))
        self.assertEqual(online, 10)

        # 2. 断连 5s = 100 帧
        missed = 100
        cached = inj.disconnect(missed_frames=missed, action="lift")
        self.assertEqual(cached, missed)

        # 3. 重连：IDENT + BACKFILL（含 2 个重复条目）
        reconnect_bytes = inj.reconnect(missed_frames=0, duplicates=2)
        produced_reconnect = adapter.feed(reconnect_bytes)
        # 100 缓存 + 2 重复 = 102 条目，去重 2 → 100 帧
        self.assertEqual(produced_reconnect, missed)

        # 4. 恢复实时遥测 20 帧
        post = adapter.feed(inj.telemetry_burst(20, action="walk"))
        self.assertEqual(post, 20)

        # 5. 总帧数 = 10 + 100 + 20 = 130，无丢失
        total = len(adapter.drain())
        self.assertEqual(total, 10 + missed + 20)

        health = adapter.health()
        self.assertEqual(health["dropped_frames"], 0)
        self.assertGreater(health["backfill_frames"], 0)
        self.assertEqual(health["backfill_duplicates"], 2)


# ---------- P0 场景 3：规则触发 → 事件去重 → 冷却 → 恢复收口 ----------
class P0Scenario3RuleDedupCooldownRecoverTest(unittest.TestCase):
    """规则触发后冷却期内不重复开事件；条件消失后自动收口。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_p0_s3_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)

    def tearDown(self):
        self.storage.close()

    def test_rule_trigger_dedup_cooldown_and_auto_close(self):
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        # 短窗规则：1s 触发，5s 冷却
        rules = RuleEngine("risk-rule-v1.0", {"load_sec": 1, "cooldown_sec": 5})
        event_engine = EventEngine(self.storage, bus)
        pipeline = InferencePipeline(self.storage, bus, registry, rules, event_engine=event_engine)

        inj = WireInjector(
            device_id="EXO-P0-03", source_label="controlled_test", hz=20.0, start_ts_ms=1_000_000, battery_pct=80
        )
        adapter = NyExoA1Adapter("EXO-P0-03", source_type="controlled_test", worker_id="P-001")

        # 1. 高负荷帧触发 LOAD_CONTINUOUS（lift 画像 torque≈42Nm > 20Nm）
        adapter.feed(inj.ident() + inj.telemetry_burst(40, action="lift"))
        for f in adapter.drain():
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            self.storage.insert_telemetry(msg)
            pipeline.handle_telemetry(msg)

        events_after_trigger = self.storage.list_events(100)
        load_events = [e for e in events_after_trigger if e.get("event_code") == "LOAD_CONTINUOUS"]
        self.assertEqual(len(load_events), 1, "应触发 1 个 LOAD_CONTINUOUS 事件")
        self.assertEqual(load_events[0]["status"], "open")
        event_id = load_events[0]["event_id"]

        # 2. 继续投递高负荷帧（冷却期内不应重复开事件）
        adapter.feed(inj.telemetry_burst(40, action="lift"))
        for f in adapter.drain():
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            self.storage.insert_telemetry(msg)
            pipeline.handle_telemetry(msg)

        events_after_cooldown = self.storage.list_events(100)
        load_events_2 = [e for e in events_after_cooldown if e.get("event_code") == "LOAD_CONTINUOUS"]
        self.assertEqual(len(load_events_2), 1, "冷却期内不应重复开新事件（事件去重）")

        # 3. 投递正常帧（stand 画像 torque≈2Nm < 退出阈值），条件消失 → 自动收口
        adapter.feed(inj.telemetry_burst(40, action="stand"))
        for f in adapter.drain():
            msg = _frame_to_msg(f)
            msg["person_id"] = "P-001"
            self.storage.insert_telemetry(msg)
            pipeline.handle_telemetry(msg)

        # 4. 事件应被自动关闭（rule_engine auto_close）
        evt = self.storage.get_event(event_id)
        self.assertEqual(evt["status"], "closed", "条件消失后事件应被自动收口")


# ---------- P0 场景 4：数据导出 → 审计日志记录 ----------
class P0Scenario4ExportAuditTest(unittest.TestCase):
    """数据导出后审计日志应记录操作人/目标/请求 ID。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ewoh_p0_s4_")
        cls.db_path = Path(cls.tmp) / "test.db"
        cls.storage = stubs.Storage(cls.db_path)
        stubs.seed_base(cls.storage)
        now = datetime.now().astimezone()
        cls.storage.insert_telemetry(
            {
                "record_id": "TS-P0-001",
                "device_id": "EXO-001",
                "timestamp": _iso(now),
                "sequence": 1,
                "source_type": "simulated",
                "telemetry": {"pitch_deg": 5.0, "load_score": 0.3, "battery_pct": 85},
                "quality": {"status": "good"},
            }
        )
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(cls.tmp) / "models")
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(cls.storage, bus, registry, rules)
        manager = stubs.AdapterManager(cls.storage, bus)
        cls.ctx = server.Context(
            cls.storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager
        )
        cls.httpd = server.build_server(("127.0.0.1", 0), cls.ctx)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        cls.storage.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_export_creates_audit_log(self):
        """POST /api/telemetry/export 后审计日志应记录导出操作。"""
        before = len(self.storage.list_audit_logs(target_type="telemetry"))
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        data = json.dumps({"device_id": "EXO-001", "start": s, "end": e, "format": "json"}).encode()
        r = urllib.request.Request(
            self.base + "/api/telemetry/export", data=data, method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
            self.assertEqual(resp.status, 200)

        after = len(self.storage.list_audit_logs(target_type="telemetry"))
        self.assertGreater(after, before, "导出操作应记审计日志")

        # 最新审计日志应包含目标设备 ID
        logs = self.storage.list_audit_logs(target_type="telemetry", limit=1)
        self.assertEqual(logs[0]["target_id"], "EXO-001")
        self.assertIsNotNone(logs[0]["request_id"])

    def test_export_csv_also_audited(self):
        """CSV 格式导出同样记审计日志。"""
        before = len(self.storage.list_audit_logs(target_type="telemetry"))
        now = datetime.now().astimezone()
        s, e = _iso(now - timedelta(minutes=5)), _iso(now + timedelta(seconds=5))
        data = json.dumps({"device_id": "EXO-001", "start": s, "end": e, "format": "csv"}).encode()
        r = urllib.request.Request(
            self.base + "/api/telemetry/export", data=data, method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
            self.assertEqual(resp.status, 200)

        after = len(self.storage.list_audit_logs(target_type="telemetry"))
        self.assertGreater(after, before, "CSV 导出也应记审计日志")


# ---------- P0 场景 5：配置外置 → 环境变量覆盖 → 生效 ----------
class P0Scenario5ConfigOverrideTest(unittest.TestCase):
    """环境变量覆盖 Settings 默认值并生效。"""

    def setUp(self):
        self._saved = dict(os.environ)
        for k in _ewoh_keys():
            os.environ.pop(k, None)
        Settings.reset()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        Settings.reset()

    def test_env_override_port_and_host(self):
        """EWOH_PORT / EWOH_HOST 环境变量覆盖默认值。"""
        os.environ["EWOH_PORT"] = "9999"
        os.environ["EWOH_HOST"] = "0.0.0.0"  # nosec B104 - test env fixture
        s = Settings.load()
        self.assertEqual(s.port, 9999)
        self.assertEqual(s.host, "0.0.0.0")  # nosec B104 - test assertion only

    def test_env_override_session_timeout(self):
        """EWOH_SESSION_TIMEOUT_SEC 覆盖会话超时。"""
        os.environ["EWOH_SESSION_TIMEOUT_SEC"] = "7200"
        s = Settings.load()
        self.assertEqual(s.session_timeout_sec, 7200)

    def test_env_override_export_roles(self):
        """EWOH_EXPORT_ALLOWED_ROLES 覆盖导出角色名单。"""
        os.environ["EWOH_EXPORT_ALLOWED_ROLES"] = "admin,operator"
        s = Settings.load()
        self.assertEqual(s.export_allowed_roles, ("admin", "operator"))

    def test_env_override_offline_threshold(self):
        """EWOH_OFFLINE_AFTER_SEC 覆盖离线判定阈值。"""
        os.environ["EWOH_OFFLINE_AFTER_SEC"] = "30"
        s = Settings.load()
        self.assertEqual(s.offline_after_sec, 30)

    def test_env_override_evidence_window(self):
        """EWOH_EVIDENCE_WINDOW_SEC 覆盖证据窗口。"""
        os.environ["EWOH_EVIDENCE_WINDOW_SEC"] = "60"
        s = Settings.load()
        self.assertEqual(s.evidence_window_sec, 60)

    def test_env_override_login_fail_lock(self):
        """EWOH_LOGIN_FAIL_LOCK 覆盖登录失败锁定阈值。"""
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "3"
        s = Settings.load()
        self.assertEqual(s.login_fail_lock, 3)

    def test_defaults_when_no_env(self):
        """无环境变量时全部回落到默认值。"""
        s = Settings.load()
        self.assertEqual(s.port, 8765)
        self.assertEqual(s.host, "127.0.0.1")
        self.assertEqual(s.session_timeout_sec, 3600)
        self.assertEqual(s.export_allowed_roles, ("admin", "safety_officer"))
        self.assertEqual(s.offline_after_sec, 10)
        self.assertEqual(s.evidence_window_sec, 30)
        self.assertEqual(s.login_fail_lock, 5)

    def test_override_takes_effect_after_reset(self):
        """reset 后重新读取环境变量，覆盖生效。"""
        s1 = Settings.load()
        self.assertEqual(s1.port, 8765)
        os.environ["EWOH_PORT"] = "7777"
        Settings.reset()
        s2 = Settings.load()
        self.assertEqual(s2.port, 7777)


if __name__ == "__main__":
    unittest.main()
