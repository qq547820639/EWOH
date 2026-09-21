"""边缘平台测试共享 fixture（EDT-014/EDT-017/EDT-010，2026-08-17 审计整改）。

- ``_ServerFixture``：原先在 test_security_boundary / test_api_endpoints /
  test_server_routes_characterization 三份近重复的 server 装配 fixture 收敛至此，
  经构造参数保留各测试文件的原有数据形状（记录 ID / 是否注册模型规则）。
- ``wait_until``：条件等待抽象（deadline 轮询），替代裸 time.sleep 轮询。
- ``FakeStorage`` / ``FakeBus``：test_inference 的内存伪实现迁移至此共享
  （保留原始 dict 语义，非 SQLite stubs.Storage 的替代）。

用法（各测试文件已把本目录加入 sys.path）：
    from _fixtures import _ServerFixture, wait_until
"""

import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import server, stubs  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


def wait_until(cond, timeout=5.0, interval=0.05):
    """EDT-010：条件等待（deadline 轮询）；超时返回 False。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


class _ServerFixture:
    """每个测试类共享一个 server 实例（随机端口），减少启停开销。

    EDT-014：三份近重复 fixture 的共享实现。参数保留各调用方原数据形状：
    - ``prefix``：临时目录前缀；
    - ``telemetry_record_id`` / ``event_id``：种子遥测/事件记录 ID；
    - ``with_model_rule``：是否注册 MODEL-A / RULE-LOAD（test_api_endpoints 用）。
    """

    def __init__(self, prefix="ewoh_fx_", telemetry_record_id="TS-FX-001",
                 event_id="EVT-FX0001", with_model_rule=False):
        self.tmp = tempfile.mkdtemp(prefix=prefix)
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
        # 插入一条遥测（带 battery/packet_loss）用于 health/export 测试
        now = datetime.now().astimezone()
        self.storage.insert_telemetry(
            {
                "record_id": telemetry_record_id,
                "device_id": "EXO-001",
                "timestamp": _iso(now),
                "sequence": 1,
                "source_type": "simulated",
                "telemetry": {"pitch_deg": 5.0, "load_score": 0.3, "battery_pct": 85, "packet_loss_pct": 0.2},
                "quality": {"status": "good", "packet_loss_pct": 0.2},
            }
        )
        # 插入一条结构化事件用于 event 端点测试
        self.storage.insert_event(
            {
                "event_id": event_id,
                "event_code": "LOAD_CONTINUOUS",
                "severity": "L2",
                "status": "open",
                "person_id": "P-001",
                "device_id": "EXO-001",
                "start_time": _iso(now),
                "trigger": {"type": "rule", "condition": "连续高负荷"},
                "evidence": {"window_before_sec": 30, "window_after_sec": 30},
                "source_type": "simulated",
            }
        )
        if with_model_rule:
            self.storage.insert_model_record("MODEL-A", "action_classifier", "0.1", model_card_uri="card://a")
            self.storage.insert_rule_record(
                "RULE-LOAD", "v0.1", enabled=True, config_json={"threshold": 0.7}, severity="L2"
            )
        bus = stubs.Bus()
        registry = stubs.ModelRegistry(Path(self.tmp) / "models")
        rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
        pipeline = stubs.InferencePipeline(self.storage, bus, registry, rules)
        manager = stubs.AdapterManager(self.storage, bus)
        self.ctx = server.Context(
            self.storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager
        )
        self.httpd = server.build_server(("127.0.0.1", 0), self.ctx)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, path, method="GET", body=None, headers=None):
        """发起请求，返回 (status, headers, body_dict)。"""
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                raw = resp.read().decode()
                return resp.status, resp.headers, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, e.headers, (json.loads(raw) if raw else {})

    def raw(self, path, method="GET", body_bytes=None, headers=None):
        """发起原始字节请求（用于超大 body 测试），返回 (status, headers, body_bytes)。"""
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = urllib.request.Request(self.base + path, data=body_bytes, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def login(self, username, password):
        """登录获取 Bearer token；返回 (token, role) 或 (None, None)。"""
        status, _, body = self.req(
            "/api/auth/login", method="POST", body={"username": username, "password": password}
        )
        if status == 200:
            return body["token"], body["user"].get("role")
        return None, None


# ---------- test_inference 的内存伪实现（EDT-017：迁移共享，语义不变） ----------


class FakeStorage:
    """内存 Storage 伪实现（契约对齐；保留原始 dict，非 SQLite 语义）。"""

    def __init__(self, db_path=None):
        if db_path is None:
            fd, db_path = tempfile.mkstemp(suffix=".db")
            os.close(fd)
        self.db_path = db_path
        self.telemetry = []
        self.inferences = []
        self.events = {}

    def init_db(self):
        pass

    def insert_telemetry(self, msg, raw_hex=None):
        self.telemetry.append(msg)

    def latest_telemetry(self, device_id):
        msgs = [m for m in self.telemetry if m["device_id"] == device_id]
        return msgs[-1] if msgs else None

    def query_telemetry(self, device_id, start, end, limit=1000):
        from edge_platform.inference import ts_to_ms

        s, e = ts_to_ms(start), ts_to_ms(end)
        out = [m for m in self.telemetry if m["device_id"] == device_id and s <= ts_to_ms(m["timestamp"]) <= e]
        out.sort(key=lambda m: ts_to_ms(m["timestamp"]))
        return out[:limit]

    def export_slice(self, device_id, start, end):
        return self.query_telemetry(device_id, start, end, 100000)

    def list_devices(self):
        return sorted({m["device_id"] for m in self.telemetry})

    def insert_inference(self, res):
        self.inferences.append(res)

    def query_inference(self, device_id, start, end, limit=100):
        return self.inferences[-limit:]

    def insert_event(self, evt):
        self.events[evt["event_id"]] = dict(evt)

    def list_events(self, limit=100):
        evts = sorted(self.events.values(), key=lambda e: e["start_time"])
        return evts[-limit:]

    def get_event(self, eid):
        return self.events.get(eid)

    def update_event_status(self, eid, status, handling):
        self.events[eid]["status"] = status
        self.events[eid]["handling"] = handling

    def record_event_status(self, eid, status, handling, action, handler_id, audit_ref=None):
        if eid not in self.events:
            raise LookupError(f"event not found: {eid}")
        self.update_event_status(eid, status, handling)
        return {
            "event_id": eid,
            "handler_id": handler_id,
            "action": action,
            "comment": handling.get("comment"),
            "handled_at": handling.get("handled_at"),
            "audit_ref": audit_ref,
        }


class FakeBus:
    """内存消息总线伪实现（订阅队列 + 发布记录）。"""

    def __init__(self):
        self.queues = {}
        self.published = {}

    def subscribe(self, topic):
        q = queue.Queue()
        self.queues.setdefault(topic, []).append(q)
        return q

    def publish(self, topic, msg):
        self.published.setdefault(topic, []).append(msg)
        for q in self.queues.get(topic, []):
            q.put(msg)
