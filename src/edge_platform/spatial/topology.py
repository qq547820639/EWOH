"""工位 / 路线 / 邻接 JSON 拓扑与最短路径。

维护工位节点与路线边（带距离、可选 GeoJSON 路径几何），提供邻接查询、Dijkstra 最短路径、
GeoJSON FeatureCollection 导出与 dict 往返。边按无向处理（工厂内通道通常双向可走）。

纯 Python 标准库实现。
"""

import heapq
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class TopologyNode:
    """拓扑节点：node_id 对应工位 station_id。"""
    node_id: str
    label: str = ""


@dataclass
class TopologyEdge:
    """拓扑边：两工位间路线，带距离（米）与可选路径几何（坐标列表 [[x,y],...]）。"""
    from_id: str
    to_id: str
    distance_m: float = 0.0
    route_geojson: Optional[list] = None  # [[x, y], ...] 或 GeoJSON LineString dict


class Topology:
    """工位路线拓扑：节点 + 边，支持邻接、最短路径、GeoJSON 导出。"""

    def __init__(self):
        self._nodes = {}   # node_id -> TopologyNode
        self._edges = []   # list[TopologyEdge]

    def add_node(self, node):
        self._nodes[node.node_id] = node

    def add_edge(self, edge):
        self._edges.append(edge)

    def nodes(self):
        return list(self._nodes.values())

    def edges(self):
        return list(self._edges)

    def neighbors(self, node_id):
        """返回 [(neighbor_id, distance_m), ...]；边按无向处理。"""
        out = []
        for e in self._edges:
            if e.from_id == node_id:
                out.append((e.to_id, e.distance_m))
            elif e.to_id == node_id:
                out.append((e.from_id, e.distance_m))
        return out

    def _adjacency(self):
        adj = {}
        for e in self._edges:
            adj.setdefault(e.from_id, []).append((e.to_id, e.distance_m))
            adj.setdefault(e.to_id, []).append((e.from_id, e.distance_m))
        return adj

    def shortest_path(self, start, end):
        """Dijkstra 最短路径。返回 (distance_m, path)；不可达返回 (None, None)。"""
        if start == end:
            return (0.0, [start])
        adj = self._adjacency()
        dist = {start: 0.0}
        prev = {}
        pq = [(0.0, start)]
        visited = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in visited:
                continue
            visited.add(u)
            if u == end:
                break
            for v, w in adj.get(u, []):
                nd = d + w
                if v not in dist or nd < dist[v]:
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if end not in dist:
            return (None, None)
        path = [end]
        cur = end
        while cur in prev:
            cur = prev[cur]
            path.append(cur)
        path.reverse()
        return (dist[end], path)

    def to_geojson(self):
        """导出为 GeoJSON FeatureCollection，每条有几何的边一条 LineString。"""
        features = []
        for e in self._edges:
            coords = e.route_geojson
            if isinstance(coords, dict):
                coords = coords.get("coordinates")
            if not coords:
                continue  # 无几何信息的边不输出
            features.append({
                "type": "Feature",
                "properties": {
                    "from_id": e.from_id, "to_id": e.to_id,
                    "distance_m": e.distance_m,
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            })
        return {"type": "FeatureCollection", "features": features}

    def to_dict(self):
        return {
            "nodes": [{"node_id": n.node_id, "label": n.label}
                      for n in self._nodes.values()],
            "edges": [
                {"from_id": e.from_id, "to_id": e.to_id,
                 "distance_m": e.distance_m, "route_geojson": e.route_geojson}
                for e in self._edges
            ],
        }

    @classmethod
    def from_dict(cls, d):
        t = cls()
        for n in d.get("nodes", []):
            t.add_node(TopologyNode(node_id=n["node_id"], label=n.get("label", "")))
        for e in d.get("edges", []):
            t.add_edge(TopologyEdge(
                from_id=e["from_id"], to_id=e["to_id"],
                distance_m=e.get("distance_m", 0.0),
                route_geojson=e.get("route_geojson"),
            ))
        return t


def route_length(edges):
    """求一组边的距离总和（米）。"""
    return sum(e.distance_m for e in edges)
