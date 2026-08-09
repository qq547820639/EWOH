"""A3 回归测试：services.recommend 消除 person_metrics 的 N+1 事件查询。

背景：person_metrics 每次调用都 list_events(200)，recommend 对每个候选人员
循环调用 → N 次重复查询。修复后 recommend 在循环前一次性查询并传入
events_cache，list_events 只调用一次。

纯 Python 标准库 unittest；运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_services_recommend -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.services import person_metrics, recommend  # noqa: E402


class _CountingStorage:
    """记录 list_events 调用次数的 Fake Storage（推荐链路所需最小契约）。"""

    def __init__(self, people, devices, events):
        self._people = people
        self._devices = devices
        self._events = events
        self.list_events_calls = 0
        self.telemetry = {}

    def list_people(self):
        return list(self._people)

    def list_devices(self):
        return list(self._devices)

    def list_events(self, limit=200):
        self.list_events_calls += 1
        return list(self._events)[-limit:]

    def latest_telemetry(self, device_id):
        return self.telemetry.get(device_id)

    def query_telemetry(self, device_id, start, end, limit=1000):
        return []


def _person(pid, team, skills, consent="granted", active=1):
    return {
        "person_id": pid,
        "display_name": f"人员{pid}",
        "team": team,
        "skills": list(skills),
        "consent_status": consent,
        "active": active,
    }


def _event(eid, person_id, status, severity="L1"):
    return {
        "event_id": eid,
        "person_id": person_id,
        "status": status,
        "severity": severity,
        "start_time": "2026-08-07T00:00:00+00:00",
        "trigger": {},
        "evidence": {},
        "handling": {},
    }


class RecommendEventsCacheTest(unittest.TestCase):
    def setUp(self):
        self.people = [
            _person("P1", "月台A", ["搬运"]),
            _person("P2", "月台B", ["搬运"]),
            _person("P3", "月台A", ["装配"]),
        ]
        self.devices = [
            {"device_id": "D1", "person_id": "P1", "source_type": "real"},
            {"device_id": "D2", "person_id": "P2", "source_type": "real"},
        ]
        self.events = [
            _event("EVT-1", "P1", "open", severity="L2"),
            _event("EVT-2", "P1", "open", severity="L1"),
            _event("EVT-3", "P2", "open", severity="L1"),
            _event("EVT-4", "P3", "closed", severity="L2"),
        ]

    def test_recommend_queries_events_once(self):
        """3 个候选人员：list_events 只调用 1 次（修复前为 3 次）。"""
        storage = _CountingStorage(self.people, self.devices, self.events)
        res = recommend(storage, [], {"required_skill": "搬运", "zone_id": "月台A"}, lambda d: True)
        self.assertEqual(storage.list_events_calls, 1, "recommend 必须只查询一次事件列表（消除 N+1）")
        self.assertEqual(len(res["items"]), 3)

    def test_metrics_filter_open_events_per_person(self):
        """events_cache 按 person_id+open 过滤正确；closed 事件不计入风险。"""
        storage = _CountingStorage(self.people, self.devices, self.events)
        res = recommend(storage, [], {"required_skill": "搬运", "zone_id": "月台A"}, lambda d: True)
        by_person = {item["person_id"]: item for item in res["items"]}
        # P1：2 条 open（含 1 条 L2）
        self.assertEqual(by_person["P1"]["metrics"]["open_events"], 2)
        self.assertEqual(by_person["P1"]["metrics"]["open_high_events"], 1)
        self.assertGreater(by_person["P1"]["metrics"]["risk_recent"], 0)
        # P3：1 条 closed L2 → 不计入 open
        self.assertEqual(by_person["P3"]["metrics"]["open_events"], 0)
        self.assertEqual(by_person["P3"]["metrics"]["open_high_events"], 0)

    def test_person_metrics_accepts_external_cache(self):
        """person_metrics 显式传入 events_cache 时不触发 storage.list_events。"""
        storage = _CountingStorage(self.people, self.devices, self.events)
        cache = [dict(e) for e in self.events]
        m = person_metrics(storage, self.people[0], self.devices[0], events_cache=cache)
        self.assertEqual(storage.list_events_calls, 0, "传入 events_cache 后不应再查库")
        self.assertEqual(m["open_events"], 2)
        # 不传 cache → 回退到 storage.list_events（向后兼容单次调用）
        m2 = person_metrics(storage, self.people[0], self.devices[0])
        self.assertEqual(storage.list_events_calls, 1)
        self.assertEqual(m2["open_events"], 2)


if __name__ == "__main__":
    unittest.main()
