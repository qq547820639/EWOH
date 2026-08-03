"""CSV/file connector surface (Final 5.0 AA-05).

Implements header mapping, row normalization, and batch ingestion for
CSV-based OT integrations. A file watcher/reader feeds rows into the adapter.
"""

from __future__ import annotations

import csv
import io
import queue
from dataclasses import dataclass
from typing import Any

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.spatial import now_iso


class CsvFileError(ValueError):
    """Raised when CSV content violates the connector contract."""


@dataclass
class CsvMapping:
    """Column mapping from vendor header to EWOH fields."""

    entity_id: str
    value: str
    timestamp: str | None = None
    metric_name: str | None = None
    unit: str | None = None


def parse_csv_rows(
    content: str | bytes,
    mapping: CsvMapping,
    default_source_type: str = "real",
) -> list[dict[str, Any]]:
    """Parse CSV content with a header row and map columns to EWOH fields."""
    if isinstance(content, bytes):
        content = content.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        raise CsvFileError("CSV must contain a header row")
    rows: list[dict[str, Any]] = []
    for row in reader:
        entity_id = (row.get(mapping.entity_id) or "").strip()
        if not entity_id:
            continue
        value_text = (row.get(mapping.value) or "").strip()
        if value_text == "":
            continue
        try:
            value: Any = int(value_text)
        except ValueError:
            try:
                value = float(value_text)
            except ValueError:
                value = value_text
        rows.append(
            {
                "entity_id": entity_id,
                "metric_name": (
                    row.get(mapping.metric_name) or mapping.metric_name or "value"
                ).strip(),
                "value": value,
                "unit": (row.get(mapping.unit) or mapping.unit) if mapping.unit else None,
                "event_time": (
                    (row.get(mapping.timestamp) or "").strip()
                    if mapping.timestamp
                    else now_iso()
                )
                or now_iso(),
                "source_type": default_source_type,
                "protocol_version": "CSV-File",
            }
        )
    if not rows:
        raise CsvFileError("CSV produced no valid rows")
    return rows


class CsvFileAdapter(BaseAdapter):
    """Edge adapter converting CSV rows to EWOH telemetry frames."""

    DEVICE_TYPE = "csv_file_connector"

    def __init__(
        self,
        device_id: str,
        mapping: CsvMapping,
        source_type: str = "real",
        model: str = "CSV-FILE-GENERIC",
    ):
        super().__init__(
            device_id,
            source_type=source_type,
            model=model,
            firmware_version="CSV-File",
        )
        self.mapping = mapping
        self._inbox: queue.Queue = queue.Queue(maxsize=1024)
        self._last_msg: dict[str, Any] | None = None
        self._last_seen: str | None = None

    def start(self) -> None:
        self._running = True
        self._started_at = now_iso()

    def stop(self) -> None:
        self._running = False

    def reconnect(self) -> bool:
        self._running = True
        return True

    def health(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
        }

    def device_info(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "mapping": {
                "entity_id": self.mapping.entity_id,
                "value": self.mapping.value,
                "timestamp": self.mapping.timestamp,
            },
        }

    def read_message(self, timeout=None) -> dict[str, Any] | None:
        try:
            msg = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        self._last_msg = msg
        self._last_seen = msg.get("event_time")
        return msg

    def _enqueue_csv(self, content: str | bytes) -> None:
        """Parse and enqueue CSV rows (file watcher callback)."""
        for row in parse_csv_rows(content, self.mapping, self.source_type):
            try:
                self._inbox.put_nowait(row)
            except queue.Full:
                pass
