"""统一实时资源状态聚合（Phase 3）：人员/设备/工位/任务/Assignment/遥测 → ResourceState。

把散落在 storage 各表的资源主数据与实时态归一为统一的 ``ResourceState``
（resource_id / resource_type / status[AVAILABLE|RESERVED|BUSY|DEGRADED|OFFLINE|MAINTENANCE] /
location / station_id / zone_id / skills / capabilities / current_task_id / reserved_by /
reserved_until / load / battery / risk / source_ts / updated_at / version），
供 ``GET /api/resources/state`` 输出，且每位资源带递增 version 供前端版本比较。

设计要点：
- 人员（person）与设备（device）都有实时态；人员状态主要取决于其当前 assignment，
  设备状态取决于在线/遥测/故障；
- 若存在资源预约（Reservation），资源状态会标记为 RESERVED 并回填 reserved_by/reserved_until；
- 所有字段容错：storage 缺失某数据源时降级为默认值/空集合，不抛异常。

纯 Python 标准库实现。
"""

from edge_platform.spatial import now_iso

from .models import (
    RESOURCE_AVAILABLE,
    RESOURCE_BUSY,
    RESOURCE_MAINTENANCE,
    RESOURCE_OFFLINE,
    RESOURCE_RESERVED,
    ResourceState,
)


def _item_id(item, key):
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)


def _item(item, key, default=""):
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _safe_call(storage, *names, default=None):
    """按顺序尝试调用 storage 上存在的方法，缺失返回 default（容错）。"""
    for name in names:
        fn = getattr(storage, name, None)
        if fn is not None:
            try:
                return fn()
            except Exception:
                return default
    return default


class ResourceStateService:
    """统一资源实时状态聚合服务（Phase 3）。"""

    def __init__(self):
        self._seq = 0
        self._cache = {}  # resource_id -> ResourceState（用于 version 递增）

    def _next_version(self, resource_id):
        """为资源版本自增（乐观版本，供前端只接受比当前版本新的数据）。"""
        cur = self._cache.get(resource_id)
        ver = int(cur.version) if cur else 0
        self._seq += 1
        return ver + 1

    def build_resource_states(self, storage, ctx=None):
        """聚合 storage 生成统一的资源状态列表（dict 列表）。

        ctx 可选提供 device_online(device)->bool 判定设备在线；缺省用在线标志。
        """
        ctx = ctx or {}
        device_online = getattr(ctx, "device_online", None) if not isinstance(ctx, dict) else None

        persons = _safe_call(storage, "list_people", "list_persons", default=[]) or []
        devices = _safe_call(storage, "list_devices", default=[]) or []
        stations = _safe_call(storage, "list_stations", default=[]) or []
        assignments = _safe_call(storage, "list_assignments", default=[]) or []
        reservations = _safe_call(storage, "list_reservations", default=[]) or []

        # 预建索引：current assignment（按 person/device 找未完成分配）
        active_assign = {
            _item_id(a, "person_id"): a
            for a in assignments
            if _item(a, "status") not in ("completed", "cancelled")
        }
        active_assign_dev = {
            _item_id(a, "device_id"): a
            for a in assignments
            if _item(a, "status") not in ("completed", "cancelled") and _item_id(a, "device_id")
        }
        # 预约索引：resource_id -> 最新预约
        reserved = {}
        for r in reservations:
            rid = _item_id(r, "resource_id")
            if rid and rid not in reserved:
                reserved[rid] = r

        states = []
        # 人员
        for p in persons:
            pid = _item_id(p, "person_id")
            if not pid:
                continue
            assign = active_assign.get(pid)
            res = reserved.get(pid)
            state = ResourceState(
                resource_id=pid,
                resource_type="person",
                status=RESOURCE_BUSY if assign else RESOURCE_AVAILABLE,
                skills=list(_item(p, "skills", []) or []),
                capabilities=list(_item(p, "capabilities", []) or []),
                current_task_id=_item_id(assign, "task_id") or "",
                station_id=_item(p, "station_id", "") or _item(p, "team", ""),
                zone_id=_item(p, "zone_id", ""),
                load=float(_item(p, "load_level", 0.0) or 0.0),
                risk=float(_item(p, "risk", 0.0) or 0.0),
            )
            if res:
                state.status = RESOURCE_RESERVED
                state.reserved_by = _item(res, "plan_id", "")
                state.reserved_until = _item(res, "end_at", "")
            state.version = self._next_version(pid)
            self._cache[pid] = state
            states.append(state)

        # 设备
        for d in devices:
            did = _item_id(d, "device_id")
            if not did:
                continue
            online = True
            if callable(device_online):
                try:
                    online = bool(device_online(d))
                except Exception:
                    online = bool(_item(d, "online", False))
            else:
                online = bool(_item(d, "online", False))
            fault = bool(_item(d, "fault", False))
            if not online:
                status = RESOURCE_OFFLINE
            elif fault:
                status = RESOURCE_MAINTENANCE
            else:
                status = RESOURCE_AVAILABLE
            assign = active_assign_dev.get(did)
            res = reserved.get(did)
            if res:
                status = RESOURCE_RESERVED if status != RESOURCE_OFFLINE else RESOURCE_OFFLINE
            elif assign and status != RESOURCE_OFFLINE:
                status = RESOURCE_BUSY
            state = ResourceState(
                resource_id=did,
                resource_type="device",
                status=status,
                location=_item(d, "location", {}) or {},
                skills=list(_item(d, "skills", []) or []),
                capabilities=list(_item(d, "capabilities", []) or []) or [_item(d, "model", "")],
                current_task_id=_item_id(assign, "task_id") or "",
                station_id=_item(d, "station_id", "") or _item_id(assign, "station_id") or "",
                zone_id=_item(d, "zone_id", ""),
                load=float(_item(d, "load_level", 0.0) or 0.0),
                battery=float(_item(d, "battery", 1.0) or 1.0),
                risk=float(_item(d, "risk", 0.0) or 0.0),
                source_ts=_item(d, "last_seen", ""),
            )
            if res:
                state.reserved_by = _item(res, "plan_id", "")
                state.reserved_until = _item(res, "end_at", "")
            state.version = self._next_version(did)
            self._cache[did] = state
            states.append(state)

        # 工位（station）作为独立资源类型
        for s in stations:
            sid = _item_id(s, "station_id")
            if not sid:
                continue
            raw_status = _item(s, "status", "AVAILABLE")
            state = ResourceState(
                resource_id=sid,
                resource_type="station",
                status=RESOURCE_AVAILABLE if raw_status not in ("OFFLINE", "MAINTENANCE") else raw_status,
                location=_item(s, "location", {}) or {},
                zone_id=_item(s, "zone_id", ""),
                capabilities=_item(s, "capabilities", []) or [],
                station_id=sid,
            )
            state.version = self._next_version(sid)
            self._cache[sid] = state
            states.append(state)

        # 统一补充 updated_at
        for st in states:
            if not st.updated_at:
                st.updated_at = now_iso()
        return [s.to_dict() for s in states]

    def to_dict_state(self, state):
        return state.to_dict() if hasattr(state, "to_dict") else dict(state)