"""工厂世界模型单元测试：状态存储 / 事件因果链 / 班次因果链 / 预测 / 回放。"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.spatial import new_id, now_iso
from edge_platform.inference import ts_to_ms, ms_to_ts
from edge_platform.world_model import (
    WorldState, StateStore,
    EventNode, EventEdge, EventGraph, build_shift_chain,
    SHIFT_CHAIN_NODE_TYPES,
    Prediction, Predictor, MODEL_VERSION,
    Replay, NODE_TYPE_LABELS,
)


def ts(minute_offset):
    """构造相对基准的 ISO 时间戳（分钟偏移）。"""
    base = ts_to_ms("2026-07-31T00:00:00.000+00:00")
    return ms_to_ts(base + int(minute_offset) * 60 * 1000)


# ---------- 状态存储 ----------
class StateStoreTest(unittest.TestCase):
    def test_set_twice_history_current_at_time(self):
        store = StateStore()
        t1 = ts(10)
        t2 = ts(20)
        s1 = store.set("P-1", "load", {"load_score": 30}, "real", 0.9, t1)
        s2 = store.set("P-1", "load", {"load_score": 70}, "real", 0.95, t2)

        # history 有 2 条
        hist = store.history("P-1", "load")
        self.assertEqual(len(hist), 2)
        self.assertEqual(hist[0], s1)
        self.assertEqual(hist[1], s2)

        # current 为第 2 条
        cur = store.current("P-1", "load")
        self.assertIs(cur, s2)
        self.assertEqual(cur.version, 2)
        self.assertIsNone(cur.valid_to)

        # 第 1 条已被关闭
        self.assertEqual(s1.valid_to, t2)
        self.assertEqual(s1.version, 1)

        # at_time 在 t1 返回第 1 条，在 t2 返回第 2 条
        self.assertIs(store.at_time("P-1", "load", t1), s1)
        self.assertIs(store.at_time("P-1", "load", t2), s2)
        # t1 与 t2 之间返回第 1 条
        self.assertIs(store.at_time("P-1", "load", ts(15)), s1)

    def test_at_time_before_first_returns_none(self):
        store = StateStore()
        store.set("D-1", "battery", {"pct": 90}, "real", 1.0, ts(10))
        self.assertIsNone(store.at_time("D-1", "battery", ts(5)))

    def test_history_time_window_filter(self):
        store = StateStore()
        store.set("P-1", "load", {"v": 1}, "real", 0.9, ts(10))
        store.set("P-1", "load", {"v": 2}, "real", 0.9, ts(20))
        store.set("P-1", "load", {"v": 3}, "real", 0.9, ts(30))
        # 只取 [ts(15), ts(25)] 相交的状态
        win = store.history("P-1", "load", ts(15), ts(25))
        self.assertEqual([s.state_json["v"] for s in win], [1, 2])

    def test_snapshot_and_roundtrip(self):
        store = StateStore()
        store.set("P-1", "position", {"zone": "A"}, "real", 0.9, ts(1))
        store.set("D-1", "battery", {"pct": 80}, "real", 1.0, ts(1))
        snap = store.snapshot()
        self.assertEqual(set(snap.keys()), {("P-1", "position"), ("D-1", "battery")})

        # to_dict / from_dict 往返
        d = store.to_dict()
        store2 = StateStore.from_dict(d)
        self.assertEqual(len(store2.history("P-1", "position")), 1)
        self.assertIsNotNone(store2.current("P-1", "position"))
        self.assertEqual(store2.current("D-1", "battery").state_json, {"pct": 80})


# ---------- 事件因果图 ----------
class EventGraphTest(unittest.TestCase):
    def _three_node_chain(self):
        g = EventGraph()
        a = g.add_node("ENTER_ZONE", {"person_id": "P-1", "zone_id": "A"}, ts(1))
        b = g.add_node("BIND_EXO", {"person_id": "P-1", "device_id": "D-1"}, ts(2))
        c = g.add_node("CLAIM_TASK", {"person_id": "P-1", "task_id": "T-1"}, ts(3))
        g.link_causal(b.node_id, a.node_id)
        g.link_causal(c.node_id, b.node_id)
        return g, a, b, c

    def test_chain_walks_root_to_leaf(self):
        g, a, b, c = self._three_node_chain()
        chain = g.chain(c.node_id)
        self.assertEqual([n.node_id for n in chain], [a.node_id, b.node_id, c.node_id])
        self.assertEqual(chain[0].node_type, "ENTER_ZONE")
        self.assertEqual(chain[-1].node_type, "CLAIM_TASK")

    def test_descendants_forward(self):
        g, a, b, c = self._three_node_chain()
        desc = g.descendants(a.node_id)
        self.assertEqual({n.node_id for n in desc}, {b.node_id, c.node_id})

    def test_find_by_type_time_window(self):
        g, a, b, c = self._three_node_chain()
        found = g.find_by_type("BIND_EXO", ts(0), ts(10))
        self.assertEqual(len(found), 1)
        self.assertIs(found[0], b)
        # 时间窗排除
        self.assertEqual(g.find_by_type("BIND_EXO", ts(0), ts(1)), [])

    def test_to_from_dict_roundtrip(self):
        g, a, b, c = self._three_node_chain()
        g2 = EventGraph.from_dict(g.to_dict())
        self.assertEqual(len(g2.all_nodes()), 3)
        self.assertEqual(len(g2.all_edges()), 2)
        chain = g2.chain(c.node_id)
        self.assertEqual([n.node_type for n in chain], ["ENTER_ZONE", "BIND_EXO", "CLAIM_TASK"])

    def test_edge_relations_supported(self):
        g = EventGraph()
        n1 = g.add_node("A", {}, ts(1))
        n2 = g.add_node("B", {}, ts(2))
        e = g.add_edge(n1.node_id, n2.node_id, "refuted")
        self.assertEqual(e.relation, "refuted")
        # refuted 不计入 descendants（仅 caused/followed）
        self.assertEqual(g.descendants(n1.node_id), [])


# ---------- 班次因果链 ----------
class ShiftChainTest(unittest.TestCase):
    def _sample_events(self):
        return [
            {"node_type": "ENTER_ZONE", "ts": ts(1), "payload": {"zone_id": "Z-A"}},
            {"node_type": "BIND_EXO", "ts": ts(2), "payload": {"device_id": "D-1"}},
            {"node_type": "CLAIM_TASK", "ts": ts(3), "payload": {"task_id": "T-1"}},
            {"node_type": "ARRIVE_STATION", "ts": ts(4), "payload": {"station_id": "S-1"}},
            {"node_type": "START_ACTION", "ts": ts(5), "payload": {"action": "搬运"}},
            {"node_type": "LOAD_RISE", "ts": ts(6), "payload": {"load_score": 85}},
            {"node_type": "BATTERY_DROP", "ts": ts(7), "payload": {"battery_pct": 18}},
            {"node_type": "STATION_BACKLOG", "ts": ts(8), "payload": {"station_id": "S-1", "backlog": 3}},
            {"node_type": "SUGGESTION", "ts": ts(9), "payload": {"suggestion": "建议 P-2 接替"}},
            {"node_type": "CONFIRM", "ts": ts(10), "payload": {"action": "confirm", "confirmed_by": "L-1"}},
            {"node_type": "REALLOCATE", "ts": ts(11), "payload": {"task_id": "T-1", "new_assignee": "P-2"}},
            {"node_type": "FEEDBACK", "ts": ts(12), "payload": {"outcome": "P-2 已接替，负荷回落"}},
        ]

    def test_full_12_step_chain_in_order(self):
        g = EventGraph()
        nodes = build_shift_chain(g, "P-1", self._sample_events())
        # 12 步且顺序与规范一致
        self.assertEqual(len(nodes), 12)
        self.assertEqual([n.node_type for n in nodes], SHIFT_CHAIN_NODE_TYPES)
        # 每个节点载荷都带 person_id
        for n in nodes:
            self.assertEqual(n.payload_json.get("person_id"), "P-1")
        # 因果链回溯：最后一个的 chain 应为根→叶 12 步
        chain = g.chain(nodes[-1].node_id)
        self.assertEqual([n.node_type for n in chain], SHIFT_CHAIN_NODE_TYPES)
        # 前向后代：根节点应有 11 个后代
        self.assertEqual(len(g.descendants(nodes[0].node_id)), 11)


# ---------- 预测 ----------
class PredictorTest(unittest.TestCase):
    def test_low_battery_high_drain_returns_prediction(self):
        p = Predictor().predict_low_battery("D-1", battery_pct=50, drain_per_min=1.0,
                                            threshold=20, horizon_min=60)
        self.assertIsNotNone(p)
        self.assertEqual(p.prediction_type, "LOW_BATTERY")
        self.assertGreater(p.probability, 0.0)
        self.assertLessEqual(p.probability, 1.0)
        self.assertGreater(p.confidence, 0.0)
        self.assertIn("battery_pct", p.assumptions)
        self.assertEqual(p.model_version, "rules-v1")

    def test_low_battery_low_drain_returns_none(self):
        p = Predictor().predict_low_battery("D-1", battery_pct=80, drain_per_min=0.05,
                                            threshold=20, horizon_min=60)
        self.assertIsNone(p)

    def test_fatigue_above_threshold(self):
        p = Predictor().predict_fatigue("P-1", current_load_score=70,
                                        load_trend_per_min=0.5, horizon_min=30)
        self.assertIsNotNone(p)
        self.assertEqual(p.prediction_type, "FATIGUE")
        # 70 + 0.5*30 = 85 > 80
        self.assertGreater(p.predicted_value["predicted_load_score"], 80)

    def test_fatigue_below_threshold_returns_none(self):
        p = Predictor().predict_fatigue("P-1", current_load_score=50,
                                        load_trend_per_min=0.1, horizon_min=30)
        # 50 + 3 = 53 < 80
        self.assertIsNone(p)

    def test_zone_congestion(self):
        p = Predictor().predict_zone_congestion("S-1", current_occupancy=8,
                                                trend=0.5, capacity=10)
        self.assertIsNotNone(p)
        self.assertEqual(p.prediction_type, "ZONE_CONGESTION")

    def test_task_delay(self):
        # 进度 10%，已耗 10 分钟，SLA 20 分钟：速率 1%/min，投影 100 分钟 > 20 → 延误
        p = Predictor().predict_task_delay("T-1", progress_pct=10, elapsed_min=10, sla_min=20)
        self.assertIsNotNone(p)
        self.assertEqual(p.prediction_type, "TASK_DELAY")

    def test_low_confidence_flagged(self):
        # 趋势为 0 且已超阈值（当前 85 > 80）→ FATIGUE 但低置信度
        p = Predictor().predict_fatigue("P-1", current_load_score=85,
                                        load_trend_per_min=0.0, horizon_min=30)
        self.assertIsNotNone(p)
        self.assertLess(p.confidence, 0.5)
        self.assertEqual(p.assumptions.get("flag"), "low_confidence")


# ---------- 回放 ----------
class ReplayTest(unittest.TestCase):
    def _setup(self):
        store = StateStore()
        store.set("P-1", "load", {"load_score": 30}, "real", 0.9, ts(1))
        store.set("P-1", "load", {"load_score": 85}, "real", 0.95, ts(6))
        store.set("D-1", "battery", {"pct": 90}, "real", 1.0, ts(1))
        store.set("D-1", "battery", {"pct": 18}, "real", 1.0, ts(7))
        g = EventGraph()
        events = [
            {"node_type": "ENTER_ZONE", "ts": ts(1), "payload": {"zone_id": "Z-A"}},
            {"node_type": "BIND_EXO", "ts": ts(2), "payload": {"device_id": "D-1"}},
            {"node_type": "CLAIM_TASK", "ts": ts(3), "payload": {"task_id": "T-1"}},
            {"node_type": "ARRIVE_STATION", "ts": ts(4), "payload": {"station_id": "S-1"}},
            {"node_type": "START_ACTION", "ts": ts(5), "payload": {"action": "搬运"}},
            {"node_type": "LOAD_RISE", "ts": ts(6), "payload": {"load_score": 85}},
            {"node_type": "BATTERY_DROP", "ts": ts(7), "payload": {"battery_pct": 18}},
            {"node_type": "STATION_BACKLOG", "ts": ts(8), "payload": {"station_id": "S-1", "backlog": 3}},
            {"node_type": "SUGGESTION", "ts": ts(9), "payload": {"suggestion": "建议 P-2 接替"}},
            {"node_type": "CONFIRM", "ts": ts(10), "payload": {"action": "confirm", "confirmed_by": "L-1"}},
            {"node_type": "REALLOCATE", "ts": ts(11), "payload": {"task_id": "T-1", "new_assignee": "P-2"}},
            {"node_type": "FEEDBACK", "ts": ts(12), "payload": {"outcome": "P-2 已接替"}},
        ]
        nodes = build_shift_chain(g, "P-1", events)
        return store, g, nodes

    def test_at_reconstructs_snapshot(self):
        store, g, nodes = self._setup()
        replay = Replay(store, g)
        snap = replay.at(ts(6))
        # 状态：P-1 在 ts(6) 的 load 应为 85（第 2 条 valid_from=ts(6)）
        self.assertEqual(snap["states"]["P-1"]["load"]["state_json"], {"load_score": 85})
        # D-1 在 ts(6) 的 battery 仍为 90（第 2 条 valid_from=ts(7)）
        self.assertEqual(snap["states"]["D-1"]["battery"]["state_json"], {"pct": 90})
        # 事件：ts(6) 及之前的事件
        self.assertGreaterEqual(len(snap["events"]), 6)
        self.assertEqual(snap["events"][-1]["node_type"], "LOAD_RISE")

    def test_compare(self):
        store, g, nodes = self._setup()
        replay = Replay(store, g)
        diff = replay.compare(ts(1), ts(6), "P-1")
        self.assertEqual(diff["before"]["load"]["state_json"], {"load_score": 30})
        self.assertEqual(diff["after"]["load"]["state_json"], {"load_score": 85})

    def test_explain_decision_non_empty_chinese(self):
        store, g, nodes = self._setup()
        replay = Replay(store, g)
        suggestion = next(n for n in nodes if n.node_type == "SUGGESTION")
        text = replay.explain_decision(suggestion.node_id)
        self.assertTrue(text)
        self.assertIn("因果链", text)
        # 引用因果链中的关键步骤
        self.assertIn("累计负荷", text)
        self.assertIn("电量", text)
        self.assertIn("积压", text)
        self.assertIn("系统生成调度建议", text)

    def test_explain_confirm_chain(self):
        store, g, nodes = self._setup()
        replay = Replay(store, g)
        confirm = next(n for n in nodes if n.node_type == "CONFIRM")
        text = replay.explain_decision(confirm.node_id)
        self.assertIn("班组长已确认", text)
        self.assertIn("系统生成调度建议", text)

    def test_shift_summary(self):
        store, g, nodes = self._setup()
        replay = Replay(store, g)
        summary = replay.shift_summary("P-1", ts(0), ts(15))
        self.assertEqual(summary["person_id"], "P-1")
        self.assertEqual(summary["action_count"], 1)
        self.assertEqual(summary["peak_load"], 85)
        self.assertEqual(summary["suggestion_count"], 1)
        self.assertEqual(summary["suggestions_confirmed"], 1)
        self.assertEqual(summary["suggestions_rejected"], 0)


if __name__ == "__main__":
    unittest.main()
