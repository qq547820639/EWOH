"""Event Envelope 接线测试（ADR-009 / NO-04b，边缘侧）。

EventEngine 开事件时产出信封形状（occurred/observed/received + schemaVersion +
source + 目录 eventType），并可通过契约模块校验。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "src"))

from edge_platform.contracts import envelope as env_contract
from edge_platform.inference.events import EVENT_CODE_CATALOG_TYPE, EventEngine

# 事件目录中本接线涉及的类型（静态声明；门禁 audit-event-envelope 对目录全量交叉校验）。
CATALOG_TYPES = frozenset(
    {
        "DeviceLowBattery",
        "WorkerHighLoad",
        "WorkerPostureRisk",
        "DeviceOffline",
        "DataDegraded",
        "DataQualityAlert",
    }
)


class FakeStorage:
    def __init__(self):
        self.events = []

    def insert_event(self, evt):
        self.events.append(evt)

    def list_events(self, limit=200):
        return self.events[-limit:]

    def query_telemetry(self, device_id, start_ms, end_ms, limit=5000):
        return []


class FakeBus:
    def __init__(self):
        self.published = []

    def publish(self, stream, payload):
        self.published.append((stream, payload))


class TestEventEngineEnvelope(unittest.TestCase):
    def test_open_event_carries_envelope(self):
        storage = FakeStorage()
        bus = FakeBus()
        engine = EventEngine(storage, bus, window_sec=30)
        from datetime import datetime, timezone

        recent = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        evt = engine.handle_draft(
            {
                "start_time": recent,
                "event_code": "LOW_BATTERY",
                "severity": "L1",
                "device_id": "EXO-1",
                "trigger": {"rule_version": "risk-rule-v0.2"},
                "source_type": "real",
            }
        )
        self.assertIsNotNone(evt)
        envelope = evt["envelope"]
        self.assertEqual(envelope["eventId"], evt["event_id"])
        self.assertEqual(envelope["eventType"], "DeviceLowBattery")
        self.assertEqual(envelope["schemaVersion"], "1.0.0")
        self.assertEqual(envelope["occurredAt"], recent)
        self.assertEqual(envelope["source"], "edge:rule-engine")
        self.assertIsNotNone(envelope["observedAt"])
        self.assertIsNotNone(envelope["receivedAt"])
        # 契约校验（目录类型静态子集）
        errors = env_contract.validate_envelope(envelope, CATALOG_TYPES)
        self.assertEqual(errors, [], errors)
        semantics = env_contract.envelope_semantics(envelope)
        self.assertFalse(semantics["clockDrift"])
        self.assertFalse(semantics["isLate"])

    def test_event_code_catalog_mapping_complete(self):
        for code in ("LOW_BATTERY", "LOAD_CONTINUOUS", "POSTURE_BEND_LONG", "DEVICE_OFFLINE", "DATA_DEGRADED"):
            self.assertIn(EVENT_CODE_CATALOG_TYPE[code], CATALOG_TYPES)


if __name__ == "__main__":
    unittest.main()
