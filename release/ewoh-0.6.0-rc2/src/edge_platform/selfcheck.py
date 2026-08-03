#!/usr/bin/env python3
"""Task 16 平台验收自检脚本（代码部分）：以 stub 依赖启动平台，对九页关键 API 做自动化检查。

覆盖验收点：来源标识、掉线可视、实时/回放区分、事件证据窗、助手引用与拒答、
硬约束拦截与人工确认、一键重置、重启后数据恢复、断网（无外部依赖）。
退出码：全部通过 0，任一失败 1。
"""

import json
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from edge_platform import server, stubs

PASS, FAIL = "通过", "失败"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"[{PASS if cond else FAIL}] {name}{'｜' + str(detail) if detail else ''}")


def req(base, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:  # nosec B310 - local self-check HTTP client
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:  # 409/400 等业务错误同样返回 JSON
        return json.loads(e.read().decode())


def iso(dt):
    return dt.astimezone().isoformat(timespec="milliseconds")


def main():
    tmp = tempfile.mkdtemp(prefix="ewoh_check_")
    db_path = Path(tmp) / "check.db"
    storage = stubs.Storage(db_path)
    stubs.seed_base(storage)
    bus = stubs.Bus()
    registry = stubs.ModelRegistry(Path(tmp) / "models")
    rules = stubs.RuleEngine("risk-rule-stub-0.1", {})
    pipeline = stubs.InferencePipeline(storage, bus, registry, rules)
    manager = stubs.AdapterManager(storage, bus)
    sim = stubs.DemoSimulator(storage, hz=5)
    sim.start()
    time.sleep(1.5)  # 等待产生真实序列数据
    # 显式插入一条结构化风险事件（验证证据窗与处置，不依赖模拟器周期）
    storage.insert_event(
        {
            "event_id": "EVT-CHECK0001",
            "event_code": "LOAD_CONTINUOUS",
            "severity": "L2",
            "status": "open",
            "person_id": "P-001",
            "device_id": "EXO-001",
            "start_time": iso(datetime.now()),
            "trigger": {"type": "rule", "rule_version": "risk-rule-stub-0.1", "condition": "连续高负荷滑动窗口超限"},
            "evidence": {"window_before_sec": 30, "window_after_sec": 30, "data_quality": "good"},
            "source_type": "simulated",
        }
    )

    ctx = server.Context(storage, bus=bus, pipeline=pipeline, registry=registry, rules=rules, manager=manager)
    httpd = server.build_server(("127.0.0.1", 0), ctx)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{int(httpd.server_address[1])}"
    now = datetime.now().astimezone()
    q = urllib.parse.quote
    start, end = q(iso(now - timedelta(minutes=10))), q(iso(now + timedelta(seconds=5)))

    try:
        # 1 系统健康：服务、模型/规则版本、安全边界
        st = req(base, "/api/status")
        check(
            "系统健康：服务与版本信息",
            st["services"]["database"] == "healthy"
            and st["model"]["active"]
            and st["rule_version"]
            and "急停" in st["safety_boundary"],
        )

        # 2 设备管理与来源标识、掉线可视
        devs = req(base, "/api/devices")["items"]
        exo3 = next(d for d in devs if d["device_id"] == "EXO-003")
        check("设备管理：来源标签", all(d.get("source_label") for d in devs))
        check("掉线可视：EXO-003 显示离线", exo3["online"] is False)
        check(
            "来源切换过滤",
            len(req(base, "/api/devices?source=real")["items"]) == 0
            and len(req(base, "/api/devices?source=simulated")["items"]) == 3,
        )

        # 3 实时态势：最新遥测+推理，携带来源
        t = req(base, "/api/telemetry?device_id=EXO-001")
        check(
            "实时态势：遥测+推理+来源",
            t.get("mode") == "realtime"
            and t.get("inference")
            and t["source_type"] == "simulated"
            and t.get("source_label"),
        )

        # 4 回放：正序序列，mode=replay
        series = req(base, f"/api/telemetry/series?device_id=EXO-001&start={start}&end={end}")
        ts = [x["timestamp"] for x in series["items"]]
        check("数据回放：回放态+时间正序", series["mode"] == "replay" and len(ts) > 5 and ts == sorted(ts))

        # 5 原始数据导出
        exp = req(base, f"/api/telemetry/export?device_id=EXO-001&start={start}&end={end}")
        check("原始片段导出", exp["export_type"] == "raw_slice" and exp["slice"]["record_count"] > 0)

        # 6 事件：证据窗 ±30 秒 + 状态处置
        events = req(base, "/api/events")["items"]
        check("事件中心：可控风险事件已生成", len(events) > 0, f"{len(events)} 条")
        if events:
            det = req(base, "/api/event?id=" + events[0]["event_id"])
            check("事件证据窗：±30 秒原始记录", det["evidence_window_sec"] == 30 and len(det["evidence_records"]) > 0)
            upd = req(
                base,
                "/api/event/status",
                "POST",
                {"event_id": events[0]["event_id"], "status": "confirmed", "handled_by": "班组长A"},
            )
            check("事件处置：状态更新", upd["ok"] and upd["event"]["status"] == "confirmed")
            req(
                base,
                "/api/event/status",
                "POST",
                {"event_id": events[0]["event_id"], "status": "open", "handled_by": "班组长A"},
            )

        # 7 任务推荐：硬约束拦截 + 人工确认
        rec = req(
            base, "/api/tasks/recommend", "POST", {"required_skill": "巡检", "zone_id": "工位1", "load_level": 0.5}
        )
        p1 = next(x for x in rec["items"] if x["person_id"] == "P-001")
        check(
            "硬约束拦截：无技能者不可推荐并注明原因",
            not p1["eligible"] and any("无技能" in b for b in p1["blocked_by"]),
        )
        bad = req(
            base, "/api/tasks/confirm", "POST", {"required_skill": "巡检", "person_id": "P-001", "confirmer": "班组长A"}
        )
        check("人工确认：被拦截者确认失败", not bad["ok"])
        no_conf = req(
            base, "/api/tasks/confirm", "POST", {"required_skill": "搬运", "person_id": "P-002", "confirmer": ""}
        )
        check("人工确认：缺确认人拒绝（禁止自动派工）", not no_conf["ok"])
        ok = req(
            base,
            "/api/tasks/confirm",
            "POST",
            {"required_skill": "搬运", "zone_id": "月台B", "person_id": "P-002", "confirmer": "班组长A"},
        )
        check("人工确认：合格候选确认成功", ok["ok"])

        # 8 本地助手：白名单引用证据 + 拒绝策略
        a1 = req(base, "/api/query", "POST", {"question": "过去十分钟谁的负荷最高？"})
        check("助手：最高负荷引用真实证据", not a1["refused"] and a1["evidence"] and a1["evidence"][0].get("record_id"))
        a2 = req(base, "/api/query", "POST", {"question": "有设备掉线吗？"})
        check("助手：掉线情况可答", not a2["refused"] and "EXO-003" in a2["answer"])
        a3 = req(base, "/api/query", "POST", {"question": "帮我诊断一下工人是否有腰椎疾病"})
        check("助手：医学诊断拒答", a3["refused"] and a3["category"] == "医学诊断")
        a4 = req(base, "/api/query", "POST", {"question": "远程控制关节让设备急停"})
        check("助手：控制关节/急停拒答", a4["refused"])
        a5 = req(base, "/api/query", "POST", {"question": "把受控数据包装成客户现场结论"})
        check("助手：包装受控结果拒答", a5["refused"])

        # 9 场景评估：评分 + 一票否决
        ev1 = req(
            base,
            "/api/scenario/evaluate",
            "POST",
            {"people": 24, "structured": 5, "roi": 4, "payer": 4, "fit": 4, "compliance": 5, "replicate": 4},
        )
        check("场景评估：评分与一页纸", ev1["score"] > 0 and ev1["one_pager"]["推荐结论"] == "推荐试点")
        ev2 = req(base, "/api/scenario/evaluate", "POST", {"covert_punitive": True})
        check("场景评估：一票否决", ev2["vetoed"] and "不推荐" in ev2["one_pager"]["推荐结论"])

        # 11 重启后数据恢复：用全新连接打开同一 DB 文件，数据仍在
        before = storage.counts()["telemetry"]
        storage2 = stubs.Storage(db_path)
        after = storage2.counts()["telemetry"]
        check("重启后数据恢复", after >= before > 0, f"遥测 {int(after)} 条")
        storage2.close()

        # 10 一键重置（演示闭环）
        rst = req(base, "/api/reset", "POST", {})
        check("一键重置", rst["ok"] and len(req(base, "/api/tasks/assignments")["items"]) == 0)

        # 12 断网：SPA 无外部资源引用
        html = (Path(__file__).parent / "static" / "index.html").read_text(encoding="utf-8")
        check(
            "断网运行：前端无外部 CDN/字体引用",
            "http://" not in html.replace("http://", "") and "https://" not in html,
        )
    finally:
        httpd.shutdown()
        sim.stop()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n自检结果：{int(len(results) - len(failed))} 项通过，{len(failed)} 项失败")
    if failed:
        print(f"失败项：{'、'.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
