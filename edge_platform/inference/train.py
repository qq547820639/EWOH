"""动作模型训练/评测 CLI。

用法：python3 -m inference.train --dataset <dir> --out models/ [--register]

数据集目录：windows.jsonl（每行 {"features":dict,"label":str,"person_id","session_id"}）
+ manifest.json（{"version","splits":{"train":[人员],"val":[],"test":[]}}）。
按 manifest 人员分组取 train/val/test，断言三组人员无交集（人员泄漏直接报错退出）。
流程：训练 → val 选 unknown 阈值 → test 评测（Macro-F1/每类 P-R-F1/混淆矩阵/
unknown 率/2000 次 predict 延迟基准）→ 输出 model.json、metrics.json、
eval_report.md、model_card.md；--register 写入 ModelRegistry 并 activate。
版本号自 v0.1.0 起按 minor 自动递增。
"""

import argparse
import hashlib
import itertools
import json
import os
import sys
import time

from . import ms_to_ts
from .model import ActionModel, ModelRegistry, ModelError

TARGET_MACRO_F1 = 0.85          # 内部目标
BENCH_N = 2000                  # 延迟基准 predict 次数
THRESH_GRID = [0.30 + 0.05 * i for i in range(13)]  # val 阈值搜索网格


# ---------- 数据 ----------
def load_dataset(ds_dir):
    """读取数据集并按 manifest 人员分组；人员跨组直接 SystemExit。"""
    with open(os.path.join(ds_dir, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    splits = manifest.get("splits") or {}
    persons = {k: list(splits.get(k) or []) for k in ("train", "val", "test")}
    for a, b in itertools.combinations(("train", "val", "test"), 2):
        dup = set(persons[a]) & set(persons[b])
        if dup:
            raise SystemExit("人员泄漏：%s 同时出现在 %s 与 %s" % (sorted(dup), a, b))
    p2s = {p: k for k, ps in persons.items() for p in ps}
    samples = {"train": [], "val": [], "test": []}
    with open(os.path.join(ds_dir, "windows.jsonl"), "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            sp = p2s.get(s.get("person_id"))
            if sp:
                samples[sp].append(s)
    return manifest, samples, persons


# ---------- 评测 ----------
def evaluate(model, samples):
    """返回 Macro-F1、每类 P/R/F1、混淆矩阵（含 unknown 列）、unknown 率。"""
    labels = sorted({s["label"] for s in samples} | set(model.centroids))
    cols = labels + ["unknown"]
    conf = {t: {p: 0 for p in cols} for t in labels}
    n_unknown = 0
    for s in samples:
        pred = model.predict(s["features"])["label"]
        if pred == "unknown":
            n_unknown += 1
        conf[s["label"]][pred if pred in cols else "unknown"] += 1
    per_class = {}
    f1s = []
    for c in labels:
        tp = conf[c][c]
        fp = sum(conf[t][c] for t in labels if t != c)
        fn = sum(conf[c][p] for p in cols if p != c)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        support = sum(conf[c].values())
        per_class[c] = {"precision": round(precision, 4), "recall": round(recall, 4),
                        "f1": round(f1, 4), "support": support}
        if support:
            f1s.append(f1)
    return {
        "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else 0.0,
        "per_class": per_class,
        "confusion": conf,
        "unknown_rate": round(n_unknown / len(samples), 4) if samples else 0.0,
        "n_samples": len(samples),
    }


def select_threshold(model, val_samples):
    """在 val 上按 Macro-F1 选 min_confidence 阈值（并列取较低值）。"""
    if not val_samples:
        return model.thresholds["min_confidence"], None
    best_th, best_f1 = model.thresholds["min_confidence"], -1.0
    for th in THRESH_GRID:
        model.thresholds["min_confidence"] = th
        f1 = evaluate(model, val_samples)["macro_f1"]
        if f1 > best_f1:
            best_th, best_f1 = th, f1
    model.thresholds["min_confidence"] = best_th
    return best_th, best_f1


def benchmark_latency(model, samples, n=BENCH_N):
    """连续 n 次 predict，实测 P50/P95（ms）。"""
    pool = [s["features"] for s in samples] or [
        {k: c[i] for i, k in enumerate(model.feature_names)}
        for c in model.centroids.values()]
    ts = []
    for i in range(n):
        t0 = time.perf_counter()
        model.predict(pool[i % len(pool)])
        ts.append((time.perf_counter() - t0) * 1000.0)
    ts.sort()

    def pct(p):
        return ts[min(n - 1, max(0, int(round(p / 100.0 * n)) - 1))]

    return {"p50": round(pct(50), 3), "p95": round(pct(95), 3), "n": n}


# ---------- 版本 ----------
def next_version(out_dir):
    """扫描 action-classifier-vX.Y.Z，minor 递增；首个为 v0.1.0。"""
    best = None
    if os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            if name.startswith("action-classifier-v"):
                try:
                    ver = tuple(int(x) for x in name[len("action-classifier-v"):].split("."))
                except ValueError:
                    continue
                if best is None or ver > best:
                    best = ver
    if best is None:
        return "0.1.0"
    return "%d.%d.%d" % (best[0], best[1] + 1, 0)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------- 报告 ----------
def write_eval_report(path, ctx):
    m = ctx["test_metrics"]
    lines = [
        "# 动作分类模型评测报告 %s-v%s" % (ctx["model_id"], ctx["version"]), "",
        "- 评测时间：%s" % ctx["created_at"],
        "- 数据集版本：%s（source_type=%s）" % (ctx["dataset_version"], ctx["source_type"]),
        "- unknown 阈值：min_confidence=%.2f（val 选取），ambiguous_gap=%.2f"
        % (ctx["thresholds"]["min_confidence"], ctx["thresholds"]["ambiguous_gap"]), "",
        "## 人员独立性声明", "",
        "本评测严格按人员分组划分，train/val/test 三组人员无任何交集（加载时已断言，"
        "发现交集直接报错退出）：",
        "- train（%d 人）：%s" % (len(ctx["persons"]["train"]), ", ".join(ctx["persons"]["train"])),
        "- val（%d 人）：%s" % (len(ctx["persons"]["val"]), ", ".join(ctx["persons"]["val"])),
        "- test（%d 人）：%s" % (len(ctx["persons"]["test"]), ", ".join(ctx["persons"]["test"])), "",
        "## 总体指标（test，人员独立）", "",
        "- Macro-F1：%.4f（内部目标 ≥ %.2f）" % (m["macro_f1"], TARGET_MACRO_F1),
        "- unknown 率：%.4f" % m["unknown_rate"],
        "- 样本数：%d" % m["n_samples"],
        "- 延迟基准（连续 %d 次 predict）：P50=%.3f ms，P95=%.3f ms"
        % (ctx["latency"]["n"], ctx["latency"]["p50"], ctx["latency"]["p95"]), "",
        "## 每类指标", "",
        "| 类别 | precision | recall | F1 | support |", "| --- | --- | --- | --- | --- |",
    ]
    for c, v in m["per_class"].items():
        lines.append("| %s | %.4f | %.4f | %.4f | %d |"
                     % (c, v["precision"], v["recall"], v["f1"], v["support"]))
    cols = list(m["per_class"]) + ["unknown"]
    lines += ["", "## 混淆矩阵（行=真实，列=预测）", "",
              "| | " + " | ".join(cols) + " |", "|" + " --- |" * (len(cols) + 1)]
    for t, row in m["confusion"].items():
        lines.append("| %s | %s |" % (t, " | ".join(str(row[c]) for c in cols)))
    lines += ["", "## 结论", ""]
    if m["macro_f1"] >= TARGET_MACRO_F1:
        lines.append("人员独立测试 Macro-F1=%.4f，达到内部目标（≥%.2f），可进入发布评审。"
                     % (m["macro_f1"], TARGET_MACRO_F1))
    else:
        lines.append("人员独立测试 Macro-F1=%.4f，未达内部目标（≥%.2f）。"
                     "建议如实缩小动作类别集合或补充受控数据后重训，"
                     "不得通过包装数据/放宽口径宣称达标。"
                     % (m["macro_f1"], TARGET_MACRO_F1))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def write_model_card(path, ctx):
    m, lat = ctx["test_metrics"], ctx["latency"]
    per_class = "；".join("%s R=%.3f" % (c, v["recall"]) for c, v in m["per_class"].items())
    content = """# 模型卡：{model_id}

- 版本：{version}
- 业务目的：外骨骼作业人员的站立/行走/弯腰/搬举动作分类，支撑风险事件判定与作业画像
- 不得使用场景：医疗诊断、惩罚性绩效、直接设备控制
- 输入传感器/字段：标准遥测的 pitch_deg/roll_deg、三轴 acceleration、三轴 angular_velocity、torque_nm、assist_level
- 窗口/采样率：2s 滑窗 @20Hz（40 条），步长 1s；12 维统计特征（见 feature_names）
- 输出标签/unknown：{labels}；unknown 含 data_quality / low_confidence / ambiguous 三种原因
- 训练数据：来源 {source_type}；{n_persons} 名匿名受试者；受控采集会话（设备/固件/穿戴记录于 collection_session）；动作标签 {labels}；授权记录见采集会话 consent_id（本包不内嵌授权文本）
- 数据划分：按人员分组 train {train_n} 人 / val {val_n} 人 / test {test_n} 人，三组无交集（已断言）
- 指标：Macro-F1={macro_f1:.4f}（人员独立 test）；每类召回：{per_class}；unknown 率={unknown_rate:.4f}；延迟 P50={p50:.3f}ms / P95={p95:.3f}ms（{bench_n} 次）
- 资源需求：纯 CPU、Python 标准库、内存 <50MB；无 GPU 依赖
- 已知限制：最近质心线性可分性有限；对未受训人员存在泛化误差；invalid 占比>30% 的窗口直接 unknown；过渡动作与负荷极重片段易判 unknown
- 监控：数据质量（invalid/degraded 占比）、unknown 率、输入分布漂移、推理延迟 P95
- 发布条件：人员独立测试 Macro-F1 ≥ {target:.2f}；unknown 三路径可用；规则降级模式可用
- 回滚包：ModelRegistry.rollback() 一键回滚至上一激活版本；本模型文件 sha256={model_sha}
""".format(
        model_id=ctx["model_id"], version=ctx["version"],
        labels="/".join(ctx["labels"]) + "/unknown",
        source_type=ctx["source_type"], n_persons=ctx["n_persons"],
        train_n=len(ctx["persons"]["train"]), val_n=len(ctx["persons"]["val"]),
        test_n=len(ctx["persons"]["test"]),
        macro_f1=m["macro_f1"], per_class=per_class, unknown_rate=m["unknown_rate"],
        p50=lat["p50"], p95=lat["p95"], bench_n=lat["n"],
        target=TARGET_MACRO_F1, model_sha=ctx["model_sha"])
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# ---------- 主流程 ----------
def run(argv=None):
    ap = argparse.ArgumentParser(prog="inference.train", description="动作模型训练与评测")
    ap.add_argument("--dataset", required=True, help="数据集目录（windows.jsonl + manifest.json）")
    ap.add_argument("--out", default="models/", help="模型输出/注册目录")
    ap.add_argument("--register", action="store_true", help="写入 ModelRegistry 并激活")
    args = ap.parse_args(argv)

    manifest, samples, persons = load_dataset(args.dataset)
    if not samples["train"]:
        print("训练集为空，退出", file=sys.stderr)
        return 2

    model = ActionModel()
    model.dataset_version = manifest.get("version")
    model.fit(samples["train"])
    best_th, val_f1 = select_threshold(model, samples["val"])
    test_metrics = evaluate(model, samples["test"])
    latency = benchmark_latency(model, samples["test"] or samples["train"])

    version = next_version(args.out)
    model.version = version
    out_dir = os.path.join(args.out, "action-classifier-v%s" % version)
    os.makedirs(out_dir, exist_ok=True)
    model_path = os.path.join(out_dir, "model.json")
    model.save(model_path)

    ctx = {
        "model_id": model.model_id, "version": version,
        "created_at": ms_to_ts(time.time() * 1000),
        "dataset_version": manifest.get("version"),
        "source_type": manifest.get("source_type", "controlled_test"),
        "persons": persons, "n_persons": len(set(sum(persons.values(), []))),
        "labels": sorted(model.centroids),
        "thresholds": model.thresholds, "test_metrics": test_metrics,
        "latency": latency, "model_sha": _sha256(model_path),
    }
    metrics = dict(ctx)
    with open(os.path.join(out_dir, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    write_eval_report(os.path.join(out_dir, "eval_report.md"), ctx)
    write_model_card(os.path.join(out_dir, "model_card.md"), ctx)

    if args.register:
        reg = ModelRegistry(args.out)
        reg.register(version, os.path.join("action-classifier-v%s" % version, "model.json"),
                     {"model_id": model.model_id, "macro_f1": test_metrics["macro_f1"],
                      "dataset_version": model.dataset_version})
        reg.activate(version)

    print("模型 %s v%s：test Macro-F1=%.4f（目标≥%.2f），unknown率=%.4f，"
          "P95=%.3fms，val阈值=%.2f（F1=%s），输出 %s%s"
          % (model.model_id, version, test_metrics["macro_f1"], TARGET_MACRO_F1,
             test_metrics["unknown_rate"], latency["p95"], best_th,
             ("%.4f" % val_f1) if val_f1 is not None else "N/A", out_dir,
             "，已注册并激活" if args.register else ""))
    return 0


def main():
    try:
        sys.exit(run())
    except ModelError as e:
        print("模型错误：%s" % e, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
