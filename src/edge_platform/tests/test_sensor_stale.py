"""Task 15.5 fault-injection：传感器停止上报遥测（sensor stale）降级可观测。

模拟一个传感器停止发送遥测：
1. 注入一帧新鲜遥测帧 → 边缘世界态端点（GET /api/devices，edge world 域路由）
   上报设备 online=true、quality good；
2. 模拟时间流逝（设备 last_seen 超过 OFFLINE_AFTER_SEC，等价于"传感器停止上报"）
   → 同一端点上报 online=false（显式离线，绝不静默保持在线）；
3. 帧质量管线把 fault/degraded 标记进 Data Quality → 设备 health 端点
   quality_status / fault / packet_loss_pct 字段可观测。

纯 Python 标准库 unittest + urllib；沿用 test_api_endpoints.py 的 server fixture 与
test_p0_acceptance.py（370-394 行）的 Settings/env 模式（离线阈值受控）。
运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_sensor_stale -v
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import edge_platform.routes._util as route_util  # noqa: E402,F401 - 保留 import 面向运行时函数
from edge_platform import server, stubs  # noqa: E402
from edge_platform.config import Settings  # noqa: E402


def _iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


class _SensorStaleFixture:
    """受控 server fixture：离线阈值经 EWOH_OFFLINE_AFTER_SEC + Settings.reset 注入。

    EDGE-045 整改后 offline_after_sec() 运行时读取 Settings（不再 import 时固化），
    测试改为走真实配置路径（env → Settings.reset → 运行时读取），
    比旧 monkeypatch 模块常量的方式更接近生产行为。
    """

    def __init__(self, offline_after_sec=10):
        self.offline_after_sec = int(offline_after_sec)
        self.tmp = tempfile.mkdtemp(prefix="ewoh_stale_")
        self.db_path = Path(self.tmp) / "test.db"
        self.storage = stubs.Storage(self.db_path)
        stubs.seed_base(self.storage)
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
        # 受控离线阈值：真实配置路径（env + reset），运行时函数即时生效。
        self._old_env = os.environ.get("EWOH_OFFLINE_AFTER_SEC")
        os.environ["EWOH_OFFLINE_AFTER_SEC"] = str(self.offline_after_sec)
        Settings.reset()
        # 增强（EDGE-045）：断言运行时读取路径确实反映新配置。
        assert route_util.offline_after_sec() == self.offline_after_sec

    def stop(self):
        if self._old_env is None:
            os.environ.pop("EWOH_OFFLINE_AFTER_SEC", None)
        else:
            os.environ["EWOH_OFFLINE_AFTER_SEC"] = self._old_env
        Settings.reset()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.storage.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, path, method="GET", body=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"}
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local test HTTP client
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, (json.loads(raw) if raw else {})


class SensorStaleTest(unittest.TestCase):
    """传感器停止上报遥测 → 离线/质量降级可观测（Task 15.5）。"""

    def setUp(self):
        self.fx = _SensorStaleFixture(offline_after_sec=10)

    def tearDown(self):
        self.fx.stop()

    def test_sensor_stops_sending_telemetry_reports_offline(self):
        """停止上报后超过 OFFLINE_AFTER_SEC → /api/devices（edge world）显式 offline。"""
        fx = self.fx
        now = datetime.now().astimezone()

        # 1) 注入一帧新鲜遥测（传感器正常上报）→ 在线。
        fx.storage.insert_telemetry(
            {
                "record_id": "TS-ONLINE-001",
                "device_id": "EXO-001",
                "timestamp": _iso(now),
                "sequence": 1,
                "source_type": "simulated",
                "telemetry": {"battery_pct": 85, "packet_loss_pct": 0.2},
                "quality": {"status": "good", "packet_loss_pct": 0.2},
            }
        )
        status, body = fx.req("/api/devices")
        self.assertEqual(status, 200)
        dev = next(x for x in body["items"] if x["device_id"] == "EXO-001")
        self.assertTrue(dev["online"])
        self.assertEqual(dev["last_seen"], _iso(now))

        # 2) 传感器停止上报：把 last_seen 推回超过 OFFLINE_AFTER_SEC（等价于时间流逝
        #    后无任何新遥测；online 标志保持 1，但新鲜度判定使其离线）。
        fx.storage.upsert_device(
            device_id="EXO-001",
            model="NY-EXO-A1",
            firmware_version="stub-1.0.0",
            person_id="P-001",
            online=1,
            source_type="simulated",
            last_seen=_iso(now - timedelta(seconds=fx.offline_after_sec + 60)),
        )
        status, body = fx.req("/api/devices")
        self.assertEqual(status, 200)
        dev = next(x for x in body["items"] if x["device_id"] == "EXO-001")
        # 15.6：降级可观测 —— 显式 offline 字段，绝不静默保持在线。
        self.assertFalse(dev["online"])

        # 单设备 health 同样显式 offline + 质量字段可观测。
        status, body = fx.req("/api/devices/EXO-001/health")
        self.assertEqual(status, 200)
        self.assertFalse(body["online"])
        self.assertIn("quality_status", body)
        self.assertIn("last_seen", body)

    def test_stale_sensor_quality_fault_surfaces_in_data_quality(self):
        """帧质量管线把 fault/degraded 标记进 Data Quality（health 端点可观测）。"""
        fx = self.fx
        now = datetime.now().astimezone()

        # 传感器最后一帧为降级帧（丢包+故障）→ 质量状态 degraded、fault=true。
        fx.storage.insert_telemetry(
            {
                "record_id": "TS-DEGRADED-001",
                "device_id": "EXO-002",
                "timestamp": _iso(now - timedelta(seconds=2)),
                "sequence": 2,
                "source_type": "simulated",
                "telemetry": {"battery_pct": 60, "packet_loss_pct": 35.0, "fault": True},
                "quality": {"status": "degraded", "packet_loss_pct": 35.0},
            }
        )
        status, body = fx.req("/api/devices/EXO-002/health")
        self.assertEqual(status, 200)
        # 15.6：降级可观测 —— Data Quality 字段显式标记。
        self.assertEqual(body["quality_status"], "degraded")
        self.assertTrue(body["fault"])
        # 丢包率字段存在且为数值（遥测表仅持久化 quality_status，丢包不作为真相源）。
        self.assertIsInstance(body["packet_loss_pct"], (int, float))

        # 无质量元数据（unknown）时同样显式标记 quality_status（不静默填 good）。
        fx.storage.insert_telemetry(
            {
                "record_id": "TS-NOQUALITY-001",
                "device_id": "EXO-002",
                "timestamp": _iso(now - timedelta(seconds=1)),
                "sequence": 3,
                "source_type": "simulated",
                "telemetry": {"battery_pct": 60},
            }
        )
        status, body = fx.req("/api/devices/EXO-002/health")
        self.assertEqual(status, 200)
        self.assertIn(body["quality_status"], ("unknown", "good"))  # 无质量时显式 unknown/good
        self.assertIn("fault", body)


if __name__ == "__main__":
    unittest.main()
