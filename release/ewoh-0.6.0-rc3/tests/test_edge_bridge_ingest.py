"""Edge bridge and ingestion protocol contract tests.

Verifies that the edge-side bridge emits UnifiedExoFrame's canonical storage
shape and that the bridge batch buffer keeps frames on failure and drains
them on success. HTTP behavior is covered by the NestJS E2E suite.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.edge.bridge.edge_to_spark import (  # noqa: E402
    SimulatedExoSource,
    SparkBridge,
)


class TestSimulatedExoSourceCanonical(unittest.TestCase):
    def test_frame_uses_canonical_unified_frame_shape(self):
        source = SimulatedExoSource(
            device_id="EXO-SIM-CANON",
            worker_id="P-SIM-CANON",
            interval_ms=10,
        )
        frame = source._gen_frame()
        self.assertEqual(frame["entity_id"], "EXO-SIM-CANON")
        self.assertEqual(frame["device_id"], "EXO-SIM-CANON")
        self.assertEqual(frame["source_type"], "simulated")
        self.assertIn("pose", frame)
        self.assertIn("trunk_pitch_deg", frame["pose"])
        self.assertIn("joint_angles_deg", frame["pose"])
        self.assertIn("load", frame)
        self.assertIn("assist_level", frame["load"])
        self.assertIn("cumulative_load_score", frame["load"])
        self.assertIn("device", frame)
        self.assertIn("battery_pct", frame["device"])
        self.assertIn("quality", frame)
        self.assertIn("status", frame["quality"])
        self.assertGreaterEqual(frame["load"]["cumulative_load_score"], 0)
        self.assertLessEqual(frame["load"]["cumulative_load_score"], 1)

    def test_frame_keeps_legacy_flat_aliases(self):
        source = SimulatedExoSource(interval_ms=10)
        frame = source._gen_frame()
        self.assertEqual(frame["pitch_deg"], frame["pose"]["trunk_pitch_deg"])
        self.assertEqual(frame["load_score"], frame["load"]["cumulative_load_score"])
        self.assertEqual(frame["battery_pct"], frame["device"]["battery_pct"])


class _FakeSource:
    def __init__(self, frames):
        self.frames = list(frames)
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def read(self, timeout=1.0):
        return self.frames.pop(0) if self.frames else None


class TestSparkBridgeBuffer(unittest.TestCase):
    def test_successful_batch_drains_buffer(self):
        bridge = SparkBridge("http://localhost:3000", source=None)
        bridge._buffer = [{"n": 1}, {"n": 2}]
        seen = []
        bridge._post_batch = lambda batch: (seen.append(len(batch)) or True)
        bridge._flush_batch()
        self.assertEqual(seen, [2])
        self.assertEqual(bridge._buffer, [])

    def test_failed_batch_keeps_buffer(self):
        bridge = SparkBridge("http://localhost:3000", source=None)
        bridge._buffer = [{"n": 1}]
        bridge._backoff = lambda: None
        bridge._post_batch = lambda batch: False
        bridge._flush_batch()
        self.assertEqual(len(bridge._buffer), 1)
        self.assertGreaterEqual(bridge._consecutive_failures, 1)

    def test_run_sends_batches_and_stops_source(self):
        frames = [{"n": 1}, {"n": 2}, {"n": 3}]
        source = _FakeSource(frames)
        bridge = SparkBridge("http://localhost:3000", source=source)
        sent = []
        bridge._post_batch = lambda batch: (sent.append(len(batch)) or True)
        bridge._running = True
        original_flush = bridge._flush_batch

        def bounded_flush():
            original_flush()
            if not bridge._buffer and not source.frames:
                bridge._running = False

        bridge._flush_batch = bounded_flush
        bridge.run()
        self.assertTrue(source.started)
        self.assertTrue(source.stopped)
        self.assertEqual(sum(sent), 3)

    def test_batch_request_forwards_org_id_header(self):
        class _Response:
            status = 201

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        bridge = SparkBridge(
            "http://localhost:3000",
            ingest_key="key",
            org_id="org-1",
        )
        with mock.patch("urllib.request.urlopen", return_value=_Response()) as urlopen:
            ok = bridge._post_batch([{"n": 1}])
        self.assertTrue(ok)
        request = urlopen.call_args[0][0]
        headers = {
            str(key).lower(): str(value)
            for key, value in request.headers.items()
        }
        self.assertEqual(headers["x-ingest-key"], "key")
        self.assertEqual(headers["x-org-id"], "org-1")


if __name__ == "__main__":
    unittest.main()
