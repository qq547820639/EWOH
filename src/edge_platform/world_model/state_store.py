"""世界状态存储：当前状态 + 历史状态。

以 (entity_id, state_type) 为主键维护「当前状态」与「历史状态列表」；set 时关闭上一条当前状态
（写 valid_to）并开启新状态、递增版本；支持 current/history/at_time/snapshot 查询与
to_dict/from_dict 回放持久化。

对应 spec「工厂世界模型层」之「当前状态、历史状态」与「沿时间轴回放」场景。纯 Python 标准库实现。
"""

from dataclasses import dataclass
from typing import Optional, List, Dict, Any

from edge_platform.spatial import new_id, now_iso
from edge_platform.inference import ts_to_ms


@dataclass
class WorldState:
    """世界状态记录。

    state_json 为状态值载荷（如 {x,y,zone} / {battery_pct} / {task_id} 等）；
    valid_to 为 None 表示当前生效；version 随同主键的 set 调用递增。
    """

    state_id: str
    entity_id: str
    state_type: str
    state_json: Dict[str, Any]
    valid_from: str
    valid_to: Optional[str] = None
    source_type: str = "real"
    confidence: float = 1.0
    version: int = 1

    def to_dict(self):
        return {
            "state_id": self.state_id,
            "entity_id": self.entity_id,
            "state_type": self.state_type,
            "state_json": self.state_json,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "source_type": self.source_type,
            "confidence": self.confidence,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            state_id=d["state_id"],
            entity_id=d["entity_id"],
            state_type=d["state_type"],
            state_json=d.get("state_json") or {},
            valid_from=d["valid_from"],
            valid_to=d.get("valid_to"),
            source_type=d.get("source_type", "real"),
            confidence=d.get("confidence", 1.0),
            version=d.get("version", 1),
        )


class StateStore:
    """世界状态内存存储：按 (entity_id, state_type) 维护当前与历史。"""

    def __init__(self):
        self._current: Dict[tuple, "WorldState"] = {}
        self._history: Dict[tuple, List["WorldState"]] = {}

    def set(self, entity_id, state_type, state_json, source_type, confidence, ts=None):
        """关闭上一条当前状态（valid_to=ts）并开启新状态，递增版本。"""
        ts = ts or now_iso()
        key = (entity_id, state_type)
        prev = self._current.get(key)
        prev_version = prev.version if prev else 0
        if prev is not None:
            prev.valid_to = ts
        state = WorldState(
            state_id=new_id("STS"),
            entity_id=entity_id,
            state_type=state_type,
            state_json=state_json or {},
            valid_from=ts,
            valid_to=None,
            source_type=source_type,
            confidence=confidence,
            version=prev_version + 1,
        )
        self._current[key] = state
        self._history.setdefault(key, []).append(state)
        return state

    def current(self, entity_id, state_type):
        """返回当前生效状态或 None。"""
        return self._current.get((entity_id, state_type))

    def history(self, entity_id, state_type, from_ts=None, to_ts=None):
        """返回时间序历史状态列表，可按 [from_ts, to_ts] 过滤（区间相交即纳入）。"""
        lst = self._history.get((entity_id, state_type), [])
        if from_ts is None and to_ts is None:
            return list(lst)
        from_ms = ts_to_ms(from_ts) if from_ts else None
        to_ms = ts_to_ms(to_ts) if to_ts else None
        out = []
        for s in lst:
            vf = ts_to_ms(s.valid_from)
            vt = ts_to_ms(s.valid_to) if s.valid_to else None
            # 状态 [valid_from, valid_to) 与查询区间 [from_ts, to_ts] 相交
            if from_ms is not None and vt is not None and vt < from_ms:
                continue
            if to_ms is not None and vf > to_ms:
                continue
            out.append(s)
        return out

    def at_time(self, entity_id, state_type, ts):
        """返回 ts 时刻生效的状态：valid_from <= ts < valid_to，或 valid_to 为 None 且 valid_from <= ts。"""
        target = ts_to_ms(ts)
        # 倒序遍历以最近优先，命中第一个有效区间即返回
        for s in reversed(self._history.get((entity_id, state_type), [])):
            vf = ts_to_ms(s.valid_from)
            if vf > target:
                continue
            vt = ts_to_ms(s.valid_to) if s.valid_to else None
            if vt is None or target < vt:
                return s
        return None

    def snapshot(self):
        """返回所有当前状态，键为 (entity_id, state_type)，供指挥地图使用。"""
        return dict(self._current)

    def all_keys(self):
        """返回所有 (entity_id, state_type) 主键列表。"""
        return list(self._history.keys())

    def state_types(self, entity_id):
        """返回某实体的全部 state_type 列表。"""
        return [st for (eid, st) in self._history.keys() if eid == entity_id]

    def to_dict(self):
        states = []
        for lst in self._history.values():
            for s in lst:
                states.append(s.to_dict())
        return {"states": states}

    @classmethod
    def from_dict(cls, d):
        store = cls()
        for sd in d.get("states", []):
            s = WorldState.from_dict(sd)
            key = (s.entity_id, s.state_type)
            store._history.setdefault(key, []).append(s)
            if s.valid_to is None:
                store._current[key] = s
        return store
