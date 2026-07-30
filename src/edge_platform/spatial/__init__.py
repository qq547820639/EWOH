"""空间数字底座：统一坐标体系、空间层级实体、工位拓扑、空间资产分级建模。

对应 spec「空间数字底座与统一坐标体系」「空间资产体系与分级建模」：
- coordinate：工厂统一坐标系（米制，+X 东 +Y 北 +Z 上，yaw 自北顺时针），2.5D 坐标变换、距离、边界框。
- entities：集团→工厂→车间→产线→区域→工位→设备/人员/任务 空间层级实体与注册表。
- topology：工位/路线/邻接 JSON 拓扑与 Dijkstra 最短路径、GeoJSON 导出。
- asset_registry：GeoJSON/GLB/3D Tiles/点云/Gaussian Splat/拓扑 JSON 资产与 L0~L3 分级版本管理。

纯 Python 标准库实现；沿用 inference 包的 new_id(prefix)（uuid4 hex）与 ISO 8601 时间戳约定。
"""

import uuid
from datetime import datetime, timezone


def new_id(prefix):
    """生成短随机业务 ID，如 STN-a1b2c3d4（沿用 inference.new_id 约定）。"""
    return "%s-%s" % (prefix, uuid.uuid4().hex[:8])


def now_iso():
    """当前 UTC 时间的 ISO 8601 字符串（毫秒精度）。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# 以下子模块导入在 new_id/now_iso 定义之后，便于子模块 `from edge_platform.spatial import ...`
from .coordinate import (  # noqa: E402
    Pose, BoundingBox, world_to_local, local_to_world, distance,
)
from .entities import (  # noqa: E402
    EntityType, SpatialEntity, SpatialRegistry, new_entity_id,
)
from .topology import (  # noqa: E402
    TopologyNode, TopologyEdge, Topology, route_length,
)
from .asset_registry import (  # noqa: E402
    AssetType, LOD, SpatialAsset, AssetRegistry, compute_checksum, new_asset_id,
)
from .multi_factory import (  # noqa: E402
    FactoryNode, CrossFactoryLink, FederationPolicy,
    MultiFactoryRegistry, CrossFactorySchedulerStub,
)

__all__ = [
    "new_id", "now_iso",
    "Pose", "BoundingBox", "world_to_local", "local_to_world", "distance",
    "EntityType", "SpatialEntity", "SpatialRegistry", "new_entity_id",
    "TopologyNode", "TopologyEdge", "Topology", "route_length",
    "AssetType", "LOD", "SpatialAsset", "AssetRegistry", "compute_checksum",
    "new_asset_id",
    "FactoryNode", "CrossFactoryLink", "FederationPolicy",
    "MultiFactoryRegistry", "CrossFactorySchedulerStub",
]
