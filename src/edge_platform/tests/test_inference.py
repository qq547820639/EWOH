"""推理/规则/模型/事件/数据集 单元测试（轻量 Fake 代替真实 Storage/Bus）。"""

import json
import os
import queue
import random
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from inference import ms_to_ts, ts_to_ms
from inference.features import extract_features, FEATURE_NAMES
from inference.rules import RuleEngine
from inference.model import ActionModel, ModelRegistry, ModelError
from inference.events import EventEngine
from inference.pipeline import InferencePipeline
from inference import train as train_mod
from collection.session import SessionManager
from collection.dataset import export_dataset

BASE_TS = 1785300000000  # 固定时间起点（ms），保证测试可重复


# ---------- 轻量 Fake（契约对齐，不依赖并行开发的真实实现） ----------
class FakeStorage:
    def __init__(self, db_path=None):
        if db_path is None:
            fd, db_path = tempfile.mkstemp(suffix=".db")
            os.close(fd)
        self.db_path = db_path
        self.telemetry = []
        self.inferences = []
        self.events = {}

    def init_db(self):
        pass

    def insert_telemetry(self, msg, raw_hex=None):
        self.telemetry.append(msg)

    def latest_telemetry(self, device_id):
        msgs = [m for m in self.telemetry if m["device_id"] == device_id]
        return msgs[-1] if msgs else None

    def query_telemetry(self, device_id, start, end, limit=1000):
        s, e = ts_to_ms(start), ts_to_ms(end)
        out = [m for m in self.telemetry
               if m["device_id"] == device_id and s <= ts_to_ms(m["timestamp"]) <= e]
        out.sort(key=lambda m: ts_to_ms(m["timestamp"]))
        return out[:limit]

    def export_slice(self, device_id, start, end):
        return self.query_telemetry(device_id, start, end, 100000)

    def list_devices(self):
        return sorted({m["device_id"] for m in self.telemetry})

    def insert_inference(self, res):
        self.inferences.append(res)

    def query_inference(self, device_id, start, end, limit=100):
        return self.inferences[-limit:]

    def insert_event(self, evt):
        self.events[evt["event_id"]] = dict(evt)

    def list_events(self, limit=100):
        evts = sorted(self.events.values(), key=lambda e: e["start_time"])
        return evts[-limit:]

    def get_event(self, eid):
        return self.events.get(eid)

    def update_event_status(self, eid, status, handling):
        self.events[eid]["status"] = status
        self.events[eid]["handling"] = handling


class FakeBus:
    def __init__(self):
        self.queues = {}
        self.published = {}

    def subscribe(self, topic):
        q = queue.Queue()
        self.queues.setdefault(topic, []).append(q)
        return q

    def publish(self, topic, msg):
        self.published.setdefault(topic, []).append(msg)
        for q in self.queues.get(topic, []):
            q.put(msg)


# ---------- 消息工厂 ----------
def mk_msg(dev, person, t_ms, seq, pitch=10.0, roll=2.0, gyro=(1.0, 2.0, 2.0),
           accel=(0.0, 0.0, 9.8), torque=5.0, assist=0.2, status="good",
           source="controlled_test"):
    return {
        "record_id": "REC-%s-%d" % (dev, seq),
        "device_id": dev, "person_id": person,
        "timestamp": ms_to_ts(t_ms), "sequence": seq,
        "telemetry": {"pitch_deg": pitch, "roll_deg": roll,
                      "acceleration": list(accel), "angular_velocity": list(gyro),
                      "torque_nm": torque, "assist_level": assist,
                      "battery_percent": 80},
        "quality": {"status": status, "packet_loss": 0.0, "clock_offset_ms": 0},
        "source_type": source,
    }


def stream(dev, person, t0, n, seq0=0, step_ms=50, **kw):
    return [mk_msg(dev, person, t0 + i * step_ms, seq0 + i, **kw) for i in range(n)]


# ---------- 特征 ----------
class FeatureTest(unittest.TestCase):
    def test_dimensions(self):
        feats = extract_features(stream("D1", "P1", BASE_TS, 40, pitch=12.0))
        self.assertIsNotNone(feats)
        self.assertEqual(sorted(feats.keys()), sorted(FEATURE_NAMES))
        self.assertEqual(len(FEATURE_NAMES), 12)
        self.assertAlmostEqual(feats["pitch_mean"], 12.0, places=6)
        self.assertAlmostEqual(feats["gyro_mag_mean"], 3.0, places=6)

    def test_invalid_ratio(self):
        # 12/40=30% 未超限 → 有特征；13/40=32.5% 超限 → None
        win = stream("D1", "P1", BASE_TS, 40)
        for i in range(12):
            win[i]["quality"]["status"] = "invalid"
        self.assertIsNotNone(extract_features(win))
        win[12]["quality"]["status"] = "invalid"
        self.assertIsNone(extract_features(win))

    def test_insufficient_samples(self):
        self.assertIsNone(extract_features(stream("D1", "P1", BASE_TS, 10)))
        self.assertIsNone(extract_features([]))

    def test_missing_fields_count_invalid(self):
        win = stream("D1", "P1", BASE_TS, 40)
        for m in win[:13]:
            del m["telemetry"]["pitch_deg"]  # 关键字段缺失等同 invalid
        self.assertIsNone(extract_features(win))


# ---------- 规则引擎 ----------
class RuleTest(unittest.TestCase):
    def setUp(self):
        # 加速测试：持续窗口缩到 1s，冷却 30s
        self.rules = RuleEngine(config={"bend_sec": 1, "load_sec": 1,
                                        "degraded_sec": 1, "cooldown_sec": 30})

    def test_posture_bend_long_trigger_close_cooldown(self):
        r = self.rules
        drafts = []
        # 弯腰 1s（20Hz×20）：第 21 条触发
        for m in stream("D1", "P1", BASE_TS, 21, pitch=50.0):
            drafts += r.on_telemetry(m)
        fires = [d for d in drafts if d["event_code"] == "POSTURE_BEND_LONG"
                 and "end_time" not in d]
        self.assertEqual(len(fires), 1)
        d = fires[0]
        self.assertEqual(d["severity"], "L1")
        self.assertEqual(d["start_time"], ms_to_ts(BASE_TS))
        self.assertEqual(d["trigger"]["type"], "rule")
        self.assertEqual(d["trigger"]["rule_version"], "risk-rule-v1.0")
        # 条件仍满足 → 不重复触发
        more = []
        for m in stream("D1", "P1", BASE_TS + 1050, 20, seq0=100, pitch=50.0):
            more += r.on_telemetry(m)
        self.assertEqual([x for x in more if "end_time" not in x], [])
        # 条件消失 → 收口 draft 带 end_time
        close = r.on_telemetry(mk_msg("D1", "P1", BASE_TS + 2100, 200, pitch=5.0))
        closes = [x for x in close if x.get("end_time")]
        self.assertEqual(len(closes), 1)
        self.assertEqual(closes[0]["event_code"], "POSTURE_BEND_LONG")
        # 冷却 30s 内再触发 → 被抑制
        again = []
        for m in stream("D1", "P1", BASE_TS + 3000, 25, seq0=300, pitch=50.0):
            again += r.on_telemetry(m)
        self.assertEqual([x for x in again if "end_time" not in x], [])
        # 冷却期满后（>30s）→ 再次触发
        late = []
        for m in stream("D1", "P1", BASE_TS + 40000, 21, seq0=400, pitch=50.0):
            late += r.on_telemetry(m)
        self.assertEqual(len([x for x in late if "end_time" not in x]), 1)

    def test_load_continuous(self):
        r = self.rules
        drafts = []
        for m in stream("D1", "P1", BASE_TS, 21, torque=30.0):
            drafts += r.on_telemetry(m)
        fires = [d for d in drafts if d["event_code"] == "LOAD_CONTINUOUS"]
        self.assertEqual(len(fires), 1)
        self.assertEqual(fires[0]["severity"], "L2")
        # assist_level 单独超阈同样触发（另一台设备避免冷却干扰）
        drafts2 = []
        for m in stream("D2", "P1", BASE_TS, 21, seq0=500, assist=0.9):
            drafts2 += r.on_telemetry(m)
        self.assertEqual(len([d for d in drafts2
                              if d["event_code"] == "LOAD_CONTINUOUS"]), 1)

    def test_sensor_degraded(self):
        r = self.rules
        drafts = []
        for m in stream("D1", "P1", BASE_TS, 21, status="degraded"):
            drafts += r.on_telemetry(m)
        fires = [d for d in drafts if d["event_code"] == "SENSOR_DEGRADED"]
        self.assertEqual(len(fires), 1)
        # 恢复 good → 收口
        close = r.on_telemetry(mk_msg("D1", "P1", BASE_TS + 1100, 600))
        self.assertEqual(len([x for x in close if x.get("end_time")
                              and x["event_code"] == "SENSOR_DEGRADED"]), 1)

    def test_device_offline_and_recover(self):
        r = self.rules
        d = r.on_offline("D1", BASE_TS)
        self.assertIsNotNone(d)
        self.assertEqual(d["event_code"], "DEVICE_OFFLINE")
        self.assertEqual(d["severity"], "L1")
        # 已开启状态下重复离线 → None
        self.assertIsNone(r.on_offline("D1", BASE_TS + 1000))
        # 恢复 → 返回 None，收口 draft 随下次遥测吐出
        self.assertIsNone(r.on_recover("D1", BASE_TS + 5000))
        out = r.on_telemetry(mk_msg("D1", "P1", BASE_TS + 5050, 700))
        closes = [x for x in out if x.get("end_time")
                  and x["event_code"] == "DEVICE_OFFLINE"]
        self.assertEqual(len(closes), 1)

    def test_demo_and_field_defaults(self):
        demo = RuleEngine(config={"bend_sec": 10, "load_sec": 8})
        self.assertEqual(demo.cfg["bend_sec"], 10)
        self.assertEqual(demo.cfg["load_sec"], 8)
        field = RuleEngine()
        self.assertEqual(field.cfg["bend_sec"], 60)
        self.assertEqual(field.cfg["load_sec"], 150)


# ---------- 模型 unknown 三路径 ----------
class ModelUnknownTest(unittest.TestCase):
    def setUp(self):
        # 手工三质心：A=[0,...] B=[1.5,0,...] C=[3.0,0,...]，mean=0/std=1
        m = ActionModel()
        m.centroids = {
            "A": [0.0] * 12,
            "B": [1.5] + [0.0] * 11,
            "C": [3.0] + [0.0] * 11,
        }
        self.model = m

    def _feats(self, pitch_mean):
        f = {k: 0.0 for k in FEATURE_NAMES}
        f["pitch_mean"] = pitch_mean
        return f

    def test_data_quality(self):
        r = self.model.predict(None)
        self.assertEqual(r["label"], "unknown")
        self.assertEqual(r["unknown_reason"], "data_quality")

    def test_ambiguous(self):
        # 距 A/B 相等 → 前两名差距 0 < 0.08
        r = self.model.predict(self._feats(0.75))
        self.assertEqual(r["label"], "unknown")
        self.assertEqual(r["unknown_reason"], "ambiguous")

    def test_low_confidence(self):
        # 最近 B 但 top1≈0.5465 < 0.55，且与次名差距≈0.215 ≥ 0.08
        r = self.model.predict(self._feats(1.0))
        self.assertEqual(r["label"], "unknown")
        self.assertEqual(r["unknown_reason"], "low_confidence")

    def test_normal_predict(self):
        r = self.model.predict(self._feats(0.05))
        self.assertEqual(r["label"], "A")
        self.assertIsNone(r["unknown_reason"])
        self.assertGreaterEqual(r["confidence"], 0.55)


# ---------- 训练评测（人员独立） ----------
# 4 动作的特征签名（12 维基准值）
ACTION_BASE = {
    "stand": [8, 1, 12, 2, 1, 5, 2, 10, 0.3, 5, 8, 0.2],
    "walk": [12, 2, 18, 2, 1, 80, 25, 150, 2.5, 6, 10, 0.3],
    "bend": [55, 8, 70, 3, 1, 10, 4, 20, 0.6, 8, 12, 0.3],
    "lift": [35, 6, 50, 3, 1, 15, 6, 30, 1.0, 30, 45, 0.7],
}


def synth_dataset(ds_dir, persons, quirk, n_per=30, seed=7):
    """生成合成数据集：每人每动作 n_per 条特征样本，含人员 quirk 偏移。"""
    rng = random.Random(seed)
    rows = []
    for p in persons:
        for action, base in ACTION_BASE.items():
            for _ in range(n_per):
                feats = {k: round(v * quirk[p] + rng.gauss(0, 0.02 * abs(v) + 0.01), 4)
                         for k, v in zip(FEATURE_NAMES, base)}
                rows.append({"features": feats, "label": action,
                             "person_id": p, "session_id": "SES-%s" % p})
    with open(os.path.join(ds_dir, "windows.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class TrainEvalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.ds = os.path.join(self.tmp, "dataset-v0.1")
        os.makedirs(self.ds)
        self.persons = ["P1", "P2", "P3"]
        synth_dataset(self.ds, self.persons, quirk={"P1": 1.0, "P2": 1.02, "P3": 0.98})
        manifest = {"version": "0.1", "source_type": "controlled_test",
                    "splits": {"train": ["P1"], "val": ["P2"], "test": ["P3"]}}
        with open(os.path.join(self.ds, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)

    def test_train_person_independent_macro_f1(self):
        out = os.path.join(self.tmp, "models")
        rc = train_mod.run(["--dataset", self.ds, "--out", out, "--register"])
        self.assertEqual(rc, 0)
        vdir = os.path.join(out, "action-classifier-v0.1.0")
        for name in ("model.json", "metrics.json", "eval_report.md", "model_card.md"):
            self.assertTrue(os.path.exists(os.path.join(vdir, name)), name)
        with open(os.path.join(vdir, "metrics.json"), encoding="utf-8") as f:
            metrics = json.load(f)
        # 人员独立 test：P3 未参与训练/选阈值
        self.assertEqual(metrics["persons"]["test"], ["P3"])
        self.assertGreaterEqual(metrics["test_metrics"]["macro_f1"], 0.85)
        self.assertIn("confusion", metrics["test_metrics"])
        self.assertLess(metrics["latency"]["p95"], 300)  # 远低于 P95<300ms 门禁
        # --register 已激活
        reg = ModelRegistry(out)
        got = reg.active()
        self.assertIsNotNone(got)
        self.assertEqual(got[1]["version"], "0.1.0")
        # 版本递增
        rc = train_mod.run(["--dataset", self.ds, "--out", out])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.isdir(os.path.join(out, "action-classifier-v0.2.0")))

    def test_person_leak_rejected(self):
        with open(os.path.join(self.ds, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"version": "0.1",
                       "splits": {"train": ["P1", "P2"], "val": ["P2"], "test": ["P3"]}}, f)
        with self.assertRaises(SystemExit):
            train_mod.load_dataset(self.ds)


# ---------- 模型注册表 ----------
class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _make_model(self, tag):
        m = ActionModel()
        m.centroids = {"stand": [0.0] * 12, "walk": [2.0] + [0.0] * 11}
        m.version = tag
        return m

    def test_activate_rollback_corrupt(self):
        reg = ModelRegistry(self.tmp)
        for ver in ("0.1.0", "0.2.0"):
            d = os.path.join(self.tmp, "action-classifier-v%s" % ver)
            os.makedirs(d)
            self._make_model(ver).save(os.path.join(d, "model.json"))
            reg.register(ver, os.path.join("action-classifier-v%s" % ver, "model.json"))
            reg.activate(ver)
        self.assertEqual(reg.versions(), ["0.1.0", "0.2.0"])
        model, meta = reg.active()
        self.assertEqual(meta["version"], "0.2.0")
        self.assertEqual(model.version, "0.2.0")
        # 回滚
        self.assertEqual(reg.rollback(), "0.1.0")
        self.assertEqual(reg.active()[1]["version"], "0.1.0")
        self.assertIsNone(reg.rollback())  # 无更早历史
        # 损坏活动模型文件 → active() 返回 None；load 抛 ModelError
        bad = os.path.join(self.tmp, "action-classifier-v0.1.0", "model.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertIsNone(reg.active())
        with self.assertRaises(ModelError):
            ActionModel.load(bad)

    def test_empty_registry(self):
        self.assertIsNone(ModelRegistry(self.tmp).active())


# ---------- 推理管线 ----------
class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.storage = FakeStorage()
        self.bus = FakeBus()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.registry = ModelRegistry(self.tmp)
        self.rules = RuleEngine(config={"bend_sec": 1, "load_sec": 1,
                                        "degraded_sec": 1, "cooldown_sec": 30})
        self.pipe = InferencePipeline(self.storage, self.bus, self.registry, self.rules)

    def _feed(self, msgs):
        res = None
        for m in msgs:
            r = self.pipe.handle_telemetry(m)
            if r is not None:
                res = r
        return res

    def test_rule_fallback_without_model(self):
        res = self._feed(stream("D1", "P1", BASE_TS, 40))
        self.assertIsNotNone(res)
        self.assertTrue(res["is_rule"])
        self.assertEqual(res["model_version"], "rule-fallback")
        self.assertEqual(res["label"], "stand")
        self.assertTrue(res["inference_id"].startswith("INF-"))
        self.assertEqual(res["window_sec"], 2)
        self.assertEqual(len(res["key_features"]), 3)
        self.assertEqual(res["data_quality"], "good")
        self.assertIsNone(res["unknown_reason"])
        self.assertFalse(res["entered_event_judgment"])
        self.assertEqual(res["ts_start"], ms_to_ts(BASE_TS))
        self.assertEqual(res["source_type"], "controlled_test")
        self.assertGreaterEqual(res["inference_ms"], 0)
        # 入库 + 总线发布 + 步长 1s 后再出一条
        self.assertEqual(len(self.storage.inferences), 1)
        self.assertEqual(len(self.bus.published.get("inference", [])), 1)
        res2 = self._feed(stream("D1", "P1", BASE_TS + 2000, 20, seq0=100))
        self.assertIsNotNone(res2)
        self.assertEqual(len(self.storage.inferences), 2)
        self.assertGreater(self.pipe.metrics()["count"], 0)

    def test_rule_fallback_bend_and_event_judgment(self):
        # 弯腰：规则降级标签 bend；持续 1s 触发 POSTURE_BEND_LONG → 进入事件判断
        res = self._feed(stream("D1", "P1", BASE_TS, 40, pitch=50.0))
        self.assertEqual(res["label"], "bend")
        self.assertTrue(res["entered_event_judgment"])
        open_evts = [e for e in self.storage.events.values() if e["status"] == "open"]
        self.assertEqual(len(open_evts), 1)
        self.assertEqual(open_evts[0]["event_code"], "POSTURE_BEND_LONG")
        self.assertEqual(len(self.bus.published.get("event", [])), 1)

    def test_model_path_when_registered(self):
        # 注册一个以真实特征训练的模型 → 走模型路径，is_rule=False
        stand = extract_features(stream("D9", "P9", BASE_TS, 40))
        walk = extract_features(stream("D9", "P9", BASE_TS, 40,
                                       gyro=(30.0, 50.0, 60.0), accel=(1.0, 1.0, 9.8)))
        m = ActionModel().fit([{"features": stand, "label": "stand"},
                               {"features": walk, "label": "walk"}])
        d = os.path.join(self.tmp, "action-classifier-v0.1.0")
        os.makedirs(d)
        m.save(os.path.join(d, "model.json"))
        self.registry.register("0.1.0", "action-classifier-v0.1.0/model.json")
        self.registry.activate("0.1.0")
        res = self._feed(stream("D2", "P2", BASE_TS, 40))
        self.assertFalse(res["is_rule"])
        self.assertEqual(res["model_version"], "0.1.0")
        self.assertEqual(res["model_id"], "action-classifier")
        self.assertEqual(res["label"], "stand")

    def test_device_offline_via_status(self):
        self.pipe.handle_device_status({"device_id": "D1", "status": "offline",
                                        "timestamp": ms_to_ts(BASE_TS)})
        evts = [e for e in self.storage.events.values()
                if e["event_code"] == "DEVICE_OFFLINE"]
        self.assertEqual(len(evts), 1)


# ---------- 事件引擎证据窗 ----------
class EventEngineTest(unittest.TestCase):
    def setUp(self):
        self.storage = FakeStorage()
        self.bus = FakeBus()
        self.engine = EventEngine(self.storage, self.bus, window_sec=30)
        # 事件起点前后 40s 遥测（20Hz）
        for m in stream("D1", "P1", BASE_TS - 40000, 1641):
            self.storage.insert_telemetry(m, None)

    def _draft(self, **kw):
        d = {"event_code": "POSTURE_BEND_LONG", "severity": "L1", "person_id": "P1",
             "device_id": "D1", "start_time": ms_to_ts(BASE_TS),
             "trigger": {"type": "rule", "rule_version": "risk-rule-v1.0",
                         "condition": "pitch_deg>45.0 持续>=1s"},
             "source_type": "controlled_test"}
        d.update(kw)
        return d

    def test_evidence_window_covers_30s(self):
        evt = self.engine.handle_draft(self._draft())
        self.assertTrue(evt["event_id"].startswith("EVT-"))
        got = self.storage.get_event(evt["event_id"])
        ev = got["evidence"]
        self.assertEqual(ev["window_before_sec"], 30)
        self.assertEqual(ev["window_after_sec"], 30)
        ids = ev["record_ids"]
        self.assertLessEqual(len(ids), 200)
        before = [i for i in ids if i["segment"] == "before"]
        after = [i for i in ids if i["segment"] == "after"]
        self.assertTrue(before and after)
        rid2ts = {m["record_id"]: ts_to_ms(m["timestamp"]) for m in self.storage.telemetry}
        # 前段：均在事件开始前且不早于 start-30s
        for i in before:
            t = rid2ts[i["record_id"]]
            self.assertTrue(BASE_TS - 30000 <= t < BASE_TS)
        for i in after:
            t = rid2ts[i["record_id"]]
            self.assertTrue(BASE_TS < t <= BASE_TS + 30000)
        # 前段最早一条接近 start-30s（覆盖满 30s 窗口）
        first_before = min(rid2ts[i["record_id"]] for i in before)
        self.assertLessEqual(first_before, BASE_TS - 30000 + 1000)
        self.assertEqual(ev["data_quality"], "good")
        self.assertEqual(got["status"], "open")
        self.assertEqual(got["trigger"]["rule_version"], "risk-rule-v1.0")
        self.assertEqual(len(self.bus.published.get("event", [])), 1)

    def test_close_event(self):
        evt = self.engine.handle_draft(self._draft())
        self.engine.handle_draft(self._draft(end_time=ms_to_ts(BASE_TS + 5000)))
        got = self.storage.get_event(evt["event_id"])
        self.assertEqual(got["status"], "closed")
        self.assertEqual(got["handling"]["end_time"], ms_to_ts(BASE_TS + 5000))


# ---------- 采集会话与数据集导出 ----------
class DatasetExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.storage = FakeStorage(db_path=os.path.join(self.tmp, "test.db"))
        self.sm = SessionManager(self.storage)

    def _build_person(self, person, t0):
        dev = "DEV-%s" % person
        sid = self.sm.start_session(person_id=person, device_id=dev,
                                    firmware_version="fw-1.0", wear_position="waist",
                                    wear_tightness="normal", consent_id="AUTH-001",
                                    observer="obs1")
        # 4 个动作标签，每段 3s（20Hz×61 条 → 每段 2 个样本）
        actions = ["stand", "walk", "bend", "lift"]
        seq = 0
        for j, act in enumerate(actions):
            seg0 = t0 + j * 4000
            self.sm.add_label(sid, act, ms_to_ts(seg0), ms_to_ts(seg0 + 3000),
                              labeler="lb1", quality="good", aux_tags=["unloaded"])
            kw = {"pitch": 50.0} if act == "bend" else {}
            if act == "walk":
                kw = {"gyro": (30.0, 50.0, 60.0)}
            if act == "lift":
                kw = {"pitch": 35.0, "torque": 30.0, "assist": 0.7}
            for m in stream(dev, person, seg0, 61, seq0=seq, **kw):
                self.storage.insert_telemetry(m, None)
                seq += 1
        self.sm.stop_session(sid)
        return sid

    def test_session_crud(self):
        sid = self.sm.start_session(person_id="PX", device_id="DX", notes="n")
        self.sm.add_label(sid, "stand", ms_to_ts(BASE_TS), ms_to_ts(BASE_TS + 1000),
                          "lb", "good", ["light"])
        self.sm.stop_session(sid)
        sess = self.sm.get_session(sid)
        self.assertEqual(sess["status"], "closed")
        self.assertEqual(sess["person_id"], "PX")
        self.assertEqual(len(sess["labels"]), 1)
        self.assertEqual(sess["labels"][0]["aux_tags"], ["light"])
        self.assertEqual(len(self.sm.list_sessions()), 1)
        with self.assertRaises(ValueError):
            self.sm.start_session(bad_field=1)

    def test_export_person_purity(self):
        for i, p in enumerate(["P1", "P2", "P3"]):
            self._build_person(p, BASE_TS + i * 100000)
        out = os.path.join(self.tmp, "datasets")
        manifest = export_dataset(self.storage, out, "0.1")
        persons = manifest["persons"]
        tr, va, te = set(persons["train"]), set(persons["val"]), set(persons["test"])
        self.assertEqual(tr | va | te, {"P1", "P2", "P3"})
        self.assertFalse(tr & va or tr & te or va & te)  # 人员纯净
        total = sum(sum(c.values()) for c in manifest["counts"].values())
        self.assertEqual(total, 24)  # 3 人 × 4 动作 × 2 窗
        self.assertEqual(manifest["source_type"], "controlled_test")
        ds_dir = os.path.join(out, "dataset-v0.1")
        with open(os.path.join(ds_dir, "windows.jsonl"), encoding="utf-8") as f:
            lines = [json.loads(x) for x in f if x.strip()]
        self.assertEqual(len(lines), 24)
        self.assertEqual(set(lines[0]["features"].keys()), set(FEATURE_NAMES))
        self.assertIn("windows.jsonl", manifest["sha256"])
        q = manifest["quality"]
        self.assertLess(q["sampling_rate_deviation_pct"], 5.0)  # 质量门槛 ≤5%
        self.assertEqual(q["field_missing_rate"], 0.0)
        self.assertIsNotNone(q["label_coverage"])
        # manifest  splits 供 train.py 使用
        with open(os.path.join(ds_dir, "manifest.json"), encoding="utf-8") as f:
            m2 = json.load(f)
        self.assertEqual(m2["splits"]["train"], persons["train"])

    def test_export_rejects_too_few_persons(self):
        self._build_person("P1", BASE_TS)
        with self.assertRaises(ValueError):
            export_dataset(self.storage, os.path.join(self.tmp, "ds2"), "0.1")


if __name__ == "__main__":
    unittest.main()
