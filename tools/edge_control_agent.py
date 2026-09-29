#!/usr/bin/env python3
"""边缘命令代理（NO-60a）：把平台下发的控制命令送到执行机构并把结果回执平台。

用法：

```bash
# 单轮（e2e / 排障用；处理一台设备的一轮待投递命令后退出）
python3 tools/edge_control_agent.py --once --device AGV-01 \
  --platform-url http://127.0.0.1:3100 --ingest-key "$EWOH_E2E_INGEST_KEY" --org-id 00000000-...

# 常驻（现场网关）：每 interval 秒轮询一次
python3 tools/edge_control_agent.py --device AGV-01 --interval-sec 2

# 走 Modbus/TCP（NO-62d）：现场 PLC/AGV 的真实协议路径
#   · 对现场设备：--transport modbus --modbus-host 10.0.0.21 --source-type real
#   · 无硬件自测：先用 edge/adapters/actuator/modbus.py 的 FakeModbusSlave 起假从站，
#     再用同样的参数指向 127.0.0.1（协议帧是真的，设备是数字孪生）
python3 tools/edge_control_agent.py --once --device AGV-01 --transport modbus \
  --modbus-host 127.0.0.1 --modbus-port 15020 --source-type controlled_test
```

真实硬件：把 `--transport` 换成现场协议实现（本入口已内置 Modbus/TCP；OPC-UA/厂商 API
按同一 `ActuatorTransport` 接口新增）后本入口不变——`build_agent` 只依赖
`ActuatorAdapter` 契约（`send_command` 返回结构化结果）。

退出码：0 = 全部命令处理成功（或本轮无命令）；2 = 有命令投递/执行失败（现场可据此告警）。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from edge_platform.edge.bridge.control_downlink import build_agent  # noqa: E402


def _log_stats(stats: dict) -> None:
    outcomes = stats.get("outcomes") or []
    summary = {
        "deviceId": stats.get("deviceId"),
        "polled": stats.get("polled"),
        "executed": sum(1 for o in outcomes if o.get("outcome") == "executed"),
        "execution_failed": sum(1 for o in outcomes if o.get("outcome") == "execution_failed"),
        "delivery_rejected": sum(1 for o in outcomes if o.get("outcome") == "delivery_rejected"),
        "note": stats.get("note"),
    }
    print(json.dumps({"event": "control_agent_round", **summary, "outcomes": outcomes}, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="边缘命令代理（平台命令下行 → 执行机构 → 回执）")
    parser.add_argument("--device", action="append", required=True, help="执行机构设备号（可重复）")
    parser.add_argument(
        "--platform-url",
        default=os.environ.get("EWOH_EVENT_UPLINK_URL") or os.environ.get("EWOH_SENSOR_UPLINK_URL") or "http://127.0.0.1:3100",
    )
    parser.add_argument("--ingest-key", default=os.environ.get("EWOH_INGEST_API_KEY", ""))
    parser.add_argument("--org-id", default=os.environ.get("EWOH_INGEST_ORG_ID", ""))
    parser.add_argument("--once", action="store_true", help="只跑一轮后退出（e2e/排障）")
    parser.add_argument("--interval-sec", type=float, default=2.0, help="常驻模式的轮询间隔")
    parser.add_argument("--limit", type=int, default=20, help="单轮最多取多少条命令")
    parser.add_argument("--hz", type=float, default=1.0, help="模拟器推进频率（真实 transport 忽略）")
    parser.add_argument(
        "--transport",
        choices=("simulated", "modbus"),
        default="simulated",
        help="执行机构传输实现：simulated（数字孪生，缺省）/ modbus（Modbus/TCP 主站）",
    )
    parser.add_argument("--modbus-host", default=os.environ.get("EWOH_MODBUS_HOST", "127.0.0.1"))
    parser.add_argument("--modbus-port", type=int, default=int(os.environ.get("EWOH_MODBUS_PORT", "502")))
    parser.add_argument(
        "--modbus-timeout-sec", type=float, default=float(os.environ.get("EWOH_MODBUS_TIMEOUT_SEC", "2.0"))
    )
    parser.add_argument(
        "--fingerprint-secret",
        default=os.environ.get("EWOH_CONTROL_FINGERPRINT_SECRET", ""),
        help="授权范围指纹的 HMAC 密钥（与平台同一密钥；配置后本机验签，验不过不碰设备）",
    )
    parser.add_argument(
        "--receipt-journal",
        default=os.environ.get("EWOH_CONTROL_RECEIPT_JOURNAL", ""),
        help="失败回执持久化 JSONL 路径；设置后进程重启会继续补投",
    )
    parser.add_argument("--source-type", default="simulated", choices=["real", "controlled_test", "simulated"])
    args = parser.parse_args(argv)

    if not args.ingest_key:
        print(json.dumps({"error": "缺少 ingest key（--ingest-key 或 EWOH_INGEST_API_KEY）"}), file=sys.stderr)
        return 3

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    agent = build_agent(
        args.platform_url,
        args.ingest_key,
        list(args.device),
        org_id=args.org_id or None,
        source_type=args.source_type,
        hz=args.hz,
        transport=args.transport,
        modbus_host=args.modbus_host,
        modbus_port=args.modbus_port,
        modbus_timeout=args.modbus_timeout_sec,
        fingerprint_secret=args.fingerprint_secret or None,
        receipt_journal_path=args.receipt_journal or None,
    )

    # EDGE-02b（V94 实测）：journal 未配置时失败回执只活在内存里，进程一退就丢，而命令
    # 早已因 ack 离开待投面——平台永远收不到那次执行结果。默认落点是部署决定（写哪里、
    # 谁拥有、怎么轮转），这里不替运维选，但必须在启动时把这个姿态说清楚。
    print(json.dumps({
        "event": "control_agent_config",
        "receiptJournal": args.receipt_journal or None,
        "receiptJournalDurable": bool(args.receipt_journal),
        "fingerprintSecretConfigured": bool(args.fingerprint_secret),
        "devices": list(args.device),
        "transport": args.transport,
        "warning": (None if args.receipt_journal else
                    "未配置 --receipt-journal / EWOH_CONTROL_RECEIPT_JOURNAL："
                    "上行失败的执行结果只在内存中，进程重启即永久丢失且不会重投；"
                    "配路径后重启可补投"),
    }, ensure_ascii=False))

    exit_code = 0
    while True:
        for device_id in args.device:
            stats = agent.run_once(device_id, args.limit)
            _log_stats(stats)
            if stats.get("note", "").startswith("pending_failed"):
                exit_code = 2
            for outcome in stats.get("outcomes") or []:
                if outcome.get("outcome") != "executed":
                    exit_code = 2
        if args.once:
            break
        time.sleep(max(args.interval_sec, 0.2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
