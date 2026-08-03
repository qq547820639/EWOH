"""环境传感器厂商读数解析为统一语义环境读数。

对应 spec「多传感器适配扩展」：环境传感器数据统一语义化、来源标识与隔离；
厂商私有字段（vendor_meta、raw_adc 等）不泄漏到上层业务。
"""

from edge_platform.spatial import now_iso


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_env_reading(raw, default_sensor_id=None, default_station_id=None, default_source_type="real"):
    """将厂商环境读数 dict 转换为统一语义读数。

    支持的厂商字段（按优先级，仅列出常见别名）：
      sensor_id / dev_id              -> sensor_id
      station_id / station            -> station_id
      temperature_c / temp / temp_c   -> temperature_c
      vibration_mm_s / vibration / vib-> vibration_mm_s
      noise_db / noise                -> noise_db
      air_quality_pm25 / pm25 / pm2_5 -> air_quality_pm25
      ts / timestamp / time           -> ts
      source_type                     -> source_type
      quality / quality_status        -> quality_status
    缺失字段：值置 None；quality_status 缺失时根据是否有关键测量决定 unknown/good。
    厂商私有字段（vendor_meta、raw_adc 等）不会进入统一帧。
    """
    if not isinstance(raw, dict):
        raise TypeError("raw 必须为 dict")

    def pick(*keys, default=None):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return default

    sensor_id = pick("sensor_id", "dev_id", default=default_sensor_id)
    station_id = pick("station_id", "station", default=default_station_id)
    temperature_c = _f(pick("temperature_c", "temp", "temp_c"))
    vibration_mm_s = _f(pick("vibration_mm_s", "vibration", "vib"))
    noise_db = _f(pick("noise_db", "noise"))
    air_quality_pm25 = _f(pick("air_quality_pm25", "pm25", "pm2_5"))
    ts = pick("ts", "timestamp", "time", default=now_iso())
    source_type = pick("source_type", default=default_source_type)
    quality_status = pick("quality_status", "quality", default="unknown")

    has_measure = any(v is not None for v in (temperature_c, vibration_mm_s, noise_db, air_quality_pm25))
    if quality_status == "unknown":
        quality_status = "good" if has_measure else "invalid"

    return {
        "sensor_id": sensor_id,
        "station_id": station_id,
        "temperature_c": temperature_c,
        "vibration_mm_s": vibration_mm_s,
        "noise_db": noise_db,
        "air_quality_pm25": air_quality_pm25,
        "ts": ts,
        "source_type": source_type,
        "quality_status": quality_status,
    }
