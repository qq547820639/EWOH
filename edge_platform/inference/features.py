"""滑动窗特征提取（纯 Python）。

输入：一个窗口的标准遥测消息列表（默认 2s@20Hz=40 条）。
输出：12 维特征 dict；窗口样本不足或 invalid 占比 >30% 时返回 None。
"""

import math

from . import SAMPLE_HZ, WINDOW_SEC

# 特征名固定顺序，模型/报告均按此对齐
FEATURE_NAMES = [
    "pitch_mean", "pitch_std", "pitch_max",
    "roll_mean", "roll_std",
    "gyro_mag_mean", "gyro_mag_std", "gyro_mag_max",
    "accel_mag_std",
    "torque_mean", "torque_max",
    "assist_mean",
]

WINDOW_SIZE = WINDOW_SEC * SAMPLE_HZ          # 40
MIN_SAMPLES = int(WINDOW_SIZE * 0.75)         # 窗口样本不足阈值
MAX_INVALID_RATIO = 0.30                      # invalid 占比上限


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _std(xs):
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def _mag(vec):
    return math.sqrt(sum(float(v) ** 2 for v in vec))


def _num(v):
    """取数值；非有限数值返回 None。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _sample_values(msg):
    """从单条遥测取 (pitch, roll, gyro_mag, accel_mag, torque, assist)；字段缺失/非法返回 None。"""
    t = msg.get("telemetry") or {}
    pitch = _num(t.get("pitch_deg"))
    roll = _num(t.get("roll_deg"))
    torque = _num(t.get("torque_nm"))
    assist = _num(t.get("assist_level"))
    gyro = t.get("angular_velocity")
    accel = t.get("acceleration")
    if None in (pitch, roll, torque, assist):
        return None
    if not (isinstance(gyro, (list, tuple)) and len(gyro) == 3):
        return None
    if not (isinstance(accel, (list, tuple)) and len(accel) == 3):
        return None
    gyro = [_num(v) for v in gyro]
    accel = [_num(v) for v in accel]
    if None in gyro or None in accel:
        return None
    return pitch, roll, _mag(gyro), _mag(accel), torque, assist


def is_invalid(msg):
    """判定单条消息是否为 invalid（质量标记或关键字段不可用）。"""
    if (msg.get("quality") or {}).get("status") == "invalid":
        return True
    return _sample_values(msg) is None


def extract_features(window, min_samples=MIN_SAMPLES):
    """提取 12 维滑窗特征。

    window: 标准遥测消息列表。
    返回 dict（键见 FEATURE_NAMES）；样本不足或 invalid 占比超限时返回 None。
    """
    if not window or len(window) < min_samples:
        return None
    invalid = sum(1 for m in window if is_invalid(m))
    if invalid / len(window) > MAX_INVALID_RATIO:
        return None

    pitch, roll, gyro_mag, accel_mag, torque, assist = [], [], [], [], [], []
    for m in window:
        v = _sample_values(m)
        if v is None:
            continue  # invalid 样本不参与统计（占比已在上方约束）
        p, r, g, a, tq, al = v
        pitch.append(p)
        roll.append(r)
        gyro_mag.append(g)
        accel_mag.append(a)
        torque.append(tq)
        assist.append(al)
    if not pitch:
        return None  # 有效样本为空（占比约束已保证 >=70% 可用时才走到这里）

    return {
        "pitch_mean": _mean(pitch),
        "pitch_std": _std(pitch),
        "pitch_max": max(pitch),
        "roll_mean": _mean(roll),
        "roll_std": _std(roll),
        "gyro_mag_mean": _mean(gyro_mag),
        "gyro_mag_std": _std(gyro_mag),
        "gyro_mag_max": max(gyro_mag),
        "accel_mag_std": _std(accel_mag),
        "torque_mean": _mean(torque),
        "torque_max": max(torque),
        "assist_mean": _mean(assist),
    }
