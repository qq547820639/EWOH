"""遥测 → 世界模型自动投影测试（NO-03c：感知自动接线 + NO-04a：Catalog 信封事件上行）。

覆盖：配置缺失显式关闭（health.enabled=false）；kind_map 前缀解析；
首帧声明 + 状态投影 + ENTITY_OBSERVED 因果事件；source_type 非契约三态
拒绝计数；无映射前缀跳过计数；真实 MessageBus 订阅集成（start→publish→
world_store 落账）；EntityDeclared/EntityStateObserved Catalog 信封事件
（落事件库 + STREAM_EVENTS，契约校验，首见单次发射不重复）。
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.bus import MessageBus
from edge_platform.runtime.protocols import STREAM_EVENTS, STREAM_TELEMETRY
from edge_platform.world_model.contract_store import ContractWorldStore
from edge_platform.world_model.projection import TelemetryWorldProjector

TENANT = "org-1"
FACTORY = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"
KIND_MAP = {"EXO-": "exo", "ENV-": "sensor"}


def _row(device_id, source_type="real", telemetry=None, timestamp=None, person_id=None):
    return {
        "record_id": "TS-1",
        "device_id": device_id,
        "timestamp": timestamp or "2026-08-16T08:05:00Z",
        "sequence": 1,
        "source_type": source_type,
        "person_id": person_id,
        "telemetry": telemetry or {"battery_pct": 80, "cumulative_load_score": 0.4},
        "quality": {"status": "good"},
    }


class TelemetryWorldProjectorTest(unittest.TestCase):
    def setUp(self):
        self.store = ContractWorldStore()
        self.bus = MessageBus()
        self.projector = TelemetryWorldProjector(
            self.store, self.bus, tenant_id=TENANT, factory_id=FACTORY, kind_map=KIND_MAP
        )

    def test_disabled_without_config(self):
        p = TelemetryWorldProjector(self.store, self.bus)
        self.assertFalse(p.enabled)
        self.assertFalse(p.health()["enabled"])
        # handle 在禁用状态下不伪造任何事实
        out = p.handle(_row("EXO-001"))
        self.assertEqual(out["skipped_reason"], "no_kind")
        self.assertEqual(len(self.store.declarations()), 0)

    def test_first_frame_declares_and_projects(self):
        out = self.projector.handle(_row("EXO-001"))
        self.assertTrue(out["projected"])
        self.assertEqual(out["entity_id"], "exo:EXO-001")
        decl = self.store.declaration("exo:EXO-001")
        self.assertEqual(decl["kind"], "exo")
        self.assertEqual(decl["tenantId"], TENANT)
        state = self.store.current("exo:EXO-001", "exo")
        self.assertEqual(state.state_json["battery_pct"], 80)
        events = self.store.event_graph().all_nodes()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].node_type, "ENTITY_OBSERVED")
        counters = self.projector.health()["counters"]
        self.assertEqual(counters["declarations"], 1)
        self.assertEqual(counters["states_projected"], 1)
        self.assertEqual(counters["events_recorded"], 1)

    def test_second_frame_no_redeclare(self):
        self.projector.handle(_row("EXO-001"))
        out = self.projector.handle(
            _row("EXO-001", telemetry={"battery_pct": 70, "cumulative_load_score": 0.5})
        )
        self.assertTrue(out["projected"])
        counters = self.projector.health()["counters"]
        self.assertEqual(counters["declarations"], 1)
        self.assertEqual(counters["states_projected"], 2)
        self.assertEqual(counters["events_recorded"], 1)
        # 状态版本单调
        self.assertEqual(self.store.current("exo:EXO-001", "exo").version, 2)

    def test_non_contract_source_rejected_counted(self):
        # EDGE-202 整改后 controlled_test 显式映射 derived（见下方专项用例）；
        # 非法来源（不在采集面/世界契约任一枚举内）仍拒绝并计数。
        out = self.projector.handle(_row("EXO-001", source_type="bogus"))
        self.assertFalse(out["projected"])
        self.assertEqual(out["skipped_reason"], "bad_source")
        self.assertEqual(self.projector.health()["counters"]["rejected_source"], 1)
        self.assertEqual(len(self.store.declarations()), 0)

    def test_controlled_test_mapped_to_derived(self):
        """EDGE-202：受控采集帧显式映射 derived 投影（不再整类拒绝）。"""
        out = self.projector.handle(_row("EXO-CT-1", source_type="controlled_test"))
        self.assertTrue(out["projected"])
        self.assertEqual(out["entity_id"], "exo:EXO-CT-1")
        decl = self.store.declaration("exo:EXO-CT-1")
        self.assertEqual(decl["source"], "derived")  # 世界契约三态内的显式映射
        state = self.store.current("exo:EXO-CT-1", "exo")
        self.assertIsNotNone(state)

    def test_unmapped_prefix_skipped_counted(self):
        out = self.projector.handle(_row("AGV-001"))
        self.assertFalse(out["projected"])
        self.assertEqual(out["skipped_reason"], "no_kind")
        self.assertEqual(self.projector.health()["counters"]["skipped_no_kind"], 1)

    def test_bus_integration_auto_projection(self):
        self.projector.start()
        self.bus.publish(STREAM_TELEMETRY, _row("ENV-001", telemetry={"temperature_c": 25}))
        deadline = time.time() + 3
        while time.time() < deadline and not self.store.declaration("sensor:ENV-001"):
            time.sleep(0.05)
        decl = self.store.declaration("sensor:ENV-001")
        self.assertIsNotNone(decl)
        self.assertEqual(decl["kind"], "sensor")
        self.assertIsNotNone(self.store.current("sensor:ENV-001", "sensor"))
        self.projector.stop()


class TelemetryWorldProjectorCatalogEventTest(unittest.TestCase):
    """NO-04a：投影事实随事件骨干上行（Catalog 信封事件 + 契约校验）。"""

    def setUp(self):
        import tempfile

        from edge_platform import stubs

        self.tmp = tempfile.mkdtemp(prefix="ewoh_proj_evt_")
        self.storage = stubs.Storage(os.path.join(self.tmp, "edge.db"))
        self.store = ContractWorldStore()
        self.bus = MessageBus()
        self.published = []
        self.bus.subscribe(STREAM_EVENTS, self.published.append)
        self.projector = TelemetryWorldProjector(
            self.store,
            self.bus,
            tenant_id=TENANT,
            factory_id=FACTORY,
            kind_map=KIND_MAP,
            storage=self.storage,
        )

    def tearDown(self):
        import shutil

        self.projector.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_declaration_and_state_observation_events(self):
        out = self.projector.handle(_row("EXO-001"))
        self.assertTrue(out["projected"])
        counters = self.projector.health()["counters"]
        self.assertEqual(counters["events_emitted"], 2)
        # 落边缘事件库（可审计/可回放）
        events = self.storage.list_events(20)
        codes = {e["event_code"] for e in events}
        self.assertIn("ENTITY_DECLARED", codes)
        self.assertIn("ENTITY_STATE_OBSERVED", codes)
        # STREAM_EVENTS 发布（信封契约字段齐备）
        self.assertEqual(len(self.published), 2)
        for evt in self.published:
            env = evt["envelope"]
            self.assertEqual(env["schemaVersion"], "1.0.0")
            self.assertEqual(env["source"], "edge:world-projection")
            self.assertIn(env["eventType"], ("EntityDeclared", "EntityStateObserved"))

    def test_second_frame_no_duplicate_events(self):
        self.projector.handle(_row("EXO-001"))
        self.projector.handle(_row("EXO-001", telemetry={"battery_pct": 70}))
        counters = self.projector.health()["counters"]
        # 声明/首观测事件只发射一次；状态持续投影
        self.assertEqual(counters["events_emitted"], 2)
        self.assertEqual(counters["states_projected"], 2)


if __name__ == "__main__":
    unittest.main()
