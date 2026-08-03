"""数据集导出：按人工标签时间窗切遥测 → 滑窗特征样本 → 人员分组划分。

export_dataset(storage, out_dir, version, window_sec=2, step_sec=1, split=(0.6,0.2,0.2))
- 人员稳定切分：按 sha256(person_id) 排序切片，同一人员只出现在一个 split，
  划分后做纯净性断言，拒绝同一人跨 split；
- 输出 out_dir/dataset-v<version>/：windows.jsonl + manifest.json
  （version/created_at/source_type='controlled_test'/counts{split×class}/
  persons+splits{split}/sha256 清单/质量报告：采样率偏差、字段缺失率、标签覆盖率）。
"""

import hashlib
import json
import os
import sqlite3
import time

from inference import SAMPLE_HZ, ms_to_ts, ts_to_ms
from inference.features import extract_features

QUERY_LIMIT = 100000


def _load_labels(db_path):
    """读取标签并关联会话（人员/设备/起止）。"""
    c = sqlite3.connect(db_path)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            "SELECT l.session_id, l.action_code, l.start_ts, l.end_ts,"
            " s.person_id, s.device_id"
            " FROM collection_label l"
            " JOIN collection_session s ON l.session_id = s.session_id"
        ).fetchall()
        sess = c.execute("SELECT session_id, start_ts, end_ts FROM collection_session").fetchall()
    finally:
        c.close()
    return [dict(r) for r in rows], [dict(r) for r in sess]


def _assign_splits(persons, split):
    """按 sha256(person_id) 稳定排序切分；n<3 无法人员独立三分时拒绝。"""
    n = len(persons)
    if n < 3:
        raise ValueError(f"人员数 {int(n)} 不足 3，无法做人员独立 train/val/test 划分")
    ordered = sorted(persons, key=lambda p: int(hashlib.sha256(p.encode("utf-8")).hexdigest(), 16))
    n_test = max(1, round(n * split[2]))
    n_val = max(1, round(n * split[1]))
    n_train = n - n_val - n_test
    while n_train < 1:  # 极小样本兜底：从 val/test 匀一个给 train
        if n_val > 1:
            n_val -= 1
        elif n_test > 1:
            n_test -= 1
        n_train = n - n_val - n_test
    groups = {"train": ordered[:n_train], "val": ordered[n_train : n_train + n_val], "test": ordered[n_train + n_val :]}
    # 人员纯净性断言：任一人员不得跨 split
    allp = groups["train"] + groups["val"] + groups["test"]
    assert len(set(allp)) == len(allp) == n, "同一人员跨 split，拒绝导出"
    return groups


def export_dataset(storage, out_dir, version, window_sec=2, step_sec=1, split=(0.6, 0.2, 0.2)):
    labels, sessions = _load_labels(storage.db_path)
    if not labels:
        raise ValueError("无人工标签，无法导出数据集")

    win_n, step_n = window_sec * SAMPLE_HZ, step_sec * SAMPLE_HZ
    samples = []
    devs = set()
    hz_devs, win_total, win_dropped = [], 0, 0
    for lb in labels:
        devs.add(lb["device_id"])
        msgs = storage.query_telemetry(lb["device_id"], lb["start_ts"], lb["end_ts"], QUERY_LIMIT)
        msgs = sorted(msgs, key=lambda m: ts_to_ms(m["timestamp"]))
        if len(msgs) >= 2:  # 采样率偏差：实际 Hz 与 20Hz 的相对偏差
            dur = ts_to_ms(msgs[-1]["timestamp"]) - ts_to_ms(msgs[0]["timestamp"])
            if dur > 0:
                hz = (len(msgs) - 1) * 1000.0 / dur
                hz_devs.append(abs(hz - SAMPLE_HZ) / SAMPLE_HZ * 100.0)
        for i in range(0, len(msgs) - win_n + 1, step_n):
            win_total += 1
            feats = extract_features(msgs[i : i + win_n])
            if feats is None:
                win_dropped += 1
                continue
            samples.append(
                {
                    "features": feats,
                    "label": lb["action_code"],
                    "person_id": lb["person_id"],
                    "session_id": lb["session_id"],
                }
            )
    if not samples:
        raise ValueError("切窗后无有效样本（标签区间过短或质量不达标）")

    persons = sorted({s["person_id"] for s in samples})
    groups = _assign_splits(persons, split)
    p2g = {p: g for g, ps in groups.items() for p in ps}

    counts = {g: {} for g in groups}
    for s in samples:
        g = p2g[s["person_id"]]
        counts[g][s["label"]] = counts[g].get(s["label"], 0) + 1

    # 标签覆盖率：已关闭会话中标签时长 / 会话时长
    lab_sum, sess_sum = 0.0, 0.0
    for s in sessions:
        if not s.get("end_ts"):
            continue
        sess_sum += max(0.0, ts_to_ms(s["end_ts"]) - ts_to_ms(s["start_ts"]))
    for lb in labels:
        lab_sum += max(0.0, ts_to_ms(lb["end_ts"]) - ts_to_ms(lb["start_ts"]))
    coverage = min(1.0, lab_sum / sess_sum) if sess_sum > 0 else None

    ds_dir = os.path.join(out_dir, f"dataset-v{version}")
    os.makedirs(ds_dir, exist_ok=True)
    win_path = os.path.join(ds_dir, "windows.jsonl")
    with open(win_path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    sha = hashlib.sha256(open(win_path, "rb").read()).hexdigest()

    manifest = {
        "version": str(version),
        "created_at": ms_to_ts(time.time() * 1000),
        "source_type": "controlled_test",
        "window_sec": window_sec,
        "step_sec": step_sec,
        "counts": counts,
        "persons": {g: sorted(ps) for g, ps in groups.items()},
        "splits": {g: sorted(ps) for g, ps in groups.items()},
        "sha256": {"windows.jsonl": sha},
        "quality": {
            "sampling_rate_deviation_pct": round(sum(hz_devs) / len(hz_devs), 2) if hz_devs else None,
            "field_missing_rate": round(win_dropped / win_total, 4) if win_total else None,
            "label_coverage": round(coverage, 4) if coverage is not None else None,
            "windows_total": win_total,
            "windows_dropped": win_dropped,
        },
    }
    with open(os.path.join(ds_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest
