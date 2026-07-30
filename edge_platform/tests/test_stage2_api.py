"""阶段 2（Task 14/15/16/17）API 集成测试。

使用 edge.storage（真实持久层）+ server.build_server 起线程 HTTP 服务，
通过 urllib.request 调用所有阶段 2 新增端点，验证：

- GET /api/devices/{id}, /api/devices/{id}/health
- GET /api/events/{id}（含证据窗口 record_ids）
- POST /api/events/{id}/comment 写入 event_handling
- GET /api/audit 审计查询
- GET /api/models 与 /api/rules
- retention_purge 删除旧遥测保留事件
- withdraw_consent 停止采集 + 删除 + 审计
- X-Request-ID 回显与限流 429
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from edge_platform import server
from edge_platform.edge.storage import Storage


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


def _seed(storage):
    """植入测试基础数据：1 人员、1 设备、若干遥测、1 推理、1 事件。"""
    storage.upsert_person(person_id="P-T01", display_name="测试员甲", team="月台A",
                          skills=["搬运", "装配"], consent_status="granted", active=1)
    storage.upsert_device(device_id="DEV-A1", device_type="exoskeleton",
                          model="NY-EXO-A1", firmware_version="1.4.2",
                          person_id="P-T01", online=1, source_type="real",
                          last_seen=_iso(datetime.now()))
    # 写入 5 条遥测（覆盖事件前后 30s 窗口）
    base = datetime.now().astimezone() - timedelta(seconds=40)
    for i in range(5):
        ts = base + timedelta(seconds=i * 20)
        storage.insert_telemetry({
            "record_id": "TS-T-%02d" % i, "device_id": "DEV-A1",
            "timestamp": _iso(ts), "sequence": i, "source_type": "real",
            "device_model": "NY-EXO-A1", "firmware_version": "1.4.2",
            "protocol_version": "NXP1-1.0",
            "telemetry": {"pitch_deg": 30 + i, "load_score": 0.4 + i * 0.05,
                          "battery_percent": 80 - i, "packet_loss_pct": 0.1},
            "quality": {"status": "good", "packet_loss_pct": 0.1},
        })
    # 1 条推理
    storage.insert_inference({
        "inference_id": "INF-T-01", "device_id": "DEV-A1",
        "ts_start": _iso(base), "ts_end": _iso(base + timedelta(seconds=20)),
        "label": "搬运", "confidence": 0.92,
        "model_id": "rule-hybrid", "model_version": "0.1",
        "source_type": "real",
        "meta": {"is_rule": True, "data_quality": "good"},
    })
    # 1 条结构化事件（事件时间在遥测窗口中段）
    ev_ts = base + timedelta(seconds=40)
    storage.insert_event({
        "event_id": "EVT-T-001", "event_code": "LOAD_CONTINUOUS", "severity": "L2",
        "status": "open", "person_id": "P-T01", "device_id": "DEV-A1",
        "start_time": _iso(ev_ts),
        "trigger": {"type": "rule", "rule_version": "risk-rule-0.1",
                    "condition": "连续高负荷滑动窗口超限"},
        "evidence": {"window_before_sec": 30, "window_after_sec": 30,
                     "record_id": "TS-T-02", "data_quality": "good"},
        "source_type": "real",
    })
    return ev_ts


class Stage2ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ewoh_stage2_")
        cls.db_path = os.path.join(cls.tmp, "stage2.db")
        cls.storage = Storage(cls.db_path)
        _seed(cls.storage)
        cls.ctx = server.Context(cls.storage)
        cls.httpd = server.build_server(("127.0.0.1", 0), cls.ctx)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.storage.close()
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, method="GET",
                                      headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode()), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode()), dict(e.headers)

    def _post(self, path, body, headers=None):
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode()), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode()), dict(e.headers)

    # ---- Task 16: 设备详情与健康 ----
    def test_get_device_detail(self):
        status, body, _ = self._get("/api/devices/DEV-A1")
        self.assertEqual(status, 200)
        self.assertEqual(body["device_id"], "DEV-A1")
        self.assertEqual(body["source_type"], "real")
        self.assertIn("health", body)
        self.assertEqual(body["health"]["device_id"], "DEV-A1")
        self.assertIn("latest", body)

    def test_get_device_detail_not_found(self):
        status, body, _ = self._get("/api/devices/NOPE")
        self.assertEqual(status, 404)
        self.assertIn("error", body)

    def test_get_device_health(self):
        status, body, _ = self._get("/api/devices/DEV-A1/health")
        self.assertEqual(status, 200)
        h = body["health"]
        self.assertEqual(h["device_id"], "DEV-A1")
        # 必备字段（即使值为 None）
        for k in ("online", "last_packet_ts", "packet_loss_pct",
                  "clock_offset_ms", "battery", "fault", "reconnect_count"):
            self.assertIn(k, h)
        self.assertEqual(h["battery"], 76)  # 最后一条 battery=80-4

    # ---- Task 17: 事件证据窗口 ----
    def test_get_event_detail_with_evidence_window(self):
        status, body, _ = self._get("/api/events/EVT-T-001")
        self.assertEqual(status, 200)
        evt = body["event"]
        # norm_event 补齐的字段（Task 17.1）
        for k in ("event_id", "event_code", "severity", "status", "person_id",
                  "device_id", "task_id", "zone_id", "start_time", "end_time",
                  "trigger", "evidence", "handling", "source_type"):
            self.assertIn(k, evt)
        # trigger 子结构补齐
        for k in ("type", "rule_version", "condition"):
            self.assertIn(k, evt["trigger"])
        # evidence 子结构补齐
        for k in ("window_before_sec", "window_after_sec", "record_ids",
                  "data_quality", "source_type"):
            self.assertIn(k, evt["evidence"])
        # 证据窗口前后 30s 遥测 record_ids（Task 17.2）
        self.assertEqual(body["evidence_window_sec"], 30)
        self.assertIn("evidence_record_ids", body)
        self.assertGreater(len(body["evidence_record_ids"]), 0)
        self.assertEqual(body["evidence_record_ids"], body.get("evidence_records") and
                         [r["record_id"] for r in body["evidence_records"]])

    # ---- Task 16: 事件评论 ----
    def test_post_event_comment_writes_handling(self):
        status, body, _ = self._post("/api/events/EVT-T-001/comment",
                                     {"comment": "请现场确认后处置", "operator": "班组长A"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["handling_id"])
        # 校验写入 event_handling 表
        rows = self.storage.list_event_handling("EVT-T-001")
        comments = [r for r in rows if r["action"] == "comment"]
        self.assertGreater(len(comments), 0)
        self.assertEqual(comments[-1]["comment"], "请现场确认后处置")
        self.assertEqual(comments[-1]["operator"], "班组长A")
        # 审计记录
        audits = self.storage.list_audit(limit=20, action="EVENT_COMMENT")
        self.assertGreater(len(audits), 0)

    def test_post_event_comment_empty_rejected(self):
        status, body, _ = self._post("/api/events/EVT-T-001/comment", {"comment": ""})
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_post_event_comment_event_not_found(self):
        status, body, _ = self._post("/api/events/EVT-NOTFOUND/comment",
                                     {"comment": "x"})
        self.assertEqual(status, 404)

    # ---- Task 16: 审计查询 ----
    def test_get_audit_list(self):
        # 先触发一次审计写入
        self._post("/api/events/EVT-T-001/comment", {"comment": "审记触发", "operator": "审计员"})
        status, body, _ = self._get("/api/audit?limit=20")
        self.assertEqual(status, 200)
        self.assertIn("items", body)
        self.assertGreater(len(body["items"]), 0)
        sample = body["items"][0]
        for k in ("audit_id", "action", "ts"):
            self.assertIn(k, sample)
        # 按 action 过滤
        _, body2, _ = self._get("/api/audit?action=EVENT_COMMENT&limit=10")
        self.assertTrue(all(x["action"] == "EVENT_COMMENT" for x in body2["items"]))
        # 按 object_type 过滤
        _, body3, _ = self._get("/api/audit?object_type=risk_event&limit=10")
        self.assertTrue(all(x["object_type"] == "risk_event" for x in body3["items"]))

    # ---- Task 16: 模型 / 规则列表 ----
    def test_get_models(self):
        # 先在 storage 注册一个模型
        self.storage.upsert_model_registry("action-classifier", "0.1.0",
                                            metrics={"f1": 0.9})
        self.storage.activate_model("action-classifier", "0.1.0", "tester")
        status, body, _ = self._get("/api/models")
        self.assertEqual(status, 200)
        self.assertIn("runtime", body)
        self.assertIn("registry", body)
        found = [m for m in body["registry"] if m["model_id"] == "action-classifier"]
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]["is_active"])

    def test_get_rules(self):
        self.storage.upsert_rule_registry("risk-rule", "0.1", config={"thr": 0.5})
        self.storage.activate_rule("risk-rule", "0.1", "tester")
        status, body, _ = self._get("/api/rules")
        self.assertEqual(status, 200)
        self.assertIn("runtime", body)
        self.assertIn("registry", body)
        found = [r for r in body["registry"] if r["rule_id"] == "risk-rule"]
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]["is_active"])

    # ---- Task 14/15: retention_purge ----
    def test_retention_purge_deletes_old_telemetry_keeps_events(self):
        # 写入一条 100 天前的遥测
        old_ts = _iso(datetime.now() - timedelta(days=100))
        self.storage.insert_telemetry({
            "record_id": "TS-OLD-01", "device_id": "DEV-A1",
            "timestamp": old_ts, "sequence": 999, "source_type": "real",
            "telemetry": {"pitch_deg": 5}, "quality": {"status": "good"},
        })
        before_t = self.storage.counts()["telemetry"]
        before_e = self.storage.counts()["risk_event"]
        status, body, _ = self._post("/api/admin/retention-purge",
                                     {"retention_days": 30, "operator": "admin"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertGreaterEqual(body["deleted"]["telemetry"], 1)
        # 事件保留
        self.assertEqual(self.storage.counts()["risk_event"], before_e)
        # 旧遥测确实被删除（telemetry 条数应减少）
        self.assertLess(self.storage.counts()["telemetry"], before_t)
        # 审计记录写入
        audits = self.storage.list_audit(limit=20, action="RETENTION_PURGE")
        self.assertGreater(len(audits), 0)

    # ---- Task 15: withdraw_consent ----
    def test_withdraw_consent_stops_and_deletes_with_audit(self):
        # 新建一名人员 + 设备 + 遥测
        self.storage.upsert_person(person_id="P-WC", display_name="撤回测试员",
                                   skills=["搬运"], consent_status="granted")
        self.storage.upsert_device(device_id="DEV-WC", model="NY-EXO-A1",
                                   person_id="P-WC", online=1, source_type="real",
                                   last_seen=_iso(datetime.now()))
        for i in range(3):
            self.storage.insert_telemetry({
                "record_id": "TS-WC-%d" % i, "device_id": "DEV-WC",
                "timestamp": _iso(datetime.now() - timedelta(seconds=i * 5)),
                "sequence": i, "source_type": "real",
                "telemetry": {"load_score": 0.3}, "quality": {"status": "good"},
            })
        # 事件不应被删除
        self.storage.insert_event({
            "event_id": "EVT-WC-01", "event_code": "POSTURE_BEND",
            "severity": "L1", "status": "open", "person_id": "P-WC",
            "device_id": "DEV-WC", "start_time": _iso(datetime.now()),
            "trigger": {"type": "rule", "rule_version": "risk-rule-0.1",
                        "condition": "弯腰持续"},
            "evidence": {"window_before_sec": 30, "window_after_sec": 30},
            "source_type": "real",
        })
        before_t = self.storage.counts()["telemetry"]
        before_e = self.storage.counts()["risk_event"]
        status, body, _ = self._post("/api/people/P-WC/withdraw-consent",
                                     {"reason": "人员离职", "operator": "安全管理员"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["consent_id"])
        # 验证 person.consent_status 已更新
        person = next(p for p in self.storage.list_people() if p["person_id"] == "P-WC")
        self.assertEqual(person["consent_status"], "withdrawn")
        # telemetry 应被删除（按 person_id 清理）
        self.assertGreaterEqual(body["deleted"]["telemetry"], 3)
        # 事件保留
        self.assertEqual(self.storage.counts()["risk_event"], before_e)
        # 审计写入（withdraw + audit_log 不被清理）
        audits = self.storage.list_audit(limit=20, action="WITHDRAW_CONSENT")
        self.assertGreater(len(audits), 0)
        # consent_record 写入
        crs = self.storage.list_consent_records(person_id="P-WC")
        self.assertGreater(len(crs), 0)

    def test_withdraw_consent_person_not_found(self):
        status, body, _ = self._post("/api/people/P-NOTFOUND/withdraw-consent",
                                     {"reason": "x"})
        self.assertEqual(status, 404)

    # ---- Task 16: X-Request-ID 回显 + 限流 429 ----
    def test_request_id_echoed(self):
        rid = "test-rid-" + str(int(time.time() * 1000))
        status, _, headers = self._get("/api/status", headers={"X-Request-ID": rid})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Request-ID") or headers.get("x-request-id"), rid)

    def test_request_id_generated_when_absent(self):
        status, _, headers = self._get("/api/status")
        self.assertEqual(status, 200)
        rid = headers.get("X-Request-ID") or headers.get("x-request-id")
        self.assertTrue(rid)

    def test_rate_limit_returns_429(self):
        # 通过临时构造一个新的低阈值限流器替换全局，避免影响其他测试
        from edge_platform.server import _RateLimiter
        orig = server._RATE_LIMITER
        try:
            server._RATE_LIMITER = _RateLimiter(window_sec=60, max_req=2)
            # 前 2 次正常，第 3 次 429
            s1, _, _ = self._get("/api/status")
            s2, _, _ = self._get("/api/status")
            s3, body3, _ = self._get("/api/status")
            self.assertEqual(s1, 200)
            self.assertEqual(s2, 200)
            self.assertEqual(s3, 429)
            self.assertEqual(body3["error"], "too_many_requests")
        finally:
            server._RATE_LIMITER = orig

    # ---- Task 16: 鉴权占位 ----
    def test_auth_login_returns_501(self):
        status, body, _ = self._post("/api/auth/login", {"username": "x", "password": "y"})
        self.assertEqual(status, 501)
        self.assertEqual(body["error"], "auth_not_implemented")

    def test_auth_refresh_returns_501(self):
        status, body, _ = self._post("/api/auth/refresh", {"refresh_token": "x"})
        self.assertEqual(status, 501)

    def test_me_returns_501(self):
        status, body, _ = self._get("/api/me")
        self.assertEqual(status, 501)
        self.assertEqual(body["error"], "auth_not_implemented")

    # ---- Task 16: 幂等键 ----
    def test_idempotency_key_replays_response(self):
        # 用一个未绑定高风险事件的人员，避免硬约束拦截导致 409
        self.storage.upsert_person(person_id="P-IDEM", display_name="幂等测试员",
                                   skills=["搬运"], consent_status="granted",
                                   team="月台B", active=1)
        self.storage.upsert_device(device_id="DEV-IDEM", model="NY-EXO-A1",
                                   person_id="P-IDEM", online=1, source_type="real",
                                   last_seen=_iso(datetime.now()))
        self.storage.insert_telemetry({
            "record_id": "TS-IDEM-01", "device_id": "DEV-IDEM",
            "timestamp": _iso(datetime.now()), "sequence": 1, "source_type": "real",
            "telemetry": {"load_score": 0.3}, "quality": {"status": "good"},
        })
        body = {"required_skill": "搬运", "zone_id": "月台B",
                "person_id": "P-IDEM", "confirmer": "班组长A"}
        headers = {"Idempotency-Key": "idem-stage2-001"}
        s1, b1, _ = self._post("/api/tasks/confirm", body, headers=headers)
        self.assertEqual(s1, 200)
        self.assertTrue(b1["ok"])
        # 第二次：相同 Idempotency-Key 应回放
        s2, b2, _ = self._post("/api/tasks/confirm", body, headers=headers)
        self.assertEqual(s2, 200)
        self.assertEqual(b1, b2)

    # ---- Task 17: EWOH_EVIDENCE_WINDOW_SEC 环境变量 ----
    def test_evidence_window_env_var(self):
        """验证 server 模块的 EVIDENCE_WINDOW_SEC 由环境变量驱动。

        这里只检查模块已加载后的常量；不重新 import（避免破坏其他测试的共享 server）。
        """
        # 默认 30（其他测试也依赖此值）
        self.assertEqual(server.EVIDENCE_WINDOW_SEC, 30)
        # 通过新进程验证 env var 生效
        import subprocess
        env = dict(os.environ)
        env["EWOH_EVIDENCE_WINDOW_SEC"] = "60"
        out = subprocess.check_output(
            [sys.executable, "-c",
             "from edge_platform import server; print(server.EVIDENCE_WINDOW_SEC)"],
            env=env, cwd=str(Path(__file__).resolve().parent.parent.parent))
        self.assertEqual(int(out.strip()), 60)


if __name__ == "__main__":
    unittest.main()
