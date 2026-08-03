"""平台业务逻辑（纯标准库）：
- Task 17 任务推荐：30/20/20/15/15 可解释评分 + 五条硬约束 + 人工确认（禁止自动派工）
- Task 18 本地助手白名单：8 类可答问题引用真实证据，7 类拒绝策略
- 场景评估器：首选条件评分 + 一票否决（delivery/07_场景评估/scenario_evaluator_rules.md）
所有函数只读 Storage 契约接口，不依赖任何第三方库。
"""

import json
from datetime import datetime, timedelta

# ---- 通用小工具 ----------------------------------------------------------


def parse_ts(s):
    """解析 ISO 时间字符串；无时区按本地时区处理；非法输入返回 None。
    容错：URL 未编码的 '+' 会被解码成空格，此处还原。"""
    if not s:
        return None
    s = str(s)
    if s.count(" ") == 1 and "T" in s:
        s = s.replace(" ", "+")
    try:
        return datetime.fromisoformat(s).astimezone()
    except ValueError:
        return None


def iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


def _loads(s, default):
    try:
        return json.loads(s) if isinstance(s, str) else (s or default)
    except (ValueError, TypeError):
        return default


def norm_telemetry(row):
    """把持久层遥测行规范化为标准消息形态（兼容表结构与消息结构两种返回）。"""
    if not row:
        return None
    r = dict(row)
    payload = _loads(r.pop("payload_json", None), {})
    if "telemetry" in payload:  # payload_json 内是完整标准消息
        merged = dict(payload)
        merged.update({k: v for k, v in r.items() if v is not None})
        r = merged
    elif payload:
        r.setdefault("telemetry", payload)
    if "timestamp" not in r and "ts" in r:
        r["timestamp"] = r.get("ts")
    if "sequence" not in r and "seq" in r:
        r["sequence"] = r.get("seq")
    if "quality" not in r:
        r["quality"] = {"status": r.get("quality_status", "unknown")}
    r.setdefault("telemetry", {})
    return r


def norm_inference(row):
    if not row:
        return None
    r = dict(row)
    meta = _loads(r.pop("evidence_json", None), {})
    merged = dict(meta)
    merged.update({k: v for k, v in r.items() if v is not None})
    return merged


def norm_event(row):
    if not row:
        return None
    r = dict(row)
    r["trigger"] = _loads(r.pop("trigger_json", None), r.get("trigger", {}))
    r["evidence"] = _loads(r.pop("evidence_json", None), r.get("evidence", {}))
    r["handling"] = _loads(r.pop("handling_json", None), r.get("handling"))
    return r


def person_skills(person):
    return _loads(person.get("skills_json"), person.get("skills", [])) or []


# ---- Task 17 任务推荐 ----------------------------------------------------

WEIGHTS = {"技能匹配": 30, "区域距离": 20, "当前负荷": 20, "连续作业时长": 15, "近期风险": 15}
WORK_NORM_MIN = 120  # 连续作业时长归一化基准（分钟）
OPEN_HIGH_SEVERITY = ("L2", "L3")


def person_metrics(storage, person, device):
    """从真实记录推导人员指标：当前负荷、连续作业分钟、近期风险。"""
    now = datetime.now().astimezone()
    load, work_min = 0.0, 0.0
    if device:
        latest = norm_telemetry(storage.latest_telemetry(device["device_id"]))
        if latest:
            load = float(latest["telemetry"].get("load_score", 0) or 0)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rows = storage.query_telemetry(device["device_id"], iso(day_start), iso(now), 20000)
        if len(rows) >= 2:
            t0, t1 = parse_ts(norm_telemetry(rows[0])["timestamp"]), parse_ts(norm_telemetry(rows[-1])["timestamp"])
            if t0 and t1:
                work_min = max(0.0, (t1 - t0).total_seconds() / 60)
    open_events = [
        e
        for e in (norm_event(x) for x in storage.list_events(200))
        if e.get("person_id") == person.get("person_id") and e.get("status") == "open"
    ]
    recent_high = [e for e in open_events if e.get("severity") in OPEN_HIGH_SEVERITY]
    risk = min(1.0, 0.2 * len(open_events) + 0.4 * len(recent_high))
    return {
        "current_load": round(load, 3),
        "work_minutes": round(work_min, 1),
        "open_events": len(open_events),
        "open_high_events": len(recent_high),
        "risk_recent": round(risk, 3),
    }


def recommend(storage, assignments, payload, device_online):
    """可解释推荐。device_online: fn(device)->bool，由服务层注入掉线判定。"""
    skill = payload.get("required_skill", "搬运")
    zone = payload.get("zone_id", "")
    load_level = float(payload.get("load_level", 0.5) or 0)
    assigned = {a["person_id"] for a in assignments if a.get("status") == "confirmed"}
    devices = storage.list_devices()
    by_person = {d.get("person_id"): d for d in devices if d.get("person_id")}
    rows = []
    for p in storage.list_people():
        skills = person_skills(p)
        dev = by_person.get(p.get("person_id"))
        m = person_metrics(storage, p, dev)
        skill_ok = skill in skills
        zone_score = 1.0 if p.get("team") == zone or p.get("zone") == zone else 0.6
        capacity = max(0.0, 1 - max(m["current_load"], load_level * 0.3))
        work_score = max(0.0, 1 - m["work_minutes"] / WORK_NORM_MIN)
        risk_score = max(0.0, 1 - m["risk_recent"])
        parts = {
            "技能匹配": round(WEIGHTS["技能匹配"] * skill_ok, 1),
            "区域距离": round(WEIGHTS["区域距离"] * zone_score, 1),
            "当前负荷": round(WEIGHTS["当前负荷"] * capacity, 1),
            "连续作业时长": round(WEIGHTS["连续作业时长"] * work_score, 1),
            "近期风险": round(WEIGHTS["近期风险"] * risk_score, 1),
        }
        # 五条硬约束：无技能 / 高风险未解除 / 设备故障 / 未授权 / 不在岗或任务冲突
        blocked = []
        if not skill_ok:
            blocked.append(f"无技能：不具备任务所需技能「{skill}」")
        if m["open_high_events"]:
            blocked.append(f"高风险未解除：存在 {int(m['open_high_events'])} 条未处置高风险事件")
        if not dev:
            blocked.append("设备故障：未绑定可用外骨骼设备")
        elif not device_online(dev):
            blocked.append(f"设备故障：设备 {dev.get('device_id')} 离线或故障")
        if p.get("consent_status") != "granted":
            blocked.append(f"未授权：人员授权状态为 {p.get('consent_status', 'unknown')}")
        if not p.get("active", 1):
            blocked.append("不在岗：人员状态为停用")
        elif p.get("person_id") in assigned:
            blocked.append("任务冲突：已被确认分配其他任务")
        rows.append(
            {
                "person_id": p.get("person_id"),
                "name": p.get("display_name", p.get("name", "")),
                "eligible": not blocked,
                "blocked_by": blocked,
                "score": round(sum(parts.values()), 1),
                "reasons": parts,
                "metrics": m,
            }
        )
    rows.sort(key=lambda x: (x["eligible"], x["score"]), reverse=True)
    return {
        "weights": WEIGHTS,
        "requires_human_confirm": True,
        "note": "系统只输出可解释推荐，最终派工须由班组长或现场负责人人工确认，平台不自动强制派工。",
        "items": rows,
    }


def confirm_assignment(storage, assignments, payload, device_online):
    """人工确认派工：重新校验硬约束，确认记录仅保存在平台会话内。"""
    task_id = payload.get("task_id") or f"TASK-{datetime.now().strftime('%H%M%S')}"
    person_id = payload.get("person_id")
    confirmer = (payload.get("confirmer") or "").strip()
    if not confirmer:
        return {"ok": False, "error": "必须填写确认人（班组长或现场负责人），禁止自动派工。"}
    cand = [r for r in recommend(storage, assignments, payload, device_online)["items"] if r["person_id"] == person_id]
    if not cand:
        return {"ok": False, "error": "人员不存在。"}
    if not cand[0]["eligible"]:
        return {"ok": False, "error": "硬约束拦截，不可确认。", "blocked_by": cand[0]["blocked_by"]}
    rec = {
        "task_id": task_id,
        "person_id": person_id,
        "confirmer": confirmer,
        "status": "confirmed",
        "confirmed_at": iso(datetime.now()),
    }
    assignments.append(rec)
    return {"ok": True, "assignment": rec}


# ---- Task 18 本地助手白名单 ----------------------------------------------

REFUSE_RULES = [
    (
        "医学诊断",
        ["诊断", "疾病", "病历", "医疗", "受伤", "健康评估", "体检"],
        "平台不提供医学诊断。本平台仅用于作业安全协同，授权用途不包括任何健康或医学判断。",
    ),
    (
        "惩罚性人事",
        ["开除", "降薪", "惩罚", "处罚", "扣钱", "裁员", "保险定价", "考核扣分"],
        "平台不支持惩罚性绩效、保险定价等用途，该用途已被安全边界明确禁止。",
    ),
    (
        "修改安全阈值",
        ["修改阈值", "调高阈值", "放宽阈值", "改阈值", "安全阈值", "限扭"],
        "急停、限扭、关节实时控制等安全闭环参数由设备本地控制，平台与大模型无权写入或修改。",
    ),
    (
        "控制关节/急停",
        ["控制关节", "急停", "远程关机", "停下设备", "停止外骨骼", "远程控制"],
        "平台不能控制关节、急停或任何设备实时控制回路，该能力在架构上不可绕过地保留在设备本地。",
    ),
    (
        "未授权人体数据查询",
        ["隐私", "原始人体数据", "个人数据", "体征", "生理"],
        "查询未授权人体数据超出授权边界。仅可查询已签署授权的匿名化作业记录。",
    ),
    (
        "包装受控结果",
        ["包装", "冒充", "当成客户", "客户现场结论", "伪造", "说成真机"],
        "受控/模拟数据不得包装成客户现场结论。所有回答必须标注真实数据来源。",
    ),
]
SKILLS = ["搬运", "装配", "拣选", "巡检"]


def _window(question):
    if "半小时" in question:
        return 30
    if "一小时" in question or "1小时" in question:
        return 60
    if "今天" in question:
        now = datetime.now().astimezone()
        return max(1, int((now - now.replace(hour=0, minute=0, second=0)).total_seconds() // 60))
    return 10  # 默认过去十分钟


def _recent_records(storage, minutes, per_device=2000):
    now = datetime.now().astimezone()
    start = iso(now - timedelta(minutes=minutes))
    out = []
    for d in storage.list_devices():
        for row in storage.query_telemetry(d["device_id"], start, iso(now), per_device):
            r = norm_telemetry(row)
            if r:
                out.append(r)
    return out


def _no_data():
    return {
        "answer": "本地持久层中没有可引用的记录，按白名单策略拒答，不提供无数据依据的结论。",
        "evidence": [],
        "refused": True,
        "category": "无数据依据",
    }


def answer(storage, question, device_online, assignments):
    """白名单问答：8 类可答（必须引用真实证据），7 类拒绝。"""
    q = (question or "").strip()
    if not q:
        return {"answer": "请输入问题。", "evidence": [], "refused": True, "category": "空问题"}
    for name, keys, msg in REFUSE_RULES:
        if any(k in q for k in keys):
            return {"answer": f"拒绝回答（{name}）。{msg}", "evidence": [], "refused": True, "category": name}

    devices = storage.list_devices()
    # 1. 在线设备
    if "在线" in q or ("多少" in q and "设备" in q):
        views = [
            {
                "device_id": d["device_id"],
                "online": device_online(d),
                "source_type": d.get("source_type"),
                "last_seen": d.get("last_seen"),
            }
            for d in devices
        ]
        on = [v for v in views if v["online"]]
        return {
            "answer": "当前在线设备 {} 台，离线 {} 台：{}。".format(
                len(on),
                len(views) - len(on),
                "、".join(f"{v['device_id']}({v['source_type']})" for v in on) or "无",
            ),
            "evidence": views,
            "refused": False,
            "category": "在线设备",
        }
    # 6. 设备掉线情况
    if "掉线" in q or "离线" in q or "断连" in q:
        off = [
            {"device_id": d["device_id"], "last_seen": d.get("last_seen"), "source_type": d.get("source_type")}
            for d in devices
            if not device_online(d)
        ]
        return {
            "answer": "当前离线设备 {} 台：{}。恢复通信后平台无需重启即可自动恢复显示。".format(
                len(off), "、".join(x["device_id"] for x in off) or "无"
            ),
            "evidence": off,
            "refused": False,
            "category": "设备掉线情况",
        }
    # 2. 最高负荷
    if "负荷" in q:
        recs = _recent_records(storage, _window(q))
        if not recs:
            return _no_data()
        top = max(recs, key=lambda r: r["telemetry"].get("load_score", 0) or 0)
        return {
            "answer": "最近时间窗内最高负荷分数 {:.2f}，来自设备 {}（来源 {}），时间 {}。".format(
                top["telemetry"].get("load_score", 0),
                top.get("device_id"),
                top.get("source_type"),
                top.get("timestamp"),
            ),
            "evidence": [
                {
                    "record_id": top.get("record_id"),
                    "timestamp": top.get("timestamp"),
                    "device_id": top.get("device_id"),
                    "source_type": top.get("source_type"),
                }
            ],
            "refused": False,
            "category": "最高负荷",
        }
    # 3/4. 近期风险事件与告警原因
    if "事件" in q or "风险" in q or "告警" in q or "报警" in q:
        events = [norm_event(e) for e in storage.list_events(50)]
        if not events:
            return _no_data()
        if "原因" in q or "为什么" in q:
            e = events[0]
            trig = e.get("trigger", {})
            return {
                "answer": "最近一条事件 {}（等级 {}）触发依据：{}（规则/模型版本 {}）。".format(
                    e.get("event_code"),
                    e.get("severity"),
                    trig.get("condition", trig.get("type", "见触发详情")),
                    trig.get("rule_version") or trig.get("model_version", "未知"),
                ),
                "evidence": [
                    {
                        "event_id": e.get("event_id"),
                        "event_code": e.get("event_code"),
                        "trigger": trig,
                        "source_type": e.get("source_type"),
                    }
                ],
                "refused": False,
                "category": "告警原因",
            }
        return {
            "answer": "最近共有 {} 条风险事件，最近一条为 {}（{}，等级 {}，状态 {}）。".format(
                len(events),
                events[0].get("event_code"),
                events[0].get("start_time"),
                events[0].get("severity"),
                events[0].get("status"),
            ),
            "evidence": [
                {
                    "event_id": e.get("event_id"),
                    "event_code": e.get("event_code"),
                    "severity": e.get("severity"),
                    "status": e.get("status"),
                    "start_time": e.get("start_time"),
                    "source_type": e.get("source_type"),
                }
                for e in events[:5]
            ],
            "refused": False,
            "category": "近期风险事件",
        }
    # 5. 任务适配人选
    if "谁适合" in q or "派谁" in q or "人选" in q or "推荐" in q:
        skill = next((s for s in SKILLS if s in q), "搬运")
        res = recommend(storage, assignments, {"required_skill": skill}, device_online)
        top = next((r for r in res["items"] if r["eligible"]), None)
        if not top:
            return {
                "answer": f"当前没有满足全部硬约束的可派工人员（技能：{skill}）。",
                "evidence": res["items"],
                "refused": True,
                "category": "任务适配人选",
            }
        return {
            "answer": "按 30/20/20/15/15 可解释评分，技能「{}」首选 {}（得分 {:.1f}）。"
            "最终派工须班组长人工确认，平台不自动派工。".format(skill, top["name"], top["score"]),
            "evidence": [top],
            "refused": False,
            "category": "任务适配人选",
        }
    # 7. 某时段动作记录
    if "动作" in q:
        now = datetime.now().astimezone()
        start = iso(now - timedelta(minutes=_window(q)))
        dev_id = next(
            (d["device_id"] for d in devices if d["device_id"] in q), devices[0]["device_id"] if devices else None
        )
        if not dev_id:
            return _no_data()
        inf = [norm_inference(r) for r in storage.query_inference(dev_id, start, iso(now), 50)]
        if not inf:
            return _no_data()
        labels = {}
        for r in inf:
            labels[r.get("label", "unknown")] = labels.get(r.get("label", "unknown"), 0) + 1
        desc = "、".join(f"{k} {v} 次" for k, v in sorted(labels.items(), key=lambda x: -x[1]))
        return {
            "answer": "设备 {} 在该时段的动作记录：{}（模型版本 {}）。".format(
                dev_id, desc, inf[-1].get("model_version", "未知")
            ),
            "evidence": [
                {
                    "inference_id": r.get("inference_id"),
                    "label": r.get("label"),
                    "confidence": r.get("confidence"),
                    "ts_end": r.get("ts_end"),
                    "model_version": r.get("model_version"),
                    "source_type": r.get("source_type"),
                }
                for r in inf[-10:]
            ],
            "refused": False,
            "category": "某时段动作记录",
        }
    # 8. 数据来源
    if "来源" in q or "真实" in q or "模拟" in q:
        by_src = {}
        for d in devices:
            by_src.setdefault(d.get("source_type"), []).append(d["device_id"])
        desc = "；".join(f"{k}：{'、'.join(v)}" for k, v in by_src.items()) or "无设备"
        return {
            "answer": (
                "平台数据来源分三类：real（真实设备）、controlled_test（受控采集）、"
                "simulated（模拟，仅工程自测）。"
                f"当前接入：{desc}。所有页面与导出均携带来源标识。"
            ),
            "evidence": [{"source_type": k, "devices": v} for k, v in by_src.items()],
            "refused": False,
            "category": "数据来源",
        }
    return {
        "answer": "该问题不在白名单内。我可回答：在线设备、最高负荷、近期风险事件、告警原因、"
        "任务适配人选、设备掉线情况、某时段动作记录、数据来源。",
        "evidence": [],
        "refused": True,
        "category": "白名单外",
    }


# ---- 场景评估器（delivery/07_场景评估/scenario_evaluator_rules.md） ------------------

VETO_ITEMS = [
    ("open_road", "开放道路或不可控人群"),
    ("no_baseline", "客户拒绝任何基线"),
    ("free_only", "无预算负责人且仅要免费体验"),
    ("ergonomic_taboo", "明显人体工效禁忌"),
    ("covert_punitive", "隐蔽采集或惩罚性绩效用途"),
]


def evaluate_scenario(p):
    """首选条件加权评分（满分 100）+ 一票否决，输出候选场景一页纸。"""
    vetoes = [label for key, label in VETO_ITEMS if p.get(key)]

    def num(k, d):
        try:
            return float(p.get(k, d))
        except (TypeError, ValueError):
            return d

    parts = {
        "空间结构化": num("structured", 3) * 4,
        "ROI可量化": num("roi", 3) * 4,
        "付费方明确": num("payer", 3) * 3,
        "设备适配": num("fit", 3) * 3,
        "数据合规": num("compliance", 3) * 3,
        "复制价值": num("replicate", 3) * 3,
    }
    score = round(sum(parts.values()), 1)  # 各维度 1-5 分，满分 100
    rating = "高" if score >= 75 else "中" if score >= 55 else "低"
    people = int(num("people", 20))
    dev_n = max(2, round(people * 0.35))
    backup = max(1, -(-dev_n // 10))
    recommended = not vetoes and rating in ("高", "中")
    conclusion = (
        f"不推荐：命中一票否决（{'、'.join(vetoes)}）"
        if vetoes
        else ("推荐试点" if rating == "高" else "有条件推荐：补齐短板后试点" if rating == "中" else "暂不推荐")
    )
    one_pager = {
        "场景": p.get("scene", "候选场景"),
        "工序": p.get("process", "搬运/装卸工序"),
        "人数": people,
        "动作": p.get("actions", "站立/行走/弯腰/搬举"),
        "痛点": p.get("pain", "高负荷搬运导致疲劳与工伤风险"),
        "付费方": p.get("payer_name", "待确认"),
        "接口": p.get("interfaces", "AIoT/门禁/定位接口待比对"),
        "数据条件": "需签署授权与 DPA，基线数据可采集",
        "设备适配度": f"{int(num('fit', 3))}/5",
        "试点周期": f"{int(8 if rating == '高' else 10)} 周",
        "建议KPI": ["特定工序作业时间", "单位人力有效产出", "负荷/疲劳趋势", "设备连续运行与故障率"],
        "风险": vetoes or ["人员接受度", "现场网络条件", "基线数据质量"],
        "推荐结论": conclusion,
    }
    return {
        "score": score,
        "rating": rating,
        "vetoed": bool(vetoes),
        "veto_reasons": vetoes,
        "recommended": recommended,
        "score_parts": {k: round(v, 1) for k, v in parts.items()},
        "recommended_devices": dev_n,
        "backup_devices": backup,
        "one_pager": one_pager,
        "next_requests": [
            "捷顺指定战略/技术/销售方案/项目交付四条对接线",
            "在园区、物业、制造业与物流客户中筛选 3-5 个候选场景",
            "选 1 个场景做半天工序调研与接口摸底，形成 90 天联合验证范围",
        ],
        "source_type": "simulated_assessment",
        "disclaimer": "本评估为候选场景筛选工具输出，不构成效果或商业承诺。",
    }
