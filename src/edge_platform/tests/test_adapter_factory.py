"""Config 驱动适配器工厂测试（NO-03c / E-03 修复）。

覆盖：四类适配器 kind 构造、未知 kind/参数/必填缺失 fail-closed、
Settings.adapters 环境变量解析（合法/非法/空）。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.config import Settings
from edge_platform.edge.adapter_factory import build_adapters
from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.camera.adapter import CameraAdapter
from edge_platform.edge.adapters.environment.adapter import EnvSensorAdapter
from edge_platform.edge.adapters.mes.adapter import MESAdapter
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter


class AdapterFactoryTest(unittest.TestCase):
    def test_ny_exo_a1_from_spec(self):
        adapters = build_adapters(
            [{"kind": "ny_exo_a1", "deviceId": "EXO-001", "sourceType": "real",
              "workerId": "P-001", "firmwareVersion": "1.2.3"}]
        )
        self.assertEqual(len(adapters), 1)
        self.assertIsInstance(adapters[0], NyExoA1Adapter)
        self.assertIsInstance(adapters[0], BaseAdapter)
        self.assertEqual(adapters[0].device_id, "EXO-001")
        self.assertEqual(adapters[0].firmware_version, "1.2.3")

    def test_camera_environment_mes(self):
        adapters = build_adapters(
            [
                {"kind": "camera", "cameraId": "CAM-001", "sourceType": "real"},
                {"kind": "environment", "sensorId": "ENV-001", "stationId": "ST-01",
                 "sourceType": "real"},
                {"kind": "mes", "deviceId": "MES-001", "sourceType": "real",
                 "systemName": "MES-DEMO"},
            ]
        )
        self.assertIsInstance(adapters[0], CameraAdapter)
        self.assertEqual(adapters[0].device_id, "CAM-001")
        self.assertIsInstance(adapters[1], EnvSensorAdapter)
        self.assertEqual(adapters[1].device_id, "ENV-001")
        self.assertIsInstance(adapters[2], MESAdapter)
        self.assertEqual(adapters[2].device_id, "MES-001")
        self.assertEqual(adapters[2].model, "MES-DEMO")

    def test_unknown_kind_fail_closed(self):
        with self.assertRaises(ValueError) as cm:
            build_adapters([{"kind": "gizmo", "deviceId": "X"}])
        self.assertIn("未知/未支持适配器 kind", str(cm.exception))

    def test_unknown_param_fail_closed(self):
        with self.assertRaises(ValueError) as cm:
            build_adapters(
                [{"kind": "ny_exo_a1", "deviceId": "EXO-001", "typoParam": 1}]
            )
        self.assertIn("未知参数", str(cm.exception))

    def test_missing_required_fail_closed(self):
        with self.assertRaises(ValueError) as cm:
            build_adapters([{"kind": "mes", "sourceType": "real"}])
        self.assertIn("缺少必填参数", str(cm.exception))

    def test_empty_spec_is_valid_empty_manager(self):
        # 空列表 = 合法空管理器（无设备接入），不是 stub
        self.assertEqual(build_adapters([]), [])

    def test_settings_adapters_env(self):
        old = os.environ.get("EWOH_ADAPTERS")
        try:
            os.environ["EWOH_ADAPTERS"] = json.dumps(
                [{"kind": "mes", "deviceId": "MES-001"}]
            )
            settings = Settings()
            self.assertEqual(settings.adapters, [{"kind": "mes", "deviceId": "MES-001"}])
            del os.environ["EWOH_ADAPTERS"]
            self.assertEqual(Settings().adapters, [])
            os.environ["EWOH_ADAPTERS"] = "not-json"
            with self.assertRaises(ValueError):
                _ = Settings().adapters
            os.environ["EWOH_ADAPTERS"] = '"not-a-list"'
            with self.assertRaises(ValueError):
                _ = Settings().adapters
        finally:
            if old is None:
                os.environ.pop("EWOH_ADAPTERS", None)
            else:
                os.environ["EWOH_ADAPTERS"] = old


if __name__ == "__main__":
    unittest.main()
