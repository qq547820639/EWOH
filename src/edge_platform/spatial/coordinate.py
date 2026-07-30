"""统一空间坐标体系（2.5D）。

工厂坐标系约定：
- 单位：米（m）。
- 原点：经测绘确定的基准点（surveyed datum）。
- 轴向：+X 东、+Y 北、+Z 上（右手系）。
- 朝向 yaw_deg：自正北（+Y）顺时针计角，单位度；yaw=0 表示面朝正北。

本模块提供位姿 Pose、坐标变换（世界↔局部，平移 + 绕 Z 轴 yaw 旋转）、XY 平面距离、
轴对齐边界框 BoundingBox。仅 2.5D（x/y/z + yaw），足以支撑 L0 二维地图与 L1 2.5D 场景。

纯 Python 标准库实现。
"""

import math
from dataclasses import dataclass


@dataclass
class Pose:
    """空间位姿：位置 (x,y,z) + 朝向 yaw_deg，附数据来源与置信度。"""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    yaw_deg: float = 0.0
    source: str = ""          # 数据来源标识，如 uwb / vision / imu_fusion / cad
    confidence: float = 1.0   # 0..1

    def to_dict(self):
        return {
            "x": self.x, "y": self.y, "z": self.z, "yaw_deg": self.yaw_deg,
            "source": self.source, "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            x=d.get("x", 0.0), y=d.get("y", 0.0), z=d.get("z", 0.0),
            yaw_deg=d.get("yaw_deg", 0.0),
            source=d.get("source", ""), confidence=d.get("confidence", 1.0),
        )


@dataclass
class BoundingBox:
    """轴对齐矩形边界框（XY 平面，米制）。"""
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    def contains(self, pose):
        """位姿是否落在边界框内（边界含端点）。"""
        return (self.min_x <= pose.x <= self.max_x
                and self.min_y <= pose.y <= self.max_y)

    def intersects(self, other):
        """与另一边界框是否相交。"""
        if other.max_x < self.min_x or other.min_x > self.max_x:
            return False
        if other.max_y < self.min_y or other.min_y > self.max_y:
            return False
        return True

    def to_dict(self):
        return {"min_x": self.min_x, "min_y": self.min_y,
                "max_x": self.max_x, "max_y": self.max_y}

    @classmethod
    def from_dict(cls, d):
        return cls(min_x=d["min_x"], min_y=d["min_y"],
                   max_x=d["max_x"], max_y=d["max_y"])


def world_to_local(pose, origin):
    """世界坐标 -> 局部坐标（origin 为参考位姿：平移 + 绕 Z 轴 yaw 旋转）。

    局部系：+X 朝 origin 朝向（前向），+Y 朝左手侧；与右手系一致。
    朝向角同步变换：local_yaw = world_yaw - origin.yaw_deg。
    """
    theta = math.radians(origin.yaw_deg)
    sin_t, cos_t = math.sin(theta), math.cos(theta)
    dx = pose.x - origin.x
    dy = pose.y - origin.y
    return Pose(
        x=sin_t * dx + cos_t * dy,
        y=-cos_t * dx + sin_t * dy,
        z=pose.z - origin.z,
        yaw_deg=pose.yaw_deg - origin.yaw_deg,
        source=pose.source,
        confidence=pose.confidence,
    )


def local_to_world(pose, origin):
    """局部坐标 -> 世界坐标（world_to_local 的逆变换）。"""
    theta = math.radians(origin.yaw_deg)
    sin_t, cos_t = math.sin(theta), math.cos(theta)
    return Pose(
        x=sin_t * pose.x - cos_t * pose.y + origin.x,
        y=cos_t * pose.x + sin_t * pose.y + origin.y,
        z=pose.z + origin.z,
        yaw_deg=pose.yaw_deg + origin.yaw_deg,
        source=pose.source,
        confidence=pose.confidence,
    )


def distance(a, b):
    """XY 平面欧氏距离（米）；忽略 z。"""
    return math.hypot(a.x - b.x, a.y - b.y)
