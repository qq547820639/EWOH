"""P0-EDGE-006：Production Runtime Assembly Smoke Test。

目标：防止「731 个 unit tests 通过，但 Production Runtime 只能跑 Stub」。

本测试**不 mock** build_components / RuntimeFactory / 真实装配路径，而是直接
按真实 production 路径装配并断言：
- import 成功（不依赖测试环境的 sys.path 别名）；
- 组件都是真实实现（MessageBus / Storage / InferencePipeline 等）；
- 不存在 stub 组件；
- 不触发 simulation 模式；
- production 装配失败必须 fail-fast（RealAssemblyError）。

注意：装配使用临时 SQLite 文件，不污染仓库 demo.db。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class ProductionAssemblyTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="ewoh_prod_asm_")
        self.db_path = str(Path(self._tmp) / "prod.db")
        # 隔离环境变量，避免 CI 影响
        self._old_mode = os.environ.pop("EWOH_RUNTIME_MODE", None)
        self._old_allow = os.environ.pop("EWOH_ALLOW_STUB", None)

    def tearDown(self):
        if self._old_mode is not None:
            os.environ["EWOH_RUNTIME_MODE"] = self._old_mode
        if self._old_allow is not None:
            os.environ["EWOH_ALLOW_STUB"] = self._old_allow
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    # ---- 真实装配（不 mock）----
    def test_production_real_assembly_succeeds_without_stub(self):
        from edge_platform.runtime.bootstrap import RuntimeFactory

        comps = RuntimeFactory(db_path=self.db_path).assemble("production")

        self.assertFalse(comps.is_simulation, "production 不得进入 simulation")
        self.assertIsNone(comps.simulator, "production 不得创建 simulator")
        self.assertEqual(comps.mode, "production")

        # Storage 必须是真实 SQLite 实现（edge_platform.edge.storage.Storage）
        from edge_platform.edge.storage import Storage as RealStorage

        self.assertIsInstance(comps.storage, RealStorage)
        # MessageBus 必须是真实实现（唯一正式契约）
        from edge_platform.edge.bus import MessageBus as RealBus

        self.assertIsInstance(comps.bus, RealBus)
        # 推理管线必须是真实实现
        from edge_platform.inference.pipeline import InferencePipeline as RealPipeline

        self.assertIsInstance(comps.pipeline, RealPipeline)
        # 规则引擎必须是真实实现
        from edge_platform.inference.rules import RuleEngine as RealRules

        self.assertIsInstance(comps.rules, RealRules)
        # 适配器管理必须是真实实现
        from edge_platform.edge.manager import AdapterManager as RealManager

        self.assertIsInstance(comps.manager, RealManager)

        # 真实组件必须定义在生产模块（edge_platform.edge / edge_platform.inference），
        # 不得定义在 stubs 模块。注意 Storage 已提升到 edge_platform.edge.storage，
        # 故 stubs.Storage 仅是兼容引用（其类模块在 edge.storage）——因此用类模块判断，
        # 而不是 isinstance(stubs.X)。
        for name, comp in comps.real_components.items():
            self.assertFalse(
                type(comp).__module__.startswith("edge_platform.stubs"),
                f"{name} 不得定义在 stubs 模块（实际 {type(comp).__module__}）",
            )

    def test_production_assembly_failure_fails_fast(self):
        from edge_platform.runtime.bootstrap import RuntimeFactory
        from edge_platform.runtime.dependencies import RealAssemblyError

        with self.assertRaises(RealAssemblyError):
            RuntimeFactory(db_path="/nonexistent/dir/db.sqlite").assemble("production")

    def test_production_pipeline_can_start_and_publish_inference(self):
        """真实装配后 pipeline 可 start 且发布到 inference stream（handler 契约）。"""
        from edge_platform.runtime.bootstrap import RuntimeFactory

        comps = RuntimeFactory(db_path=self.db_path).assemble("production")
        bus = comps.bus
        pipeline = comps.pipeline

        received = []

        def on_inference(msg):
            received.append(msg)

        sub_id = bus.subscribe("inference", on_inference)
        pipeline.start()
        try:
            # 真实 pipeline 需要 WINDOW_SIZE=40 帧（@20Hz 2s 窗口）才触发一次推理
            base = {
                "device_id": "EXO-PROD-1",
                "person_id": "P-1",
                "source_type": "real",
                "telemetry": {
                    "pitch_deg": 10.0,
                    "roll_deg": 2.0,
                    "angular_velocity": 1.0,
                    "acceleration": 9.8,
                    "torque_nm": 5.0,
                    "assist_level": 0.2,
                },
                "quality": {"status": "good"},
                "firmware_version": "v1.0.0",
            }
            import time

            for i in range(50):
                ts = f"2026-08-08T00:00:{int(i):02}.000+08:00"
                pipeline.handle_telemetry({**base, "sequence": i + 1, "timestamp": ts})
            time.sleep(0.3)
        finally:
            bus.unsubscribe("inference", sub_id)
            if hasattr(pipeline, "stop"):
                pipeline.stop()

        self.assertTrue(
            len(received) >= 1,
            "production pipeline 应发布 inference 事件（handler 契约）",
        )

    # ---- development 语义 ----
    def test_development_without_allow_stub_fails_on_bad_db(self):
        from edge_platform.runtime.bootstrap import RuntimeFactory
        from edge_platform.runtime.dependencies import RealAssemblyError

        os.environ["EWOH_ALLOW_STUB"] = ""
        with self.assertRaises(RealAssemblyError):
            RuntimeFactory(db_path="/nonexistent/dir/db.sqlite").assemble("development")

    def test_simulation_explicit_only(self):
        from edge_platform.runtime.bootstrap import RuntimeFactory

        comps = RuntimeFactory(db_path=self.db_path).assemble("simulation")
        self.assertTrue(comps.is_simulation)
        self.assertIsNotNone(comps.simulator)


if __name__ == "__main__":
    unittest.main()
