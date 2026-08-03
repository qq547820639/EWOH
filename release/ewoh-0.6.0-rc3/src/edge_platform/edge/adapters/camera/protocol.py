"""摄像头厂商检测帧解析为统一语义检测/骨架帧。

对应 spec「识别结果可追溯」：每个识别结果附带置信度、摄像头 ID、模型版本；
厂商私有字段（vendor_meta、raw_pixels 等）不泄漏到上层业务。
"""

from edge_platform.spatial import now_iso


def _norm_person(p):
    """将单个厂商人员检测 dict 映射为统一 {track_id, skeleton_json, bbox_xyxy, confidence}。"""
    if not isinstance(p, dict):
        return None
    track_id = p.get("track_id", p.get("id", p.get("person_id")))
    skeleton_json = p.get("skeleton_json", p.get("skeleton", p.get("keypoints")))
    bbox = p.get("bbox_xyxy")
    if bbox is None:
        bbox = p.get("bbox") or p.get("box")
        if isinstance(bbox, dict):
            bbox = [bbox.get("x1"), bbox.get("y1"), bbox.get("x2"), bbox.get("y2")]
    confidence = p.get("confidence", p.get("score", p.get("conf", 0.5)))
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.5
    return {
        "track_id": track_id,
        "skeleton_json": skeleton_json,
        "bbox_xyxy": list(bbox) if bbox else [],
        "confidence": confidence,
    }


def parse_detection(raw, camera_id=None, default_source_type="real", default_model_version="edge-pose-v0.1"):
    """将厂商检测原始 dict 转换为统一语义检测/骨架帧。

    支持的厂商字段：
      camera_id / cam_id / device_id  -> camera_id
      persons / detections / results  -> persons 列表
      ts / timestamp / time           -> ts
      source_type                     -> source_type
      model_version / model_ver       -> model_version
    厂商私有字段（vendor_meta、raw_pixels 等）不会进入统一帧。
    """
    if not isinstance(raw, dict):
        raise TypeError("raw 必须为 dict")

    cam = camera_id or raw.get("camera_id") or raw.get("cam_id") or raw.get("device_id")

    raw_persons = raw.get("persons") or raw.get("detections") or raw.get("results") or []
    persons = [p for p in (_norm_person(p) for p in raw_persons) if p is not None]

    ts = raw.get("ts") or raw.get("timestamp") or raw.get("time") or now_iso()
    source_type = raw.get("source_type", default_source_type)
    model_version = raw.get("model_version") or raw.get("model_ver") or default_model_version

    return {
        "camera_id": cam,
        "persons": persons,
        "ts": ts,
        "source_type": source_type,
        "model_version": model_version,
    }
