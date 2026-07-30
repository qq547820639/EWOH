"""dataset_split 与 model_card 单元测试（纯标准库 unittest）。

覆盖 spec Task 19.2（按人员划分）与 Task 19.3（模型卡）：
- split_by_person：基本划分、比例校验、缺 person_id 报错、可复现性、不相交断言、
  少量人员 val/test 显式为空；
- verify_no_person_leak：正常无泄漏与泄漏场景；
- class_distribution：类别计数正确；
- write/read_split_manifest：往返一致；
- ModelCard：to_dict/to_json/from_json 往返、assert_non_medical 通过与失败、
  build_action_classifier_card 字段完整。

运行：python -m pytest src/edge_platform/tests/test_dataset_split_and_card.py -v
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式（沿用 test_governance 风格）
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.inference.dataset_split import (
    MANIFEST_VERSION, split_by_person, verify_no_person_leak,
    class_distribution, write_split_manifest, read_split_manifest,
)
from edge_platform.inference.model import ActionModel
from edge_platform.inference.model_card import (
    ModelCard, build_action_classifier_card, assert_non_medical,
    DEFAULT_LIMITATIONS, DEFAULT_OUT_OF_SCOPE_USES, DEFAULT_INTENDED_USE,
)


def _mk_sample(pid, label="stand", i=0):
    return {"person_id": pid, "label": label, "session_id": "SES-%s" % pid, "idx": i}


def _mk_samples(persons, per_person=4, labels=("stand", "walk", "bend", "lift")):
    """生成合成样本：每个人员 per_person 条，循环分配 label。"""
    out = []
    for p in persons:
        for i in range(per_person):
            out.append(_mk_sample(p, labels[i % len(labels)], i))
    return out


# ---------- split_by_person ----------
class SplitByPersonTest(unittest.TestCase):
    def test_basic_split_counts_and_disjoint(self):
        persons = ["P%02d" % i for i in range(20)]
        samples = _mk_samples(persons, per_person=5)
        splits = split_by_person(samples, ratios=(0.7, 0.15, 0.15), seed=42)
        # 三个键均显式存在
        self.assertEqual(set(splits.keys()), {"train", "val", "test"})
        # 样本总数守恒
        self.assertEqual(sum(len(v) for v in splits.values()), len(samples))
        # 人员两两不相交
        tr = {s["person_id"] for s in splits["train"]}
        va = {s["person_id"] for s in splits["val"]}
        te = {s["person_id"] for s in splits["test"]}
        self.assertFalse(tr & va)
        self.assertFalse(tr & te)
        self.assertFalse(va & te)
        self.assertEqual(tr | va | te, set(persons))
        # train 人员数 ≈ 0.7*20=14
        self.assertEqual(len(tr), 14)

    def test_ratios_sum_not_one_raises(self):
        with self.assertRaises(ValueError):
            split_by_person(_mk_samples(["P1", "P2"]), ratios=(0.7, 0.2, 0.2))
        with self.assertRaises(ValueError):
            split_by_person(_mk_samples(["P1", "P2"]), ratios=(0.5, 0.5))

    def test_missing_person_id_raises(self):
        bad = [{"label": "stand"}, {"person_id": "P1", "label": "walk"}]
        with self.assertRaises(ValueError):
            split_by_person(bad)

    def test_reproducible_with_same_seed(self):
        samples = _mk_samples(["P%02d" % i for i in range(15)], per_person=3)
        s1 = split_by_person(samples, seed=7)
        s2 = split_by_person(samples, seed=7)
        # 同 seed → 同样的人员归属
        for k in ("train", "val", "test"):
            self.assertEqual([s["person_id"] for s in s1[k]],
                             [s["person_id"] for s in s2[k]])
        # 不同 seed → 人员归属应不同（极大概率；此处校验 train 人员集合不同）
        s3 = split_by_person(samples, seed=99)
        self.assertNotEqual(
            {s["person_id"] for s in s1["train"]},
            {s["person_id"] for s in s3["train"]})

    def test_few_persons_val_test_explicit_empty(self):
        # 仅 1 名人员：train 非空，val/test 显式为空列表
        s1 = split_by_person(_mk_samples(["SOLO"], per_person=3))
        self.assertTrue(s1["train"])
        self.assertEqual(s1["val"], [])
        self.assertEqual(s1["test"], [])
        # 2 名人员：train 非空，三键均存在
        s2 = split_by_person(_mk_samples(["A", "B"], per_person=2))
        self.assertTrue(s2["train"])
        self.assertEqual(sum(len(v) for v in s2.values()), 4)

    def test_disjoint_assertion_invariant_holds(self):
        # 不变量由内部断言强制；多轮不同 seed 下均不应抛 AssertionError
        samples = _mk_samples(["P%02d" % i for i in range(12)], per_person=2)
        for seed in range(10):
            splits = split_by_person(samples, seed=seed)
            ok, overlap = verify_no_person_leak(splits)
            self.assertTrue(ok, "seed=%d 出现人员泄漏: %r" % (seed, overlap))


# ---------- verify_no_person_leak ----------
class VerifyLeakTest(unittest.TestCase):
    def test_no_leak(self):
        splits = {
            "train": [_mk_sample("P1"), _mk_sample("P2")],
            "val": [_mk_sample("P3")],
            "test": [_mk_sample("P4")],
        }
        ok, overlap = verify_no_person_leak(splits)
        self.assertTrue(ok)
        self.assertEqual(overlap["train_val"], [])
        self.assertEqual(overlap["train_test"], [])
        self.assertEqual(overlap["val_test"], [])

    def test_leak_detected(self):
        splits = {
            "train": [_mk_sample("P1"), _mk_sample("P2")],
            "val": [_mk_sample("P2"), _mk_sample("P3")],   # P2 泄漏到 val
            "test": [_mk_sample("P4")],
        }
        ok, overlap = verify_no_person_leak(splits)
        self.assertFalse(ok)
        self.assertEqual(overlap["train_val"], ["P2"])
        self.assertEqual(overlap["train_test"], [])
        self.assertEqual(overlap["val_test"], [])


# ---------- class_distribution ----------
class ClassDistributionTest(unittest.TestCase):
    def test_counts_correct(self):
        samples = [
            _mk_sample("P1", "stand"), _mk_sample("P1", "stand"),
            _mk_sample("P2", "walk"), _mk_sample("P3", "bend"),
        ]
        dist = class_distribution(samples)
        self.assertEqual(dist, {"stand": 2, "walk": 1, "bend": 1})

    def test_missing_label_bucket(self):
        samples = [{"person_id": "P1"}, {"person_id": "P1", "label": "walk"}]
        dist = class_distribution(samples)
        self.assertEqual(dist, {"_missing": 1, "walk": 1})


# ---------- manifest 往返 ----------
class ManifestRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_write_read_roundtrip(self):
        samples = _mk_samples(["P%02d" % i for i in range(10)], per_person=3)
        splits = split_by_person(samples, seed=1)
        path = os.path.join(self.tmp, "split.json")
        written = write_split_manifest(splits, path, ratios=(0.7, 0.15, 0.15))
        self.assertEqual(written["version"], MANIFEST_VERSION)
        self.assertTrue(os.path.exists(path))
        read = read_split_manifest(path)
        # 往返一致
        self.assertEqual(read["version"], MANIFEST_VERSION)
        self.assertEqual(read["split_counts"], written["split_counts"])
        self.assertEqual(read["person_ids"], written["person_ids"])
        self.assertEqual(read["ratios"], {"train": 0.7, "val": 0.15, "test": 0.15})
        # split_counts 与实际样本数一致
        self.assertEqual(read["split_counts"]["train"], len(splits["train"]))
        self.assertEqual(read["split_counts"]["val"], len(splits["val"]))
        self.assertEqual(read["split_counts"]["test"], len(splits["test"]))
        # person_ids 与划分一致且两两不相交
        tr, va, te = (set(read["person_ids"][k]) for k in ("train", "val", "test"))
        self.assertFalse(tr & va or tr & te or va & te)
        self.assertEqual(tr | va | te, {"P%02d" % i for i in range(10)})


# ---------- ModelCard ----------
def _mk_model(version="0.1.0"):
    """构造一个带 centroids 的 ActionModel（不依赖真实特征流）。"""
    m = ActionModel()
    m.centroids = {
        "stand": [0.0] * 12,
        "walk": [2.0] + [0.0] * 11,
        "bend": [5.0] + [0.0] * 11,
        "lift": [3.5] + [0.0] * 11,
    }
    m.version = version
    m.dataset_version = "0.1"
    m.thresholds = {"min_confidence": 0.55, "ambiguous_gap": 0.08}
    return m


class ModelCardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_to_dict_roundtrip_json(self):
        metrics = {"macro_f1": 0.87, "per_class_f1": {"stand": 0.9},
                   "high_risk_recall": 0.96, "false_positive_rate": 0.04}
        manifest = {"version": "0.1", "split_counts": {"train": 10, "val": 2, "test": 3}}
        card = build_action_classifier_card(_mk_model(), metrics, manifest, created_by="ci")
        path = os.path.join(self.tmp, "card.json")
        card.to_json(path)
        loaded = ModelCard.from_json(path)
        # 关键字段往返一致
        self.assertEqual(loaded.model_id, card.model_id)
        self.assertEqual(loaded.model_type, "action_classifier")
        self.assertEqual(loaded.version, "0.1.0")
        self.assertEqual(loaded.metrics, metrics)
        self.assertEqual(loaded.thresholds, {"min_confidence": 0.55, "ambiguous_gap": 0.08})
        self.assertEqual(loaded.dataset_split, manifest)
        self.assertEqual(loaded.dataset_version, "0.1")
        self.assertEqual(loaded.created_by, "ci")
        self.assertEqual(loaded.label_set, ["bend", "lift", "stand", "walk", "unknown"])
        self.assertEqual(loaded.feature_names, ActionModel().feature_names)
        # to_dict 与 to_json 内容一致
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), card.to_dict())

    def test_assert_non_medical_pass(self):
        card = build_action_classifier_card(_mk_model(), {}, {})
        # 默认 ethical_notes 含「非医学诊断」、description 不含禁用词 → 通过
        assert_non_medical(card)

    def test_assert_non_medical_fail_on_description(self):
        card = build_action_classifier_card(_mk_model(), {}, {})
        card.description = "用于识别患病与健康异常状态"  # 含禁用词
        with self.assertRaises(AssertionError):
            assert_non_medical(card)

    def test_assert_non_medical_fail_on_notes(self):
        card = build_action_classifier_card(_mk_model(), {}, {})
        card.ethical_notes = ["仅作参考"]  # 缺「非医学诊断」
        with self.assertRaises(AssertionError):
            assert_non_medical(card)

    def test_build_action_classifier_card_fields_complete(self):
        metrics = {"macro_f1": 0.9, "per_class_f1": {"stand": 0.93},
                   "high_risk_recall": 0.95, "false_positive_rate": 0.05}
        manifest = {"version": "0.2", "person_ids": {"train": ["P1"], "val": [], "test": []}}
        card = build_action_classifier_card(_mk_model("0.2.0"), metrics, manifest,
                                            created_by="trainer")
        # 字段完整性
        self.assertEqual(card.model_type, "action_classifier")
        self.assertEqual(card.version, "0.2.0")
        # model.dataset_version 优先于 manifest.version（模型自带口径为准）
        self.assertEqual(card.dataset_version, "0.1")
        self.assertEqual(card.dataset_split, manifest)
        self.assertEqual(card.metrics, metrics)
        self.assertEqual(card.thresholds, {"min_confidence": 0.55, "ambiguous_gap": 0.08})
        self.assertEqual(card.unknown_policy, "未知动作强制输出 unknown，不得强制分类")
        self.assertEqual(card.intended_use, DEFAULT_INTENDED_USE)
        self.assertEqual(card.out_of_scope_uses, DEFAULT_OUT_OF_SCOPE_USES)
        self.assertEqual(card.limitations, DEFAULT_LIMITATIONS)
        self.assertTrue(any("非医学诊断" in n for n in card.ethical_notes))
        self.assertEqual(card.created_by, "trainer")
        self.assertTrue(card.created_at)  # ISO 时间戳自动填充
        self.assertIn("unknown", card.label_set)
        # 4 类动作 + unknown，且 unknown 排在末尾
        self.assertEqual(len(card.label_set), 5)
        self.assertEqual(card.label_set[-1], "unknown")
        self.assertEqual(set(card.label_set) - {"unknown"},
                         {"stand", "walk", "bend", "lift"})


if __name__ == "__main__":
    unittest.main()
