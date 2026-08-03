"""Edge sequence buffer for out-of-order, duplicate, and backfill handling.

Final 5.0 Y3-06: connectors and edge bridges must survive network loss,
out-of-order delivery, duplicates, and late backfill without corrupting the
canonical telemetry order. This module keeps a small in-memory sequence window
and releases frames only in contiguous order.
"""

from __future__ import annotations

from typing import Any


class SequenceBuffer:
    """Reorder and de-duplicate frames by an integer sequence number."""

    def __init__(self, next_expected: int = 1, window_size: int = 1000):
        self._next_expected = int(next_expected)
        self._window_size = int(window_size)
        self._frames: dict[int, dict[str, Any]] = {}
        self._released: set[int] = set()

    @property
    def next_expected(self) -> int:
        return self._next_expected

    def push(self, frame: dict[str, Any]) -> tuple[bool, str | None]:
        """Accept a frame; returns (accepted, reason)."""
        seq = int(frame.get("seq", 0))
        if seq < self._next_expected or seq in self._released:
            return False, "duplicate_or_stale"
        if seq in self._frames:
            return False, "duplicate"
        if seq > self._next_expected + self._window_size:
            return False, "out_of_window"
        self._frames[seq] = dict(frame)
        return True, None

    def ready(self) -> list[dict[str, Any]]:
        """Release all contiguous frames starting at next_expected."""
        released: list[dict[str, Any]] = []
        while self._next_expected in self._frames:
            released.append(self._frames.pop(self._next_expected))
            self._released.add(self._next_expected)
            self._next_expected += 1
        if len(self._released) > self._window_size:
            self._released = set(sorted(self._released)[-self._window_size:])
        return released

    def has_gap(self) -> bool:
        return self._next_expected not in self._frames and bool(self._frames)

    def missing(self) -> list[int]:
        """Return missing sequence numbers between expected and highest buffered."""
        if not self._frames:
            return []
        highest = max(self._frames)
        return [
            seq
            for seq in range(self._next_expected, highest)
            if seq not in self._frames
        ]
