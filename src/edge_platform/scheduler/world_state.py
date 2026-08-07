"""世界状态服务：聚合各数据源生成一致性快照，用于确认前检测世界状态变化。

联合调度必须先基于一致的世界状态快照生成方案；人工确认前若世界状态发生关键变化
（人员/设备在线集合、任务集合、分配状态），后端应拒绝确认并提示重排。

纯 Python 标准库实现。
"""

from datetime import datetime, timezone

from edge_platform.spatial import now_iso

from .models import WorldStateSnapshot


def _parse_ts(ts, default=None):
    if not ts:
        return default
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return default
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _safe_call(storage, *names, default=None, **kwargs):
    """按顺序尝试调用 storage 上存在的方法，缺失返回 default（容错）。

    kwargs 会透传给目标方法（如 list_events(limit=200)）。
    """
    for name in names:
        fn = getattr(storage, name, None)
        if fn is not None:
            try:
                return fn(**kwargs)
            except TypeError:
                return fn(storage) if callable(getattr(storage, name, None)) else default
            except Exception:
                return default
    return default


def _item_id(item, key):
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)


def _item_status(item):
    if isinstance(item, dict):
        return item.get("status")
    return getattr(item, "status", None)


class WorldStateService:
    """世界状态快照构建与比对。"""

    def __init__(self):
        self._seq = 0

    def _next_snapshot_id(self):
        """生成 WS-YYYYMMDD-NNNN 格式快照 ID（日期 + 递增序号）。"""
        self._seq += 1
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        return f"WS-{day}-{self._seq:04d}"

    def build_snapshot(self, storage, ctx=None):
        """聚合 storage 各数据源生成 WorldStateSnapshot。

        storage 可能缺少 list_tasks/list_stations 等方法，用 getattr 容错（缺失给空列表）。
        """
        ctx = ctx or {}
        persons = _safe_call(storage, "list_people", "list_persons", default=[]) or []
        devices = _safe_call(storage, "list_devices", default=[]) or []
        tasks = _safe_call(storage, "list_tasks", default=[]) or []
        stations = _safe_call(storage, "list_stations", default=[]) or []
        assignments = _safe_call(storage, "list_assignments", default=[]) or []
        events = _safe_call(storage, "list_events", default=[], limit=200) or []
        reservations = _safe_call(storage, "list_reservations", default=[])

        telemetry = _safe_call(storage, "get_telemetry", default=None)
        sources = {
            "persons_ts": _safe_call(storage, "people_updated_at", default=""),
            "devices_ts": _safe_call(storage, "devices_updated_at", default=""),
            "tasks_ts": _safe_call(storage, "tasks_updated_at", default=""),
            "events_ts": _safe_call(storage, "events_updated_at", default=""),
            "telemetry_ts": (telemetry or {}).get("timestamp", "")
            if isinstance(telemetry, dict)
            else "",
        }
        snapshot = WorldStateSnapshot(
            snapshot_id=self._next_snapshot_id(),
            timestamp=now_iso(),
            persons=[p.to_dict() if hasattr(p, "to_dict") else p for p in persons],
            devices=[d.to_dict() if hasattr(d, "to_dict") else d for d in devices],
            tasks=[t.to_dict() if hasattr(t, "to_dict") else t for t in tasks],
            stations=[s.to_dict() if hasattr(s, "to_dict") else s for s in stations],
            assignments=[
                a.to_dict() if hasattr(a, "to_dict") else a for a in assignments
            ],
            reservations=[
                r.to_dict() if hasattr(r, "to_dict") else r for r in (reservations or [])
            ],
            events=[e.to_dict() if hasattr(e, "to_dict") else e for e in events],
            topology_version=ctx.get("topology_version", "") or "",
        )
        snapshot.station_ts_hint = sources.get("tasks_ts") or ""
        snapshot.source_timestamps = sources
        return snapshot

    def is_stale(self, snapshot, max_age_sec=300):
        """根据 snapshot.timestamp 与当前时间差判断是否过期。"""
        if snapshot is None:
            return True
        ts = _parse_ts(getattr(snapshot, "timestamp", None))
        if ts is None:
            return True
        age = (datetime.now(timezone.utc) - ts).total_seconds()
        return age > float(max_age_sec)

    def key_changed(self, a, b):
        """比较两个快照的关键字段是否变化（人员/设备在线/任务/分配状态）。

        用于确认前检测 world state 变化，防止基于过期世界状态确认。
        """
        if a is None or b is None:
            return True
        if getattr(a, "snapshot_id", None) == getattr(b, "snapshot_id", None):
            return False

        def _id_set(items):
            return {_item_id(i, "person_id") or _item_id(i, "device_id") or _item_id(i, "task_id")
                    for i in items}

        def _online_devices(items):
            return {
                _item_id(i, "device_id")
                for i in items
                if _item_item_online(i)
            }

        if _id_set(a.persons) != _id_set(b.persons):
            return True
        if _online_devices(a.devices) != _online_devices(b.devices):
            return True
        if _id_set(a.tasks) != _id_set(b.tasks):
            return True
        # 分配状态集合变化
        a_assign = {(_item_id(i, "assignment_id"), _item_status(i)) for i in a.assignments}
        b_assign = {(_item_id(i, "assignment_id"), _item_status(i)) for i in b.assignments}
        if a_assign != b_assign:
            return True
        return False


def _item_item_online(item):
    """判断设备在线：status 不在离线/维护集合即视为在线（缺省在线）。"""
    offline = {"OFFLINE", "offline", "MAINTENANCE", "maintenance", "fault", "FAULT"}
    return _item_status(item) not in offline
