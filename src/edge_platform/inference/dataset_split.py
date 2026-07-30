"""按人员划分训练/验证/测试集的数据集划分工具（纯 Python 标准库）。

对应 spec Task 19.2「按人员划分训练/验证/测试集，不允许同一人员跨集合」。

核心不变量：同一人员的样本只能落在 train / val / test 中的某一个集合，
三组 person_id 两两不相交。该不变量用于防止数据泄漏——若同一人员同时出现在
训练集与测试集，模型会记住个体特征（步态/穿戴习惯/传感器偏置）而非动作本身，
导致测试指标虚高、现场泛化失败。因此划分的粒度是「人员」而非「样本」。

提供：
- split_by_person(samples, ratios, seed)：按 person_id 分组并随机划分人员，
  用 random.Random(seed) 保证可复现；强制断言三组人员不相交。
- verify_no_person_leak(splits)：校验任意两集合 person_id 不相交，返回 (ok, overlap)。
- class_distribution(samples)：统计各动作类别样本数，便于检查类别均衡。
- write_split_manifest / read_split_manifest：落盘/读取 JSON 划分清单。

纯标准库实现；不引入 numpy/torch/sklearn 等外部依赖。
"""

import json
import random
import time

from . import ms_to_ts

MANIFEST_VERSION = "dataset-split-v1"
_SPLIT_KEYS = ("train", "val", "test")


def _person_ids(samples):
    """提取样本列表的 person_id 集合；任意样本缺少 person_id 抛 ValueError。"""
    ids = set()
    for i, s in enumerate(samples):
        pid = s.get("person_id") if isinstance(s, dict) else None
        if pid is None or pid == "":
            raise ValueError("第 %d 个样本缺少 person_id" % i)
        ids.add(pid)
    return ids


def _count_targets(n, ratios):
    """按比例计算 train/val/test 的人员数量；保证 n>=1 时 train>=1 且三者之和=n。

    优先保证 train 非空（spec：至少 1 个人员时 train 非空），val/test 在人员数
    不足时可为 0；剩余人员按 val 然后 test 顺序分配，确保总数严格等于 n。
    """
    if n <= 0:
        return 0, 0, 0
    n_train = max(1, int(round(n * ratios[0])))
    n_train = min(n_train, n)                       # 不超过总人数
    remaining = n - n_train
    n_val = min(remaining, int(round(n * ratios[1])))
    n_test = remaining - n_val
    return n_train, n_val, n_test


def split_by_person(samples, ratios=(0.7, 0.15, 0.15), seed=42):
    """按 person_id 把「人员」随机划分到 train/val/test，返回三组样本列表。

    - samples: list[dict]，每个样本必须含 person_id 字段，否则 ValueError。
    - ratios: (train, val, test) 三者之和必须为 1.0，否则 ValueError。
    - seed: random.Random(seed) 保证划分可复现。
    - 不变量：train/val/test 的 person_id 集合两两不相交（断言强制）。
    - 至少 1 个人员时保证 train 非空；人员数 < 3 时 val/test 可为空，但仍显式给出。
    """
    if len(ratios) != 3:
        raise ValueError("ratios 必须为长度 3 的序列 (train, val, test)")
    if abs(sum(ratios) - 1.0) > 1e-9:
        raise ValueError("ratios 之和必须为 1.0，实际为 %r" % (sum(ratios),))
    if any(r < 0 for r in ratios):
        raise ValueError("ratios 各分量不得为负: %r" % (ratios,))

    # 先做 person_id 校验（即便 samples 为空也先验证 ratios）
    persons = _person_ids(samples)

    # 排序后再洗牌：保证划分结果只依赖 seed，与输入顺序无关
    ordered = sorted(persons)
    rng = random.Random(seed)
    rng.shuffle(ordered)

    n_train, n_val, n_test = _count_targets(len(ordered), ratios)
    train_persons = ordered[:n_train]
    val_persons = ordered[n_train:n_train + n_val]
    test_persons = ordered[n_train + n_val:n_train + n_val + n_test]

    buckets = {k: [] for k in _SPLIT_KEYS}
    pid_to_split = {}
    for p in train_persons:
        pid_to_split[p] = "train"
    for p in val_persons:
        pid_to_split[p] = "val"
    for p in test_persons:
        pid_to_split[p] = "test"
    for s in samples:
        buckets[pid_to_split[s["person_id"]]].append(s)

    # 严格不变量断言：三组 person_id 两两不相交
    s_train = {s["person_id"] for s in buckets["train"]}
    s_val = {s["person_id"] for s in buckets["val"]}
    s_test = {s["person_id"] for s in buckets["test"]}
    assert not (s_train & s_val), "train/val 人员泄漏: %s" % sorted(s_train & s_val)
    assert not (s_train & s_test), "train/test 人员泄漏: %s" % sorted(s_train & s_test)
    assert not (s_val & s_test), "val/test 人员泄漏: %s" % sorted(s_val & s_test)
    assert s_train | s_val | s_test == persons, "人员集合不完整"
    if persons:
        assert s_train, "train 不可为空（至少 1 个人员时）"

    return buckets


def verify_no_person_leak(splits):
    """检查 splits 中任意两集合 person_id 是否不相交。

    splits: {"train": [sample,...], "val": [...], "test": [...]}。
    返回 (ok: bool, overlap: dict)，overlap 形如
    {"train_val": [...], "train_test": [...], "val_test": [...]}，
    无重叠时各值为空列表。
    """
    keys = [k for k in _SPLIT_KEYS if k in splits]
    pid_sets = {k: {s.get("person_id") for s in splits[k]
                    if isinstance(s, dict) and s.get("person_id") is not None}
                for k in keys}
    overlap = {}
    ok = True
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            inter = sorted(pid_sets[a] & pid_sets[b])
            overlap["%s_%s" % (a, b)] = inter
            if inter:
                ok = False
    return ok, overlap


def class_distribution(samples):
    """统计每个动作类别（label）的样本数，返回 {label: count}。

    用于检查训练/测试集的类别均衡；缺失 label 的样本计入 "_missing"。
    """
    dist = {}
    for s in samples:
        label = s.get("label") if isinstance(s, dict) else None
        key = label if label is not None else "_missing"
        dist[key] = dist.get(key, 0) + 1
    return dist


def write_split_manifest(splits, path, ratios=None):
    """把划分结果落盘为 JSON 清单。

    清单结构：
    {"created_at": iso, "ratios": {"train":..,"val":..,"test":..},
     "split_counts": {"train": n,...},
     "person_ids": {"train": [...], "val": [...], "test": [...]},
     "version": "dataset-split-v1"}

    ratios 缺省时按 split_counts（样本数）计算实际占比；显式传入则原样记录目标比例。
    """
    split_counts = {k: len(splits.get(k, [])) for k in _SPLIT_KEYS}
    person_ids = {k: sorted({s["person_id"] for s in splits.get(k, [])})
                  for k in _SPLIT_KEYS}
    if ratios is None:
        total = sum(split_counts.values())
        if total > 0:
            ratios_out = {k: round(split_counts[k] / total, 6) for k in _SPLIT_KEYS}
        else:
            ratios_out = {k: 0.0 for k in _SPLIT_KEYS}
    else:
        ratios_out = {k: float(ratios[i]) for i, k in enumerate(_SPLIT_KEYS)}

    manifest = {
        "created_at": ms_to_ts(time.time() * 1000),
        "ratios": ratios_out,
        "split_counts": split_counts,
        "person_ids": person_ids,
        "version": MANIFEST_VERSION,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


def read_split_manifest(path):
    """读取划分清单 JSON，返回 dict。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
