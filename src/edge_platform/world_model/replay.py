"""时间轴回放与决策解释。

Replay 基于 StateStore + EventGraph 重建任意时刻的世界状态快照、对比实体在两个时间点的状态差异、
沿因果链解释调度决策、生成班次摘要。对应 spec「工厂世界模型层」之「沿时间轴回放事件、解释决策、
评估改进效果」与「因果链追溯」场景。纯 Python 标准库实现。
"""

from typing import Dict, Any, List

from edge_platform.inference import ts_to_ms, ms_to_ts


# 节点类型 -> 中文标签（决策解释用）
NODE_TYPE_LABELS = {
    "ENTER_ZONE": "进入区域",
    "BIND_EXO": "与外骨骼绑定",
    "CLAIM_TASK": "领取任务",
    "ARRIVE_STATION": "到达工位",
    "START_ACTION": "开始搬运动作",
    "LOAD_RISE": "累计负荷上升",
    "BATTERY_DROP": "外骨骼电量下降",
    "STATION_BACKLOG": "工位出现积压",
    "SUGGESTION": "系统生成调度建议",
    "CONFIRM": "班组长确认",
    "REALLOCATE": "任务重新分配",
    "FEEDBACK": "结果回流",
    "SENSOR_CONFLICT": "传感器冲突",
    "PREDICTION": "短期预测",
}


class Replay:
    """时间轴回放器：状态快照 + 事件流 + 决策解释 + 班次摘要。"""

    def __init__(self, state_store, event_graph):
        self.state_store = state_store
        self.event_graph = event_graph

    def at(self, ts):
        """重建 ts 时刻世界状态快照：每个实体的有效状态 + ts 及之前的事件流。"""
        target_ms = ts_to_ms(ts)
        states: Dict[str, Dict[str, Any]] = {}
        for (entity_id, state_type) in self.state_store.all_keys():
            s = self.state_store.at_time(entity_id, state_type, ts)
            if s is None:
                continue
            states.setdefault(entity_id, {})[state_type] = s.to_dict()
        events = [n.to_dict() for n in self.event_graph.all_nodes()
                  if ts_to_ms(n.ts) <= target_ms]
        events.sort(key=lambda d: ts_to_ms(d["ts"]))
        return {"ts": ts, "states": states, "events": events}

    def compare(self, t1, t2, entity_id):
        """对比某实体在 t1/t2 两个时刻的状态差异，返回 before/after。"""
        before: Dict[str, Any] = {}
        after: Dict[str, Any] = {}
        for st in self.state_store.state_types(entity_id):
            b = self.state_store.at_time(entity_id, st, t1)
            a = self.state_store.at_time(entity_id, st, t2)
            if b is not None:
                before[st] = b.to_dict()
            if a is not None:
                after[st] = a.to_dict()
        return {
            "entity_id": entity_id,
            "t1": t1,
            "t2": t2,
            "before": before,
            "after": after,
        }

    def explain_decision(self, node_id):
        """沿因果链解释调度决策，返回中文说明字符串。

        对 SUGGESTION/CONFIRM 等决策节点，引用其因果链上的累计负荷上升、电量下降、
        工位积压、确认与结果回流等上下文。
        """
        chain = self.event_graph.chain(node_id)
        if not chain:
            return ""
        head = chain[-1]
        head_label = NODE_TYPE_LABELS.get(head.node_type, head.node_type)
        parts = [self._describe_node(n) for n in chain]
        return "决策解释：%s 的因果链（共 %d 步）：%s。" % (
            head_label, len(chain), " → ".join(parts),
        )

    def _describe_node(self, node):
        """单节点的中文片段，引用关键载荷字段。"""
        p = node.payload_json or {}
        t = node.node_type
        if t == "ENTER_ZONE":
            return "员工 %s 进入区域 %s" % (p.get("person_id", "?"), p.get("zone_id", "?"))
        if t == "BIND_EXO":
            return "与外骨骼 %s 绑定" % p.get("device_id", "?")
        if t == "CLAIM_TASK":
            return "领取任务 %s" % p.get("task_id", "?")
        if t == "ARRIVE_STATION":
            return "到达工位 %s" % p.get("station_id", "?")
        if t == "START_ACTION":
            return "开始%s动作" % p.get("action", "搬运")
        if t == "LOAD_RISE":
            return "累计负荷上升至 %s" % p.get("load_score", p.get("value", "?"))
        if t == "BATTERY_DROP":
            return "外骨骼电量下降至 %s%%" % p.get("battery_pct", "?")
        if t == "STATION_BACKLOG":
            return "工位 %s 出现积压（待处理 %s 件）" % (
                p.get("station_id", "?"), p.get("backlog", "?"))
        if t == "SUGGESTION":
            return "系统生成调度建议（%s）" % p.get("suggestion", "建议换人接替")
        if t == "CONFIRM":
            action = p.get("action", "confirm")
            verb = "已确认" if action == "confirm" else "已驳回"
            return "班组长%s（由 %s 操作）" % (verb, p.get("confirmed_by", "班组长"))
        if t == "REALLOCATE":
            return "任务 %s 重新分配给 %s" % (p.get("task_id", "?"), p.get("new_assignee", "?"))
        if t == "FEEDBACK":
            return "结果回流：%s" % p.get("outcome", "已执行")
        return NODE_TYPE_LABELS.get(t, t)

    def shift_summary(self, person_id, from_ts, to_ts):
        """班次摘要：动作数、峰值负荷、事件数、建议生成与确认/驳回数。"""
        from_ms = ts_to_ms(from_ts)
        to_ms = ts_to_ms(to_ts)
        nodes = [n for n in self.event_graph.all_nodes()
                 if from_ms <= ts_to_ms(n.ts) <= to_ms
                 and (n.payload_json or {}).get("person_id") == person_id]
        actions = [n for n in nodes if n.node_type == "START_ACTION"]
        peak_load = None
        for n in nodes:
            if n.node_type != "LOAD_RISE":
                continue
            v = (n.payload_json or {}).get("load_score")
            if v is None:
                continue
            if peak_load is None or v > peak_load:
                peak_load = v
        suggestions = [n for n in nodes if n.node_type == "SUGGESTION"]
        confirms = [n for n in nodes if n.node_type == "CONFIRM"]
        confirmed = sum(1 for n in confirms
                        if (n.payload_json or {}).get("action", "confirm") == "confirm")
        rejected = len(confirms) - confirmed
        return {
            "person_id": person_id,
            "from_ts": from_ts,
            "to_ts": to_ts,
            "action_count": len(actions),
            "peak_load": peak_load,
            "event_count": len(nodes),
            "suggestion_count": len(suggestions),
            "suggestions_confirmed": confirmed,
            "suggestions_rejected": rejected,
        }
