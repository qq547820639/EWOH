"""SQLite provenance survives restarts and legacy snapshot-table upgrades."""

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from edge_platform.edge.storage import Storage
from edge_platform.scheduler.models import WorldStateSnapshot
from edge_platform.scheduler.repository import SchedulingRepository


class SnapshotProvenanceTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "snapshot.db"

    def test_upsert_and_reopen_preserve_versioned_metadata_and_entity_arrays(self):
        snapshot = WorldStateSnapshot(
            snapshot_id="snapshot", tasks=[{"task_id": "task"}], events=[{"event_id": "event"}],
            topology_version="topology-1", source_timestamps={"tasks_ts": "2026-09-10T08:00:00Z"},
        )
        with closing(Storage(self.path)) as storage:
            repository = SchedulingRepository(storage)
            repository.save_snapshot(snapshot)
            snapshot.source_timestamps["tasks_ts"] = "2026-09-10T08:01:00Z"
            snapshot.source_timestamps["events_ts"] = "2026-09-10T08:02:00+08:00"
            repository.save_snapshot(snapshot)

        with closing(Storage(self.path)) as reopened:
            repository = SchedulingRepository(reopened)
            stored = repository.get_snapshot(snapshot.snapshot_id)
            self.assertEqual(repository.list_snapshots(), [stored])
            self.assertEqual(WorldStateSnapshot(**{key: value for key, value in stored.items() if key != "id"}), snapshot)
            raw = reopened._db.execute("SELECT metadata_json FROM world_state_snapshot").fetchone()[0]
            self.assertEqual(json.loads(raw), {"version": 1, "source_timestamps": snapshot.source_timestamps})

    def test_legacy_table_upgrade_is_idempotent_and_retains_existing_rows(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("""
                CREATE TABLE world_state_snapshot (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id TEXT UNIQUE NOT NULL,
                    timestamp TEXT, persons_json TEXT, devices_json TEXT, tasks_json TEXT,
                    stations_json TEXT, assignments_json TEXT, reservations_json TEXT,
                    events_json TEXT, topology_version TEXT
                )
            """)
            db.execute(
                "INSERT INTO world_state_snapshot (snapshot_id, timestamp, tasks_json) VALUES (?, ?, ?)",
                ("legacy", "2026-09-10T08:00:00Z", '[{"task_id": "legacy-task"}]'),
            )
        with closing(Storage(self.path)) as storage:
            storage.init_db()
            row = storage.get_world_state_snapshot("legacy")
            self.assertEqual(row["source_timestamps"], {})
            self.assertEqual(row["tasks"], [{"task_id": "legacy-task"}])
            snapshot = WorldStateSnapshot(**{key: value for key, value in row.items() if key != "id"})
            snapshot.source_timestamps = {"tasks_ts": "2026-09-10T07:59:00Z"}
            SchedulingRepository(storage).save_snapshot(snapshot)
        with closing(Storage(self.path)) as reopened:
            self.assertEqual(reopened.get_world_state_snapshot("legacy")["source_timestamps"], snapshot.source_timestamps)
            self.assertEqual(len(reopened.list_world_state_snapshots()), 1)


if __name__ == "__main__":
    unittest.main()
