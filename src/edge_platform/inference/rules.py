"""确定性规则引擎（风险事件初判）。

规则始终运行，与模型无关；输出事件草稿（draft）交给 EventEngine 开/关事件。
- POSTURE_BEND_LONG  L1  pitch>bend_pitch_deg 持续 bend_sec
- LOAD_CONTINUOUS    L2  torque_nm>load_torque_nm 或 assist_level>load_assist 持续 load_sec
- SENSOR_DEGRADED    L1  quality.status!=good 持续 degraded_sec（invalid 同属非 good）
- DEVICE_OFFLINE     L1  由 on_offline 回调触发；on_recover 标记恢复，
                         收口 draft 在下一次 on_telemetry 时随返回值吐出（签名保持 ->None）
- LOW_BATTERY        L1  battery_percent<low_battery_pct 持续 low_battery_sec（Task 21）
- TIME_SYNC_ANOMALY  L1  时间戳倒退/漂移超过阈值（Task 21）
- PACKET_LOSS_BURST  L1  packet_loss_pct>packet_loss_enter_pct 持续 packet_loss_sec（Task 21）
- ACTION_ANOMALY_LOW_QUALITY  L1  动作异常(unknown)且 data_quality!=good（Task 21，on_inference 触发）

每个 (设备, 事件代码) 有冷却（默认 30s）防止刷屏；条件消失时输出带 end_time 的收口 draft。
Task 22 滞回区间（hysteresis）：enter_threshold 与 exit_threshold 分离，
默认 exit = enter * 0.8（"低于阈值" 类规则 exit = enter + 反向裕度）。
阈值可由 config 覆盖：demo 用短窗 {"bend_sec":10,"load_sec":8}，现场默认 60/150。
"""

from . import ts_to_ms, ms_to_ts

# 现场默认阈值
# exit_*  值为 None 时按规则自动从 enter 派生（见 _derive_exit_thresholds）。
DEFAULT_CONFIG = {
    "bend_pitch_deg": 45.0,
    "bend_pitch_exit_deg": None,          # auto: bend_pitch_deg * 0.8
    "bend_sec": 60,
    "load_torque_nm": 20.0,
    "load_torque_exit_nm": None,          # auto: load_torque_nm * 0.8
    "load_assist": 0.8,
    "load_assist_exit": None,             # auto: load_assist * 0.8
    "load_sec": 150,
    "degraded_sec": 5,
    "cooldown_sec": 30,
    # Task 21 新增规则阈值
    "low_battery_pct": 10.0,
    "low_battery_exit_pct": None,         # auto: low_battery_pct + 2（反向裕度）
    "low_battery_sec": 5,
    "time_sync_drift_ms": 5000,
    "time_sync_exit_ms": None,            # auto: time_sync_drift_ms * 0.8
    "time_sync_sec": 1,
    "packet_loss_enter_pct": 10.0,
    "packet_loss_exit_pct": None,         # auto: packet_loss_enter_pct * 0.8
    "packet_loss_sec": 5,
    "action_anomaly_sec": 5,
}

# 演示短窗（现场演示等待时间不可过长）
DEMO_CONFIG = dict(DEFAULT_CONFIG, bend_sec=10, load_sec=8)

# 事件代码 -> 默认等级
SEVERITY = {
    "POSTURE_BEND_LONG": "L1",
    "LOAD_CONTINUOUS": "L2",
    "SENSOR_DEGRADED": "L1",
    "DEVICE_OFFLINE": "L1",
    "LOW_BATTERY": "L1",
    "TIME_SYNC_ANOMALY": "L1",
    "PACKET_LOSS_BURST": "L1",
    "ACTION_ANOMALY_LOW_QUALITY": "L1",
}


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class RuleEngine:
    def __init__(self, rule_version="risk-rule-v1.0", config=None):
        self.rule_version = rule_version
        self.cfg = dict(DEFAULT_CONFIG)
        if config:
            self.cfg.update(config)
        self._derive_exit_thresholds()
        self._state = {}    # device_id -> {*_since: ms|None} 持续型计时
        self._open = {}     # (device_id,event_code) -> 开启 draft
        self._fired = {}    # (device_id,event_code) -> 上次触发 ms（冷却用）
        self._pending = []  # on_recover 产生的收口 draft，随下次 on_telemetry 吐出
        self._last_ts = {}  # device_id -> 上一条遥测 ms（时间戳倒退/漂移检测）
        self._person = {}   # device_id -> 最新 person_id（on_inference 复用）

    # ---- exit_threshold 自动派生（Task 22 滞回区间） ----
    def _derive_exit_thresholds(self):
        """exit 阈值为 None 时按规则从 enter 派生。

        "高于阈值" 类（pitch/torque/assist/packet_loss/drift）：exit = enter * 0.8
        "低于阈值" 类（battery）：exit = enter + 2（反向裕度，避免抖动收口）
        """
        c = self.cfg
        if c.get("bend_pitch_exit_deg") is None:
            c["bend_pitch_exit_deg"] = c["bend_pitch_deg"] * 0.8
        if c.get("load_torque_exit_nm") is None:
            c["load_torque_exit_nm"] = c["load_torque_nm"] * 0.8
        if c.get("load_assist_exit") is None:
            c["load_assist_exit"] = c["load_assist"] * 0.8
        if c.get("low_battery_exit_pct") is None:
            c["low_battery_exit_pct"] = c["low_battery_pct"] + 2.0
        if c.get("time_sync_exit_ms") is None:
            c["time_sync_exit_ms"] = c["time_sync_drift_ms"] * 0.8
        if c.get("packet_loss_exit_pct") is None:
            c["packet_loss_exit_pct"] = c["packet_loss_enter_pct"] * 0.8

    # ---- 内部工具 ----
    def _st(self, dev):
        return self._state.setdefault(
            dev, {"bend_since": None, "load_since": None, "degraded_since": None,
                  "low_battery_since": None, "packet_loss_since": None,
                  "time_sync_since": None, "action_anomaly_since": None})

    def _cooldown_ok(self, key, ts_ms):
        last = self._fired.get(key)
        return last is None or ts_ms - last >= self.cfg["cooldown_sec"] * 1000

    def _draft(self, code, dev, person, start_ms, source_type, condition):
        return {
            "event_code": code,
            "severity": SEVERITY[code],
            "person_id": person,
            "device_id": dev,
            "start_time": ms_to_ts(start_ms),
            "trigger": {
                "type": "rule",
                "rule_version": self.rule_version,
                "condition": condition,
            },
            "source_type": source_type or "real",
        }

    def _track(self, st_key, cond_enter, ts_ms, dur_sec, code, dev, person, src,
               condition, cond_exit=None):
        """持续型条件通用状态机（Task 22 滞回区间）。

        cond_enter: 进入条件（满足时计时/触发）。
        cond_exit:  退出条件（满足时保持，不满足且 cond_enter 也不满足时收口）。
                    默认等于 cond_enter（无滞回，向后兼容）。
        dur_sec=0 时支持即时触发（首条满足即触发）。
        """
        if cond_exit is None:
            cond_exit = cond_enter
        out = []
        key = (dev, code)
        st = self._st(dev)
        if cond_enter:
            if st[st_key] is None:
                st[st_key] = ts_ms
            # dur_sec=0 → 即时触发；否则需持续满 dur_sec
            if (dur_sec == 0 or ts_ms - st[st_key] >= dur_sec * 1000) \
                    and key not in self._open:
                if self._cooldown_ok(key, ts_ms):
                    d = self._draft(code, dev, person, st[st_key], src, condition)
                    self._open[key] = d
                    self._fired[key] = ts_ms
                    out.append(d)
        elif not cond_exit:
            # 进入条件不满足且退出条件也不满足 → 收口
            # （滞回区间内 cond_exit 仍为 True → 不收口，计时保持）
            st[st_key] = None
            if key in self._open:
                d = self._open.pop(key)
                d = dict(d)
                d["end_time"] = ms_to_ts(ts_ms)  # 收口：供 EventEngine 关闭事件
                out.append(d)
        return out

    # ---- 对外接口 ----
    def on_telemetry(self, msg):
        """处理一条标准遥测，返回本消息产生的 draft 列表（开启或收口）。"""
        drafts, self._pending = list(self._pending), []
        dev = msg.get("device_id")
        if not dev:
            return drafts
        ts_ms = ts_to_ms(msg["timestamp"])
        person = msg.get("person_id")
        if person:
            self._person[dev] = person
        src = msg.get("source_type")
        tel = msg.get("telemetry") or {}
        q = msg.get("quality") or {}
        qstatus = q.get("status", "good")

        pitch = _f(tel.get("pitch_deg"))
        bend_enter = pitch is not None and pitch > self.cfg["bend_pitch_deg"]
        bend_exit = pitch is not None and pitch > self.cfg["bend_pitch_exit_deg"]
        drafts += self._track(
            "bend_since", bend_enter, ts_ms, self.cfg["bend_sec"],
            "POSTURE_BEND_LONG", dev, person, src,
            "pitch_deg>%s 持续>=%ss" % (self.cfg["bend_pitch_deg"], self.cfg["bend_sec"]),
            cond_exit=bend_exit)

        torque = _f(tel.get("torque_nm"))
        assist = _f(tel.get("assist_level"))
        load_enter = ((torque is not None and torque > self.cfg["load_torque_nm"])
                      or (assist is not None and assist > self.cfg["load_assist"]))
        load_exit = ((torque is not None and torque > self.cfg["load_torque_exit_nm"])
                     or (assist is not None and assist > self.cfg["load_assist_exit"]))
        drafts += self._track(
            "load_since", load_enter, ts_ms, self.cfg["load_sec"],
            "LOAD_CONTINUOUS", dev, person, src,
            "torque_nm>%s 或 assist_level>%s 持续>=%ss"
            % (self.cfg["load_torque_nm"], self.cfg["load_assist"], self.cfg["load_sec"]),
            cond_exit=load_exit)

        cond_deg = qstatus != "good"
        drafts += self._track(
            "degraded_since", cond_deg, ts_ms, self.cfg["degraded_sec"],
            "SENSOR_DEGRADED", dev, person, src,
            "quality.status!=good 持续>=%ss" % self.cfg["degraded_sec"])

        # ---- Task 21 新增规则 ----
        # LOW_BATTERY：battery_percent < low_battery_pct 持续 low_battery_sec
        battery = _f(tel.get("battery_percent"))
        lb_enter = battery is not None and battery < self.cfg["low_battery_pct"]
        lb_exit = battery is not None and battery < self.cfg["low_battery_exit_pct"]
        drafts += self._track(
            "low_battery_since", lb_enter, ts_ms, self.cfg["low_battery_sec"],
            "LOW_BATTERY", dev, person, src,
            f"battery_percent<{self.cfg['low_battery_pct']} 持续>={self.cfg['low_battery_sec']}s",
            cond_exit=lb_exit)

        # TIME_SYNC_ANOMALY：时间戳倒退 / 漂移超过阈值
        last_ts = self._last_ts.get(dev)
        drift = None
        if last_ts is not None:
            drift = ts_ms - last_ts
        self._last_ts[dev] = ts_ms
        ts_enter = False
        ts_exit = False
        if drift is not None:
            drift_abs = abs(drift)
            ts_enter = (drift < 0) or (drift_abs > self.cfg["time_sync_drift_ms"])
            ts_exit = (drift < 0) or (drift_abs > self.cfg["time_sync_exit_ms"])
        drafts += self._track(
            "time_sync_since", ts_enter, ts_ms, self.cfg["time_sync_sec"],
            "TIME_SYNC_ANOMALY", dev, person, src,
            f"时间戳倒退或漂移>{self.cfg['time_sync_drift_ms']}ms",
            cond_exit=ts_exit)

        # PACKET_LOSS_BURST：packet_loss_pct > packet_loss_enter_pct 持续 packet_loss_sec
        pkt_loss = _f(q.get("packet_loss"))
        pl_enter = pkt_loss is not None and pkt_loss > self.cfg["packet_loss_enter_pct"]
        pl_exit = pkt_loss is not None and pkt_loss > self.cfg["packet_loss_exit_pct"]
        drafts += self._track(
            "packet_loss_since", pl_enter, ts_ms, self.cfg["packet_loss_sec"],
            "PACKET_LOSS_BURST", dev, person, src,
            f"packet_loss_pct>{self.cfg['packet_loss_enter_pct']} 持续>={self.cfg['packet_loss_sec']}s",
            cond_exit=pl_exit)
        return drafts

    def on_inference(self, res):
        """处理推理结果（Task 21 ACTION_ANOMALY_LOW_QUALITY）。

        当推理标签为 unknown 且数据质量非 good 时，按 action_anomaly_sec 持续触发。
        返回 draft 列表。ts_end 缺失时跳过。
        """
        drafts = []
        dev = res.get("device_id")
        if not dev:
            return drafts
        ts_end = res.get("ts_end")
        if not ts_end:
            return drafts
        ts_ms = ts_to_ms(ts_end)
        person = self._person.get(dev)
        src = res.get("source_type")
        cond = res.get("label") == "unknown" and res.get("data_quality") != "good"
        drafts += self._track(
            "action_anomaly_since", cond, ts_ms, self.cfg["action_anomaly_sec"],
            "ACTION_ANOMALY_LOW_QUALITY", dev, person, src,
            f"label=unknown 且 data_quality!=good 持续>={self.cfg['action_anomaly_sec']}s")
        return drafts

    def on_offline(self, device_id, ts):
        """设备离线回调：立即产出 DEVICE_OFFLINE draft（冷却内被抑制则返回 None）。"""
        ts_ms = ts if isinstance(ts, (int, float)) else ts_to_ms(ts)
        key = (device_id, "DEVICE_OFFLINE")
        if key in self._open or not self._cooldown_ok(key, ts_ms):
            return None
        d = self._draft("DEVICE_OFFLINE", device_id, None, ts_ms, "real",
                        "心跳超时/通信中断")
        self._open[key] = d
        self._fired[key] = ts_ms
        return d

    def on_recover(self, device_id, ts):
        """设备恢复回调：收口离线事件。draft 进入待吐队列，返回值固定为 None。"""
        ts_ms = ts if isinstance(ts, (int, float)) else ts_to_ms(ts)
        key = (device_id, "DEVICE_OFFLINE")
        if key in self._open:
            d = dict(self._open.pop(key))
            d["end_time"] = ms_to_ts(ts_ms)
            self._pending.append(d)
        return None
