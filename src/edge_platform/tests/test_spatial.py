"""空间数字底座单元测试：坐标变换 / 空间实体 / 拓扑 / 资产注册表。"""

import hashlib
import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.spatial.coordinate import (
    Pose, BoundingBox, world_to_local, local_to_world, distance,
)
from edge_platform.spatial.entities import (
    EntityType, SpatialEntity, SpatialRegistry, new_entity_id,
)
from edge_platform.spatial.topology import (
    TopologyNode, TopologyEdge, Topology, route_length,
)
from edge_platform.spatial.asset_registry import (
    AssetType, LOD, SpatialAsset, AssetRegistry, compute_checksum, new_asset_id,
)


# ---------- 坐标 ----------
class CoordinateTest(unittest.TestCase):
    def test_transform_roundtrip(self):
        origin = Pose(x=10.0, y=20.0, z=1.0, yaw_deg=37.0)
        p = Pose(x=33.5, y=-7.2, z=3.0, yaw_deg=120.0, source="uwb", confidence=0.8)
        back = local_to_world(world_to_local(p, origin), origin)
        self.assertAlmostEqual(back.x, p.x, places=9)
        self.assertAlmostEqual(back.y, p.y, places=9)
        self.assertAlmostEqual(back.z, p.z, places=9)
        self.assertAlmostEqual(back.yaw_deg, p.yaw_deg, places=9)
        self.assertEqual(back.source, p.source)
        self.assertAlmostEqual(back.confidence, p.confidence, places=9)

    def test_transform_convention_facing_north(self):
        # origin 朝正北（yaw=0）：世界正北 5m → 局部前向 5m；世界正东 5m → 局部右侧 -5m
        origin = Pose(x=0.0, y=0.0, z=0.0, yaw_deg=0.0)
        north = world_to_local(Pose(x=0.0, y=5.0), origin)
        self.assertAlmostEqual(north.x, 5.0, places=9)
        self.assertAlmostEqual(north.y, 0.0, places=9)
        east = world_to_local(Pose(x=5.0, y=0.0), origin)
        self.assertAlmostEqual(east.x, 0.0, places=9)
        self.assertAlmostEqual(east.y, -5.0, places=9)

    def test_distance(self):
        a = Pose(x=0.0, y=0.0)
        self.assertAlmostEqual(distance(a, Pose(x=3.0, y=4.0)), 5.0, places=9)
        # XY 平面距离，忽略 z
        self.assertAlmostEqual(distance(a, Pose(x=3.0, y=4.0, z=100.0)), 5.0, places=9)
        self.assertAlmostEqual(distance(a, a), 0.0, places=9)

    def test_bbox_contains_intersects(self):
        bb = BoundingBox(min_x=0.0, min_y=0.0, max_x=10.0, max_y=10.0)
        self.assertTrue(bb.contains(Pose(x=5.0, y=5.0)))
        self.assertTrue(bb.contains(Pose(x=0.0, y=0.0)))      # 边界含端点
        self.assertTrue(bb.contains(Pose(x=10.0, y=10.0)))
        self.assertFalse(bb.contains(Pose(x=10.01, y=5.0)))
        self.assertFalse(bb.contains(Pose(x=5.0, y=-0.01)))
        # 相交
        self.assertTrue(bb.intersects(BoundingBox(5.0, 5.0, 15.0, 15.0)))
        self.assertTrue(bb.intersects(BoundingBox(2.0, 2.0, 8.0, 8.0)))   # 完全包含
        self.assertFalse(bb.intersects(BoundingBox(20.0, 20.0, 30.0, 30.0)))


# ---------- 空间实体 ----------
class EntityTest(unittest.TestCase):
    def _build_tree(self):
        reg = SpatialRegistry()
        nodes = [
            SpatialEntity("F1", EntityType.FACTORY, name="1号工厂"),
            SpatialEntity("WS1", EntityType.WORKSHOP, parent_id="F1", name="A车间"),
            SpatialEntity("L1", EntityType.LINE, parent_id="WS1", name="产线1"),
            SpatialEntity("Z1", EntityType.ZONE, parent_id="L1", name="打包区"),
            SpatialEntity("S1", EntityType.STATION, parent_id="Z1", name="工位A"),
        ]
        for e in nodes:
            reg.register(e)
        return reg

    def test_register_and_get(self):
        reg = self._build_tree()
        self.assertEqual(reg.get("S1").name, "工位A")
        self.assertIsNone(reg.get("NOPE"))

    def test_parent_validation(self):
        reg = SpatialRegistry()
        with self.assertRaises(ValueError):
            reg.register(SpatialEntity("X", EntityType.ZONE, parent_id="MISSING"))
        # 根实体 parent_id=None 不校验
        reg.register(SpatialEntity("ROOT", EntityType.FACTORY))
        self.assertIsNotNone(reg.get("ROOT"))

    def test_children_ancestors_descendants(self):
        reg = self._build_tree()
        self.assertEqual([e.entity_id for e in reg.children("F1")], ["WS1"])
        self.assertEqual([e.entity_id for e in reg.ancestors("S1")],
                         ["Z1", "L1", "WS1", "F1"])
        self.assertEqual({e.entity_id for e in reg.descendants("F1")},
                         {"WS1", "L1", "Z1", "S1"})
        self.assertEqual(reg.descendants("S1"), [])

    def test_by_type(self):
        reg = self._build_tree()
        self.assertEqual([e.entity_id for e in reg.by_type(EntityType.STATION)], ["S1"])
        # 字符串值同样支持
        self.assertEqual(len(reg.by_type("ZONE")), 1)
        self.assertEqual(reg.by_type(EntityType.PERSON), [])

    def test_to_from_dict_roundtrip(self):
        e = SpatialEntity(
            "E1", EntityType.DEVICE, parent_id="S1", name="机械臂1",
            pose=Pose(x=1.5, y=2.5, z=0.0, yaw_deg=90.0, source="cad", confidence=0.95),
            bbox=BoundingBox(0, 0, 3, 3), status="active", source_type="real",
            confidence=0.9, version=3,
        )
        d = e.to_dict()
        self.assertEqual(d["entity_type"], "DEVICE")
        self.assertEqual(d["pose"]["x"], 1.5)
        e2 = SpatialEntity.from_dict(d)
        self.assertEqual(e2.entity_id, "E1")
        self.assertEqual(e2.entity_type, EntityType.DEVICE)
        self.assertAlmostEqual(e2.pose.x, 1.5)
        self.assertAlmostEqual(e2.pose.yaw_deg, 90.0)
        self.assertEqual(e2.bbox.max_x, 3)
        self.assertEqual(e2.version, 3)
        # 二次往返稳定
        self.assertEqual(e2.to_dict(), d)

    def test_touch_bumps_version(self):
        e = SpatialEntity("E2", EntityType.PERSON, name="张三")
        self.assertEqual(e.version, 1)
        self.assertTrue(e.updated_at)
        e.touch()
        self.assertEqual(e.version, 2)
        e.touch()
        self.assertEqual(e.version, 3)

    def test_new_entity_id(self):
        eid = new_entity_id("STN")
        self.assertTrue(eid.startswith("STN-"))
        self.assertEqual(len(eid), len("STN-") + 12)


# ---------- 拓扑 ----------
class TopologyTest(unittest.TestCase):
    def _triangle(self):
        t = Topology()
        t.add_node(TopologyNode("A", "工位A"))
        t.add_node(TopologyNode("B", "工位B"))
        t.add_node(TopologyNode("C", "工位C"))
        t.add_edge(TopologyEdge("A", "B", distance_m=1.0, route_geojson=[[0, 0], [1, 0]]))
        t.add_edge(TopologyEdge("B", "C", distance_m=1.0, route_geojson=[[1, 0], [2, 0]]))
        t.add_edge(TopologyEdge("A", "C", distance_m=3.0, route_geojson=[[0, 0], [2, 0]]))
        return t

    def test_neighbors(self):
        t = self._triangle()
        nb_ids = sorted(n for n, _ in t.neighbors("B"))
        self.assertEqual(nb_ids, ["A", "C"])
        self.assertEqual(t.neighbors("D"), [])

    def test_shortest_path(self):
        t = self._triangle()
        # 直接边 A-C=3.0，但 A-B-C=2.0 更短
        dist, path = t.shortest_path("A", "C")
        self.assertAlmostEqual(dist, 2.0, places=9)
        self.assertEqual(path, ["A", "B", "C"])
        # 同节点
        d0, p0 = t.shortest_path("A", "A")
        self.assertEqual(d0, 0.0)
        self.assertEqual(p0, ["A"])
        # 不可达（孤岛节点）
        t.add_node(TopologyNode("D", "孤岛"))
        d_none, p_none = t.shortest_path("A", "D")
        self.assertIsNone(d_none)
        self.assertIsNone(p_none)

    def test_geojson(self):
        gj = self._triangle().to_geojson()
        self.assertEqual(gj["type"], "FeatureCollection")
        self.assertEqual(len(gj["features"]), 3)
        for f in gj["features"]:
            self.assertEqual(f["type"], "Feature")
            self.assertEqual(f["geometry"]["type"], "LineString")
            self.assertIn("from_id", f["properties"])
            self.assertIn("to_id", f["properties"])
        self.assertEqual(gj["features"][0]["geometry"]["coordinates"], [[0, 0], [1, 0]])

    def test_geojson_skips_edge_without_geometry(self):
        t = Topology()
        t.add_node(TopologyNode("A"))
        t.add_node(TopologyNode("B"))
        t.add_edge(TopologyEdge("A", "B", distance_m=2.0))  # 无 route_geojson
        gj = t.to_geojson()
        self.assertEqual(gj["type"], "FeatureCollection")
        self.assertEqual(gj["features"], [])

    def test_to_from_dict_roundtrip(self):
        t = self._triangle()
        t2 = Topology.from_dict(t.to_dict())
        self.assertEqual(len(t2.nodes()), 3)
        self.assertEqual(len(t2.edges()), 3)
        dist, path = t2.shortest_path("A", "C")
        self.assertAlmostEqual(dist, 2.0, places=9)
        self.assertEqual(path, ["A", "B", "C"])

    def test_route_length(self):
        edges = [TopologyEdge("A", "B", 2.0), TopologyEdge("B", "C", 3.5)]
        self.assertAlmostEqual(route_length(edges), 5.5, places=9)
        self.assertEqual(route_length([]), 0.0)


# ---------- 资产注册表 ----------
class AssetRegistryTest(unittest.TestCase):
    def test_register_bumps_version_and_history(self):
        reg = AssetRegistry()
        a1 = SpatialAsset(new_asset_id(), "floor_map", AssetType.GEOJSON, LOD.L0)
        reg.register(a1)
        self.assertEqual(a1.version, 1)
        a2 = SpatialAsset(new_asset_id(), "floor_map", AssetType.GEOJSON, LOD.L0)
        reg.register(a2)
        self.assertEqual(a2.version, 2)
        hist = reg.history("floor_map", AssetType.GEOJSON)
        self.assertEqual(len(hist), 2)
        self.assertEqual([h.version for h in hist], [1, 2])
        latest = reg.latest("floor_map", AssetType.GEOJSON)
        self.assertIs(latest, a2)
        self.assertEqual(latest.version, 2)

    def test_get(self):
        reg = AssetRegistry()
        a = SpatialAsset("AST-fixed", "x", AssetType.GLB, LOD.L2)
        reg.register(a)
        self.assertIs(reg.get("AST-fixed"), a)
        self.assertIsNone(reg.get("missing"))

    def test_by_lod_and_scope(self):
        reg = AssetRegistry()
        a0 = SpatialAsset(new_asset_id(), "m0", AssetType.GEOJSON, LOD.L0, spatial_scope="WS1")
        a2 = SpatialAsset(new_asset_id(), "m2", AssetType.GLB, LOD.L2, spatial_scope="WS2")
        a0b = SpatialAsset(new_asset_id(), "m0b", AssetType.GEOJSON, LOD.L0, spatial_scope="WS1")
        for a in (a0, a2, a0b):
            reg.register(a)
        self.assertEqual({a.name for a in reg.by_lod(LOD.L0)}, {"m0", "m0b"})
        self.assertEqual(len(reg.by_lod(LOD.L2)), 1)
        self.assertEqual(reg.by_lod(LOD.L3), [])
        # 字符串 LOD 也支持
        self.assertEqual(len(reg.by_lod("L0")), 2)
        self.assertEqual({a.name for a in reg.by_scope("WS1")}, {"m0", "m0b"})
        self.assertEqual(reg.by_scope("WS9"), [])

    def test_by_lod_returns_latest_only(self):
        # 同名同类型注册两次 → by_lod 只返回最新版本
        reg = AssetRegistry()
        reg.register(SpatialAsset(new_asset_id(), "m", AssetType.GEOJSON, LOD.L0))
        reg.register(SpatialAsset(new_asset_id(), "m", AssetType.GEOJSON, LOD.L0))
        l0 = reg.by_lod(LOD.L0)
        self.assertEqual(len(l0), 1)
        self.assertEqual(l0[0].version, 2)

    def test_compute_checksum(self):
        h = compute_checksum(b"hello")
        self.assertEqual(len(h), 64)
        self.assertEqual(h, hashlib.sha256(b"hello").hexdigest())
        self.assertEqual(compute_checksum(b"hello"), h)
        self.assertNotEqual(compute_checksum(b"world"), h)

    def test_new_asset_id(self):
        aid = new_asset_id("TILES")
        self.assertTrue(aid.startswith("TILES-"))
        self.assertEqual(len(aid), len("TILES-") + 12)


if __name__ == "__main__":
    unittest.main()
