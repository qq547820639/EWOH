"""空间资产注册表与分级建模。

统一输出 GeoJSON（二维区域路线）/ GLB（轻量三维）/ 3D Tiles（大规模分块）/ 点云 / Gaussian Splat
（局部高写实）/ TOPOLOGY_JSON（工位路线邻接）；三维建模分四级 LOD：L0 二维地图、L1 2.5D、
L2 轻量三维 GLB、L3 高写实局部场景。SpatialAsset 携带 uri、版本、来源、sha256 校验和与来源说明
（provenance：CAD/扫描等）。AssetRegistry 按 (name, asset_type) 维护版本历史，注册同名同类型资产
自动递增版本并保留历史，支持按 scope/lod 过滤与 latest/history 查询。

对应 spec「空间资产体系与分级建模」。纯 Python 标准库实现。
"""

import enum
import hashlib
from dataclasses import dataclass
from typing import Optional

from edge_platform.spatial import new_id, now_iso


class AssetType(enum.Enum):
    """空间资产类型。"""

    GEOJSON = "GEOJSON"
    GLB = "GLB"
    TILES_3D = "TILES_3D"
    POINTCLOUD = "POINTCLOUD"
    GAUSSIAN_SPLAT = "GAUSSIAN_SPLAT"
    TOPOLOGY_JSON = "TOPOLOGY_JSON"


class LOD(enum.Enum):
    """三维建模分级。"""

    L0 = "L0"  # 二维地图
    L1 = "L1"  # 2.5D
    L2 = "L2"  # 轻量三维 GLB
    L3 = "L3"  # 高写实局部场景


def compute_checksum(content_bytes):
    """计算内容 sha256 十六进制摘要。"""
    return hashlib.sha256(content_bytes).hexdigest()


def new_asset_id(prefix="AST"):
    """生成空间资产 ID，如 AST-a1b2c3d4。"""
    return new_id(prefix)


@dataclass
class SpatialAsset:
    """空间资产：含类型、LOD、所属实体、URI、版本、来源、校验和与来源说明。"""

    asset_id: str
    name: str
    asset_type: AssetType
    lod: LOD
    spatial_scope: Optional[str] = None  # 所属空间实体 entity_id
    uri: str = ""
    version: int = 1
    source_type: str = "real"
    created_at: str = ""
    checksum: str = ""
    provenance: str = ""  # 来源说明：CAD / 扫描 / 摄影测量 等

    def __post_init__(self):
        if isinstance(self.asset_type, str):
            self.asset_type = AssetType(self.asset_type)
        if isinstance(self.lod, str):
            self.lod = LOD(self.lod)
        if not self.created_at:
            self.created_at = now_iso()


class AssetRegistry:
    """空间资产注册表：按 (name, asset_type) 维护版本历史。"""

    def __init__(self):
        self._by_id = {}  # asset_id -> SpatialAsset
        self._history = {}  # (name, asset_type_value) -> list[SpatialAsset]

    @staticmethod
    def _type_value(asset_type):
        return asset_type.value if isinstance(asset_type, AssetType) else asset_type

    @staticmethod
    def _lod_value(lod):
        return lod.value if isinstance(lod, LOD) else lod

    def register(self, asset):
        """注册资产；若 (name, asset_type) 已存在则递增版本并保留历史。"""
        key = (asset.name, asset.asset_type.value)
        history = self._history.setdefault(key, [])
        asset.version = history[-1].version + 1 if history else 1
        history.append(asset)
        self._by_id[asset.asset_id] = asset
        return asset

    def get(self, asset_id):
        return self._by_id.get(asset_id)

    def latest(self, name, asset_type):
        """返回某 (name, asset_type) 的最新版本；无则 None。"""
        history = self._history.get((name, self._type_value(asset_type)))
        return history[-1] if history else None

    def history(self, name, asset_type):
        """返回某 (name, asset_type) 的全部版本（按注册顺序）。"""
        return list(self._history.get((name, self._type_value(asset_type)), []))

    def by_scope(self, entity_id):
        """返回属于某空间实体的资产（每个 name+type 取最新版本）。"""
        out = []
        for history in self._history.values():
            latest_asset = history[-1]
            if latest_asset.spatial_scope == entity_id:
                out.append(latest_asset)
        return out

    def by_lod(self, lod):
        """返回某 LOD 的资产（每个 name+type 取最新版本）。"""
        lval = self._lod_value(lod)
        out = []
        for history in self._history.values():
            latest_asset = history[-1]
            if latest_asset.lod.value == lval:
                out.append(latest_asset)
        return out
