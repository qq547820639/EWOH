"""Deterministic shadow-plan checks before requesting human review."""

from datetime import datetime, timezone

from edge_platform.spatial import now_iso


def _timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _station_available_capacity(station):
    counts = []
    for value in (station.get("capacity", 1), station.get("current_occupancy", station.get("occupancy", 0))):
        try:
            count = int(value)
        except (TypeError, ValueError, OverflowError):
            return 0
        if isinstance(value, bool) or count < 0 or (isinstance(value, float) and count != value):
            return 0
        counts.append(count)
    capacity, occupancy = counts
    return capacity - occupancy


def evaluate_plan(plan, snapshot, requested_task_ids):
    tasks = {task["task_id"]: task for task in snapshot.tasks}
    persons = {person["person_id"]: person for person in snapshot.persons}
    devices = {device["device_id"]: device for device in snapshot.devices}
    stations = {station["station_id"]: station for station in snapshot.stations}
    station_capacity = {station_id: _station_available_capacity(station) for station_id, station in stations.items()}
    blockers = []
    windows = {}
    durations = {}
    assigned = set()

    for assignment in plan.assignments:
        task_id = assignment.task_id
        if task_id in assigned or task_id not in requested_task_ids or task_id not in tasks:
            blockers.append({"code": "TASK_SCOPE", "task_id": task_id})
        assigned.add(task_id)
        if assignment.person_id not in persons:
            blockers.append({"code": "PERSON_MISSING", "task_id": task_id})
        elif persons[assignment.person_id].get("active") in (False, 0):
            blockers.append({"code": "PERSON_INACTIVE", "task_id": task_id})
        if assignment.device_id and assignment.device_id not in devices:
            blockers.append({"code": "DEVICE_MISSING", "task_id": task_id})
        elif assignment.device_id:
            device = devices[assignment.device_id]
            if device.get("online") in (False, 0) or str(device.get("status", "")).lower() in {
                "offline", "fault", "faulty", "maintenance",
            }:
                blockers.append({"code": "DEVICE_UNAVAILABLE", "task_id": task_id})
        if assignment.station_id and assignment.station_id not in stations:
            blockers.append({"code": "STATION_MISSING", "task_id": task_id, "station_id": assignment.station_id})
        elif assignment.station_id:
            station = stations[assignment.station_id]
            if any(station.get(flag) in (False, 0) for flag in ("available", "active", "online")) or str(
                station.get("status", "")
            ).lower() in {
                "offline", "blocked", "fault", "faulty", "maintenance", "unavailable", "disabled", "inactive",
            }:
                blockers.append({
                    "code": "STATION_UNAVAILABLE", "task_id": task_id, "station_id": assignment.station_id,
                })
            if station_capacity[assignment.station_id] <= 0:
                blockers.append({"code": "STATION_CAPACITY", "task_id": task_id, "station_id": assignment.station_id})
        if tasks.get(task_id, {}).get("status") in {"completed", "cancelled"}:
            blockers.append({"code": "TASK_TERMINAL", "task_id": task_id})
        if assignment.route.get("reachable") is not True:
            blockers.append({"code": "ROUTE_UNVERIFIED", "task_id": task_id})
        if assignment.hard_constraint_results:
            blockers.append({"code": "HARD_CONSTRAINT", "task_id": task_id})
        start = _timestamp(assignment.planned_start)
        end = _timestamp(assignment.planned_end)
        if start is None or end is None or end <= start:
            blockers.append({"code": "TIME_WINDOW_INVALID", "task_id": task_id})
            continue
        durations[task_id] = (end - start).total_seconds()
        for resource_type, resource_id in (
            ("person", assignment.person_id),
            ("device", assignment.device_id),
        ):
            if not resource_id:
                continue
            previous = windows.setdefault((resource_type, resource_id), [])
            if any(start < previous_end and previous_start < end for previous_start, previous_end in previous):
                blockers.append({"code": "RESOURCE_CONFLICT", "task_id": task_id, "resource_id": resource_id})
            previous.append((start, end))
        if station_capacity.get(assignment.station_id, 0) > 0:
            station_windows = windows.setdefault(("station", assignment.station_id), [])
            station_windows.append((start, end))
            changes = sorted(
                change for window_start, window_end in station_windows
                for change in ((window_start, 1), (window_end, -1))
            )
            concurrent = 0
            for _, delta in changes:
                concurrent += delta
                if concurrent > station_capacity[assignment.station_id]:
                    blockers.append({
                        "code": "STATION_CAPACITY", "task_id": task_id, "station_id": assignment.station_id,
                    })
                    break

    unassigned = sorted(set(requested_task_ids) - assigned)
    if unassigned:
        blockers.append({"code": "TASKS_UNASSIGNED", "task_ids": unassigned})
    if not plan.assignments:
        blockers.append({"code": "NO_ASSIGNMENTS"})
    return {
        "kind": "deterministic_plan_evaluation",
        "is_simulation": True,
        "evaluated_at": now_iso(),
        "snapshot_id": snapshot.snapshot_id,
        "snapshot_at": snapshot.timestamp,
        "source_timestamps": dict(getattr(snapshot, "source_timestamps", {}) or {}),
        "feasible": not blockers,
        "blockers": blockers,
        "unassigned_task_ids": unassigned,
        "predicted_duration_seconds": durations,
        "affected_person_ids": sorted({assignment.person_id for assignment in plan.assignments}),
        "affected_device_ids": sorted({
            assignment.device_id for assignment in plan.assignments if assignment.device_id
        }),
        "assumptions": [
            "Durations and routes come from the plan's recorded snapshot.",
            "Evaluation does not authorize execution or validate physical equipment safety.",
        ],
    }
