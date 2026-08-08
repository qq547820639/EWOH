"""P0-EDGE-003/004/005：EventBus 契约 / StreamName / Subscriber 异常可观测测试。

覆盖：
- 唯一正式契约：subscribe(stream, handler) -> sub_id / publish / unsubscribe；
- 生产使用的全部 StreamName 都登记在 ALL_STREAMS 并被 MessageBus 支持；
- subscriber 异常不再静默：计数器递增、其他 handler 与总线不受影响；
- stubs.Bus 与真实 MessageBus 契约一致（防止测试/生产行为分裂）。
"""

import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.edge.bus import MessageBus  # noqa: E402
from edge_platform.runtime.protocols import ALL_STREAMS, STREAM_EVENTS, STREAM_INFERENCE  # noqa: E402


class EventBusContractTest(unittest.TestCase):
    def test_handler_subscribe_contract(self):
        bus = MessageBus()
        received = []
        sub_id = bus.subscribe(STREAM_EVENTS, lambda m: received.append(m["seq"]))
        self.assertIsInstance(sub_id, str)
        bus.publish(STREAM_EVENTS, {"seq": 1, "ts": "2026-08-08T00:00:00.000+00:00"})
        self.assertEqual(received, [1])
        self.assertTrue(bus.unsubscribe(STREAM_EVENTS, sub_id))
        bus.publish(STREAM_EVENTS, {"seq": 2, "ts": "2026-08-08T00:00:00.000+00:00"})
        self.assertEqual(received, [1])

    def test_all_production_streams_are_supported(self):
        """P0-EDGE-004：生产使用的所有 stream 必须被 MessageBus 支持。"""
        bus = MessageBus()
        for stream in ALL_STREAMS:
            with self.subTest(stream=stream):
                sub_id = bus.subscribe(stream, lambda m: None)
                bus.publish(stream, {"ts": "2026-08-08T00:00:00.000+00:00"})
                bus.unsubscribe(stream, sub_id)
                # tail 不抛错
                bus.tail(stream, 1)

    def test_undefined_stream_rejected(self):
        bus = MessageBus()
        with self.assertRaises(ValueError):
            bus.publish("not-a-real-stream", {"ts": "x"})

    def test_inference_stream_defined(self):
        self.assertIn(STREAM_INFERENCE, ALL_STREAMS)
        self.assertIn(STREAM_EVENTS, ALL_STREAMS)

    def test_subscriber_exception_is_observed_not_silent(self):
        """P0-EDGE-005：handler 异常必须可观测（计数器 + 日志），且不击穿总线。"""
        bus = MessageBus()

        def bad(_):
            raise RuntimeError("boom")

        good = []
        bus.subscribe(STREAM_EVENTS, bad)
        bus.subscribe(STREAM_EVENTS, lambda m: good.append(m["seq"]))
        bus.publish(STREAM_EVENTS, {"seq": 1, "ts": "2026-08-08T00:00:00.000+00:00"})
        self.assertEqual(good, [1])
        self.assertGreaterEqual(bus.handler_errors_total, 1)
        # 总线仍可用
        bus.publish(STREAM_EVENTS, {"seq": 2, "ts": "2026-08-08T00:00:00.000+00:00"})
        self.assertEqual(good, [1, 2])

    def test_stub_bus_same_contract_as_real(self):
        """stubs.Bus 与真实 MessageBus 必须同一契约（handler 回调）。"""
        from edge_platform import stubs

        real = MessageBus()
        stub = stubs.Bus()
        for bus in (real, stub):
            with self.subTest(bus=type(bus).__name__):
                got = []
                sub_id = bus.subscribe(STREAM_EVENTS, lambda m: got.append(m["seq"]))
                self.assertIsInstance(sub_id, str)
                bus.publish(STREAM_EVENTS, {"seq": 1, "ts": "2026-08-08T00:00:00.000+00:00"})
                self.assertEqual(got, [1])
                self.assertTrue(bus.unsubscribe(STREAM_EVENTS, sub_id))


if __name__ == "__main__":
    unittest.main()
