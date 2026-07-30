"""事件因果链：事件节点 + 因果边 + 因果链追溯。

EventNode 为事件节点（含 parent_id 因果前驱）；EventEdge 为节点间关系边
（caused/followed/triggered/confirmed/refuted）。EventGraph 提供节点/边增删、因果链 chain
（沿 parent_id 回溯到根）、descendants（沿 caused/followed 边前向）、find_by_type 时间窗查询
与 to_dict/from_dict。

build_shift_chain 把一个人员班次的原始事件序列链接为 spec 旗舰场景的 12 步因果链：
进入区域→与外骨骼绑定→领取任务→到达工位→开始搬运动作→累计负荷上升→外骨骼电量下降→
工位出现积压→系统生成调度建议→班组长确认→任务重新分配→结果回流。

对应 spec「工厂世界模型层」之「事件因果链」与「因果链追溯」场景。纯 Python 标准库实现。
"""

from dataclasses import dataclass
from typing import Optional, List, Dict, Any

from edge_platform.spatial import new_id, now_iso
from edge_platform.inference import ts_to_ms


# 班次因果链的 12 步规范节点类型（顺序即因果顺序）
SHIFT_CHAIN_NODE_TYPES = [
    "ENTER_ZONE", "BIND_EXO", "CLAIM_TASK", "ARRIVE_STATION",
    "START_ACTION", "LOAD_RISE", "BATTERY_DROP", "STATION_BACKLOG",
    "SUGGESTION", "CONFIRM", "REALLOCATE", "FEEDBACK",
]

# 节点关系类型
EDGE_RELATIONS = ("caused", "followed", "triggered", "confirmed", "refuted")


@dataclass
class EventNode:
    """事件节点：node_type 为枚举式字符串，parent_id 指向因果前驱（根为 None）。"""

    node_id: str
    node_type: str
    payload_json: Dict[str, Any]
    ts: str
    parent_id: Optional[str] = None
    source_type: str = "real"
    confidence: float = 1.0

    def to_dict(self):
        return {
            "node_id": self.node_id,
            "node_type": self.node_type,
            "payload_json": self.payload_json,
            "ts": self.ts,
            "parent_id": self.parent_id,
            "source_type": self.source_type,
            "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            node_id=d["node_id"],
            node_type=d["node_type"],
            payload_json=d.get("payload_json") or {},
            ts=d["ts"],
            parent_id=d.get("parent_id"),
            source_type=d.get("source_type", "real"),
            confidence=d.get("confidence", 1.0),
        )


@dataclass
class EventEdge:
    """事件因果边：relation ∈ caused/followed/triggered/confirmed/refuted。"""

    edge_id: str
    from_node: str
    to_node: str
    relation: str = "caused"

    def to_dict(self):
        return {
            "edge_id": self.edge_id,
            "from_node": self.from_node,
            "to_node": self.to_node,
            "relation": self.relation,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            edge_id=d["edge_id"],
            from_node=d["from_node"],
            to_node=d["to_node"],
            relation=d.get("relation", "caused"),
        )


class EventGraph:
    """事件因果图：节点字典 + 边列表，支持因果链追溯与前向遍历。"""

    def __init__(self):
        self._nodes: Dict[str, EventNode] = {}
        self._edges: List[EventEdge] = []

    def add_node(self, node_type, payload, ts, parent_id=None, source_type="real", confidence=1.0):
        """新增事件节点（自动生成 node_id）；parent_id 仅记录因果前驱，不自动连边。

        如需 descendants 前向遍历，请配合 link_causal 或 add_edge 追加 'caused' 边。
        """
        node = EventNode(
            node_id=new_id("EV"),
            node_type=node_type,
            payload_json=payload or {},
            ts=ts or now_iso(),
            parent_id=parent_id,
            source_type=source_type,
            confidence=confidence,
        )
        self._nodes[node.node_id] = node
        return node

    def add_edge(self, from_id, to_id, relation="caused"):
        """新增因果边。"""
        edge = EventEdge(
            edge_id=new_id("EDGE"),
            from_node=from_id,
            to_node=to_id,
            relation=relation,
        )
        self._edges.append(edge)
        return edge

    def link_causal(self, child_id, parent_id):
        """便捷因果链接：设置 child.parent_id=parent_id 并追加一条 'caused' 边。"""
        child = self._nodes.get(child_id)
        if child is None:
            raise KeyError("子节点不存在: %s" % child_id)
        if parent_id not in self._nodes:
            raise KeyError("父节点不存在: %s" % parent_id)
        child.parent_id = parent_id
        return self.add_edge(parent_id, child_id, "caused")

    def chain(self, node_id):
        """沿 parent_id 回溯到根，返回根在前的有序列表。"""
        out: List[EventNode] = []
        seen = set()
        cur = self._nodes.get(node_id)
        while cur is not None and cur.node_id not in seen:
            seen.add(cur.node_id)
            out.append(cur)
            if cur.parent_id is None:
                break
            cur = self._nodes.get(cur.parent_id)
        out.reverse()
        return out

    def descendants(self, node_id):
        """沿 'caused'/'followed' 边前向遍历，返回后代节点列表（不含自身，广度优先）。"""
        out: List[EventNode] = []
        seen = {node_id}
        queue = [node_id]
        while queue:
            cur = queue.pop(0)
            for e in self._edges:
                if e.from_node == cur and e.relation in ("caused", "followed") \
                        and e.to_node not in seen:
                    seen.add(e.to_node)
                    nxt = self._nodes.get(e.to_node)
                    if nxt is not None:
                        out.append(nxt)
                        queue.append(e.to_node)
        return out

    def find_by_type(self, node_type, from_ts=None, to_ts=None):
        """按 node_type 与 [from_ts, to_ts] 时间窗查询，返回时间升序结果。"""
        from_ms = ts_to_ms(from_ts) if from_ts else None
        to_ms = ts_to_ms(to_ts) if to_ts else None
        out = []
        for n in self._nodes.values():
            if n.node_type != node_type:
                continue
            t = ts_to_ms(n.ts)
            if from_ms is not None and t < from_ms:
                continue
            if to_ms is not None and t > to_ms:
                continue
            out.append(n)
        out.sort(key=lambda n: ts_to_ms(n.ts))
        return out

    def get(self, node_id):
        return self._nodes.get(node_id)

    def all_nodes(self):
        return list(self._nodes.values())

    def all_edges(self):
        return list(self._edges)

    def to_dict(self):
        return {
            "nodes": [n.to_dict() for n in self._nodes.values()],
            "edges": [e.to_dict() for e in self._edges],
        }

    @classmethod
    def from_dict(cls, d):
        g = cls()
        for nd in d.get("nodes", []):
            n = EventNode.from_dict(nd)
            g._nodes[n.node_id] = n
        for ed in d.get("edges", []):
            g._edges.append(EventEdge.from_dict(ed))
        return g


def build_shift_chain(graph, person_id, events):
    """把人员班次原始事件序列链接为 spec 旗舰 12 步因果链。

    events 为 dict 列表，每项可含 node_type/ts/payload/source_type/confidence/parent_id；
    按列表顺序依次建节点，相邻节点以 'caused' 边相连（前为父），返回建好的节点列表（顺序与输入一致）。
    每个节点载荷自动补 person_id，便于按人员检索与摘要。
    """
    nodes = []
    prev_id = None
    for ev in events:
        node_type = ev.get("node_type")
        ts_val = ev.get("ts") or now_iso()
        payload = dict(ev.get("payload") or {})
        payload.setdefault("person_id", person_id)
        source_type = ev.get("source_type", "real")
        confidence = ev.get("confidence", 1.0)
        explicit_parent = ev.get("parent_id")
        parent_id = explicit_parent if explicit_parent is not None else prev_id
        node = graph.add_node(
            node_type, payload, ts_val,
            source_type=source_type, confidence=confidence,
        )
        if parent_id is not None:
            graph.link_causal(node.node_id, parent_id)
        nodes.append(node)
        prev_id = node.node_id
    return nodes
