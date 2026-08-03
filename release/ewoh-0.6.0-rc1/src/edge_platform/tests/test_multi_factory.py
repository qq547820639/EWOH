"""多车间与跨工厂协同扩展单元测试（V2.0 规划级骨架）。

覆盖：FactoryNode / CrossFactoryLink / FederationPolicy 注册与查询、
validate_federation 允许/拒绝场景、export_federation_topology 导出、
CrossFactorySchedulerStub.propose_cross_factory（STUB 状态）与 validate_isolation。
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.spatial.multi_factory import (
    CrossFactoryLink,
    CrossFactorySchedulerStub,
    FactoryNode,
    FederationPolicy,
    MultiFactoryRegistry,
    new_factory_id,
    new_link_id,
    new_policy_id,
)


def _make_factory(factory_id, group_id="GRP-1", name=None, status="ACTIVE"):
    return FactoryNode(
        factory_id=factory_id,
        name=name or factory_id,
        parent_group_id=group_id,
        location={"lat": 31.23, "lng": 121.47, "address": "上海"},
        timezone="Asia/Shanghai",
        capacity={"workshops": 3, "stations": 30, "persons": 120},
        data_isolation_policy="strict",
        status=status,
    )


def _make_link(link_id, src, tgt, link_type="COLLABORATIVE_TASK"):
    return CrossFactoryLink(
        link_id=link_id,
        source_factory_id=src,
        target_factory_id=tgt,
        link_type=link_type,
        topology_ref={"type": "TOPOLOGY_JSON", "ref": "topo-1"},
        constraints={"max_payload_per_hour": 100},
    )


def _make_policy(policy_id, scope=None, consent_required=True):
    return FederationPolicy(
        policy_id=policy_id,
        name=policy_id,
        data_sharing_scope=scope if scope is not None else ["aggregated_stats", "event_summary"],
        privacy_constraints=["no_raw_personal_data"],
        consent_required=consent_required,
        audit_required=True,
        retention="aggregated-only",
    )


# ---------- 本地调度器桩 ----------
class _FakeCand:
    def __init__(self, cid):
        self.candidate_id = cid
        self.person_id = "P1"
        self.station_id = "S1"
        self.passed = True
        self.score = 0.5
        self.score_breakdown = {}
        self.explanation = "fake"


class _FakeReq:
    def __init__(self, candidates):
        self.candidates = candidates


class _FakeScheduler:
    """本地调度器桩：模拟 Scheduler.propose(task, persons, devices, ctx) 接口。"""

    def __init__(self, factory_id):
        self.factory_id = factory_id

    def propose(self, task, persons, devices, ctx=None):
        return _FakeReq([_FakeCand(f"C-{self.factory_id}-1")])


# ---------- 注册与查询 ----------
class FactoryRegistryTest(unittest.TestCase):
    def _build(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1", group_id="GRP-A", name="工厂1"))
        reg.register_factory(_make_factory("F2", group_id="GRP-A", name="工厂2"))
        reg.register_factory(_make_factory("F3", group_id="GRP-B", name="工厂3"))
        return reg

    def test_register_factory_success(self):
        reg = MultiFactoryRegistry()
        f = _make_factory("F1", name="工厂1")
        reg.register_factory(f)
        self.assertIs(reg.get_factory("F1"), f)
        # 注册即入审计日志（安全不变量 4）
        self.assertTrue(any(r["op"] == "register_factory" for r in reg.audit_log()))

    def test_get_factory_query(self):
        reg = self._build()
        self.assertEqual(reg.get_factory("F1").name, "工厂1")
        self.assertIsNone(reg.get_factory("NOPE"))

    def test_list_factories_all_and_by_group(self):
        reg = self._build()
        self.assertEqual({f.factory_id for f in reg.list_factories()}, {"F1", "F2", "F3"})
        # 按集团过滤
        self.assertEqual([f.factory_id for f in reg.list_factories("GRP-A")], ["F1", "F2"])
        self.assertEqual([f.factory_id for f in reg.list_factories("GRP-B")], ["F3"])
        self.assertEqual(reg.list_factories("GRP-Z"), [])

    def test_factory_node_roundtrip_and_defaults(self):
        f = _make_factory("F9")
        self.assertEqual(f.status, "ACTIVE")
        self.assertTrue(f.created_at)  # __post_init__ 自动填充
        d = f.to_dict()
        self.assertEqual(d["factory_id"], "F9")
        self.assertEqual(d["capacity"]["stations"], 30)
        f2 = FactoryNode.from_dict(d)
        self.assertEqual(f2.factory_id, "F9")
        self.assertEqual(f2.timezone, "Asia/Shanghai")
        self.assertEqual(f2.to_dict(), d)


class LinkRegistryTest(unittest.TestCase):
    def _build(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1"))
        reg.register_factory(_make_factory("F2"))
        reg.register_factory(_make_factory("F3"))
        reg.register_link(_make_link("L12", "F1", "F2"))
        reg.register_link(_make_link("L23", "F2", "F3", link_type="SUPPLY"))
        return reg

    def test_register_link_success(self):
        reg = self._build()
        link = reg.list_links()[0]
        self.assertIn(link.link_id, {"L12", "L23"})
        self.assertTrue(any(r["op"] == "register_link" for r in reg.audit_log()))

    def test_list_links_all_and_by_factory(self):
        reg = self._build()
        # 全部
        self.assertEqual({link.link_id for link in reg.list_links()}, {"L12", "L23"})
        # 按工厂过滤（双向匹配）
        self.assertEqual([link.link_id for link in reg.list_links("F1")], ["L12"])
        f2_links = sorted(link.link_id for link in reg.list_links("F2"))
        self.assertEqual(f2_links, ["L12", "L23"])
        self.assertEqual(reg.list_links("F9"), [])


class PolicyRegistryTest(unittest.TestCase):
    def test_register_policy_success(self):
        reg = MultiFactoryRegistry()
        p = _make_policy("P1")
        reg.register_policy(p)
        self.assertIs(reg.get_policy("P1"), p)
        self.assertIsNone(reg.get_policy("NOPE"))
        self.assertTrue(any(r["op"] == "register_policy" for r in reg.audit_log()))

    def test_policy_defaults(self):
        p = FederationPolicy(policy_id="P", name="p")
        self.assertTrue(p.consent_required)
        self.assertTrue(p.audit_required)
        self.assertEqual(p.retention, "aggregated-only")  # 安全不变量 1
        self.assertEqual(p.data_sharing_scope, [])


# ---------- 联邦校验 ----------
class ValidateFederationTest(unittest.TestCase):
    def _build(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1"))
        reg.register_factory(_make_factory("F2"))
        reg.register_link(_make_link("L12", "F1", "F2"))
        reg.register_policy(_make_policy("P1", scope=["aggregated_stats", "event_summary"]))
        return reg

    def test_validate_federation_allowed(self):
        reg = self._build()
        allowed, reason = reg.validate_federation("F1", "F2", "aggregated_stats")
        self.assertTrue(allowed)
        self.assertIn("允许共享", reason)
        # 审计记录 allowed=True
        audits = [r for r in reg.audit_log() if r["op"] == "validate_federation"]
        self.assertTrue(audits[-1]["allowed"])

    def test_validate_federation_denied_no_link(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1"))
        reg.register_factory(_make_factory("F3"))  # F1 与 F3 间无链接
        reg.register_policy(_make_policy("P1", scope=["aggregated_stats"]))
        allowed, reason = reg.validate_federation("F1", "F3", "aggregated_stats")
        self.assertFalse(allowed)
        self.assertIn("链接", reason)

    def test_validate_federation_denied_policy_not_allow(self):
        reg = self._build()
        # data_class 不在策略 scope 内 → 拒绝（安全不变量 2）
        allowed, reason = reg.validate_federation("F1", "F2", "raw_personal_data")
        self.assertFalse(allowed)
        self.assertIn("策略", reason)

    def test_validate_federation_denied_factory_missing(self):
        reg = self._build()
        allowed, reason = reg.validate_federation("F1", "MISSING", "aggregated_stats")
        self.assertFalse(allowed)
        self.assertIn("工厂不存在", reason)


# ---------- 拓扑导出 ----------
class ExportTopologyTest(unittest.TestCase):
    def test_export_federation_topology_complete(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1"))
        reg.register_factory(_make_factory("F2"))
        reg.register_link(_make_link("L12", "F1", "F2"))
        reg.register_policy(_make_policy("P1"))
        topo = reg.export_federation_topology()
        self.assertEqual(len(topo["factories"]), 2)
        self.assertEqual(len(topo["links"]), 1)
        self.assertEqual(len(topo["policies"]), 1)
        self.assertTrue(topo["exported_at"])
        # 不变量随拓扑导出
        inv = topo["invariants"]
        self.assertEqual(inv["retention"], "aggregated-only")
        self.assertFalse(inv["auto_execute"])  # 安全不变量 3
        self.assertTrue(inv["consent_required_default"])
        self.assertTrue(inv["audit_required_default"])
        # 工厂/链接/策略字段齐全
        self.assertEqual(topo["factories"][0]["factory_id"], "F1")
        self.assertEqual(topo["links"][0]["link_type"], "COLLABORATIVE_TASK")
        self.assertEqual(topo["policies"][0]["policy_id"], "P1")


# ---------- 跨工厂调度 stub ----------
class CrossFactorySchedulerStubTest(unittest.TestCase):
    def _build(self):
        reg = MultiFactoryRegistry()
        reg.register_factory(_make_factory("F1"))
        reg.register_factory(_make_factory("F2"))
        # F3 处于维护态，不应参与
        reg.register_factory(_make_factory("F3", status="MAINTENANCE"))
        reg.register_link(_make_link("L12", "F1", "F2"))
        schedulers = {
            "F1": _FakeScheduler("F1"),
            "F2": _FakeScheduler("F2"),
            "F3": _FakeScheduler("F3"),
            "F9": _FakeScheduler("F9"),  # 未注册工厂
        }
        return reg, CrossFactorySchedulerStub(reg, schedulers)

    def test_propose_cross_factory_returns_stub_status(self):
        reg, stub = self._build()
        task = {"task_id": "T1", "type": "assembly"}
        ctx = {"persons": [], "devices": []}
        results = stub.propose_cross_factory(task, ["F1", "F2", "F3", "F9"], ctx)
        # F1、F2 参与；F3 维护态、F9 未注册 → 仅 F1/F2 各 1 条
        factory_ids = sorted(r["factory_id"] for r in results)
        self.assertEqual(factory_ids, ["F1", "F2"])
        for r in results:
            self.assertTrue(r["cross_factory"])
            self.assertEqual(r["status"], "STUB")  # V2.0 未实现完整逻辑
            self.assertTrue(r["candidate_id"])
        # 审计记录
        self.assertTrue(any(r["op"] == "propose_cross_factory" for r in stub.audit_log()))

    def test_validate_isolation_ok(self):
        reg, stub = self._build()
        reg.register_policy(_make_policy("P1", scope=["aggregated_stats"]))
        plan = {"factories": ["F1", "F2"], "data_classes": ["aggregated_stats"]}
        ok, violations = stub.validate_isolation(plan)
        self.assertTrue(ok)
        self.assertEqual(violations, [])

    def test_validate_isolation_violations(self):
        reg, stub = self._build()
        # 无策略覆盖 raw_personal_data → 违反隔离
        plan = {"factories": ["F1", "F2"], "data_classes": ["raw_personal_data"]}
        ok, violations = stub.validate_isolation(plan)
        self.assertFalse(ok)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["factory_a"], "F1")
        self.assertEqual(violations[0]["factory_b"], "F2")
        self.assertEqual(violations[0]["data_class"], "raw_personal_data")


# ---------- ID 生成 ----------
class IdGenTest(unittest.TestCase):
    def test_new_ids(self):
        fid = new_factory_id()
        self.assertTrue(fid.startswith("FAC-"))
        self.assertEqual(len(fid), len("FAC-") + 12)
        lid = new_link_id("CFL")
        self.assertTrue(lid.startswith("CFL-"))
        pid = new_policy_id("FED")
        self.assertTrue(pid.startswith("FED-"))


if __name__ == "__main__":
    unittest.main()
