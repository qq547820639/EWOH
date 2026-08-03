"""UWB 厂商帧解析为统一语义位置消息。

对应 spec「统一语义转换」：厂商私有字段（如 anchor_distances、vendor_tag_id、
raw_rssi）经本模块映射为统一消息
{tag_id, person_id, x, y, z, quality_status, confidence, ts, source_type, beacon_ids}，
未映射字段不进入上层业务。

简化假设（纯 stdlib，已固化在字段字典中）：
- 若厂商帧直接提供 pos_x/pos_y/pos_z 或 x/y/z（厂商已完成定位解算），则直接采用；
- 若仅提供 anchor_distances（beacon_id -> 距离米），则用参与测距锚点的加权质心
  作为 trilateration 的简化 stub（真实部署应替换为最小二乘解算，但接口契约不变）；
- 若两者均无，返回 quality_status='invalid' 的占位消息，不抛异常。
"""

from edge_platform.spatial import now_iso


def _centroid_from_anchors(anchor_distances, beacons):
    """简化 trilateration stub：用参与测距的锚点位置加权质心作为位置估计。

    权重取 1/(d+0.1)，距离越近权重越高；仅做工程可用的近似，不保证精度。
    真实部署应由厂商或融合层提供精确解算结果。
    """
    if not anchor_distances or not beacons:
        return None
    bmap = {b.beacon_id: b for b in beacons}
    sx = sy = sz = sw = 0.0
    for bid, d in anchor_distances.items():
        b = bmap.get(bid)
        if b is None:
            continue
        try:
            d = float(d)
        except (TypeError, ValueError):
            continue
        w = 1.0 / (max(0.0, d) + 0.1)
        sx += b.x * w
        sy += b.y * w
        sz += b.z * w
        sw += w
    if sw <= 0:
        return None
    return sx / sw, sy / sw, sz / sw


def parse_uwb_frame(raw, beacons=None, tags=None, default_source_type="real"):
    """将厂商 UWB 原始帧 dict 转换为统一语义位置消息。

    支持的厂商字段（按优先级，仅列出常见别名）：
      tag_id / tag / vendor_tag_id  -> tag_id
      person_id / worker_id         -> person_id
      pos_x/pos_y/pos_z             -> x/y/z（厂商已解算）
      x/y/z                         -> x/y/z（厂商已解算，备选）
      anchor_distances              -> 通过质心 stub 解算 x/y/z
      confidence / conf             -> confidence
      quality / quality_status      -> quality_status
      ts / timestamp / time         -> ts
      source_type                   -> source_type（默认 default_source_type）
      beacon_ids / anchors          -> beacon_ids
    厂商私有字段（raw_rssi、vendor_internal 等）不会进入统一帧。
    """
    if not isinstance(raw, dict):
        raise TypeError("raw 必须为 dict")
    beacons = beacons or []
    tags = tags or {}

    def pick(*keys, default=None):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    tag_id = pick("tag_id", "tag", "vendor_tag_id")
    person_id = pick("person_id", "worker_id")
    if person_id is None and tag_id in tags:
        person_id = tags[tag_id].person_id

    x = pick("pos_x", "x")
    y = pick("pos_y", "y")
    z = pick("pos_z", "z")

    if x is None or y is None:
        # 尝试通过 anchor_distances 质心估计
        anchor_distances = pick("anchor_distances", "distances")
        if anchor_distances:
            est = _centroid_from_anchors(anchor_distances, beacons)
            if est is not None:
                x, y, z = est

    quality_status = pick("quality_status", "quality", default="unknown")
    if x is None or y is None:
        quality_status = "invalid"
        x = x if x is not None else 0.0
        y = y if y is not None else 0.0
        z = z if z is not None else 0.0
    elif quality_status == "unknown":
        quality_status = "good"
    # z 缺失但 x/y 有效时默认 0.0（平面定位，多数 UWB 部署仅解算 XY）
    if z is None:
        z = 0.0

    confidence = pick("confidence", "conf")
    try:
        confidence = float(confidence) if confidence is not None else 0.5
    except (TypeError, ValueError):
        confidence = 0.5

    ts = pick("ts", "timestamp", "time", default=now_iso())
    source_type = pick("source_type", default=default_source_type)

    beacon_ids = pick("beacon_ids", "anchors")
    if beacon_ids is None and isinstance(raw.get("anchor_distances"), dict):
        beacon_ids = list(raw["anchor_distances"].keys())
    if beacon_ids is None:
        beacon_ids = [b.beacon_id for b in beacons]

    return {
        "tag_id": tag_id,
        "person_id": person_id,
        "x": float(x),
        "y": float(y),
        "z": float(z),
        "quality_status": quality_status,
        "confidence": confidence,
        "ts": ts,
        "source_type": source_type,
        "beacon_ids": list(beacon_ids),
    }
