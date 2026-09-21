"""ContractWorldStore 契约行为测试（ADR-008 / ADR-015 / NO-03b）。

覆盖：真实装配产出 world_store 组件；set_state 契约校验 fail-closed
（非规范身份/未知实体类型/越界置信度/未知来源类型拒绝）；双时态关闭 +
版本递增；snapshot() 契约形状 + 来源画像 + 整体自检；实体声明登记
（kind 前缀一致性 / 不可变字段 / 版本单调 / 来源不可回改 / 时间不回拨 /
声明-状态交叉校验 / 持久化恢复）。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "src"))

from edge_platform.runtime.bootstrap import RuntimeFactory
from edge_platform.world_model.contract_store import ContractWorldStore, WorldStoreContractError


class TestContractWorldStoreAssembly(unittest.TestCase):
    def test_real_assembly_includes_contract_world_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            comps = RuntimeFactory(db_path=os.path.join(tmp, "edge.db")).assemble("development")
            self.assertIsInstance(comps.world_store, ContractWorldStore)
            self.assertIs(comps.real_components["world_store"], comps.world_store)


class TestContractWorldStore(unittest.TestCase):
    def setUp(self):
        self.store = ContractWorldStore()
        self.person_id = "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"
        self.factory_id = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"

    def _person_declaration(self, version=1, valid_from="2026-08-16T08:00:00Z", **overrides):
        decl = {
            "entityId": self.person_id,
            "kind": "person",
            "tenantId": "org-1",
            "factoryId": self.factory_id,
            "timeSemantics": {"validFrom": valid_from, "validTo": None},
            "status": "active",
            "source": "real",
            "version": version,
        }
        decl.update(overrides)
        return decl

    def test_set_state_valid_and_version_monotonic(self):
        s1 = self.store.set_state(self.person_id, "person", {"zone": "Z1"}, "real", 1.0)
        s2 = self.store.set_state(self.person_id, "person", {"zone": "Z2"}, "real", 0.9)
        self.assertEqual(s1.version, 1)
        self.assertEqual(s2.version, 2)
        # 双时态关闭：旧状态 valid_to = 新状态 valid_from
        self.assertEqual(s1.valid_to, s2.valid_from)

    def test_non_canonical_entity_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state("p1", "person", {}, "real", 1.0)
        self.assertEqual(cm.exception.code, "bad_entity_id")

    def test_unknown_entity_type_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state(self.person_id, "maintenance_condition", {}, "real", 1.0)
        self.assertEqual(cm.exception.code, "unknown_entity_type")

    def test_confidence_out_of_range_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state(self.person_id, "person", {}, "real", 1.5)
        self.assertEqual(cm.exception.code, "bad_confidence")

    def test_unknown_source_type_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state(self.person_id, "person", {}, "replay", 1.0)
        self.assertEqual(cm.exception.code, "unknown_source_type")

    def test_snapshot_contract_shape_and_profile(self):
        self.store.set_state(self.person_id, "person", {"zone": "Z1"}, "real", 1.0)
        self.store.set_state("exo:NY-A1-SN-0007", "exo", {"battery": 80}, "simulated", 0.9)
        snap = self.store.snapshot()
        self.assertIn("snapshotId", snap)
        self.assertIn("entityVersions", snap)
        self.assertEqual(snap["entityVersions"][self.person_id], 1)
        # worldVersion = 全键最大版本（person/exo 各自版本 1）
        self.assertEqual(snap["worldVersion"], 1)
        # 混合来源快照：非 simulatedOnly，含 real（§13 模拟隔离的可执行面）
        self.assertEqual(snap["sourceProfile"], {"simulatedOnly": False, "hasReal": True})

    def test_history_and_at_time(self):
        _s1 = self.store.set_state(self.person_id, "person", {"zone": "Z1"}, "real", 1.0)
        s2 = self.store.set_state(self.person_id, "person", {"zone": "Z2"}, "real", 1.0)
        history = self.store.history(self.person_id, "person")
        self.assertEqual(len(history), 2)
        at = self.store.at_time(self.person_id, "person", s2.valid_from)
        self.assertEqual(at.version, 2)


class TestContractWorldStoreEntityDeclarations(unittest.TestCase):
    """ADR-015 / NO-03b：实体声明契约校验 + 声明/状态交叉校验 + 持久化。"""

    def setUp(self):
        self.store = ContractWorldStore()
        self.person_id = "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"
        self.factory_id = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"

    def _declaration(self, entity_id, kind, version=1, valid_from="2026-08-16T08:00:00Z", **overrides):
        decl = {
            "entityId": entity_id,
            "kind": kind,
            "tenantId": "org-1",
            "factoryId": self.factory_id,
            "timeSemantics": {"validFrom": valid_from, "validTo": None},
            "status": "active",
            "source": "real",
            "version": version,
        }
        decl.update(overrides)
        return decl

    def test_declare_valid_and_roundtrip(self):
        decl = self.store.declare_entity(self._declaration(self.person_id, "person"))
        self.assertEqual(self.store.declaration(self.person_id)["kind"], "person")
        self.assertEqual(len(self.store.declarations()), 1)
        # 持久化恢复：声明与状态整体重建
        self.store.set_state(self.person_id, "person", {"zone": "Z1"}, "real", 1.0)
        restored = ContractWorldStore.from_dict(self.store.to_dict())
        self.assertEqual(restored.declaration(self.person_id)["version"], 1)
        self.assertEqual(restored.current(self.person_id, "person").version, 1)
        self.assertEqual(decl["timeSemantics"]["validFrom"], "2026-08-16T08:00:00Z")

    def test_kind_prefix_mismatch_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(self._declaration(self.person_id, "station"))
        self.assertEqual(cm.exception.code, "kind_prefix_mismatch")

    def test_identity_only_prefix_rejected(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(
                self._declaration("device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "machine")
            )
        self.assertEqual(cm.exception.code, "kind_prefix_unknown")

    def test_redeclaration_immutability(self):
        self.store.declare_entity(self._declaration(self.person_id, "person"))
        # 重复声明：版本递增 + 时间不回拨 + kind/tenant/factory/source 不可变
        ok = self.store.declare_entity(
            self._declaration(self.person_id, "person", version=2, valid_from="2026-08-16T09:00:00Z")
        )
        self.assertEqual(ok["version"], 2)
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(
                self._declaration(self.person_id, "person", version=3, factoryId="factory:OTHER")
            )
        self.assertEqual(cm.exception.code, "declaration_immutable")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(
                self._declaration(self.person_id, "person", version=3, source="simulated")
            )
        self.assertEqual(cm.exception.code, "source_change_rejected")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(self._declaration(self.person_id, "person", version=2))
        self.assertEqual(cm.exception.code, "declaration_version_not_increasing")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.declare_entity(
                self._declaration(
                    self.person_id, "person", version=3, valid_from="2026-08-16T07:00:00Z"
                )
            )
        self.assertEqual(cm.exception.code, "declaration_time_regression")

    def test_declared_state_cross_checks(self):
        # 声明型实体（无状态投影）不得写状态
        self.store.declare_entity(
            self._declaration("skill:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "skill")
        )
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state("skill:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11", "skill", {}, "real", 1.0)
        self.assertEqual(cm.exception.code, "entity_not_state_projectable")
        # 状态可投影实体：entityType 必须等于声明 kind；状态生效时间不得早于声明
        self.store.declare_entity(self._declaration(self.person_id, "person"))
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state(self.person_id, "exo", {}, "real", 1.0)
        self.assertEqual(cm.exception.code, "entity_type_mismatch")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.set_state(
                self.person_id, "person", {}, "real", 1.0, ts="2026-08-16T07:00:00Z"
            )
        self.assertEqual(cm.exception.code, "state_precedes_declaration")
        # 合法写入：声明后状态正常入账
        s = self.store.set_state(self.person_id, "person", {"zone": "Z1"}, "real", 1.0)
        self.assertEqual(s.version, 1)


class TestContractWorldStoreEventReplayPrediction(unittest.TestCase):
    """NO-03b：因果事件登记 + 时间轴回放 + 短期预测（生产调用链能力）。"""

    def setUp(self):
        self.store = ContractWorldStore()
        self.person_id = "person:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"
        self.exo_id = "exo:NY-A1-SN-0007"
        self.factory_id = "factory:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11"

    def _declare_person(self):
        self.store.declare_entity(
            {
                "entityId": self.person_id,
                "kind": "person",
                "tenantId": "org-1",
                "factoryId": self.factory_id,
                "timeSemantics": {"validFrom": "2026-08-16T08:00:00Z", "validTo": None},
                "status": "active",
                "source": "real",
                "version": 1,
            }
        )

    def test_record_event_canonical_and_chain(self):
        a = self.store.record_event(
            self.person_id, "ENTER_ZONE", {"zone_id": "zone:Z-A"}, ts="2026-08-16T08:05:00Z"
        )
        b = self.store.record_event(
            self.person_id,
            "BIND_EXO",
            {"device_id": self.exo_id},
            ts="2026-08-16T08:06:00Z",
            parent_id=a.node_id,
        )
        self.assertIn("entity_id", b.payload_json)
        self.assertEqual(b.payload_json["entity_id"], self.person_id)
        chain = self.store.event_graph().chain(b.node_id)
        self.assertEqual([n.node_id for n in chain], [a.node_id, b.node_id])

    def test_record_event_refs_fail_closed(self):
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.record_event("P-1", "ENTER_ZONE", {})
        self.assertEqual(cm.exception.code, "bad_event_entity_ref")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.record_event(self.person_id, "BIND_EXO", {"device_id": "D-1"})
        self.assertEqual(cm.exception.code, "bad_entity_ref:device_id")
        with self.assertRaises(WorldStoreContractError) as cm:
            self.store.record_event(
                self.person_id, "CLAIM_TASK", {}, parent_id="EV-MISSING"
            )
        self.assertEqual(cm.exception.code, "unknown_event_parent")

    def test_replay_merges_states_and_events(self):
        self._declare_person()
        self.store.set_state(
            self.person_id, "person", {"zone": "Z1"}, "real", 1.0, ts="2026-08-16T08:05:00Z"
        )
        self.store.record_event(
            self.person_id, "ENTER_ZONE", {"zone_id": "zone:Z-A"}, ts="2026-08-16T08:05:00Z"
        )
        out = self.store.replay("2026-08-16T08:10:00Z")
        self.assertIn(self.person_id, out["states"])
        self.assertEqual(out["events"][0]["node_type"], "ENTER_ZONE")

    def test_predict_dispatch_and_fail_closed(self):
        pred = self.store.predict(
            "fatigue",
            {"personId": self.person_id, "currentLoadScore": 85, "loadTrendPerMin": 0.0},
        )
        self.assertIsNotNone(pred)
        self.assertEqual(pred.prediction_type, "FATIGUE")
        self.assertEqual(pred.target_entity_id, self.person_id)
        # 未触发阈值 → None（无预测不是错误）
        none_pred = self.store.predict(
            "low_battery",
            {"deviceId": self.exo_id, "batteryPct": 80, "drainPerMin": 0.01},
        )
        self.assertIsNone(none_pred)
        with self.assertRaises(ValueError):
            self.store.predict("gizmo", {})
        with self.assertRaises(KeyError):
            self.store.predict("fatigue", {"personId": self.person_id})
        # 目标实体非规范身份 fail-closed
        with self.assertRaises(ValueError):
            self.store.predict(
                "fatigue",
                {"personId": "P-1", "currentLoadScore": 85, "loadTrendPerMin": 0.0},
            )

    def test_persistence_roundtrip_with_events(self):
        self._declare_person()
        self.store.set_state(
            self.person_id, "person", {"zone": "Z1"}, "real", 1.0, ts="2026-08-16T08:05:00Z"
        )
        self.store.record_event(
            self.person_id, "ENTER_ZONE", {"zone_id": "zone:Z-A"}, ts="2026-08-16T08:05:00Z"
        )
        first_snapshot = self.store.snapshot()
        snapshot = self.store.to_dict()
        restored = ContractWorldStore.from_dict(snapshot)
        self.assertEqual(restored.current(self.person_id, "person").version, 1)
        self.assertEqual(len(restored.event_graph().all_nodes()), 1)
        self.assertIn(self.person_id, restored.replay("2026-08-16T08:10:00Z")["states"])
        # 快照序号必须跨离线重启保持单调，否则旧重启后的快照会被误判为新。
        restored_snapshot = restored.snapshot()
        self.assertEqual(
            int(restored_snapshot["snapshotVersion"]),
            int(first_snapshot["snapshotVersion"]) + 1,
        )

    def test_persistence_rejects_invalid_restored_state(self):
        self._declare_person()
        snapshot = self.store.to_dict()
        snapshot["store"]["states"].append(
            {
                "state_id": "STS-BAD",
                "entity_id": "P-1",
                "state_type": "person",
                "state_json": {"zone": "Z1"},
                "valid_from": "2026-08-16T08:06:00Z",
                "valid_to": None,
                "source_type": "real",
                "confidence": 1.0,
                "version": 1,
            }
        )
        with self.assertRaises(WorldStoreContractError) as cm:
            ContractWorldStore.from_dict(snapshot)
        self.assertEqual(cm.exception.code, "bad_entity_id")


if __name__ == "__main__":
    unittest.main()
