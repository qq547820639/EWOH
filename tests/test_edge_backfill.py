"""Sequence buffer contract tests for out-of-order/backfill (Y3-06)."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.edge.backfill import SequenceBuffer  # noqa: E402


class TestSequenceBuffer(unittest.TestCase):
    def test_in_order_frames_release_contiguously(self):
        buffer = SequenceBuffer()
        for seq in (1, 2, 3):
            self.assertTrue(buffer.push({"seq": seq, "value": seq})[0])
        released = buffer.ready()
        self.assertEqual([frame["seq"] for frame in released], [1, 2, 3])
        self.assertEqual(buffer.next_expected, 4)

    def test_out_of_order_frames_release_in_order(self):
        buffer = SequenceBuffer()
        for seq in (2, 1, 3):
            buffer.push({"seq": seq, "value": seq})
        released = buffer.ready()
        self.assertEqual([frame["seq"] for frame in released], [1, 2, 3])

    def test_duplicate_frames_are_rejected(self):
        buffer = SequenceBuffer()
        buffer.push({"seq": 1, "value": "one"})
        self.assertTrue(buffer.push({"seq": 2, "value": "a"})[0])
        accepted, reason = buffer.push({"seq": 2, "value": "b"})
        self.assertFalse(accepted)
        self.assertEqual(reason, "duplicate")
        self.assertEqual(
            [frame["seq"] for frame in buffer.ready()],
            [1, 2],
        )

    def test_gap_detection_and_backfill(self):
        buffer = SequenceBuffer()
        buffer.push({"seq": 1, "value": "one"})
        buffer.push({"seq": 3, "value": "three"})
        self.assertEqual(buffer.ready()[0]["seq"], 1)
        self.assertTrue(buffer.has_gap())
        self.assertEqual(buffer.missing(), [2])
        buffer.push({"seq": 2, "value": "two"})
        released = buffer.ready()
        self.assertEqual([frame["seq"] for frame in released], [2, 3])
        self.assertFalse(buffer.has_gap())

    def test_stale_and_out_of_window_frames_are_rejected(self):
        buffer = SequenceBuffer(next_expected=5, window_size=10)
        accepted, reason = buffer.push({"seq": 4, "value": "old"})
        self.assertFalse(accepted)
        self.assertEqual(reason, "duplicate_or_stale")
        accepted, reason = buffer.push({"seq": 20, "value": "far"})
        self.assertFalse(accepted)
        self.assertEqual(reason, "out_of_window")


if __name__ == "__main__":
    unittest.main()
