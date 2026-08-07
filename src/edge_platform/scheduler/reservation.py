"""资源预约服务：时间窗绑定，冲突时禁止覆盖（内存实现 + 线程锁）。

联合调度确认后为每个 assignment 对 (person, device) 建立资源预约；
同一资源在同一时间窗内只能有一条 active 预约，冲突必须由后端拒绝。

纯 Python 标准库实现（threading.RLock）。
"""

import threading
from datetime import datetime, timezone

from edge_platform.spatial import new_id

from .models import Reservation


class ReservationConflictError(ValueError):
    """资源预约时间窗冲突。"""

    pass


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


def _overlaps(a_start, a_end, b_start, b_end):
    """两个时间窗是否重叠（半开区间 [start, end)，端点相接不算重叠）。"""
    a_s, a_e = _parse_ts(a_start), _parse_ts(a_end)
    b_s, b_e = _parse_ts(b_start), _parse_ts(b_end)
    if a_s is None or a_e is None or b_s is None or b_e is None:
        return False
    return a_s < b_e and b_s < a_e


class ReservationService:
    """内存预约服务。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._reservations = {}  # reservation_id -> Reservation

    def reserve(self, resource_id, assignment_id, plan_id, start_at, end_at, expires_at):
        """创建预约；与同资源现有 active 预约时间窗冲突则抛 ReservationConflictError。"""
        with self._lock:
            if self.check_conflict(resource_id, start_at, end_at):
                raise ReservationConflictError(
                    f"资源 {resource_id} 在时间窗 {start_at}~{end_at} 已被预约，存在冲突"
                )
            res = Reservation(
                reservation_id=new_id("RES"),
                resource_id=resource_id,
                assignment_id=assignment_id,
                plan_id=plan_id,
                start_at=start_at,
                end_at=end_at,
                expires_at=expires_at,
                status="active",
                version=1,
            )
            self._reservations[res.reservation_id] = res
            return res

    def check_conflict(self, resource_id, start_at, end_at, exclude_reservation_id=None):
        """判断同资源在时间窗上是否与现有 active 预约冲突。"""
        with self._lock:
            now = datetime.now(timezone.utc)
            for res in self._reservations.values():
                if res.status != "active":
                    continue
                if exclude_reservation_id and res.reservation_id == exclude_reservation_id:
                    continue
                if res.resource_id != resource_id:
                    continue
                # 已过期预约不视为冲突
                exp = _parse_ts(res.expires_at)
                if exp is not None and exp <= now:
                    continue
                if _overlaps(start_at, end_at, res.start_at, res.end_at):
                    return True
            return False

    def renew(self, reservation_id, new_expires_at):
        """续期：更新 expires_at 并递增 version。"""
        with self._lock:
            res = self._get(reservation_id)
            res.expires_at = new_expires_at
            res.version += 1
            return res

    def release(self, reservation_id):
        """释放预约：状态置为 released（不再参与冲突检测）。"""
        with self._lock:
            res = self._get(reservation_id)
            res.status = "released"
            return res

    def expire_overdue(self, now=None):
        """把过期（expires_at 早于 now）的 active 预约标记为 expired，返回列表。"""
        with self._lock:
            now = _parse_ts(now) or datetime.now(timezone.utc)
            expired = []
            for res in self._reservations.values():
                if res.status != "active":
                    continue
                exp = _parse_ts(res.expires_at)
                if exp is not None and exp <= now:
                    res.status = "expired"
                    expired.append(res)
            return expired

    def list_active(self):
        """返回全部 active 预约。"""
        with self._lock:
            return [r for r in self._reservations.values() if r.status == "active"]

    def get(self, reservation_id):
        """按 ID 取预约；不存在返回 None。"""
        with self._lock:
            return self._reservations.get(reservation_id)

    def _get(self, reservation_id):
        res = self._reservations.get(reservation_id)
        if res is None:
            raise KeyError(f"预约不存在: {reservation_id}")
        return res
