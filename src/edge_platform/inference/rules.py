"""确定性规则引擎（风险事件初判）。

规则始终运行，与模型无关；输出事件草稿（draft）交给 EventEngine 开/关事件。
- POSTURE_BEND_LONG  L1  pitch>bend_pitch_deg 持续 bend_sec
- LOAD_CONTINUOUS    L2  torque_nm>load_torque_nm 或 assist_level>load_assist 持续 load_sec
- SENSOR_DEGRADED    L1  quality.status!=good 持续 degraded_sec（invalid 同属非 good）
- DEVICE_OFFLINE     L1  由 on_offline 回调触发；on_recover 标记恢复，
                         收口 draft 在下一次 on_telemetry 时随返回值吐出（签名保持 ->None）

每个 (设备, 事件代码) 有冷却（默认 30s）防止刷屏；条件消失时输出带 end_time 的收口 draft。
阈值可由 config 覆盖：demo 用短窗 {"bend_sec":10,"load_sec":8}，现场默认 60/150。
"""

from . import ts_to_ms, ms_to_ts

# 现场默认阈值
DEFAULT_CONFIG = {
    "bend_pitch_deg": 45.0,
    "bend_sec": 60,
    "load_torque_nm": 20.0,
    "load_assist": 0.8,
    "load_sec": 150,
    "degraded_sec": 5,
    "cooldown_sec": 30,
}

# 演示短窗（现场演示等待时间不可过长）
DEMO_CONFIG = dict(DEFAULT_CONFIG, bend_sec=10, load_sec=8)

# 事件代码 -> 默认等级
SEVERITY = {
    "POSTURE_BEND_LONG": "L1",
    "LOAD_CONTINUOUS": "L2",
    "SENSOR_DEGRADED": "L1",
    "DEVICE_OFFLINE": "L1",
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
        self._state = {}    # device_id -> {"bend_since","load_since","degraded_since"}(ms)
        self._open = {}     # (device_id,event_code) -> 开启 draft
        self._fired = {}    # (device_id,event_code) -> 上次触发 ms（冷却用）
        self._pending = []  # on_recover 产生的收口 draft，随下次 on_telemetry 吐出

    # ---- 内部工具 ----
    def _st(self, dev):
        return self._state.setdefault(
            dev, {"bend_since": None, "load_since": None, "degraded_since": None})

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

    def _track(self, st_key, cond, ts_ms, dur_sec, code, dev, person, src, condition):
        """持续型条件通用状态机：满足计时、超时触发；条件消失则收口。"""
        out = []
        key = (dev, code)
        st = self._st(dev)
        if cond:
            if st[st_key] is None:
                st[st_key] = ts_ms
            elif ts_ms - st[st_key] >= dur_sec * 1000 and key not in self._open:
                if self._cooldown_ok(key, ts_ms):
                    d = self._draft(code, dev, person, st[st_key], src, condition)
                    self._open[key] = d
                    self._fired[key] = ts_ms
                    out.append(d)
        else:
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
        src = msg.get("source_type")
        tel = msg.get("telemetry") or {}
        qstatus = (msg.get("quality") or {}).get("status", "good")

        pitch = _f(tel.get("pitch_deg"))
        cond_bend = pitch is not None and pitch > self.cfg["bend_pitch_deg"]
        drafts += self._track(
            "bend_since", cond_bend, ts_ms, self.cfg["bend_sec"],
            "POSTURE_BEND_LONG", dev, person, src,
            "pitch_deg>%s 持续>=%ss" % (self.cfg["bend_pitch_deg"], self.cfg["bend_sec"]))

        torque = _f(tel.get("torque_nm"))
        assist = _f(tel.get("assist_level"))
        cond_load = ((torque is not None and torque > self.cfg["load_torque_nm"])
                     or (assist is not None and assist > self.cfg["load_assist"]))
        drafts += self._track(
            "load_since", cond_load, ts_ms, self.cfg["load_sec"],
            "LOAD_CONTINUOUS", dev, person, src,
            "torque_nm>%s 或 assist_level>%s 持续>=%ss"
            % (self.cfg["load_torque_nm"], self.cfg["load_assist"], self.cfg["load_sec"]))

        cond_deg = qstatus != "good"
        drafts += self._track(
            "degraded_since", cond_deg, ts_ms, self.cfg["degraded_sec"],
            "SENSOR_DEGRADED", dev, person, src,
            "quality.status!=good 持续>=%ss" % self.cfg["degraded_sec"])
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
