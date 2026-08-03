"""空间层级实体与注册表。

集团→工厂→车间→产线→区域→工位→设备/人员/任务 的统一空间层级。每个实体具备唯一 ID、父级空间、
坐标、朝向、边界框、状态、数据来源（real/controlled_test/simulated）、置信度、更新时间、版本；
支持 to_dict/from_dict 往返与 touch 版本递增。SpatialRegistry 为内存态实体存储，提供父子/祖先/
后代遍历与按类型查询，注册时校验父级存在（根除外）。

对应 spec「空间数字底座与统一坐标体系」之「空间实体可追溯」场景。纯 Python 标准库实现。
"""

import enum
from dataclasses import dataclass
from typing import Optional

from edge_platform.spatial import new_id, now_iso
from edge_platform.spatial.coordinate import BoundingBox, Pose


class EntityType(enum.Enum):
    """空间实体类型（值即字符串，便于序列化与跨语言对齐）。"""

    GROUP = "GROUP"
    FACTORY = "FACTORY"
    WORKSHOP = "WORKSHOP"
    LINE = "LINE"
    ZONE = "ZONE"
    STATION = "STATION"
    DEVICE = "DEVICE"
    PERSON = "PERSON"
    TASK = "TASK"


def new_entity_id(prefix="ENT"):
    """生成空间实体 ID，如 STN-a1b2c3d4。"""
    return new_id(prefix)


@dataclass
class SpatialEntity:
    """空间层级实体。

    entity_id 唯一；parent_id 指向父空间实体（根为 None）；pose/bbox 可空；
    source_type 区分 real/controlled_test/simulated；version 随 touch 递增。
    """

    entity_id: str
    entity_type: EntityType
    parent_id: Optional[str] = None
    name: str = ""
    pose: Optional[Pose] = None
    bbox: Optional[BoundingBox] = None
    status: str = "active"
    source_type: str = "real"
    confidence: float = 1.0
    updated_at: str = ""
    version: int = 1

    def __post_init__(self):
        if isinstance(self.entity_type, str):
            self.entity_type = EntityType(self.entity_type)
        if not self.updated_at:
            self.updated_at = now_iso()

    def touch(self):
        """更新时间戳并递增版本（实体被修改后调用）。"""
        self.version += 1
        self.updated_at = now_iso()

    def to_dict(self):
        return {
            "entity_id": self.entity_id,
            "entity_type": self.entity_type.value,
            "parent_id": self.parent_id,
            "name": self.name,
            "pose": self.pose.to_dict() if self.pose else None,
            "bbox": self.bbox.to_dict() if self.bbox else None,
            "status": self.status,
            "source_type": self.source_type,
            "confidence": self.confidence,
            "updated_at": self.updated_at,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, d):
        pose = d.get("pose")
        bbox = d.get("bbox")
        return cls(
            entity_id=d["entity_id"],
            entity_type=d["entity_type"],  # 字符串在 __post_init__ 中转回枚举
            parent_id=d.get("parent_id"),
            name=d.get("name", ""),
            pose=Pose.from_dict(pose) if pose else None,
            bbox=BoundingBox.from_dict(bbox) if bbox else None,
            status=d.get("status", "active"),
            source_type=d.get("source_type", "real"),
            confidence=d.get("confidence", 1.0),
            updated_at=d.get("updated_at", ""),
            version=d.get("version", 1),
        )


class SpatialRegistry:
    """空间实体内存注册表：entity_id -> SpatialEntity。"""

    def __init__(self):
        self._entities = {}

    def register(self, entity):
        """注册实体；parent_id 非空时校验父级已存在（根除外）。"""
        if entity.parent_id is not None and entity.parent_id not in self._entities:
            raise ValueError(f"父级实体不存在: {entity.parent_id}")
        self._entities[entity.entity_id] = entity
        return entity

    def get(self, entity_id):
        return self._entities.get(entity_id)

    def children(self, parent_id):
        """直接子实体列表。"""
        return [e for e in self._entities.values() if e.parent_id == parent_id]

    def ancestors(self, entity_id):
        """祖先链：从直接父级逐级到根。"""
        out = []
        cur = self.get(entity_id)
        while cur is not None and cur.parent_id is not None:
            parent = self.get(cur.parent_id)
            if parent is None:
                break
            out.append(parent)
            cur = parent
        return out

    def descendants(self, entity_id):
        """所有后代（广度优先）。"""
        out = []
        queue = list(self.children(entity_id))
        while queue:
            c = queue.pop(0)
            out.append(c)
            queue.extend(self.children(c.entity_id))
        return out

    def by_type(self, entity_type):
        """按类型查询；接受 EntityType 或字符串值。"""
        if isinstance(entity_type, EntityType):
            return [e for e in self._entities.values() if e.entity_type == entity_type]
        return [e for e in self._entities.values() if e.entity_type.value == entity_type]

    def all(self):
        return list(self._entities.values())
