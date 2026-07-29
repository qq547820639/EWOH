"""轻量动作分类模型（最近质心）与模型版本注册表。纯标准库。

ActionModel：对 12 维滑窗特征做 z-score 标准化，按类质心欧氏距离的
softmax(-d) 作为置信度。unknown 三路径（判定顺序固定）：
1. data_quality   特征为 None 或含非法值（质量差）
2. ambiguous      前两名置信度差距 < ambiguous_gap（先于此低置信判定，
                  否则 softmax 下该分支永不可达）
3. low_confidence 最高置信度 < min_confidence

ModelRegistry：models_dir 下 registry.json 记录版本与活动模型，history.json
记录激活顺序以支持一键回滚；模型文件损坏时 ActionModel.load 抛 ModelError
（可控异常），Registry.active() 捕获后返回 None 供上层降级为规则模式。
"""

import json
import math
import os
import time

from . import ms_to_ts
from .features import FEATURE_NAMES


class ModelError(Exception):
    """模型文件损坏/不可解析（可控异常，供上层降级）。"""


class ActionModel:
    MODEL_ID = "action-classifier"

    def __init__(self):
        self.model_id = self.MODEL_ID
        self.version = "0.0.0"
        self.feature_names = list(FEATURE_NAMES)
        self.centroids = {}                 # label -> 标准化空间质心向量
        self.mean = [0.0] * len(self.feature_names)
        self.std = [1.0] * len(self.feature_names)
        self.thresholds = {"min_confidence": 0.55, "ambiguous_gap": 0.08}
        self.trained_at = None
        self.dataset_version = None

    # ---- 训练 ----
    def fit(self, samples):
        """samples: [{"features": dict, "label": str}]。"""
        rows = [(s.get("features"), s.get("label")) for s in samples]
        rows = [(f, l) for f, l in rows if isinstance(f, dict) and l]
        if not rows:
            raise ValueError("无有效训练样本")
        n = len(self.feature_names)
        raw = []
        for f, _ in rows:
            try:
                raw.append([float(f[k]) for k in self.feature_names])
            except (KeyError, TypeError, ValueError) as e:
                raise ValueError("训练样本特征缺失/非法: %s" % e)
        m = len(raw)
        self.mean = [sum(r[i] for r in raw) / m for i in range(n)]
        self.std = []
        for i in range(n):
            var = sum((r[i] - self.mean[i]) ** 2 for r in raw) / m
            self.std.append(max(math.sqrt(var), 1e-9))
        sums, cnt = {}, {}
        for (f, label), r in zip(rows, raw):
            z = [(r[i] - self.mean[i]) / self.std[i] for i in range(n)]
            if label not in sums:
                sums[label] = [0.0] * n
                cnt[label] = 0
            for i in range(n):
                sums[label][i] += z[i]
            cnt[label] += 1
        self.centroids = {l: [s / cnt[l] for s in sums[l]] for l in sums}
        self.trained_at = ms_to_ts(time.time() * 1000)
        return self

    # ---- 推理 ----
    def _zvec(self, features):
        """特征 dict -> 标准化向量；缺失/非有限值返回 None。"""
        if not isinstance(features, dict):
            return None
        z = []
        for i, k in enumerate(self.feature_names):
            try:
                x = float(features[k])
            except (KeyError, TypeError, ValueError):
                return None
            if not math.isfinite(x):
                return None
            z.append((x - self.mean[i]) / self.std[i])
        return z

    def predict(self, features):
        """返回 {"label","confidence","unknown_reason"}；unknown 时 label='unknown'。"""
        unknown = {"label": "unknown", "confidence": 0.0}
        z = self._zvec(features)
        if z is None or not self.centroids:
            return dict(unknown, unknown_reason="data_quality")
        dists = []
        for label, c in self.centroids.items():
            d = math.sqrt(sum((z[i] - c[i]) ** 2 for i in range(len(z))))
            dists.append((label, d))
        dists.sort(key=lambda t: t[1])
        # softmax(-d) 作为置信度（数值稳定）
        negs = [-d for _, d in dists]
        mx = max(negs)
        exps = [math.exp(x - mx) for x in negs]
        tot = sum(exps)
        scores = [e / tot for e in exps]
        top_label, top = dists[0][0], scores[0]
        gap = top - scores[1] if len(scores) > 1 else 1.0
        conf = round(top, 4)
        if len(scores) > 1 and gap < self.thresholds["ambiguous_gap"]:
            return dict(unknown, confidence=conf, unknown_reason="ambiguous")
        if top < self.thresholds["min_confidence"]:
            return dict(unknown, confidence=conf, unknown_reason="low_confidence")
        return {"label": top_label, "confidence": conf, "unknown_reason": None}

    # ---- 序列化 ----
    def to_dict(self):
        return {
            "model_id": self.model_id,
            "version": self.version,
            "feature_names": self.feature_names,
            "centroids": self.centroids,
            "stats": {"mean": self.mean, "std": self.std},
            "thresholds": self.thresholds,
            "trained_at": self.trained_at,
            "dataset_version": self.dataset_version,
        }

    @classmethod
    def from_dict(cls, d):
        try:
            m = cls()
            m.model_id = str(d["model_id"])
            m.version = str(d["version"])
            m.feature_names = [str(x) for x in d["feature_names"]]
            m.centroids = {str(k): [float(v) for v in vs]
                           for k, vs in d["centroids"].items()}
            m.mean = [float(x) for x in d["stats"]["mean"]]
            m.std = [max(float(x), 1e-9) for x in d["stats"]["std"]]
            m.thresholds = {"min_confidence": float(d["thresholds"]["min_confidence"]),
                            "ambiguous_gap": float(d["thresholds"]["ambiguous_gap"])}
            m.trained_at = d.get("trained_at")
            m.dataset_version = d.get("dataset_version")
        except (KeyError, TypeError, ValueError) as e:
            raise ModelError("模型文件字段缺失/非法: %s" % e)
        n = len(m.feature_names)
        ok = (m.centroids and len(m.mean) == n and len(m.std) == n
              and all(len(c) == n and all(math.isfinite(v) for v in c)
                      for c in m.centroids.values()))
        if not ok:
            raise ModelError("模型维度不一致或含非法数值")
        return m

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path):
        """加载模型；文件损坏/不可读抛 ModelError。"""
        try:
            with open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError) as e:
            raise ModelError("模型文件不可读: %s" % e)
        if not isinstance(d, dict):
            raise ModelError("模型文件格式错误")
        return cls.from_dict(d)


def _ver_key(v):
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return (0,)


class ModelRegistry:
    """模型版本治理：registry.json 记录版本/活动模型，history.json 记录激活栈。"""

    def __init__(self, models_dir):
        self.dir = models_dir
        os.makedirs(models_dir, exist_ok=True)
        self.reg_path = os.path.join(models_dir, "registry.json")
        self.hist_path = os.path.join(models_dir, "history.json")

    def _load_json(self, path, default):
        if not os.path.exists(path):
            return default
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _load_reg(self):
        reg = self._load_json(self.reg_path, {"active": None, "models": {}})
        reg.setdefault("active", None)
        reg.setdefault("models", {})
        return reg

    def _save(self, path, obj):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)

    # ---- 查询 ----
    def versions(self):
        return sorted(self._load_reg()["models"].keys(), key=_ver_key)

    def active_version(self):
        try:
            return self._load_reg()["active"]
        except (OSError, ValueError):
            return None

    def active(self):
        """返回 (ActionModel, meta)；无活动模型或文件损坏返回 None。"""
        try:
            reg = self._load_reg()
            ver = reg["active"]
            if not ver:
                return None
            entry = reg["models"][ver]
            model = ActionModel.load(os.path.join(self.dir, entry["path"]))
            meta = dict(entry)
            meta["version"] = ver
            return model, meta
        except (ModelError, KeyError, OSError, ValueError):
            return None

    # ---- 变更 ----
    def register(self, version, model_path, meta=None):
        """登记一个已落盘模型（model_path 相对 models_dir）。"""
        reg = self._load_reg()
        entry = {"path": model_path, "registered_at": ms_to_ts(time.time() * 1000)}
        if meta:
            entry.update(meta)
        reg["models"][str(version)] = entry
        self._save(self.reg_path, reg)

    def activate(self, version):
        """激活指定版本；模型不可加载时抛 ModelError，不变更状态。"""
        version = str(version)
        reg = self._load_reg()
        if version not in reg["models"]:
            raise ModelError("版本未注册: %s" % version)
        ActionModel.load(os.path.join(self.dir, reg["models"][version]["path"]))
        reg["active"] = version
        self._save(self.reg_path, reg)
        hist = self._load_json(self.hist_path, [])
        hist.append(version)
        self._save(self.hist_path, hist)

    def rollback(self):
        """回滚到上一激活版本，返回该版本号；无历史可回滚返回 None。"""
        hist = self._load_json(self.hist_path, [])
        if len(hist) < 2:
            return None
        hist.pop()  # 当前版本出栈
        prev = hist[-1]
        reg = self._load_reg()
        if prev not in reg["models"]:
            return None
        reg["active"] = prev
        self._save(self.reg_path, reg)
        self._save(self.hist_path, hist)
        return prev
