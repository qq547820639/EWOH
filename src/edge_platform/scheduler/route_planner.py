"""路线规划：把人员/设备当前位置映射到工位拓扑节点，求到达目标工位的路线。

- GraphRoutePlanner：基于 spatial Topology 的 Dijkstra 最短路径（复用 topology.shortest_path），
  ETA = distance_m / walk_speed_m_per_s。
- EuclideanRoutePlanner：退化实现，无拓扑时用 spatial.distance 算直线距离。
- build_route_planner：工厂函数，有拓扑返回拓扑版，否则返回欧氏版。

安全与可达性：不可达或被 blocked 的路线 reachable=False，在规划阶段即被拦截，
不进入后续候选/评分流程。

纯 Python 标准库实现。
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from edge_platform.spatial import Pose, distance


def _to_xy(loc):
    """从 dict 位置提取 (x, y)；缺省返回 (None, None)。兼容 {x,y} 与 {pose:{x,y}}。"""
    if not isinstance(loc, dict):
        return None, None
    pose = loc.get("pose")
    if isinstance(pose, dict):
        return pose.get("x"), pose.get("y")
    x, y = loc.get("x"), loc.get("y")
    if x is None and y is None:
        x, y = loc.get("px"), loc.get("py")
    return x, y


def _node_xy(node):
    """从拓扑节点对象提取 (x,y)；无坐标则返回 (None, None)。"""
    for attr in ("location", "pose", "coordinates"):
        v = getattr(node, attr, None)
        if isinstance(v, dict):
            x, y = _to_xy(v)
            if x is not None and y is not None:
                return float(x), float(y)
    return None, None


@dataclass
class Route:
    """路线结果：起止节点、距离、ETA、路径节点列表、几何与可达性。"""

    from_id: str = ""
    to_id: str = ""
    distance_m: float = 0.0
    eta_sec: int = 0
    nodes: list = field(default_factory=list)
    geometry: list = field(default_factory=list)
    reachable: bool = True
    blocked_reason: str = ""

    def to_dict(self):
        return {
            "from_id": self.from_id,
            "to_id": self.to_id,
            "distance_m": self.distance_m,
            "eta_sec": self.eta_sec,
            "nodes": list(self.nodes),
            "geometry": list(self.geometry),
            "reachable": self.reachable,
            "blocked_reason": self.blocked_reason,
        }


class RoutePlanner(ABC):
    """路线规划器抽象基类。"""

    @abstractmethod
    def calculate_route(self, from_loc, to_station_id, topology=None, blocked_nodes=None):
        """计算从 from_loc 到目标工位 to_station_id 的 Route。"""
        raise NotImplementedError


class GraphRoutePlanner(RoutePlanner):
    """基于空间 Topology 的最短路径路线规划。"""

    def __init__(self, topology, walk_speed_m_per_s=1.4):
        self.topology = topology
        self.walk_speed_m_per_s = float(walk_speed_m_per_s or 1.4)

    def _resolve_start_node(self, from_loc):
        """把 from_loc 映射到最近拓扑节点（节点 id 即 station_id）。"""
        if isinstance(from_loc, dict):
            station_id = from_loc.get("station_id")
            if station_id:
                return station_id
        # 否则遍历 topology.nodes() 找最近节点（用 spatial.distance 比较）
        x, y = _to_xy(from_loc)
        best_id, best_dist = None, None
        for node in self.topology.nodes():
            nx, ny = _node_xy(node)
            if nx is None or ny is None:
                continue
            d = distance(Pose(x=x or 0.0, y=y or 0.0), Pose(x=nx, y=ny))
            if best_dist is None or d < best_dist:
                best_id, best_dist = node.node_id, d
        return best_id

    def calculate_route(self, from_loc, to_station_id, topology=None, blocked_nodes=None):
        topology = topology or self.topology
        blocked_nodes = set(blocked_nodes or ())
        start_node = self._resolve_start_node(from_loc)
        if not start_node:
            return Route(
                from_id="",
                to_id=to_station_id,
                reachable=False,
                blocked_reason="无法将当前位置映射到拓扑节点",
            )
        if to_station_id in blocked_nodes or start_node in blocked_nodes:
            return Route(
                from_id=start_node,
                to_id=to_station_id,
                reachable=False,
                blocked_reason="起点或终点节点处于阻断状态",
            )
        dist_m, path = topology.shortest_path(start_node, to_station_id)
        if dist_m is None:
            return Route(
                from_id=start_node,
                to_id=to_station_id,
                reachable=False,
                blocked_reason="拓扑中起点到终点不可达",
            )
        eta = int(round(dist_m / self.walk_speed_m_per_s)) if self.walk_speed_m_per_s else 0
        return Route(
            from_id=start_node,
            to_id=to_station_id,
            distance_m=float(dist_m),
            eta_sec=eta,
            nodes=list(path),
            reachable=True,
        )


class EuclideanRoutePlanner(RoutePlanner):
    """欧氏距离直线路线规划（无拓扑时的退化实现）。"""

    def calculate_route(self, from_loc, to_station_id, topology=None, blocked_nodes=None):
        blocked_nodes = set(blocked_nodes or ())
        x, y = _to_xy(from_loc)
        to_xy = _to_xy(to_station_id) if isinstance(to_station_id, dict) else (None, None)
        if blocked_nodes and to_station_id in blocked_nodes:
            return Route(
                from_id="",
                to_id=to_station_id,
                reachable=False,
                blocked_reason="目标节点处于阻断状态",
            )
        if x is None or y is None:
            return Route(
                from_id="",
                to_id=to_station_id,
                reachable=False,
                blocked_reason="缺少起点坐标，无法计算欧氏路线",
            )
        tx, ty = to_xy
        if tx is None or ty is None:
            tx, ty = (x + 1.0, y + 1.0)  # 无目标坐标时按单位距离占位
        d = distance(Pose(x=float(x), y=float(y)), Pose(x=float(tx), y=float(ty)))
        return Route(
            from_id="",
            to_id=to_station_id,
            distance_m=float(d),
            eta_sec=int(round(d)),
            nodes=[],
            geometry=[[x, y], [tx, ty]],
            reachable=True,
        )


def build_route_planner(topology=None):
    """工厂函数：有拓扑则返回 GraphRoutePlanner，否则返回 EuclideanRoutePlanner。"""
    if topology is not None:
        return GraphRoutePlanner(topology)
    return EuclideanRoutePlanner()
