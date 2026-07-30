"""模型卡（model card）模板与生成器（纯 Python 标准库）。

对应 spec Task 19.3「每个模型配备模型卡；保存数据/特征/模型/阈值版本」与
checklist「每个模型配备模型卡；数据/特征/模型/阈值版本保存（ModelRegistry 已支持，
需真实模型）」。

模型卡是模型版本治理（governance.ModelRegistry）的配套契约：
- ModelRegistry 记录 model_type/version/data_version/feature_version/
  threshold_version/model_card_uri 等追溯字段，model_card_uri 即指向本模块生成的
  模型卡 JSON；
- 每个模型上线（promote_to_shadow → activate）前必须配备模型卡，否则不可追溯数据
  与阈值版本，不可审计；
- 模型卡固化伦理边界（非医学诊断）、unknown 策略、已知局限与超范围用途，防止模型
  被误用于医学诊断或跨工厂直接部署。

ModelCard 为 dataclass；build_action_classifier_card 从 ActionModel 实例 + 评测指标
+ 数据集清单自动填充；assert_non_medical 强制伦理边界断言。

纯标准库实现；不引入 numpy/torch/sklearn 等外部依赖。
"""

import json
import time
from dataclasses import asdict, dataclass, field, fields
from typing import Dict, List

from . import ms_to_ts

MODEL_CARD_VERSION = "model-card-v1"

# 动作分类模型固化字段（build_action_classifier_card 使用）
DEFAULT_UNKNOWN_POLICY = "未知动作强制输出 unknown，不得强制分类"
DEFAULT_INTENDED_USE = "用于工厂人员动作识别与负荷/疲劳趋势评分"
DEFAULT_OUT_OF_SCOPE_USES = ["医学诊断", "跨工厂直接部署", "持续原始视频长期保存"]
DEFAULT_LIMITATIONS = [
    "非医学诊断，不用'患病'/'健康异常'表述",
    "仅在试点车间工序范围内有效",
    "遮挡/逆光/夜间需降级",
]
DEFAULT_ETHICAL_NOTES = ["非医学诊断，不用于疾病/健康状态判断"]
DEFAULT_DESCRIPTION = (
    "外骨骼作业人员动作分类模型（站立/行走/弯腰/搬举等），支撑风险事件判定与"
    "负荷/疲劳趋势评分。未知动作强制输出 unknown，不强制分类。"
)


@dataclass
class ModelCard:
    """模型卡：模型版本治理的配套契约。

    字段对应 spec「数据/特征/模型/阈值版本保存」与模型卡 checklist：
    - model_id / model_type / version / created_at / created_by：版本与责任追溯；
    - dataset_version / dataset_split：数据版本与划分清单引用（防人员泄漏）；
    - feature_names / label_set：特征口径与标签集合（含 unknown）；
    - metrics / thresholds：评测指标与推理阈值；
    - unknown_policy：unknown 强制输出策略；
    - limitations / intended_use / out_of_scope_uses / ethical_notes：伦理边界。
    """
    model_id: str
    model_type: str
    version: str
    description: str
    dataset_version: str
    dataset_split: Dict
    feature_names: List[str]
    label_set: List[str]
    metrics: Dict
    thresholds: Dict
    unknown_policy: str = DEFAULT_UNKNOWN_POLICY
    limitations: List[str] = field(default_factory=list)
    intended_use: str = DEFAULT_INTENDED_USE
    out_of_scope_uses: List[str] = field(default_factory=list)
    ethical_notes: List[str] = field(default_factory=list)
    created_at: str = ""
    created_by: str = "system"
    card_version: str = MODEL_CARD_VERSION

    def __post_init__(self):
        if not self.created_at:
            self.created_at = ms_to_ts(time.time() * 1000)

    def to_dict(self):
        """转 dict（深拷贝，避免外部修改污染卡内字段）。"""
        d = asdict(self)
        # 确保 mutable 默认值被复制（asdict 已深拷贝，这里仅为防御性一致）
        return d

    def to_json(self, path):
        """把模型卡写入 JSON 文件。"""
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
        return path

    @classmethod
    def from_json(cls, path):
        """从 JSON 文件读取并构造 ModelCard。"""
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        # 仅取 dataclass 已声明的字段，忽略多余键，保证前向兼容
        names = {f.name for f in fields(cls)}
        kwargs = {k: v for k, v in d.items() if k in names}
        return cls(**kwargs)


def build_action_classifier_card(model, metrics, dataset_manifest, created_by="system"):
    """从 ActionModel 实例 + 评测指标 + 数据集清单构建动作分类模型卡。

    - model: ActionModel 实例（取 model_id/version/feature_names/thresholds/
      dataset_version/centroids）。
    - metrics: 评测指标 dict，如 {"macro_f1":..., "per_class_f1":{...},
      "high_risk_recall":..., "false_positive_rate":...}。
    - dataset_manifest: 数据集划分清单（dataset_split.write_split_manifest 产物或
      collection.dataset.export_dataset 的 manifest），原样存入 dataset_split 字段。
    - 自动填充 limitations / intended_use / out_of_scope_uses / ethical_notes /
      unknown_policy 等固化字段。
    """
    centroids = getattr(model, "centroids", {}) or {}
    label_set = sorted(centroids.keys()) + ["unknown"]
    dataset_version = getattr(model, "dataset_version", None) or ""
    if not dataset_version and isinstance(dataset_manifest, dict):
        dataset_version = str(dataset_manifest.get("version") or "")

    return ModelCard(
        model_id=getattr(model, "model_id", "action-classifier"),
        model_type="action_classifier",
        version=str(getattr(model, "version", "0.0.0")),
        description=DEFAULT_DESCRIPTION,
        dataset_version=dataset_version,
        dataset_split=dict(dataset_manifest) if isinstance(dataset_manifest, dict)
        else {"raw": dataset_manifest},
        feature_names=list(getattr(model, "feature_names", [])),
        label_set=label_set,
        metrics=dict(metrics) if isinstance(metrics, dict) else {},
        thresholds=dict(getattr(model, "thresholds", {})),
        unknown_policy=DEFAULT_UNKNOWN_POLICY,
        limitations=list(DEFAULT_LIMITATIONS),
        intended_use=DEFAULT_INTENDED_USE,
        out_of_scope_uses=list(DEFAULT_OUT_OF_SCOPE_USES),
        ethical_notes=list(DEFAULT_ETHICAL_NOTES),
        created_by=created_by,
    )


def assert_non_medical(card):
    """断言模型卡守住「非医学诊断」伦理边界。

    - ethical_notes 中必须至少一项含「非医学诊断」；
    - description 不得含「患病」或「健康异常」字样。
    否则抛 AssertionError。
    """
    notes = getattr(card, "ethical_notes", None) or []
    has_non_medical = any("非医学诊断" in str(n) for n in notes)
    if not has_non_medical:
        raise AssertionError("ethical_notes 必须含「非医学诊断」: %r" % (notes,))

    desc = str(getattr(card, "description", ""))
    for forbidden in ("患病", "健康异常"):
        if forbidden in desc:
            raise AssertionError("description 不得含「%s」字样（非医学诊断边界）" % forbidden)
