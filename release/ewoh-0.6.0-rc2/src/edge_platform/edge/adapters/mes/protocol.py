"""MES 厂商工单事件解析为统一语义工单消息。

对应 spec「多传感器适配扩展」：MES 数据同样适用来源标识与隔离；
厂商私有字段（erp_internal_code、cost_center 等）不泄漏到上层业务。
"""

from edge_platform.spatial import now_iso


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_work_order(raw, default_source_type="real"):
    """将厂商工单事件 dict 转换为统一语义工单消息。

    支持的厂商字段别名：
      task_id / wo_id / order_id          -> task_id
      task_name / wo_name / name          -> task_name
      station_id / station                -> station_id
      required_skill / skill / skill_req  -> required_skill
      load_level / load                   -> load_level
      status / state                      -> status
      assigned_person_id / person_id / worker_id -> assigned_person_id
      ts / timestamp / time               -> ts
      source_type                         -> source_type
    厂商私有字段（erp_internal_code、cost_center 等）不会进入统一帧。
    """
    if not isinstance(raw, dict):
        raise TypeError("raw 必须为 dict")

    def pick(*keys, default=None):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    return {
        "task_id": pick("task_id", "wo_id", "order_id"),
        "task_name": pick("task_name", "wo_name", "name"),
        "station_id": pick("station_id", "station"),
        "required_skill": pick("required_skill", "skill", "skill_req"),
        "load_level": _f(pick("load_level", "load"), default=0.0),
        "status": pick("status", "state", default="unknown"),
        "assigned_person_id": pick("assigned_person_id", "person_id", "worker_id"),
        "ts": pick("ts", "timestamp", "time", default=now_iso()),
        "source_type": pick("source_type", default=default_source_type),
    }
